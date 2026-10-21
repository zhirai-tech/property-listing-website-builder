/**
 * 媒体服务（方案第三章第 2 条、方案第 8 阶段上传文件校验）。
 *
 * 安全链路：文件头识别真实类型 -> 扩展名交叉核对 -> 大小与数量上限 ->
 * 生成安全存储键 -> 落盘 -> 写入数据库。
 */

import type { AppContext } from '../app-context.ts';
import { notFound, unprocessable } from '../domain/errors.ts';
import {
  resolveCover,
  sniffMimeType,
  validateExternalVideoUrl,
  validateUpload,
} from '../domain/media.ts';
import { reorderMedia } from '../domain/media.ts';
import type { Media } from '../domain/types.ts';
import {
  applyCover,
  applyOrder,
  countPhotos,
  deleteMedia,
  getCover,
  getMedia,
  insertMedia,
  listMedia,
  nextSortOrder,
  updateMedia,
} from '../db/repositories/media-repo.ts';
import { recordAudit } from './audit-service.ts';
import { requireProperty } from './property-service.ts';

/** 上传策略来自环境配置，便于按部署环境调整 */
function policy(ctx: AppContext): {
  maxUploadBytes: number;
  maxVideoBytes: number;
  maxPhotosPerProperty: number;
} {
  return ctx.config.upload;
}

export interface UploadInput {
  filename: string;
  declaredMime: string;
  data: Uint8Array;
  /** 素材来源或授权说明（方案第三章第 2 条要求记录） */
  sourceNote?: string;
}

