/**
 * 托管适配器（方案第三章第 8 条、第 6 阶段验收）。
 */

import { dependencyUnavailable } from '../domain/errors.ts';
import type { DnsResolver } from './dns.ts';
import { flattenTxtRecords } from './dns.ts';
import type { DomainBindingState } from '../domain/listing-page.ts';
import {
  buildCustomDomainUrl,
  buildDefaultPublicUrl,
  domainVerificationInstructions,
} from '../domain/hosting.ts';

export interface PublicUrlResult {
  url: string;
  kind: 'default' | 'custom_domain';
  note: string;
}

export interface DomainVerificationResult {
  verified: boolean;
  detail: string;
  /** 实际查询到的 TXT 记录，便于用户排查 */
  found: string[];
  instructions: { recordType: 'TXT'; recordName: string; recordValue: string; steps: string[] };
}

export interface HostingProvider {
  readonly name: string;
  readonly allowsCustomDomain: boolean;
  resolvePublicUrl(slug: string, state: DomainBindingState): PublicUrlResult;
  verifyDomain(
    domain: string,
    token: string,
    state: DomainBindingState,
  ): Promise<DomainVerificationResult>;
}

export interface HostingOptions {
  publicBaseUrl: string;
  cnameTarget: string;
  domainVerifyPrefix: string;
}

/** 平台默认地址：不支持自定义域名绑定 */
export class DefaultHostingProvider implements HostingProvider {
  readonly name = 'default';
  readonly allowsCustomDomain = false;
  private readonly options: HostingOptions;

  constructor(options: HostingOptions) {
    this.options = options;
  }

  resolvePublicUrl(slug: string): PublicUrlResult {
    return {
      url: buildDefaultPublicUrl(this.options.publicBaseUrl, slug),
      kind: 'default',
      note: '使用平台默认发布地址',
    };
  }

  async verifyDomain(domain: string, token: string): Promise<DomainVerificationResult> {
    return {
      verified: false,
      detail: '当前托管模式为「平台默认地址」，未启用自定义域名绑定',
      found: [],
      instructions: domainVerificationInstructions(domain, token, this.options.domainVerifyPrefix),
    };
  }
}

/** 支持自定义域名与子域名，域名必须通过 DNS TXT 记录完成所有权验证 */
export class CustomDomainHostingProvider implements HostingProvider {
  readonly name = 'custom_domain';
  readonly allowsCustomDomain = true;
  private readonly options: HostingOptions;
  private readonly dns: DnsResolver;

  constructor(options: HostingOptions, dns: DnsResolver) {
    this.options = options;
    this.dns = dns;
  }

  resolvePublicUrl(slug: string, state: DomainBindingState): PublicUrlResult {
    const instructions = domainVerificationInstructions(
      state.customDomain ?? 'example.com',
      state.domainVerifyToken ?? '',
      this.options.domainVerifyPrefix,
    );

    if (state.customDomain && state.domainVerifiedAt) {
      return {
        url: buildCustomDomainUrl(state.customDomain, slug),
        kind: 'custom_domain',
        note: '使用已通过所有权验证的自定义域名',
      };
    }

    return {
      url: buildDefaultPublicUrl(this.options.publicBaseUrl, slug),
      kind: 'default',
      note: state.customDomain
        ? `自定义域名 ${state.customDomain} 尚未通过所有权验证，暂时使用平台默认地址。验证方式：在 ${instructions.recordName} 添加 TXT 记录 ${instructions.recordValue}`
        : '使用平台默认发布地址',
    };
  }

  async verifyDomain(
    domain: string,
    token: string,
    _state: DomainBindingState,
  ): Promise<DomainVerificationResult> {
    const instructions = domainVerificationInstructions(
      domain,
      token,
      this.options.domainVerifyPrefix,
    );

    let records: string[][] = [];
    try {
      records = await this.dns.resolveTxt(domain);
    } catch (error) {
      throw dependencyUnavailable('DNS 查询', error);
    }

    const found = flattenTxtRecords(records);
    const expected = instructions.recordValue;
    const verified = found.includes(expected);

    return {
      verified,
      detail: verified
        ? `已验证 ${domain} 的所有权（TXT 记录匹配）`
        : found.length === 0
          ? `未查询到 ${domain} 的任何 TXT 记录，请先添加 ${expected}`
          : `已查询到 ${found.length} 条 TXT 记录，但没有匹配 ${expected}`,
      found,
      instructions,
    };
  }
}
