/**
 * 健康检查与运行时自检。
 * 方案第 8 阶段要求上线前有明确的检查手段。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { redactedConfig } from '../../config.ts';
import { appliedVersions } from '../../db/migrations.ts';
import { propertyStats } from '../../services/property-service.ts';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    at: ctx.adapters.clock.now().toISOString(),
    migrations: appliedVersions(ctx.db),
    adapters: {
      clock: ctx.adapters.clock.constructor.name,
      map: ctx.adapters.map.name,
      storage: ctx.adapters.storage.name,
      mail: ctx.adapters.mail.name,
      dns: ctx.adapters.dns.name,
      hosting: ctx.adapters.hosting.name,
    },
  }));

  /** 自检：只返回脱敏摘要，绝不暴露密钥 */
  app.get('/api/admin/diagnostics', async () => {
    const storageOk = await probeStorage(ctx);

    return {
      diagnostics: {
        env: ctx.config.env,
        migrations: appliedVersions(ctx.db),
        stats: propertyStats(ctx),
        adapters: {
          clock: ctx.adapters.clock.constructor.name,
          map: ctx.adapters.map.name,
          storage: ctx.adapters.storage.name,
          mail: ctx.adapters.mail.name,
          dns: ctx.adapters.dns.name,
          hosting: ctx.adapters.hosting.name,
        },
        storageWritable: storageOk,
        timeTravelEnabled: ctx.travelClock !== null,
        config: redactedConfig(ctx.config),
      },
    };
  });
}

/** 写入并删除一个探针文件，确认存储可用 */
async function probeStorage(ctx: AppContext): Promise<boolean> {
  const key = `_health/probe-${Date.now()}.txt`;
  try {
    await ctx.adapters.storage.put(key, new TextEncoder().encode('ok'));
    const read = await ctx.adapters.storage.read(key);
    await ctx.adapters.storage.remove(key);
    return read !== null;
  } catch {
    return false;
  }
}