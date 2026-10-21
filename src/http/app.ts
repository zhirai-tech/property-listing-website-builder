/**
 * Fastify 应用装配。
 *
 * 设计原则：
 *  - 业务逻辑全部在 services 层，路由只做「解析输入 -> 调服务 -> 输出」；
 *  - 统一错误处理把 DomainError 转为结构化中文提示，未知错误不泄漏堆栈；
 *  - 所有响应统一附加安全头，公开页使用 per-request nonce 的 CSP。
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../app-context.ts';
import { DomainError, isDomainError } from '../domain/errors.ts';
import {
  LoginRateLimiter,
  contentSecurityPolicy,
  createNonce,
  securityHeaders,
  verifySessionToken,
} from './security.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { PUBLIC_PLATFORM_PATHS, currentPlatformUser, registerPlatformRoutes } from './routes/platform.ts';
import { registerPublicSiteRoutes } from './routes/public-sites.ts';
import { registerPublicRoutes } from './routes/public-pages.ts';
import { registerAdminAuthRoutes } from './routes/admin-auth.ts';
import { registerAdminPropertyRoutes } from './routes/admin-properties.ts';
import { registerAdminMediaRoutes } from './routes/admin-media.ts';
import { registerAdminPageRoutes } from './routes/admin-pages.ts';
import { registerAdminReminderRoutes } from './routes/admin-reminders.ts';
import { registerAdminSettingsRoutes } from './routes/admin-settings.ts';
import { registerAdminExportRoutes } from './routes/admin-export.ts';
import { registerAdminBackupRoutes } from './routes/admin-backup.ts';

declare module 'fastify' {
  interface FastifyRequest {
    cspNonce: string;
  }
}

export interface AppOptions {
  /** 覆盖静态资源目录（测试用） */
  adminDir?: string;
  /** 平台用户界面目录（默认 public/app） */
  appDir?: string;
  brandDir?: string;
}

const ADMIN_COOKIE = 'admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 无需登录即可访问的后台接口 */
const PUBLIC_ADMIN_PATHS = new Set(['/api/admin/login', '/api/admin/session']);

