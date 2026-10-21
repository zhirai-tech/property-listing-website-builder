/**
 * 提醒服务（方案第三章第 9 条、第 7 阶段验收）。
 *
 * 验收要点：
 *  - 用可控测试时间验证规则，不需要真实等待 7/15 天（全部时间取自 Clock）；
 *  - 提醒可重试且不会重复轰炸用户（幂等键 + 退避 + 发送时段 + 撤下即跳过）；
 *  - 记录计划时间、执行状态与失败原因（写回 reminders 表并落审计日志）。
 */

import type { AppContext } from '../app-context.ts';
import { notFound } from '../domain/errors.ts';
import type { Reminder } from '../domain/types.ts';
import {
  DEFAULT_REMINDER_CONFIG,
  REMINDER_LABELS,
  buildReminderPlan,
  decideDispatch,
  reminderIdempotencyKey,
  type ReminderRuleConfig,
} from '../domain/reminder.ts';
import {
  getReminder,
  listDueReminders,
  listRemindersByProperty,
  listRemindersByWorkspace,
  markCompleted,
  markSkipped,
  recordAttempt,
  reopenReminder,
  updateReminder,
  upsertReminder,
} from '../db/repositories/reminder-repo.ts';
import { getProperty } from '../db/repositories/property-repo.ts';
import { getListingPageById, getListingPageByProperty } from '../db/repositories/listing-page-repo.ts';
import { listUsers } from '../db/repositories/workspace-repo.ts';
import { recordAudit } from './audit-service.ts';

/** 从配置与工作区得到提醒规则（时区、天数、重试上限都可配置） */
export function reminderConfig(ctx: AppContext): ReminderRuleConfig {
  return {
    ...DEFAULT_REMINDER_CONFIG,
    day1: ctx.config.reminders.day1,
    day2: ctx.config.reminders.day2,
    maxAttempts: ctx.config.reminders.maxAttempts,
    timezone: ctx.workspace.defaultTimezone,
  };
}

/**
 * 发布后生成提醒计划。
 * 使用幂等键 upsert：重新发布会重置既有提醒，而不是新增一条，
 * 因此用户不会因为反复上下架而被重复通知。
 */
export function scheduleRemindersForPage(
  ctx: AppContext,
  page: { id: string; propertyId: string; publishedAt: string | null; status: string; slug: string },
): Reminder[] {
  if (page.status !== 'published' || !page.publishedAt) return [];

  const config = reminderConfig(ctx);
  const publishedAt = new Date(page.publishedAt);
  const plan = buildReminderPlan(publishedAt, config);

  const created = plan.map((entry) =>
    upsertReminder(ctx.db, {
      propertyId: page.propertyId,
      listingPageId: page.id,
      kind: entry.kind,
      dueAt: entry.dueAt.toISOString(),
      timezone: config.timezone,
      idempotencyKey: reminderIdempotencyKey(page.propertyId, entry.kind),
    }),
  );

  recordAudit(ctx, {
    action: 'reminder.schedule',
    entityType: 'listing_page',
    entityId: page.id,
    detail: {
      timezone: config.timezone,
      day1: config.day1,
      day2: config.day2,
      dueAt: plan.map((p) => `${p.kind}@${p.dueAt.toISOString()}`),
    },
  });

  return created;
}

export interface DispatchDetail {
  reminderId: string;
  kind: string;
  propertyTitle: string;
  outcome: 'sent' | 'failed' | 'gave_up' | 'skipped' | 'retry_later';
  message: string;
}

export interface DispatchReport {
  at: string;
  considered: number;
  sent: number;
  failed: number;
  gaveUp: number;
  skipped: number;
  retryLater: number;
  details: DispatchDetail[];
  /** 未配置收件人时的整体提示 */
  recipientWarning: string;
}

/** 解析提醒收件人：显式配置优先，其次工作区所有者邮箱 */
export function resolveRecipient(ctx: AppContext): { email: string; source: string } {
  const configured = ctx.config.reminders.recipient.trim();
  if (configured !== '') return { email: configured, source: 'REMINDER_RECIPIENT' };

  const owner = listUsers(ctx.db, ctx.workspace.id).find((user) => user.role === 'owner');
  if (owner && owner.email.trim() !== '') {
    return { email: owner.email.trim(), source: 'OWNER_EMAIL' };
  }
  return { email: '', source: 'none' };
}

