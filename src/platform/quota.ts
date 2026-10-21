/**
 * 服务端额度判定。
 *
 * 【为什么必须在这里判】
 * 用户明确要求「所有限制均由服务端执行」，且
 * 「不能只通过前端隐藏按钮来实现会员限制」。
 * 因此每一次 AI 调用、每一次创建项目、每一次托管发布，
 * 都必须先经过本模块，前端只是把这里的结论展示出来。
 *
 * 【判定与扣减是两步】
 *   checkQuota()  → 够不够（纯读，不改状态）
 *   claimTask()   → 抢任务位（幂等写，见 ai/usage.ts）
 *   settleTask()  → 写终态用量
 * 之所以拆开：判定要在调用**之前**做（省得白花钱），
 * 结算要在调用**之后**做（因为真实用量只有调用完才知道）。
 * 中间用 taskId 唯一键兜住重复提交。
 */

import type { Database } from '../db/database.ts';
import { limitsFor, type TierLimits } from './config.ts';
import { usageSince, type UsageTotals } from './ai/usage.ts';
import type { AiTaskKind } from './ai/types.ts';
import { expiredNotice, type MembershipState } from './membership.ts';

/** 拒绝原因码 —— 前端据此给出可读提示，而不是靠猜字符串 */
export type QuotaDenyCode =
  | 'project_limit'
  | 'generation_limit'
  | 'revision_limit'
  | 'token_limit'
  | 'hosting_not_included'
  | 'admin_not_included'
  | 'single_call_too_large';

export interface QuotaDecision {
  allowed: boolean;
  code?: QuotaDenyCode;
  /** 可直接展示给用户的中文说明 */
  message?: string;
  limits: TierLimits;
  used: UsageTotals & { projects: number };
  /** 周期起点（ISO）；null 表示一次性总额度、不随周期恢复 */
  periodStart: string | null;
}

/** 计算套餐的额度周期起点。'none' = 一次性总额度，永远从最早算起。 */
export function periodStartFor(limits: TierLimits, now: Date): string | null {
  if (limits.quotaPeriod === 'none') return null;
  if (limits.quotaPeriod === 'daily') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return d.toISOString();
  }
  // monthly
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return d.toISOString();
}