/** 生成安全的存储键：以房源 ID 分目录，文件名由内部生成，不采用用户输入 */
function buildStorageKey(propertyId: string, mimeType: string): string {
  const extension =
    mimeType === 'image/jpeg'
      ? 'jpg'
      : mimeType === 'image/png'
        ? 'png'
        : mimeType === 'image/webp'
          ? 'webp'
          : mimeType === 'image/gif'
            ? 'gif'
            : mimeType === 'video/mp4'
              ? 'mp4'
              : mimeType === 'video/webm'
                ? 'webm'
                : mimeType === 'video/quicktime'
                  ? 'mov'
                  : 'bin';

  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${propertyId}/${unique}.${extension}`;
}

export async function addUploadedMedia(
  ctx: AppContext,
  propertyId: string,
  input: UploadInput,
): Promise<Media> {
  requireProperty(ctx, propertyId);

  const head = input.data.subarray(0, 32);
  const actualMime = sniffMimeType(head);

  const { kind, mimeType } = validateUpload({
    filename: input.filename,
    declaredMime: input.declaredMime,
    actualMime,
    byteSize: input.data.byteLength,
    existingPhotoCount: countPhotos(ctx.db, propertyId),
    policy: policy(ctx),
  });

  const storageKey = buildStorageKey(propertyId, mimeType);
  await ctx.adapters.storage.put(storageKey, input.data);

  const existing = listMedia(ctx.db, propertyId);
  const isFirstPhoto = kind === 'photo' && existing.filter((m) => m.kind === 'photo').length === 0;

  const created = insertMedia(ctx.db, propertyId, {
    kind,
    storageKey,
    originalName: input.filename,
    mimeType,
    byteSize: input.data.byteLength,
    sortOrder: nextSortOrder(ctx.db, propertyId),
    isCover: isFirstPhoto,
    sourceNote: input.sourceNote ?? '',
  });

  // 保证封面不变量
  if (isFirstPhoto) applyCover(ctx.db, propertyId, created.id);

  recordAudit(ctx, {
    action: 'media.upload',
    entityType: 'media',
    entityId: created.id,
    detail: { propertyId, kind, mimeType, byteSize: input.data.byteLength },
  });

  return getMedia(ctx.db, created.id) ?? created;
}

/** 外部视频链接（方案第三章第 2 条：可选支持外部视频链接） */
export function addVideoLink(
  ctx: AppContext,
  propertyId: string,
  url: string,
  sourceNote = '',
): Media {
  requireProperty(ctx, propertyId);
  const normalized = validateExternalVideoUrl(url);

  const created = insertMedia(ctx.db, propertyId, {
    kind: 'video_link',
    externalUrl: normalized,
    mimeType: 'text/uri-list',
    sortOrder: nextSortOrder(ctx.db, propertyId),
    isCover: false,
    sourceNote,
  });

  recordAudit(ctx, {
    action: 'media.addLink',
    entityType: 'media',
    entityId: created.id,
    detail: { propertyId, url: normalized },
  });

  return created;
}

export function requireMedia(ctx: AppContext, mediaId: string): Media {
  const media = getMedia(ctx.db, mediaId);
  if (!media) throw notFound('媒体', mediaId);
  // 通过房源归属间接校验工作区，防止越权访问其它工作区的素材
  requireProperty(ctx, media.propertyId);
  return media;
}

export async function deleteMediaItem(ctx: AppContext, mediaId: string): Promise<void> {
  const media = requireMedia(ctx, mediaId);

  if (media.storageKey !== '') {
    await ctx.adapters.storage.remove(media.storageKey);
  }

  deleteMedia(ctx.db, mediaId);

  // 删除的若是封面，需要重新指定一张，避免展示页无封面
  if (media.isCover) {
    const remaining = listMedia(ctx.db, media.propertyId);
    const coverMap = resolveCover(remaining, null);
    const nextCover = [...coverMap.entries()].find(([, isCover]) => isCover)?.[0] ?? null;
    applyCover(ctx.db, media.propertyId, nextCover);
  }

  recordAudit(ctx, {
    action: 'media.delete',
    entityType: 'media',
    entityId: mediaId,
    detail: { propertyId: media.propertyId, kind: media.kind },
  });
}

/** 更新素材来源/授权说明（方案第三章第 2 条要求可记录素材来源） */
export function updateMediaSourceNote(ctx: AppContext, mediaId: string, sourceNote: string): Media {
  requireMedia(ctx, mediaId);

  const updated = updateMedia(ctx.db, mediaId, { sourceNote });
  if (!updated) throw notFound('媒体', mediaId);

  recordAudit(ctx, {
    action: 'media.updateNote',
    entityType: 'media',
    entityId: mediaId,
    detail: { sourceNote },
  });

  return updated;
}

/** 重新排序：请求中的 id 顺序即目标顺序 */
export function reorderMediaItems(
  ctx: AppContext,
  propertyId: string,
  desiredOrder: readonly string[],
): Media[] {
  requireProperty(ctx, propertyId);
  const current = listMedia(ctx.db, propertyId);

  const ordered = reorderMedia(current, desiredOrder);
  applyOrder(ctx.db, ordered);

  recordAudit(ctx, {
    action: 'media.reorder',
    entityType: 'property',
    entityId: propertyId,
    detail: { count: ordered.length },
  });

  return listMedia(ctx.db, propertyId);
}

export function setCoverMedia(ctx: AppContext, propertyId: string, mediaId: string | null): Media[] {
  requireProperty(ctx, propertyId);
  const current = listMedia(ctx.db, propertyId);

  if (mediaId !== null) {
    const target = current.find((m) => m.id === mediaId);
    if (!target) throw notFound('媒体', mediaId);
    if (target.kind !== 'photo') {
      throw unprocessable('只有照片可以设为封面');
    }
  }

  const coverMap = resolveCover(current, mediaId);
  const chosen = [...coverMap.entries()].find(([, isCover]) => isCover)?.[0] ?? null;
  applyCover(ctx.db, propertyId, chosen);

  recordAudit(ctx, {
    action: 'media.setCover',
    entityType: 'property',
    entityId: propertyId,
    detail: { coverId: chosen },
  });

  return listMedia(ctx.db, propertyId);
}

export function listPropertyMedia(ctx: AppContext, propertyId: string): Media[] {
  requireProperty(ctx, propertyId);
  return listMedia(ctx.db, propertyId);
}

export function coverOf(ctx: AppContext, propertyId: string): Media | null {
  return getCover(ctx.db, propertyId);
}
