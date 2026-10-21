/**
 * 备份与恢复服务（方案第 8 阶段验收：备份能够恢复）。
 *
 * 实现要点：
 *  - 使用 SQLite 的 VACUUM INTO 生成一致性快照（运行中也能安全备份）；
 *  - 一并打包上传的媒体文件，保证「素材不丢」；
 *  - 附带 manifest（表行数、文件数），恢复时可据此逐项校验；
 *  - 恢复演练在独立目录进行，不影响正在运行的数据，并可重复执行。
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { AppContext } from '../app-context.ts';
import { openDatabase } from '../db/database.ts';
import { unprocessable } from '../domain/errors.ts';
import { createZip, type ZipEntry } from '../util/zip.ts';
import { readZip } from '../util/unzip.ts';
import { recordAudit } from './audit-service.ts';

/** 备份需要覆盖的业务表 */
export const BACKUP_TABLES = [
  'workspaces',
  'users',
  'properties',
  'property_translations',
  'contacts',
  'media',
  'listing_pages',
  'reminders',
  'external_service_configs',
  'audit_logs',
] as const;

export interface BackupManifest {
  createdAt: string;
  databaseFile: string;
  tables: Record<string, number>;
  mediaFiles: number;
  note: string;
}

export interface BackupResult {
  file: string;
  bytes: number;
  manifest: BackupManifest;
}

function escapeSqlPath(path: string): string {
  return path.replace(/'/g, "''");
}

/**
 * 备份文件名中编码时间戳。
 *
 * 之所以不依赖文件系统 mtime：mtime 是真实时间，而「当前时间」来自注入的 Clock，
 * 两者在演示/测试环境（可控时钟）下会不一致，导致保留策略算错。
 * 这里把时间戳写进文件名，列出与清理都以它为准，行为可预测、可测试。
 */
export function backupFileName(at: Date): string {
  return `backup-${at.toISOString().replace(/[-:.]/g, '')}.zip`;
}

/** 从文件名解析备份时间；无法解析时返回 null */
export function parseBackupTime(fileName: string): string | null {
  const match = /^backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.zip$/.exec(fileName);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
}

async function collectFiles(rootDir: string, prefix: string): Promise<{ path: string; full: string }[]> {
  if (!existsSync(rootDir)) return [];

  const out: { path: string; full: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else {
        const rel = relative(rootDir, full).split(sep).join('/');
        out.push({ path: `${prefix}/${rel}`, full });
      }
    }
  };
  await walk(rootDir);
  return out;
}

/** 列出数据库中登记的全部素材存储键 */
export function listAllStorageKeys(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db
    .prepare("SELECT DISTINCT storage_key FROM media WHERE storage_key <> '' ORDER BY storage_key")
    .all();
  return rows.map((row) => String((row as { storage_key: unknown }).storage_key));
}

/** 统计各表行数，作为恢复校验基线 */
export function tableCounts(db: ReturnType<typeof openDatabase>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
      counts[table] = Number((row as { total?: unknown } | undefined)?.total ?? 0);
    } catch {
      counts[table] = -1; // 表不存在
    }
  }
  return counts;
}

