/**
 * 房源仓储（唯一数据源）。
 *
 * 方案第六章第 3 条：不创建平行系统。后台列表、展示页、导出、
 * 提醒全部通过本仓储读取同一张 properties 表。
 */

import type { Database } from '../database.ts';
import { asInt, asNumber, asText, asTextOrNull, nowIso } from '../database.ts';
import { buildUpdate, likePattern, toSqlValue } from '../sql.ts';
import type { AreaUnit, ListingStatus, PricePeriod, Property, PropertyStatus } from '../../domain/types.ts';
import type { PropertyFormValues } from '../../domain/property.ts';
import { newId } from '../../util/ids.ts';

/** 字段名 -> 数据库列名 */
export const PROPERTY_COLUMNS: Record<keyof PropertyFormValues, string> = {
  title: 'title',
  description: 'description',
  addressLine: 'address_line',
  district: 'district',
  city: 'city',
  region: 'region',
  countryCode: 'country_code',
  postalCode: 'postal_code',
  latitude: 'latitude',
  longitude: 'longitude',
  propertyType: 'property_type',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
  areaValue: 'area_value',
  areaUnit: 'area_unit',
  floorNote: 'floor_note',
  priceAmount: 'price_amount',
  priceCurrency: 'price_currency',
  pricePeriod: 'price_period',
  depositAmount: 'deposit_amount',
  depositCurrency: 'deposit_currency',
  extraFeesNote: 'extra_fees_note',
  availableFrom: 'available_from',
  status: 'status',
  availabilityStatus: 'availability_status',
};

const SELECT_COLUMNS = `
  id, workspace_id, title, description,
  address_line, district, city, region, country_code, postal_code,
  latitude, longitude,
  property_type, bedrooms, bathrooms, area_value, area_unit, floor_note,
  price_amount, price_currency, price_period,
  deposit_amount, deposit_currency, extra_fees_note,
  available_from, status, availability_status, created_at, updated_at
`;

export function mapProperty(row: Record<string, unknown>): Property {
  return {
    id: asText(row['id']),
    workspaceId: asText(row['workspace_id']),
    title: asText(row['title']),
    description: asText(row['description']),
    addressLine: asText(row['address_line']),
    district: asText(row['district']),
    city: asText(row['city']),
    region: asText(row['region']),
    countryCode: asText(row['country_code']),
    postalCode: asText(row['postal_code']),
    latitude: asNumber(row['latitude']),
    longitude: asNumber(row['longitude']),
    propertyType: asText(row['property_type']),
    bedrooms: asNumber(row['bedrooms']),
    bathrooms: asNumber(row['bathrooms']),
    areaValue: asNumber(row['area_value']),
    areaUnit: asText(row['area_unit']) as AreaUnit,
    floorNote: asText(row['floor_note']),
    priceAmount: asNumber(row['price_amount']),
    priceCurrency: asText(row['price_currency']),
    pricePeriod: asText(row['price_period']) as PricePeriod,
    depositAmount: asNumber(row['deposit_amount']),
    depositCurrency: asText(row['deposit_currency']),
    extraFeesNote: asText(row['extra_fees_note']),
    availableFrom: asTextOrNull(row['available_from']),
    status: asText(row['status']) as PropertyStatus,
    availabilityStatus:
      asText(row['availability_status']) === 'rented' ? 'rented' : 'available',
    createdAt: asText(row['created_at']),
    updatedAt: asText(row['updated_at']),
  };
}

export function insertProperty(
  db: Database,
  workspaceId: string,
  form: PropertyFormValues,
): Property {
  const id = newId('property');
  const now = nowIso();

  const fields = Object.keys(PROPERTY_COLUMNS) as (keyof PropertyFormValues)[];
  const columns = fields.map((f) => PROPERTY_COLUMNS[f]);
  const placeholders = fields.map(() => '?');
  const values = fields.map((f) => toSqlValue(form[f]));

  db.prepare(
    `INSERT INTO properties (id, workspace_id, ${columns.join(', ')}, created_at, updated_at)
     VALUES (?, ?, ${placeholders.join(', ')}, ?, ?)`,
  ).run(id, workspaceId, ...values, now, now);

  const created = getProperty(db, id);
  if (!created) throw new Error('房源创建后读取失败，请检查数据库连接');
  return created;
}

