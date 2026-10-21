/**
 * 审计服务：统一记录关键操作。
 *
 * 方案第八章第 6 条要求记录「计划时间、执行状态和失败原因」；
 * 这里对所有写操作提供统一入口，避免遗漏。
 */

import type { AppContext } from '../app-context.ts';
import { appendAudit, listEntityAudit, listRecentAudit } from '../db/repositories/audit-repo.ts';
import type { AuditLogEntry } from '../domain/types.ts';

export function recordAudit(
  ctx: AppContext,
  entry: {
    actor?: string;
    action: string;
    entityType: string;
    entityId: string;
    detail?: string | Record<string, unknown>;
  },
): AuditLogEntry {
  const detail =
    typeof entry.detail === 'string'
      ? entry.detail
      : entry.detail
        ? JSON.stringify(entry.detail)
        : '';

  return appendAudit(ctx.db, {
    actor: entry.actor ?? 'admin',
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    detail,
  });
}

export function recentAudit(ctx: AppContext, limit = 100): AuditLogEntry[] {
  return listRecentAudit(ctx.db, limit);
}

export function entityAudit(ctx: AppContext, entityType: string, entityId: string): AuditLogEntry[] {
  return listEntityAudit(ctx.db, entityType, entityId);
}
