/**
 * DNS 适配器（第 6 阶段：域名所有权验证）。
 *
 * 方案第 6 阶段验收要求「完成域名所有权验证；未经验证的域名不能直接绑定」。
 * 验证方式为 DNS TXT 记录比对，因此把 DNS 查询抽象成可替换适配器：
 *  - 生产使用系统解析器；
 *  - 测试使用 FakeDnsResolver，无需真实域名即可验证整条流程。
 */

import { resolveTxt } from 'node:dns/promises';

export interface DnsResolver {
  readonly name: string;
  /** 返回 TXT 记录；每条记录可能被拆成多个字符串片段 */
  resolveTxt(domain: string): Promise<string[][]>;
}

export class SystemDnsResolver implements DnsResolver {
  readonly name = 'system';

  async resolveTxt(domain: string): Promise<string[][]> {
    try {
      return await resolveTxt(domain);
    } catch {
      // 查询失败与「没有记录」在业务上等价：一律视为未验证
      return [];
    }
  }
}

export class FakeDnsResolver implements DnsResolver {
  readonly name = 'fake';
  private readonly records = new Map<string, string[][]>();

  setTxt(domain: string, records: string[][]): void {
    this.records.set(domain.toLowerCase(), records);
  }

  clear(): void {
    this.records.clear();
  }

  async resolveTxt(domain: string): Promise<string[][]> {
    return this.records.get(domain.toLowerCase()) ?? [];
  }
}

/** 把 DNS 返回的分片记录拼回完整字符串 */
export function flattenTxtRecords(records: readonly string[][]): string[] {
  return records.map((chunks) => chunks.join(''));
}
