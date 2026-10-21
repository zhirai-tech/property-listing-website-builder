/**
 * 房源译文仓储。
 *
 * 方案第三章第 7 条：原始描述与翻译文本必须分开保存，
 * 因此译文独立成表，切换语言永远不会覆盖原文。
 */

import type { Database } from '../database.ts';
import { asText, nowIso } from '../database.ts';
import { newId } from '../../util/ids.ts';
import type { PropertyTranslation } from '../../domain/types.ts';

export function mapTranslation(row: Record<string, unknown>): PropertyTranslation {
  return {
    id: asText(row['id']),
    propertyId: asText(row['property_id']),
    locale: asText(row['locale']),
    title: asText(row['title']),
    description: asText(row['description']),
    createdAt: asText(row['created_at']),
    updatedAt: asText(row['updated_at']),
  };
}

export function listTranslations(db: Database, propertyId: string): PropertyTranslation[] {
  const rows = db
    .prepare(
      'SELECT id, property_id, locale, title, description, created_at, updated_at FROM property_translations WHERE property_id = ? ORDER BY locale',
    )
    .all(propertyId);
  return rows.map((row) => mapTranslation(row as Record<string, unknown>));
}

export function getTranslation(
  db: Database,
  propertyId: string,
  locale: string,
): PropertyTranslation | null {
  const row = db
    .prepare(
      `SELECT id, property_id, locale, title, description, created_at, updated_at
       FROM property_translations WHERE property_id = ? AND LOWER(locale) = LOWER(?)`,
    )
    .get(propertyId, locale);
  return row ? mapTranslation(row as Record<string, unknown>) : null;
}

/** 新增或更新某个语言的译文（按 property_id + locale 唯一） */
export function upsertTranslation(
  db: Database,
  propertyId: string,
  locale: string,
  title: string,
  description: string,
): PropertyTranslation {
  const now = nowIso();
  const existing = getTranslation(db, propertyId, locale);

  if (existing) {
    db.prepare(
      'UPDATE property_translations SET title = ?, description = ?, updated_at = ? WHERE id = ?',
    ).run(title, description, now, existing.id);
    return { ...existing, title, description, updatedAt: now };
  }

  const id = newId('translation');
  db.prepare(
    `INSERT INTO property_translations (id, property_id, locale, title, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, propertyId, locale, title, description, now, now);

  return { id, propertyId, locale, title, description, createdAt: now, updatedAt: now };
}

export function deleteTranslation(db: Database, propertyId: string, locale: string): boolean {
  const result = db
    .prepare('DELETE FROM property_translations WHERE property_id = ? AND LOWER(locale) = LOWER(?)')
    .run(propertyId, locale);
  return Number(result.changes) > 0;
}