export async function buildApp(ctx: AppContext, options: AppOptions = {}): Promise<FastifyInstance> {
  /**
   * 自定义 JSON 解析器。
   *
   * 【为什么需要它】Fastify 默认在「Content-Type 是 JSON 但没有 body」时抛
   * `FST_ERR_CTP_EMPTY_JSON_BODY`。这带来两个问题：
   *   1. 一个没有 body 的 `DELETE` 只要带上了 `Content-Type: application/json`
   *      就会被拒 —— 而很多 HTTP 客户端会默认带上这个头。
   *      空 body 本来就表示「没有负载」，这是合法的，不该因为一个头就报错。
   *   2. 它抛出的错误会掉进兜底分支变成 **500**，于是任何客户端都能让服务端
   *      返回「服务器内部错误」—— 实测中发现后台接口也有这个问题。
   *
   * 这里把两种情况分开：
   *   - **空 body** → 解析成 `undefined`，交给 handler 的 `request.body ?? {}` 处理，
   *     由业务校验给出真正有用的提示（例如「口令不能为空」）。
   *   - **非空但非法 JSON** → 交给错误处理器，返回 **400**（客户端错误，不是服务端故障）。
   */
  const app = Fastify({
    logger: false,
    // 【默认不信任代理】
    // 审计发现：原来无条件 `trustProxy: true` + 用 `request.ip` 做限流键，
    // 等于把限流键交给客户端 —— 轮换 X-Forwarded-For 就能无限尝试口令。
    // 现在改成由配置决定，默认 false（此时 request.ip 直接取 TCP 对端地址，
    // 客户端伪造的 XFF 头不再影响限流）。
    // 确实部署在可信反向代理后面时，用 TRUST_PROXY=true 显式打开。
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    // 空 body = 没有负载，交给 handler 决定怎么处理
    if (text === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      // 非法 JSON 是客户端错误；打上 400 让错误处理器给出明确响应
      const err = error as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(cookie, { secret: ctx.config.sessionSecret });
  await app.register(multipart, {
    limits: {
      fileSize: Math.max(ctx.config.upload.maxUploadBytes, ctx.config.upload.maxVideoBytes),
      files: 1,
      fields: 20,
    },
  });

  // 注意：媒体不直接由 @fastify/static 从磁盘目录提供，
  // 而是通过存储适配器读取（见下方 /media/* 路由）。
  // 否则一旦把 STORAGE_PROVIDER 换成对象存储，展示页的图片就会全部 404。

  // 地图不再依赖任何第三方库：使用项目内置的轻量实现（src/render/mini-map.ts），
  // 因此无需托管外部资源，script-src 保持 'self' 即可。

  // 后台管理界面（纯静态 ES Module，无需构建）
  const adminDir = options.adminDir ?? join(process.cwd(), 'public', 'admin');
  if (existsSync(adminDir)) {
    await app.register(fastifyStatic, {
      root: adminDir,
      prefix: '/admin/',
      index: ['index.html'],
      decorateReply: false,
    });
  }

  // 平台用户界面（注册 / 登录 / 项目 / 编辑 / 下载），面向终端用户。
  // 与后台分开：后台是运营者工具，这里是产品本身。
  // 注意 /app/ 不在任何鉴权前缀下 —— 它是纯静态页面，
  // 页面里的每个数据请求都要带平台会话才会被放行。
  const appDir = options.appDir ?? join(process.cwd(), 'public', 'app');
  if (existsSync(appDir)) {
    await app.register(fastifyStatic, {
      root: appDir,
      prefix: '/app/',
      index: ['index.html'],
      decorateReply: false,
    });
  }

  // 品牌资源（ZHIRAI / 智睿 的图标集）。
  //
  // 【为什么单独注册一条，而不是塞进 /app/ 或 /admin/】
  // 图标是**两个界面共用**的同一套文件。放进任一目录都会产生第二份拷贝，
  // 将来换图标时必然会漏掉一份 —— 品牌资源分叉是最难发现的那类不一致。
  // 单独一个前缀，两边都引用同一份。
  //
  // 内容只有图标（png / ico / icns），不含任何用户数据或个人信息。
  const brandDir = options.brandDir ?? join(process.cwd(), 'public', 'assets', 'brand');
  if (existsSync(brandDir)) {
    await app.register(fastifyStatic, {
      root: brandDir,
      prefix: '/brand/',
      decorateReply: false,
      // 品牌资源不带索引页，也不需要目录列表
      index: false,
    });
  }

  // 限流参数来自配置（含防 IP 轮换的全局上限），不再写死在构造函数默认值里
  const limiter = new LoginRateLimiter({
    maxAttempts: ctx.config.rateLimit.maxAttempts,
    windowMs: ctx.config.rateLimit.windowMs,
    blockMs: ctx.config.rateLimit.blockMs,
    globalMaxAttempts: ctx.config.rateLimit.globalMaxAttempts,
    globalWindowMs: ctx.config.rateLimit.globalWindowMs,
  });

  // ---- 后台接口鉴权 ----
  //
  // 【为什么不能只看原始 URL 前缀】
  // 守卫原先跑在 onRequest 阶段，而 onRequest 在**路由匹配之前**执行 ——
  // 那时拿不到「路由器到底匹配了哪条路由」，只能拿 request.url 猜前缀。
  // 但 Fastify 路由用的是**解码后**的路径，两者口径不一致：
  // `/%61pi/admin/overview` 在守卫眼里不以 /api/admin/ 开头（跳过鉴权），
  // 在路由器眼里解码成 /api/admin/overview（正常命中后台路由）→ 鉴权被绕过。
  // 这不是某一个 URL 的问题，而是「守卫看的路径」与「路由器匹配的路径」
  // 是两个不同来源 —— 任何编码变体都会成为入口。
  //
  // 【修法】把权威判断放到 preHandler：
  // preHandler 在路由匹配**之后**执行，request.routeOptions.url 就是
  // 路由器实际匹配的那条路由模式（如 /api/admin/properties/:id）。
  // 用它判断，守卫与路由共用同一个事实来源，从根上消除解析差异；
  // 并且任何**新增**的 /api/admin/* 路由、任意 HTTP 方法都自动受保护。
  function isProtectedAdminRoute(normalizedPath: string): boolean {
    return normalizedPath.startsWith('/api/admin/') && !PUBLIC_ADMIN_PATHS.has(normalizedPath);
  }

  /**
   * 平台用户接口的受保护判定。
   *
   * 与后台是**两套独立会话**：后台读 admin_session、用主密钥；
   * 平台读 platform_session、用域分离后的密钥。
   * 详见 src/platform/auth.ts 顶部 —— 复用后台密钥会让注册用户拿到管理员权限。
   */
  function isProtectedPlatformRoute(normalizedPath: string): boolean {
    return normalizedPath.startsWith('/api/platform/') && !PUBLIC_PLATFORM_PATHS.has(normalizedPath);
  }

  /** 尽力解码；失败返回 null（交给 preHandler 定夺，不在这里放行） */
  function decodePathBestEffort(rawPath: string): string | null {
    try {
      return decodeURIComponent(rawPath);
    } catch {
      return null;
    }
  }

  function rejectUnauthorized(reply: FastifyReply): FastifyReply {
    return reply.code(401).send({
      error: { code: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录', issues: [] },
    });
  }

  /** 会话校验：有效期用真实时间，而不是注入的业务时钟 */
  function hasValidSession(request: FastifyRequest): boolean {
    const token = request.cookies[ADMIN_COOKIE];
    if (!token) return false;
    // 注意：会话有效期使用真实时间，而不是注入的业务时钟。
    // 否则演示用的「时间旅行」（DEV_TIME_TRAVEL）会把管理员直接登出。
    return verifySessionToken(ctx.config.sessionSecret, token, new Date()) !== null;
  }

  // ---- 全局：nonce、安全头 ----
  app.addHook('onRequest', async (request, reply) => {
    request.cspNonce = createNonce();

    // 早拒一层：对原始路径做一次尽力解码后再判断，避免未授权请求把 2MB 请求体
    // 读进来才被拒。这一层**只是提前拒绝**，不是权威判断 ——
    // 权威判断在下面的 preHandler（它用的是路由器实际匹配的路由）。
    // 解码失败时不做判断，交给 preHandler，绝不在这里放行。
    const decoded = decodePathBestEffort((request.url.split('?')[0] ?? ''));
    if (decoded !== null) {
      if (isProtectedAdminRoute(decoded) && !hasValidSession(request)) {
        return rejectUnauthorized(reply);
      }
      if (isProtectedPlatformRoute(decoded) && !currentPlatformUser(ctx, request)) {
        return rejectUnauthorized(reply);
      }
    }
  });

  // ---- 全局：后台鉴权（权威判断） ----
  app.addHook('preHandler', async (request, reply) => {
    const routeUrl = request.routeOptions?.url;
    // 没有匹配到路由时本钩子不会执行（404 由 notFoundHandler 处理）。
    if (!routeUrl) return;

    if (isProtectedAdminRoute(routeUrl)) {
      if (!hasValidSession(request)) return rejectUnauthorized(reply);
      return;
    }

    if (isProtectedPlatformRoute(routeUrl)) {
      if (!currentPlatformUser(ctx, request)) return rejectUnauthorized(reply);
    }
  });


  app.addHook('onSend', async (request, reply, payload) => {
    // 含地图的页面：公开展示页，以及后台的「预览」页（预览与公开页同源同版式）。
    // 注意：预览页也渲染内联脚本，因此必须使用同一套 nonce 策略，
    // 否则 CSP 会把预览页的交互与地图全部拦掉。
    const isMapPage =
      request.url.startsWith('/p/') ||
      /\/api\/admin\/properties\/[^/]+\/preview(\?|$)/.test(request.url) ||
      // 平台预览与后台预览渲染的是同一个页面（都含 Leaflet 地图），
      // 必须同等放宽内联样式，否则地图会因 CSP 被拦而不显示。
      /\/api\/platform\/projects\/[^/]+\/preview(\?|$)/.test(request.url);

    const headers = securityHeaders(
      contentSecurityPolicy({
        nonce: request.cspNonce,
        // 地图库已本地化提供（/vendor/leaflet），无需放行外部脚本源
        allowExternalScripts: false,
        // 含地图的页面：Leaflet 必须使用内联 style 属性
        allowInlineStyles: isMapPage,
      }),
    );

    for (const [key, value] of Object.entries(headers)) {
      // 【不要覆盖路由自己设的 CSP】
      // 某些响应需要比全局策略**更严**的策略，例如 AI 生成的自定义页面：
      // 它的 CSP 是 `default-src 'none'`（不允许任何脚本）—— 这是纵深防御的第二层。
      // 如果这里无条件覆盖，那一层就形同虚设（实测中确实如此：路由设的严格 CSP
      // 被这里盖成了全局的宽松版，而测试断言才发现）。
      // 因此：路由若已显式设置 CSP，以路由为准。
      if (key === 'Content-Security-Policy' && reply.getHeader('content-security-policy') !== undefined) {
        continue;
      }
      reply.header(key, value);
    }

    // 后台接口一律不缓存
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }

    return payload;
  });

  // ---- 统一错误处理 ----
  app.setErrorHandler((error, request, reply) => {
    if (isDomainError(error)) {
      return reply.code(error.httpStatus).send(error.toResponse());
    }

    const err = error as unknown as {
      code?: string;
      validation?: unknown;
      message: string;
      stack?: string;
    };

    const code = err.code;
    // multipart 超限
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send(
        new DomainError('VALIDATION_FAILED', '上传文件超过大小限制', {
          issues: [{ field: 'file', message: '文件过大，请压缩后重试' }],
        }).toResponse(),
      );
    }

    /**
     * 请求体解析失败 —— 这是**客户端造成的**，必须回 400 而不是 500。
     *
     * 【为什么必须显式处理】Fastify 在 Content-Type 是 JSON 但 body 为空或不是合法 JSON 时
     * 会抛 FST_ERR_CTP_EMPTY_JSON_BODY / FST_ERR_CTP_INVALID_JSON 一类的错误。
     * 不拦的话会掉进下面的兜底分支变成 500，于是：
     *   - 任何客户端只要发一个 `Content-Type: application/json` 且不带 body 的请求，
     *     就能让服务端返回「服务器内部错误」；
     *   - 日志里会混进大量并非服务端缺陷的报错，真正的故障反而被淹掉。
     * 这是实测发现的既有缺陷（后台接口同样受影响），不是本次改造引入的。
     */
    if (typeof code === 'string' && code.startsWith('FST_ERR_CTP_')) {
      return reply.code(400).send(
        new DomainError('VALIDATION_FAILED', '请求体格式不正确', {
          issues: [{ field: 'body', message: '请求体不是合法的 JSON，或为空' }],
        }).toResponse(),
      );
    }

    /**
     * 带 4xx `statusCode` 的错误按客户端错误处理。
     *
     * 自定义的 JSON 解析器（见 buildApp 顶部）在遇到非法 JSON 时
     * 抛出的是原生 `SyntaxError`，它没有 Fastify 的 `FST_ERR_*` code，
     * 只有在上面挂了 `statusCode = 400`。不认这个字段的话，
     * 非法 JSON 又会掉进兜底分支变成 500。
     */
    const status = (error as unknown as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send(
        new DomainError('VALIDATION_FAILED', '请求体格式不正确', {
          issues: [{ field: 'body', message: '请求体不是合法的 JSON' }],
        }).toResponse(),
      );
    }

    if (err.validation) {
      return reply.code(400).send(
        new DomainError('VALIDATION_FAILED', '请求参数格式不正确', {
          issues: [{ field: 'body', message: err.message }],
        }).toResponse(),
      );
    }

    ctx.logger.error('未处理的服务端错误', {
      url: request.url,
      method: request.method,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 6).join('\n'),
    });

    // 不向客户端泄漏内部细节
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务器内部错误，请稍后重试或联系管理员',
        issues: [],
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: '接口不存在', issues: [] },
      });
    }
    return reply.code(404).type('text/html; charset=utf-8').send(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面不存在</title></head><body style="font-family:system-ui;padding:48px;text-align:center"><h1>404</h1><p>页面不存在。</p><p><a href="/admin/">返回管理后台</a></p></body></html>`,
    );
  });

  // ---- 上传媒体（只读，经存储适配器） ----
  const MEDIA_MIME: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.svg': 'image/svg+xml',
  };

  app.get<{ Params: { '*': string } }>('/media/*', async (request, reply) => {
    const key = request.params['*'] ?? '';

    // 存储键只允许「相对路径 + 安全字符」，其余一律拒绝
    if (key === '' || key.includes('..') || key.includes('\0') || key.startsWith('/')) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: '非法的媒体路径' } });
    }

    let data: Uint8Array | null = null;
    try {
      data = await ctx.adapters.storage.read(key);
    } catch (error) {
      ctx.logger.warn('读取媒体失败', { key, message: error instanceof Error ? error.message : String(error) });
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '媒体不存在' } });
    }

    if (!data) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '媒体不存在' } });
    }

    const dot = key.lastIndexOf('.');
    const extension = dot >= 0 ? key.slice(dot).toLowerCase() : '';

    return reply
      .type(MEDIA_MIME[extension] ?? 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=3600')
      .send(Buffer.from(data));
  });

  // ---- 路由 ----
  registerHealthRoutes(app, ctx);
  // 平台托管页面的公开访问（不需要登录 —— 这是给别人看的页面）
  registerPublicSiteRoutes(app, ctx);
  registerPlatformRoutes(app, ctx, { limiter });
  registerPublicRoutes(app, ctx);
  registerAdminAuthRoutes(app, ctx, { limiter, sessionTtlMs: SESSION_TTL_MS, cookieName: ADMIN_COOKIE });
  registerAdminPropertyRoutes(app, ctx);
  registerAdminMediaRoutes(app, ctx);
  registerAdminPageRoutes(app, ctx);
  registerAdminReminderRoutes(app, ctx);
  registerAdminSettingsRoutes(app, ctx);
  registerAdminExportRoutes(app, ctx);
  registerAdminBackupRoutes(app, ctx);

  // 内联 favicon：避免浏览器请求 /favicon.ico 产生 404 噪音
  const favicon =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="7" fill="#0f766e"/>' +
    '<path d="M8 16l8-6 8 6v9a1 1 0 0 1-1 1h-4v-6h-6v6H9a1 1 0 0 1-1-1z" fill="white"/></svg>';

  app.get('/favicon.ico', async (_request, reply) =>
    reply.type('image/svg+xml').header('Cache-Control', 'public, max-age=86400').send(favicon),
  );

  // 根路径保持原有行为（跳后台），不擅自改动既有部署习惯。
  // 平台入口在 /app/。若将来要把平台作为首页，改这一行即可。
  app.get('/', async (_request, reply) => reply.redirect('/admin/'));

  return app;
}

export { ADMIN_COOKIE, SESSION_TTL_MS };