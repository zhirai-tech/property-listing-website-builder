/**
 * 结构化日志。
 *
 * 安全要求（方案第六章第 8 条）：密钥不得出现在日志里。
 * 因此这里对敏感字段名做统一脱敏，而不是依赖每个调用点自觉。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|authorization|cookie|session)/i;

export const REDACTED = '[已脱敏]';

/** 递归脱敏：命中敏感键名的值一律替换 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[深度超限]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level: LogLevel;
  /** 输出目标，默认 process.stdout；测试中可替换为收集器 */
  sink?: (line: string) => void;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const build = (bindings: Record<string, unknown>): Logger => {
    const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level]) return;
      const payload = {
        at: new Date().toISOString(),
        level,
        message,
        ...(redact(bindings) as Record<string, unknown>),
        ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
      };
      sink(JSON.stringify(payload));
    };

    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (extra) => build({ ...bindings, ...extra }),
    };
  };

  return build({});
}
