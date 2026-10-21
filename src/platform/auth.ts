/**
 * 平台用户认证。
 *
 * 【与会话机制的关系 —— 这是本文件最重要的设计决定】
 *
 * 审计阶段发现：现有的 `createSessionToken()` **把 role 硬编码成 'admin'**，
 * 而 `verifySessionToken()` **只校验 HMAC 与过期时间、完全不读 payload.role`。
 * 也就是说：**任何能通过后台会话校验的令牌，都等价于管理员。**
 *
 * 因此平台用户会话**绝不能复用后台的密钥与 Cookie**，否则
 * 「注册一个账号」就等于「拿到管理员权限」。
 *
 * 本文件用两道物理隔离：
 *   1. **域分离密钥**：平台密钥 = HMAC(sessionSecret, 'zhirai-platform-user-session-v1')。
 *      即使两个令牌格式相同，用一个密钥签的令牌在另一个密钥下也验不过。
 *   2. **不同 Cookie 名**：后台读 `admin_session`，平台读 `platform_session`。
 *      守卫各读各的，不存在「同一个 Cookie 被两边都接受」的可能。
 *
 * 另外，平台会话的 payload 里 `role` 恒为 `'user'`，并且**校验时会真的检查它**
 * （不重复后台那个「签了 role 却从不读 role」的毛病）。
 */

import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import { DEFAULT_TIER } from './config.ts';

/** 平台会话 Cookie 名 —— 与后台的 admin_session 区分开 */
export const PLATFORM_COOKIE = 'platform_session';

/** 平台会话有效期：7 天（比后台的 12 小时长，因为是终端用户） */
export const PLATFORM_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 域分离标签：换掉这个字符串等于让所有存量平台会话失效 */
const PLATFORM_SESSION_DOMAIN = 'zhirai-platform-user-session-v1';

/**
 * 从主密钥派生平台会话专用密钥。
 * 关键：**不是直接用 sessionSecret** —— 直接复用会让平台令牌在后台守卫下也有效。
 */
export function platformSessionSecret(masterSecret: string): string {
  return createHmac('sha256', masterSecret).update(PLATFORM_SESSION_DOMAIN).digest('hex');
}

// ---------------------------------------------------------------------------
// 口令哈希
// ---------------------------------------------------------------------------

// scrypt 参数。N=16384, r=8, p=1 需要 128*N*r = 16MB 内存，
// 因此 maxmem 必须显式给足，否则 Node 会抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** 口令哈希格式：scrypt$N$r$p$salt$hash（全部 base64url） */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/**
 * 校验口令。
 *
 * 用**恒定时间比较**，且任何格式异常都返回 false 而不是抛错 ——
 * 否则「哈希格式不对」会变成一个可探测的信号。
 */
export function verifyPassword(plain: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

export interface PlatformUser {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  tier: string;
  status: string;
  memberUntil: string | null;
  sessionVersion: number;
}

function mapUser(raw: Record<string, unknown>): PlatformUser {
  return {
    id: String(raw['id']),
    workspaceId: String(raw['workspace_id']),
    email: String(raw['email']),
    displayName: String(raw['display_name']),
    tier: String(raw['tier'] ?? DEFAULT_TIER),
    status: String(raw['status'] ?? 'active'),
    memberUntil: raw['member_until'] === null || raw['member_until'] === undefined ? null : String(raw['member_until']),
    sessionVersion: Number(raw['session_version'] ?? 1),
  };
}

export function findUserByEmail(db: Database, email: string): PlatformUser | null {
  const row = db
    .prepare('SELECT * FROM users WHERE email = ? AND is_system = 0')
    .get(email.trim().toLowerCase());
  return row ? mapUser(row as Record<string, unknown>) : null;
}

export function findUserById(db: Database, id: string): PlatformUser | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ? AND is_system = 0').get(id);
  return row ? mapUser(row as Record<string, unknown>) : null;
}

/** 邮箱格式（够用即可，不追求 RFC 完备） */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 口令最短长度 —— 平台用户是终端用户，比后台口令要求更明确 */
export const MIN_PASSWORD_LENGTH = 8;

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  /**
   * 平台用户**不再共享**遗留工作区。
   *
   * 【为什么】现有 `properties` 只按 `workspace_id` 归属，没有 per-user 列。
   * 如果多个平台用户共用同一个工作区，就会出现「A 建的房源 B 也能看到」——
   * 用户明确要求「用户是否可以通过修改项目 ID 访问其他用户的项目」必须为否。
   * 复用现有的 `workspaces.owner_user_id` 模型，给每个用户建自己的工作区，
   * 隔离就落在数据层，而不是靠应用层记得加过滤条件。
   *
   * 遗留工作区与其既有房源**完全不受影响**（仍归系统账号）。
   */
  workspaceId?: string;
}

export type RegisterResult =
  | { ok: true; user: PlatformUser }
  | { ok: false; code: 'invalid_email' | 'weak_password' | 'email_taken' | 'invalid_name'; message: string };

/**
 * 注册平台用户。
 *
 * 注意 `is_system = 0`：迁移时把既有用户标成了系统账号，
 * 它们没有口令、不应出现在平台用户里。这里新建的用户才是真正的平台用户。
 */
