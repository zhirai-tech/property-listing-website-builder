/**
 * 媒体仓储（方案第四章第 2 条）。
 *
 * 约定：
 *  - sort_order 决定展示顺序；
 *  - 每个房源至多一张封面（is_cover = 1），由 setCover 保证；
 *  - source_note 记录素材来源/授权说明（方案第三章第 2 条）。
 */

import type { Database } from '../database.ts';
import { asInt, asText, asTextOrNull, fromBool, nowIso, toBool } from '../database.ts';
import { buildUpdate, toSqlValue } from '../sql.ts';
import { newId } from '../../util/ids.ts';
import type { Media, MediaKind } from '../../domain/types.ts';

const SELECT_COLUMNS = `
  id, property_id, kind, storage_key, external_url, original_name, mime_type,
  byte_size, sort_order, is_cover, source_note, created_at, updated_at
`;

export function mapMedia(row: Record<string, unknown>): Media {
  return {
    id: asText(row['id']),
    propertyId: asText(row['property_id']),
    kind: asText(row['kind']) as MediaKind,
    storageKey: asText(row['storage_key']),
    externalUrl: asTextOrNull(row['external_url']),
    originalName: asText(row['original_name']),
    mimeType: asText(row['mime_type']),
    byteSize: asInt(row['byte_size'], 0),
    sortOrder: asInt(row['sort_order'], 0),
    isCover: toBool(row['is_cover']),
    sourceNote: asText(row['source_note']),
    createdAt: asText(row['created_at']),
    updatedAt: asText(row['updated_at']),
  };
}

export interface MediaInput {
  kind: MediaKind;
  storageKey?: string;
  externalUrl?: string | null;
  originalName?: string;
  mimeType?: string;
  byteSize?: number;
  sortOrder?: number;
  isCover?: boolean;
  sourceNote?: string;
}

export function insertMedia(db: Database, propertyId: string, input: MediaInput): Media {
  const id = newId('media');
  const now = nowIso();

  db.prepare(
    `INSERT INTO media (id, property_id, kind, storage_key, external_url, original_name, mime_type,
                        byte_size, sort_order, is_cover, source_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    propertyId,
    input.kind,
    input.storageKey ?? '',
    input.externalUrl ?? null,
    input.originalName ?? '',
    input.mimeType ?? '',
    input.byteSize ?? 0,
    input.sortOrder ?? 0,
    fromBool(input.isCover ?? false),
    input.sourceNote ?? '',
    now,
    now,
  );

  const created = getMedia(db, id);
  if (!created) throw new Error('媒体记录创建后读取失败');
  return created;
}

const MEDIA_COLUMNS: Record<string, string> = {
  kind: 'kind',
  storageKey: 'storage_key',
  externalUrl: 'external_url',
  originalName: 'original_name',
  mimeType: 'mime_type',
  byteSize: 'byte_size',
  sortOrder: 'sort_order',
  isCover: 'is_cover',
  sourceNote: 'source_note',
};

export function getMedia(db: Database, id: string): Media | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM media WHERE id = ?`).get(id);
  return row ? mapMedia(row as Record<string, unknown>) : null;
}

export function updateMedia(db: Database, id: string, patch: Partial<MediaInput>): Media | null {
  const { sql, values } = buildUpdate('media', MEDIA_COLUMNS, patch, 'id = ?');
  if (sql !== '') db.prepare(sql).run(...values, id);
  db.prepare('UPDATE media SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  return getMedia(db, id);
}

export function deleteMedia(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM media WHERE id = ?').run(id).changes) > 0;
}

/**
 * 按 sort_order 返回媒体列表。
 *
 * 注意：这里刻意不把封面排到最前 —— 封面归属由 is_cover 单独表达，
 * 排序只反映用户显式调整的顺序。否则后台「上移/下移」会被封面强制置顶掩盖，
 * 用户会以为排序没有生效。
 */
export function listMedia(db: Database, propertyId: string): Media[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM media WHERE property_id = ?
       ORDER BY sort_order ASC, created_at ASC`,
    )
    .all(propertyId);
  return rows.map((row) => mapMedia(row as Record<string, unknown>));
}

export function countPhotos(db: Database, propertyId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM media WHERE property_id = ? AND kind = 'photo'")
    .get(propertyId);
  return asInt((row as Record<string, unknown> | undefined)?.['total'], 0);
}

export function nextSortOrder(db: Database, propertyId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM media WHERE property_id = ?')
    .get(propertyId);
  return asInt((row as Record<string, unknown> | undefined)?.['max_order'], -1) + 1;
}

/**
 * 应用封面归属：先把该房源所有媒体置为非封面，再把目标置为封面。
 * 保证「至多一张封面」这一不变量在数据库层面成立。
 */
export function applyCover(db: Database, propertyId: string, coverId: string | null): void {
  db.prepare('UPDATE media SET is_cover = 0 WHERE property_id = ?').run(propertyId);
  if (coverId) {
    db.prepare('UPDATE media SET is_cover = 1, updated_at = ? WHERE id = ? AND property_id = ?').run(
      nowIso(),
      coverId,
      propertyId,
    );
  }
}

/** 按给定顺序重排 */
export function applyOrder(db: Database, orderedIds: readonly string[]): void {
  const stmt = db.prepare('UPDATE media SET sort_order = ?, updated_at = ? WHERE id = ?');
  const now = nowIso();
  orderedIds.forEach((id, index) => {
    stmt.run(index, now, id);
  });
}

/** 取封面：优先 is_cover，其次排序最靠前的一张照片 */
export function getCover(db: Database, propertyId: string): Media | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM media
       WHERE property_id = ? AND kind = 'photo'
       ORDER BY is_cover DESC, sort_order ASC, created_at ASC
       LIMIT 1`,
    )
    .get(propertyId);
  return row ? mapMedia(row as Record<string, unknown>) : null;
}

/** 删除房源时清理素材文件前，先取出所有 storage_key */
export function listStorageKeys(db: Database, propertyId: string): string[] {
  const rows = db
    .prepare("SELECT storage_key FROM media WHERE property_id = ? AND storage_key <> ''")
    .all(propertyId);
  return rows.map((row) => asText((row as Record<string, unknown>)['storage_key']));
}
