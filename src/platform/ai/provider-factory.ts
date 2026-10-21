/**
 * 按配置创建 AI 供应商。
 *
 * 【安全默认】未配置或配置不完整时一律返回 Mock —— 一个不发网络请求、不花钱的实现。
 * 只有 `AI_PROVIDER=openai` **且** baseUrl / apiKey / model 三者齐全，
 * 才会创建真实 provider。缺任何一项就退回 Mock 并**明确报告原因**，
 * 而不是带着半套配置去发请求（那样只会在运行时失败，且可能是意外付费）。
 */

import type { AiProvider } from './types.ts';
import { createMockProvider } from './mock-provider.ts';
import { createOpenAiCompatibleProvider } from './openai-provider.ts';

export interface AiConfigLike {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  requireUsage: boolean;
}

export interface ProviderSelection {
  provider: AiProvider;
  /** 实际生效的供应商（'mock' 或 'openai'） */
  kind: 'mock' | 'openai';
  /** 退回 Mock 时说明原因；正常时为 null */
  fallbackReason: string | null;
}

export function createProviderFromConfig(config: AiConfigLike, fetchImpl?: typeof fetch): ProviderSelection {
  if (config.provider !== 'openai') {
    return { provider: createMockProvider(), kind: 'mock', fallbackReason: null };
  }

  const missing: string[] = [];
  if (config.baseUrl.trim() === '') missing.push('AI_BASE_URL');
  if (config.apiKey.trim() === '') missing.push('AI_API_KEY');
  if (config.model.trim() === '') missing.push('AI_MODEL');

  if (missing.length > 0) {
    return {
      provider: createMockProvider(),
      kind: 'mock',
      fallbackReason: `AI_PROVIDER=openai 但缺少 ${missing.join(' / ')}，已退回 mock（不会发出任何真实请求）`,
    };
  }

  return {
    provider: createOpenAiCompatibleProvider({
      name: 'openai',
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
      requireUsage: config.requireUsage,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    kind: 'openai',
    fallbackReason: null,
  };
}