export function registerUser(db: Database, input: RegisterInput, nowIsoStr = nowIso()): RegisterResult {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, code: 'invalid_email', message: '请输入有效的邮箱地址' };
  }
  if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: 'weak_password', message: `口令至少 ${MIN_PASSWORD_LENGTH} 位` };
  }
  const displayName = input.displayName.trim();
  if (displayName === '' || displayName.length > 60) {
    return { ok: false, code: 'invalid_name', message: '昵称必填且不超过 60 字' };
  }
  if (findUserByEmail(db, email)) {
    return { ok: false, code: 'email_taken', message: '该邮箱已注册' };
  }

  const userId = `usr_${randomUUID()}`;
  const workspaceId = input.workspaceId ?? `wsp_${randomUUID()}`;

  // 平台用户使用自己的工作区：房源、媒体、联系方式都按 workspace_id 隔离，
  // 这样「用户只能看到自己的数据」是数据层保证，而不是靠查询里记得加条件。
  db.prepare(
    `INSERT INTO workspaces
       (id, name, owner_user_id, default_locale, default_currency, default_area_unit,
        default_timezone, hosting_provider, created_at, updated_at)
     VALUES (?, ?, ?, 'zh-CN', 'CNY', 'square_meter', 'Asia/Shanghai', 'default', ?, ?)`,
  ).run(workspaceId, `${displayName}的工作区`, userId, nowIsoStr, nowIsoStr);

  db.prepare(
    `INSERT INTO users
       (id, workspace_id, email, display_name, role, password_hash, status, tier, member_until,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'member', ?, 'active', ?, NULL, ?, ?)`,
  ).run(userId, workspaceId, email, displayName, hashPassword(input.password), DEFAULT_TIER, nowIsoStr, nowIsoStr);

  const created = findUserById(db, userId);
  if (!created) throw new Error('注册后无法读回用户');
  return { ok: true, user: created };
}

export type LoginResult =
  | { ok: true; user: PlatformUser }
  | { ok: false; code: 'invalid_credentials' | 'account_disabled'; message: string };

/**
 * 登录校验。
 *
 * 邮箱不存在与口令错误返回**同一个**错误码与文案 ——
 * 否则可以拿它当「这个邮箱注册过没有」的探测器。
 */
export function authenticateUser(db: Database, email: string, password: string): LoginResult {
  const row = db
    .prepare('SELECT * FROM users WHERE email = ? AND is_system = 0')
    .get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;

  if (!row) {
    // 仍然走一次哈希，避免「存在的邮箱耗时更长」这种时间侧信道
    verifyPassword(password, null);
    return { ok: false, code: 'invalid_credentials', message: '邮箱或口令不正确' };
  }

  const user = mapUser(row);
  if (!verifyPassword(password, row['password_hash'] === null ? null : String(row['password_hash']))) {
    return { ok: false, code: 'invalid_credentials', message: '邮箱或口令不正确' };
  }
  if (user.status !== 'active') {
    return { ok: false, code: 'account_disabled', message: '账号已被停用，请联系管理员' };
  }
  return { ok: true, user };
}

// ---------------------------------------------------------------------------
// 会话令牌
// ---------------------------------------------------------------------------

interface PlatformSessionPayload {
  sub: string;
  role: 'user';
  /** 会话版本号：与 users.session_version 不等即视为已吊销 */
  sv: number;
  iat: number;
  exp: number;
  jti: string;
}

/** 给平台用户签发会话令牌（用**域分离后的**密钥） */
export function createUserSession(
  masterSecret: string,
  userId: string,
  sessionVersion: number,
  ttlMs: number,
  now: Date,
): string {
  const payload: PlatformSessionPayload = {
    sub: userId,
    role: 'user',
    sv: sessionVersion,
    iat: now.getTime(),
    exp: now.getTime() + ttlMs,
    jti: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', platformSessionSecret(masterSecret)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * 校验平台会话。
 *
 * 与后台那个版本的**关键区别**：这里会检查 `role === 'user'`。
 * 后台版本签了 role 却从不读，等于把 role 当装饰；
 * 平台这边不重复那个错误。
 */
export function verifyUserSession(
  masterSecret: string,
  token: string | undefined,
  now: Date,
): PlatformSessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', platformSessionSecret(masterSecret)).update(body).digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  let payload: PlatformSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PlatformSessionPayload;
  } catch {
    return null;
  }

  if (payload.role !== 'user') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now.getTime()) return null;
  if (typeof payload.sub !== 'string' || payload.sub === '') return null;
  if (typeof payload.sv !== 'number' || !Number.isInteger(payload.sv)) return null;
  return payload;
}

/**
 * 让某个用户的**全部**已签发会话立即失效。
 * 登出、改口令、管理员停用账号时都应调用它。
 */
export function revokeUserSessions(db: Database, userId: string, at: string = nowIso()): void {
  db.prepare('UPDATE users SET session_version = session_version + 1, updated_at = ? WHERE id = ?').run(at, userId);
}