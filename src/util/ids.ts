/**
 * 标识符生成。
 * 使用带前缀的 UUID，便于日志与数据库中一眼分辨实体类型。
 */

import { randomUUID } from 'node:crypto';

const PREFIXES = {
  user: 'usr',
  workspace: 'wsp',
  property: 'prp',
  translation: 'trn',
  contact: 'cnt',
  media: 'med',
  listingPage: 'lpg',
  reminder: 'rmd',
  externalService: 'ext',
  audit: 'aud',
} as const;

export type IdKind = keyof typeof PREFIXES;

/** 生成 <prefix>_<uuid> 形式的标识符 */
export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${randomUUID()}`;
}

/** 生成 URL 安全的随机令牌（用于域名验证、会话等） */
export function newToken(bytes = 24): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString('base64url');
}

/** 断言一个字符串看起来像某类实体 ID（用于路由参数快速失败） */
export function isIdOf(kind: IdKind, value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${PREFIXES[kind]}_`);
}
