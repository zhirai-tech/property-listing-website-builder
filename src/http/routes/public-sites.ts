/**
 * 平台托管页面的公开访问。
 *
 * 【为什么用 /s/ 而不是 /p/】
 * `/p/<slug>` 已经是**房源展示页**的地址（`property_id` 一对一）。
 * 平台项目里还有「自定义单页」这种与房源无关的类型，
 * 混在同一个前缀下会让两套 slug 空间纠缠在一起。
 * `/s/<slug>`（site）语义清楚，也不需要动既有的公开页路由与它的测试。
 *
 * 【不需要登录】这是发布出去给别人看的页面。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { DomainError } from '../../domain/errors.ts';
import { getWorkspace } from '../../db/repositories/workspace-repo.ts';
import { getProjectBySlug } from '../../platform/projects.ts';
import { readPublishedSnapshot } from '../../platform/publish-snapshot.ts';
import { aggregateFor, ensureListingPage } from '../../services/publish-service.ts';
import { buildLocaleLinks } from '../../services/i18n-service.ts';
import { composeAddress, renderListingPage } from '../../render/page-renderer.ts';
import { resolveAvailability } from '../../domain/availability.ts';

/** 生成页面类插件使用的严格 CSP（与平台内预览一致） */
const GENERATED_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

function notFound(reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .type('text/html; charset=utf-8')
    .send(
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>页面不存在</title></head><body style="font-family:system-ui;padding:40px;text-align:center">' +
        '<h1>页面不存在</h1><p>这个地址没有正在托管的页面，或者托管已经停止。</p></body></html>',
    );
}

export function registerPublicSiteRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { slug: string } }>('/s/:slug', async (request, reply) => {
    const project = getProjectBySlug(ctx.db, request.params.slug);
    // 未发布 / 已停止托管 / 从未存在 —— 一律 404，不区分（避免成为「这个短链有没有人用」的探测器）
    if (!project) return notFound(reply);

    // 用户自己的工作区：既有的渲染与查询链路都以 ctx.workspace 为作用域
    const workspace = getWorkspace(ctx.db, project.workspaceId);
    if (!workspace) return notFound(reply);
    const scoped: AppContext = { ...ctx, workspace };

    const versionSpec = project.publishedVersionId
      ? (ctx.db.prepare('SELECT spec_json FROM project_versions WHERE id = ?').get(project.publishedVersionId) as
          | { spec_json: string }
          | undefined)
      : undefined;
    // 公开访问必须渲染**发布版本**，而不是当前草稿 ——
    // 否则用户一改草稿，线上页面就跟着变了。
    let spec = project.spec;
    if (versionSpec) {
      try {
        spec = JSON.parse(versionSpec.spec_json) as Record<string, unknown>;
      } catch {
        // 版本内容损坏时退回当前 spec，至少不要 500
      }
    }

    if (project.pluginId === 'custom-page') {
      const html = spec['html'];
      if (typeof html !== 'string' || html === '') return notFound(reply);
      return reply
        .type('text/html; charset=utf-8')
        .header('X-Robots-Tag', 'noindex')
        .header('Content-Security-Policy', GENERATED_PAGE_CSP)
        .header('X-Content-Type-Options', 'nosniff')
        .send(html);
    }

    if (project.pluginId === 'listing') {
      const propertyId = spec['propertyId'];
      if (typeof propertyId !== 'string' || propertyId === '') return notFound(reply);

      // ---- 优先使用发布快照 ----
      //
      // 房源类项目的公开页**必须**渲染最近一次成功发布的数据，
      // 而不是当前 `properties` 记录 —— 因为 `saveDraft` 会把草稿同步进
      // properties，读实时数据等于「一改草稿，线上当场就变」。
      //
      // 老版本（本修复之前发布的）没有快照，回退到原有实时读取逻辑，
      // 这样既有的发布页不会因为这次改动而打不开。
      const snapshot = readPublishedSnapshot(ctx.db, project.publishedVersionId);

      if (snapshot) {
        const aggregate = snapshot.aggregate;
        const page = aggregate.listingPage;
        if (!page) return notFound(reply);

        const html = renderListingPage({
          aggregate,
          workspace: scoped.workspace,
          locale: snapshot.locale,
          publicUrl: scoped.adapters.hosting.resolvePublicUrl(page.slug, {
            customDomain: page.customDomain,
            domainVerifyToken: page.domainVerifyToken,
            domainVerifiedAt: page.domainVerifiedAt,
          }).url,
          templateId: page.templateId,
          mapView: scoped.adapters.map.buildView({
            latitude: aggregate.property.latitude,
            longitude: aggregate.property.longitude,
            addressText: composeAddress(aggregate.property),
          }),
          nearby: null,
          localeLinks: buildLocaleLinks(scoped, propertyId, snapshot.locale),
          includeMapScript: true,
          includeQr: true,
          generatedAt: scoped.adapters.clock.now(),
          nonce: request.cspNonce,
          availability: resolveAvailability(
            aggregate.property,
            scoped.adapters.clock.now(),
            scoped.config.listingStaleDays,
          ),
        });

        return reply.type('text/html; charset=utf-8').send(html);
      }

      // ---- 回退：本修复之前发布的旧版本没有快照 ----
      //
      // 注意这里保留 `ensureListingPage`：旧版本可能确实还没有展示页记录，
      // 而它的 slug / 模板设置需要现取。新版本走上面的快照分支，
      // 不再在 GET 里写库。
      const aggregate = aggregateFor(scoped, propertyId);
      const page = ensureListingPage(scoped, propertyId);
      const locale = page.locale ?? scoped.workspace.defaultLocale;

      const html = renderListingPage({
        aggregate,
        workspace: scoped.workspace,
        locale,
        publicUrl: scoped.adapters.hosting.resolvePublicUrl(page.slug, {
          customDomain: page.customDomain,
          domainVerifyToken: page.domainVerifyToken,
          domainVerifiedAt: page.domainVerifiedAt,
        }).url,
        templateId: page.templateId,
        mapView: scoped.adapters.map.buildView({
          latitude: aggregate.property.latitude,
          longitude: aggregate.property.longitude,
          addressText: composeAddress(aggregate.property),
        }),
        nearby: null,
        localeLinks: buildLocaleLinks(scoped, propertyId, locale),
        includeMapScript: true,
        includeQr: true,
        generatedAt: scoped.adapters.clock.now(),
        nonce: request.cspNonce,
        availability: resolveAvailability(
          aggregate.property,
          scoped.adapters.clock.now(),
          scoped.config.listingStaleDays,
        ),
      });

      return reply.type('text/html; charset=utf-8').send(html);
    }

    // 未知插件类型：不猜测怎么渲染
    return notFound(reply);
  });
}

export { DomainError };