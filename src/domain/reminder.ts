/**
 * 提醒领域规则（方案第三章第 9 条、第 7 阶段验收）。
 *
 * 规则：发布后第 7 天提醒检查房源，第 15 天提醒确认或更新。
 * 要求：
 *  - 提醒规则、时区、通知方式可配置；
 *  - 允许用户关闭或标记完成；
 *  - 可安全重试，且不会重复轰炸用户；
 *  - 必须能用「可控测试时间」验证，不能真实等待 7/15 天。
 */

import { addZonedDays, formatZoned, toZonedParts, zonedHourOfDay } from '../util/time.ts';
import type { Reminder, ReminderKind, ReminderStatus } from './types.ts';

export interface ReminderRuleConfig {
  /** 第一次提醒的相对天数，默认 7 */
  day1: number;
  /** 第二次提醒的相对天数，默认 15 */
  day2: number;
  /** 默认时区 */
  timezone: string;
  /** 单个提醒允许的最大尝试次数 */
  maxAttempts: number;
  /** 允许发送的当地时段（含起、不含止），默认 09:00–20:00 */
  sendWindowStartHour: number;
  sendWindowEndHour: number;
}

export const DEFAULT_REMINDER_CONFIG: ReminderRuleConfig = {
  day1: 7,
  day2: 15,
  timezone: 'UTC',
  maxAttempts: 3,
  sendWindowStartHour: 9,
  sendWindowEndHour: 20,
};

export const REMINDER_LABELS: Record<ReminderKind, string> = {
  check_day_7: '发布后第 7 天：检查房源',
  confirm_day_15: '发布后第 15 天：确认或更新',
};

const REMINDER_KIND_FOR_SLOT: readonly ReminderKind[] = ['check_day_7', 'confirm_day_15'];

/**
 * 依据发布时间与配置生成提醒计划。
 * 提醒时刻固定在目标时区的 sendWindowStartHour 点，避免凌晨打扰。
 */
export function buildReminderPlan(
  publishedAt: Date,
  config: ReminderRuleConfig,
): { kind: ReminderKind; dueAt: Date }[] {
  const offsets = [config.day1, config.day2];

  return offsets.map((offsetDays, index) => {
    const shifted = addZonedDays(publishedAt, offsetDays, config.timezone);
    const dueAt = zonedHourOfDay(shifted, config.timezone, config.sendWindowStartHour);
    return { kind: REMINDER_KIND_FOR_SLOT[index] as ReminderKind, dueAt };
  });
}

/**
 * 幂等键：同一房源 + 同一提醒类型最多一条记录。
 * 重新发布时重置既有记录而不是新建，因此用户不会收到重复提醒。
 */
export function reminderIdempotencyKey(propertyId: string, kind: ReminderKind): string {
  return `${propertyId}:${kind}`;
}

/** 到点且处于待发送状态 */
export function isReminderDue(reminder: Pick<Reminder, 'status' | 'dueAt'>, now: Date): boolean {
  if (reminder.status !== 'pending') return false;
  return new Date(reminder.dueAt).getTime() <= now.getTime();
}

/** 是否还能继续重试 */
export function canRetry(
  reminder: Pick<Reminder, 'attempts' | 'status'>,
  maxAttempts: number,
): boolean {
  if (reminder.status === 'completed' || reminder.status === 'skipped') return false;
  return reminder.attempts < maxAttempts;
}

/** 指数退避：1 分钟 -> 2 -> 4 -> ... 最多 6 小时 */
export function retryDelayMs(attempts: number): number {
  const base = 60_000;
  const capped = Math.min(base * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
  return capped;
}

/** 下一次可重试的时间点 */
export function nextRetryAt(reminder: Pick<Reminder, 'lastAttemptAt' | 'attempts'>): Date | null {
  if (!reminder.lastAttemptAt) return null;
  return new Date(new Date(reminder.lastAttemptAt).getTime() + retryDelayMs(reminder.attempts));
}

/**
 * 判断当前是否处于允许发送的当地时段。
 * 用于避免深夜给用户发提醒（方案第八章第 6 条：避免重复轰炸）。
 */
export function withinSendWindow(now: Date, config: ReminderRuleConfig): boolean {
  const { hour } = toZonedParts(now, config.timezone);
  if (config.sendWindowStartHour === config.sendWindowEndHour) return true;
  if (config.sendWindowStartHour < config.sendWindowEndHour) {
    return hour >= config.sendWindowStartHour && hour < config.sendWindowEndHour;
  }
  // 跨午夜时段
  return hour >= config.sendWindowStartHour || hour < config.sendWindowEndHour;
}

/**
 * 决定一条到期提醒本次应如何处理。
 * 返回 'send' | 'retry-later' | 'give-up' | 'skip'
 */
export function decideDispatch(
  reminder: Pick<Reminder, 'status' | 'dueAt' | 'attempts' | 'lastAttemptAt'>,
  now: Date,
  config: ReminderRuleConfig,
): 'send' | 'retry-later' | 'give-up' | 'skip' {
  if (reminder.status === 'completed' || reminder.status === 'skipped') return 'skip';
  if (!isReminderDue(reminder, now)) return 'skip';

  if (!withinSendWindow(now, config)) return 'retry-later';

  if (reminder.attempts >= config.maxAttempts) return 'give-up';

  if (reminder.lastAttemptAt && reminder.attempts > 0) {
    const next = nextRetryAt(reminder);
    if (next && now.getTime() < next.getTime()) return 'retry-later';
  }

  return 'send';
}

/** 供后台展示的提醒摘要 */
export function describeReminder(reminder: Reminder, locale: string): string {
  const label = REMINDER_LABELS[reminder.kind];
  const when = formatZoned(new Date(reminder.dueAt), reminder.timezone, locale);
  return `${label}（计划：${when}，状态：${reminderStatusLabel(reminder.status)}）`;
}

export function reminderStatusLabel(status: ReminderStatus): string {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'completed':
      return '已完成';
    case 'skipped':
      return '已关闭';
    case 'failed':
      return '发送失败';
    default:
      return status;
  }
}
