/**
 * AI 能力的**部署前自检**。
 *
 * 【为什么需要它】
 * 这个平台的默认配置是 `AI_PROVIDER=mock` —— 一个不产生网络请求、不花钱的实现。
 * 好处是不会误触发付费调用；代价是**它并不能真的生成页面**：
 *   - 模式 B（自由页面）：Mock 不理解页面生成的提示词模板，产不出 html；
 *   - 模式 A（房源字段）：Mock 只能从「键: 值」里抽字段，稍微复杂的要求就抽不到东西。
 *
 * 于是会出现一种很难查的情况：**部署者启动服务、打开界面、试了一下，
 * 以为「AI 功能坏了」—— 而系统从头到尾没有告诉他「你需要配置 AI_PROVIDER」**。
 *
 * 这个模块把「AI 到底能不能用」变成一个明确的、可查询的事实，
 * 在启动日志和诊断接口里都能看到。
 */

export interface AiReadiness {
  /** 就绪 / 降级 */
  status: 'ready' | 'degraded';
  /** 实际生效的供应商 */
  provider: string;
  /** 一句话结论 */
  summary: string;
  /** 需要部署者做的事；就绪时为空数组 */
  actions: string[];
  /** 模式能力：哪些生成方式在当前配置下是可用的 */
  capabilities: {
    /** 模式 B：自由描述生成页面 */
    freeFormPage: boolean;
    /** 模式 A：按字段生成/修改 */
    fieldEdit: boolean;
  };
}

export interface AiConfigLike {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function checkAiReadiness(config: AiConfigLike): AiReadiness {
  const isMock = config.provider !== 'openai';

  if (!isMock) {
    const missing: string[] = [];
    if (config.baseUrl.trim() === '') missing.push('AI_BASE_URL');
    if (config.apiKey.trim() === '') missing.push('AI_API_KEY');
    if (config.model.trim() === '') missing.push('AI_MODEL');

    if (missing.length > 0) {
      // 声明了 openai 但配置不全 —— 实际会退回 mock
      return {
        status: 'degraded',
        provider: 'mock',
        summary: `配置了 AI_PROVIDER=openai，但缺少 ${missing.join(' / ')}，实际已退回 mock，不会发出任何真实请求。`,
        actions: missing.map((k) => `设置环境变量 ${k}`),
        capabilities: { freeFormPage: false, fieldEdit: true },
      };
    }

    return {
      status: 'ready',
      provider: 'openai',
      summary: `AI 已就绪：使用 ${config.model}（${config.baseUrl}）。`,
      actions: [],
      capabilities: { freeFormPage: true, fieldEdit: true },
    };
  }

  return {
    status: 'degraded',
    provider: 'mock',
    summary:
      '当前使用内置的模拟 AI（mock）：不会发出任何网络请求、不产生费用，但无法真正生成网页。' +
      '「自定义单页」功能在此配置下不可用。',
    actions: [
      '若要启用真实生成能力，设置 AI_PROVIDER=openai',
      '并同时提供 AI_BASE_URL / AI_API_KEY / AI_MODEL 三项',
    ],
    capabilities: { freeFormPage: false, fieldEdit: true },
  };
}