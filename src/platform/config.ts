/**
 * 平台统一配置：套餐额度、限额与开关。
 *
 * 【为什么集中在一个文件】
 * 用户明确要求：免费额度「不得散落硬编码在前端、后端和多个模块中」。
 * 因此所有限额只在这里定义一次，其它模块一律通过 `resolvePlatformLimits()` 取用。
 *
 * 【三层来源，优先级从低到高】
 *   1. DEFAULTS         —— 代码里的初始值（本文件）
 *   2. 环境变量          —— 部署时按需覆盖，见 ENV_OVERRIDES
 *   3. platform_settings 表 —— 管理员在后台调整，运行时可改，无需重启
 *
 * 【为什么 DB 层最重要】
 * 用户要求「所有限制均由服务端执行，管理员可以在平台后台调整」。
 * 环境变量改一次要重启，所以管理员调整走 DB；env 只作为部署默认值。
 */

/** 一个套餐的完整限额 */
export interface TierLimits {
  /** 套餐标识 */
  tier: string;
  /** 最多可创建的生成项目数 */
  maxProjects: number;
  /** 额度周期内最多 AI 生成次数 */
  maxAiGenerations: number;
  /** 额度周期内最多 AI 修改次数 */
  maxAiRevisions: number;
  /** 额度周期内最多消耗的 AI Token 总量 */
  tokenQuota: number;
  /** 是否允许平台在线托管 */
  hostingEnabled: boolean;
  /** 是否允许使用插件在线管理后台 */
  adminEnabled: boolean;
  /** 是否允许持续修改（超出此数的修改需要新套餐） */
  unlimitedRevisions: boolean;
  /** 草稿版本保留天数 */
  versionRetentionDays: number;
  /**
   * 项目保存天数；`null` 表示不限期。
   *
   * 【为什么是 per-tier 而不是一个全局常量】
   * 用户要求「免费项目是否需要短期保存，应通过统一的免费项目保存策略管理；
   * 不能承诺无限期保存」——「免费」是关键限定词，付费会员不应受同一条限制。
   * 因此把它表达成套餐的一个字段。原先 PLATFORM_LIMITS 里那个
   * `freeProjectRetentionDays` 全局常量已删除：两个地方各写一次同样的规则，
   * 迟早会漂移。
   */
  projectRetentionDays: number | null;
  /** 额度周期：'none' 表示一次性总额度，不随周期恢复 */
  quotaPeriod: 'none' | 'daily' | 'monthly';
}

/**
 * 初始默认配置。
 *
 * free 的数字来自用户给定的初始值：1 个项目、1 次 AI 修改、500,000 Token。
 * 其余套餐是「第一阶段先建立统一判定机制」用的占位套餐，
 * **不接真实支付**，由管理员在后台手工授予。
 */
export const DEFAULT_TIER_LIMITS: Readonly<Record<string, TierLimits>> = Object.freeze({
  free: {
    tier: 'free',
    maxProjects: 1,
    maxAiGenerations: 3,
    maxAiRevisions: 1,
    tokenQuota: 500_000,
    hostingEnabled: false,
    adminEnabled: false,
    unlimitedRevisions: false,
    versionRetentionDays: 7,
    // 免费项目保存 7 天（自最后修改起算）。
    // 刻意用「最后修改时间」而不是「创建时间」：用户在用的项目不应该被回收。
    projectRetentionDays: 7,
    quotaPeriod: 'none',
  },
  basic: {
    tier: 'basic',
    maxProjects: 3,
    maxAiGenerations: 50,
    maxAiRevisions: 50,
    tokenQuota: 3_000_000,
    hostingEnabled: true,
    adminEnabled: true,
    unlimitedRevisions: false,
    versionRetentionDays: 30,
    projectRetentionDays: null,
    quotaPeriod: 'monthly',
  },
  pro: {
    tier: 'pro',
    maxProjects: 20,
    maxAiGenerations: 500,
    maxAiRevisions: 500,
    tokenQuota: 30_000_000,
    hostingEnabled: true,
    adminEnabled: true,
    unlimitedRevisions: true,
    versionRetentionDays: 180,
    projectRetentionDays: null,
    quotaPeriod: 'monthly',
  },
});

/** 平台的种子套餐（第一个注册的套餐为默认套餐） */
export const DEFAULT_TIER = 'free';

/** 环境变量覆盖：`PLATFORM_<TIER>_<FIELD>`，例如 PLATFORM_FREE_TOKEN_QUOTA */
const ENV_PREFIX = 'PLATFORM_';

/** 允许被环境变量覆盖的字段白名单 —— 防止拼错的环境变量悄悄改变行为 */
const OVERRIDABLE_FIELDS: readonly (keyof TierLimits)[] = [
  'maxProjects',
  'maxAiGenerations',
  'maxAiRevisions',
  'tokenQuota',
  'hostingEnabled',
  'adminEnabled',
  'unlimitedRevisions',
  'versionRetentionDays',
  'projectRetentionDays',
];

