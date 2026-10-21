/**
 * 归档已到期的免费项目。
 *
 * 用法：node --disable-warning=ExperimentalWarning scripts/expire-projects.ts
 *
 * 【为什么是脚本而不是进程内定时器】
 * 到期清理是低频、可延迟、可重跑的操作。放进主进程只会多一个随时可能出错的背景任务，
 * 而且多个实例同时跑会互相打架。做成脚本可以用系统计划任务在低峰期跑一次。
 * 项目里 scripts/run-reminders.ts 已经是这个模式。
 *
 * 【安全性】
 *  - 只归档，不删除任何行；
 *  - 只处理免费套餐的项目；
 *  - 可以重复运行（已归档的不会被再次处理）。
 */

import { loadConfig, ensureRuntimeDirs } from '../src/config.ts';
import { closeContext, createAppContext } from '../src/app-context.ts';
import { runMigrations } from '../src/db/migrations.ts';
import { expireOverdueProjects } from '../src/platform/retention.ts';

function main(): void {
  const config = loadConfig();
  ensureRuntimeDirs(config);

  const ctx = createAppContext({ config });

  try {
    runMigrations(ctx.db);
    const result = expireOverdueProjects(ctx);

    process.stdout.write(`扫描 ${result.scanned} 个项目，归档 ${result.archived.length} 个到期项目。\n`);
    for (const p of result.archived) {
      process.stdout.write(`  - ${p.title}（最后修改 ${p.updatedAt}）\n`);
    }
    if (result.archived.length === 0) {
      process.stdout.write('  没有到期项目。\n');
    }
  } finally {
    closeContext(ctx);
  }
}

main();