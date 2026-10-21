/**
 * 设置、外部服务适配器配置、托管域名与审计日志接口（方案第 4、6、8 阶段）。
 *
 * 安全约束：本接口只返回脱敏后的配置，密钥永远不出现在响应里。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { redactedConfig } from '../../config.ts';
import { validationFailed } from '../../domain/errors.ts';
import type { AdapterKind, AreaUnit } from '../../domain/types.ts';
import { ADAPTER_KINDS, AREA_UNITS } from '../../domain/types.ts';
import { Validator } from '../../domain/validate.ts';
import { updateWorkspace } from '../../db/repositories/workspace-repo.ts';
import {
  listExternalServices,
  upsertExternalService,
} from '../../db/repositories/external-service-repo.ts';
import { recordAudit, recentAudit } from '../../services/audit-service.ts';
import {
  bindDomain,
  hostingState,
  unbindDomain,
  verifyBoundDomain,
} from '../../services/hosting-service.ts';

export function registerAdminSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/admin/settings', async () => ({
    workspace: ctx.workspace,
    config: redactedConfig(ctx.config),
    reminders: {
      day1: ctx.config.reminders.day1,
      day2: ctx.config.reminders.day2,
      maxAttempts: ctx.config.reminders.maxAttempts,
      dispatchIntervalMinutes: ctx.config.reminders.dispatchIntervalMinutes,
      note: '提醒天数与重试上限通过环境变量配置，修改后需重启服务；时区在上方工作区设置中修改。',
    },
    adapters: {
      map: ctx.adapters.map.name,
      storage: ctx.adapters.storage.name,
      mail: ctx.adapters.mail.name,
      dns: ctx.adapters.dns.name,
      hosting: ctx.adapters.hosting.name,
      clock: ctx.adapters.clock.constructor.name,
    },
    areaUnits: AREA_UNITS,
    externalServices: listExternalServices(ctx.db, ctx.workspace.id),
  }));

  app.patch('/api/admin/settings', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const v = new Validator();

    const patch: Record<string, unknown> = {};

    if (Object.hasOwn(body, 'name')) {
      patch.name = v.str(body['name'], 'name', '工作区名称', { required: true, max: 120 });
    }
    if (Object.hasOwn(body, 'defaultLocale')) {
      patch.defaultLocale = v.locale(
        body['defaultLocale'],
        'defaultLocale',
        '默认语言',
        ctx.workspace.defaultLocale,
      );
    }
    if (Object.hasOwn(body, 'defaultCurrency')) {
      patch.defaultCurrency = v.currency(
        body['defaultCurrency'],
        'defaultCurrency',
        '默认币种',
        ctx.workspace.defaultCurrency,
      );
    }
    if (Object.hasOwn(body, 'defaultAreaUnit')) {
      patch.defaultAreaUnit = v.enumOf<AreaUnit>(
        body['defaultAreaUnit'],
        'defaultAreaUnit',
        '默认面积单位',
        AREA_UNITS,
        ctx.workspace.defaultAreaUnit,
      );
    }
    if (Object.hasOwn(body, 'defaultTimezone')) {
      patch.defaultTimezone = v.timezone(
        body['defaultTimezone'],
        'defaultTimezone',
        '默认时区',
        ctx.workspace.defaultTimezone,
      );
    }
    v.done();

    const updated = updateWorkspace(ctx.db, ctx.workspace.id, patch);
    if (!updated) throw validationFailed([{ field: 'body', message: '工作区更新失败' }]);

    // 上下文中的工作区也需要同步，避免同一进程内读到旧值
    ctx.workspace = updated;

    recordAudit(ctx, {
      action: 'settings.update',
      entityType: 'workspace',
      entityId: updated.id,
      detail: patch,
    });

    return updated;
  });

  // ---- 外部服务适配器配置 ----

  app.get('/api/admin/external-services', async () => ({
    items: listExternalServices(ctx.db, ctx.workspace.id),
    kinds: ADAPTER_KINDS,
    note: '此处只保存非敏感配置与密钥的环境变量名；密钥本身必须通过环境变量注入，不会写入数据库或前端。',
  }));

  app.put('/api/admin/external-services', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const v = new Validator();

    const adapterKind = v.enumOf<AdapterKind>(
      body['adapterKind'],
      'adapterKind',
      '适配器类型',
      ADAPTER_KINDS,
      'map',
    );
    const provider = v.str(body['provider'], 'provider', '服务商', { required: true, max: 60 });
    const freeTierNote = v.text(body['freeTierNote'], 'freeTierNote', '免费额度说明', { max: 1000 });
    v.done();

    // 拒绝任何看起来像密钥的字段名，强制走环境变量
    const rawConfig = (body['config'] ?? {}) as Record<string, unknown>;
    const config: Record<string, string> = {};
    const rejected: string[] = [];

    for (const [key, value] of Object.entries(rawConfig)) {
      if (/(password|secret|token|api[_-]?key|access[_-]?key)/i.test(key)) {
        rejected.push(key);
        continue;
      }
      config[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }

    if (rejected.length > 0) {
      throw validationFailed(
        rejected.map((field) => ({
          field: `config.${field}`,
          message: '疑似密钥字段被拒绝保存。请改为在 .env 中设置，并在 secretRefs 里填写环境变量名。',
        })),
        '配置中包含疑似密钥，已拒绝保存',
      );
    }

    const secretRefs = Array.isArray(body['secretRefs'])
      ? body['secretRefs'].filter((v2): v2 is string => typeof v2 === 'string')
      : [];

    const saved = upsertExternalService(ctx.db, ctx.workspace.id, {
      adapterKind,
      provider,
      config,
      secretRefs,
      enabled: body['enabled'] === false ? false : true,
      freeTierNote,
    });

    recordAudit(ctx, {
      action: 'settings.external_service',
      entityType: 'external_service',
      entityId: saved.id,
      detail: { adapterKind, provider, secretRefs },
    });

    return saved;
  });

  app.get('/api/admin/audit', async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number.parseInt(query.limit ?? '100', 10);
    return { items: recentAudit(ctx, Number.isFinite(limit) ? limit : 100) };
  });

  // ---- 托管与自定义域名（第 6 阶段） ----

  app.get<{ Params: { id: string } }>('/api/admin/properties/:id/hosting', async (request) => ({
    state: hostingState(ctx, request.params.id),
    cnameTarget: ctx.config.hosting.cnameTarget,
    verifyPrefix: ctx.config.hosting.domainVerifyPrefix,
  }));

  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/hosting/domain', async (request) => {
    const body = (request.body ?? {}) as { domain?: unknown };
    const domain = typeof body.domain === 'string' ? body.domain : '';
    return bindDomain(ctx, request.params.id, domain);
  });

  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/hosting/verify', async (request) =>
    verifyBoundDomain(ctx, request.params.id),
  );

  app.delete<{ Params: { id: string } }>('/api/admin/properties/:id/hosting/domain', async (request) => ({
    page: unbindDomain(ctx, request.params.id),
  }));
}