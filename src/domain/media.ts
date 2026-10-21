/**
 * 媒体领域规则（方案第三章第 2 条、第八章上传文件校验）。
 *
 * 安全要求：
 *  - 不信任客户端提供的 MIME，必须用文件头（魔数）复核；
 *  - 限制类型、单文件大小与数量；
 *  - 记录素材来源/授权说明，避免使用未授权素材商用（方案第八章第 1 条）。
 */

import { validationFailed, type FieldIssue } from './errors.ts';
import type { MediaKind } from './types.ts';

export interface UploadPolicy {
  maxUploadBytes: number;
  maxVideoBytes: number;
  maxPhotosPerProperty: number;
}

export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

export const ALLOWED_UPLOAD_MIME_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as const;

/** 扩展名到 MIME 的保守映射，仅用于交叉核对 */
const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  return filename.slice(idx).toLowerCase();
}

/**
 * 通过文件头判断真实 MIME 类型。
 * 返回 null 表示无法识别 —— 调用方应拒绝该上传。
 */
export function sniffMimeType(head: Uint8Array): string | null {
  const b = head;
  const startsWith = (bytes: readonly number[], offset = 0): boolean =>
    bytes.every((value, i) => b[offset + i] === value);

  // JPEG: FF D8 FF
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // GIF: "GIF87a" / "GIF89a"
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // WebP: "RIFF"????"WEBP"
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  // MP4 / MOV: 第 4..7 字节为 "ftyp"
  if (startsWith([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0);
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  // WebM / Matroska: 1A 45 DF A3
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';

  return null;
}

export function kindForMime(mime: string): MediaKind | null {
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mime)) return 'photo';
  if ((VIDEO_MIME_TYPES as readonly string[]).includes(mime)) return 'video_file';
  return null;
}

/**
 * 完整上传校验：文件名、声明 MIME、真实 MIME、大小、数量。
 * 返回规范化后的决策结果。
 */
export function validateUpload(input: {
  filename: string;
  declaredMime: string;
  actualMime: string | null;
  byteSize: number;
  existingPhotoCount: number;
  policy: UploadPolicy;
}): { kind: MediaKind; mimeType: string } {
  const issues: FieldIssue[] = [];
  const { filename, declaredMime, actualMime, byteSize, existingPhotoCount, policy } = input;

  if (filename.trim() === '') {
    issues.push({ field: 'file', message: '文件名不能为空' });
  }

  const ext = extensionOf(filename);
  const expectedByExt = EXTENSION_MIME[ext];
  if (!expectedByExt) {
    issues.push({
      field: 'file',
      message: `不支持的文件扩展名 ${ext || '(无)'}，允许：${Object.keys(EXTENSION_MIME).join(' / ')}`,
    });
  }

  if (actualMime === null) {
    issues.push({ field: 'file', message: '无法识别文件真实类型，请确认为 JPG/PNG/WebP/GIF/MP4/WebM/MOV' });
  } else if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(actualMime)) {
    issues.push({ field: 'file', message: `不允许的文件类型：${actualMime}` });
  } else if (expectedByExt && expectedByExt !== actualMime) {
    issues.push({
      field: 'file',
      message: `文件扩展名与实际内容不一致（扩展名暗示 ${expectedByExt}，实际为 ${actualMime}）`,
    });
  }

  if (declaredMime && actualMime && declaredMime !== actualMime) {
    issues.push({
      field: 'file',
      message: `浏览器声明的类型（${declaredMime}）与文件实际类型（${actualMime}）不一致`,
    });
  }

  if (byteSize <= 0) {
    issues.push({ field: 'file', message: '文件为空' });
  }

  const kind = actualMime ? kindForMime(actualMime) : null;

  if (kind === 'photo') {
    if (byteSize > policy.maxUploadBytes) {
      issues.push({
        field: 'file',
        message: `照片不能超过 ${Math.round(policy.maxUploadBytes / 1024 / 1024)} MB`,
      });
    }
    if (existingPhotoCount >= policy.maxPhotosPerProperty) {
      issues.push({
        field: 'file',
        message: `每个房源最多上传 ${policy.maxPhotosPerProperty} 张照片，当前已有 ${existingPhotoCount} 张`,
      });
    }
  }

  if (kind === 'video_file' && byteSize > policy.maxVideoBytes) {
    issues.push({
      field: 'file',
      message: `视频不能超过 ${Math.round(policy.maxVideoBytes / 1024 / 1024)} MB`,
    });
  }

  if (issues.length > 0) throw validationFailed(issues, '文件校验未通过');

  return { kind: kind as MediaKind, mimeType: actualMime as string };
}

/** 外部视频链接校验：仅允许 http/https，避免 javascript: 等危险协议 */
export function validateExternalVideoUrl(raw: string): string {
  const value = raw.trim();
  if (value === '') {
    throw validationFailed([{ field: 'externalUrl', message: '视频链接不能为空' }]);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationFailed([{ field: 'externalUrl', message: '视频链接格式不正确' }]);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw validationFailed([{ field: 'externalUrl', message: '视频链接必须以 http:// 或 https:// 开头' }]);
  }
  return url.toString();
}

/**
 * 重新排序：给定 id 顺序，返回 sortOrder 映射。
 * 顺序中未出现的媒体会被追加到末尾，保持相对顺序，避免丢失。
 */
export function reorderMedia(
  current: readonly { id: string }[],
  desiredOrder: readonly string[],
): string[] {
  const known = new Set(current.map((m) => m.id));
  const ordered = desiredOrder.filter((id) => known.has(id));

  const seen = new Set(ordered);
  for (const item of current) {
    if (!seen.has(item.id)) {
      ordered.push(item.id);
      seen.add(item.id);
    }
  }
  return ordered;
}

/**
 * 计算封面归属：保证每个房源至多一张封面。
 * 传入期望封面 id（可为 null），返回 id -> isCover 的结果。
 */
export function resolveCover(
  current: readonly { id: string; isCover: boolean; kind: MediaKind }[],
  desiredCoverId: string | null,
): Map<string, boolean> {
  const photos = current.filter((m) => m.kind === 'photo');
  const result = new Map<string, boolean>();
  for (const m of current) result.set(m.id, false);

  if (photos.length === 0) return result;

  if (desiredCoverId && photos.some((m) => m.id === desiredCoverId)) {
    result.set(desiredCoverId, true);
    return result;
  }

  // 保留已有封面；若没有则取排序最靠前的一张
  const existing = photos.find((m) => m.isCover);
  const fallback = existing ?? photos[0];
  if (fallback) result.set(fallback.id, true);
  return result;
}
