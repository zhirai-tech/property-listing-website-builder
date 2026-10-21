/**
 * 托管发布与子域名领域规则（方案第三章第 8 条、第 6 阶段验收）。
 *
 * 验收要点：
 *  - 先支持平台默认发布地址，再支持自定义子域名/域名绑定；
 *  - 域名需完成所有权验证，不能直接绑定未经验证的域名；
 *  - 发布和撤回可以重复操作。
 */

import { conflict } from './errors.ts';
import { isDomainActive, type DomainBindingState } from './listing-page.ts';
import { isValidDomain, normalizeDomainLabel } from '../util/slug.ts';

export interface HostingOptions {
  /** 平台默认发布根地址，例如 https://listings.example.com */
  publicBaseUrl: string;
  /** 自定义域名需要指向的 CNAME 目标 */
  cnameTarget: string;
  /** 是否允许绑定自定义域名 */
  allowCustomDomain: boolean;
}

/** 拼接平台默认发布地址 */
export function buildDefaultPublicUrl(baseUrl: string, slug: string): string {
  const base = baseUrl.replace(/\/+$/g, '');
  return `${base}/p/${encodeURIComponent(slug)}`;
}

/** 子域名形式：<slug>.<cnameTarget> */
export function buildSubdomain(slug: string, cnameTarget: string): string {
  const label = normalizeDomainLabel(slug);
  if (label === '') {
    throw conflict('无法从该 slug 生成合法子域名，请改用自定义域名或调整标题');
  }
  return `${label}.${cnameTarget.replace(/^\.+/, '')}`;
}

/** 自定义域名形式的公开地址 */
export function buildCustomDomainUrl(domain: string, slug: string): string {
  return `https://${domain}/p/${encodeURIComponent(slug)}`;
}

/**
 * 计算展示页当前的公开访问地址。
 * 只有域名验证通过后才会使用自定义域名，否则回退平台默认地址
 * —— 对应验收项「未经验证的域名不能直接绑定」。
 */
export function resolvePublicUrl(
  slug: string,
  state: DomainBindingState,
  options: HostingOptions,
): { url: string; kind: 'default' | 'custom_domain'; note: string } {
  if (options.allowCustomDomain && isDomainActive(state) && state.customDomain) {
    return {
      url: buildCustomDomainUrl(state.customDomain, slug),
      kind: 'custom_domain',
      note: '使用已通过所有权验证的自定义域名',
    };
  }

  if (options.allowCustomDomain && state.customDomain && !isDomainActive(state)) {
    return {
      url: buildDefaultPublicUrl(options.publicBaseUrl, slug),
      kind: 'default',
      note: `自定义域名 ${state.customDomain} 尚未通过所有权验证，暂时使用平台默认地址`,
    };
  }

  return {
    url: buildDefaultPublicUrl(options.publicBaseUrl, slug),
    kind: 'default',
    note: '使用平台默认发布地址',
  };
}

/** 生成域名验证用的 DNS TXT 记录指引 */
export function domainVerificationInstructions(
  domain: string,
  token: string,
  prefix: string,
): { recordType: 'TXT'; recordName: string; recordValue: string; steps: string[] } {
  if (!isValidDomain(domain)) {
    throw conflict(`域名格式不合法：${domain}`);
  }
  return {
    recordType: 'TXT',
    recordName: domain,
    recordValue: `${prefix}=${token}`,
    steps: [
      `登录 ${domain} 的 DNS 管理后台`,
      `新增一条 TXT 记录，主机记录为 @，值为 ${prefix}=${token}`,
      '保存后等待 DNS 生效（通常几分钟到几小时）',
      '回到本页面点击「验证域名」',
    ],
  };
}

/** 子域名可用性检查（保留字与长度） */
const RESERVED_LABELS = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'smtp', 'ftp', 'cdn', 'static', 'assets',
  'test', 'staging', 'dev', 'prod', 'status', 'docs', 'help', 'support',
]);

export function validateSubdomainLabel(label: string): string {
  const normalized = normalizeDomainLabel(label);
  if (normalized === '') {
    throw conflict('子域名不能为空，且只能包含字母、数字与连字符');
  }
  if (normalized.length < 2) {
    throw conflict('子域名至少 2 个字符');
  }
  if (RESERVED_LABELS.has(normalized)) {
    throw conflict(`子域名 ${normalized} 为系统保留名称，请更换`);
  }
  return normalized;
}
