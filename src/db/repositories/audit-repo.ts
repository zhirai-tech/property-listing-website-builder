/**
 * 审计日志仓储。
 *
 * 方案第八章第 6 条：记录计划时间、执行状态和失败原因。
 * 除提醒外，关键写操作（发布、撤下、删除、导出、备份）也记录在案。
 */

import type { Database } from '../database.ts';
import { asText } from '../database.ts';
import { newId } from '../../util/ids.ts';
import type { AuditLogEntry } from '../../domain/types.ts';

const SELECT_COLUMNS = 'id, at, actor, action, entity_type, entity_id, detail';

export function mapAudit(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: asText(row['id']),
    at: asText(row['at']),
    actor: asText(row['actor']),
    action: asText(row['action']),
    entityType: asText(row['entity_type']),
    entityId: asText(row['entity_id']),
    detail: asText(row['detail']),
  };
}

export function appendAudit(
  db: Database,
  entry: Omit<AuditLogEntry, 'id' | 'at'> & { at?: string },
): AuditLogEntry {
  const id = newId('audit');
  const at = entry.at ?? new Date().toISOString();

  db.prepare(
    'INSERT INTO audit_logs (id, at, actor, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, at, entry.actor, entry.action, entry.entityType, entry.entityId, entry.detail);

  return {
    id,
    at,
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    detail: entry.detail,
  };
}

export function listRecentAudit(db: Database, limit = 100): AuditLogEntry[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM audit_logs ORDER BY at DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 500));
  return rows.map((row) => mapAudit(row as Record<string, unknown>));
}

export function listEntityAudit(
  db: Database,
  entityType: string,
  entityId: string,
  limit = 50,
): AuditLogEntry[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM audit_logs
       WHERE entity_type = ? AND entity_id = ? ORDER BY at DESC LIMIT ?`,
    )
    .all(entityType, entityId, Math.min(Math.max(limit, 1), 500));
  return rows.map((row) => mapAudit(row as Record<string, unknown>));
}