/** 创建备份归档（数据库快照 + 上传素材 + manifest） */
export async function createBackup(ctx: AppContext): Promise<BackupResult> {
  const tmpDir = join(ctx.config.dataDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });

  const now = ctx.adapters.clock.now();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const snapshotPath = join(tmpDir, `snapshot-${stamp}.sqlite`);

  // VACUUM INTO 生成一致性快照
  ctx.db.exec(`VACUUM INTO '${escapeSqlPath(snapshotPath)}'`);

  const snapshot = await readFile(snapshotPath);

  const manifest: BackupManifest = {
    createdAt: now.toISOString(),
    databaseFile: 'db/app.sqlite',
    tables: tableCounts(ctx.db),
    mediaFiles: 0,
    note: '本归档包含 SQLite 一致性快照与全部上传素材，可用于完整恢复。',
  };

  const files: ZipEntry[] = [
    { path: manifest.databaseFile, data: new Uint8Array(snapshot) },
  ];

  // 通过存储适配器逐个读取素材，而不是直接扫描本地目录。
  // 这样即使将来把存储换成对象存储（S3 等），备份依然完整 ——
  // 直接读 uploadDir 会在非本地适配器下静默丢失所有素材。
  const keys = listAllStorageKeys(ctx.db);
  const missing: string[] = [];

  for (const key of keys) {
    const data = await ctx.adapters.storage.read(key);
    if (!data) {
      missing.push(key);
      continue;
    }
    files.push({ path: `uploads/${key}`, data });
  }

  manifest.mediaFiles = keys.length - missing.length;
  if (missing.length > 0) {
    manifest.note = `${manifest.note} 注意：有 ${missing.length} 个素材在存储中读取失败，未包含在备份内（${missing.join(', ')}）。`;
  }

  files.push({
    path: 'manifest.json',
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  const zip = createZip(files);

  await mkdir(ctx.config.backupDir, { recursive: true });

  // 同一秒内重复备份时自动加序号，避免覆盖
  let backupFile = join(ctx.config.backupDir, backupFileName(now));
  let counter = 2;
  while (existsSync(backupFile)) {
    backupFile = join(ctx.config.backupDir, backupFileName(now).replace(/\.zip$/, `-${counter}.zip`));
    counter += 1;
  }

  await writeFile(backupFile, zip.data);

  await rm(snapshotPath, { force: true });

  recordAudit(ctx, {
    action: 'backup.create',
    entityType: 'backup',
    entityId: backupFile,
    detail: { bytes: zip.data.length, tables: manifest.tables, mediaFiles: manifest.mediaFiles },
  });

  return { file: backupFile, bytes: zip.data.length, manifest };
}

export interface BackupInfo {
  file: string;
  bytes: number;
  createdAt: string;
}

export async function listBackups(ctx: AppContext): Promise<BackupInfo[]> {
  if (!existsSync(ctx.config.backupDir)) return [];

  const items = await readdir(ctx.config.backupDir, { withFileTypes: true });
  const results: BackupInfo[] = [];

  for (const item of items) {
    if (!item.isFile() || !item.name.endsWith('.zip')) continue;
    const full = join(ctx.config.backupDir, item.name);
    const info = await stat(full);

    // 优先使用文件名中编码的时间（与业务时钟一致），仅在无法解析时退回 mtime
    const fromName = parseBackupTime(item.name);
    results.push({
      file: full,
      bytes: info.size,
      createdAt: fromName ?? info.mtime.toISOString(),
    });
  }

  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface VerifyResult {
  ok: boolean;
  manifest: BackupManifest | null;
  problems: string[];
  tables: Record<string, number>;
}

/** 校验备份归档的完整性：能解码、数据库能打开、表行数与 manifest 一致 */
export async function verifyBackupFile(ctx: AppContext, filePath: string): Promise<VerifyResult> {
  const problems: string[] = [];
  let manifest: BackupManifest | null = null;
  let tables: Record<string, number> = {};

  let entries;
  try {
    entries = readZip(new Uint8Array(await readFile(filePath)));
  } catch (error) {
    return {
      ok: false,
      manifest: null,
      problems: [`无法读取归档：${error instanceof Error ? error.message : String(error)}`],
      tables: {},
    };
  }

  const manifestEntry = entries.find((e) => e.path === 'manifest.json');
  if (!manifestEntry) {
    problems.push('归档缺少 manifest.json');
  } else {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as BackupManifest;
  }

  const dbEntry = entries.find((e) => e.path === 'db/app.sqlite');
  if (!dbEntry) {
    problems.push('归档缺少数据库快照 db/app.sqlite');
    return { ok: false, manifest, problems, tables };
  }

  const tmpDir = join(ctx.config.dataDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const probePath = join(tmpDir, `verify-${Date.now()}.sqlite`);
  await writeFile(probePath, dbEntry.data);

  try {
    const db = openDatabase(probePath);
    try {
      tables = tableCounts(db);
      for (const table of BACKUP_TABLES) {
        if (tables[table] === -1) problems.push(`快照中缺少表：${table}`);
      }
      if (manifest) {
        for (const [table, expected] of Object.entries(manifest.tables)) {
          const actual = tables[table];
          if (actual !== expected) {
            problems.push(`表 ${table} 行数不一致：manifest=${expected}，快照=${actual}`);
          }
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    problems.push(`数据库快照无法打开：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(probePath, { force: true });
  }

  return { ok: problems.length === 0, manifest, problems, tables };
}

export interface RestoreResult {
  targetDir: string;
  databaseFile: string;
  uploadDir: string;
  restoredTables: Record<string, number>;
  restoredMediaFiles: number;
  manifest: BackupManifest | null;
}

/**
 * 恢复演练：把备份解包到独立目录并校验。
 *
 * 采用「恢复到独立目录 + 校验行数」而不是直接覆盖正在运行的数据库，
 * 这样可以在不影响线上数据的前提下反复验证备份确实可恢复；
 * 真正切换时只需把 targetDir 指向 var/ 并重启服务。
 */
export async function restoreBackupToDirectory(
  ctx: AppContext,
  filePath: string,
  targetDir: string,
): Promise<RestoreResult> {
  const target = resolve(targetDir);
  const entries = readZip(new Uint8Array(await readFile(filePath)));

  let restoredMediaFiles = 0;

  for (const entry of entries) {
    if (entry.path.includes('..')) {
      throw unprocessable(`归档中包含非法路径：${entry.path}`);
    }

    const full = resolve(target, entry.path);
    if (!full.startsWith(target + sep)) {
      throw unprocessable(`归档路径越界：${entry.path}`);
    }

    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, entry.data);

    if (entry.path.startsWith('uploads/')) restoredMediaFiles += 1;
  }

  const databaseFile = join(target, 'db', 'app.sqlite');
  const uploadDir = join(target, 'uploads');

  const db = openDatabase(databaseFile);
  let restoredTables: Record<string, number>;
  try {
    restoredTables = tableCounts(db);
  } finally {
    db.close();
  }

  const manifestEntry = entries.find((e) => e.path === 'manifest.json');
  const manifest = manifestEntry
    ? (JSON.parse(new TextDecoder().decode(manifestEntry.data)) as BackupManifest)
    : null;

  recordAudit(ctx, {
    action: 'backup.restore_drill',
    entityType: 'backup',
    entityId: filePath,
    detail: { targetDir: target, tables: restoredTables, mediaFiles: restoredMediaFiles },
  });

  return { targetDir: target, databaseFile, uploadDir, restoredTables, restoredMediaFiles, manifest };
}

/** 按保留天数清理旧备份 */
export async function pruneBackups(ctx: AppContext): Promise<{ removed: string[]; kept: number }> {
  const backups = await listBackups(ctx);
  const cutoff = ctx.adapters.clock.now().getTime() - ctx.config.backupRetentionDays * 24 * 60 * 60 * 1000;

  const removed: string[] = [];
  let kept = 0;

  for (const backup of backups) {
    if (new Date(backup.createdAt).getTime() < cutoff) {
      await rm(backup.file, { force: true });
      removed.push(backup.file);
    } else {
      kept += 1;
    }
  }

  if (removed.length > 0) {
    recordAudit(ctx, {
      action: 'backup.prune',
      entityType: 'backup',
      entityId: 'retention',
      detail: { removed: removed.length, kept, retentionDays: ctx.config.backupRetentionDays },
    });
  }

  return { removed, kept };
}