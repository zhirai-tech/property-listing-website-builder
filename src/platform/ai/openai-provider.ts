/**
 * OpenAI 兼容的 AI Provider。
 *
 * 【为什么是「OpenAI 兼容」而不是绑死某一家】
 * 绝大多数供应商（含自建的本地推理服务）都实现了同一套
 * `POST {baseUrl}/chat/completions` 协议。写一个适配层，
 * 换供应商只需要改 baseUrl / model，不需要改代码。
 *
 * 【本阶段刻意没做的事】
 * **没有配置任何真实 API Key，也没有向任何真实供应商发过请求。**
 * 这个文件的存在是为了让「真的去调一个模型」这段链路可替换、可测试；
 * 它的行为由**本地假上游**验证（见 tests/platform/ai-provider.test.ts）。
 *
 * 【用量必须来自上游】
 * 上游返回的 `usage.prompt_tokens` / `completion_tokens` 是**唯一**可信来源。
 * 拿不到就报错让任务失败、零扣费 —— 见 `requireUsage` 的说明。
 * 绝不估算、绝不用字符数顶替，因为那样额度控制就是假的。
 */

import type { AiCallInput, AiCallResult, AiProvider, AiUsageReport } from './types.ts';

export interface OpenAiCompatibleOptions {
  /** 上游名称，记入台账用于区分不同供应商 */
  name?: string;
  /** 形如 https://api.example.com/v1（末尾斜杠可有可无） */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** 拿不到 usage 时是否视为失败；默认 true */
  requireUsage?: boolean;
  /** 注入 fetch，便于测试 */
  fetchImpl?: typeof fetch;
}

/** 上游返回结构里我们真正会读的字段 */
interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  error?: { message?: unknown };
}

export class AiProviderError extends Error {
  /** 便于上层区分「上游错误」与「我们自己的 bug」 */
  readonly kind: 'timeout' | 'http' | 'protocol' | 'usage_missing' | 'network';
  readonly status?: number;

  constructor(kind: AiProviderError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'AiProviderError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

function toCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * 从上游响应里读出用量。
 *
 * 三家字段名略有差异（有的只有 total_tokens），因此：
 *   - prompt/completion 缺失时按 0 处理，但 **total 必须能算出来**；
 *   - total 缺失时用 prompt+completion 补齐；
 *   - 两个都没有 → 返回 null，由调用方决定是失败还是放行。
 */
export function readUsage(raw: ChatCompletionResponse['usage']): AiUsageReport | null {
  if (!raw || typeof raw !== 'object') return null;

  const prompt = toCount(raw.prompt_tokens);
  const completion = toCount(raw.completion_tokens);
  const total = toCount(raw.total_tokens);

  if (prompt === null && completion === null && total === null) return null;

  const inputTokens = prompt ?? 0;
  const outputTokens = completion ?? 0;
  const totalTokens = total ?? inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    // 成本由供应商决定；OpenAI 兼容协议不在响应里返回费用，
    // 因此这里记 0，由上游账单口径另行核算。**不猜测单价。**
    costMicros: 0,
  };
}

/**
 * 从模型输出里取出结构化补丁。
 *
 * 要求模型返回一个 JSON 对象。模型经常把 JSON 包在 ```json 代码块里，
 * 这里做一次宽松提取；仍然拿不到合法 JSON 就当任务失败 ——
 * 因为无法把一段自然语言「应用」到结构化规格上。
 */
export function parsePatch(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'string') return null;

  let text = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  // 退化处理：截取第一个 { 到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildSystemPrompt(input: AiCallInput): string {
  const fieldList = (input.fields ?? [])
    .map((f) => `- ${f.key}（${f.label}，${f.kind}）`)
    .join('\n');

  return [
    '你是一个网页内容助手。根据用户要求，输出**只包含需要修改的字段**的 JSON 对象。',
    '不要输出解释文字，不要输出整个页面，只输出 JSON。',
    '只能使用下面列出的字段键，不要发明新键：',
    fieldList || '（本次没有可编辑字段）',
    input.currentSpec ? `当前内容：${JSON.stringify(input.currentSpec)}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): AiProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const requireUsage = options.requireUsage ?? true;
  const name = options.name ?? 'openai-compatible';

  return {
    name,
    model: options.model,
    // 这个是真实供应商（会发网络请求），与 mock 区分开
    live: true,

    async call(input: AiCallInput): Promise<AiCallResult> {
      const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 密钥只放在请求头里，绝不写进日志或错误信息
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages: [
              {
                role: 'system',
                // 平台的格式约束放 system；用户的话放 user。两者不混。
                content: input.instructions
                  ? `${buildSystemPrompt(input)}\n\n${input.instructions}`
                  : buildSystemPrompt(input),
              },
              { role: 'user', content: input.prompt },
            ],
            max_tokens: input.maxOutputTokens,
            temperature: 0.2,
            // 要求结构化输出，降低解析失败率
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const isAbort = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new AiProviderError(
          isAbort ? 'timeout' : 'network',
          isAbort ? `上游超时（${timeoutMs}ms）` : `无法连接上游：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 错误响应体里可能带供应商的说明，但**不能原样透出给用户**（可能含内部信息）
      if (!response.ok) {
        let detail = '';
        try {
          const body = (await response.json()) as ChatCompletionResponse;
          if (typeof body.error?.message === 'string') detail = body.error.message.slice(0, 200);
        } catch {
          // 响应体不是 JSON，忽略
        }
        throw new AiProviderError('http', `上游返回 ${response.status}${detail ? `：${detail}` : ''}`, response.status);
      }

      let body: ChatCompletionResponse;
      try {
        body = (await response.json()) as ChatCompletionResponse;
      } catch {
        throw new AiProviderError('protocol', '上游返回的不是合法 JSON');
      }

      const patch = parsePatch(body.choices?.[0]?.message?.content);
      if (patch === null) {
        throw new AiProviderError('protocol', '模型输出不是可解析的 JSON 对象');
      }

      const usage = readUsage(body.usage);
      if (usage === null) {
        if (requireUsage) {
          // 拿不到用量就失败：放过去等于这次调用不记账，额度控制形同虚设
          throw new AiProviderError('usage_missing', '上游未返回用量信息，无法计费，本次调用不计入额度');
        }
        return {
          patch,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
          provider: name,
          model: options.model,
        };
      }

      return { patch, usage, provider: name, model: options.model };
    },
  };
}