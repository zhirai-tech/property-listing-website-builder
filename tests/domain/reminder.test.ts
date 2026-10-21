/**
 * 提醒规则单元测试（方案第 7 阶段验收：用可控时间验证，不需真实等待）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REMINDER_CONFIG,
  buildReminderPlan,
  canRetry,
  decideDispatch,
  isReminderDue,
  reminderIdempotencyKey,
  retryDelayMs,
  withinSendWindow,
  type ReminderRuleConfig,
} from '../../src/domain/reminder.ts';
import { toZonedParts } from '../../src/util/time.ts';

function config(overrides: Partial<ReminderRuleConfig> = {}): ReminderRuleConfig {
  return { ...DEFAULT_REMINDER_CONFIG, timezone: 'Asia/Shanghai', ...overrides };
}

test('发布计划生成第 7 天与第 15 天两条提醒', () => {
  const published = new Date('2026-01-15T02:00:00.000Z'); // 当地 10:00
  const plan = buildReminderPlan(published, config());

  assert.equal(plan.length, 2);
  assert.equal(plan[0]?.kind, 'check_day_7');
  assert.equal(plan[1]?.kind, 'confirm_day_15');
});

test('提醒时刻落在目标时区的当地上午 9 点', () => {
  const published = new Date('2026-01-15T02:00:00.000Z');
  const plan = buildReminderPlan(published, config());

  for (const entry of plan) {
    const local = toZonedParts(entry.dueAt, 'Asia/Shanghai');
    assert.equal(local.hour, 9, `${entry.kind} 应在当地 9 点，实际 ${local.hour}`);
    assert.equal(local.minute, 0);
  }
});

test('提醒日期确实相隔 7 天与 15 天（按当地日历）', () => {
  const published = new Date('2026-01-15T02:00:00.000Z');
  const plan = buildReminderPlan(published, config());

  const day7 = toZonedParts(plan[0]!.dueAt, 'Asia/Shanghai');
  const day15 = toZonedParts(plan[1]!.dueAt, 'Asia/Shanghai');

  assert.deepEqual([day7.year, day7.month, day7.day], [2026, 1, 22]);
  assert.deepEqual([day15.year, day15.month, day15.day], [2026, 1, 30]);
});

test('时区配置会影响提醒时刻', () => {
  const published = new Date('2026-01-15T02:00:00.000Z');
  const shanghai = buildReminderPlan(published, config({ timezone: 'Asia/Shanghai' }));
  const utc = buildReminderPlan(published, config({ timezone: 'UTC' }));

  assert.notEqual(shanghai[0]!.dueAt.toISOString(), utc[0]!.dueAt.toISOString());
  assert.equal(toZonedParts(utc[0]!.dueAt, 'UTC').hour, 9);
});

test('提醒天数可配置', () => {
  const published = new Date('2026-01-15T02:00:00.000Z');
  const plan = buildReminderPlan(published, config({ day1: 3, day2: 10 }));

  const day3 = toZonedParts(plan[0]!.dueAt, 'Asia/Shanghai');
  assert.deepEqual([day3.month, day3.day], [1, 18]);
});

test('未到时间不发送', () => {
  const due = new Date('2026-01-22T01:00:00.000Z');
  const now = new Date('2026-01-21T23:00:00.000Z');

  assert.equal(isReminderDue({ status: 'pending', dueAt: due.toISOString() }, now), false);
  assert.equal(
    decideDispatch({ status: 'pending', dueAt: due.toISOString(), attempts: 0, lastAttemptAt: null }, now, config()),
    'skip',
  );
});

test('到点且在允许时段内会发送', () => {
  const due = new Date('2026-01-22T01:00:00.000Z'); // 当地 09:00
  const now = new Date('2026-01-22T02:00:00.000Z'); // 当地 10:00

  assert.equal(isReminderDue({ status: 'pending', dueAt: due.toISOString() }, now), true);
  assert.equal(
    decideDispatch({ status: 'pending', dueAt: due.toISOString(), attempts: 0, lastAttemptAt: null }, now, config()),
    'send',
  );
});

test('到点但处于深夜时段会推迟，避免打扰用户', () => {
  const due = new Date('2026-01-22T01:00:00.000Z');
  const now = new Date('2026-01-22T17:00:00.000Z'); // 当地次日 01:00

  assert.equal(
    decideDispatch({ status: 'pending', dueAt: due.toISOString(), attempts: 0, lastAttemptAt: null }, now, config()),
    'retry-later',
  );
  assert.equal(withinSendWindow(now, config()), false);
});

test('已完成或已关闭的提醒不再发送', () => {
  const due = new Date('2026-01-22T01:00:00.000Z');
  const now = new Date('2026-01-22T02:00:00.000Z');

  for (const status of ['completed', 'skipped'] as const) {
    assert.equal(
      decideDispatch({ status, dueAt: due.toISOString(), attempts: 0, lastAttemptAt: null }, now, config()),
      'skip',
    );
  }
});

test('达到最大尝试次数后放弃重试', () => {
  const due = new Date('2026-01-22T01:00:00.000Z');
  const now = new Date('2026-01-22T02:00:00.000Z');

  assert.equal(
    decideDispatch({ status: 'pending', dueAt: due.toISOString(), attempts: 3, lastAttemptAt: null }, now, config({ maxAttempts: 3 })),
    'give-up',
  );
});

test('重试遵循指数退避且封顶 6 小时', () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(retryDelayMs(3), 240_000);
  assert.equal(retryDelayMs(20), 6 * 60 * 60 * 1000);
});

test('刚失败过的提醒在退避期内不会重复发送', () => {
  const due = new Date('2026-01-22T01:00:00.000Z');
  const lastAttempt = new Date('2026-01-22T02:00:00.000Z');
  const now = new Date('2026-01-22T02:00:30.000Z'); // 仅过 30 秒

  assert.equal(
    decideDispatch(
      { status: 'pending', dueAt: due.toISOString(), attempts: 1, lastAttemptAt: lastAttempt.toISOString() },
      now,
      config(),
    ),
    'retry-later',
  );
});

test('幂等键在同一房源同一类型上稳定不变（防止重复通知）', () => {
  const a = reminderIdempotencyKey('prp_1', 'check_day_7');
  const b = reminderIdempotencyKey('prp_1', 'check_day_7');
  const c = reminderIdempotencyKey('prp_1', 'confirm_day_15');

  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('canRetry 在完成/关闭或超出上限时为 false', () => {
  assert.equal(canRetry({ attempts: 0, status: 'pending' }, 3), true);
  assert.equal(canRetry({ attempts: 3, status: 'pending' }, 3), false);
  assert.equal(canRetry({ attempts: 0, status: 'completed' }, 3), false);
  assert.equal(canRetry({ attempts: 0, status: 'skipped' }, 3), false);
});

// ---------------------------------------------------------------------------
// 日历日语义（第 25 阶段补充）
//
// 【为什么这组测试必须存在】
// 产品规则是「发布当地日历日 + N 天，时刻为该时区的当地 09:00」，
// 而不是「经过 N×24 小时」。两者在两种常见情况下**不相等**：
//   1. 发布时刻晚于当地 09:00 → 到「第 N 天 09:00」不足 N×24 小时；
//   2. 期间跨越夏令时切换 → 偏移变化 1 小时，瞬时差随之偏离 N×24 小时。
// 此前 `scripts/smoke.ts` 用毫秒差断言，于是**一天中的大部分时间都失败**。
// 这组测试把规则本身钉死：日期按当地日历、时刻按当地 09:00。
// 所有输入都是固定日期，不依赖运行时的系统时间。
// ---------------------------------------------------------------------------

/** 按指定时区的日历计算两个瞬间相隔几天（仅用于断言，复用产品的 toZonedParts） */
function zonedCalendarDays(from: Date, to: Date, timeZone: string): number {
  const a = toZonedParts(from, timeZone);
  const b = toZonedParts(to, timeZone);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** 断言某条提醒：当地日期正好是发布后第 N 个日历日，且时刻为当地 09:00 */
function assertCalendarDayAtLocalNine(
  publishedAt: Date,
  dueAt: Date,
  days: number,
  timeZone: string,
  label: string,
): void {
  const local = toZonedParts(dueAt, timeZone);
  assert.equal(
    zonedCalendarDays(publishedAt, dueAt, timeZone),
    days,
    `${label}：应为第 ${days} 个日历日，实际当地 ${local.year}-${local.month}-${local.day}`,
  );
  assert.deepEqual(
    [local.hour, local.minute, local.second],
    [9, 0, 0],
    `${label}：当地时刻应为 09:00:00，实际 ${local.hour}:${local.minute}:${local.second}`,
  );
}

test('发布在当地 09:00 之前：第 7 天仍是第 7 个日历日的当地 09:00', () => {
  // 上海当地 2026-01-15 08:30 —— 早于发送窗口起点
  const published = new Date('2026-01-15T00:30:00.000Z');
  const plan = buildReminderPlan(published, config({ timezone: 'Asia/Shanghai' }));

  // 当地日历：01-15 + 7 = 01-22
  assertCalendarDayAtLocalNine(published, plan[0]!.dueAt, 7, 'Asia/Shanghai', '第 7 天');
  assert.equal(plan[0]!.dueAt.toISOString(), '2026-01-22T01:00:00.000Z');

  // 发布早于 09:00 时，瞬时差**大于** 7×24 小时 —— 与「按日历日」并不冲突
  const deltaDays = (plan[0]!.dueAt.getTime() - published.getTime()) / 86_400_000;
  assert.ok(deltaDays > 7, `当地 08:30 发布时瞬时差应大于 7 天，实际 ${deltaDays.toFixed(4)} 天`);
});

test('发布在当地 09:00 之后：第 7 天仍是第 7 个日历日，但瞬时差不足 7 天', () => {
  // 上海当地 2026-01-15 18:00 —— 晚于发送窗口起点
  // 这正是旧断言（要求 ≥ 7×24 小时）会误报失败的情形。
  const published = new Date('2026-01-15T10:00:00.000Z');
  const plan = buildReminderPlan(published, config({ timezone: 'Asia/Shanghai' }));

  assertCalendarDayAtLocalNine(published, plan[0]!.dueAt, 7, 'Asia/Shanghai', '第 7 天');
  assertCalendarDayAtLocalNine(published, plan[1]!.dueAt, 15, 'Asia/Shanghai', '第 15 天');

  // 产品承诺的是日历日，所以这里瞬时差**小于** 7×24 小时是正确的，不是缺陷
  const deltaDays = (plan[0]!.dueAt.getTime() - published.getTime()) / 86_400_000;
  assert.ok(
    deltaDays > 6 && deltaDays < 7,
    `当地 18:00 发布时瞬时差应落在 6~7 天之间，实际 ${deltaDays.toFixed(4)} 天`,
  );
});

test('跨夏令时开始：日历日与当地 09:00 均正确（瞬时差因偏移变化而偏离 7 天）', () => {
  // 美国 2026 年夏令时于 3 月 8 日 02:00 开始（EST -5 → EDT -4）
  // 纽约当地 2026-03-05 09:00 EST，第 7 个日历日是 03-12，此时已是 EDT
  const published = new Date('2026-03-05T14:00:00.000Z');
  assert.deepEqual(
    [toZonedParts(published, 'America/New_York').day, toZonedParts(published, 'America/New_York').hour],
    [5, 9],
    '前置条件：发布时应为纽约当地 03-05 09:00（EST）',
  );

  const plan = buildReminderPlan(published, config({ timezone: 'America/New_York' }));
  assertCalendarDayAtLocalNine(published, plan[0]!.dueAt, 7, 'America/New_York', '第 7 天');

  // 03-12 已进入夏令时，当地 09:00 EDT = 13:00Z（而非 EST 的 14:00Z）
  assert.equal(plan[0]!.dueAt.toISOString(), '2026-03-12T13:00:00.000Z');

  // 偏移变化 1 小时 → 瞬时差**小于** 7×24 小时。这是正确的日历日行为。
  const deltaDays = (plan[0]!.dueAt.getTime() - published.getTime()) / 86_400_000;
  assert.ok(
    Math.abs(deltaDays - 7) > 0.04,
    `跨夏令时开始应使瞬时差偏离 7 天约 1 小时，实际 ${deltaDays.toFixed(4)} 天`,
  );
});

test('跨夏令时结束：日历日与当地 09:00 均正确', () => {
  // 美国 2026 年夏令时于 11 月 1 日 02:00 结束（EDT -4 → EST -5）
  // 纽约当地 2026-10-28 09:00 EDT，第 7 个日历日是 11-04，此时已是 EST
  const published = new Date('2026-10-28T13:00:00.000Z');
  assert.deepEqual(
    [toZonedParts(published, 'America/New_York').day, toZonedParts(published, 'America/New_York').hour],
    [28, 9],
    '前置条件：发布时应为纽约当地 10-28 09:00（EDT）',
  );

  const plan = buildReminderPlan(published, config({ timezone: 'America/New_York' }));
  assertCalendarDayAtLocalNine(published, plan[0]!.dueAt, 7, 'America/New_York', '第 7 天');
  assertCalendarDayAtLocalNine(published, plan[1]!.dueAt, 15, 'America/New_York', '第 15 天');

  // 11-04 已回到标准时间，当地 09:00 EST = 14:00Z
  assert.equal(plan[0]!.dueAt.toISOString(), '2026-11-04T14:00:00.000Z');
});

test('欧洲夏令时开始：日历日与当地 09:00 同样保持正确', () => {
  // 英国 2026 年夏令时于 3 月 29 日 01:00 开始（GMT +0 → BST +1）
  // 伦敦当地 2026-03-26 09:00 GMT，第 7 个日历日是 04-02，此时已是 BST
  const published = new Date('2026-03-26T09:00:00.000Z');
  const plan = buildReminderPlan(published, config({ timezone: 'Europe/London' }));

  assertCalendarDayAtLocalNine(published, plan[0]!.dueAt, 7, 'Europe/London', '第 7 天');
  // 04-02 当地 09:00 BST = 08:00Z
  assert.equal(plan[0]!.dueAt.toISOString(), '2026-04-02T08:00:00.000Z');
});

test('同一瞬间在不同时区各自落在当地的第 7 个日历日 09:00', () => {
  // 一个瞬间，四个时区：每个时区都必须按**自己**的日历与当地 09:00 计算。
  // 注意 UTC 与 Asia/Shanghai 的当地日期可能不同 —— 断言按各自时区成立。
  const published = new Date('2026-06-10T22:00:00.000Z'); // 上海已是 06-11 06:00
  const zones = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London'] as const;

  const results = zones.map((timeZone) => {
    const plan = buildReminderPlan(published, config({ timezone: timeZone }));
    assertCalendarDayAtLocalNine(published, plan[0]!.dueAt, 7, timeZone, `第 7 天 @ ${timeZone}`);
    assertCalendarDayAtLocalNine(published, plan[1]!.dueAt, 15, timeZone, `第 15 天 @ ${timeZone}`);
    return { timeZone, day: toZonedParts(published, timeZone).day, iso: plan[0]!.dueAt.toISOString() };
  });

  // 各时区的当地日期不同（UTC 为 06-10，上海为 06-11），因此结果必然不同
  assert.equal(results.find((r) => r.timeZone === 'UTC')!.day, 10);
  assert.equal(results.find((r) => r.timeZone === 'Asia/Shanghai')!.day, 11);
  assert.notEqual(
    results.find((r) => r.timeZone === 'UTC')!.iso,
    results.find((r) => r.timeZone === 'Asia/Shanghai')!.iso,
  );
});