export function getProperty(db: Database, id: string): Property | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM properties WHERE id = ?`).get(id);
  return row ? mapProperty(row as Record<string, unknown>) : null;
}

/** 按 ID 读取，不存在时抛错（服务层用） */
export function requireProperty(db: Database, id: string): Property {
  const found = getProperty(db, id);
  if (!found) {
    const error = new Error(`房源不存在：${id}`);
    error.name = 'NotFound';
    throw error;
  }
  return found;
}

export function updateProperty(
  db: Database,
  id: string,
  patch: Partial<PropertyFormValues>,
): Property {
  const { sql, values } = buildUpdate('properties', PROPERTY_COLUMNS, patch, 'id = ?');

  if (sql !== '') {
    db.prepare(sql).run(...values, id);
  }

  // 即使没有字段变化也刷新 updated_at，保证「最后修改时间」语义正确
  db.prepare('UPDATE properties SET updated_at = ? WHERE id = ?').run(nowIso(), id);

  const updated = getProperty(db, id);
  if (!updated) {
    const error = new Error(`房源不存在：${id}`);
    error.name = 'NotFound';
    throw error;
  }
  return updated;
}

/** 硬删除（会级联清理媒体、译文、联系方式、发布页与提醒） */
export function deleteProperty(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM properties WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

export interface PropertyListFilter {
  workspaceId: string;
  status?: PropertyStatus | 'all';
  /** 关键词：标题 / 城市 / 区域 / 地址 */
  search?: string;
  /** 是否包含归档房源，默认 false（归档默认不出现在主列表） */
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'updated_desc' | 'created_desc' | 'title_asc';
}

export interface PropertyListResult {
  items: Property[];
  total: number;
}

/** 列表查询：支持搜索、状态筛选、归档过滤与分页 */
export function listProperties(db: Database, filter: PropertyListFilter): PropertyListResult {
  const where: string[] = ['workspace_id = ?'];
  const params: (string | number)[] = [filter.workspaceId];

  if (filter.status && filter.status !== 'all') {
    where.push('status = ?');
    params.push(filter.status);
  } else if (!filter.includeArchived) {
    where.push("status <> 'archived'");
  }

  const search = (filter.search ?? '').trim();
  if (search !== '') {
    where.push(`(
      LOWER(title) LIKE ? ESCAPE '\\' OR
      LOWER(city) LIKE ? ESCAPE '\\' OR
      LOWER(district) LIKE ? ESCAPE '\\' OR
      LOWER(address_line) LIKE ? ESCAPE '\\' OR
      LOWER(region) LIKE ? ESCAPE '\\'
    )`);
    const pattern = likePattern(search);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  const whereSql = where.join(' AND ');

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM properties WHERE ${whereSql}`)
    .get(...params);
  const total = asInt((totalRow as Record<string, unknown> | undefined)?.['total'], 0);

  const orderBy =
    filter.sort === 'created_desc'
      ? 'created_at DESC'
      : filter.sort === 'title_asc'
        ? 'title ASC'
        : 'updated_at DESC';

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM properties
       WHERE ${whereSql}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  return {
    items: rows.map((row) => mapProperty(row as Record<string, unknown>)),
    total,
  };
}

/** 状态统计，用于后台概览 */
export function countByStatus(db: Database, workspaceId: string): Record<string, number> {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS total FROM properties WHERE workspace_id = ? GROUP BY status')
    .all(workspaceId);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    counts[asText(record['status'])] = asInt(record['total'], 0);
  }
  return counts;
}

