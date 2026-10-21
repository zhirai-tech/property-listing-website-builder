/**
 * 发布服务（方案第三章第 3 条、第 2 阶段验收）。
 *
 * 验收要点：
 *  - 修改房源后展示页同步更新（页面永远从聚合实时渲染，不存在缓存副本）；
 *  - 未发布房源不能被公开访问（公开查询强制要求 status = published）；
 *  - 后台与页面内容一致（同一份 PropertyAggregate）。
 */

import type { AppContext } from '../app-context.ts';
import { notFound, unprocessable, conflict } from '../domain/errors.ts';
import type { ListingPage, PropertyAggregate, TemplateId } from '../domain/types.ts';
import {
  assertPublishTransition,
  assertTemplateId,
  collectPublishReadiness,
  slugSeedFor,
} from '../domain/listing-page.ts';
import { nextAvailableSlug } from '../util/slug.ts';
import {
  getListingPageByProperty,
  getListingPageBySlug,
  insertListingPage,
  listListingPages,
  slugExists,
  updateListingPage,
} from '../db/repositories/listing-page-repo.ts';
import { listMedia } from '../db/repositories/media-repo.ts';
import { listEffectivePublicContacts } from '../db/repositories/contact-repo.ts';
import { listTranslations } from '../db/repositories/translation-repo.ts';
import { getProperty } from '../db/repositories/property-repo.ts';
import { recordAudit } from './audit-service.ts';
import { requireProperty } from './property-service.ts';
import { scheduleRemindersForPage } from './reminder-service.ts';

/** 生成在全库范围内唯一的 slug */
/**
 * 分配一个未被占用的短链。
 *
 * 【两个 slug 空间必须一起查】
 * 房源展示页用 `listing_pages.slug`，平台托管页用 `projects.public_slug`。
 * 一开始这里只查了前者 —— 于是平台项目的短链可能和某个房源展示页撞车，
 * 而两个空间的页面都能通过 `/s/` 访问，撞车意味着**其中一个永远打不开**。
 * 现在两边一起查，slug 是全局唯一的。
 */
export function allocateSlug(ctx: AppContext, seed: string): string {
  return nextAvailableSlug(seed, (candidate) => {
    if (slugExists(ctx.db, candidate)) return true;
    const project = ctx.db
      .prepare('SELECT 1 AS x FROM projects WHERE public_slug = ?')
      .get(candidate);
    return project !== undefined;
  });
}

/** 若房源尚无发布页则创建其一（不改变发布状态） */
export function ensureListingPage(ctx: AppContext, propertyId: string): ListingPage {
  const property = requireProperty(ctx, propertyId);

  const existing = getListingPageByProperty(ctx.db, propertyId);
  if (existing) return existing;

  const seed = slugSeedFor({
    title: property.title,
    city: property.city,
    propertyType: property.propertyType,
  });

  const slug = allocateSlug(ctx, seed);

  const created = insertListingPage(ctx.db, propertyId, ctx.workspace.id, {
    slug,
    locale: ctx.workspace.defaultLocale,
    templateId: 'modern',
  });

  recordAudit(ctx, {
    action: 'listing.create',
    entityType: 'listing_page',
    entityId: created.id,
    detail: { propertyId, slug },
  });

  return created;
}

export interface ListingSettingsPatch {
  slug?: string;
  locale?: string;
  templateId?: string;
}

/** 修改发布设置：slug 唯一性、模板合法性、语言格式都在此把关 */
export function updateListingSettings(
  ctx: AppContext,
  propertyId: string,
  patch: ListingSettingsPatch,
): ListingPage {
  const page = ensureListingPage(ctx, propertyId);

  const next: Parameters<typeof updateListingPage>[2] = {};

  if (patch.slug !== undefined) {
    const slug = patch.slug.trim();

    if (slug === '') {
      // 留空表示重新按标题生成
      const property = requireProperty(ctx, propertyId);
      next.slug = allocateSlug(
        ctx,
        slugSeedFor({
          title: property.title,
          city: property.city,
          propertyType: property.propertyType,
        }),
      );
    } else {
      if (!/^[\p{L}\p{N}-]+$/u.test(slug)) {
        throw conflict('分享链接只能包含字母、数字、汉字与连字符');
      }
      if (slug.length > 80) throw conflict('分享链接最长 80 个字符');

      const taken = getListingPageBySlug(ctx.db, slug);
      if (taken && taken.id !== page.id) {
        throw conflict(`分享链接「${slug}」已被其它房源占用，请换一个`);
      }
      next.slug = slug;
    }
  }

  if (patch.locale !== undefined) {
    next.locale = patch.locale.trim() === '' ? ctx.workspace.defaultLocale : patch.locale.trim();
  }

  if (patch.templateId !== undefined) {
    next.templateId = assertTemplateId(patch.templateId) as TemplateId;
  }

  const updated = updateListingPage(ctx.db, page.id, next);
  if (!updated) throw notFound('发布页', page.id);

  recordAudit(ctx, {
    action: 'listing.settings',
    entityType: 'listing_page',
    entityId: page.id,
    detail: next as Record<string, unknown>,
  });

  return updated;
}

