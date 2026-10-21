/**
 * HTTP 安全层（方案第 8 阶段安全检查项）。
 *
 * 覆盖：
 *  - 会话令牌使用 HMAC 签名，校验用恒定时间比较，防止时序侧信道；
 *  - 登录失败次数限流，抵御暴力破解；
 *  - CSP 使用 per-request nonce，而不是 unsafe-inline；
 *  - 统一安全响应头（防嗅探、防点击劫持、限制 referrer）。
 */

import { createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// 会话令牌
// ---------------------------------------------------------------------------

export interface SessionPayload {
  /** 签发时间（毫秒） */
  iat: number;
  /** 过期时间（毫秒） */
  exp: number;
  /** 角色，便于后续扩展多用户 */
  role: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signPayload(secret: string, payload: object): string {
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** 恒定时间字符串比较，长度不同也保持恒定时间 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  // 先对齐长度，再比较，避免长度差异泄漏信息
  const length = Math.max(bufferA.length, bufferB.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  bufferA.copy(paddedA);
  bufferB.copy(paddedB);

  return nodeTimingSafeEqual(paddedA, paddedB) && bufferA.length === bufferB.length;
}

export function createSessionToken(secret: string, ttlMs: number, now: Date): string {
  const payload: SessionPayload = {
    iat: now.getTime(),
    exp: now.getTime() + ttlMs,
    role: 'admin',
  };
  return signPayload(secret, payload);
}

export function verifySessionToken(secret: string, token: string, now: Date): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  if (!timingSafeEqual(signature, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || payload.exp <= now.getTime()) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// CSP nonce
// ---------------------------------------------------------------------------

export function createNonce(): string {
  return randomBytes(16).toString('base64');
}

export interface CspOptions {
  nonce?: string;
  /** 允许加载的地图瓦片与脚本来源 */
  allowExternalScripts?: boolean;
  /**
   * 是否允许内联 style 属性。
   * Leaflet 通过 style 属性定位瓦片与标记，无法避免；
   * 注意：style-src 一旦出现 nonce，浏览器会忽略 unsafe-inline，
   * 因此开启时必须同时去掉 style-src 上的 nonce。script-src 始终保留 nonce。
   */
  allowInlineStyles?: boolean;
}

/**
 * 内容安全策略。
 * 内联样式与脚本一律使用 nonce，因此不需要 unsafe-inline。
 */
export function contentSecurityPolicy(options: CspOptions = {}): string {
  const nonce = options.nonce;
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}'` : "'self'";

  const styleSrc = options.allowInlineStyles
    ? "'self' 'unsafe-inline'"
    : nonce
      ? `'self' 'nonce-${nonce}'`
      : "'self'";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** 通用安全响应头 */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

// ---------------------------------------------------------------------------
// 登录限流
// ---------------------------------------------------------------------------

export interface RateLimitState {
  attempts: number;
  windowStart: number;
  blockedUntil: number;
}

export interface RateLimiterOptions {
  /** 单键（单个 IP）窗口内允许的失败次数 */
  maxAttempts?: number;
  windowMs?: number;
  blockMs?: number;
  /**
   * **全局**窗口内允许的失败总次数。
   *
   * 【为什么需要它】单键限流依赖「键是可信的」。
   * 但审计发现：`trustProxy: true` + 用 `request.ip` 做键，
   * 等于把键交给客户端 —— 轮换 `X-Forwarded-For` 就能无限尝试。
   * 全局计数不依赖任何客户端输入，因此轮换 IP 也会被挡住。
   *
   * 默认值刻意比单键宽松得多：正常使用撞不到，
   * 但脚本化的爆破会在几十次内被拦。
   */
  globalMaxAttempts?: number;
  globalWindowMs?: number;
}

export class LoginRateLimiter {
  private readonly state = new Map<string, RateLimitState>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly globalMaxAttempts: number;
  private readonly globalWindowMs: number;

  /** 全局失败计数（不分键） */
  private globalAttempts = 0;
  private globalWindowStart = 0;
  private globalBlockedUntil = 0;
  /** 上次清理时间，用于把 prune 摊到每次 check 上 */
  private lastPruneAt = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.blockMs = options.blockMs ?? 15 * 60 * 1000;
    this.globalMaxAttempts = options.globalMaxAttempts ?? 60;
    this.globalWindowMs = options.globalWindowMs ?? 15 * 60 * 1000;
  }

  /** 返回是否允许尝试以及剩余等待时间 */
  check(key: string, now: Date): { allowed: boolean; retryAfterMs: number } {
    // 顺手清理过期键：原先 prune() 从不被调用，
    // state 这个 Map 只增不减，长时间运行会无限增长。
    // 放在这里做是「摊还」——每次 check 最多扫一遍，不需要单独的定时器。
    if (now.getTime() - this.lastPruneAt > Math.min(this.windowMs, 60_000)) {
      this.prune(now);
      this.lastPruneAt = now.getTime();
    }

    // 全局封禁优先：它不依赖客户端提供的任何信息
    if (this.globalBlockedUntil > now.getTime()) {
      return { allowed: false, retryAfterMs: this.globalBlockedUntil - now.getTime() };
    }

    const entry = this.state.get(key);
    if (!entry) return { allowed: true, retryAfterMs: 0 };

    if (entry.blockedUntil > now.getTime()) {
      return { allowed: false, retryAfterMs: entry.blockedUntil - now.getTime() };
    }

    // 窗口过期则重置
    if (now.getTime() - entry.windowStart > this.windowMs) {
      this.state.delete(key);
      return { allowed: true, retryAfterMs: 0 };
    }

    return { allowed: true, retryAfterMs: 0 };
  }

  /** 记录一次失败；达到上限后进入封禁窗口 */
  recordFailure(key: string, now: Date): void {
    // ---- 全局计数 ----
    if (now.getTime() - this.globalWindowStart > this.globalWindowMs) {
      this.globalAttempts = 0;
      this.globalWindowStart = now.getTime();
    }
    this.globalAttempts += 1;
    if (this.globalAttempts >= this.globalMaxAttempts) {
      this.globalBlockedUntil = now.getTime() + this.blockMs;
      this.globalAttempts = 0;
      this.globalWindowStart = now.getTime();
    }

    // ---- 单键计数 ----
    const entry = this.state.get(key) ?? { attempts: 0, windowStart: now.getTime(), blockedUntil: 0 };

    if (now.getTime() - entry.windowStart > this.windowMs) {
      entry.attempts = 0;
      entry.windowStart = now.getTime();
    }

    entry.attempts += 1;
    if (entry.attempts >= this.maxAttempts) {
      entry.blockedUntil = now.getTime() + this.blockMs;
      entry.attempts = 0;
      entry.windowStart = now.getTime();
    }

    this.state.set(key, entry);
  }

  recordSuccess(key: string): void {
    this.state.delete(key);
  }

  /** 仅供测试与诊断：当前是否处于全局封禁 */
  isGloballyBlocked(now: Date): boolean {
    return this.globalBlockedUntil > now.getTime();
  }

  /** 当前跟踪的键数量（诊断用；用于验证 prune 确实生效） */
  trackedKeys(): number {
    return this.state.size;
  }

  /** 定期清理，避免内存无限增长 */
  prune(now: Date): void {
    for (const [key, entry] of this.state) {
      const expired =
        entry.blockedUntil < now.getTime() && now.getTime() - entry.windowStart > this.windowMs;
      if (expired) this.state.delete(key);
    }
  }

  get size(): number {
    return this.state.size;
  }
}