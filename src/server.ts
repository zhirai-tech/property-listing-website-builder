/**
 * 服务入口。
 *
 * 启动顺序：加载配置 -> 校验配置 -> 建目录 -> 打开数据库并迁移 -> 装配上下文 -> 启动 HTTP。
 * 任一环节失败都直接退出并打印原因，避免半启动状态。
 */

import { checkAiReadiness } from './platform/ai/readiness.ts';
import { loadConfig, ensureRuntimeDirs } from './config.ts';
import { closeContext, createAppContext } from './app-context.ts';
import { buildApp } from './http/app.ts';
import { appliedVersions } from './db/migrations.ts';
import { dispatchDueReminders } from './services/reminder-service.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  // 配置校验失败会直接抛出，包含具体原因（例如生产环境使用了默认口令）
  ensureRuntimeDirs(config);

  const ctx = createAppContext({ config });

  ctx.logger.info('启动轻量化房源管理平台', {
    env: config.env,
    migrations: appliedVersions(ctx.db),
    workspace: ctx.workspace.name,
    databaseFile: config.databaseFile,
    adapters: {
      map: ctx.adapters.map.name,
      storage: ctx.adapters.storage.name,
      mail: ctx.adapters.mail.name,
      hosting: ctx.adapters.hosting.name,
      clock: ctx.adapters.clock.constructor.name,
    },
    devTimeTravel: ctx.travelClock !== null,
  });

  // 启动时把「AI 到底能不能用」讲清楚。
  // 默认配置是 mock（不花钱，但也生成不出页面）——
  // 不说的话，部署者会以为 AI 功能坏了，而系统从不告诉他原因。
  const readiness = checkAiReadiness(config.ai);
  if (readiness.status === 'degraded') {
    console.warn('[AI] ' + readiness.summary);
    for (const action of readiness.actions) console.warn('[AI]   需要做：' + action);
  } else {
    console.log('[AI] ' + readiness.summary);
  }

  const app = await buildApp(ctx);

  await app.listen({ port: config.port, host: config.host });

  const base = config.publicBaseUrl || `http://${config.host}:${config.port}`;
  ctx.logger.info('服务已就绪', {
    admin: `${base}/admin/`,
    health: `${base}/healthz`,
  });

  // ---- 提醒定时投递 ----
  const intervalMs = Math.max(config.reminders.dispatchIntervalMinutes, 1) * 60 * 1000;

  const timer = setInterval(() => {
    void dispatchDueReminders(ctx)
      .then((report) => {
        if (report.considered > 0) {
          ctx.logger.info('提醒投递完成', {
            considered: report.considered,
            sent: report.sent,
            failed: report.failed,
            skipped: report.skipped,
          });
        }
      })
      .catch((error: unknown) => {
        ctx.logger.error('提醒投递任务异常', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, intervalMs);

  // 不阻塞进程退出
  timer.unref();

  // ---- 优雅退出 ----
  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info('收到退出信号，正在关闭', { signal });
    clearInterval(timer);

    try {
      await app.close();
    } catch (error) {
      ctx.logger.warn('关闭 HTTP 服务时出错', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    closeContext(ctx);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`启动失败：${message}\n`);
  process.exit(1);
});