function buildMessage(
  ctx: AppContext,
  reminder: Reminder,
  propertyTitle: string,
  publicUrl: string,
): { subject: string; text: string } {
  const label = REMINDER_LABELS[reminder.kind];
  const publishedNote = reminder.kind === 'check_day_7' ? '已发布 7 天' : '已发布 15 天';

  return {
    subject: `【房源提醒】${propertyTitle} ${publishedNote}：${label}`,
    text: [
      `你发布的房源「${propertyTitle}」${publishedNote}。`,
      '',
      `本次提醒：${label}`,
      `展示页地址：${publicUrl}`,
      '',
      '建议操作：',
      reminder.kind === 'check_day_7'
        ? ' 1. 打开展示页确认信息是否仍然准确；\n 2. 检查照片是否需要更新；\n 3. 若已成交或已出租，请在后台撤下页面。'
        : ' 1. 确认价格、可入住日期等关键信息；\n 2. 若房源已失效，请在后台撤下或归档；\n 3. 若仍然有效，可在后台将该提醒标记为完成。',
      '',
      '你可以在后台「发布提醒」页面关闭提醒或标记完成，也可以调整提醒时区与天数。',
      `（本邮件由轻量化房源管理平台自动发送，规则：发布后第 ${ctx.config.reminders.day1} 天与第 ${ctx.config.reminders.day2} 天各一次）`,
    ].join('\n'),
  };
}

/**
 * 扫描并投递所有到期提醒。
 * 传入 Clock 决定「现在」，因此测试可以把时间直接推到第 7/15 天。
 */
