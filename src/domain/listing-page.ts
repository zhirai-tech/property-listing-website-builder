/**
 * 发布页（ListingPage）领域规则（方案第三章第 3 条 / 第 8 条、第四章第 4 条）。
 */

import { conflict, unprocessable } from './errors.ts';
import { isValidDomain, slugify } from '../util/slug.ts';
import type { ListingPage, ListingStatus, PropertyAggregate, TemplateId } from './types.ts';
import { TEMPLATE_IDS } from './types.ts';

/** 生成 slug 的基础输入 */
export function slugSeedFor(property: { title: string; city: string; propertyType: string }): string {
  const primary = slugify(property.title);
  if (primary !== '') return primary;

  const fallback = slugify([property.city, property.propertyType].filter(Boolean).join(' '));
  return fallback;
}

/**
 * 发布前置条件检查。
 *
 * 方案第 2 阶段验收要求「后台与页面内容一致」，因此发布前必须确认
 * 展示页需要的最小信息已经存在，避免生成空白页面。
 * 返回 blockers 供前端提前提示，而不是等到发布时才报错。
 */
export function collectPublishReadiness(aggregate: {
  property: { title: string; addressLine: string; city: string; region: string };
  media: readonly { kind: string; storageKey: string; externalUrl: string | null }[];
  contacts: readonly { isPublic: boolean; channelValue: string }[];
  hasTranslationFor: (locale: string) => boolean;
  locale: string;
}): { ready: boolean; blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const { property } = aggregate;

  if (property.title.trim() === '') {
    blockers.push('房源标题为空，展示页将没有标题');
  }

  const hasAnyAddress =
    property.addressLine.trim() !== '' ||
    property.city.trim() !== '' ||
    property.region.trim() !== '';
  if (!hasAnyAddress) {
    blockers.push('地址信息为空，至少填写地址、城市或区域之一');
  }

  if (aggregate.media.length === 0) {
    warnings.push('尚未上传任何照片，展示页将只显示文字信息');
  }

  const publicContacts = aggregate.contacts.filter((c) => c.isPublic && c.channelValue.trim() !== '');
  if (publicContacts.length === 0) {
    warnings.push('没有公开的联系方式，访客将无法联系你');
  }

  if (aggregate.locale !== '' && !aggregate.hasTranslationFor(aggregate.locale)) {
    warnings.push(`展示语言 ${aggregate.locale} 尚无译文，将回退显示原文`);
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

/**
 * 发布状态迁移校验。
 * 方案第 2 阶段验收：未发布房源不能被公开访问；发布与撤下可以重复操作。
 */
export function assertPublishTransition(current: ListingStatus, next: ListingStatus): void {
  const allowed: Record<ListingStatus, readonly ListingStatus[]> = {
    unpublished: ['published'],
    published: ['withdrawn', 'published'],
    withdrawn: ['published'],
  };

  if (next === current) return;

  if (!allowed[current].includes(next)) {
    throw unprocessable(`发布状态不能从「${statusLabel(current)}」直接变为「${statusLabel(next)}」`);
  }
}

export function statusLabel(status: ListingStatus): string {
  switch (status) {
    case 'unpublished':
      return '未发布';
    case 'published':
      return '已发布';
    case 'withdrawn':
      return '已撤下';
    default:
      return status;
  }
}

/** 公开访问判定：只有 published 才允许匿名访问 */
export function isPubliclyVisible(page: Pick<ListingPage, 'status'>): boolean {
  return page.status === 'published';
}

export function assertTemplateId(value: string): TemplateId {
  if ((TEMPLATE_IDS as readonly string[]).includes(value)) return value as TemplateId;
  throw conflict(`模板不存在：${value}，可选：${TEMPLATE_IDS.join(' / ')}`);
}

// ---------------------------------------------------------------------------
// 自定义域名（第 6 阶段）
// ---------------------------------------------------------------------------

export interface DomainBindingState {
  customDomain: string | null;
  domainVerifyToken: string | null;
  domainVerifiedAt: string | null;
}

/**
 * 绑定自定义域名前置校验。
 * 方案第 6 阶段验收：未经验证的域名不能直接绑定。
 */
export function assertDomainBindable(domain: string): string {
  const value = domain.trim().toLowerCase();
  if (!isValidDomain(value)) {
    throw conflict(`域名格式不合法：${domain}，示例：listings.example.com`);
  }
  return value;
}

/** 只有当验证时间存在时，域名才被视为可用 */
export function isDomainActive(state: DomainBindingState): boolean {
  return (
    state.customDomain !== null &&
    state.customDomain !== '' &&
    state.domainVerifiedAt !== null &&
    state.domainVerifiedAt !== ''
  );
}

/**
 * 判断域名是否已通过所有权验证。
 * 方案第 6 阶段验收要求「完成域名所有权验证」，验证方式为 DNS TXT 记录。
 */
export function verifyDomainOwnership(
  state: Pick<DomainBindingState, 'domainVerifyToken'>,
  txtRecords: readonly string[],
  expectedPrefix: string,
): boolean {
  if (!state.domainVerifyToken) return false;
  const expected = `${expectedPrefix}=${state.domainVerifyToken}`;
  return txtRecords.some((record) => record.trim() === expected);
}

/** 校验聚合数据是否满足渲染展示页的最低要求 */
export function assertRenderable(aggregate: PropertyAggregate): void {
  if (!aggregate.property) throw unprocessable('房源数据缺失，无法渲染展示页');
}
