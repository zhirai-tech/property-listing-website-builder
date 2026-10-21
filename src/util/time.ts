/**
 * 时区感知的时间工具。
 *
 * 方案第三章第 9 条要求提醒规则「时区可配置」，第 7 阶段的验收要求
 * 「用可控测试时间验证规则，不需要真实等待 7/15 天」。为了同时满足这两点，
 * 这里实现不依赖第三方库的 IANA 时区换算：
 *   - 既能把某一瞬间转换到目标时区的日历字段；
 *   - 也能把目标时区的「墙上时间」反向换算回瞬间（含夏令时二次修正）。
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(timeZone, fmt);
  }
  return fmt;
}

/** 断言时区合法，非法时抛出可读错误 */
export function assertTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    throw new Error(`无效的 IANA 时区：${timeZone}`);
  }
}

/** 把某一瞬间转换为目标时区的日历字段 */
export function toZonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // Intl 在 hour12:false 下可能返回 24 表示午夜，统一归零
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** 目标时区在某一瞬间的 UTC 偏移（毫秒） */
function offsetMsAt(instant: Date, timeZone: string): number {
  const p = toZonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // 去掉毫秒后再比较，避免 Intl 的秒级精度造成抖动
  const base = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - base;
}

/**
 * 把目标时区的墙上时间换算回瞬间。
 * 采用「先估算偏移、再用估算结果二次校正」的方式处理夏令时切换。
 */
export function fromZonedParts(parts: ZonedParts, timeZone: string): Date {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  const guess = new Date(asUtc);
  const firstOffset = offsetMsAt(guess, timeZone);
  const refined = new Date(asUtc - firstOffset);

  const secondOffset = offsetMsAt(refined, timeZone);
  if (secondOffset !== firstOffset) {
    return new Date(asUtc - secondOffset);
  }
  return refined;
}

/** 在目标时区的日历上增加天数，保持当地时刻不变（正确处理夏令时） */
export function addZonedDays(instant: Date, days: number, timeZone: string): Date {
  const p = toZonedParts(instant, timeZone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return fromZonedParts(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: p.hour,
      minute: p.minute,
      second: p.second,
    },
    timeZone,
  );
}

/** 目标时区当天 00:00 对应的瞬间 */
export function startOfZonedDay(instant: Date, timeZone: string): Date {
  const p = toZonedParts(instant, timeZone);
  return fromZonedParts({ ...p, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** 目标时区当天 09:00 对应的瞬间 —— 提醒默认在上午发出，避免打扰 */
export function zonedHourOfDay(instant: Date, timeZone: string, hour: number): Date {
  const p = toZonedParts(instant, timeZone);
  return fromZonedParts({ ...p, hour, minute: 0, second: 0 }, timeZone);
}

/** 按目标时区格式化日期时间，用于展示与日志 */
export function formatZoned(
  instant: Date,
  timeZone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(instant);
}
