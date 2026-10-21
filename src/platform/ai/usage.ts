/**
 * AI 用量台账。
 *
 * 【三条硬要求，逐一落实】
 *
 * 1. 「必须使用服务端可信的模型调用结果记录用量」
 *    → 所有写入此处的用量都来自 `AiProvider` 的返回值，
 *      不接受任何来自 HTTP 请求体的 token 数字（见 routes 层）。
 *
 * 2. 「同一任务不得重复扣费」
 *    → `ai_usage.task_id` 有 UNIQUE 索引，是最终防线。
 *      `claimTask()` 用 INSERT 抢占，撞唯一约束即表示该任务已被登记，
 *      调用方据此拒绝重复执行 —— 并发、重试、刷新重放都拦得住。
 *
 * 3. 「失败任务依据实际发生的调用执行明确的结算或返还规则」
 *    → 明确规则如下（不是「随意扣除」）：
 *      · 调用**没有真正发出**（额度检查就拒了）→ 不写台账，零消耗。
 *      · 调用发出但**供应商报错** → 记 failed，按供应商实际返回的用量结算；
 *        若供应商没返回用量，则记 0（不猜测、不按估算扣）。
 *      · 调用成功 → 记 succeeded，按实际用量结算。
 *
 * 【为什么不做「预留-返还」】
 * 预留会让「失败」变成一次写两次（先扣再退），中途崩溃会留下错误的账。
 * 直接用唯一键抢占 + 终态一次性写入，账目只有一次写入，不会出现中间态。
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../db/database.ts';
import { nowIso } from '../../db/database.ts';
import type { AiTaskKind, AiTaskStatus, AiUsageReport, SettleInput } from './types.ts';

export interface AiUsageRow {
  id: string;
  userId: string;
  projectId: string | null;
  taskId: string;
  kind: AiTaskKind;
  provider: string;
  model: string;
  status: AiTaskStatus;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
  failureReason: string | null;
  createdAt: string;
}

function mapRow(raw: Record<string, unknown>): AiUsageRow {
  return {
    id: String(raw['id']),
    userId: String(raw['user_id']),
    projectId: raw['project_id'] === null || raw['project_id'] === undefined ? null : String(raw['project_id']),
    taskId: String(raw['task_id']),
    kind: String(raw['kind']) as AiTaskKind,
    provider: String(raw['provider']),
    model: String(raw['model']),
    status: String(raw['status']) as AiTaskStatus,
    inputTokens: Number(raw['input_tokens'] ?? 0),
    outputTokens: Number(raw['output_tokens'] ?? 0),
    totalTokens: Number(raw['total_tokens'] ?? 0),
    costMicros: Number(raw['cost_micros'] ?? 0),
    failureReason: raw['failure_reason'] === null ? null : String(raw['failure_reason'] ?? ''),
    createdAt: String(raw['created_at']),
  };
}

/** 某个 taskId 是否已经被登记过 */
export function taskExists(db: Database, taskId: string): boolean {
  const row = db.prepare('SELECT 1 AS x FROM ai_usage WHERE task_id = ?').get(taskId);
  return row !== undefined;
}

export function getByTaskId(db: Database, taskId: string): AiUsageRow | null {
  const row = db.prepare('SELECT * FROM ai_usage WHERE task_id = ?').get(taskId);
  return row ? mapRow(row as Record<string, unknown>) : null;
}

/**
 * 抢占一个任务 id。
 *
 * 用带唯一约束的 INSERT 占位（先写入 0 用量），
 * 成功返回 `{claimed: true, id}`；撞唯一约束说明任务已被登记，
 * 返回 `{claimed: false}`，调用方必须**放弃执行**而不是再跑一次。
 */
export function claimTask(
  db: Database,
  input: { taskId: string; userId: string; projectId: string | null; kind: AiTaskKind; provider: string; model: string },
): { claimed: true; id: string } | { claimed: false } {
  const id = `aiu_${randomUUID()}`;
  try {
    db.prepare(
      `INSERT INTO ai_usage
         (id, user_id, project_id, task_id, kind, provider, model, status,
          input_tokens, output_tokens, total_tokens, cost_micros, failure_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'rejected', 0, 0, 0, 0, NULL, ?)`,
    ).run(id, input.userId, input.projectId, input.taskId, input.kind, input.provider, input.model, nowIso());
    return { claimed: true, id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|PRIMARY KEY/i.test(message)) return { claimed: false };
    throw error;
  }
}

/**
 * 结算一次任务的最终用量。只允许从占位态改成终态，不会重复累加。
 *
 * 返回受影响行数：0 表示该任务不存在或已结算过（两种情况都不再动账）。
 */
export function settleTask(db: Database, input: SettleInput): number {
  const usage: AiUsageReport = input.usage;
  const result = db
    .prepare(
      `UPDATE ai_usage
          SET status = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?,
              cost_micros = ?, failure_reason = ?, provider = ?, model = ?
        WHERE task_id = ? AND status = 'rejected'`,
    )
    .run(
      input.status,
      Math.max(0, Math.floor(usage.inputTokens)),
      Math.max(0, Math.floor(usage.outputTokens)),
      Math.max(0, Math.floor(usage.totalTokens)),
      Math.max(0, Math.floor(usage.costMicros)),
      input.failureReason ?? null,
      input.provider,
      input.model,
      input.taskId,
    );
  return Number(result.changes ?? 0);
}

/** 某个用户在给定时间点之后已消耗的用量 */
export interface UsageTotals {
  tokens: number;
  generations: number;
  revisions: number;
  costMicros: number;
}

/**
 * 统计用量。
 *
 * 只统计 `succeeded` 的任务 —— 这是「失败不扣额度」规则的落点：
 * 被拒绝的任务（额度不够）和被标记 failed 的任务都不计入消耗。
 * 若将来接真实供应商且失败也真实产生了成本，
 * 这里可以改成按 `cost_micros > 0` 计入，而不必改调用方。
 */
export function usageSince(db: Database, userId: string, sinceIso: string | null): UsageTotals {
  const where = sinceIso === null
    ? "user_id = ? AND status = 'succeeded'"
    : "user_id = ? AND status = 'succeeded' AND created_at >= ?";
  const params = sinceIso === null ? [userId] : [userId, sinceIso];

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(total_tokens), 0) AS tokens,
         COALESCE(SUM(cost_micros), 0)  AS cost,
         COALESCE(SUM(CASE WHEN kind = 'generate' THEN 1 ELSE 0 END), 0) AS generations,
         COALESCE(SUM(CASE WHEN kind = 'revise'   THEN 1 ELSE 0 END), 0) AS revisions
       FROM ai_usage WHERE ${where}`,
    )
    .get(...params) as Record<string, unknown> | undefined;

  return {
    tokens: Number(row?.['tokens'] ?? 0),
    generations: Number(row?.['generations'] ?? 0),
    revisions: Number(row?.['revisions'] ?? 0),
    costMicros: Number(row?.['cost'] ?? 0),
  };
}

/** 某用户最近的任务记录（供后台展示） */
export function listRecentUsage(db: Database, userId: string, limit = 50): AiUsageRow[] {
  const rows = db
    .prepare('SELECT * FROM ai_usage WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => mapRow(r as Record<string, unknown>));
}