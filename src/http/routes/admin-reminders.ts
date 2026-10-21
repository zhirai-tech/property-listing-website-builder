/**
 * 提醒接口（方案第 7 阶段）。
 * 提供手工触发投递的入口，便于验收时直接观察投递结果。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { REMINDER_LABELS, describeReminder } from '../../domain/reminder.ts';
import {
  completeReminder,
  dispatchDueReminders,
  listRemindersAdmin,
  reopenReminderById,
  rescheduleReminder,
  resolveRecipient,
  skipReminder,
} from '../../services/reminder-service.ts';
import { recordAudit } from '../../services/audit-service.ts';

export function registerAdminReminderRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/admin/reminders', async () => {
    const rows = listRemindersAdmin(ctx);
    const recipient = resolveRecipient(ctx);

    // 下一条待处理提醒：前端据此把业务时间精确跳到计划时刻，
    // 避免「整天推进」落到发送时段之外而误以为规则失效。
    const pending = rows
      .filter((row) => row.reminder.status === 'pending')
      .sort((a, b) => a.reminder.dueAt.localeCompare(b.reminder.dueAt));

    const nextPending = pending[0]
      ? {
          id: pending[0].reminder.id,
          kind: pending[0].reminder.kind,
          label: REMINDER_LABELS[pending[0].reminder.kind],
          dueAt: pending[0].reminder.dueAt,
          timezone: pending[0].reminder.timezone,
          propertyTitle: pending[0].propertyTitle,
          /** 计划时刻之后 1 小时，确保处于当地允许发送时段 */
          dispatchAt: new Date(new Date(pending[0].reminder.dueAt).getTime() + 3600000).toISOString(),
        }
      : null;

    return {
      items: rows.map((row) => ({
        ...row,
        label: REMINDER_LABELS[row.reminder.kind],
        description: describeReminder(row.reminder, ctx.workspace.defaultLocale),
      })),
      nextPending,
      config: {
        day1: ctx.config.reminders.day1,
        day2: ctx.config.reminders.day2,
        maxAttempts: ctx.config.reminders.maxAttempts,
        timezone: ctx.workspace.defaultTimezone,
        recipient: recipient.email,
        recipientSource: recipient.source,
        editableNote:
          '提醒天数与最大重试次数通过环境变量配置（REMINDER_DAY_1 / REMINDER_DAY_2 / REMINDER_MAX_ATTEMPTS）；时区可在「设置」中修改。',
      },
      now: ctx.adapters.clock.now().toISOString(),
      timeTravel: ctx.travelClock ? { enabled: true } : { enabled: false },
    };
  });

  app.post<{ Params: { id: string } }>('/api/admin/reminders/:id/complete', async (request) =>
    completeReminder(ctx, request.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/admin/reminders/:id/skip', async (request) =>
    skipReminder(ctx, request.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/admin/reminders/:id/reopen', async (request) =>
    reopenReminderById(ctx, request.params.id),
  );

  app.patch<{ Params: { id: string } }>('/api/admin/reminders/:id', async (request) => {
    const body = (request.body ?? {}) as { dueAt?: unknown };
    const dueAt = typeof body.dueAt === 'string' ? body.dueAt : '';
    return rescheduleReminder(ctx, request.params.id, dueAt);
  });

  /** 手工触发一次投递扫描（验收时用来观察第 7/15 天提醒是否按规则发出） */
  app.post('/api/admin/reminders/dispatch', async () => {
    const report = await dispatchDueReminders(ctx);

    recordAudit(ctx, {
      action: 'reminder.dispatch_manual',
      entityType: 'reminder',
      entityId: 'batch',
      detail: {
        considered: report.considered,
        sent: report.sent,
        failed: report.failed,
        gaveUp: report.gaveUp,
        skipped: report.skipped,
      },
    });

    return report;
  });
}