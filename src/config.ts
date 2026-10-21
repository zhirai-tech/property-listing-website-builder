/**
 * 运行配置加载与校验。
 *
 * 安全要求（方案第六章第 8 条 / 第八章第 1 条）：
 *  - 密钥只从环境变量读取，绝不写入代码或前端；
 *  - 所有外部服务都有明确配置边界；
 *  - 生产环境使用默认口令时直接拒绝启动。
 */

import { checkAiReadiness } from './platform/ai/readiness.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AreaUnit } from './domain/types.ts';
import { AREA_UNITS } from './domain/types.ts';

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  publicBaseUrl: string;

  dataDir: string;
  databaseFile: string;
  uploadDir: string;
  backupDir: string;

  adminPassword: string;
  sessionSecret: string;

  /**
   * 是否信任反向代理传来的 X-Forwarded-For。
   *
   * 【为什么默认 false】
   * 审计发现：`trustProxy: true` + 用 `request.ip` 做限流键，
   * 等于**把限流键交给客户端**（任意伪造 XFF 即可无限尝试口令）。
   * 因此默认不信任；只有确实部署在可信反向代理后面时才通过
   * `TRUST_PROXY=true` 显式打开。
   */
  trustProxy: boolean;

  /**
   * AI 供应商配置。
   *
   * 【默认值刻意保守】`provider` 缺省是 `mock` ——
   * 一个不产生任何网络请求、不花任何钱的确定性实现。
   * 只有显式配置 `AI_PROVIDER=openai` 且给了 baseUrl / apiKey / model，
   * 才会真的去调一个 HTTP 上游。这样「误触发付费调用」需要人为配置错误才可能发生。
   */
  ai: {
    /** 'mock' | 'openai' */
    provider: string;
    /** OpenAI 兼容的 base URL，例如 https://api.example.com/v1 */
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    /**
     * 是否要求上游返回 usage。
     *
     * 默认 `true`：**拿不到用量就让任务失败、零扣费**，而不是估算一个数字记上去。
     * 用户明确要求「不得用估算数字冒充真实消耗」。
     * 开着它意味着：一个不返回 usage 的上游无法用来提供服务 —— 这是刻意的，
     * 因为把无法计量的调用放过去，等于额度控制失效。
     */
    requireUsage: boolean;
  };

  /**
   * 新页面短链的风格。
   *
   * `unicode`（默认）—— 沿用既有行为：中文标题生成中文短链
   *   （例如 `/s/浦东新区三居室`）。浏览器地址栏里可读。
   *   代价：复制到微信/短信等通道时会变成 `%E6%B5%A6...`。
   *
   * `ascii` —— 中文标题生成 `page-<短标识>`（例如 `/s/page-a3f9k2`）。
   *   可读性差，但**链接在任何通道里都能原样复制粘贴**。
   *
   * 【为什么做成配置而不是直接改默认】
   * 保留 Unicode 是原项目里**写明了理由**的决定（见 util/slug.ts 的注释：
   * 「中文/日文等标题不会被清空」），而且既有页面已经用了中文短链、
   * 那些链接可能已经分享出去。单方面改默认会动到别人已经在用的地址。
   * 因此默认保持原样，需要 ASCII 的部署者用 `SLUG_STYLE=ascii` 打开。
   *
   * 无论选哪种，**已经存在的短链都保持原样、继续可用**。
   */
  slugStyle: 'unicode' | 'ascii';

  /** 登录/注册限流参数 */
  rateLimit: {
    /** 单键（单个 IP）窗口内允许的失败次数 */
    maxAttempts: number;
    /** 失败统计窗口 */
    windowMs: number;
    /** 超限后的封禁时长 */
    blockMs: number;
    /** **全局**窗口内允许的失败总次数（防 IP 轮换绕过单键限流） */
    globalMaxAttempts: number;
    /** 全局窗口时长 */
    globalWindowMs: number;
  };

  workspace: {
    name: string;
    ownerEmail: string;
    defaultLocale: string;
    defaultCurrency: string;
    defaultAreaUnit: AreaUnit;
    defaultTimezone: string;
  };

  upload: {
    maxUploadBytes: number;
    maxPhotosPerProperty: number;
    maxVideoBytes: number;
  };

  map: {
    provider: string;
    tileUrl: string;
    attribution: string;
    apiKey: string;
    freeTierNote: string;
    /** 周边信息查询端点（Overpass 兼容），可按地区替换为自建或本地服务 */
    overpassEndpoint: string;
  };

  storage: {
    provider: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };

  mail: {
    provider: string;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPassword: string;
    from: string;
  };

  hosting: {
    provider: string;
    cnameTarget: string;
    domainVerifyPrefix: string;
  };

  reminders: {
    day1: number;
    day2: number;
    maxAttempts: number;
    dispatchIntervalMinutes: number;
    /** 提醒收件邮箱；留空则回退到工作区所有者邮箱 */
    recipient: string;
  };

  backupRetentionDays: number;

  /**
   * 超过多少天未更新房源，展示页就把状态标为「未确认」。
   * 设为 0 表示关闭自动判定（只显示房东声明的是否已租）。
   */
  listingStaleDays: number;

  /**
   * 仅开发/验收用的「时间旅行」开关。
   * 打开后使用可控时钟，可在浏览器里直接把时间推进到第 7/15 天，
   * 用于演示与验收提醒规则（方案第 7 阶段：不需要真实等待）。
   * 生产环境强制关闭。
   */
  devTimeTravel: boolean;
}

