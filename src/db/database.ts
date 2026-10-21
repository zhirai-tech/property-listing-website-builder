/**
 * SQLite 连接管理。
 *
 * 使用 Node 24 内置的 node:sqlite —— 无原生编译依赖，符合方案「简单轻量」原则。
 * 全库只保留这一套数据模型（方案第六章第 3 条：不创建平行系统）。
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export type Database = DatabaseSync;

export interface OpenOptions {
  /** 是否启用 WAL（内存库与部分文件系统不支持，失败时自动降级） */
  wal?: boolean;
}

/** 打开数据库并应用必要的 PRAGMA */
export function openDatabase(file: string, options: OpenOptions = {}): Database {
  if (file !== ':memory:') {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(file);

  // 外键约束是数据一致性的基础：删除房源时媒体/提醒必须级联清理
  db.exec('PRAGMA foreign_keys = ON');
  // 并发写入时不要立刻失败
  db.exec('PRAGMA busy_timeout = 5000');

  if (options.wal !== false && file !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // exFAT 等文件系统可能不支持 WAL，降级为回滚日志即可
      db.exec('PRAGMA journal_mode = DELETE');
    }
  }

  return db;
}

/** 在一个事务中执行；抛错自动回滚（方案第六章第 5 条：失败回滚） */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚本身失败时保留原始错误，避免掩盖根因
    }
    throw error;
  }
}

/** 当前时间戳（统一使用 UTC ISO 字符串，避免本地时区导致的排序错乱） */
export function nowIso(): string {
  return new Date().toISOString();
}

/** SQLite 没有布尔类型，统一用 0/1 存储 */
export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/** 把可空文本列读成 string（NULL -> ''），避免上层到处判空 */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 把可空文本列读成 string | null */
export function asTextOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export function asInt(value: unknown, fallback = 0): number {
  const n = asNumber(value);
  return n === null ? fallback : Math.trunc(n);
}
