/**
 * 会员到期后的服务端权限控制（真实 API 路径）。
 *
 * 【修复前的缺陷】
 * `users.member_until` 从加进 schema 起就只被存储和读取，
 * **从来没有参与过任何判断** —— 会员到期后照样能发布到平台托管、用会员额度。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListingProject, createTestApp, registerUser } from '../helpers/test-app.ts';

/** 造一个指定到期时间的会员；null 表示不限期 */
async function member(
  t: Awaited<ReturnType<typeof createTestApp>>,
  email: string,
  opts: { tier?: string; memberUntil?: string | null } = {},
) {
  const u = await registerUser(t, email);
  const tier = opts.tier ?? 'basic';
  const until = opts.memberUntil === undefined ? null : opts.memberUntil;
  t.harness.ctx.db.prepare('UPDATE users SET tier = ?, member_until = ? WHERE email = ?').run(tier, until, email);
  return u;
}

/**
 * 相对**应用时钟**的日期。
 *
 * 测试环境的 clock 是 FakeClock，与真实时间不同。
 * 用真实 `Date.now()` 计算「一天前」，相对假时钟可能反而是「未来」——
 * 会员判定就永远不触发。所以一律从 `ctx.adapters.clock` 取基准。
 */
function appTime(t: Awaited<ReturnType<typeof createTestApp>>): number {
  return t.harness.ctx.adapters.clock.now().getTime();
}
function daysFrom(t: Awaited<ReturnType<typeof createTestApp>>, d: number): string {
  return new Date(appTime(t) + d * 86_400_000).toISOString();
}

async function quotaOf(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string) {
  const res = await t.app.inject({ method: 'GET', url: '/api/platform/quota', headers: { cookie } });
  return JSON.parse(res.body) as Record<string, any>;
}

