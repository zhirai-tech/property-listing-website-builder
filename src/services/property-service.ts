/**
 * 房源服务（方案第 1 阶段核心）。
 *
 * 验收要点：
 *  - 新增、查看、编辑、删除或归档、状态切换都在这里闭环；
 *  - 数据保存到统一数据库，刷新后仍然存在；
 *  - 错误输入有明确提示（由 domain 层校验产生中文 issues）；
 *  - 不存在第二套重复数据模型 —— 所有读写都走同一仓储。
 */

import type { AppContext } from '../app-context.ts';
import { notFound } from '../domain/errors.ts';
import { conflict } from '../domain/errors.ts';
import type { PropertyAggregate, Property, PropertyStatus } from '../domain/types.ts';
import { PROPERTY_STATUSES } from '../domain/types.ts';
import {
  diffPropertyForm,
  emptyPropertyForm,
  parsePropertyForm,
  propertyFormFromProperty,
} from '../domain/property.ts';
import {
  countByStatus,
  deleteProperty,
  findDuplicate,
  getProperty,
  insertProperty,
  listProperties,
  updateProperty,
  type PropertyListFilter,
  type PropertyListResult,
} from '../db/repositories/property-repo.ts';
import { listMedia, listStorageKeys } from '../db/repositories/media-repo.ts';
import { listPropertyContacts } from '../db/repositories/contact-repo.ts';
import { listTranslations } from '../db/repositories/translation-repo.ts';
import { getListingPageByProperty } from '../db/repositories/listing-page-repo.ts';
import { recordAudit } from './audit-service.ts';

/**
 * 读取并校验房源归属。
 * 权限隔离（方案第三章第 10 条）：只能操作本工作区的房源。
 */
export function requireProperty(ctx: AppContext, id: string): Property {
  const property = getProperty(ctx.db, id);
  if (!property || property.workspaceId !== ctx.workspace.id) {
    throw notFound('房源', id);
  }
  return property;
}

export interface CreatePropertyResult {
  property: Property;
  /** 疑似重复录入的提示（方案第三章第 5 条：避免重复录入相同房源） */
  duplicateOf: Property | null;
}

export function createPropertyFromInput(
  ctx: AppContext,
  raw: Record<string, unknown>,
): CreatePropertyResult {
  const defaults = {
    currency: ctx.workspace.defaultCurrency,
    areaUnit: ctx.workspace.defaultAreaUnit,
  };

  const form = parsePropertyForm(raw, emptyPropertyForm(defaults));

  const duplicate = findDuplicate(ctx.db, ctx.workspace.id, form.title, form.city);
  const property = insertProperty(ctx.db, ctx.workspace.id, form);

  recordAudit(ctx, {
    action: 'property.create',
    entityType: 'property',
    entityId: property.id,
    detail: { title: property.title, duplicateOf: duplicate?.id ?? null },
  });

  return { property, duplicateOf: duplicate };
}

export function updatePropertyFromInput(
  ctx: AppContext,
  id: string,
  raw: Record<string, unknown>,
): Property {
  const current = requireProperty(ctx, id);
  const base = propertyFormFromProperty(current);

  const next = parsePropertyForm(raw, base);
  const patch = diffPropertyForm(next, base);

  const updated = updateProperty(ctx.db, id, patch);

  recordAudit(ctx, {
    action: 'property.update',
    entityType: 'property',
    entityId: id,
    detail: { changedFields: Object.keys(patch) },
  });

  return updated;
}

export function setPropertyStatus(ctx: AppContext, id: string, status: PropertyStatus): Property {
  if (!(PROPERTY_STATUSES as readonly string[]).includes(status)) {
    throw conflict(`未知的房源状态：${status}`);
  }

  requireProperty(ctx, id);
  const updated = updateProperty(ctx.db, id, { status });

  recordAudit(ctx, {
    action: 'property.status',
    entityType: 'property',
    entityId: id,
    detail: { status },
  });

  return updated;
}

/** 归档（软下架）：默认不出现在主列表中，但数据完整保留 */
export function archiveProperty(ctx: AppContext, id: string): Property {
  return setPropertyStatus(ctx, id, 'archived');
}

export function restoreProperty(ctx: AppContext, id: string): Property {
  return setPropertyStatus(ctx, id, 'draft');
}

/**
 * 彻底删除房源。
 * 同时清理磁盘上的素材文件，避免留下孤儿文件（方案第三章第 10 条：删除素材）。
 */
export async function deletePropertyCascade(ctx: AppContext, id: string): Promise<void> {
  const property = requireProperty(ctx, id);

  const keys = listStorageKeys(ctx.db, id);
  for (const key of keys) {
    await ctx.adapters.storage.remove(key);
  }

  deleteProperty(ctx.db, id);

  recordAudit(ctx, {
    action: 'property.delete',
    entityType: 'property',
    entityId: id,
    detail: { title: property.title, removedFiles: keys.length },
  });
}

/** 复制房源：用于相似房源的快速录入（方案第三章第 5 条） */
export function duplicateProperty(ctx: AppContext, id: string): Property {
  const source = requireProperty(ctx, id);
  const form = propertyFormFromProperty(source);

  const copy = insertProperty(ctx.db, ctx.workspace.id, {
    ...form,
    title: `${form.title}（副本）`,
    status: 'draft',
  });

  recordAudit(ctx, {
    action: 'property.duplicate',
    entityType: 'property',
    entityId: copy.id,
    detail: { sourceId: id },
  });

  return copy;
}

/** 聚合读取：展示页、导出、后台详情共用同一个聚合，保证内容一致 */
export function getPropertyAggregate(ctx: AppContext, id: string): PropertyAggregate {
  const property = requireProperty(ctx, id);

  return {
    property,
    media: listMedia(ctx.db, id),
    contacts: listPropertyContacts(ctx.db, id),
    listingPage: getListingPageByProperty(ctx.db, id),
    translations: listTranslations(ctx.db, id),
  };
}

export interface AdminListResult extends PropertyListResult {
  statusCounts: Record<string, number>;
}

export function listPropertiesAdmin(
  ctx: AppContext,
  filter: Omit<PropertyListFilter, 'workspaceId'>,
): AdminListResult {
  const result = listProperties(ctx.db, { ...filter, workspaceId: ctx.workspace.id });
  return { ...result, statusCounts: countByStatus(ctx.db, ctx.workspace.id) };
}

/** 后台概览统计 */
export function propertyStats(ctx: AppContext): {
  statusCounts: Record<string, number>;
  total: number;
} {
  const counts = countByStatus(ctx.db, ctx.workspace.id);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { statusCounts: counts, total };
}
