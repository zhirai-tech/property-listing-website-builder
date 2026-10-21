/**
 * 时区工具单元测试。
 * 方案第 9 条要求「时区可配置」，提醒的准确性完全依赖这里的换算。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addZonedDays,
  assertTimeZone,
  formatZoned,
  fromZonedParts,
  startOfZonedDay,
  toZonedParts,
  zonedHourOfDay,
} from '../../src/util/time.ts';

test('瞬间 -> 目标时区日历字段', () => {
  const parts = toZonedParts(new Date('2026-01-15T02:00:00.000Z'), 'Asia/Shanghai');
  assert.deepEqual(parts, { year: 2026, month: 1, day: 15, hour: 10, minute: 0, second: 0 });
});

test('午夜零点被正确表示为 0 点而不是 24 点', () => {
  const parts = toZonedParts(new Date('2026-01-15T16:00:00.000Z'), 'Asia/Shanghai');
  assert.equal(parts.hour, 0);
  assert.equal(parts.day, 16);
});

test('日历字段 -> 瞬间（反向换算）', () => {
  const instant = fromZonedParts(
    { year: 2026, month: 1, day: 15, hour: 10, minute: 0, second: 0 },
    'Asia/Shanghai',
  );
  assert.equal(instant.toISOString(), '2026-01-15T02:00:00.000Z');
});

test('往返换算保持一致', () => {
  const original = new Date('2026-06-01T07:30:15.000Z');
  const parts = toZonedParts(original, 'America/New_York');
  const roundTrip = fromZonedParts(parts, 'America/New_York');
  assert.equal(roundTrip.toISOString(), original.toISOString());
});

test('跨夏令时切换增加天数时保持当地时刻不变', () => {
  // 美国 2026 年夏令时于 3 月 8 日 02:00 开始
  const before = new Date('2026-03-07T14:00:00.000Z'); // 纽约 09:00 EST
  assert.equal(toZonedParts(before, 'America/New_York').hour, 9);

  const after = addZonedDays(before, 1, 'America/New_York');
  const local = toZonedParts(after, 'America/New_York');

  assert.equal(local.day, 8, '日期应前进一天');
  assert.equal(local.hour, 9, '当地时刻应保持 9 点（已切换为 EDT）');
  assert.equal(after.toISOString(), '2026-03-08T13:00:00.000Z');
});

test('跨夏令时结束后增加天数同样保持当地时刻', () => {
  const before = new Date('2026-10-31T13:00:00.000Z'); // 纽约 09:00 EDT
  const after = addZonedDays(before, 1, 'America/New_York');

  assert.equal(toZonedParts(after, 'America/New_York').hour, 9);
  assert.equal(toZonedParts(after, 'America/New_York').day, 1);
});

test('跨月与跨年增加天数正确', () => {
  const endOfMonth = new Date('2026-01-31T02:00:00.000Z');
  const next = toZonedParts(addZonedDays(endOfMonth, 1, 'Asia/Shanghai'), 'Asia/Shanghai');
  assert.deepEqual([next.month, next.day], [2, 1]);

  const endOfYear = new Date('2026-12-31T02:00:00.000Z');
  const year = toZonedParts(addZonedDays(endOfYear, 1, 'Asia/Shanghai'), 'Asia/Shanghai');
  assert.deepEqual([year.year, year.month, year.day], [2027, 1, 1]);
});

test('zonedHourOfDay 把时刻固定到当地指定小时', () => {
  const instant = new Date('2026-01-15T20:00:00.000Z');
  const nine = zonedHourOfDay(instant, 'Asia/Shanghai', 9);
  const parts = toZonedParts(nine, 'Asia/Shanghai');

  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 0);
  assert.equal(parts.day, 16, '当地日期应已跨到次日');
});

test('startOfZonedDay 返回当地 00:00', () => {
  const instant = new Date('2026-01-15T20:30:00.000Z');
  const start = startOfZonedDay(instant, 'Asia/Shanghai');
  const parts = toZonedParts(start, 'Asia/Shanghai');

  assert.deepEqual([parts.hour, parts.minute, parts.second], [0, 0, 0]);
  assert.equal(parts.day, 16);
});

test('非法时区被明确拒绝', () => {
  assert.throws(() => assertTimeZone('Not/AZone'), /无效的 IANA 时区/);
  assert.equal(assertTimeZone('UTC'), 'UTC');
});

test('formatZoned 按目标时区输出', () => {
  const text = formatZoned(new Date('2026-01-15T02:00:00.000Z'), 'Asia/Shanghai', 'zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  assert.ok(text.includes('2026'), text);
});