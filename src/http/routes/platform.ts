/**
 * 平台用户接口：注册、登录、项目、额度、AI 生成与导出。
 *
 * 【与后台接口的隔离】
 * 这条前缀下的所有接口都用**平台用户会话**（`platform_session`），
 * 与后台的 `admin_session` 是两套独立密钥、两个独立 Cookie。
 * 详见 `src/platform/auth.ts` 顶部的说明 —— 复用后台密钥会让
 * 「注册一个账号」等于「拿到管理员权限」。
 *
 * 【额度一律服务端判】
 * 每个写动作都先过 `checkQuota()`，前端拿到的只是结论。
 * 用户明确要求「不能只通过前端隐藏按钮来实现会员限制」。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../app-context.ts';
import { DomainError  } from '../../domain/errors.ts';
import type { DomainErrorCode } from '../../domain/errors.ts';
import type { AiProvider } from '../../platform/ai/types.ts';
import { createProviderFromConfig } from '../../platform/ai/provider-factory.ts';
import {
  PLATFORM_COOKIE,
  PLATFORM_SESSION_TTL_MS,
  authenticateUser,
  createUserSession,
  findUserById,
  registerUser,
  revokeUserSessions,
  verifyUserSession,
} from '../../platform/auth.ts';
import { checkQuota, quotaSummary, readStoredSettings } from '../../platform/quota.ts';
import type { PlatformUser } from '../../platform/auth.ts';
import { limitsFor } from '../../platform/config.ts';
import { expiredNotice, resolveMembership, type MembershipState } from '../../platform/membership.ts';
import { withRetention } from '../../platform/retention.ts';
import { checkSpec, ensureCharset } from '../../platform/page-generation.ts';
import { exampleSummaries, getPageExample } from '../../platform/examples.ts';
import { safetyStatsBreakdown } from '../../platform/ai/safety-stats.ts';
import { describePageIssues } from '../../domain/page-safety.ts';
import {
  archiveProject,
  createProject,
  getOwnedProject,
  listProjectsOfUser,
  listVersionsOfProject,
  publishProject,
  restoreProject,
  runAiTask,
  restoreVersion,
  saveDraft,
  unpublishProject,
} from '../../platform/projects.ts';
import { listBuiltinPlugins } from '../../platform/plugins/registry.ts';
import {
  installPlugin,
  listInstallations,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
} from '../../platform/plugins/lifecycle.ts';
import { exportListingAsZip } from '../../services/export-service.ts';
import { getWorkspace } from '../../db/repositories/workspace-repo.ts';
import {
  addUploadedMedia,
  deleteMediaItem,
  listPropertyMedia,
  reorderMediaItems,
  setCoverMedia,
} from '../../services/media-service.ts';
import { aggregateFor, ensureListingPage } from '../../services/publish-service.ts';
import { buildLocaleLinks } from '../../services/i18n-service.ts';
import { composeAddress, renderListingPage } from '../../render/page-renderer.ts';
import { resolveAvailability } from '../../domain/availability.ts';
import type { LoginRateLimiter } from '../security.ts';

/**
 * 用指定工作区替换上下文里的工作区。
 *
 * 平台用户各有自己的工作区，而既有服务都以 `ctx.workspace` 为作用域。
 * 构造一个「同一 db / 同一适配器 / 换一个 workspace」的上下文，
 * 就能直接复用那些服务，且作用域自动收紧到该用户自己的数据。
 */
function contextForWorkspace(ctx: AppContext, workspace: AppContext['workspace']): AppContext {
  return { ...ctx, workspace };
}

export interface PlatformRouteOptions {
  limiter: LoginRateLimiter;
  sessionTtlMs?: number;
  /** 注入 AI 供应商；缺省用确定性 Mock（不发网络请求、不调付费服务） */
  aiProvider?: AiProvider;
}

/** 无需平台会话即可访问的路径 */
export const PUBLIC_PLATFORM_PATHS: ReadonlySet<string> = new Set([
  '/api/platform/register',
  '/api/platform/login',
  '/api/platform/session',
]);

interface AuthedRequest extends FastifyRequest {
  platformUserId?: string;
}

/** 从 Cookie 里取当前平台用户；无效返回 null */
export function currentPlatformUser(ctx: AppContext, request: FastifyRequest) {
  const token = request.cookies[PLATFORM_COOKIE];
  const payload = verifyUserSession(ctx.config.sessionSecret, token, new Date());
  if (!payload) return null;
  // 每次都回库确认用户仍存在且启用 —— 这样「停用账号」能立即生效，
  // 而不是等 7 天会话自然过期。
  const user = findUserById(ctx.db, payload.sub);
  if (!user || user.status !== 'active') return null;
  // 版本号不匹配 = 该会话已被吊销（登出 / 改口令 / 管理员停用）
  if (user.sessionVersion !== payload.sv) return null;

  // ---- 会员到期在这里统一生效 ----
  //
  // 这是**每一个已认证平台请求的唯一入口**（requireUser 走它）。
  // 在把 user 交给路由之前先把过期会员的套餐降回 free，
  // 所有下游（额度判定、托管发布、AI 任务、界面展示）就自动按免费套餐处理 ——
  // 不需要每个接口各写一遍到期判断（那样迟早会漏）。
  return withEffectiveTier(ctx, user);
}

/**
 * 把「数据库里记录的套餐」换成「考虑到期后的生效套餐」。
 *
 * 返回的是同一个用户对象的副本，`tier` 已被替换；
 * 另外附带 `membership` 便于诊断与给出「续期」而非「升级」的提示。
 */
