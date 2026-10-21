/**
 * 发布页与多语言接口（方案第 2、3、5 阶段）。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { validationFailed } from '../../domain/errors.ts';
import {
  aggregateFor,
  ensureListingPage,
  listPagesAdmin,
  publishListing,
  readiness,
  updateListingSettings,
  withdrawListing,
} from '../../services/publish-service.ts';
import {
  buildLocaleLinks,
  listPropertyTranslations,
  removeTranslation,
  saveTranslation,
} from '../../services/i18n-service.ts';
import { listTemplates } from '../../render/templates.ts';
import { PUBLIC_PAGE_LOCALES, SUPPORTED_LOCALES } from '../../domain/i18n.ts';
import { renderQrSvg } from '../../render/qrcode.ts';
import { composeAddress, renderListingPage } from '../../render/page-renderer.ts';
import { resolveAvailability } from '../../domain/availability.ts';

export function registerAdminPageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/admin/pages', async () => ({ items: listPagesAdmin(ctx) }));

  app.get('/api/admin/templates', async () => ({
    items: listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      heroLayout: t.heroLayout,
      showQr: t.showQr,
    })),
  }));

  app.get('/api/admin/locales', async () => ({
    items: SUPPORTED_LOCALES,
    defaultLocale: ctx.workspace.defaultLocale,
  }));

  /** 当前发布设置 + 就绪状态 + 分享链接与二维码 */
  app.get<{ Params: { id: string } }>('/api/admin/properties/:id/listing', async (request) => {
    const page = ensureListingPage(ctx, request.params.id);
    const aggregate = aggregateFor(ctx, request.params.id);
    const resolved = ctx.adapters.hosting.resolvePublicUrl(page.slug, {
      customDomain: page.customDomain,
      domainVerifyToken: page.domainVerifyToken,
      domainVerifiedAt: page.domainVerifiedAt,
    });

    const qr = renderQrSvg(resolved.url, { cellSize: 4, margin: 2 });

    return {
      page,
      publicUrl: resolved.url,
      urlKind: resolved.kind,
      urlNote: resolved.note,
      qrSvg: qr.svg,
      readiness: readiness(ctx, request.params.id, page.locale),
      templates: listTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description })),
      localeLinks: buildLocaleLinks(ctx, request.params.id, page.locale),
      translationCount: aggregate.translations.length,
    };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/properties/:id/listing', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return updateListingSettings(ctx, request.params.id, {
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      locale: typeof body.locale === 'string' ? body.locale : undefined,
      templateId: typeof body.templateId === 'string' ? body.templateId : undefined,
    });
  });

  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/publish', async (request) =>
    publishListing(ctx, request.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/withdraw', async (request) => ({
    page: withdrawListing(ctx, request.params.id),
  }));

  /**
   * 真实预览：即便房源尚未发布，也能看到与公开页完全一致的渲染结果。
   * 方案第 2 阶段要求「支持预览」，且预览必须与发布后的页面同源同版式。
   */
  app.get<{ Params: { id: string }; Querystring: { locale?: string } }>(
    '/api/admin/properties/:id/preview',
    async (request, reply) => {
      const aggregate = aggregateFor(ctx, request.params.id);
      const page = ensureListingPage(ctx, request.params.id);

      const locale = request.query.locale ?? page.locale ?? ctx.workspace.defaultLocale;
      const addressText = composeAddress(aggregate.property);

      const html = renderListingPage({
        aggregate,
        workspace: ctx.workspace,
        locale,
        publicUrl: ctx.adapters.hosting.resolvePublicUrl(page.slug, {
          customDomain: page.customDomain,
          domainVerifyToken: page.domainVerifyToken,
          domainVerifiedAt: page.domainVerifiedAt,
        }).url,
        templateId: page.templateId,
        mapView: ctx.adapters.map.buildView({
          latitude: aggregate.property.latitude,
          longitude: aggregate.property.longitude,
          addressText,
        }),
        nearby: null,
        localeLinks: buildLocaleLinks(ctx, request.params.id, locale),
        includeMapScript: true,
        includeQr: true,
        generatedAt: ctx.adapters.clock.now(),
        // 使用与公开页一致的 per-request nonce，供内联脚本与样式使用
        nonce: request.cspNonce,
        availability: resolveAvailability(
          aggregate.property,
          ctx.adapters.clock.now(),
          ctx.config.listingStaleDays,
        ),
      });

      // CSP 由全局 onSend 钩子统一设置（含 nonce 与地图所需的内联样式放宽），
      // 这里只额外声明不要被搜索引擎收录。
      return reply
        .type('text/html; charset=utf-8')
        .header('X-Robots-Tag', 'noindex')
        .send(html);
    },
  );

  // ---- 多语言 ----

  app.get<{ Params: { id: string } }>('/api/admin/properties/:id/translations', async (request) => {
    const property = aggregateFor(ctx, request.params.id).property;
    return {
      origin: {
        locale: ctx.workspace.defaultLocale,
        title: property.title,
        description: property.description,
      },
      items: listPropertyTranslations(ctx, request.params.id),
      // supportedLocales：译文可以录哪些语言 —— 用户自己填内容，八种都支持
      supportedLocales: SUPPORTED_LOCALES,
      // pageLocales：展示页界面文字翻好了哪些语言 —— 目前只有中英，
      // 选其它语言会回落成英文界面，所以不提供
      pageLocales: PUBLIC_PAGE_LOCALES,
    };
  });

  app.put<{ Params: { id: string } }>('/api/admin/properties/:id/translations', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const saved = saveTranslation(ctx, request.params.id, body);
    return reply.code(201).send(saved);
  });

  app.delete<{ Params: { id: string; locale: string } }>(
    '/api/admin/properties/:id/translations/:locale',
    async (request) => {
      const removed = removeTranslation(ctx, request.params.id, request.params.locale);
      if (!removed) throw validationFailed([{ field: 'locale', message: '该语言没有译文' }]);
      return { deleted: true, locale: request.params.locale };
    },
  );
}