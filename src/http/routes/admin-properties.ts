/**
 * 房源管理接口（方案第 1 阶段）。
 * 路由只负责解析输入与输出，业务规则全部在 service 层。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { validationFailed } from '../../domain/errors.ts';
import type { PropertyStatus } from '../../domain/types.ts';
import {
  archiveProperty,
  createPropertyFromInput,
  deletePropertyCascade,
  duplicateProperty,
  getPropertyAggregate,
  listPropertiesAdmin,
  propertyStats,
  restoreProperty,
  setPropertyStatus,
  updatePropertyFromInput,
} from '../../services/property-service.ts';
import { readiness } from '../../services/publish-service.ts';
import { listTemplates } from '../../render/templates.ts';
import { recentAudit } from '../../services/audit-service.ts';
import { countListingByStatus } from '../../db/repositories/listing-page-repo.ts';
import { countByStatus, listPropertiesWithMeta } from '../../db/repositories/property-repo.ts';
import { resolveAvailability } from '../../domain/availability.ts';
import { countByStatus as countRemindersByStatus } from '../../db/repositories/reminder-repo.ts';

interface ListQuery {
  status?: string;
  search?: string;
  limit?: string;
  offset?: string;
  sort?: string;
  includeArchived?: string;
}

export function registerAdminPropertyRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** 后台概览：房源、发布、提醒三个维度的统计 */
  app.get('/api/admin/overview', async () => {
    const stats = propertyStats(ctx);

    return {
      workspace: ctx.workspace,
      properties: stats,
      listings: countListingByStatus(ctx.db, ctx.workspace.id),
      reminders: countRemindersByStatus(ctx.db, ctx.workspace.id),
      templates: listTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
      })),
      timeTravel: ctx.travelClock
        ? { enabled: true, now: ctx.adapters.clock.now().toISOString() }
        : { enabled: false },
      adapters: {
        map: ctx.adapters.map.name,
        storage: ctx.adapters.storage.name,
        mail: ctx.adapters.mail.name,
        hosting: ctx.adapters.hosting.name,
      },
      recentAudit: recentAudit(ctx, 12),
    };
  });

  app.get<{ Querystring: ListQuery }>('/api/admin/properties', async (request) => {
    const query = request.query;
    const limit = Number.parseInt(query.limit ?? '50', 10);
    const offset = Number.parseInt(query.offset ?? '0', 10);

    const sort =
      query.sort === 'created_desc' || query.sort === 'title_asc' ? query.sort : 'updated_desc';

    // 单条 SQL 取回房源 + 发布信息 + 照片数量，避免逐条再查（N+1）
    const result = listPropertiesWithMeta(ctx.db, {
      workspaceId: ctx.workspace.id,
      status: (query.status as PropertyStatus | 'all') ?? 'all',
      search: query.search ?? '',
      includeArchived: query.includeArchived === 'true',
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      sort,
    });

    // 列表同样展示「推导后」的状态，让房东一眼看到哪些房源已经陈旧到需要确认
    const now = ctx.adapters.clock.now();
    const items = result.items.map((row) => ({
      ...row.property,
      availabilityStatus: resolveAvailability(
        row.property,
        now,
        ctx.config.listingStaleDays,
      ).status,
      listing: row.listing,
      photoCount: row.photoCount,
      // 卡片需要直接拿到缩略图地址；存储键为空时前端渲染占位
      coverUrl: row.coverStorageKey ? `/media/${row.coverStorageKey}` : null,
    }));

    return {
      items,
      total: result.total,
      statusCounts: countByStatus(ctx.db, ctx.workspace.id),
    };
  });

  app.post('/api/admin/properties', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = createPropertyFromInput(ctx, body);
    return reply.code(201).send(result);
  });

  app.get<{ Params: { id: string } }>('/api/admin/properties/:id', async (request) => {
    const aggregate = getPropertyAggregate(ctx, request.params.id);
    const page = aggregate.listingPage;

    return {
      ...aggregate,
      readiness: readiness(ctx, request.params.id, page?.locale ?? ctx.workspace.defaultLocale),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/properties/:id', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return updatePropertyFromInput(ctx, request.params.id, body);
  });

  app.delete<{ Params: { id: string } }>('/api/admin/properties/:id', async (request) => {
    await deletePropertyCascade(ctx, request.params.id);
    return { deleted: true, id: request.params.id };
  });

  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/status', async (request) => {
    const body = (request.body ?? {}) as { status?: unknown };
    const status = typeof body.status === 'string' ? body.status : '';

    if (status === 'archived') return archiveProperty(ctx, request.params.id);
    if (status === 'restore') return restoreProperty(ctx, request.params.id);

    return setPropertyStatus(ctx, request.params.id, status as PropertyStatus);
  });

  app.post<{ Params: { id: string } }>('/api/admin/properties/:id/duplicate', async (request, reply) => {
    const copy = duplicateProperty(ctx, request.params.id);
    return reply.code(201).send(copy);
  });

  /** 发布就绪检查：前端可在发布前先取回阻塞项 */
  app.get<{ Params: { id: string }; Querystring: { locale?: string } }>(
    '/api/admin/properties/:id/readiness',
    async (request) => {
      const locale = request.query.locale ?? ctx.workspace.defaultLocale;
      return readiness(ctx, request.params.id, locale);
    },
  );

  /** 触发一次上传前的策略查询，便于前端提前校验 */
  app.get('/api/admin/upload-policy', async () => ({
    maxUploadBytes: ctx.config.upload.maxUploadBytes,
    maxVideoBytes: ctx.config.upload.maxVideoBytes,
    maxPhotosPerProperty: ctx.config.upload.maxPhotosPerProperty,
    allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'],
  }));

  app.get<{ Params: { id: string } }>('/api/admin/properties/:id/audit', async (request) => {
    const { entityAudit } = await import('../../services/audit-service.ts');
    return { items: entityAudit(ctx, 'property', request.params.id) };
  });

  /** 供前端做输入提示：可选状态与模板 */
  app.get('/api/admin/meta', async () => ({
    statuses: [
      { value: 'draft', label: '草稿' },
      { value: 'active', label: '在售/在租' },
      { value: 'reserved', label: '已预订' },
      { value: 'closed', label: '已成交' },
      { value: 'archived', label: '已归档' },
    ],
    availabilityStatuses: [
      { value: 'available', label: '出租中（仍可租）' },
      { value: 'rented', label: '已租（已租出）' },
    ],
    availabilityNote:
      '「未确认」由系统按最后更新时间自动判定，无需手工设置；编辑房源即视为一次更新。',
    pricePeriods: [
      { value: 'total', label: '总价' },
      { value: 'per_month', label: '每月' },
      { value: 'per_week', label: '每周' },
      { value: 'per_night', label: '每晚' },
      { value: 'per_year', label: '每年' },
    ],
    // 面积单位各国不同，标签带上国际写法，避免房东在「平方米 / m²」之间犹豫
    areaUnits: [
      { value: 'square_meter', label: '平方米 m²' },
      { value: 'square_foot', label: '平方英尺 sq ft' },
    ],
    propertyTypes: [
      { value: 'apartment', label: '公寓' },
      { value: 'house', label: '独立住宅' },
      { value: 'room', label: '单间' },
      { value: 'studio', label: '开间' },
      { value: 'townhouse', label: '联排' },
      { value: 'office', label: '办公' },
      { value: 'shop', label: '商铺' },
      { value: 'land', label: '土地' },
      { value: 'other', label: '其他' },
    ],
    contactChannels: [
      { value: 'phone', label: '电话' },
      { value: 'email', label: '邮箱' },
      { value: 'chat', label: '在线咨询' },
      { value: 'wechat', label: '微信' },
      { value: 'whatsapp', label: 'WhatsApp' },
      { value: 'telegram', label: 'Telegram' },
      { value: 'other', label: '其他' },
    ],
    currencies: ['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'HKD', 'TWD', 'SGD', 'AUD', 'CAD', 'THB', 'VND', 'AED'],
    locale: ctx.workspace.defaultLocale,
    currency: ctx.workspace.defaultCurrency,
    areaUnit: ctx.workspace.defaultAreaUnit,
    timezone: ctx.workspace.defaultTimezone,
  }));

  // 兼容：有些前端会先请求验证输入是否合法
  app.post('/api/admin/properties/validate', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const { parsePropertyForm, emptyPropertyForm } = await import('../../domain/property.ts');
      const parsed = parsePropertyForm(
        body,
        emptyPropertyForm({
          currency: ctx.workspace.defaultCurrency,
          areaUnit: ctx.workspace.defaultAreaUnit,
        }),
      );
      return { valid: true, values: parsed };
    } catch (error) {
      const { isDomainError } = await import('../../domain/errors.ts');
      if (isDomainError(error)) {
        return { valid: false, ...error.toResponse() };
      }
      throw validationFailed([{ field: 'body', message: '输入校验失败' }]);
    }
  });
}