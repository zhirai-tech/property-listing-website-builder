/**
 * 托管与子域名服务（方案第三章第 8 条、第 6 阶段验收）。
 *
 * 验收要点：
 *  - 先平台默认地址，再支持子域名/自定义域名；
 *  - 完成域名所有权验证（DNS TXT）；
 *  - 未经验证的域名不能直接绑定 —— 绑定后仍走默认地址，直到验证通过；
 *  - 发布和撤回可以重复操作（由 publish-service 的状态机保证）。
 */

import type { AppContext } from '../app-context.ts';
import { conflict, notFound, unprocessable } from '../domain/errors.ts';
import type { ListingPage } from '../domain/types.ts';
import { assertDomainBindable } from '../domain/listing-page.ts';
import { buildSubdomain, validateSubdomainLabel } from '../domain/hosting.ts';
import { newToken } from '../util/ids.ts';
import { randomSuffix } from '../util/slug.ts';
import { getListingPageByDomain, updateListingPage } from '../db/repositories/listing-page-repo.ts';
import { recordAudit } from './audit-service.ts';
import { ensureListingPage, publicUrlFor } from './publish-service.ts';
import { requireProperty } from './property-service.ts';

export interface HostingState {
  provider: string;
  allowsCustomDomain: boolean;
  propertyId: string;
  slug: string;
  publicUrl: string;
  urlKind: 'default' | 'custom_domain';
  note: string;
  customDomain: string | null;
  domainVerifiedAt: string | null;
  verifyToken: string | null;
  freeTierNote: string;
}

export function hostingState(ctx: AppContext, propertyId: string): HostingState {
  const page = ensureListingPage(ctx, propertyId);
  const resolved = ctx.adapters.hosting.resolvePublicUrl(page.slug, {
    customDomain: page.customDomain,
    domainVerifyToken: page.domainVerifyToken,
    domainVerifiedAt: page.domainVerifiedAt,
  });

  return {
    provider: ctx.adapters.hosting.name,
    allowsCustomDomain: ctx.adapters.hosting.allowsCustomDomain,
    propertyId,
    slug: page.slug,
    publicUrl: resolved.url,
    urlKind: resolved.kind,
    note: resolved.note,
    customDomain: page.customDomain,
    domainVerifiedAt: page.domainVerifiedAt,
    verifyToken: page.domainVerifyToken,
    freeTierNote: ctx.config.map.freeTierNote,
  };
}

export interface BindDomainResult {
  page: ListingPage;
  instructions: { recordType: 'TXT'; recordName: string; recordValue: string; steps: string[] };
  /** 绑定后仍可用的公开地址（验证通过前是默认地址） */
  publicUrl: string;
}

/**
 * 绑定自定义域名。
 * 关键规则：绑定动作本身不会让域名立即生效 —— 必须通过 DNS TXT 验证。
 */
export function bindDomain(ctx: AppContext, propertyId: string, domain: string): BindDomainResult {
  requireProperty(ctx, propertyId);

  if (!ctx.adapters.hosting.allowsCustomDomain) {
    throw unprocessable(
      '当前托管模式为「平台默认地址」，未启用自定义域名。请先设置 HOSTING_PROVIDER=custom_domain 后重启服务。',
    );
  }

  const normalized = assertDomainBindable(domain);

  const taken = getListingPageByDomain(ctx.db, normalized);
  if (taken && taken.propertyId !== propertyId) {
    throw conflict(`域名 ${normalized} 已绑定到其它房源，请先解绑`);
  }

  const page = ensureListingPage(ctx, propertyId);
  const token = page.domainVerifyToken ?? newToken(18);

  const updated = updateListingPage(ctx.db, page.id, {
    customDomain: normalized,
    domainVerifyToken: token,
    // 重新绑定必须重新验证
    domainVerifiedAt: null,
  });
  if (!updated) throw notFound('发布页', page.id);

  const instructions = {
    recordType: 'TXT' as const,
    recordName: normalized,
    recordValue: `${ctx.config.hosting.domainVerifyPrefix}=${token}`,
    steps: [
      `登录 ${normalized} 的域名/DNS 管理后台`,
      `新增 TXT 记录：主机记录 @，值 ${ctx.config.hosting.domainVerifyPrefix}=${token}`,
      '保存后等待 DNS 生效（通常几分钟到几小时）',
      '回到本页面点击「验证域名」',
    ],
  };

  recordAudit(ctx, {
    action: 'hosting.bind',
    entityType: 'listing_page',
    entityId: page.id,
    detail: { domain: normalized },
  });

  return { page: updated, instructions, publicUrl: publicUrlFor(ctx, updated) };
}

export interface VerifyDomainResult {
  verified: boolean;
  detail: string;
  found: string[];
  instructions: { recordType: 'TXT'; recordName: string; recordValue: string; steps: string[] };
  publicUrl: string;
}

export async function verifyBoundDomain(
  ctx: AppContext,
  propertyId: string,
): Promise<VerifyDomainResult> {
  const page = ensureListingPage(ctx, propertyId);

  if (!page.customDomain) {
    throw unprocessable('尚未绑定自定义域名，请先绑定');
  }

  const token = page.domainVerifyToken ?? '';
  const result = await ctx.adapters.hosting.verifyDomain(page.customDomain, token, {
    customDomain: page.customDomain,
    domainVerifyToken: page.domainVerifyToken,
    domainVerifiedAt: page.domainVerifiedAt,
  });

  if (result.verified) {
    const updated = updateListingPage(ctx.db, page.id, {
      domainVerifiedAt: ctx.adapters.clock.now().toISOString(),
    });

    recordAudit(ctx, {
      action: 'hosting.verify',
      entityType: 'listing_page',
      entityId: page.id,
      detail: { domain: page.customDomain, verified: true },
    });

    return {
      verified: true,
      detail: result.detail,
      found: result.found,
      instructions: result.instructions,
      publicUrl: updated ? publicUrlFor(ctx, updated) : publicUrlFor(ctx, page),
    };
  }

  recordAudit(ctx, {
    action: 'hosting.verify',
    entityType: 'listing_page',
    entityId: page.id,
    detail: { domain: page.customDomain, verified: false, found: result.found },
  });

  return {
    verified: false,
    detail: result.detail,
    found: result.found,
    instructions: result.instructions,
    publicUrl: publicUrlFor(ctx, page),
  };
}

export function unbindDomain(ctx: AppContext, propertyId: string): ListingPage {
  const page = ensureListingPage(ctx, propertyId);

  const updated = updateListingPage(ctx.db, page.id, {
    customDomain: null,
    domainVerifyToken: null,
    domainVerifiedAt: null,
  });
  if (!updated) throw notFound('发布页', page.id);

  recordAudit(ctx, {
    action: 'hosting.unbind',
    entityType: 'listing_page',
    entityId: page.id,
    detail: { previousDomain: page.customDomain },
  });

  return updated;
}

/**
 * 依据 slug 生成一个可用的子域名建议。
 *
 * DNS 标签只允许 ascii 字母/数字/连字符，而 slug 可能是中文
 * （例如「浦东新区精装两居室」），这种情况下回退为随机标签，
 * 而不是直接抛错让用户无从下手 —— 用户仍可在界面上自行修改。
 */
export function suggestSubdomain(ctx: AppContext, slug: string): string {
  let label: string;

  try {
    label = validateSubdomainLabel(slug);
  } catch {
    label = `listing-${randomSuffix(6)}`;
  }

  return buildSubdomain(label, ctx.config.hosting.cnameTarget);
}