/**
 * 迁移命令行入口：pnpm migrate
 *
 * 同时作为模块被 server.ts 调用，保证「启动即迁移」，避免忘记执行迁移。
 */

import { loadConfig, ensureRuntimeDirs } from '../config.ts';
import { openDatabase } from './database.ts';
import { runMigrations } from './migrations.ts';
import { createLogger } from '../util/logger.ts';

export function migrateToLatest(databaseFile: string): { applied: string[]; skipped: number[] } {
  const db = openDatabase(databaseFile);
  try {
    const result = runMigrations(db);
    return {
      applied: result.applied.map((m) => `v${m.version} ${m.name}`),
      skipped: result.skipped,
    };
  } finally {
    db.close();
  }
}

/** 直接运行本文件时执行迁移 */
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('/src/db/migrate.ts') ?? false;

if (isDirectRun) {
  const logger = createLogger({ level: 'info' });
  const config = loadConfig();
  ensureRuntimeDirs(config);

  const result = migrateToLatest(config.databaseFile);
  logger.info('数据库迁移完成', {
    databaseFile: config.databaseFile,
    applied: result.applied,
    skippedVersions: result.skipped,
  });
}
