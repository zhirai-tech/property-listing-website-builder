/**
 * 免费项目的保存期限。
 *
 * 【用户的要求】
 * 「免费项目是否需要短期保存，应通过统一的免费项目保存策略管理；
 * 不能承诺无限期保存。」
 *
 * 【为什么必须有这个模块，而不是留一个常量】
 * 原先 `PLATFORM_LIMITS.freeProjectRetentionDays = 7` 定义了却**从未被任何代码读取**。
 * 一个定义了却不生效的限制比没有更糟 —— 它会让读代码的人以为限制已经在那里。
 * 现在它被表达成套餐字段（`TierLimits.projectRetentionDays`）并在下面真正执行。
 *
 * 【三条设计决定】
 *
 * 1. **按「最后修改时间」算，不按「创建时间」**
 *    老用户天天在改的项目不该突然被回收。期限的意义是清理废弃项目，不是惩罚活跃用户。
 *
 * 2. **到期只「归档」，不删除**
 *    用户明确要求不得执行破坏性操作。归档后项目从列表消失、额度释放，
 *    数据仍在库里，可恢复。物理删除是另一件事，本阶段不做。
 *
 * 3. **付费套餐不限期**
 *    用户把这条限制明确限定在「免费用户」。套餐变为付费后，
 *    已有的免费项目应立即不再倒计时。
 */

import type { Database } from '../db/database.ts';
import type { AppContext } from '../app-context.ts';
import type { TierLimits } from './config.ts';
import { limitsFor } from './config.ts';
import { readStoredSettings } from './quota.ts';
import { resolveMembership } from './membership.ts';

/** 一份项目的期限信息 */
export interface ProjectRetention {
  /** 到期时间（ISO）；null 表示不限期 */
  expiresAt: string | null;
  /** 是否已到期 */
  expired: boolean;
  /** 剩余天数（向上取整）；不限期时为 null */
  daysLeft: number | null;
  /** 适用的规则天数；不限期时为 null */
  retentionDays: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 算出一个项目的保存期限。
 *
 * @param updatedAt 项目最后修改时间（ISO）
 * @param limits    该用户当前套餐的限额
 */
export function projectRetention(
  updatedAt: string,
  limits: TierLimits,
  now: Date = new Date(),
): ProjectRetention {
  const days = limits.projectRetentionDays;
  if (days === null) {
    return { expiresAt: null, expired: false, daysLeft: null, retentionDays: null };
  }

  const base = Date.parse(updatedAt);
  if (Number.isNaN(base)) {
    // 时间戳坏掉时**不判为过期** —— 宁可留着，也不要因为一条脏数据把项目归档掉
    return { expiresAt: null, expired: false, daysLeft: null, retentionDays: days };
  }

  const expiresAtMs = base + days * MS_PER_DAY;
  const daysLeft = Math.ceil((expiresAtMs - now.getTime()) / MS_PER_DAY);
  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    expired: expiresAtMs <= now.getTime(),
    daysLeft,
    retentionDays: days,
  };
}

/** 给一个项目的响应附加期限信息 */
export function withRetention<T extends { updatedAt: string; status: string }>(
  project: T,
  limits: TierLimits,
  now: Date = new Date(),
): T & { retention: ProjectRetention } {
  return { ...project, retention: projectRetention(project.updatedAt, limits, now) };
}

export interface ExpireResult {
  /** 被归档的项目 */
  archived: { id: string; userId: string; title: string; updatedAt: string }[];
  /** 扫描过的项目数 */
  scanned: number;
}

/**
 * 把已到期的免费项目归档。
 *
 * 【刻意不做的事】
 *  - 不物理删除任何行；
 *  - 不动付费用户的项目；
 *  - 不动已经归档的项目。
 *
 * 有意做成一个**可以手工调用的函数 + 脚本**，而不是进程内定时器：
 * 到期清理是低频、可延迟的操作，放进主进程只会增加一个随时可能出错的背景任务。
 * 这也是项目里 `scripts/run-reminders.ts` 已有的做法。
 */
export function expireOverdueProjects(
  ctx: AppContext,
  // 同样取自应用时钟：会员到期回收必须与会话判定用同一个「现在」
  now: Date = ctx.adapters.clock.now(),
): ExpireResult {
  const stored = readStoredSettings(ctx.db);

  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.user_id, p.title, p.updated_at, u.tier, u.member_until
         FROM projects p
         JOIN users u ON u.id = p.user_id
        WHERE p.status <> 'archived'`,
    )
    .all() as {
    id: string;
    user_id: string;
    title: string;
    updated_at: string;
    tier: string;
    member_until: string | null;
  }[];

  const archived: ExpireResult['archived'] = [];
  const at = now.toISOString();

  for (const row of rows) {
    // 用**生效**套餐：会员到期后应按免费套餐的保存期限处理。
    // 若这里仍读 u.tier，到期会员的项目会一直按会员期限（不限期）保留 ——
    // 那条规则就永远不生效。
    const membership = resolveMembership({ tier: row.tier, memberUntil: row.member_until }, now);
    const limits = limitsFor(membership.tier, stored);
    if (!projectRetention(row.updated_at, limits, now).expired) continue;

    // 归档而不是删除：数据仍在库里，管理员可恢复
    const changed = ctx.db
      .prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ? AND status <> 'archived'")
      .run(at, row.id);
    if (Number(changed.changes ?? 0) > 0) {
      archived.push({ id: row.id, userId: row.user_id, title: row.title, updatedAt: row.updated_at });
    }
  }

  return { archived, scanned: rows.length };
}