/**
 * 极简 .env 解析：不引入依赖，仅在变量尚未存在时写入。
 * 已存在的真实环境变量优先级更高，便于容器/CI 覆盖。
 */
export function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // 去除成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function str(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`环境变量 ${key} 必须是整数，当前值：${raw}`);
  }
  return parsed;
}

function resolvePath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

export interface LoadConfigOptions {
  /** 项目根目录，用于解析相对路径；默认 process.cwd() */
  rootDir?: string;
  /** 是否读取 .env 文件，默认 true */
  readEnvFile?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const root = options.rootDir ?? process.cwd();

  if (options.readEnvFile !== false) {
    loadDotEnv(resolve(root, '.env'));
  }

  const envRaw = str('NODE_ENV', 'development');
  const env: AppConfig['env'] =
    envRaw === 'production' || envRaw === 'test' ? envRaw : 'development';

  const areaUnitRaw = str('DEFAULT_AREA_UNIT', 'square_meter');
  const defaultAreaUnit: AreaUnit = (AREA_UNITS as readonly string[]).includes(areaUnitRaw)
    ? (areaUnitRaw as AreaUnit)
    : 'square_meter';

  const dataDir = resolvePath(root, str('DATA_DIR', './var'));

  const config: AppConfig = {
    env,
    port: int('PORT', 3000),
    host: str('HOST', '127.0.0.1'),
    publicBaseUrl: str('PUBLIC_BASE_URL', 'http://127.0.0.1:3000').replace(/\/+$/g, ''),

    dataDir,
    databaseFile: resolvePath(root, str('DATABASE_FILE', './var/db/app.sqlite')),
    uploadDir: resolvePath(root, str('UPLOAD_DIR', './var/uploads')),
    backupDir: resolvePath(root, str('BACKUP_DIR', './var/backups')),

    adminPassword: str('ADMIN_PASSWORD', 'change-me-in-production'),
    sessionSecret: str('SESSION_SECRET', 'please-generate-a-long-random-session-secret-32chars'),

    // AI 供应商：默认 mock，不产生任何网络请求。
    // 只有显式设置 AI_PROVIDER=openai 才会真的去调上游。
    ai: {
      provider: str('AI_PROVIDER', 'mock').toLowerCase(),
      baseUrl: str('AI_BASE_URL', ''),
      apiKey: str('AI_API_KEY', ''),
      model: str('AI_MODEL', ''),
      timeoutMs: int('AI_TIMEOUT_MS', 60_000),
      requireUsage: str('AI_REQUIRE_USAGE', 'true').toLowerCase() !== 'false',
    },

    // 短链风格：默认沿用既有行为（中文短链），可用 SLUG_STYLE=ascii 切换
    slugStyle: str('SLUG_STYLE', 'unicode').toLowerCase() === 'ascii' ? 'ascii' : 'unicode',

    // 默认不信任代理：见 AppConfig.trustProxy 的说明。
    // 只有确实部署在可信反向代理后面时才设 TRUST_PROXY=true。
    trustProxy: str('TRUST_PROXY', 'false').toLowerCase() === 'true',

    rateLimit: {
      maxAttempts: int('RATE_LIMIT_MAX_ATTEMPTS', 5),
      windowMs: int('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
      blockMs: int('RATE_LIMIT_BLOCK_MS', 15 * 60 * 1000),
      // 全局上限刻意比单键宽松得多：正常使用不该撞到它，
      // 但 IP 轮换式的爆破会在几百次内被挡住。
      globalMaxAttempts: int('RATE_LIMIT_GLOBAL_MAX_ATTEMPTS', 60),
      globalWindowMs: int('RATE_LIMIT_GLOBAL_WINDOW_MS', 15 * 60 * 1000),
    },

    workspace: {
      name: str('DEFAULT_WORKSPACE_NAME', '我的房源工作区'),
      ownerEmail: str('OWNER_EMAIL', 'owner@example.com'),
      defaultLocale: str('DEFAULT_LOCALE', 'zh-CN'),
      defaultCurrency: str('DEFAULT_CURRENCY', 'CNY').toUpperCase(),
      defaultAreaUnit,
      defaultTimezone: str('DEFAULT_TIMEZONE', 'Asia/Shanghai'),
    },

    upload: {
      maxUploadBytes: int('MAX_UPLOAD_BYTES', 15 * 1024 * 1024),
      maxPhotosPerProperty: int('MAX_PHOTOS_PER_PROPERTY', 30),
      maxVideoBytes: int('MAX_VIDEO_BYTES', 200 * 1024 * 1024),
    },

    map: {
      provider: str('MAP_PROVIDER', 'osm'),
      tileUrl: str('MAP_TILE_URL', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
      attribution: str('MAP_ATTRIBUTION', '© OpenStreetMap contributors'),
      apiKey: str('MAP_API_KEY', ''),
      freeTierNote: str('MAP_FREE_TIER_NOTE', ''),
      overpassEndpoint: str('MAP_OVERPASS_ENDPOINT', 'https://overpass-api.de/api/interpreter'),
    },

    storage: {
      provider: str('STORAGE_PROVIDER', 'local'),
      bucket: str('STORAGE_BUCKET', ''),
      accessKey: str('STORAGE_ACCESS_KEY', ''),
      secretKey: str('STORAGE_SECRET_KEY', ''),
    },

    mail: {
      provider: str('MAIL_PROVIDER', 'console'),
      smtpHost: str('SMTP_HOST', ''),
      smtpPort: int('SMTP_PORT', 587),
      smtpUser: str('SMTP_USER', ''),
      smtpPassword: str('SMTP_PASSWORD', ''),
      from: str('MAIL_FROM', 'no-reply@example.com'),
    },

    hosting: {
      provider: str('HOSTING_PROVIDER', 'default'),
      cnameTarget: str('HOSTING_CNAME_TARGET', 'listings.example.com'),
      domainVerifyPrefix: str('DOMAIN_VERIFY_PREFIX', '_property-listing-verify'),
    },

    reminders: {
      day1: int('REMINDER_DAY_1', 7),
      day2: int('REMINDER_DAY_2', 15),
      maxAttempts: int('REMINDER_MAX_ATTEMPTS', 3),
      dispatchIntervalMinutes: int('REMINDER_DISPATCH_INTERVAL_MINUTES', 60),
      recipient: str('REMINDER_RECIPIENT', ''),
    },

    backupRetentionDays: int('BACKUP_RETENTION_DAYS', 30),

    listingStaleDays: int('LISTING_STALE_DAYS', 30),

    devTimeTravel: env !== 'production' && str('DEV_TIME_TRAVEL', 'false') === 'true',
  };

  validateConfig(config);
  return config;
}

/**
 * 配置校验：把「会导致安全事故」的配置问题在启动阶段暴露，
 * 而不是等到运行时才发现密钥是默认值。
 */
export function validateConfig(config: AppConfig): void {
  const problems: string[] = [];

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(`PORT 必须在 1-65535 之间，当前：${config.port}`);
  }
  if (config.reminders.day1 <= 0 || config.reminders.day2 <= config.reminders.day1) {
    problems.push('提醒天数必须满足 0 < REMINDER_DAY_1 < REMINDER_DAY_2');
  }
  if (config.upload.maxUploadBytes <= 0) {
    problems.push('MAX_UPLOAD_BYTES 必须为正数');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.workspace.defaultTimezone });
  } catch {
    problems.push(`DEFAULT_TIMEZONE 不是有效的 IANA 时区：${config.workspace.defaultTimezone}`);
  }

  if (config.env === 'production') {
    if (config.adminPassword === 'change-me-in-production') {
      problems.push('生产环境必须修改 ADMIN_PASSWORD，不能使用示例默认口令');
    }
    if (config.adminPassword.length < 12) {
      problems.push('生产环境 ADMIN_PASSWORD 长度至少 12 位');
    }
    if (config.sessionSecret.startsWith('please-generate')) {
      problems.push('生产环境必须设置真实的 SESSION_SECRET');
    }
    if (config.sessionSecret.length < 32) {
      problems.push('SESSION_SECRET 长度至少 32 字符');
    }
    if (config.publicBaseUrl.startsWith('http://')) {
      problems.push('生产环境 PUBLIC_BASE_URL 应使用 https://');
    }
  }

  if (problems.length > 0) {
    throw new Error(`配置校验失败：\n  - ${problems.join('\n  - ')}`);
  }
}

