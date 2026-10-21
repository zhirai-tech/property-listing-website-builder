/**
 * 领域错误类型。
 *
 * 方案第六章第 5、6 条要求：错误输入必须有明确提示，失败要能回滚并说明原因。
 * 因此所有可预期的业务失败都通过 DomainError 表达，并携带机器可读 code 与
 * 可直接展示的中文提示，避免上层各处自行拼接错误消息。
 */

export type DomainErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'UNPROCESSABLE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'RATE_LIMITED'
  /** 服务端自身故障（不是调用方的问题，也不是外部依赖故障） */
  | 'INTERNAL';

export interface FieldIssue {
  /** 字段路径，例如 priceAmount */
  field: string;
  /** 面向用户的中文说明 */
  message: string;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly issues: FieldIssue[];
  readonly httpStatus: number;

  constructor(
    code: DomainErrorCode,
    message: string,
    options: { issues?: FieldIssue[]; httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.issues = options.issues ?? [];
    this.httpStatus = options.httpStatus ?? defaultHttpStatus(code);
  }

  /** 转换为可直接返回给前端的结构 */
  toResponse(): { error: { code: DomainErrorCode; message: string; issues: FieldIssue[] } } {
    return {
      error: { code: this.code, message: this.message, issues: this.issues },
    };
  }
}

function defaultHttpStatus(code: DomainErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'FORBIDDEN':
      return 403;
    case 'UNPROCESSABLE':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'DEPENDENCY_UNAVAILABLE':
      return 503;
    case 'INTERNAL':
      return 500;
    default:
      return 500;
  }
}

/** 字段校验失败 */
export function validationFailed(
  issues: FieldIssue[],
  message = '输入内容有误，请检查后重试',
): DomainError {
  return new DomainError('VALIDATION_FAILED', message, { issues });
}

/** 实体不存在 */
export function notFound(what: string, id?: string): DomainError {
  return new DomainError('NOT_FOUND', id ? `${what}不存在：${id}` : `${what}不存在`);
}

/** 状态冲突，例如 slug 重复、绑定未验证域名 */
export function conflict(message: string, issues: FieldIssue[] = []): DomainError {
  return new DomainError('CONFLICT', message, { issues });
}

/** 业务规则不允许，例如未发布房源不可公开访问 */
export function unprocessable(message: string, issues: FieldIssue[] = []): DomainError {
  return new DomainError('UNPROCESSABLE', message, { issues });
}

export function forbidden(message = '没有权限执行该操作'): DomainError {
  return new DomainError('FORBIDDEN', message);
}

/** 外部服务故障（地图、邮件、DNS 等）—— 方案第三章第 6 条要求故障时可降级 */
export function dependencyUnavailable(what: string, cause?: unknown): DomainError {
  return new DomainError('DEPENDENCY_UNAVAILABLE', `${what}暂时不可用，请稍后重试`, { cause });
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
