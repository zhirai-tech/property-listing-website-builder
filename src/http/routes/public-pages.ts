/**
 * 公开展示页路由（方案第三章第 3 条、第 2 阶段验收）。
 *
 * 关键规则：未发布 / 已撤下 / 不存在的 slug 一律返回 404 且内容一致，
 * 不泄漏「该房源是否存在」。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { composeAddress, renderListingPage, renderUnavailablePage } from '../../render/page-renderer.ts';
import { renderQrSvg } from '../../render/qrcode.ts';
import { incrementViewCount } from '../../db/repositories/listing-page-repo.ts';
import { buildLocaleLinks } from '../../services/i18n-service.ts';
import { findPublicPage } from '../../services/publish-service.ts';
import { isSupportedLocale } from '../../domain/i18n.ts';
import { resolveAvailability } from '../../domain/availability.ts';

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { slug: string }; Querystring: { lang?: string; nearby?: string } }>(
    '/p/:slug',
    async (request, reply) => {
      const { slug } = request.params;
      const found = findPublicPage(ctx, slug);

      if (!found) {
        return reply
          .code(404)
          .type('text/html; charset=utf-8')
          .send(
            renderUnavailablePage({
              status: 404,
              title: '页面不存在或已撤下',
              message: '该房源页面不存在、尚未发布，或已被发布者撤下。',
              nonce: request.cspNonce,
            }),
          );
      }

      const { aggregate, page } = found;
      const { property } = aggregate;

      const requestedLocale = (request.query.lang ?? '').trim();
      const locale =
        requestedLocale !== '' && isSupportedLocale(requestedLocale)
          ? requestedLocale
          : page.locale || ctx.workspace.defaultLocale;

      const addressText = composeAddress(property);

      const mapView = ctx.adapters.map.buildView({
        latitude: property.latitude,
        longitude: property.longitude,
        addressText,
      });

      // 周边信息按需加载：只有用户显式请求时才访问外部服务
      const wantNearby = request.query.nearby === '1';
      const nearby =
        wantNearby && mapView.hasCoordinates && mapView.enabled
          ? await ctx.adapters.map.nearby({
              latitude: property.latitude as number,
              longitude: property.longitude as number,
            })
          : null;

      const resolved = ctx.adapters.hosting.resolvePublicUrl(page.slug, {
        customDomain: page.customDomain,
        domainVerifyToken: page.domainVerifyToken,
        domainVerifiedAt: page.domainVerifiedAt,
      });

      const html = renderListingPage({
        aggregate,
        workspace: ctx.workspace,
        locale,
        publicUrl: resolved.url,
        templateId: page.templateId,
        mapView,
        nearby,
        localeLinks: buildLocaleLinks(ctx, property.id, locale),
        includeMapScript: true,
        includeQr: true,
        generatedAt: ctx.adapters.clock.now(),
        nonce: request.cspNonce,
        availability: resolveAvailability(
          property,
          ctx.adapters.clock.now(),
          ctx.config.listingStaleDays,
        ),
      });

      // 浏览量统计不应影响页面响应
      try {
        incrementViewCount(ctx.db, page.id);
      } catch {
        // 忽略统计失败
      }

      return reply.type('text/html; charset=utf-8').send(html);
    },
  );

  /** 二维码图片（可单独保存或打印） */
  app.get<{ Params: { slug: string } }>('/p/:slug/qr.svg', async (request, reply) => {
    const found = findPublicPage(ctx, request.params.slug);
    if (!found) return reply.code(404).send('not found');

    const page = found.page;
    const resolved = ctx.adapters.hosting.resolvePublicUrl(page.slug, {
      customDomain: page.customDomain,
      domainVerifyToken: page.domainVerifyToken,
      domainVerifiedAt: page.domainVerifiedAt,
    });

    const qr = renderQrSvg(resolved.url, { cellSize: 8, margin: 4, label: '房源页面二维码' });

    return reply
      .type('image/svg+xml; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .send(qr.svg);
  });

  /** 周边信息 JSON（供展示页按需加载） */
  app.get<{ Params: { slug: string } }>('/p/:slug/nearby.json', async (request, reply) => {
    const found = findPublicPage(ctx, request.params.slug);
    if (!found) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '页面不存在' } });

    const { property } = found.aggregate;
    if (property.latitude === null || property.longitude === null) {
      return { available: false, reason: '该房源未填写经纬度', places: [], source: 'none' };
    }

    const result = await ctx.adapters.map.nearby({
      latitude: property.latitude,
      longitude: property.longitude,
    });

    return reply.header('Cache-Control', 'public, max-age=600').send(result);
  });
}