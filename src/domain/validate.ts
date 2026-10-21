/**
 * 可复用的字段校验器。
 *
 * 设计目标：
 *  - 一次性收集全部字段问题再统一抛错，避免用户「改一个报一个」；
 *  - 所有提示均为面向用户的中文，且带字段路径，前端可直接定位到输入框；
 *  - 输入一律先按「未知」处理并做类型收敛，不信任来自 HTTP 的任何内容。
 */

import { validationFailed, type FieldIssue } from './errors.ts';

export interface StrOptions {
  required?: boolean;
  min?: number;
  max?: number;
  /** 允许的取值集合（不区分大小写比较后再收敛为小写） */
  oneOf?: readonly string[];
}

export interface NumOptions {
  min?: number;
  max?: number;
  /** 是否允许小数，默认允许 */
  integer?: boolean;
  required?: boolean;
}

/**
 * 校验过程容器：累积 issue，最后通过 done() 统一抛出 DomainError。
 */
export class Validator {
  readonly issues: FieldIssue[] = [];

  private fail(field: string, message: string): void {
    this.issues.push({ field, message });
  }

  /** 把未知输入收敛为字符串（数字会被转成字符串，null/undefined 视为空） */
  private coerceString(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw === 'boolean') return String(raw);
    return null;
  }

  /** 通用字符串字段 */
  str(raw: unknown, field: string, label: string, opts: StrOptions = {}): string {
    const { required = false, min = 0, max = 500, oneOf } = opts;
    const coerced = this.coerceString(raw);

    if (coerced === null || coerced.trim() === '') {
      if (required) this.fail(field, `${label}不能为空`);
      return '';
    }

    // 规范化：去除首尾空白，把连续空白折叠为单个空格（描述类字段由调用方另行处理换行）
    let value = coerced.trim().replace(/[ \t\u3000]+/g, ' ');

    if (value.length < min) this.fail(field, `${label}至少需要 ${min} 个字符`);

    if (value.length > max) {
      this.fail(field, `${label}最多 ${max} 个字符，当前 ${value.length} 个`);
      value = value.slice(0, max);
    }

    if (oneOf && value !== '') {
      const lowered = value.toLowerCase();
      if (!oneOf.includes(lowered)) {
        this.fail(field, `${label}取值不合法，可选：${oneOf.join(' / ')}`);
        return '';
      }
      return lowered;
    }

    return value;
  }

  /** 多行文本：保留换行，仅规范化行尾与首尾空白 */
  text(raw: unknown, field: string, label: string, opts: { max?: number } = {}): string {
    const { max = 20000 } = opts;
    const coerced = this.coerceString(raw);
    if (coerced === null) return '';

    const value = coerced.replace(/\r\n?/g, '\n').trim();
    if (value.length > max) {
      this.fail(field, `${label}最多 ${max} 个字符，当前 ${value.length} 个`);
      return value.slice(0, max);
    }
    return value;
  }

  /** 数字字段，空值返回 null */
  num(raw: unknown, field: string, label: string, opts: NumOptions = {}): number | null {
    const { min, max, integer = false, required = false } = opts;

    if (raw === null || raw === undefined || raw === '') {
      if (required) this.fail(field, `${label}不能为空`);
      return null;
    }

    const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());

    if (!Number.isFinite(parsed)) {
      this.fail(field, `${label}必须是数字`);
      return null;
    }
    if (integer && !Number.isInteger(parsed)) {
      this.fail(field, `${label}必须是整数`);
      return null;
    }
    if (min !== undefined && parsed < min) {
      this.fail(field, `${label}不能小于 ${min}`);
      return null;
    }
    if (max !== undefined && parsed > max) {
      this.fail(field, `${label}不能大于 ${max}`);
      return null;
    }
    return parsed;
  }

  /** 布尔字段：接受 true/false、"true"/"false"、1/0、on/off */
  bool(raw: unknown, field: string, label: string, fallback = false): boolean {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    if (typeof raw === 'string') {
      const v = raw.trim().toLowerCase();
      if (['true', '1', 'on', 'yes', 'y'].includes(v)) return true;
      if (['false', '0', 'off', 'no', 'n', ''].includes(v)) return false;
    }
    if (raw === null || raw === undefined) return fallback;
    this.fail(field, `${label}必须是布尔值`);
    return fallback;
  }

  /** 从固定集合中取值 */
  enumOf<T extends string>(
    raw: unknown,
    field: string,
    label: string,
    allowed: readonly T[],
    fallback: T,
  ): T {
    const coerced = this.coerceString(raw);
    if (coerced === null || coerced.trim() === '') return fallback;
    const value = coerced.trim().toLowerCase() as T;
    if (!allowed.includes(value)) {
      this.fail(field, `${label}取值不合法，可选：${allowed.join(' / ')}`);
      return fallback;
    }
    return value;
  }

  /** ISO 4217 三位货币代码，统一转大写 */
  currency(raw: unknown, field: string, label: string, fallback: string): string {
    const coerced = this.coerceString(raw);
    if (coerced === null || coerced.trim() === '') return fallback;
    const value = coerced.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(value)) {
      this.fail(field, `${label}需为 3 位字母货币代码，例如 CNY / USD / EUR`);
      return fallback;
    }
    return value;
  }

  /** ISO 3166-1 alpha-2 国家代码，允许留空 */
  countryCode(raw: unknown, field: string, label: string): string {
    const coerced = this.coerceString(raw);
    if (coerced === null || coerced.trim() === '') return '';
    const value = coerced.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(value)) {
      this.fail(field, `${label}需为 2 位字母国家代码，例如 CN / US / JP`);
      return '';
    }
    return value;
  }

  /** ISO 日期（YYYY-MM-DD）；空值返回 null */
  isoDate(raw: unknown, field: string, label: string): string | null {
    const coerced = this.coerceString(raw);
    if (coerced === null || coerced.trim() === '') return null;

    const value = coerced.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      this.fail(field, `${label}格式应为 YYYY-MM-DD`);
      return null;
    }

    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(y, m - 1, d));
    const valid =
      probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
    if (!valid) {
      this.fail(field, `${label}不是有效日期`);
      return null;
    }
    return value;
  }

  /** 带时区的 IANA 时区名 */
  timezone(raw: unknown, field: string, label: string, fallback: string): string {
    const coerced = this.coerceString(raw);
    if (coerced === null || coerced.trim() === '') return fallback;
    const value = coerced.trim();
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return value;
    } catch {
      this.fail(field, `${label}不是有效的 IANA 时区，例如 Asia/Shanghai`);
      return fallback;
    }
  }

  /** 语言标签，例如 zh-CN / en / ja */
  locale(raw: unknown, field: string, label: string, fallback: string): string {
    const coerced = this.coerceString(raw);
    if (coerced === null || coerced.trim() === '') return fallback;
    const value = coerced.trim();
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
      this.fail(field, `${label}格式应为语言标签，例如 zh-CN 或 en`);
      return fallback;
    }
    // 规范化为 BCP 47 常见写法：语言小写、地区大写
    const parts = value.split('-');
    const head = (parts[0] ?? '').toLowerCase();
    const rest = parts.slice(1).map((p) => (p.length === 2 ? p.toUpperCase() : p));
    return [head, ...rest].join('-');
  }

  /** 判断某个字段是否被显式提供（用于 PATCH 语义） */
  has(raw: Record<string, unknown>, field: string): boolean {
    return Object.hasOwn(raw, field);
  }

  /** 如果有 issue 则抛出统一的 DomainError */
  done(message = '输入内容有误，请检查后重试'): void {
    if (this.issues.length > 0) throw validationFailed(this.issues, message);
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}
