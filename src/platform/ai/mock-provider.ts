/**
 * 确定性 Mock AI Provider。
 *
 * 【这是 Mock，不是真实模型】
 * 它的用途是把「额度 → 任务 → 用量 → 结算 → 幂等」整条链路真实跑通并测试，
 * 而**不产生任何网络请求、不调用任何付费服务**。
 * 它产出的用量数字是**根据输入长度算出来的确定性值**，
 * 不是真实模型的 token 计量 —— 台账里会记录 `provider: 'mock'`，可据此区分。
 *
 * 真实供应商接入时新增一个实现 `AiProvider` 的模块即可，
 * 额度、台账、幂等这些逻辑完全不需要改动。
 */

import type { AiCallInput, AiCallResult, AiProvider } from './types.ts';

/** 粗略的中英文字符估算 —— 仅用于 Mock，不用于真实计费 */
function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 128) ascii += 1;
    else nonAscii += 1;
  }
  // 英文约 4 字符/token，中文约 1 字符/token
  return Math.ceil(ascii / 4) + nonAscii;
}

/**
 * 从用户描述里抽取「键: 值」形式的字段补丁。
 *
 * 这样做是为了让 Mock 的输出**结构化且可验证**，
 * 同时也符合用户要求的「修改时采用局部修改，不要每次从头生成整个项目」——
 * 返回的是 patch，不是整份规格。
 */
function extractPatch(input: AiCallInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const known = new Set((input.fields ?? []).map((f) => f.key));

  for (const line of input.prompt.split(/[\n;；]/)) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_.]*)\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    if (known.size > 0 && !known.has(key)) continue; // 只接受插件声明过的字段
    const value = m[2] as string;
    patch[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }

  // 没解析出结构化字段时，退化为对标题的一句话修改建议
  if (Object.keys(patch).length === 0 && known.has('title')) {
    patch.title = input.prompt.trim().slice(0, 60) || '未命名页面';
  }
  return patch;
}

export function createMockProvider(options: { model?: string } = {}): AiProvider {
  const model = options.model ?? 'mock-deterministic-v1';
  return {
    name: 'mock',
    model,
    live: false,
    async call(input: AiCallInput): Promise<AiCallResult> {
      const patch = extractPatch(input);
      const promptTokens = estimateTokens(input.prompt);
      const contextTokens = input.currentSpec ? estimateTokens(JSON.stringify(input.currentSpec)) : 0;
      const outputTokens = Math.min(estimateTokens(JSON.stringify(patch)), input.maxOutputTokens);

      return {
        patch,
        usage: {
          inputTokens: promptTokens + contextTokens,
          outputTokens,
          totalTokens: promptTokens + contextTokens + outputTokens,
          // Mock 不计费。真实供应商在此填写真实成本。
          costMicros: 0,
        },
        provider: 'mock',
        model,
      };
    },
  };
}

/** 判断某个 provider 是否是 mock —— 报告与台账据此区分「模拟」与「真实」 */
export function isMockProvider(provider: AiProvider): boolean {
  return !provider.live;
}