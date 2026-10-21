/**
 * AI 能力契约与用量类型。
 *
 * 【当前实现的诚实说明】
 * 本阶段**没有接入任何真实模型服务**（用户明确禁止调用真实付费 AI）。
 * 落地的是一个可替换的 Provider 接口 + 一个确定性 Mock Provider，
 * 用于把「额度判定 → 任务登记 → 用量结算 → 幂等」这条链路真实跑通并测试。
 * 真实供应商接入时只需新增一个实现 `AiProvider` 的模块，其余代码不动。
 */

/** 任务类型 */
export type AiTaskKind = 'generate' | 'revise';

/** 任务终态 */
export type AiTaskStatus = 'succeeded' | 'failed' | 'rejected';

/**
 * 一次模型调用的真实用量。
 *
 * 【安全要点】这个对象**只能由服务端的 Provider 产生**。
 * 浏览器提交的任何 token 数字一律不采信 —— 用户明确要求
 * 「必须使用服务端可信的模型调用结果记录用量」。
 */
export interface AiUsageReport {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 成本，单位：百万分之一货币单位（避免浮点误差） */
  costMicros: number;
}

/** 调用输入 */
export interface AiCallInput {
  taskId: string;
  kind: AiTaskKind;
  /** 用户侧的原始需求描述 */
  prompt: string;
  /**
   * 平台附加给模型的**系统指令**（约束、格式要求等）。
   *
   * 【为什么要与 prompt 分开】
   * 两者的性质不同：prompt 是用户说的话，instructions 是平台对输出格式的约束。
   * 早期版本把约束直接拼在 prompt 后面，后果是：
   *   - 约束出现在「用户消息」里，模型更容易把它当成内容的一部分；
   *   - Mock 这类按输入文本解析的实现会把整段约束当成用户输入（实测中
   *     它把约束模板写进了页面标题）。
   * 分开之后，真实 provider 把它放进 system 消息（那是它该在的位置），
   * 而 Mock 只读 prompt，不受影响。
   */
  instructions?: string;
  /** 该插件当前的结构化规格（供模型做局部修改，而不是整页重写） */
  currentSpec?: Record<string, unknown>;
  /** 插件提供的字段清单，用于约束输出结构 */
  fields?: readonly { key: string; label: string; kind: string }[];
  /** 单次调用的输出上限 */
  maxOutputTokens: number;
}

/** 调用结果 */
export interface AiCallResult {
  /** 结构化的字段补丁：只包含要改的键，而不是整份规格 */
  patch: Record<string, unknown>;
  usage: AiUsageReport;
  /** 供应商与模型标识（记入台账） */
  provider: string;
  model: string;
}

/** AI 供应商接口 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** 是否是可用的真实供应商（false 表示 mock） */
  readonly live: boolean;
  call(input: AiCallInput): Promise<AiCallResult>;
}

/** 用量结算输入 */
export interface SettleInput {
  taskId: string;
  userId: string;
  projectId: string | null;
  kind: AiTaskKind;
  status: AiTaskStatus;
  usage: AiUsageReport;
  provider: string;
  model: string;
  failureReason?: string;
}

/** 一次任务占用的额度（用于前置检查） */
export interface QuotaSnapshot {
  tier: string;
  /** 周期内已用 Token */
  tokensUsed: number;
  /** 周期内已用生成次数 */
  generationsUsed: number;
  /** 周期内已用修改次数 */
  revisionsUsed: number;
  /** 当前项目数 */
  projectsUsed: number;
}