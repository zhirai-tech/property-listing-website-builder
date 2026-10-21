/**
 * 发布页仓储（方案第四章第 4 条）。
 */

import type { Database } from '../database.ts';
import { asInt, asText, asTextOrNull, nowIso } from '../database.ts';
import { buildUpdate, toSqlValue } from '../sql.ts';
import { newId } from '../../util/ids.ts';
import type { ListingPage, ListingStatus, TemplateId } from '../../domain/types.ts';

const SELECT_COLUMNS = `
  id, property_id, workspace_id, slug, locale, template_id, status,
  published_at, withdrawn_at, custom_domain, domain_verify_token, domain_verified_at,
  view_count, created_at, updated_at
`;

export function mapListingPage(row: Record<string, unknown>): ListingPage {
  return {
    id: asText(row['id']),
    propertyId: asText(row['property_id']),
    workspaceId: asText(row['workspace_id']),
    slug: asText(row['slug']),
    locale: asText(row['locale']),
    templateId: asText(row['template_id']) as TemplateId,
    status: asText(row['status']) as ListingStatus,
    publishedAt: asTextOrNull(row['published_at']),
    withdrawnAt: asTextOrNull(row['withdrawn_at']),
    customDomain: asTextOrNull(row['custom_domain']),
    domainVerifyToken: asTextOrNull(row['domain_verify_token']),
    domainVerifiedAt: asTextOrNull(row['domain_verified_at']),
    viewCount: asInt(row['view_count'], 0),
    createdAt: asText(row['created_at']),
    updatedAt: asText(row['updated_at']),
  };
}

export function getListingPageById(db: Database, id: string): ListingPage | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM listing_pages WHERE id = ?`).get(id);
  return row ? mapListingPage(row as Record<string, unknown>) : null;
}

export function getListingPageByProperty(db: Database, propertyId: string): ListingPage | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listing_pages WHERE property_id = ? LIMIT 1`)
    .get(propertyId);
  return row ? mapListingPage(row as Record<string, unknown>) : null;
}

/** 公开页只按 slug 查询；调用方仍需检查 status = published */
export function getListingPageBySlug(db: Database, slug: string): ListingPage | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listing_pages WHERE slug = ? LIMIT 1`)
    .get(slug);
  return row ? mapListingPage(row as Record<string, unknown>) : null;
}

export function slugExists(db: Database, slug: string): boolean {
  const row = db.prepare('SELECT 1 AS found FROM listing_pages WHERE slug = ? LIMIT 1').get(slug);
  return row !== undefined;
}

export function getListingPageByDomain(db: Database, domain: string): ListingPage | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM listing_pages WHERE LOWER(custom_domain) = LOWER(?) LIMIT 1`)
    .get(domain);
  return row ? mapListingPage(row as Record<string, unknown>) : null;
}

export interface ListingPageInput {
  slug: string;
  locale: string;
  templateId: TemplateId;
}

export function insertListingPage(
  db: Database,
  propertyId: string,
  workspaceId: string,
  input: ListingPageInput,
): ListingPage {
  const id = newId('listingPage');
  const now = nowIso();

  db.prepare(
    `INSERT INTO listing_pages (id, property_id, workspace_id, slug, locale, template_id, status,
                                published_at, withdrawn_at, custom_domain, domain_verify_token,
                                domain_verified_at, view_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unpublished', NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
  ).run(id, propertyId, workspaceId, input.slug, input.locale, input.templateId, now, now);

  const created = getListingPageById(db, id);
  if (!created) throw new Error('发布页创建后读取失败');
  return created;
}

const LISTING_COLUMNS: Record<string, string> = {
  slug: 'slug',
  locale: 'locale',
  templateId: 'template_id',
  status: 'status',
  publishedAt: 'published_at',
  withdrawnAt: 'withdrawn_at',
  customDomain: 'custom_domain',
  domainVerifyToken: 'domain_verify_token',
  domainVerifiedAt: 'domain_verified_at',
};

export type ListingPagePatch = {
  slug?: string;
  locale?: string;
  templateId?: TemplateId;
  status?: ListingStatus;
  publishedAt?: string | null;
  withdrawnAt?: string | null;
  customDomain?: string | null;
  domainVerifyToken?: string | null;
  domainVerifiedAt?: string | null;
};

export function updateListingPage(
  db: Database,
  id: string,
  patch: ListingPagePatch,
): ListingPage | null {
  const { sql, values } = buildUpdate('listing_pages', LISTING_COLUMNS, patch, 'id = ?');
  if (sql !== '') db.prepare(sql).run(...values, id);
  db.prepare('UPDATE listing_pages SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  return getListingPageById(db, id);
}

export function incrementViewCount(db: Database, id: string): void {
  db.prepare('UPDATE listing_pages SET view_count = view_count + 1 WHERE id = ?').run(id);
}

export function listListingPages(db: Database, workspaceId: string): ListingPage[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM listing_pages WHERE workspace_id = ? ORDER BY updated_at DESC`,
    )
    .all(workspaceId);
  return rows.map((row) => mapListingPage(row as Record<string, unknown>));
}

export function deleteListingPage(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM listing_pages WHERE id = ?').run(id).changes) > 0;
}

/** 统计各发布状态数量，用于后台概览 */
export function countListingByStatus(db: Database, workspaceId: string): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS total FROM listing_pages WHERE workspace_id = ? GROUP BY status')
    .all(workspaceId);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    counts[asText(record['status'])] = asInt(record['total'], 0);
  }
  return counts;
}
