/**
 * 存储适配器（方案第四章第 7 条：存储为可替换适配器）。
 *
 * 安全要点：storage key 全部来自内部生成，但公开 URL 可能被外部构造，
 * 因此读取路径必须做严格的白名单校验，杜绝目录穿越。
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

export interface StoredObject {
  key: string;
  byteSize: number;
}

export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Uint8Array): Promise<StoredObject>;
  read(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number | null>;
  /** 供展示页引用的 URL（相对或绝对） */
  publicUrl(key: string): string;
}

/** 拒绝绝对路径、盘符、.. 与空段 */
export function assertSafeKey(key: string): string {
  const normalizedKey = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalizedKey === '') throw new Error('storage key 不能为空');
  if (/^[a-zA-Z]:/.test(normalizedKey)) throw new Error(`storage key 不允许包含盘符：${key}`);

  const parts = normalizedKey.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      throw new Error(`storage key 含非法路径段：${key}`);
    }
    if (part.includes('\0')) throw new Error('storage key 含非法字符');
  }
  return parts.join('/');
}

/** 把 key 挂到根目录下，并复核结果确实位于根目录内 */
export function resolveKeyPath(rootDir: string, key: string): string {
  const safe = assertSafeKey(key);
  const root = resolve(rootDir);
  const full = resolve(root, normalize(safe).split(sep).join('/'));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`storage key 越出存储根目录：${key}`);
  }
  return full;
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly rootDir: string;
  /** 公开 URL 前缀 */
  private readonly urlPrefix: string;

  constructor(options: { rootDir: string; urlPrefix?: string }) {
    this.rootDir = options.rootDir;
    this.urlPrefix = (options.urlPrefix ?? '/media').replace(/\/+$/g, '');
  }

  async put(key: string, data: Uint8Array): Promise<StoredObject> {
    const full = resolveKeyPath(this.rootDir, key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    return { key, byteSize: data.byteLength };
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      const full = resolveKeyPath(this.rootDir, key);
      const buffer = await readFile(full);
      return new Uint8Array(buffer);
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      const full = resolveKeyPath(this.rootDir, key);
      await rm(full, { force: true });
    } catch {
      // 删除失败不应影响主流程（文件可能已不存在）
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.size(key)) !== null;
  }

  async size(key: string): Promise<number | null> {
    try {
      const full = resolveKeyPath(this.rootDir, key);
      const info = await stat(full);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }

  publicUrl(key: string): string {
    const safe = assertSafeKey(key);
    return `${this.urlPrefix}/${safe.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** 供备份服务使用的实际根目录 */
  get baseDir(): string {
    return this.rootDir;
  }
}

/** 仅用于测试：把对象保存在内存中 */
export class MemoryStorageProvider implements StorageProvider {
  readonly name = 'memory';
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<StoredObject> {
    const safe = assertSafeKey(key);
    this.objects.set(safe, data);
    return { key: safe, byteSize: data.byteLength };
  }

  async read(key: string): Promise<Uint8Array | null> {
    return this.objects.get(assertSafeKey(key)) ?? null;
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(assertSafeKey(key));
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(assertSafeKey(key));
  }

  async size(key: string): Promise<number | null> {
    return this.objects.get(assertSafeKey(key))?.byteLength ?? null;
  }

  publicUrl(key: string): string {
    return `/media/${assertSafeKey(key)}`;
  }

  get count(): number {
    return this.objects.size;
  }
}
