/**
 * 媒体管理接口（方案第三章第 2 条）。
 * 上传 -> 类型/大小/数量校验 -> 落盘 -> 入库，全链路在 media-service 内闭环。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { validationFailed } from '../../domain/errors.ts';
import {
  addUploadedMedia,
  addVideoLink,
  deleteMediaItem,
  listPropertyMedia,
  reorderMediaItems,
  setCoverMedia,
  updateMediaSourceNote,
} from '../../services/media-service.ts';

export function registerAdminMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { id: string } }>('/api/admin/properties/:id/media', async (request) =>
    listPropertyMedia(ctx, request.params.id),
  );

  /** 上传照片或视频文件（multipart/form-data） */
  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/media', async (request, reply) => {
    const file = await request.file();

    if (!file) {
      throw validationFailed([{ field: 'file', message: '请选择要上传的文件' }]);
    }

    const data = await file.toBuffer();

    // multipart 的其他文本字段（如素材来源说明）
    const fields = file.fields as Record<string, unknown>;
    const sourceNoteField = fields['sourceNote'];
    const sourceNote =
      sourceNoteField && typeof sourceNoteField === 'object' && 'value' in sourceNoteField
        ? String((sourceNoteField as { value: unknown }).value)
        : '';

    const created = await addUploadedMedia(ctx, request.params.id, {
      filename: file.filename,
      declaredMime: file.mimetype,
      data: new Uint8Array(data),
      sourceNote,
    });

    return reply.code(201).send(created);
  });

  /** 添加外部视频链接 */
  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/media/link', async (request, reply) => {
    const body = (request.body ?? {}) as { url?: unknown; sourceNote?: unknown };
    const url = typeof body.url === 'string' ? body.url : '';
    const sourceNote = typeof body.sourceNote === 'string' ? body.sourceNote : '';

    const created = addVideoLink(ctx, request.params.id, url, sourceNote);
    return reply.code(201).send(created);
  });

  /** 更新素材来源/授权说明 */
  app.patch<{ Params: { mediaId: string } }>('/api/admin/media/:mediaId', async (request) => {
    const body = (request.body ?? {}) as { sourceNote?: unknown };
    const sourceNote = typeof body.sourceNote === 'string' ? body.sourceNote : '';
    return updateMediaSourceNote(ctx, request.params.mediaId, sourceNote);
  });

  app.delete<{ Params: { mediaId: string } }>('/api/admin/media/:mediaId', async (request) => {
    await deleteMediaItem(ctx, request.params.mediaId);
    return { deleted: true, id: request.params.mediaId };
  });

  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/media/reorder', async (request) => {
    const body = (request.body ?? {}) as { order?: unknown };
    const order = Array.isArray(body.order) ? body.order.filter((v): v is string => typeof v === 'string') : [];

    if (order.length === 0) {
      throw validationFailed([{ field: 'order', message: '请提供媒体顺序数组' }]);
    }

    return reorderMediaItems(ctx, request.params.id, order);
  });

  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/media/cover', async (request) => {
    const body = (request.body ?? {}) as { mediaId?: unknown };
    const mediaId = typeof body.mediaId === 'string' && body.mediaId !== '' ? body.mediaId : null;
    return setCoverMedia(ctx, request.params.id, mediaId);
  });
}