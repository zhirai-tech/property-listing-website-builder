/**
 * 静态导出接口（方案第 3 阶段）。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { exportListingAsZip, exportListingToDirectory } from '../../services/export-service.ts';
import { requireProperty } from '../../services/property-service.ts';

export function registerAdminExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** 下载 ZIP：包含 index.html、assets/ 与说明文件 */
  app.get<{ Params: { id: string }; Querystring: { locale?: string } }>(
    '/api/admin/properties/:id/export.zip',
    async (request, reply) => {
      const result = await exportListingAsZip(ctx, request.params.id, {
        locale: request.query.locale,
      });

      // 中文文件名使用 RFC 5987 编码，兼容各浏览器
      const asciiFallback = result.filename.replace(/[^\x20-\x7e]/g, '_');

      return reply
        .type('application/zip')
        .header(
          'Content-Disposition',
          `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        )
        .header('Content-Length', String(result.data.length))
        .send(Buffer.from(result.data));
    },
  );

  /** 导出到服务器目录（返回实际写入路径与文件清单） */
  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/export', async (request) => {
    const property = requireProperty(ctx, request.params.id);
    const body = (request.body ?? {}) as { outDir?: unknown };

    const defaultDir = `${ctx.config.dataDir}/exports/${property.id}`;
    const outDir = typeof body.outDir === 'string' && body.outDir.trim() !== '' ? body.outDir : defaultDir;

    const result = await exportListingToDirectory(ctx, request.params.id, { outDir });
    return { ...result, entry: `${result.outDir}/index.html` };
  });

  /** 预览导出结果的 HTML 源码（便于核对内容一致性） */
  app.get<{ Params: { id: string }; Querystring: { locale?: string } }>(
    '/api/admin/properties/:id/export-preview',
    async (request, reply) => {
      const { buildExportBundle } = await import('../../services/export-service.ts');
      const bundle = await buildExportBundle(ctx, request.params.id, {
        locale: request.query.locale,
      });

      const index = bundle.files.find((f) => f.path === 'index.html');
      const html = index ? new TextDecoder().decode(index.data) : '';

      return reply
        .type('text/html; charset=utf-8')
        .header('Content-Security-Policy', "default-src 'self' data:")
        .send(html);
    },
  );
}