function withEffectiveTier(ctx: AppContext, user: PlatformUser): PlatformUser & { membership: MembershipState } {
  const membership = resolveMembership(
    { tier: user.tier, memberUntil: user.memberUntil },
    ctx.adapters.clock.now(),
  );
  return { ...user, tier: membership.tier, membership };
}

/**
 * 取某个工作区，并把上下文切过去。
 *
 * 平台用户各有自己的工作区，而既有服务都以 `ctx.workspace` 为作用域。
 * 构造一个「同一 db / 同一适配器 / 换一个 workspace」的上下文，
 * 就能直接复用那些服务，且作用域自动收紧到该用户自己的数据。
 *
 * 找不工作区时返回 null，调用方必须当作 404 处理 —— 绝不回退到遗留工作区。
 */
function requireWorkspaceScoped(ctx: AppContext, workspaceId: string) {
  const workspace = getWorkspace(ctx.db, workspaceId);
  if (!workspace) return null;
  return contextForWorkspace(ctx, workspace);
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({
    error: { code: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录', issues: [] },
  });
}

export function registerPlatformRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: PlatformRouteOptions,
): void {
  const { limiter } = options;
  const sessionTtlMs = options.sessionTtlMs ?? PLATFORM_SESSION_TTL_MS;
  // 按配置选供应商：默认 mock；只有 AI_PROVIDER=openai 且配置齐全才会用真实 provider。
  // 退回 Mock 时把原因记进日志 —— 否则「配了却没生效」会很难查。
  const selection = createProviderFromConfig(ctx.config.ai);
  if (selection.fallbackReason) {
    ctx.logger.warn('AI 供应商退回 mock', { reason: selection.fallbackReason });
  }
  const provider = options.aiProvider ?? selection.provider;

  /**
   * **服务层失败码 → HTTP 状态与错误码**的唯一映射。
   *
   * 【为什么必须统一】
   * 这 5 个路由原先各自写了一套三元表达式，规则还不一样：
   * 只有「发布」那条被补过 422，其余四条把**任何**失败都报成 403 FORBIDDEN。
   * 后果是：AI 没产出内容、上游 AI 服务不可用、甚至连「项目不存在」，
   * 在响应体里都带着 `code: FORBIDDEN` ——
   * 客户端按 code 分支会误判成「你没权限」，监控会把它们统计成越权尝试。
   *
   * 现在只有这一张表，所有路由都走它。
   *
   * 【分类依据】按「谁的错、能不能重试」分三类：
   *   - 调用方指错了对象 → 404 / 400
   *   - 内容或产出不符合要求 → 422（不是权限问题，改内容就能过）
   *   - 上游依赖挂了 → 502（等一会儿重试有可能成功）
   *   - 服务端自己出错 → 500
   *   - 其余（额度、套餐、所有权）→ 403（确实是不被允许）
   */
  function httpErrorFor(code: string): { status: number; code: DomainErrorCode } {
    switch (code) {
      // ---- 对象不存在 / 指错了对象 ----
      case 'not_found':
        return { status: 404, code: 'NOT_FOUND' };
      // 引用别人工作区的房源：**保持既有的 403 + 明确提示**。
      // 我一度想把它改成 404（「不泄露资源是否存在」），但那会改变一个
      // 与本轮缺陷无关的既有行为，并有测试专门断言 403 与「不属于你」。
      // 这里刻意不动它。
      case 'property_not_owned':
        return { status: 403, code: 'FORBIDDEN' };

      // ---- 状态冲突：目标当前不处于可操作状态 ----
      case 'not_archived':
      case 'not_published':
      case 'duplicate_task':
        return { status: 409, code: 'CONFLICT' };

      // ---- 调用方传错了参数 ----
      case 'unknown_plugin':
      case 'unknown_user':
        return { status: 400, code: 'VALIDATION_FAILED' };

      // ---- 内容 / 产出不符合要求：不是权限，也不是服务端故障 ----
      case 'not_publishable':
      case 'empty_patch':
      case 'no_page_output':
      case 'unsafe_output':
      case 'single_call_too_large':
        return { status: 422, code: 'UNPROCESSABLE' };

      // ---- 上游 AI 服务不可用：网关类故障 ----
      case 'provider_error':
        return { status: 502, code: 'DEPENDENCY_UNAVAILABLE' };

      // ---- 服务端自身出错 ----
      case 'internal':
        return { status: 500, code: 'INTERNAL' };

      // ---- 其余：额度、套餐、所有权 —— 确实是不被允许 ----
      default:
        return { status: 403, code: 'FORBIDDEN' };
    }
  }

  /** 取当前用户，未登录直接回 401 并返回 null */
  const requireUser = (request: FastifyRequest, reply: FastifyReply) => {
    const user = currentPlatformUser(ctx, request);
    if (!user) {
      unauthorized(reply);
      return null;
    }
    return user;
  };

  /**
   * **统一的管理权限守卫**。
   *
   * 【这个权限位是什么，不是什么】
   * `adminEnabled` 是**套餐能力位**（`config.ts` 的 DEFAULT_TIER_LIMITS：
   * free=false、basic/pro=true），语义是「该套餐是否包含插件在线管理后台」。
   * 它**不是**「系统管理员身份」—— 本平台没有平台侧管理员身份，
   * 房东端后台是另一套独立的口令会话（见 `app.ts` 的 admin_session），
   * 两者不能混为一谈，也绝不能互相授权。
   *
   * 【为什么要有这个统一入口】
   * `checkQuota(action:'plugin.admin')` 这条规则早就写好了，但**从来没有被调用过** ——
   * 于是 adminEnabled 成了一个「可查询、永不生效」的权限位。
   * 校验如果散在各个路由里各写一遍，迟早会出现某个接口漏判。
   * 所以所有受它保护的路由一律走这里，规则只有一份。
   *
   * 【到期会员】
   * 传入的 `user.tier` 已经过 `currentPlatformUser` 的到期解析，
   * 因此到期会员在这里自然拿不到管理能力 —— 不需要在这里再判一次到期。
   */
  const requirePluginAdmin = (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply);
    if (!user) return null;

    const decision = checkQuota(
      ctx.db,
      {
        userId: user.id,
        tier: user.tier,
        action: 'plugin.admin',
        membership: (user as { membership?: MembershipState }).membership,
      },
      ctx.adapters.clock.now(),
    );
    if (!decision.allowed) {
      // 403 而不是 404：调用方已经通过认证，缺的是能力 —— 明确告诉他需要升级/续期
      reply
        .code(403)
        .send(new DomainError('FORBIDDEN', decision.message ?? '当前套餐不包含插件在线管理后台。').toResponse());
      return null;
    }
    return user;
  };

  // ---- 注册 ----

  app.post('/api/platform/register', async (request, reply) => {
    const now = new Date();
    const ip = request.ip || 'unknown';
    const gate = limiter.check(ip, now);
    if (!gate.allowed) {
      const minutes = Math.ceil(gate.retryAfterMs / 60000);
      return reply
        .code(429)
        .send(new DomainError('RATE_LIMITED', `操作过于频繁，请 ${minutes} 分钟后再试`).toResponse());
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = registerUser(ctx.db, {
      email: typeof body.email === 'string' ? body.email : '',
      password: typeof body.password === 'string' ? body.password : '',
      displayName: typeof body.displayName === 'string' ? body.displayName : '',
      // 不传 workspaceId：注册会为该用户创建独立工作区，
      // 使「用户只能看到自己的数据」由数据层保证（见 platform/auth.ts 的说明）。
    });

    if (!result.ok) {
      limiter.recordFailure(ip, now);
      return reply.code(400).send(new DomainError('VALIDATION_FAILED', result.message).toResponse());
    }

    const token = createUserSession(
      ctx.config.sessionSecret, result.user.id, result.user.sessionVersion, sessionTtlMs, now,
    );
    reply.setCookie(PLATFORM_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.publicBaseUrl.startsWith('https://'),
      maxAge: Math.floor(sessionTtlMs / 1000),
    });
    // 同上：注册出来的必然是免费用户，但走同一条路径可以避免
    // 「这个接口解析、那个接口不解析」的分裂。
    const effective = withEffectiveTier(ctx, result.user);
    return reply.code(201).send({ user: effective, quota: quotaSummary(ctx.db, effective.id, effective.tier) });
  });

  // ---- 登录 / 登出 / 会话 ----

  app.post('/api/platform/login', async (request, reply) => {
    const now = new Date();
    const ip = request.ip || 'unknown';
    const gate = limiter.check(ip, now);
    if (!gate.allowed) {
      const minutes = Math.ceil(gate.retryAfterMs / 60000);
      return reply
        .code(429)
        .send(new DomainError('RATE_LIMITED', `登录尝试过于频繁，请 ${minutes} 分钟后再试`).toResponse());
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = authenticateUser(
      ctx.db,
      typeof body.email === 'string' ? body.email : '',
      typeof body.password === 'string' ? body.password : '',
    );

    if (!result.ok) {
      limiter.recordFailure(ip, now);
      // 邮箱不存在与口令错误返回同一码同一文案，避免成为账号探测器
      return reply.code(401).send(new DomainError('FORBIDDEN', result.message).toResponse());
    }

    const token = createUserSession(
      ctx.config.sessionSecret, result.user.id, result.user.sessionVersion, sessionTtlMs, now,
    );
    reply.setCookie(PLATFORM_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.publicBaseUrl.startsWith('https://'),
      maxAge: Math.floor(sessionTtlMs / 1000),
    });
    // 登录/注册响应同样要按**生效套餐**返回。
    // 否则到期会员刚登录时会看到「basic / 3 个项目 / 含托管」，
    // 而下一个请求就变成免费套餐 —— 界面会自相矛盾：
    // 显示着会员额度，点下去却提示已到期。
    const effective = withEffectiveTier(ctx, result.user);
    return { user: effective, quota: quotaSummary(ctx.db, effective.id, effective.tier) };
  });

  app.post('/api/platform/logout', async (request, reply) => {
    // 先吊销再清 Cookie：只清 Cookie 的话，被截获的令牌在 7 天有效期内一直能用。
    // 这里把该用户的 session_version +1，其**全部**已签发令牌立刻失效。
    const user = currentPlatformUser(ctx, request);
    if (user) revokeUserSessions(ctx.db, user.id);
    reply.clearCookie(PLATFORM_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/platform/session', async (request) => {
    const user = currentPlatformUser(ctx, request);
    if (!user) return { authenticated: false, user: null, quota: null };
    return { authenticated: true, user, quota: quotaSummary(ctx.db, user.id, user.tier) };
  });

  // ---- 额度 ----

  app.get('/api/platform/quota', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return quotaSummary(ctx.db, user.id, user.tier);
  });

  /**
   * 生成质量观测：校验门拒掉了多少、因为哪条规则。
   *
   * 放在平台侧而不是只做后台接口：这是**产品要把 AI 功能调好**所必需的观测，
   * 不是运营专属。免费用户也能看到「我的请求为什么老是被拒」。
   */
  app.get('/api/platform/safety-stats', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const breakdown = safetyStatsBreakdown(ctx.db, 500);
    // 判断门严不严要看 gated —— 不受门约束的任务会把总体拒绝率稀释掉
    const stats = breakdown.gated;
    return {
      ...stats,
      // 三种口径都给出来：gated 是判断依据，all 用于对照
      breakdown,
      // 给一句人话解释，避免调用方各自解读 rejectRate
      hint:
        stats.rejectedByGate === 0
          ? `目前没有生成结果被安全检查拒掉（口径：只统计受校验门约束的插件 ${breakdown.gatedPlugins.join(', ')}）。`
          : `最近 ${stats.totalTasks} 次生成里有 ${stats.rejectedByGate} 次被安全检查拒掉（${
              Math.round(stats.rejectRate * 100)
            }%）。如果比例偏高，说明规则可能过严，需要按 rules 里的命中情况逐条评估。`,
    };
  });

  // ---- 插件 ----

  // ---- 插件生命周期（受 adminEnabled 保护）----
  //
  // 作用域是**当前用户自己的工作区**：一个人停用插件不会影响别人。
  // 所有操作都只动 `plugin_installations` 一行，**不碰任何业务数据**。

  /** 列出本工作区的插件安装状态 */
  app.get('/api/platform/plugins/installations', async (request, reply) => {
    const user = requirePluginAdmin(request, reply);
    if (!user) return;
    return {
      items: listInstallations(ctx.db, user.workspaceId, ctx.adapters.clock.now().toISOString()),
    };
  });

  /** 安装 */
  app.post<{ Params: { id: string } }>('/api/platform/plugins/:id/install', async (request, reply) => {
    const user = requirePluginAdmin(request, reply);
    if (!user) return;
    const r = installPlugin(ctx.db, user.workspaceId, request.params.id, ctx.adapters.clock.now().toISOString());
    if (!r.ok) {
      const { status, code } = httpErrorFor(r.code);
      return reply.code(status).send(new DomainError(code, r.message).toResponse());
    }
    return { installation: r.installation };
  });

  /** 启用 / 停用 */
  for (const [action, enabled] of [['enable', true], ['disable', false]] as const) {
    app.post<{ Params: { id: string } }>(`/api/platform/plugins/:id/${action}`, async (request, reply) => {
      const user = requirePluginAdmin(request, reply);
      if (!user) return;
      const r = setPluginEnabled(
        ctx.db, user.workspaceId, request.params.id, enabled, ctx.adapters.clock.now().toISOString(),
      );
      if (!r.ok) {
        const { status, code } = httpErrorFor(r.code);
        return reply.code(status).send(new DomainError(code, r.message).toResponse());
      }
      return { installation: r.installation };
    });
  }

  /** 更新（内置插件随代码发布，这里会如实说明无法单独更新） */
  app.post<{ Params: { id: string } }>('/api/platform/plugins/:id/update', async (request, reply) => {
    const user = requirePluginAdmin(request, reply);
    if (!user) return;
    const r = updatePlugin(ctx.db, user.workspaceId, request.params.id, ctx.adapters.clock.now().toISOString());
    if (!r.ok) {
      const { status, code } = httpErrorFor(r.code);
      return reply.code(status).send(new DomainError(code, r.message).toResponse());
    }
    return { installation: r.installation };
  });

  /** 卸载：**只删安装记录，不动项目、版本、公开页面与房源数据** */
  app.delete<{ Params: { id: string } }>('/api/platform/plugins/:id/installation', async (request, reply) => {
    const user = requirePluginAdmin(request, reply);
    if (!user) return;
    const r = uninstallPlugin(ctx.db, user.workspaceId, request.params.id, ctx.adapters.clock.now().toISOString());
    if (!r.ok) {
      const { status, code } = httpErrorFor(r.code);
      return reply.code(status).send(new DomainError(code, r.message).toResponse());
    }
    return { installation: r.installation };
  });

  /**
   * 插件管理视图 —— **受 `adminEnabled` 保护的管理接口**。
   *
   * 【为什么是这个接口】
   * 权限位必须有真实的受保护对象，否则「生效」无从验证。
   * 但插件**生命周期**（安装 / 启用 / 禁用 / 升级 / 卸载）在本平台尚未实现，
   * 且按本次任务要求不予开发；`safety-stats` 又是**刻意对免费用户开放**的
   * （见上面的注释：免费用户需要知道自己的请求为什么被拒），锁上它会破坏既有产品规则。
   *
   * 所以这里提供的是插件**管理视图**：把插件清单里属于「配置与契约」的那一层
   * 单独暴露给有管理能力的套餐 —— 字段结构、结构键、能力声明、契约版本、
   * 公开页路由、以及**当前套餐对该插件的可用性**。
   * 它是只读的，不涉及安装、启停、升级、卸载。
   *
   * 【注意它不返回什么】
   * 不返回任何其他用户的数据、不返回密钥、不返回内部错误。
   * 项目计数只统计**当前用户自己的**项目。
   */
  app.get<{ Params: { id: string } }>('/api/platform/plugins/:id/admin', async (request, reply) => {
    const user = requirePluginAdmin(request, reply);
    if (!user) return;

    const registered = listBuiltinPlugins().find((p) => p.manifest.id === request.params.id);
    if (!registered) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '插件不存在').toResponse());
    }

    const manifest = registered.manifest;
    const limits = limitsFor(user.tier, readStoredSettings(ctx.db));

    // 只统计当前用户自己的项目 —— 管理视图不该成为窥探他人数据的入口
    const projectCount = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND plugin_id = ?')
      .get(user.id, manifest.id) as { n: number } | undefined;

    const publishedCount = ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND plugin_id = ? AND status = 'published'",
      )
      .get(user.id, manifest.id) as { n: number } | undefined;

    return {
      plugin: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        pageType: manifest.pageType,
        builtin: manifest.builtin,
        executable: registered.executable,
        description: manifest.description,
        // 管理视图才给出的配置细节
        structuralKeys: manifest.structuralKeys,
        capabilities: manifest.capabilities,
        fields: manifest.fields.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          required: f.required ?? false,
        })),
      },
      usage: {
        projects: Number(projectCount?.n ?? 0),
        published: Number(publishedCount?.n ?? 0),
      },
      // 当前套餐对该插件的可用性 —— 让管理员一眼看出「为什么这个功能用不了」
      entitlement: {
        tier: limits.tier,
        adminEnabled: limits.adminEnabled,
        hostingEnabled: limits.hostingEnabled,
        projectQuota: limits.maxProjects,
      },
    };
  });

  app.get('/api/platform/plugins', async () => ({
    items: listBuiltinPlugins().map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      pageType: p.manifest.pageType,
      description: p.manifest.description,
      fields: p.manifest.fields,
      executable: p.executable,
    })),
  }));

  // ---- 示例画廊 ----
  //
  // 用真实的生成结果做引导：用户可以在花额度之前先看到「生成出来长什么样」。
  // 示例是内置的静态内容，**不调用 AI、不消耗额度**。

  app.get('/api/platform/examples', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return exampleSummaries();
  });

  app.get<{ Params: { id: string } }>('/api/platform/examples/:id/preview', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const example = getPageExample(request.params.id);
    if (!example) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '示例不存在').toResponse());
    }
    // 与自定义页面的预览用同一套严格 CSP —— 画廊没有理由比真实产物宽松
    return reply
      .type('text/html; charset=utf-8')
      .header('X-Robots-Tag', 'noindex')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
      )
      .header('X-Content-Type-Options', 'nosniff')
      .send(example.html);
  });

  // ---- 项目 ----

  app.get('/api/platform/projects', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    // 带上保存期限：免费用户需要知道项目什么时候到期，而不是到期后才发现项目没了
    const limits = limitsFor(user.tier, readStoredSettings(ctx.db));
    const now = new Date();
    // scope=archived 查回收站；缺省只列未归档的（额度按未归档数计）
    const scope = (request.query as { scope?: string }).scope === 'archived' ? 'archived' : 'active';
    const base = ctx.config.publicBaseUrl.replace(/\/+$/, '');
    return {
      items: listProjectsOfUser(ctx.db, user.id, scope).map((p) => ({
        ...withRetention(p, limits, now),
        // 【列表里也要有公开地址】
        // 否则用户关掉页面再回来就找不到自己的链接了 —— 而那是他唯一需要记住的东西。
        publicUrl: p.status === 'published' && p.publicSlug ? `${base}/s/${p.publicSlug}` : null,
      })),
    };
  });

  app.post('/api/platform/projects', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = createProject(ctx, user.id, {
      pluginId: typeof body.pluginId === 'string' ? body.pluginId : '',
      title: typeof body.title === 'string' ? body.title : '',
      spec: typeof body.spec === 'object' && body.spec !== null ? (body.spec as Record<string, unknown>) : {},
    });

    if (!result.ok) {
      const { status, code } = httpErrorFor(result.code);
      return reply.code(status).send(new DomainError(code, result.message).toResponse());
    }
    return reply.code(201).send({ project: result.project });
  });

  app.get<{ Params: { id: string } }>('/api/platform/projects/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    // 别人的项目在这里根本查不出来 —— 返回 404 而不是 403，
    // 避免「这个 id 存在但不是你的」这种信息泄露。
    const project = getOwnedProject(ctx.db, user.id, request.params.id);
    if (!project) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
    }
    const limits = limitsFor(user.tier, readStoredSettings(ctx.db));
    return {
      project: withRetention(project, limits),
      versions: listVersionsOfProject(ctx.db, project.id, 20),
      quota: quotaSummary(ctx.db, user.id, user.tier),
      // 公开地址只在托管中才有意义
      publicUrl:
        project.status === 'published' && project.publicSlug
          ? `${ctx.config.publicBaseUrl.replace(/\/+$/, '')}/s/${project.publicSlug}`
          : null,
    };
  });

  app.patch<{ Params: { id: string } }>('/api/platform/projects/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const patchSpec = typeof body.spec === 'object' && body.spec !== null
      ? (body.spec as Record<string, unknown>)
      : undefined;

    // 先取项目以便判断插件类型；同时把「不存在」与「内容不合规」区分开 ——
    // 原先两者都返回 404，用户看到「项目不存在」会完全摸不着头脑。
    const existing = getOwnedProject(ctx.db, user.id, request.params.id);
    if (!existing) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
    }

    if (patchSpec) {
      const check = checkSpec(existing.pluginId, { ...existing.spec, ...patchSpec });
      if (!check.ok) {
        return reply
          .code(422)
          .send(new DomainError('UNPROCESSABLE', describePageIssues(check.issues)).toResponse());
      }
    }

    const updated = saveDraft(ctx, user.id, request.params.id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      spec: patchSpec,
    });
    if (!updated) {
      return reply.code(422).send(new DomainError('UNPROCESSABLE', '内容未通过校验或超出上限').toResponse());
    }
    return { project: updated };
  });

  /** 从回收站恢复 */
  app.post<{ Params: { id: string } }>('/api/platform/projects/:id/restore', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const result = restoreProject(ctx, user.id, request.params.id);
    if (!result.ok) {
      const { status, code } = httpErrorFor(result.code);
      return reply.code(status).send(new DomainError(code, result.message).toResponse());
    }
    return { project: result.project, quota: quotaSummary(ctx.db, user.id, user.tier) };
  });

  app.delete<{ Params: { id: string } }>('/api/platform/projects/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const ok = archiveProject(ctx, user.id, request.params.id);
    if (!ok) return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
    return { ok: true };
  });

  // ---- AI 生成 / 修改 ----

  const runTask = async (
    request: FastifyRequest & { params: { id: string } },
    reply: FastifyReply,
    kind: 'generate' | 'revise',
  ) => {
    const user = currentPlatformUser(ctx, request);
    if (!user) return unauthorized(reply);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt === '') {
      return reply.code(400).send(new DomainError('VALIDATION_FAILED', '请描述你想要的页面内容').toResponse());
    }
    if (prompt.length > 4000) {
      return reply.code(400).send(new DomainError('VALIDATION_FAILED', '描述过长，请精简到 4000 字以内').toResponse());
    }

    // 幂等键优先取请求头：浏览器重复点、刷新重放都会带同一个 taskId，
    // 从而撞上 ai_usage 的唯一约束，不会重复扣额度。
    const headerTaskId = request.headers['x-task-id'];
    const taskId = typeof headerTaskId === 'string' && headerTaskId.trim() !== ''
      ? headerTaskId.trim().slice(0, 100)
      : `task_${randomUUID()}`;

    const targetFields = Array.isArray(body.targetFields)
      ? body.targetFields.filter((f): f is string => typeof f === 'string')
      : undefined;

    const result = await runAiTask(ctx, provider, user.id, {
      projectId: request.params.id,
      kind,
      prompt,
      taskId,
      targetFields,
    });

    if (!result.ok) {
      // 原先这里把**所有** AI 失败都报成 403 FORBIDDEN：
      // 「AI 没产出内容」（422）、「上游服务不可用」（502）、
      // 甚至「项目不存在」（404）在响应体里都带 code=FORBIDDEN。
      const { status, code } = httpErrorFor(result.code);
      return reply.code(status).send(new DomainError(code, result.message).toResponse());
    }

    return {
      patch: result.patch,
      spec: result.spec,
      usage: result.usage,
      provider: result.provider,
      model: result.model,
      /** 明确告诉调用方这是模拟用量还是真实用量 */
      simulated: result.provider === 'mock',
      quota: quotaSummary(ctx.db, user.id, user.tier),
    };
  };

  app.post<{ Params: { id: string } }>('/api/platform/projects/:id/generate', async (request, reply) =>
    runTask(request as FastifyRequest & { params: { id: string } }, reply, 'generate'));

  app.post<{ Params: { id: string } }>('/api/platform/projects/:id/revise', async (request, reply) =>
    runTask(request as FastifyRequest & { params: { id: string } }, reply, 'revise'));

  // ---- 图片上传 ----
  //
  // 复用既有的媒体服务与校验链路（扩展名/MIME 嗅探、体积上限、存储适配器），
  // 只把作用域换成该用户自己的工作区。不新写一套上传逻辑。

  /** 取项目关联的房源 id，并确认它属于该用户 */
  const resolveProjectProperty = (user: { id: string; workspaceId: string }, projectId: string) => {
    const project = getOwnedProject(ctx.db, user.id, projectId);
    if (!project) return { error: 'project_not_found' as const };
    const propertyId = project.spec['propertyId'];
    if (typeof propertyId !== 'string' || propertyId === '') return { error: 'no_property' as const };
    const owns = ctx.db
      .prepare('SELECT id FROM properties WHERE id = ? AND workspace_id = ?')
      .get(propertyId, user.workspaceId);
    if (!owns) return { error: 'property_not_owned' as const };
    return { project, propertyId };
  };

  app.get<{ Params: { id: string } }>('/api/platform/projects/:id/media', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const resolved = resolveProjectProperty(user, request.params.id);
    if ('error' in resolved) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
    }
    const scoped = requireWorkspaceScoped(ctx, user.workspaceId);
    if (!scoped) return reply.code(404).send(new DomainError('NOT_FOUND', '工作区不存在').toResponse());
    return { items: await listPropertyMedia(scoped, resolved.propertyId) };
  });

  app.post<{ Params: { id: string } }>('/api/platform/projects/:id/media', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const resolved = resolveProjectProperty(user, request.params.id);
    if ('error' in resolved) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
    }

    const file = await request.file();
    if (!file) {
      return reply
        .code(400)
        .send(new DomainError('VALIDATION_FAILED', '请选择要上传的文件').toResponse());
    }
    const data = await file.toBuffer();

    const scoped = requireWorkspaceScoped(ctx, user.workspaceId);
    if (!scoped) return reply.code(404).send(new DomainError('NOT_FOUND', '工作区不存在').toResponse());
    try {
      const created = await addUploadedMedia(scoped, resolved.propertyId, {
        filename: file.filename,
        declaredMime: file.mimetype,
        data: new Uint8Array(data),
        sourceNote: '',
      });
      return reply.code(201).send(created);
    } catch (error) {
      // 复用既有校验的错误语义：类型不支持 / 过大 / 超出张数上限
      return reply
        .code(400)
        .send(new DomainError('VALIDATION_FAILED', error instanceof Error ? error.message : '上传失败').toResponse());
    }
  });

  app.delete<{ Params: { id: string; mediaId: string } }>(
    '/api/platform/projects/:id/media/:mediaId',
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return;
      const resolved = resolveProjectProperty(user, request.params.id);
      if ('error' in resolved) {
        return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
      }
      // 只允许删除属于本项目的媒体：先确认该 media 的 property_id 匹配
      const row = ctx.db
        .prepare('SELECT id FROM media WHERE id = ? AND property_id = ?')
        .get(request.params.mediaId, resolved.propertyId);
      if (!row) return reply.code(404).send(new DomainError('NOT_FOUND', '素材不存在').toResponse());

      const scoped = requireWorkspaceScoped(ctx, user.workspaceId);
    if (!scoped) return reply.code(404).send(new DomainError('NOT_FOUND', '工作区不存在').toResponse());
      await deleteMediaItem(scoped, request.params.mediaId);
      return { ok: true };
    },
  );

  /** 调整照片顺序 */
  app.post<{ Params: { id: string } }>('/api/platform/projects/:id/media/reorder', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const resolved = resolveProjectProperty(user, request.params.id);
    if ('error' in resolved) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
    }

    const body = (request.body ?? {}) as { order?: unknown };
    const order = Array.isArray(body.order) ? body.order.filter((v): v is string => typeof v === 'string') : [];
    if (order.length === 0) {
      return reply
        .code(400)
        .send(new DomainError('VALIDATION_FAILED', '请提供照片顺序数组').toResponse());
    }

    const scoped = requireWorkspaceScoped(ctx, user.workspaceId);
    if (!scoped) return reply.code(404).send(new DomainError('NOT_FOUND', '工作区不存在').toResponse());
    // reorderMediaItems 只接受属于该房源的 id，传别人的 id 会被它自己剔除
    return { items: reorderMediaItems(scoped, resolved.propertyId, order) };
  });

  /** 设为封面 */
  app.post<{ Params: { id: string } }>('/api/platform/projects/:id/media/cover', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const resolved = resolveProjectProperty(user, request.params.id);
    if ('error' in resolved) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
    }

    const body = (request.body ?? {}) as { mediaId?: unknown };
    const mediaId = typeof body.mediaId === 'string' && body.mediaId !== '' ? body.mediaId : null;

    const scoped = requireWorkspaceScoped(ctx, user.workspaceId);
    if (!scoped) return reply.code(404).send(new DomainError('NOT_FOUND', '工作区不存在').toResponse());
    try {
      return { items: setCoverMedia(scoped, resolved.propertyId, mediaId) };
    } catch (error) {
      return reply
        .code(400)
        .send(new DomainError('VALIDATION_FAILED', error instanceof Error ? error.message : '设置封面失败').toResponse());
    }
  });

  // ---- 预览 ----
  //
  // 与后台预览、以及导出用的是**同一个渲染函数**（renderListingPage），
  // 因此这里看到的就是发布后/下载后的样子，不会出现「预览和实际不一致」。

  app.get<{ Params: { id: string } }>('/api/platform/projects/:id/preview', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    // 【先取项目，再按插件分支】不能一上来就要求 propertyId ——
    // 自定义页面（模式 B）的项目根本没有关联房源，
    // 那样会在「判断插件类型」之前就先返回 404。
    const project = getOwnedProject(ctx.db, user.id, request.params.id);
    if (!project) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());
    }

    // ---- 自定义页面（模式 B）：直接返回生成的 HTML ----
    //
    // 【纵深防御】校验门已经保证里面没有脚本，但这里仍然用一条极严的 CSP 兜底：
    // default-src 'none' + 不允许任何脚本来源。
    // 万一校验门将来漏了某种绕过手法，浏览器也不会执行它。
    // `sandbox` 让页面运行在一个没有同源权限的独立环境里 ——
    // 即使它有办法发起请求，也读不到平台的 Cookie 与接口。
    if (project.pluginId === 'custom-page') {
      const html = project.spec['html'];
      if (typeof html !== 'string' || html === '') {
        return reply
          .code(404)
          .send(new DomainError('NOT_FOUND', '这个页面还没有生成内容').toResponse());
      }
      return reply
        .type('text/html; charset=utf-8')
        .header('X-Robots-Tag', 'noindex')
        .header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
        )
        .header('X-Content-Type-Options', 'nosniff')
        .send(html);
    }

    // 走到这里说明是房源类插件，这时才需要关联房源
    const resolved = resolveProjectProperty(user, request.params.id);
    if ('error' in resolved) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在或尚未关联房源').toResponse());
    }

    const scoped = requireWorkspaceScoped(ctx, user.workspaceId);
    if (!scoped) return reply.code(404).send(new DomainError('NOT_FOUND', '工作区不存在').toResponse());

    const aggregate = aggregateFor(scoped, resolved.propertyId);
    const page = ensureListingPage(scoped, resolved.propertyId);
    const locale = page.locale ?? scoped.workspace.defaultLocale;

    const html = renderListingPage({
      aggregate,
      workspace: scoped.workspace,
      locale,
      publicUrl: scoped.adapters.hosting.resolvePublicUrl(page.slug, {
        customDomain: page.customDomain,
        domainVerifyToken: page.domainVerifyToken,
        domainVerifiedAt: page.domainVerifiedAt,
      }).url,
      templateId: page.templateId,
      mapView: scoped.adapters.map.buildView({
        latitude: aggregate.property.latitude,
        longitude: aggregate.property.longitude,
        addressText: composeAddress(aggregate.property),
      }),
      nearby: null,
      localeLinks: buildLocaleLinks(scoped, resolved.propertyId, locale),
      includeMapScript: true,
      includeQr: true,
      generatedAt: scoped.adapters.clock.now(),
      // 与公开页用同一个 per-request nonce，供内联脚本与样式使用
      nonce: request.cspNonce,
      availability: resolveAvailability(
        aggregate.property,
        scoped.adapters.clock.now(),
        scoped.config.listingStaleDays,
      ),
    });

    return reply
      .type('text/html; charset=utf-8')
      .header('X-Robots-Tag', 'noindex')
      .send(html);
  });

  // ---- 发布 ----

  app.post<{ Params: { id: string } }>('/api/platform/projects/:id/publish', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const result = publishProject(ctx, user.id, request.params.id);
    if (!result.ok) {
      // 「内容无效」不是「你没权限」。用 403 会让前端显示「升级套餐」、
      // 让监控把它当成越权尝试 —— 而用户真正需要知道的是「页面还没内容」。
      const { status, code } = httpErrorFor(result.code);
      return reply.code(status).send(new DomainError(code, result.message).toResponse());
    }
    return {
      project: result.project,
      version: result.version,
      // 直接把可分享的地址给出来 —— 用户发布之后第一件事就是想知道「链接是什么」
      publicUrl: result.project.publicSlug
        ? `${ctx.config.publicBaseUrl.replace(/\/+$/, '')}/s/${result.project.publicSlug}`
        : null,
    };
  });

  /**
   * 回滚到某个历史版本。
   *
   * body.mode:
   *   - `draft`（默认）—— 只写回草稿，**线上页面不受影响**
   *   - `publish` —— 重新发布这一版（走完整校验与额度判定）
   *
   * 默认选 `draft` 是有意的：默认动作必须是**不会改变线上内容**的那个，
   * 否则一次误点就会把正在对外访问的页面换掉。
   */
  app.post<{ Params: { id: string; versionId: string } }>(
    '/api/platform/projects/:id/versions/:versionId/restore',
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return;

      const rawMode = (request.body as { mode?: unknown } | undefined)?.mode;
      const mode = rawMode === 'publish' ? 'publish' : 'draft';

      const result = restoreVersion(ctx, user.id, request.params.id, request.params.versionId, mode);
      if (!result.ok) {
        const { status, code } = httpErrorFor(result.code);
        return reply.code(status).send(new DomainError(code, result.message).toResponse());
      }

      return {
        mode: result.mode,
        project: result.project,
        version: result.version,
        // 明确告诉调用方线上有没有被改动 —— 避免「以为回滚了线上」的误解
        publicUrlChanged: result.mode === 'publish',
        publicUrl:
          result.project.status === 'published' && result.project.publicSlug
            ? `${ctx.config.publicBaseUrl.replace(/\/+$/, '')}/s/${result.project.publicSlug}`
            : null,
      };
    },
  );

  /** 停止平台托管：公开地址立刻失效，但内容保留、可重新发布 */
  app.post<{ Params: { id: string } }>('/api/platform/projects/:id/unpublish', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const result = unpublishProject(ctx, user.id, request.params.id);
    if (!result.ok) {
      const { status, code } = httpErrorFor(result.code);
      return reply.code(status).send(new DomainError(code, result.message).toResponse());
    }
    return { project: result.project };
  });

  // ---- 导出下载 ----

  app.get<{ Params: { id: string } }>('/api/platform/projects/:id/export', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const project = getOwnedProject(ctx.db, user.id, request.params.id);
    if (!project) return reply.code(404).send(new DomainError('NOT_FOUND', '项目不存在').toResponse());

    // ---- 自定义页面（模式 B）：直接下发 HTML 文件 ----
    // 单页就是全部产物，不需要打包。文件名用项目标题（做 ASCII 兜底）。
    if (project.pluginId === 'custom-page') {
      const html = project.spec['html'];
      if (typeof html !== 'string' || html === '') {
        return reply
          .code(400)
          .send(new DomainError('VALIDATION_FAILED', '这个页面还没有生成内容').toResponse());
      }
      const safeTitle = project.title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'page';
      const asciiName = `${safeTitle.replace(/[^\x20-\x7e]/g, '_')}.html`;
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${safeTitle}.html`)}`,
        )
        .header('X-Robots-Tag', 'noindex')
        // 下载后走 file://，没有响应头可依赖 —— 必须让文件自己声明编码，
        // 否则中文可能乱码（见 ensureCharset 的说明）。
        .send(ensureCharset(html));
    }

    // 房源插件复用既有的导出能力 —— 不另写一套打包逻辑
    const propertyId = project.spec['propertyId'];
    if (project.pluginId !== 'listing' || typeof propertyId !== 'string' || propertyId === '') {
      return reply
        .code(400)
        .send(new DomainError('VALIDATION_FAILED', '该项目尚未关联可导出的内容').toResponse());
    }

    // 再次确认房源属于该用户的工作区（纵深防御：创建时已校验过一次）
    const owns = ctx.db
      .prepare('SELECT id FROM properties WHERE id = ? AND workspace_id = ?')
      .get(propertyId, user.workspaceId);
    if (!owns) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '项目内容不存在').toResponse());
    }

    // 【为什么换上下文而不是改导出服务】
    // 既有导出链路全程以 `ctx.workspace` 为作用域：房源归属校验、联系方式、
    // 渲染默认值（币种/面积单位/语言）都从它取。给它一个「同一 db/适配器、
    // 但 workspace 换成该用户自己的工作区」的上下文，既有服务一行都不用改，
    // 而且作用域自动变正确 —— 比在导出服务里加一个 workspaceId 参数更不容易漏。
    const userWorkspace = getWorkspace(ctx.db, user.workspaceId);
    if (!userWorkspace) {
      return reply.code(404).send(new DomainError('NOT_FOUND', '工作区不存在').toResponse());
    }
    const bundle = await exportListingAsZip(contextForWorkspace(ctx, userWorkspace), propertyId, {});
    const asciiFallback = bundle.filename.replace(/[^\x20-\x7e]/g, '_');
    return reply
      .type('application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(bundle.filename)}`,
      )
      .header('Content-Length', String(bundle.data.length))
      .send(Buffer.from(bundle.data));
  });
}

export type { AuthedRequest };