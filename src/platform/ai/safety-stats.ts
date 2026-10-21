/**
 * 生成质量的观测：校验门到底拒掉了多少、因为什么。
 *
 * 【为什么需要这个】
 * 校验门是一个取舍：太松会放行危险页面，太紧会让模型正常的输出也过不去。
 * 第九阶段把门做得很紧，但**「紧到什么程度」当时没有数字**——
 * 而「要不要放宽」这种问题，靠感觉讨论没有意义。
 *
 * 【为什么要按插件拆开 —— 这条很重要】
 * 第一版统计的是**全部** AI 任务，但校验门**只作用于自由页面类插件**（模式 B）。
 * 房源插件（模式 A）的任务根本不经过这道门，一旦样本里模式 A 占多数，
 * 算出来的拒绝率就会**系统性偏低** —— 而我要用这个数字判断「门该松还是该紧」。
 * 用一个有偏差的数字做决策，比没有数字更糟。所以这里按插件分别统计。
 *
 * 【为什么从台账算而不是另建计数表】
 * 台账本来就在记录每一次任务的终态与失败原因，是一份现成的事实来源。
 * 另建一张计数的表只会多一份需要同步维护的状态，还可能对不上。
 */

import type { Database } from '../../db/database.ts';

/** 校验门失败时写进 failure_reason 的固定前缀（见 projects.ts） */
const GATE_PREFIX = '生成结果未通过安全检查：';

/** 受校验门约束的插件 —— 只有这些的拒绝率才是有意义的 */
export const GATED_PLUGINS: readonly string[] = ['custom-page'];

export interface RuleHit {
  /** 规则名，例如 forbidden_tag:script 或 meta_not_allowed */
  rule: string;
  count: number;
}

export interface SafetyStats {
  /**
   * 统计口径。
   * `gated`  —— 只含受校验门约束的插件（**判断门严不严要看这个**）
   * `gatedExcluded` —— 其余插件（不受门约束，混进来会拉低拒绝率）
   */
  scope: 'gated' | 'gatedExcluded' | 'all';
  totalTasks: number;
  succeeded: number;
  /** 被校验门拒掉的次数 */
  rejectedByGate: number;
  /** 其它失败（上游错误、超时等） */
  failedOther: number;
  /** 被门拒掉的比例（0–1）；没有任务时为 0 */
  rejectRate: number;
  /** 各规则的命中次数，从多到少 */
  rules: RuleHit[];
}

interface RawRow {
  status: string;
  failure_reason: string | null;
  plugin_id: string | null;
}

function summarize(rows: RawRow[], scope: SafetyStats['scope']): SafetyStats {
  const counts = new Map<string, number>();
  let succeeded = 0;
  let rejectedByGate = 0;
  let failedOther = 0;

  for (const row of rows) {
    if (row.status === 'succeeded') {
      succeeded += 1;
      continue;
    }
    const reason = row.failure_reason ?? '';
    if (reason.startsWith(GATE_PREFIX)) {
      rejectedByGate += 1;
      const list = reason.slice(GATE_PREFIX.length);
      for (const rule of list.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
        counts.set(rule, (counts.get(rule) ?? 0) + 1);
      }
    } else {
      failedOther += 1;
    }
  }

  const totalTasks = rows.length;
  return {
    scope,
    totalTasks,
    succeeded,
    rejectedByGate,
    failedOther,
    rejectRate: totalTasks === 0 ? 0 : rejectedByGate / totalTasks,
    rules: [...counts.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
  };
}

export interface SafetyStatsOptions {
  /** 只看最近多少条任务；缺省 500。传 0 表示不限。 */
  limit?: number;
  /**
   * 统计范围。缺省 `gated` —— **这是判断门严不严时唯一正确的口径**。
   */
  scope?: SafetyStats['scope'];
}

const SCOPE_FILTER: Record<SafetyStats['scope'], string> = {
  // 只统计受门约束的插件。project_id 为空的记录（项目已删）无法判断插件，
  // 保守起见归入「不受约束」一档，避免把来源不明的失败算进门里。
  gated: `p.plugin_id IN (${GATED_PLUGINS.map(() => '?').join(',')})`,
  gatedExcluded: `(p.plugin_id IS NULL OR p.plugin_id NOT IN (${GATED_PLUGINS.map(() => '?').join(',')}))`,
  all: '1 = 1',
};

/**
 * 汇总最近的任务。
 *
 * 注意 SQL 里用 **LEFT JOIN**：项目被删除后 `project_id` 会变成 NULL
 * （外键是 ON DELETE SET NULL），这些历史记录不能被静默丢掉 ——
 * 丢掉会让统计看起来「样本变少」，但看不出为什么。
 */
export function safetyStats(db: Database, options: SafetyStatsOptions = {}): SafetyStats {
  const limit = options.limit ?? 500;
  const scope = options.scope ?? 'gated';

  const rows = db
    .prepare(
      `SELECT a.status AS status, a.failure_reason AS failure_reason, p.plugin_id AS plugin_id
         FROM ai_usage a
         LEFT JOIN projects p ON p.id = a.project_id
        WHERE ${SCOPE_FILTER[scope]}
        ORDER BY a.created_at DESC
        LIMIT ?`,
    )
    .all(...(scope === 'all' ? [] : [...GATED_PLUGINS]), limit > 0 ? limit : -1) as unknown as RawRow[];

  return summarize(rows, scope);
}

/**
 * 同时给出三种口径，便于对照。
 *
 * `gated` 与 `gatedExcluded` 的对比本身就是信息：
 * 如果两者的拒绝率差很多，说明「不受门约束的任务」正在稀释总体数字 ——
 * 这正是第一版统计的问题。
 */
export function safetyStatsBreakdown(db: Database, limit = 500) {
  return {
    gated: safetyStats(db, { limit, scope: 'gated' }),
    gatedExcluded: safetyStats(db, { limit, scope: 'gatedExcluded' }),
    all: safetyStats(db, { limit, scope: 'all' }),
    gatedPlugins: [...GATED_PLUGINS],
  };
}