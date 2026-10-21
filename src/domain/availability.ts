/**
 * 可租状态推导（对外展示用）。
 *
 * 需求：展示页要能体现三种情况
 *  - **出租中**：房东确认仍可租；
 *  - **已租**：房东确认已租出；
 *  - **未确认**：房东长时间没有更新房源信息，此时页面不应继续显示「出租中」，
 *    否则会给访客错误预期 —— 系统按最后更新时间自动判定为「未确认」。
 *
 * 设计取舍：
 *  - `unconfirmed` **不允许手工设置**，只能由陈旧度推导，避免房东用它当万能挡箭牌；
 *  - 判定基准是 `updated_at`（任何一次编辑都会刷新），而不是发布时间，
 *    这样房东只要改过价格/描述就会自动回到「出租中」。
 */

import type { AvailabilityStatus, AvailabilityStatusInput } from './types.ts';

export interface AvailabilityInput {
  availabilityStatus: AvailabilityStatusInput;
  /** 最后更新时间（ISO 字符串） */
  updatedAt: string;
}

export interface AvailabilityResult {
  status: AvailabilityStatus;
  /** 距上次更新经过的天数（向下取整） */
  staleDays: number;
  /** 是否因为陈旧而被判定为未确认 */
  stale: boolean;
}

/**
 * 推导对外展示的可租状态。
 *
 * @param staleAfterDays 超过多少天未更新即视为「未确认」；设为 0 或负数表示关闭该机制
 * @param now            当前时间（由注入的 Clock 提供，便于测试）
 */
export function resolveAvailability(
  property: AvailabilityInput,
  now: Date,
  staleAfterDays: number,
): AvailabilityResult {
  const updatedAt = new Date(property.updatedAt);
  const elapsedMs = Number.isNaN(updatedAt.getTime()) ? 0 : now.getTime() - updatedAt.getTime();
  const staleDays = Math.max(0, Math.floor(elapsedMs / 86_400_000));

  // 房东明确标记「已租」时优先级最高，不再提示未确认
  if (property.availabilityStatus === 'rented') {
    return { status: 'rented', staleDays, stale: false };
  }

  if (staleAfterDays > 0 && staleDays >= staleAfterDays) {
    return { status: 'unconfirmed', staleDays, stale: true };
  }

  return { status: 'available', staleDays, stale: false };
}

/**
 * 可租状态对发布/展示的影响：
 * 「已租」与「未确认」仍然允许公开访问（页面照常打开，只是状态标签不同），
 * 但后台会提示房东尽快确认，避免误导访客。
 */
export function availabilityNeedsAttention(status: AvailabilityStatus): boolean {
  return status === 'unconfirmed';
}