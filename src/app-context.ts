/**
 * 应用组合根：把配置、数据库、适配器装配成一个可注入的上下文。
 *
 * 业务服务全部通过 AppContext 获取依赖，因此：
 *  - 单元测试可以注入 FakeClock / MemoryStorage；
 *  - 替换外部服务只需改适配器注册表，不动业务代码。
 */

import type { Database } from './db/database.ts';
import { openDatabase } from './db/database.ts';
import { runMigrations } from './db/migrations.ts';
import { ensureDefaultWorkspace } from './db/repositories/workspace-repo.ts';
import type { AppConfig } from './config.ts';
import { ensureRuntimeDirs } from './config.ts';
import type { Adapters } from './adapters/registry.ts';
import { createAdapters } from './adapters/registry.ts';
import { FakeClock } from './adapters/clock.ts';
import type { Logger } from './util/logger.ts';
import { createLogger } from './util/logger.ts';
import type { Workspace } from './domain/types.ts';

export interface AppContext {
  config: AppConfig;
  db: Database;
  adapters: Adapters;
  logger: Logger;
  workspace: Workspace;
  /**
   * 仅当 DEV_TIME_TRAVEL=true 时存在：可控时钟。
   * 用于在浏览器中把时间推进到第 7/15 天验证提醒，无需真实等待。
   */
  travelClock: FakeClock | null;
}

export interface CreateContextOptions {
  config: AppConfig;
  /** 注入替代适配器（测试用） */
  adapters?: Partial<Adapters>;
  inMemoryStorage?: boolean;
  /** 内存数据库：测试用，避免污染真实数据文件 */
  inMemoryDatabase?: boolean;
  logger?: Logger;
}

/** 打开数据库、执行迁移、保证存在默认工作区，并装配适配器 */
export function createAppContext(options: CreateContextOptions): AppContext {
  const { config } = options;

  if (!options.inMemoryDatabase) ensureRuntimeDirs(config);

  const logger =
    options.logger ??
    createLogger({ level: config.env === 'test' ? 'error' : 'info' });

  const db = openDatabase(options.inMemoryDatabase ? ':memory:' : config.databaseFile);
  runMigrations(db);

  const workspace = ensureDefaultWorkspace(db, {
    workspaceName: config.workspace.name,
    defaultLocale: config.workspace.defaultLocale,
    defaultCurrency: config.workspace.defaultCurrency,
    defaultAreaUnit: config.workspace.defaultAreaUnit,
    defaultTimezone: config.workspace.defaultTimezone,
    hostingProvider: config.hosting.provider,
    ownerEmail: config.workspace.ownerEmail,
    ownerDisplayName: '工作区所有者',
  });

  const travelClock = config.devTimeTravel && !options.adapters?.clock ? new FakeClock(new Date()) : null;

  const adapters = createAdapters(config, logger, {
    overrides: travelClock ? { ...options.adapters, clock: travelClock } : options.adapters,
    inMemoryStorage: options.inMemoryStorage,
  });

  return { config, db, adapters, logger, workspace, travelClock };
}

export function closeContext(ctx: AppContext): void {
  try {
    ctx.db.close();
  } catch {
    // 关闭失败不影响进程退出
  }
}