/** 检查同一工作区内是否已存在同名且同地址的房源，用于「避免重复录入」（方案第三章第 5 条） */
export function findDuplicate(
  db: Database,
  workspaceId: string,
  title: string,
  city: string,
): Property | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM properties
       WHERE workspace_id = ? AND LOWER(title) = LOWER(?) AND LOWER(city) = LOWER(?)
       LIMIT 1`,
    )
    .get(workspaceId, title.trim(), city.trim());
  return row ? mapProperty(row as Record<string, unknown>) : null;
}
/** 列表查询用的别名列（与 SELECT_COLUMNS 对应，供 JOIN 场景使用） */
const SELECT_COLUMNS_ALIASED = `
  p.id, p.workspace_id, p.title, p.description,
  p.address_line, p.district, p.city, p.region, p.country_code, p.postal_code,
  p.latitude, p.longitude,
  p.property_type, p.bedrooms, p.bathrooms, p.area_value, p.area_unit, p.floor_note,
  p.price_amount, p.price_currency, p.price_period,
  p.deposit_amount, p.deposit_currency, p.extra_fees_note,
  p.available_from, p.status, p.availability_status, p.created_at, p.updated_at
`;

export interface PropertyListRow {
  property: Property;
  listing: { slug: string; status: ListingStatus; templateId: string } | null;
  photoCount: number;
  /** 封面图的存储键（无照片时为 null）。列表卡片要用它渲染缩略图。 */
  coverStorageKey: string | null;
}

/**
 * 列表 + 发布状态 + 照片数量，使用单条 SQL 完成。
 *
 * 之前由调用方对每一行再取一次聚合，会产生 N+1 次查询；
 * 房源列表是最常打开的页面，必须一次查完。
 */
export function listPropertiesWithMeta(
  db: Database,
  filter: PropertyListFilter,
): { items: PropertyListRow[]; total: number } {
  const where: string[] = ['p.workspace_id = ?'];
  const params: (string | number)[] = [filter.workspaceId];

  if (filter.status && filter.status !== 'all') {
    where.push('p.status = ?');
    params.push(filter.status);
  } else if (!filter.includeArchived) {
    where.push("p.status <> 'archived'");
  }

  const search = (filter.search ?? '').trim();
  if (search !== '') {
    where.push(`(
      LOWER(p.title) LIKE ? ESCAPE '\\' OR
      LOWER(p.city) LIKE ? ESCAPE '\\' OR
      LOWER(p.district) LIKE ? ESCAPE '\\' OR
      LOWER(p.address_line) LIKE ? ESCAPE '\\' OR
      LOWER(p.region) LIKE ? ESCAPE '\\'
    )`);
    const pattern = likePattern(search);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  const whereSql = where.join(' AND ');

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM properties p WHERE ${whereSql}`)
    .get(...params);
  const total = asInt((totalRow as Record<string, unknown> | undefined)?.['total'], 0);

  const orderBy =
    filter.sort === 'created_desc'
      ? 'p.created_at DESC'
      : filter.sort === 'title_asc'
        ? 'p.title ASC'
        : 'p.updated_at DESC';

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS_ALIASED},
              lp.slug AS listing_slug,
              lp.status AS listing_status,
              lp.template_id AS listing_template_id,
              (SELECT COUNT(*) FROM media m WHERE m.property_id = p.id AND m.kind = 'photo') AS photo_count,
              -- 封面优先取 is_cover=1，否则取排序最前的一张。
              -- 与 count 一起用子查询完成，保持单条 SQL 的 N+1 规避。
              (SELECT m.storage_key FROM media m
                WHERE m.property_id = p.id AND m.kind = 'photo'
                ORDER BY m.is_cover DESC, m.sort_order ASC, m.created_at ASC
                LIMIT 1) AS cover_storage_key
       FROM properties p
       LEFT JOIN listing_pages lp ON lp.property_id = p.id
       WHERE ${whereSql}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  const items = rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const slug = asTextOrNull(row['listing_slug']);

    return {
      property: mapProperty(row),
      listing: slug
        ? {
            slug,
            status: asText(row['listing_status']) as ListingStatus,
            templateId: asText(row['listing_template_id']),
          }
        : null,
      photoCount: asInt(row['photo_count'], 0),
      coverStorageKey: asTextOrNull(row['cover_storage_key']),
    };
  });

  return { items, total };
}