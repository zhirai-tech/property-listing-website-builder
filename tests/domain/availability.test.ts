/**
 * 可租状态推导单元测试。
 *
 * 对外要能区分三种情况：
 *  - 出租中：房东确认仍可租；
 *  - 已租：房东明确标记已租出；
 *  - 未确认：房东长时间没更新信息，系统按陈旧度自动判定。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityNeedsAttention, resolveAvailability } from '../../src/domain/availability.ts';

const NOW = new Date('2026-10-12T12:00:00.000Z');

/** 构造一个「N 天前更新过」的房源 */
function updatedDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

test('刚更新过的房源显示为出租中', () => {
  const result = resolveAvailability(
    { availabilityStatus: 'available', updatedAt: updatedDaysAgo(0) },
    NOW,
    30,
  );

  assert.equal(result.status, 'available');
  assert.equal(result.stale, false);
  assert.equal(result.staleDays, 0);
  assert.equal(availabilityNeedsAttention(result.status), false);
});

test('房东明确标记已租时显示为已租，且不再受陈旧度影响', () => {
  const result = resolveAvailability(
    { availabilityStatus: 'rented', updatedAt: updatedDaysAgo(0) },
    NOW,
    30,
  );

  assert.equal(result.status, 'rented');
  assert.equal(result.stale, false);
  assert.equal(availabilityNeedsAttention(result.status), false);
});

test('已租优先于陈旧判定：即使很久没更新也仍显示已租', () => {
  const result = resolveAvailability(
    { availabilityStatus: 'rented', updatedAt: updatedDaysAgo(400) },
    NOW,
    30,
  );

  assert.equal(result.status, 'rented');
  assert.equal(result.stale, false);
});

test('超过阈值未更新时自动判定为未确认，并给出天数', () => {
  const result = resolveAvailability(
    { availabilityStatus: 'available', updatedAt: updatedDaysAgo(45) },
    NOW,
    30,
  );

  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.stale, true);
  assert.equal(result.staleDays, 45);
  assert.equal(availabilityNeedsAttention(result.status), true);
});

test('阈值边界：第 29 天仍为出租中，第 30 天变为未确认', () => {
  const day29 = resolveAvailability(
    { availabilityStatus: 'available', updatedAt: updatedDaysAgo(29) },
    NOW,
    30,
  );
  const day30 = resolveAvailability(
    { availabilityStatus: 'available', updatedAt: updatedDaysAgo(30) },
    NOW,
    30,
  );

  assert.equal(day29.status, 'available');
  assert.equal(day30.status, 'unconfirmed');
});

test('阈值为 0 或负数时关闭陈旧判定', () => {
  for (const threshold of [0, -1]) {
    const result = resolveAvailability(
      { availabilityStatus: 'available', updatedAt: updatedDaysAgo(9999) },
      NOW,
      threshold,
    );
    assert.equal(result.status, 'available', `阈值 ${threshold} 应关闭自动判定`);
    assert.equal(result.stale, false);
  }
});

test('编辑房源即视为更新，会从「未确认」回到「出租中」', () => {
  const stale = resolveAvailability(
    { availabilityStatus: 'available', updatedAt: updatedDaysAgo(60) },
    NOW,
    30,
  );
  assert.equal(stale.status, 'unconfirmed');

  const refreshed = resolveAvailability(
    { availabilityStatus: 'available', updatedAt: updatedDaysAgo(0) },
    NOW,
    30,
  );
  assert.equal(refreshed.status, 'available');
});

test('更新时间不可解析时不崩溃，按「刚更新」处理而不是误报未确认', () => {
  const result = resolveAvailability(
    { availabilityStatus: 'available', updatedAt: '不是时间' },
    NOW,
    30,
  );

  assert.equal(result.staleDays, 0);
  assert.equal(result.status, 'available');
});

test('更新时间为未来时间时不会出现负数天数', () => {
  const future = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
  const result = resolveAvailability(
    { availabilityStatus: 'available', updatedAt: future },
    NOW,
    30,
  );

  assert.equal(result.staleDays, 0);
  assert.equal(result.status, 'available');
});