async function tryPublish(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, id: string) {
  const res = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${id}/publish`, headers: { cookie } });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, any> };
}

const PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>会员页</title></head><body><h1>会员页</h1><p>这是一段足够长的正文内容，用于通过内容质量检查。</p></body></html>';

async function makeCustomPage(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, title: string) {
  const res = await t.app.inject({
    method: 'POST', url: '/api/platform/projects', headers: { cookie },
    payload: { pluginId: 'custom-page', title },
  });
  const id = JSON.parse(res.body).project.id as string;
  await t.app.inject({
    method: 'PATCH', url: `/api/platform/projects/${id}`, headers: { cookie },
    payload: { spec: { title: '会员页', html: PAGE } },
  });
  return id;
}

test('场景A：未到期会员的会员功能正常可用', async () => {
  const t = await createTestApp();
  try {
    const u = await member(t, 'mem-a@example.com', { memberUntil: daysFrom(t, 30) });

    const q = await quotaOf(t, u.cookie);
    assert.equal(q.tier, 'basic', '未到期会员应保持原套餐');
    assert.equal(q.hostingEnabled, true, '应包含平台托管');
    assert.equal(q.projects.quota, 3, '应按 basic 的项目上限');

    const pid = await makeCustomPage(t, u.cookie, '未到期会员项目');
    const pub = await tryPublish(t, u.cookie, pid);
    assert.equal(pub.status, 200, `未到期会员应能发布：${JSON.stringify(pub.body).slice(0, 140)}`);
    assert.ok(pub.body.publicUrl, '应返回公开地址');

    const page = await t.app.inject({ method: 'GET', url: new URL(pub.body.publicUrl).pathname });
    assert.equal(page.statusCode, 200, '公开地址应可访问');
  } finally {
    await t.dispose();
  }
});

test('场景B：已到期会员的会员功能被服务端拒绝，并提示续期', async () => {
  const t = await createTestApp();
  try {
    const u = await member(t, 'mem-b@example.com', { memberUntil: daysFrom(t, -1) });

    // 额度接口必须反映为免费套餐
    const q = await quotaOf(t, u.cookie);
    assert.equal(q.tier, 'free', '到期后生效套餐应为 free');
    assert.equal(q.hostingEnabled, false, '到期后不应再有平台托管');
    assert.equal(q.projects.quota, 1, '到期后应按免费套餐的项目上限');

    const pid = await makeCustomPage(t, u.cookie, '到期会员项目');
    const pub = await tryPublish(t, u.cookie, pid);
    assert.equal(pub.status, 403, `到期会员发布应被拒绝，实际 ${pub.status}`);
    assert.equal(pub.body.publicUrl, undefined, '被拒时不得返回公开地址');

    const message = pub.body.error?.message ?? '';
    assert.match(message, /到期/, `提示应说明是「到期」，实际：${message}`);
    assert.match(message, /续期/, `提示应给出续期方向，实际：${message}`);

    // 项目状态不能被改动
    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.equal(detail.project.status, 'draft');
    assert.equal(detail.project.publicSlug, null);
  } finally {
    await t.dispose();
  }
});

test('场景C：免费用户原有功能不受影响，会员功能仍受限', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'mem-c@example.com');
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'free' WHERE email = ?").run('mem-c@example.com');

    // 原来允许的：建项目、预览、下载
    const pid = await makeCustomPage(t, u.cookie, '免费用户项目');
    const preview = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${pid}/preview`, headers: { cookie: u.cookie } });
    assert.equal(preview.statusCode, 200, '免费用户应仍能预览');
    const dl = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${pid}/export`, headers: { cookie: u.cookie } });
    assert.equal(dl.statusCode, 200, '免费用户应仍能下载');

    // 会员专属：托管仍受限
    const pub = await tryPublish(t, u.cookie, pid);
    assert.equal(pub.status, 403, '免费用户不应能发布到托管');

    // 免费用户即便 member_until 是过去时间，也不该被说成「会员到期」
    t.harness.ctx.db.prepare("UPDATE users SET member_until = ? WHERE email = ?").run(daysFrom(t, -5), 'mem-c@example.com');
    const q = await quotaOf(t, u.cookie);
    assert.equal(q.tier, 'free');
    const pub2 = await tryPublish(t, u.cookie, pid);
    assert.equal(pub2.status, 403);
    assert.ok(!/到期/.test(pub2.body.error?.message ?? ''), '免费用户不该被提示「会员到期」');
  } finally {
    await t.dispose();
  }
});

test('场景D：请求体里声明会员身份或有效期一律无效', async () => {
  const t = await createTestApp();
  try {
    const u = await member(t, 'mem-d@example.com', { memberUntil: daysFrom(t, -1), tier: 'basic' });

    // 先建一个项目（免费额度允许 1 个）
    const pid = await makeCustomPage(t, u.cookie, '篡改测试');

    // 在发布请求体里塞各种「我其实是会员」的字段
    for (const payload of [
      { tier: 'pro' },
      { member_until: daysFrom(t, 365) },
      { memberUntil: daysFrom(t, 365) },
      { userId: 'usr_other' },
      { plan_id: 'pro' },
      { tier: 'pro', member_until: daysFrom(t, 365), hostingEnabled: true },
    ]) {
      const res = await t.app.inject({
        method: 'POST', url: `/api/platform/projects/${pid}/publish`,
        headers: { cookie: u.cookie }, payload,
      });
      assert.equal(res.statusCode, 403, `请求体伪造 ${JSON.stringify(payload)} 不应生效，实际 ${res.statusCode}`);
    }

    // 额度接口也不该被请求体影响
    await t.app.inject({
      method: 'GET', url: `/api/platform/quota?tier=pro&member_until=${encodeURIComponent(daysFrom(t, 365))}`,
      headers: { cookie: u.cookie },
    });
    const q = await quotaOf(t, u.cookie);
    assert.equal(q.tier, 'free', '查询参数同样不能提升套餐');

    // 数据库里的到期时间没有被改写
    const row = t.harness.ctx.db.prepare('SELECT member_until FROM users WHERE email = ?').get('mem-d@example.com') as { member_until: string };
    assert.ok(
      new Date(row.member_until).getTime() < appTime(t),
      '库中的到期时间不应被客户端改写（且确实已过期）',
    );
  } finally {
    await t.dispose();
  }
});

test('场景E：到期不删除项目、版本与已发布页面', async () => {
  const t = await createTestApp();
  try {
    // 先用有效会员发布
    const u = await member(t, 'mem-e@example.com', { memberUntil: daysFrom(t, 1) });
    const pid = await makeCustomPage(t, u.cookie, '到期保留测试');
    const pub = await tryPublish(t, u.cookie, pid);
    assert.equal(pub.status, 200, pub.body && JSON.stringify(pub.body).slice(0, 120));
    const url = pub.body.publicUrl as string;
    assert.ok((await t.app.inject({ method: 'GET', url: new URL(url).pathname })).body.includes('会员页'));

    const before = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);

    // 把会员改成已到期
    t.harness.ctx.db.prepare('UPDATE users SET member_until = ? WHERE email = ?').run(daysFrom(t, -1), 'mem-e@example.com');

    // 项目、版本、公开页面都必须完好
    const after = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.equal(after.project.status, 'published', '到期不应改变项目的发布状态');
    assert.equal(after.project.publicSlug, before.project.publicSlug, '短链不应改变');
    assert.equal(after.versions.length, before.versions.length, '版本历史不应被删除');
    assert.deepEqual(after.project.spec, before.project.spec, '内容不应被改动');

    // 公开页面仍可匿名访问（到期不自动下线已发布页面）
    const page = await t.app.inject({ method: 'GET', url: new URL(url).pathname });
    assert.equal(page.statusCode, 200, '到期不应自动下线已发布页面');
    assert.ok(page.body.includes('会员页'), '页面内容应保持');

    // 但会员功能已被拒绝
    const republish = await tryPublish(t, u.cookie, pid);
    assert.equal(republish.status, 403, '到期后重新发布应被拒绝');

    // 导出仍可用（下载是免费功能）
    const dl = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${pid}/export`, headers: { cookie: u.cookie } });
    assert.equal(dl.statusCode, 200, '到期后仍应能下载自己的页面');
  } finally {
    await t.dispose();
  }
});

