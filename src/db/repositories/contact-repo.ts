/**
 * 联系方式仓储（方案第四章第 3 条）。
 *
 * 公开策略（方案第三章第 10 条）：只有 is_public = 1 的渠道才会出现在展示页，
 * 因此公开页查询走 listPublicContacts，从数据层就杜绝越权泄露。
 */

import type { Database } from '../database.ts';
import { asInt, asText, fromBool, nowIso, toBool } from '../database.ts';
import { buildUpdate, toSqlValue } from '../sql.ts';
import { newId } from '../../util/ids.ts';
import type { Contact, ContactChannelKind } from '../../domain/types.ts';

const SELECT_COLUMNS = `
  id, workspace_id, property_id, display_name, channel_kind, channel_value,
  is_public, sort_order, created_at, updated_at
`;

export function mapContact(row: Record<string, unknown>): Contact {
  return {
    id: asText(row['id']),
    workspaceId: asText(row['workspace_id']),
    propertyId: asText(row['property_id']) === '' ? null : asText(row['property_id']),
    displayName: asText(row['display_name']),
    channelKind: asText(row['channel_kind']) as ContactChannelKind,
    channelValue: asText(row['channel_value']),
    isPublic: toBool(row['is_public']),
    sortOrder: asInt(row['sort_order'], 0),
    createdAt: asText(row['created_at']),
    updatedAt: asText(row['updated_at']),
  };
}

export interface ContactInput {
  displayName: string;
  channelKind: ContactChannelKind;
  channelValue: string;
  isPublic: boolean;
  sortOrder?: number;
}

export function insertContact(
  db: Database,
  workspaceId: string,
  propertyId: string | null,
  input: ContactInput,
): Contact {
  const id = newId('contact');
  const now = nowIso();

  db.prepare(
    `INSERT INTO contacts (id, workspace_id, property_id, display_name, channel_kind, channel_value,
                           is_public, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    propertyId,
    input.displayName,
    input.channelKind,
    input.channelValue,
    fromBool(input.isPublic),
    input.sortOrder ?? 0,
    now,
    now,
  );

  const created = getContact(db, id);
  if (!created) throw new Error('联系方式创建后读取失败');
  return created;
}

const CONTACT_COLUMNS: Record<string, string> = {
  displayName: 'display_name',
  channelKind: 'channel_kind',
  channelValue: 'channel_value',
  isPublic: 'is_public',
  sortOrder: 'sort_order',
};

export function getContact(db: Database, id: string): Contact | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM contacts WHERE id = ?`).get(id);
  return row ? mapContact(row as Record<string, unknown>) : null;
}

export function updateContact(db: Database, id: string, patch: Partial<ContactInput>): Contact | null {
  const { sql, values } = buildUpdate('contacts', CONTACT_COLUMNS, patch, 'id = ?');
  if (sql !== '') db.prepare(sql).run(...values, id);
  db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  return getContact(db, id);
}

export function deleteContact(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM contacts WHERE id = ?').run(id).changes) > 0;
}

/** 房源级联系方式 */
export function listPropertyContacts(db: Database, propertyId: string): Contact[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM contacts WHERE property_id = ? ORDER BY sort_order, created_at`)
    .all(propertyId);
  return rows.map((row) => mapContact(row as Record<string, unknown>));
}

/** 工作区级默认联系方式（property_id IS NULL） */
export function listWorkspaceContacts(db: Database, workspaceId: string): Contact[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM contacts WHERE workspace_id = ? AND property_id IS NULL ORDER BY sort_order, created_at`,
    )
    .all(workspaceId);
  return rows.map((row) => mapContact(row as Record<string, unknown>));
}

/**
 * 展示页实际生效的联系方式：房源级优先；房源没有任何联系方式时回退工作区默认。
 * 只返回用户明确标记为公开的渠道。
 */
export function listEffectivePublicContacts(
  db: Database,
  workspaceId: string,
  propertyId: string,
): Contact[] {
  const propertyContacts = listPropertyContacts(db, propertyId).filter((c) => c.isPublic);
  if (propertyContacts.length > 0) return propertyContacts;
  return listWorkspaceContacts(db, workspaceId).filter((c) => c.isPublic);
}

/** 后台展示用：房源级 + 工作区默认，附带来源标记 */
export function listContactsWithSource(
  db: Database,
  workspaceId: string,
  propertyId: string,
): { contact: Contact; source: 'property' | 'workspace' }[] {
  const own = listPropertyContacts(db, propertyId).map((contact) => ({
    contact,
    source: 'property' as const,
  }));
  const shared = listWorkspaceContacts(db, workspaceId).map((contact) => ({
    contact,
    source: 'workspace' as const,
  }));
  return [...own, ...shared];
}
