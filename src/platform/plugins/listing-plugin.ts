/**
 * 房源插件 —— 现有房源系统接入插件体系的第一个实际落地。
 *
 * 【复用而非重写】
 * 本文件**不重新实现任何房源逻辑**：
 *   - 渲染沿用 `src/render/page-renderer.ts` 的 `renderListingPage`；
 *   - 数据沿用 `src/db/repositories/property-repo.ts` 与 `publish-service.ts`；
 *   - 模板沿用 `src/render/templates.ts` 的 `listTemplates()`。
 * 插件在这里只做一件事：**把已有能力声明成平台能识别的契约**。
 *
 * 【为什么这很重要】
 * 用户明确要求「优先复用已有代码和业务逻辑，避免复制一份完整的房源系统再长期维护两份」。
 * 因此插件是「适配层」，不是「第二套实现」。
 */

import { listTemplates } from '../../render/templates.ts';
import type { PluginField, PluginManifest, PublishCheck } from './types.ts';
import { PLUGIN_API_VERSION } from './types.ts';

/** 房源插件的字段定义 —— 直接对应现有 properties 表的可编辑列 */
const FIELDS: readonly PluginField[] = [
  { key: 'title', label: '标题', kind: 'text', required: true, max: 200, hint: '显示在展示页最上方' },
  { key: 'description', label: '房源描述', kind: 'textarea', max: 5000 },
  { key: 'priceAmount', label: '价格', kind: 'money' },
  { key: 'priceCurrency', label: '币种', kind: 'text', max: 3 },
  { key: 'pricePeriod', label: '计价周期', kind: 'select', options: ['per_month', 'per_week', 'per_night', 'per_year', 'total'] },
  { key: 'depositAmount', label: '押金', kind: 'money' },
  { key: 'areaValue', label: '面积', kind: 'number' },
  { key: 'areaUnit', label: '面积单位', kind: 'select', options: ['square_meter', 'square_foot'] },
  { key: 'bedrooms', label: '卧室', kind: 'number' },
  { key: 'bathrooms', label: '卫生间', kind: 'number' },
  { key: 'propertyType', label: '房型', kind: 'text', max: 40 },
  { key: 'floorNote', label: '楼层说明', kind: 'text', max: 200 },
  { key: 'addressLine', label: '详细地址', kind: 'text', max: 200 },
  { key: 'city', label: '城市', kind: 'text', max: 80 },
  { key: 'district', label: '区/县', kind: 'text', max: 80 },
  { key: 'region', label: '省/州', kind: 'text', max: 80 },
  { key: 'countryCode', label: '国家/地区代码', kind: 'text', max: 2 },
  { key: 'postalCode', label: '邮政编码', kind: 'text', max: 20 },
  { key: 'availableFrom', label: '可入住日期', kind: 'date' },
  { key: 'extraFeesNote', label: '附加费用说明', kind: 'textarea', max: 1000 },
  { key: 'photos', label: '照片', kind: 'images', max: 30, hint: '第一张自动成为封面' },
];

export const LISTING_PLUGIN_ID = 'listing';

export const listingPluginManifest: PluginManifest = {
  id: LISTING_PLUGIN_ID,
  name: '房源展示页',
  version: '1.0.0',
  pageType: 'listing',
  description: '把一套房源的结构化信息生成为可分享的展示页，复用平台已有的渲染、模板与导出发能力。',
  fields: FIELDS,
  // 只声明真正需要的能力：房源插件要渲染、要读存储里的照片、要能上传媒体、要能发布。
  // 没有声明 'ai.generate' —— 生成能力由平台在任务层统一调度，插件本身不需要直接调用模型。
  capabilities: ['render.server', 'storage.read', 'storage.write', 'media.upload', 'hosting.publish'],
  apiVersion: PLUGIN_API_VERSION,
  builtin: true,
  // propertyId 指向被展示的那套房源：用户不在管理界面里改它，
  // 但保存规格时必须保留，否则项目就丢了「展示的是哪套房」。
  structuralKeys: ['propertyId'],
};

/** 插件对外暴露的规格：平台据此生成页面，无需知道房源内部结构 */
/**
 * 发布前校验（房源项目）。
 *
 * 房源项目的公开页渲染的是一整套房源数据，所以「有内容」= 关联到一套真实房源。
 * 具体的可渲染性由发布时冻结快照那一步保证（采不到快照就拒绝发布）。
 */
export function listingPublishCheck(spec: Record<string, unknown>): PublishCheck {
  const propertyId = spec['propertyId'];
  if (typeof propertyId !== 'string' || propertyId === '') {
    return {
      ok: false,
      message: '这个房源项目还没有关联房源，无法发布。请先让项目关联到一套房源。',
    };
  }
  return { ok: true };
}

export interface ListingSpec {
  propertyId: string;
  templateId: string;
  locale: string;
}

/** 可用的展示模板（复用现有 templates.ts，不另建一份列表） */
export function availableListingTemplates(): { id: string; name: string; description: string }[] {
  return listTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description }));
}

/** 默认模板 —— 与 publish-service 的既有默认保持一致 */
export const DEFAULT_LISTING_TEMPLATE = 'modern';

/**
 * 把项目 spec 同步到它关联的房源记录。
 *
 * 【为什么必须有这一步】
 * 平台侧的内容存在 `projects.spec_json` 里（AI 与字段编辑器都改它），
 * 而**导出与展示页渲染的是 `properties` 记录**。两者如果不打通，
 * 用户在界面上改完、保存、下载，拿到的还是旧内容 ——
 * 也就是「修改后导出结果与保存内容一致」这条要求会失败。
 *
 * 映射是天然的：房源插件的字段键**就是** properties 的列名。
 * 但转换必须按清单里声明的控件类型来做，不能直接照搬 ——
 * 表单里数字是字符串、日期是 `YYYY-MM-DD`、下拉必须校验枚举值。
 * 因此这里由 `manifest.fields` 驱动，而不是写死一份键名列表。
 */
export function listingSpecToPropertyPatch(
  spec: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const field of FIELDS) {
    if (!Object.hasOwn(spec, field.key)) continue;
    const raw = spec[field.key];

    if (field.kind === 'number' || field.kind === 'money') {
      if (raw === '' || raw === null || raw === undefined) {
        patch[field.key] = null;
        continue;
      }
      const n = Number(raw);
      // 非数字一律丢弃本次改动，而不是写入 NaN 把房源污染掉
      if (Number.isFinite(n)) patch[field.key] = n;
      continue;
    }

    if (field.kind === 'date') {
      patch[field.key] = typeof raw === 'string' && raw !== '' ? raw : null;
      continue;
    }

    if (field.kind === 'select') {
      const value = String(raw ?? '');
      // 下拉值必须落在清单声明的选项里，否则跳过 ——
      // 直接把任意字符串写进枚举列会让展示页渲染出未定义行为
      if (field.options && !field.options.includes(value)) continue;
      patch[field.key] = value;
      continue;
    }

    // photos 是 images 控件，走媒体表，不是 properties 的列
    if (field.kind === 'image' || field.kind === 'images') continue;

    patch[field.key] = String(raw ?? '');
  }

  return patch;
}