/** 确保运行期目录存在 */
export function ensureRuntimeDirs(config: AppConfig): void {
  for (const dir of [
    config.dataDir,
    dirname(config.databaseFile),
    config.uploadDir,
    config.backupDir,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/**
 * 脱敏后的配置快照，可安全写日志或返回给前端。
 * 方案第六章第 8 条：密钥不得暴露。
 */
export function redactedConfig(config: AppConfig): Record<string, unknown> {
  const secret = (value: string): string => (value === '' ? '(未设置)' : '已设置');
  return {
    env: config.env,
    port: config.port,
    host: config.host,
    publicBaseUrl: config.publicBaseUrl,
    trustProxy: config.trustProxy,
    rateLimit: config.rateLimit,
    databaseFile: config.databaseFile,
    workspace: config.workspace,
    map: {
      provider: config.map.provider,
      tileUrl: config.map.tileUrl,
      attribution: config.map.attribution,
      apiKey: secret(config.map.apiKey),
      freeTierNote: config.map.freeTierNote,
    },
    ai: {
      provider: config.ai.provider,
      baseUrl: config.ai.baseUrl,
      // 密钥必须脱敏：这个对象会被诊断接口返回
      apiKey: secret(config.ai.apiKey),
      model: config.ai.model,
      timeoutMs: config.ai.timeoutMs,
      requireUsage: config.ai.requireUsage,
    },
    // 「AI 到底能不能用」必须是一个一眼能看到的事实 ——
    // 否则部署者会以为「AI 功能坏了」，而系统从来不告诉他原因。
    aiReadiness: checkAiReadiness(config.ai),
    storage: {
      provider: config.storage.provider,
      bucket: config.storage.bucket,
      accessKey: secret(config.storage.accessKey),
      secretKey: secret(config.storage.secretKey),
    },
    mail: {
      provider: config.mail.provider,
      smtpHost: config.mail.smtpHost,
      smtpPort: config.mail.smtpPort,
      smtpUser: config.mail.smtpUser,
      smtpPassword: secret(config.mail.smtpPassword),
      from: config.mail.from,
    },
    hosting: config.hosting,
    reminders: config.reminders,
    adminPassword: secret(config.adminPassword),
    sessionSecret: secret(config.sessionSecret),
  };
}