function coerceField(field: keyof TierLimits, raw: string): unknown {
  if (field === 'hostingEnabled' || field === 'adminEnabled' || field === 'unlimitedRevisions') {
    return raw === 'true' || raw === '1';
  }
  // 保存期限是唯一可以为「不限期」的数值字段：
  // 用 `none` / `null` / 空串 / `0` 表达「不限期」，其余按天数解析。
  // 没有这个分支的话，管理员就没法把某个套餐改成不限期。
  if (field === 'projectRetentionDays') {
    const v = raw.trim().toLowerCase();
    if (v === 'none' || v === 'null' || v === '' || v === '0') return null;
    const days = Number(v);
    return Number.isFinite(days) && days > 0 ? Math.floor(days) : undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** 从 `process.env` 读取部署级覆盖 */
export function envTierOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, Partial<TierLimits>> {
  const out: Record<string, Partial<TierLimits>> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;
    const rest = key.slice(ENV_PREFIX.length).toLowerCase();
    if (!rest.includes('_')) continue;

    for (const tier of Object.keys(DEFAULT_TIER_LIMITS)) {
      const prefix = `${tier}_`;
      if (!rest.startsWith(prefix)) continue;
      const snake = rest.slice(prefix.length);
      const field = OVERRIDABLE_FIELDS.find(
        (f) => f.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`) === snake,
      );
      if (!field) break;
      const coerced = coerceField(field, value);
      if (coerced === undefined) break;
      out[tier] = { ...(out[tier] ?? {}), [field]: coerced };
      break;
    }
  }
  return out;
}

/** 把一份（可能不完整的）JSON 校验并合并成合法限额 */
export function mergeLimits(base: TierLimits, patch: Record<string, unknown>): TierLimits {
  const merged: TierLimits = { ...base };
  for (const field of OVERRIDABLE_FIELDS) {
    const raw = patch[field];
    if (raw === undefined || raw === null) continue;
    if (typeof merged[field] === 'boolean') {
      if (typeof raw === 'boolean') (merged[field] as boolean) = raw;
      else if (raw === 'true' || raw === 'false') (merged[field] as boolean) = raw === 'true';
      continue;
    }
    // 可为「不限期」的字段：显式 null 表示不限期
    if (field === 'projectRetentionDays' && (raw === null || raw === 'none' || raw === 0 || raw === '0')) {
      (merged[field] as number | null) = null;
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n) && n >= 0) (merged[field] as number) = Math.floor(n);
  }
  return merged;
}

/**
 * 解析全部套餐限额。
 *
 * @param stored 来自 `platform_settings` 表的管理员覆盖（键为 `limits.<tier>`）
 */
export function resolvePlatformLimits(
  stored: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, TierLimits> {
  const envOverrides = envTierOverrides(env);
  const out: Record<string, TierLimits> = {};

  for (const [tier, base] of Object.entries(DEFAULT_TIER_LIMITS)) {
    let limits = mergeLimits(base, envOverrides[tier] ?? {});
    const storedPatch = stored[`limits.${tier}`];
    if (storedPatch && typeof storedPatch === 'object') {
      limits = mergeLimits(limits, storedPatch as Record<string, unknown>);
    }
    out[tier] = limits;
  }
  return out;
}

/** 取某个套餐的限额；未知套餐一律按最严格的 free 处理，绝不默认放行 */
export function limitsFor(
  tier: string,
  stored: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): TierLimits {
  const all = resolvePlatformLimits(stored, env);
  return all[tier] ?? all[DEFAULT_TIER] ?? DEFAULT_TIER_LIMITS[DEFAULT_TIER]!;
}

/** 平台其它限额（与套餐无关的全局限制） */
export const PLATFORM_LIMITS = Object.freeze({
  /** 单次 AI 生成允许的最大输出 Token（防止一次请求烧穿额度） */
  maxOutputTokensPerCall: 8_000,
  /** 单次 AI 请求允许的最大输入 Token */
  maxInputTokensPerCall: 60_000,
  /** AI 任务在库中的最长存活时间（毫秒）；超过即视为失败可回收 */
  taskStaleMs: 10 * 60 * 1000,
  /** 一次生成最多接受的项目规格字节数 */
  maxSpecBytes: 256 * 1024,
  /**
   * 单次 AI 调用最多重试几次。
   *
   * 默认 **1** —— 且只重试「确定没有产生生成结果」的失败（连接失败、网关 5xx）。
   * 超时 / 协议错误 / 缺用量**不重试**：那些情况下上游很可能已经生成并计费，
   * 重试等于再花一次钱。判据见 `isRetriableProviderFailure`。
   */
  aiMaxRetries: 1,
});