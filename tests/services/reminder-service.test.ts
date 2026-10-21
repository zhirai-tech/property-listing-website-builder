/**
 * 提醒服务单元测试（方案第 7 阶段验收）。
 * 全程使用可控时钟，不真实等待 7/15 天。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, propertyInput } from '../helpers/test-app.ts';
import { createPropertyFromInput } from '../../src/services/property-service.ts';
import { publishListing, withdrawListing } from '../../src/services/publish-service.ts';
import {
  completeReminder,
  dispatchDueReminders,
  listRemindersAdmin,
  reminderConfig,
  reopenReminderById,
  resolveRecipient,
  skipReminder,
} from '../../src/services/reminder-service.ts';
import { isDomainError } from '../../src/domain/errors.ts';

function setup() {
  const h = createHarness({ start: '2026-01-15T02:00:00.000Z' }); // 上海当地 10:00
  const { property } = createPropertyFromInput(h.ctx, propertyInput());
  publishListing(h.ctx, property.id);
  return { h, propertyId: property.id };
}

test('发布后按配置生成两条提醒，时刻为发布后第 7/15 天当地 9 点', () => {
  const { h, propertyId } = setup();
  try {
    const rows = listRemindersAdmin(h.ctx);
    assert.equal(rows.length, 2);

    const byKind = new Map(rows.map((r) => [r.reminder.kind, r.reminder]));
    const day7 = byKind.get('check_day_7');
    const day15 = byKind.get('confirm_day_15');

    assert.ok(day7 && day15);
    assert.equal(day7.timezone, 'Asia/Shanghai');
    assert.equal(day7.dueAt, '2026-01-22T01:00:00.000Z');
    assert.equal(day15.dueAt, '2026-01-30T01:00:00.000Z');

    // 与房源关联，便于追溯
    assert.equal(day7.propertyId, propertyId);
  } finally {
    h.dispose();
  }
});

test('发布当天不发送任何提醒', async () => {
  const { h } = setup();
  try {
    const report = await dispatchDueReminders(h.ctx);
    assert.equal(report.considered, 0);
    assert.equal(report.sent, 0);
    assert.equal(h.mail.sent.length, 0);
  } finally {
    h.dispose();
  }
});

test('第 7 天发送第一次提醒，且只发一次', async () => {
  const { h } = setup();
  try {
    h.clock.set('2026-01-22T02:00:00.000Z'); // 到期后 1 小时，当地 10:00

    const first = await dispatchDueReminders(h.ctx);
    assert.equal(first.sent, 1);
    assert.equal(first.details[0]?.kind, 'check_day_7');
    assert.equal(h.mail.sent.length, 1);
    assert.match(h.mail.sent[0]?.subject ?? '', /房源提醒/);
    assert.ok(h.mail.sent[0]?.text.includes('/p/'), '邮件正文应包含分享链接');

    // 重复扫描不得重复发送
    const second = await dispatchDueReminders(h.ctx);
    assert.equal(second.sent, 0);
    assert.equal(h.mail.sent.length, 1);
  } finally {
    h.dispose();
  }
});

test('第 15 天发送第二次提醒', async () => {
  const { h } = setup();
  try {
    h.clock.set('2026-01-22T02:00:00.000Z');
    await dispatchDueReminders(h.ctx);

    h.clock.set('2026-01-30T02:00:00.000Z');
    const report = await dispatchDueReminders(h.ctx);

    assert.equal(report.sent, 1);
    assert.equal(report.details[0]?.kind, 'confirm_day_15');
    assert.equal(h.mail.sent.length, 2);
  } finally {
    h.dispose();
  }
});

test('深夜到点会推迟到允许时段，不会打扰用户', async () => {
  const { h } = setup();
  try {
    h.clock.set('2026-01-22T17:00:00.000Z'); // 上海当地次日 01:00

    const report = await dispatchDueReminders(h.ctx);
    assert.equal(report.sent, 0);
    assert.equal(report.retryLater, 1);
    assert.equal(h.mail.sent.length, 0);

    // 天亮后即可正常发送
    h.clock.set('2026-01-23T02:00:00.000Z');
    const later = await dispatchDueReminders(h.ctx);
    assert.equal(later.sent, 1);
  } finally {
    h.dispose();
  }
});

test('展示页撤下后未发送的提醒自动关闭，不再打扰', async () => {
  const { h, propertyId } = setup();
  try {
    withdrawListing(h.ctx, propertyId);
    h.clock.set('2026-01-22T02:00:00.000Z');

    const report = await dispatchDueReminders(h.ctx);
    assert.equal(report.sent, 0);
    assert.equal(report.skipped, 1);
    assert.equal(h.mail.sent.length, 0);

    const rows = listRemindersAdmin(h.ctx);
    assert.equal(rows.find((r) => r.reminder.kind === 'check_day_7')?.reminder.status, 'skipped');
  } finally {
    h.dispose();
  }
});

test('用户可以标记完成或关闭提醒', () => {
  const { h } = setup();
  try {
    const rows = listRemindersAdmin(h.ctx);
    const day7 = rows.find((r) => r.reminder.kind === 'check_day_7')?.reminder;
    const day15 = rows.find((r) => r.reminder.kind === 'confirm_day_15')?.reminder;
    assert.ok(day7 && day15);

    assert.equal(completeReminder(h.ctx, day7.id).status, 'completed');
    assert.equal(skipReminder(h.ctx, day15.id).status, 'skipped');

    // 已完成的提醒即使到点也不发送
    h.clock.set('2026-01-22T02:00:00.000Z');
    return dispatchDueReminders(h.ctx).then((report) => {
      assert.equal(report.sent, 0);
    });
  } finally {
    h.dispose();
  }
});

test('可以重新启用已关闭的提醒', () => {
  const { h } = setup();
  try {
    const day7 = listRemindersAdmin(h.ctx).find((r) => r.reminder.kind === 'check_day_7')?.reminder;
    assert.ok(day7);

    skipReminder(h.ctx, day7.id);
    const reopened = reopenReminderById(h.ctx, day7.id);

    assert.equal(reopened.status, 'pending');
    assert.equal(reopened.attempts, 0);
    assert.equal(reopened.completedAt, null);
  } finally {
    h.dispose();
  }
});

test('投递失败会重试，达到上限后标记为失败', async () => {
  const { h } = setup();
  try {
    // 让邮件适配器始终失败
    h.mail.send = async () => {
      throw new Error('模拟邮件服务不可用');
    };

    h.clock.set('2026-01-22T02:00:00.000Z');
    const first = await dispatchDueReminders(h.ctx);
    assert.equal(first.failed, 1);

    const config = reminderConfig(h.ctx);

    // 逐次重试直到放弃
    for (let i = 1; i < config.maxAttempts; i += 1) {
      h.clock.advanceMs(6 * 60 * 60 * 1000);
      h.clock.set('2026-01-22T02:00:00.000Z');
      h.clock.advanceMs(i * 6 * 60 * 60 * 1000);
      await dispatchDueReminders(h.ctx);
    }

    const reminder = listRemindersAdmin(h.ctx).find((r) => r.reminder.kind === 'check_day_7')?.reminder;
    assert.ok(reminder);
    assert.ok(['pending', 'failed'].includes(reminder.status), `状态应为 pending/failed，实际 ${reminder.status}`);
    assert.ok(reminder.attempts >= 1);
    assert.match(reminder.lastError ?? '', /邮件服务不可用/);
  } finally {
    h.dispose();
  }
});

test('未配置收件人时给出明确提示且不会静默成功', async () => {
  const h = createHarness({ start: '2026-01-15T02:00:00.000Z' });
  try {
    h.ctx.config.reminders.recipient = '';
    // 所有者邮箱也清空
    h.ctx.db.prepare("UPDATE users SET email = '' WHERE role = 'owner'").run();

    const recipient = resolveRecipient(h.ctx);
    assert.equal(recipient.email, '');
    assert.equal(recipient.source, 'none');

    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    publishListing(h.ctx, property.id);
    h.clock.set('2026-01-22T02:00:00.000Z');

    const report = await dispatchDueReminders(h.ctx);
    assert.equal(report.sent, 0);
    assert.match(report.recipientWarning, /未配置提醒收件邮箱/);
  } finally {
    h.dispose();
  }
});

test('操作不存在或跨工作区的提醒会被拒绝', () => {
  const { h } = setup();
  try {
    assert.throws(() => completeReminder(h.ctx, 'rmd_missing'), (error: unknown) => isDomainError(error));

    const day7 = listRemindersAdmin(h.ctx).find((r) => r.reminder.kind === 'check_day_7')?.reminder;
    assert.ok(day7);

    const other = { ...h.ctx, workspace: { ...h.ctx.workspace, id: 'wsp_other' } };
    assert.throws(() => completeReminder(other, day7.id), (error: unknown) => isDomainError(error));
  } finally {
    h.dispose();
  }
});

test('提醒配置来自环境变量（天数与重试上限可配置）', () => {
  const h = createHarness();
  try {
    h.ctx.config.reminders.day1 = 3;
    h.ctx.config.reminders.day2 = 9;
    h.ctx.config.reminders.maxAttempts = 5;

    const config = reminderConfig(h.ctx);
    assert.equal(config.day1, 3);
    assert.equal(config.day2, 9);
    assert.equal(config.maxAttempts, 5);
    assert.equal(config.timezone, h.ctx.workspace.defaultTimezone);
  } finally {
    h.dispose();
  }
});