/**
 * 会员有效期的统一判定。
 *
 * 【为什么需要单独一个模块】
 * `users.member_until` 这个字段从加进 schema 起就**只被存储和读取，
 * 从来没有参与过任何判断** —— 也就是说「会员到期」这件事在服务端不存在。
 * 会员到期后，用户照样能发布到平台托管、用会员额度。
 *
 * 判定必须**只有一处**：如果每个接口各自读一次 `users.tier` 再各写一遍到期逻辑，
 * 迟早会漏掉某个入口（本项目已经有 6 个地方直接读 tier）。
 * 所以这里提供唯一入口，其余地方一律走它。
 *
 * 【字段含义（依据现有代码与数据得出，未做猜测）】
 *   - 类型：`TEXT`，可空（迁移 v3 添加）。
 *   - 格式：ISO-8601 瞬间（与项目其它时间字段一致），因此比较的是**时间点**，
 *     不涉及本地时区与 UTC 混用的问题。
 *   - 写入方：**没有任何代码写过它** —— 现有会员都是直接改库设置的，
 *     值一律为 `NULL`。
 *
 * 【三种状态如何区分】
 * 现有数据无法区分「永久有效」与「未设置到期时间」，因此选择**兼容且安全**的规则：
 *
 *   | tier     | member_until        | 生效套餐 | 说明 |
 *   | ---      | ---                 | ---      | --- |
 *   | `free`   | 任意                | `free`   | 免费用户不受会员有效期影响 |
 *   | 非 free  | `NULL`              | 原套餐   | **视为不限期**（见下） |
 *   | 非 free  | 可解析且 `now <` 它  | 原套餐   | 未到期 |
 *   | 非 free  | 可解析且 `now >=` 它 | `free`   | **已到期** |
 *   | 非 free  | 无法解析            | `free`   | **视为已到期**（fail-safe） |
 *
 * **为什么 NULL 视为不限期**：现有代码里没有任何地方写入该字段，
 * 也就是说**当前所有会员的 member_until 都是 NULL**。若把 NULL 当作「已到期」，
 * 这次改动会让全部现有会员立刻失去权限 —— 那是用一个猜测去推翻既有行为。
 * 反过来把它当作不限期，与改动前的实际效果一致，是兼容的选择。
 *
 * **为什么无法解析时按已到期处理**：读不懂的到期时间不应该换来付费权限。
 * 这是唯一一处刻意 fail-closed 的地方，且会在报告里说明。
 *
 * 【边界规则】
 * 有效期是**[起, 止) 半开区间**：`now < member_until` 有效，
 * `now === member_until` **已到期**。到期时刻本身不再授予权限，
 * 避免「刚好卡在到期瞬间」出现两种解释。
 */

import type { Database } from '../db/database.ts';

export interface MembershipInput {
  tier: string;
  memberUntil: string | null;
}

export interface MembershipState {
  /** 生效套餐：已考虑到期，可直接用于额度判定 */
  tier: string;
  /** 数据库里记录的套餐（未考虑到期），仅用于展示与排查 */
  recordedTier: string;
  /** 会员是否已到期 */
  expired: boolean;
  /** 记录的到期时间；null 表示未设置 */
  memberUntil: string | null;
}

/** 免费套餐标识。与 config.ts 的 DEFAULT_TIER 保持一致。 */
const FREE_TIER = 'free';

/**
 * 解析出**生效套餐**。
 *
 * @param user 需要 `tier` 与 `memberUntil`
 * @param now  判定时刻（由 Clock 提供，便于用可控时间测试）
 */
export function resolveMembership(user: MembershipInput, now: Date): MembershipState {
  const recordedTier = typeof user.tier === 'string' && user.tier !== '' ? user.tier : FREE_TIER;
  const memberUntil =
    typeof user.memberUntil === 'string' && user.memberUntil !== '' ? user.memberUntil : null;

  // 免费用户不涉及会员有效期
  if (recordedTier === FREE_TIER) {
    return { tier: FREE_TIER, recordedTier, expired: false, memberUntil };
  }

  // 未设置到期时间 → 视为不限期（与改动前的实际行为一致）
  if (memberUntil === null) {
    return { tier: recordedTier, recordedTier, expired: false, memberUntil: null };
  }

  const until = new Date(memberUntil);
  const untilMs = until.getTime();

  // 到期时间无法解析 → fail-safe：不授予付费权限
  if (!Number.isFinite(untilMs)) {
    return { tier: FREE_TIER, recordedTier, expired: true, memberUntil };
  }

  // 半开区间 [起, 止)：now < until 才算有效
  if (now.getTime() < untilMs) {
    return { tier: recordedTier, recordedTier, expired: false, memberUntil };
  }

  return { tier: FREE_TIER, recordedTier, expired: true, memberUntil };
}

/**
 * 直接按 userId 查库解析会员状态。
 *
 * 【为什么要有这个辅助】
 * 项目里有多处**不经会话**就要判定套餐的地方（发布、AI 任务、恢复、
 * 到期回收扫描）。它们原先各自 `SELECT tier FROM users`，
 * 如果每处都自己补一遍到期判断，迟早漏掉一处 —— 而漏掉的那处
 * 就是「到期会员仍能用会员功能」的缺口。
 * 统一走这里，就不会有第二个版本。
 *
 * 用户不存在时返回 null（调用方按「无此用户」处理，不要当成免费用户放行）。
 */
export function membershipForUser(db: Database, userId: string, now: Date): MembershipState | null {
  const row = db.prepare('SELECT tier, member_until FROM users WHERE id = ?').get(userId) as
    | { tier: string | null; member_until: string | null }
    | undefined;
  if (!row) return null;
  return resolveMembership(
    {
      tier: typeof row.tier === 'string' ? row.tier : FREE_TIER,
      memberUntil: typeof row.member_until === 'string' ? row.member_until : null,
    },
    now,
  );
}

/** 把到期时间格式化成可读文本，用于提示；解析不了时原样返回 */
export function describeMemberUntil(memberUntil: string | null): string {
  if (memberUntil === null) return '';
  const d = new Date(memberUntil);
  if (!Number.isFinite(d.getTime())) return memberUntil;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** 到期时给用户的提示前缀 —— 明确说「已到期」，而不是笼统的「套餐不包含」 */
export function expiredNotice(state: MembershipState): string {
  const at = describeMemberUntil(state.memberUntil);
  return at === '' ? '会员已到期。' : `会员已于 ${at} 到期。`;
}