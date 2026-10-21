/**
 * 会员有效期判定（纯函数）单元测试。
 *
 * 时间边界必须精确 —— 本地时区与 UTC 混用会让会员提前失效或过期后仍有效，
 * 所以这里全部用 **ISO 瞬间**（UTC）比较，边界逐毫秒断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeMemberUntil,
  expiredNotice,
  resolveMembership,
} from '../../src/platform/membership.ts';

const NOW = new Date('2026-06-15T12:00:00.000Z');

test('免费用户不受会员有效期影响', () => {
  for (const until of [null, '2020-01-01T00:00:00.000Z', 'not-a-date']) {
    const s = resolveMembership({ tier: 'free', memberUntil: until }, NOW);
    assert.equal(s.tier, 'free');
    assert.equal(s.expired, false, `免费用户不该被判定为「会员已到期」：${until}`);
  }
});

test('未设置到期时间 → 视为不限期（与改动前行为一致）', () => {
  for (const tier of ['basic', 'pro']) {
    const s = resolveMembership({ tier, memberUntil: null }, NOW);
    assert.equal(s.tier, tier, `${tier} 的 member_until 为 NULL 时应保持原套餐`);
    assert.equal(s.expired, false);
    assert.equal(s.memberUntil, null);
  }
  // 空串与 undefined 同样按未设置处理
  assert.equal(resolveMembership({ tier: 'basic', memberUntil: '' }, NOW).tier, 'basic');
});

test('未到期 → 保持原套餐', () => {
  const s = resolveMembership({ tier: 'pro', memberUntil: '2026-06-15T12:00:00.001Z' }, NOW);
  assert.equal(s.tier, 'pro');
  assert.equal(s.expired, false);
});

test('已到期 → 生效套餐降为 free，并标记 expired', () => {
  const s = resolveMembership({ tier: 'pro', memberUntil: '2026-06-15T11:59:59.999Z' }, NOW);
  assert.equal(s.tier, 'free');
  assert.equal(s.expired, true);
  assert.equal(s.recordedTier, 'pro', '原套餐应保留在 recordedTier 里，便于排查');
});

test('时间边界：到期时刻本身已不算有效（半开区间 [起, 止)）', () => {
  const at = '2026-06-15T12:00:00.000Z';
  // 到期前 1 毫秒 → 有效
  assert.equal(resolveMembership({ tier: 'basic', memberUntil: at }, new Date(Date.parse(at) - 1)).expired, false);
  // 正好到期 → 已到期
  assert.equal(resolveMembership({ tier: 'basic', memberUntil: at }, new Date(Date.parse(at))).expired, true);
  // 到期后 1 毫秒 → 已到期
  assert.equal(resolveMembership({ tier: 'basic', memberUntil: at }, new Date(Date.parse(at) + 1)).expired, true);
});

test('带时区偏移的到期时间按瞬间比较，不受本地时区影响', () => {
  // 2026-06-15T20:00:00+08:00 与 12:00Z 是同一瞬间
  const sameInstant = '2026-06-15T20:00:00+08:00';
  assert.equal(resolveMembership({ tier: 'basic', memberUntil: sameInstant }, NOW).expired, true, '同一瞬间应已到期');
  assert.equal(
    resolveMembership({ tier: 'basic', memberUntil: sameInstant }, new Date('2026-06-15T11:59:00.000Z')).expired,
    false,
  );
});

test('到期时间无法解析 → fail-safe 视为已到期', () => {
  for (const bad of ['not-a-date', '2026-13-45', '']) {
    const s = resolveMembership({ tier: 'pro', memberUntil: bad }, NOW);
    if (bad === '') {
      // 空串按「未设置」处理
      assert.equal(s.expired, false, '空串应视为未设置');
    } else {
      assert.equal(s.tier, 'free', `无法解析的到期时间不应授予付费权限：${bad}`);
      assert.equal(s.expired, true);
    }
  }
});

test('套餐字段异常时按免费处理，不意外授予付费权限', () => {
  for (const tier of ['', 'unknown-tier']) {
    const s = resolveMembership({ tier, memberUntil: null }, NOW);
    // '' 会归一化成 free；未知套餐名保持原样交给 limitsFor 决定（它有自己的兜底）
    if (tier === '') assert.equal(s.tier, 'free');
    else assert.equal(s.recordedTier, 'unknown-tier');
  }
});

test('提示文案包含到期时间，且说的是「到期」不是「升级」', () => {
  const s = resolveMembership({ tier: 'basic', memberUntil: '2026-01-02T03:04:05.000Z' }, NOW);
  const notice = expiredNotice(s);
  assert.match(notice, /到期/);
  assert.match(notice, /2026-01-02 03:04:05 UTC/);
  assert.ok(!/升级/.test(notice), '到期提示不该说「升级」');
  assert.match(describeMemberUntil('2026-01-02T03:04:05.000Z'), /2026-01-02 03:04:05 UTC/);
});