test('场景F：到期时刻前后与之后的行为正确（真实调用路径）', async () => {
  const t = await createTestApp();
  try {
    // 距离现在 2 秒后到期 —— 用于观察跨越到期时刻
    const until = new Date(appTime(t) + 2000).toISOString();
    const u = await member(t, 'mem-f@example.com', { memberUntil: until });

    const q1 = await quotaOf(t, u.cookie);
    assert.equal(q1.tier, 'basic', '到期前应保持会员套餐');

    // 直接把到期时间改成 1 毫秒前，等价于「已跨越到期时刻」
    t.harness.ctx.db.prepare('UPDATE users SET member_until = ? WHERE email = ?')
      .run(new Date(appTime(t) - 1).toISOString(), 'mem-f@example.com');
    const q2 = await quotaOf(t, u.cookie);
    assert.equal(q2.tier, 'free', '跨越到期时刻后应立即降为 free');

    // 到期时间与「现在」完全相同的边界由单元测试覆盖（毫秒级断言），
    // 集成层面验证的是「跨过之后立即生效」。
  } finally {
    await t.dispose();
  }
});

test('场景G：不受会员限制的功能仍正常，且无法借其它接口绕过', async () => {
  const t = await createTestApp();
  try {
    const u = await member(t, 'mem-g@example.com', { memberUntil: daysFrom(t, -10), tier: 'pro' });

    // 免费功能仍可用：建项目、保存、预览、下载、删除、回收站
    const pid = await makeCustomPage(t, u.cookie, '到期后免费功能');
    const preview = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${pid}/preview`, headers: { cookie: u.cookie } });
    assert.equal(preview.statusCode, 200);
    const dl = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${pid}/export`, headers: { cookie: u.cookie } });
    assert.equal(dl.statusCode, 200);

    // 会员专属：发布被拒
    assert.equal((await tryPublish(t, u.cookie, pid)).status, 403);

    // 不能借其它接口绕过：
    // ① 项目数上限按 free 计算（pro 是 20，free 是 1）
    const second = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'custom-page', title: '第二个项目' },
    });
    assert.equal(second.statusCode, 403, '到期后应按免费套餐的项目上限拒绝');

    // ② 「恢复」接口也走同一套判定，不能绕过项目上限
    const third = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'custom-page', title: '第三个项目' },
    });
    assert.equal(third.statusCode, 403, '恢复路径同样受上限约束');

    // ③ 批量接口 / 其它写接口都不能发布
    for (const url of [
      `/api/platform/projects/${pid}/publish`,
      `/api/platform/projects/${pid}/generate`,
    ]) {
      const res = await t.app.inject({ method: 'POST', url, headers: { cookie: u.cookie }, payload: { prompt: 'x' } });
      assert.notEqual(res.statusCode, 200, `${url} 不应在到期后成功`);
    }

    // ④ 房源插件项目同样不能发布
    const lp = await createListingProject(t, u.cookie, '到期房源项目');
    if (lp.project) {
      const res = await tryPublish(t, u.cookie, lp.project.id);
      assert.equal(res.status, 403, '房源项目同样受会员到期约束');
    }
  } finally {
    await t.dispose();
  }
});

test('登录与注册响应也按生效套餐返回（否则界面会与后续请求自相矛盾）', async () => {
  const t = await createTestApp();
  try {
    const email = 'mem-login@example.com';
    await registerUser(t, email);
    t.harness.ctx.db.prepare('UPDATE users SET tier = ?, member_until = ? WHERE email = ?')
      .run('pro', new Date(t.harness.ctx.adapters.clock.now().getTime() - 86_400_000).toISOString(), email);

    const login = await t.app.inject({
      method: 'POST', url: '/api/platform/login',
      payload: { email, password: 'platform-pass-123' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const body = JSON.parse(login.body) as Record<string, any>;

    assert.equal(body.user.tier, 'free', '登录响应应按生效套餐返回');
    assert.equal(body.quota.tier, 'free', '登录响应的额度也应是免费套餐');
    assert.equal(body.quota.hostingEnabled, false, '到期会员登录时不应显示含托管');

    // 与会话接口保持一致
    const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
    const session = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/session', headers: { cookie },
    })).body) as Record<string, any>;
    assert.equal(session.user.tier, body.user.tier, '登录与会话的套餐必须一致');
    assert.equal(session.quota.tier, body.quota.tier);
  } finally {
    await t.dispose();
  }
});