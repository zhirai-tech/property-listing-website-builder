/**
 * 提醒仓储（方案第四章第 5 条）。
 *
 * 幂等由 idempotency_key 唯一索引保证：同一房源同一类型只能有一条记录，
 * 因此重复调用不会造成重复通知（方案第八章第 6 条）。
 */

import type { Database } from '../database.ts';
import { asInt, asText, asTextOrNull, nowIso } from '../database.ts';
import { buildUpdate } from '../sql.ts';
import { newId } from '../../util/ids.ts';
import type { Reminder, ReminderKind, ReminderStatus } from '../../domain/types.ts';

const SELECT_COLUMNS = `
  id, property_id, listing_page_id, kind, due_at, timezone, status, attempts,
  last_attempt_at, last_error, completed_at, idempotency_key, created_at, updated_at
`;

export function mapReminder(row: Record<string, unknown>): Reminder {
  return {
    id: asText(row['id']),
    propertyId: asText(row['property_id']),
    listingPageId: asTextOrNull(row['listing_page_id']),
    kind: asText(row['kind']) as ReminderKind,
    dueAt: asText(row['due_at']),
    timezone: asText(row['timezone']),
    status: asText(row['status']) as ReminderStatus,
    attempts: asInt(row['attempts'], 0),
    lastAttemptAt: asTextOrNull(row['last_attempt_at']),
    lastError: asTextOrNull(row['last_error']),
    completedAt: asTextOrNull(row['completed_at']),
    idempotencyKey: asText(row['idempotency_key']),
    createdAt: asText(row['created_at']),
    updatedAt: asText(row['updated_at']),
  };
}

export function getReminder(db: Database, id: string): Reminder | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM reminders WHERE id = ?`).get(id);
  return row ? mapReminder(row as Record<string, unknown>) : null;
}

export function getReminderByKey(db: Database, idempotencyKey: string): Reminder | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM reminders WHERE idempotency_key = ?`)
    .get(idempotencyKey);
  return row ? mapReminder(row as Record<string, unknown>) : null;
}

export function listRemindersByProperty(db: Database, propertyId: string): Reminder[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM reminders WHERE property_id = ? ORDER BY due_at ASC`)
    .all(propertyId);
  return rows.map((row) => mapReminder(row as Record<string, unknown>));
}

export function listRemindersByWorkspace(db: Database, workspaceId: string): Reminder[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.property_id, r.listing_page_id, r.kind, r.due_at, r.timezone, r.status,
              r.attempts, r.last_attempt_at, r.last_error, r.completed_at, r.idempotency_key,
              r.created_at, r.updated_at
       FROM reminders r
       JOIN properties p ON p.id = r.property_id
       WHERE p.workspace_id = ?
       ORDER BY r.due_at ASC`,
    )
    .all(workspaceId);
  return rows.map((row) => mapReminder(row as Record<string, unknown>));
}

/**
 * 幂等创建/重置提醒。
 * 已存在则更新计划时间与发布页关联，并重置为待发送状态（不新增记录）。
 */
export function upsertReminder(
  db: Database,
  input: {
    propertyId: string;
    listingPageId: string | null;
    kind: ReminderKind;
    dueAt: string;
    timezone: string;
    idempotencyKey: string;
  },
): Reminder {
  const now = nowIso();
  const existing = getReminderByKey(db, input.idempotencyKey);

  if (existing) {
    db.prepare(
      `UPDATE reminders
       SET due_at = ?, timezone = ?, listing_page_id = ?, status = 'pending',
           attempts = 0, last_attempt_at = NULL, last_error = NULL, completed_at = NULL,
           updated_at = ?
       WHERE id = ?`,
    ).run(input.dueAt, input.timezone, input.listingPageId, now, existing.id);

    const refreshed = getReminder(db, existing.id);
    if (!refreshed) throw new Error('提醒更新后读取失败');
    return refreshed;
  }

  const id = newId('reminder');
  db.prepare(
    `INSERT INTO reminders (id, property_id, listing_page_id, kind, due_at, timezone, status,
                            attempts, last_attempt_at, last_error, completed_at,
                            idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.propertyId,
    input.listingPageId,
    input.kind,
    input.dueAt,
    input.timezone,
    input.idempotencyKey,
    now,
    now,
  );

  const created = getReminder(db, id);
  if (!created) throw new Error('提醒创建后读取失败');
  return created;
}

const REMINDER_COLUMNS: Record<string, string> = {
  dueAt: 'due_at',
  timezone: 'timezone',
  status: 'status',
  attempts: 'attempts',
  lastAttemptAt: 'last_attempt_at',
  lastError: 'last_error',
  completedAt: 'completed_at',
};

export function updateReminder(
  db: Database,
  id: string,
  patch: Record<string, unknown>,
): Reminder | null {
  const { sql, values } = buildUpdate('reminders', REMINDER_COLUMNS, patch, 'id = ?');
  if (sql !== '') db.prepare(sql).run(...values, id);
  db.prepare('UPDATE reminders SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  return getReminder(db, id);
}

/** 标记为已完成（用户确认） */
export function markCompleted(db: Database, id: string): Reminder | null {
  return updateReminder(db, id, { status: 'completed', completedAt: nowIso(), lastError: null });
}

/** 用户主动关闭提醒 */
export function markSkipped(db: Database, id: string): Reminder | null {
  return updateReminder(db, id, { status: 'skipped', completedAt: nowIso() });
}

/** 重新启用提醒（恢复为待发送） */
export function reopenReminder(db: Database, id: string): Reminder | null {
  return updateReminder(db, id, {
    status: 'pending',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    completedAt: null,
  });
}

/** 记录一次投递尝试 */
export function recordAttempt(
  db: Database,
  id: string,
  outcome: { success: boolean; error?: string; finalFailure?: boolean },
): Reminder | null {
  const current = getReminder(db, id);
  if (!current) return null;

  const attempts = current.attempts + 1;
  return updateReminder(db, id, {
    attempts,
    lastAttemptAt: nowIso(),
    lastError: outcome.success ? null : (outcome.error ?? '未知错误'),
    status: outcome.success ? 'completed' : outcome.finalFailure ? 'failed' : 'pending',
    completedAt: outcome.success ? nowIso() : null,
  });
}

/** 找出所有到期的待发送提醒 */
export function listDueReminders(db: Database, now: Date, limit = 100): Reminder[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM reminders
       WHERE status = 'pending' AND due_at <= ?
       ORDER BY due_at ASC
       LIMIT ?`,
    )
    .all(now.toISOString(), limit);
  return rows.map((row) => mapReminder(row as Record<string, unknown>));
}

export function deleteReminder(db: Database, id: string): boolean {
  return Number(db.prepare('DELETE FROM reminders WHERE id = ?').run(id).changes) > 0;
}

export function countByStatus(db: Database, workspaceId: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT r.status, COUNT(*) AS total FROM reminders r
       JOIN properties p ON p.id = r.property_id
       WHERE p.workspace_id = ? GROUP BY r.status`,
    )
    .all(workspaceId);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    counts[asText(record['status'])] = asInt(record['total'], 0);
  }
  return counts;
}