/** 当前聚合（后台与展示页共用的唯一数据源） */
export function aggregateFor(ctx: AppContext, propertyId: string): PropertyAggregate {
  const property = requireProperty(ctx, propertyId);
  const page = getListingPageByProperty(ctx.db, propertyId);

  return {
    property,
    media: listMedia(ctx.db, propertyId),
    contacts: listEffectivePublicContacts(ctx.db, ctx.workspace.id, propertyId),
    listingPage: page,
    translations: listTranslations(ctx.db, propertyId),
  };
}

/** 发布就绪检查：把阻塞项提前暴露给用户，而不是发布时才失败 */
export function readiness(
  ctx: AppContext,
  propertyId: string,
  locale: string,
): { ready: boolean; blockers: string[]; warnings: string[] } {
  const aggregate = aggregateFor(ctx, propertyId);
  return collectPublishReadiness({
    property: aggregate.property,
    media: aggregate.media,
    contacts: aggregate.contacts,
    locale,
    hasTranslationFor: (tag) =>
      tag === '' ||
      tag.toLowerCase() === ctx.workspace.defaultLocale.toLowerCase() ||
      aggregate.translations.some((t) => t.locale.toLowerCase() === tag.toLowerCase()),
  });
}

export interface PublishResult {
  page: ListingPage;
  publicUrl: string;
  warnings: string[];
}

export function publishListing(ctx: AppContext, propertyId: string): PublishResult {
  const page = ensureListingPage(ctx, propertyId);
  const check = readiness(ctx, propertyId, page.locale);

  if (!check.ready) {
    throw unprocessable(`发布前请先完善以下信息：${check.blockers.join('；')}`, []);
  }

  assertPublishTransition(page.status, 'published');

  const now = ctx.adapters.clock.now().toISOString();
  const updated = updateListingPage(ctx.db, page.id, {
    status: 'published',
    publishedAt: now,
    withdrawnAt: null,
  });
  if (!updated) throw notFound('发布页', page.id);

  // 发布后按配置生成第 7/15 天提醒
  scheduleRemindersForPage(ctx, updated);

  const url = publicUrlFor(ctx, updated);

  recordAudit(ctx, {
    action: 'listing.publish',
    entityType: 'listing_page',
    entityId: updated.id,
    detail: { propertyId, slug: updated.slug, url },
  });

  return { page: updated, publicUrl: url, warnings: check.warnings };
}

export function withdrawListing(ctx: AppContext, propertyId: string): ListingPage {
  const page = ensureListingPage(ctx, propertyId);
  assertPublishTransition(page.status, 'withdrawn');

  const now = ctx.adapters.clock.now().toISOString();
  const updated = updateListingPage(ctx.db, page.id, {
    status: 'withdrawn',
    withdrawnAt: now,
  });
  if (!updated) throw notFound('发布页', page.id);

  recordAudit(ctx, {
    action: 'listing.withdraw',
    entityType: 'listing_page',
    entityId: updated.id,
    detail: { propertyId },
  });

  return updated;
}

export function publicUrlFor(ctx: AppContext, page: ListingPage): string {
  const resolved = ctx.adapters.hosting.resolvePublicUrl(page.slug, {
    customDomain: page.customDomain,
    domainVerifyToken: page.domainVerifyToken,
    domainVerifiedAt: page.domainVerifiedAt,
  });
  return resolved.url;
}

/**
 * 公开访问查询。
 * 未发布（unpublished / withdrawn）一律返回 null —— 由路由层转 404，
 * 且不泄露「该房源是否存在」。
 */
export function findPublicPage(
  ctx: AppContext,
  slug: string,
): { aggregate: PropertyAggregate; page: ListingPage } | null {
  const page = getListingPageBySlug(ctx.db, slug);
  if (!page) return null;
  if (page.status !== 'published') return null;

  const property = getProperty(ctx.db, page.propertyId);
  if (!property) return null;

  return {
    page,
    aggregate: {
      property,
      media: listMedia(ctx.db, page.propertyId),
      contacts: listEffectivePublicContacts(ctx.db, property.workspaceId, page.propertyId),
      listingPage: page,
      translations: listTranslations(ctx.db, page.propertyId),
    },
  };
}

export interface AdminPageRow {
  page: ListingPage;
  propertyTitle: string;
  publicUrl: string;
  readiness: { ready: boolean; blockers: string[]; warnings: string[] };
}

export function listPagesAdmin(ctx: AppContext): AdminPageRow[] {
  return listListingPages(ctx.db, ctx.workspace.id)
    .map((page) => {
      const property = getProperty(ctx.db, page.propertyId);
      if (!property) return null;

      return {
        page,
        propertyTitle: property.title,
        publicUrl: publicUrlFor(ctx, page),
        readiness: readiness(ctx, page.propertyId, page.locale),
      };
    })
    .filter((row): row is AdminPageRow => row !== null);
}
