/**
 * 后台登录与演示用「时间旅行」。
 *
 * 安全要点：
 *  - 口令使用恒定时间比较；
 *  - 登录失败限流，抵御暴力破解；
 *  - 会话为 HMAC 签名的 HttpOnly Cookie。
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.ts';
import { DomainError } from '../../domain/errors.ts';
import { createSessionToken, timingSafeEqual, type LoginRateLimiter } from '../security.ts';

export interface AuthRouteOptions {
  limiter: LoginRateLimiter;
  sessionTtlMs: number;
  cookieName: string;
}

export function registerAdminAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: AuthRouteOptions,
): void {
  const { limiter, sessionTtlMs, cookieName } = options;

  app.post('/api/admin/login', async (request, reply) => {
    // 鉴权与限流使用真实时间，不受可控时钟影响（见 app.ts 中的说明）
    const now = new Date();
    const ip = request.ip || 'unknown';

    const gate = limiter.check(ip, now);
    if (!gate.allowed) {
      const minutes = Math.ceil(gate.retryAfterMs / 60000);
      return reply.code(429).send(
        new DomainError('RATE_LIMITED', `登录尝试过于频繁，请 ${minutes} 分钟后再试`).toResponse(),
      );
    }

    const body = (request.body ?? {}) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';

    if (!timingSafeEqual(password, ctx.config.adminPassword)) {
      limiter.recordFailure(ip, now);
      ctx.logger.warn('后台登录失败', { ip });

      return reply.code(401).send(
        new DomainError('FORBIDDEN', '管理口令不正确').toResponse(),
      );
    }

    limiter.recordSuccess(ip);

    const token = createSessionToken(ctx.config.sessionSecret, sessionTtlMs, now);
    reply.setCookie(cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.publicBaseUrl.startsWith('https://'),
      maxAge: Math.floor(sessionTtlMs / 1000),
    });

    ctx.logger.info('后台登录成功', { ip });
    return { authenticated: true, expiresAt: new Date(now.getTime() + sessionTtlMs).toISOString() };
  });

  app.post('/api/admin/logout', async (_request, reply) => {
    reply.clearCookie(cookieName, { path: '/' });
    return { authenticated: false };
  });

  app.get('/api/admin/session', async (request) => {
    const token = request.cookies[cookieName];
    if (!token) return { authenticated: false };

    const { verifySessionToken } = await import('../security.ts');
    const session = verifySessionToken(ctx.config.sessionSecret, token, new Date());

    return session
      ? { authenticated: true, expiresAt: new Date(session.exp).toISOString() }
      : { authenticated: false };
  });

  /**
   * 演示/验收专用：把可控时钟推进到指定时间。
   *
   * 方案第 7 阶段要求「用可控测试时间验证规则，不需要真实等待 7/15 天」。
   * 该接口只在 DEV_TIME_TRAVEL=true 且非生产环境时可用。
   */
  app.post('/api/admin/dev/advance-time', async (request, reply) => {
    if (!ctx.travelClock) {
      return reply.code(403).send(
        new DomainError(
          'FORBIDDEN',
          '时间旅行未启用。请在 .env 中设置 DEV_TIME_TRAVEL=true 后重启服务（生产环境不可用）。',
        ).toResponse(),
      );
    }

    const body = (request.body ?? {}) as { days?: unknown; hours?: unknown; to?: unknown; reset?: unknown };

    if (body.reset === true) {
      ctx.travelClock.set(new Date());
      return { now: ctx.travelClock.now().toISOString(), action: 'reset' };
    }

    // 精确指定时间点：验收提醒规则时用它把时钟拨到计划时间附近，避免受时区与发送时段影响
    if (typeof body.to === 'string' && body.to.trim() !== '') {
      const target = new Date(body.to);
      if (Number.isNaN(target.getTime())) {
        return reply.code(400).send(
          new DomainError('VALIDATION_FAILED', 'to 必须是合法的 ISO 时间字符串', {
            issues: [{ field: 'to', message: '例如 2026-10-20T02:00:00.000Z' }],
          }).toResponse(),
        );
      }
      ctx.travelClock.set(target);
      const now = ctx.travelClock.now();
      ctx.logger.warn('演示：已将可控时钟设置为指定时间', { to: now.toISOString() });
      return { now: now.toISOString(), action: 'set' };
    }

    const days = Number(body.days ?? 0);
    const hours = Number(body.hours ?? 0);

    if ((!Number.isFinite(days) || days === 0) && (!Number.isFinite(hours) || hours === 0)) {
      return reply.code(400).send(
        new DomainError('VALIDATION_FAILED', '请提供 days / hours（可为负数）或 to（ISO 时间）', {
          issues: [
            { field: 'days', message: '天，可为负数' },
            { field: 'hours', message: '小时，可为负数' },
          ],
        }).toResponse(),
      );
    }

    if (Number.isFinite(days) && days !== 0) ctx.travelClock.advanceDays(days);
    if (Number.isFinite(hours) && hours !== 0) ctx.travelClock.advanceMs(hours * 60 * 60 * 1000);

    const now = ctx.travelClock.now();
    ctx.logger.warn('演示：已推进可控时钟', { days, hours, now: now.toISOString() });

    return { now: now.toISOString(), action: 'advance', days, hours };
  });

  app.get('/api/admin/dev/clock', async () => ({
    enabled: ctx.travelClock !== null,
    now: ctx.adapters.clock.now().toISOString(),
  }));
}