export async function dispatchDueReminders(
  ctx: AppContext,
  options: { limit?: number } = {},
): Promise<DispatchReport> {
  const now = ctx.adapters.clock.now();
  const config = reminderConfig(ctx);
  const due = listDueReminders(ctx.db, now, options.limit ?? 100);

  const report: DispatchReport = {
    at: now.toISOString(),
    considered: due.length,
    sent: 0,
    failed: 0,
    gaveUp: 0,
    skipped: 0,
    retryLater: 0,
    details: [],
    recipientWarning: '',
  };

  const recipient = resolveRecipient(ctx);
  if (recipient.email === '') {
    report.recipientWarning =
      '未配置提醒收件邮箱（REMINDER_RECIPIENT 或 OWNER_EMAIL 均为空），提醒不会真正投递';
  }

  for (const reminder of due) {
    const property = getProperty(ctx.db, reminder.propertyId);
    const propertyTitle = property?.title ?? '(房源已删除)';

    const action = decideDispatch(reminder, now, config);

    if (action === 'skip') {
      report.skipped += 1;
      report.details.push({
        reminderId: reminder.id,
        kind: reminder.kind,
        propertyTitle,
        outcome: 'skipped',
        message: '不在投递时机',
      });
      continue;
    }

    if (action === 'retry-later') {
      report.retryLater += 1;
      report.details.push({
        reminderId: reminder.id,
        kind: reminder.kind,
        propertyTitle,
        outcome: 'retry_later',
        message: '未到重试时间或不在允许发送的当地时段',
      });
      continue;
    }

    if (action === 'give-up') {
      recordAttempt(ctx.db, reminder.id, {
        success: false,
        error: `已尝试 ${reminder.attempts} 次仍未成功，停止自动重试`,
        finalFailure: true,
      });
      report.gaveUp += 1;
      report.details.push({
        reminderId: reminder.id,
        kind: reminder.kind,
        propertyTitle,
        outcome: 'gave_up',
        message: '达到最大重试次数，已标记为发送失败',
      });
      recordAudit(ctx, {
        action: 'reminder.give_up',
        entityType: 'reminder',
        entityId: reminder.id,
        detail: { attempts: reminder.attempts, lastError: reminder.lastError },
      });
      continue;
    }

    // action === 'send'
    if (!property) {
      markSkipped(ctx.db, reminder.id);
      report.skipped += 1;
      report.details.push({
        reminderId: reminder.id,
        kind: reminder.kind,
        propertyTitle,
        outcome: 'skipped',
        message: '房源已删除，提醒自动关闭',
      });
      continue;
    }

    const page =
      (reminder.listingPageId ? getListingPageById(ctx.db, reminder.listingPageId) : null) ??
      getListingPageByProperty(ctx.db, reminder.propertyId);

    // 页面已撤下或未发布时不再打扰用户
    if (!page || page.status !== 'published') {
      markSkipped(ctx.db, reminder.id);
      report.skipped += 1;
      report.details.push({
        reminderId: reminder.id,
        kind: reminder.kind,
        propertyTitle,
        outcome: 'skipped',
        message: '展示页已撤下或未发布，提醒自动关闭',
      });
      continue;
    }

    const resolved = ctx.adapters.hosting.resolvePublicUrl(page.slug, {
      customDomain: page.customDomain,
      domainVerifyToken: page.domainVerifyToken,
      domainVerifiedAt: page.domainVerifiedAt,
    });

    if (recipient.email === '') {
      recordAttempt(ctx.db, reminder.id, {
        success: false,
        error: '未配置提醒收件邮箱',
        finalFailure: true,
      });
      report.failed += 1;
      report.details.push({
        reminderId: reminder.id,
        kind: reminder.kind,
        propertyTitle,
        outcome: 'failed',
        message: '未配置提醒收件邮箱，无法投递',
      });
      continue;
    }

    const message = buildMessage(ctx, reminder, property.title, resolved.url);

    try {
      const result = await ctx.adapters.mail.send({ to: recipient.email, ...message });
      recordAttempt(ctx.db, reminder.id, { success: true });
      report.sent += 1;
      report.details.push({
        reminderId: reminder.id,
        kind: reminder.kind,
        propertyTitle,
        outcome: 'sent',
        message: result.detail,
      });

      recordAudit(ctx, {
        action: 'reminder.sent',
        entityType: 'reminder',
        entityId: reminder.id,
        detail: { to: recipient.email, source: recipient.source, provider: result.provider },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const willExhaust = reminder.attempts + 1 >= config.maxAttempts;

      recordAttempt(ctx.db, reminder.id, {
        success: false,
        error: reason,
        finalFailure: willExhaust,
      });

      if (willExhaust) report.gaveUp += 1;
      else report.failed += 1;

      report.details.push({
        reminderId: reminder.id,
        kind: reminder.kind,
        propertyTitle,
        outcome: willExhaust ? 'gave_up' : 'failed',
        message: reason,
      });

      recordAudit(ctx, {
        action: 'reminder.failed',
        entityType: 'reminder',
        entityId: reminder.id,
        detail: { attempt: reminder.attempts + 1, reason, willExhaust },
      });
    }
  }

  return report;
}

export function completeReminder(ctx: AppContext, id: string): Reminder {
  requireReminder(ctx, id);
  const updated = markCompleted(ctx.db, id);
  if (!updated) throw notFound('提醒', id);

  recordAudit(ctx, {
    action: 'reminder.complete',
    entityType: 'reminder',
    entityId: id,
    detail: {},
  });
  return updated;
}

export function skipReminder(ctx: AppContext, id: string): Reminder {
  requireReminder(ctx, id);
  const updated = markSkipped(ctx.db, id);
  if (!updated) throw notFound('提醒', id);

  recordAudit(ctx, { action: 'reminder.skip', entityType: 'reminder', entityId: id, detail: {} });
  return updated;
}

export function reopenReminderById(ctx: AppContext, id: string): Reminder {
  requireReminder(ctx, id);
  const updated = reopenReminder(ctx.db, id);
  if (!updated) throw notFound('提醒', id);

  recordAudit(ctx, { action: 'reminder.reopen', entityType: 'reminder', entityId: id, detail: {} });
  return updated;
}

/** 修改提醒计划时间（后台可手工调整） */
export function rescheduleReminder(ctx: AppContext, id: string, dueAtIso: string): Reminder {
  requireReminder(ctx, id);
  const parsed = new Date(dueAtIso);
  if (Number.isNaN(parsed.getTime())) throw notFound('提醒时间', dueAtIso);

  const updated = updateReminder(ctx.db, id, { dueAt: parsed.toISOString() });
  if (!updated) throw notFound('提醒', id);

  recordAudit(ctx, {
    action: 'reminder.reschedule',
    entityType: 'reminder',
    entityId: id,
    detail: { dueAt: parsed.toISOString() },
  });
  return updated;
}

function requireReminder(ctx: AppContext, id: string): Reminder {
  const reminder = getReminder(ctx.db, id);
  if (!reminder) throw notFound('提醒', id);

  const property = getProperty(ctx.db, reminder.propertyId);
  if (!property || property.workspaceId !== ctx.workspace.id) {
    throw notFound('提醒', id);
  }
  return reminder;
}

export function listRemindersForProperty(ctx: AppContext, propertyId: string): Reminder[] {
  return listRemindersByProperty(ctx.db, propertyId);
}

export function listRemindersAdmin(ctx: AppContext): { reminder: Reminder; propertyTitle: string }[] {
  return listRemindersByWorkspace(ctx.db, ctx.workspace.id).map((reminder) => ({
    reminder,
    propertyTitle: getProperty(ctx.db, reminder.propertyId)?.title ?? '(已删除)',
  }));
}