/** 当前用户的项目数 */
export function countProjects(db: Database, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND status <> 'archived'")
    .get(userId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * 读取管理员在 `platform_settings` 里的覆盖。
 * 读失败不抛错 —— 配置读不到时退回代码默认值，绝不放行也不崩。
 */
export function readStoredSettings(db: Database): Record<string, unknown> {
  try {
    const rows = db.prepare('SELECT key, value_json FROM platform_settings').all();
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      const row = r as { key: string; value_json: string };
      try {
        out[row.key] = JSON.parse(row.value_json);
      } catch {
        // 单条配置损坏不影响其它配置
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 写入一条管理员配置 */
export function writeStoredSetting(db: Database, key: string, value: unknown, nowIso: string): void {
  db.prepare(
    `INSERT INTO platform_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso);
}

export interface QuotaCheckInput {
  userId: string;
  /** **生效**套餐（已考虑到期）；调用方应传 resolveMembership 的结果 */
  tier: string;
  /** 需要判定的动作 */
  action: 'create_project' | AiTaskKind | 'hosting.publish' | 'plugin.admin';
  /**
   * 会员到期信息（可选）。
   *
   * 【为什么额度判定要知道这件事】
   * 到期后生效套餐已经是 free，额度本身就会拒绝；但**提示该说什么**不一样：
   * 「升级套餐」和「续期会员」是两回事。用户明明买过会员，
   * 却被告知「升级套餐」，会以为系统把他的会员弄丢了。
   */
  membership?: { expired: boolean; memberUntil: string | null };
}

/**
 * 判定一次动作是否被允许。
 *
 * 这是服务端的唯一判定入口：路由层、服务层都必须调它，
 * 不允许任何地方自己算一遍额度。
 */
export function checkQuota(db: Database, input: QuotaCheckInput, now: Date = new Date()): QuotaDecision {
  const stored = readStoredSettings(db);
  const limits = limitsFor(input.tier, stored);
  const periodStart = periodStartFor(limits, now);
  const used = { ...usageSince(db, input.userId, periodStart), projects: countProjects(db, input.userId) };

  // 到期会员的提示要说「续期」，而不是笼统的「升级套餐」
  const renewHint = input.membership?.expired ? `${expiredNotice(input.membership as MembershipState)}续期后可继续使用。` : '';

  const deny = (code: QuotaDenyCode, message: string): QuotaDecision => ({
    allowed: false,
    code,
    message: renewHint === '' ? message : `${renewHint}${message}`,
    limits,
    used,
    periodStart,
  });

  if (input.action === 'create_project') {
    if (used.projects >= limits.maxProjects) {
      return deny(
        'project_limit',
        `当前套餐最多创建 ${limits.maxProjects} 个项目，已达上限。升级套餐或删除已有项目后可继续。`,
      );
    }
    return { allowed: true, limits, used, periodStart };
  }

  if (input.action === 'hosting.publish') {
    if (!limits.hostingEnabled) {
      return deny('hosting_not_included', '当前套餐不包含平台在线托管。可下载网页文件自行部署，或升级套餐。');
    }
    return { allowed: true, limits, used, periodStart };
  }

  if (input.action === 'plugin.admin') {
    if (!limits.adminEnabled) {
      return deny('admin_not_included', '当前套餐不包含插件在线管理后台。升级套餐后可使用。');
    }
    return { allowed: true, limits, used, periodStart };
  }

  // ---- AI 任务 ----
  if (used.tokens >= limits.tokenQuota) {
    return deny(
      'token_limit',
      `AI 额度已用尽（${used.tokens} / ${limits.tokenQuota} Token）。升级套餐${periodStart ? '或等待额度周期恢复' : ''}后可继续。`,
    );
  }

  if (input.action === 'generate') {
    if (used.generations >= limits.maxAiGenerations) {
      return deny(
        'generation_limit',
        `生成次数已用尽（${used.generations} / ${limits.maxAiGenerations} 次）。升级套餐${periodStart ? '或等待额度周期恢复' : ''}后可继续。`,
      );
    }
  } else {
    if (!limits.unlimitedRevisions && used.revisions >= limits.maxAiRevisions) {
      return deny(
        'revision_limit',
        `AI 修改次数已用尽（${used.revisions} / ${limits.maxAiRevisions} 次）。升级套餐可继续修改。`,
      );
    }
  }

  return { allowed: true, limits, used, periodStart };
}

/** 单次调用的体量上限 —— 防止一次请求就烧穿整个额度 */
export function checkCallSize(
  estimatedInputTokens: number,
  maxInputTokensPerCall: number,
  maxOutputTokensPerCall: number,
): { ok: true } | { ok: false; code: QuotaDenyCode; message: string } {
  if (estimatedInputTokens > maxInputTokensPerCall) {
    return {
      ok: false,
      code: 'single_call_too_large',
      message: `本次请求内容过长（约 ${estimatedInputTokens} Token，上限 ${maxInputTokensPerCall}）。请精简后重试。`,
    };
  }
  if (maxOutputTokensPerCall <= 0) {
    return { ok: false, code: 'single_call_too_large', message: '输出上限必须为正数。' };
  }
  return { ok: true };
}

/** 剩余额度的可读摘要（供前端展示，前端不参与判定） */
export function quotaSummary(db: Database, userId: string, tier: string, now: Date = new Date()) {
  const stored = readStoredSettings(db);
  const limits = limitsFor(tier, stored);
  const periodStart = periodStartFor(limits, now);
  const used = usageSince(db, userId, periodStart);
  const projects = countProjects(db, userId);

  return {
    tier: limits.tier,
    periodStart,
    tokens: { used: used.tokens, quota: limits.tokenQuota, remaining: Math.max(0, limits.tokenQuota - used.tokens) },
    generations: {
      used: used.generations,
      quota: limits.maxAiGenerations,
      remaining: Math.max(0, limits.maxAiGenerations - used.generations),
    },
    revisions: limits.unlimitedRevisions
      ? { used: used.revisions, quota: null, remaining: null }
      : {
          used: used.revisions,
          quota: limits.maxAiRevisions,
          remaining: Math.max(0, limits.maxAiRevisions - used.revisions),
        },
    projects: { used: projects, quota: limits.maxProjects, remaining: Math.max(0, limits.maxProjects - projects) },
    hostingEnabled: limits.hostingEnabled,
    adminEnabled: limits.adminEnabled,
  };
}