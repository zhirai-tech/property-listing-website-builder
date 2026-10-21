/**
 * `adminEnabled` 服务端权限控制。
 *
 * 【修复前的缺陷】
 * `checkQuota(action:'plugin.admin')` 这条规则早就写好了，
 * 但**全库没有任何路由调用过它** —— `adminEnabled` 是一个
 * 「可查询、永不生效」的权限位。
 *
 * 【这个权限位是什么】
 * 它是**套餐能力位**（free=false、basic/pro=true），语义是
 * 「该套餐是否包含插件在线管理后台」。它**不是**「系统管理员身份」——
 * 平台侧没有管理员身份；房东端后台是另一套独立口令会话，两者不互相授权。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerUser } from '../helpers/test-app.ts';

const ADMIN_PATH = '/api/platform/plugins/listing/admin';

function appTime(t: Awaited<ReturnType<typeof createTestApp>>): number {
  return t.harness.ctx.adapters.clock.now().getTime();
}
function daysFrom(t: Awaited<ReturnType<typeof createTestApp>>, d: number): string {
  return new Date(appTime(t) + d * 86_400_000).toISOString();
}

/** 造一个指定套餐/到期时间的用户 */
async function user(
  t: Awaited<ReturnType<typeof createTestApp>>,
  email: string,
  opts: { tier?: string; memberUntil?: string | null } = {},
) {
  const u = await registerUser(t, email);
  t.harness.ctx.db
    .prepare('UPDATE users SET tier = ?, member_until = ? WHERE email = ?')
    .run(opts.tier ?? 'free', opts.memberUntil ?? null, email);
  return u;
}

const get = (t: Awaited<ReturnType<typeof createTestApp>>, url: string, cookie?: string) =>
  t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

test('场景A：未登录用户无法调用受保护的管理接口', async () => {
  const t = await createTestApp();
  try {
    const res = await get(t, ADMIN_PATH);
    assert.equal(res.statusCode, 401, `未登录应为 401，实际 ${res.statusCode}`);
    // 不能泄露插件信息
    assert.ok(!res.body.includes('structuralKeys'), '未登录不应拿到管理视图内容');

    // 百分号编码路径同样被拦（防止绕过守卫）
    const encoded = await get(t, '/%61pi/platform/plugins/listing/admin');
    assert.equal(encoded.statusCode, 401, `编码路径也应为 401，实际 ${encoded.statusCode}`);
  } finally {
    await t.dispose();
  }
});

test('场景B：普通免费用户无法调用受保护的管理接口', async () => {
  const t = await createTestApp();
  try {
    const u = await user(t, 'adm-b@example.com', { tier: 'free' });
    const res = await get(t, ADMIN_PATH, u.cookie);
    assert.equal(res.statusCode, 403, `免费用户应为 403，实际 ${res.statusCode}`);
    const body = JSON.parse(res.body);
    assert.equal(body.error?.code, 'FORBIDDEN');
    assert.match(body.error?.message ?? '', /管理后台|套餐/, '应说明缺少管理能力');
    assert.ok(!res.body.includes('structuralKeys'), '被拒时不应泄露管理视图内容');
  } finally {
    await t.dispose();
  }
});

test('场景C：已到期会员不因会员身份获得管理权限', async () => {
  const t = await createTestApp();
  try {
    // tier 是 basic（adminEnabled=true），但已到期
    const u = await user(t, 'adm-c@example.com', { tier: 'basic', memberUntil: daysFrom(t, -1) });
    const res = await get(t, ADMIN_PATH, u.cookie);

    assert.equal(res.statusCode, 403, `到期会员应为 403，实际 ${res.statusCode}`);
    const body = JSON.parse(res.body);
    const message = body.error?.message ?? '';
    assert.match(message, /到期/, `提示应说明已到期，实际：${message}`);
    assert.match(message, /续期/, `提示应指向续期，实际：${message}`);
    assert.ok(!res.body.includes('structuralKeys'), '被拒时不应泄露管理视图内容');

    // 对照：把到期时间改成未来，同一个用户立刻可用 —— 证明差别就在有效期
    t.harness.ctx.db
      .prepare('UPDATE users SET member_until = ? WHERE email = ?')
      .run(daysFrom(t, 30), 'adm-c@example.com');
    assert.equal((await get(t, ADMIN_PATH, u.cookie)).statusCode, 200, '续期后应恢复管理能力');
  } finally {
    await t.dispose();
  }
});

test('场景D：有管理权限的会员可以正常使用管理功能', async () => {
  const t = await createTestApp();
  try {
    for (const tier of ['basic', 'pro']) {
      const email = `adm-d-${tier}@example.com`;
      const u = await user(t, email, { tier, memberUntil: daysFrom(t, 30) });
      const res = await get(t, ADMIN_PATH, u.cookie);
      assert.equal(res.statusCode, 200, `${tier} 应可访问管理视图，实际 ${res.statusCode}`);

      const body = JSON.parse(res.body) as Record<string, any>;
      assert.equal(body.plugin.id, 'listing');
      assert.ok(Array.isArray(body.plugin.structuralKeys), '应含结构键');
      assert.ok(Array.isArray(body.plugin.fields) && body.plugin.fields.length > 0, '应含字段清单');
      assert.ok(body.plugin.capabilities !== undefined, '应含能力声明');
      assert.equal(body.entitlement.adminEnabled, true, '应体现当前套餐包含管理后台');
      assert.equal(body.entitlement.tier, tier);
      assert.equal(typeof body.usage.projects, 'number', '应含自己的项目计数');
    }

    // 不存在的插件 → 404（而不是 403，避免变成插件探测器）
    const u2 = await user(t, 'adm-d2@example.com', { tier: 'pro', memberUntil: daysFrom(t, 30) });
    assert.equal((await get(t, '/api/platform/plugins/no-such/admin', u2.cookie)).statusCode, 404);
  } finally {
    await t.dispose();
  }
});

test('场景E：篡改客户端参数无法绕过权限检查', async () => {
  const t = await createTestApp();
  try {
    const u = await user(t, 'adm-e@example.com', { tier: 'free' });

    // 查询参数
    for (const qs of [
      '?adminEnabled=true',
      '?tier=pro',
      '?adminEnabled=true&tier=pro&hostingEnabled=true',
    ]) {
      const res = await get(t, ADMIN_PATH + qs, u.cookie);
      assert.equal(res.statusCode, 403, `查询参数 ${qs} 不应生效，实际 ${res.statusCode}`);
    }

    // 请求头
    for (const headers of [
      { 'x-admin-enabled': 'true', cookie: u.cookie },
      { 'x-platform-tier': 'pro', cookie: u.cookie },
      { 'x-user-id': 'usr_other', cookie: u.cookie },
      { 'x-platform-role': 'admin', cookie: u.cookie },
    ]) {
      const res = await t.app.inject({ method: 'GET', url: ADMIN_PATH, headers });
      assert.equal(res.statusCode, 403, `请求头伪造不应生效，实际 ${res.statusCode}`);
    }

    // 请求体（POST 到管理接口不存在，用 GET 带 body 也应无效）
    const withBody = await t.app.inject({
      method: 'GET', url: ADMIN_PATH, headers: { cookie: u.cookie },
      payload: { adminEnabled: true, tier: 'pro', userId: 'usr_other', role: 'admin' },
    });
    assert.equal(withBody.statusCode, 403, '请求体伪造不应生效');

    // 库里的套餐没有被改写
    const row = t.harness.ctx.db.prepare('SELECT tier, member_until FROM users WHERE email = ?')
      .get('adm-e@example.com') as { tier: string; member_until: string | null };
    assert.equal(row.tier, 'free', '库中套餐不应被客户端改写');
    assert.equal(row.member_until, null);

    // 伪造的 Cookie 也不行（签名校验）
    const forged = await t.app.inject({
      method: 'GET', url: ADMIN_PATH,
      headers: { cookie: 'platform_session=eyJzdWIiOiJ1c3JfeCIsInJvbGUiOiJhZG1pbiJ9.forged' },
    });
    assert.equal(forged.statusCode, 401, '伪造会话应为 401');
  } finally {
    await t.dispose();
  }
});

test('场景F：普通用户的创建、预览、下载与公开页面访问不受影响', async () => {
  const t = await createTestApp();
  try {
    const u = await user(t, 'adm-f@example.com', { tier: 'free' });

    // 建项目
    const created = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'custom-page', title: '普通用户项目' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const pid = JSON.parse(created.body).project.id as string;

    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>普通页面</title></head><body><h1>普通页面</h1><p>这是一段足够长的正文内容，用于通过内容质量检查。</p></body></html>';
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { title: '普通页面', html } },
    });

    // 预览 / 下载
    assert.equal((await get(t, `/api/platform/projects/${pid}/preview`, u.cookie)).statusCode, 200, '预览应正常');
    assert.equal((await get(t, `/api/platform/projects/${pid}/export`, u.cookie)).statusCode, 200, '下载应正常');

    // 插件目录接口仍应对所有登录用户开放（建项目需要它）—— 不能被这次改动锁上
    const catalog = await get(t, '/api/platform/plugins', u.cookie);
    assert.equal(catalog.statusCode, 200, '插件目录应对普通用户开放（建项目依赖它）');

    // 安全统计仍对免费用户开放（刻意的产品决定：让用户知道请求为什么被拒）
    const stats = await get(t, '/api/platform/safety-stats', u.cookie);
    assert.equal(stats.statusCode, 200, '安全统计应对免费用户开放');

    // 公开页面访问：用一个会员账号发布，然后**匿名**访问。
    // 这样不依赖演示数据，而且顺带证明了「管理权限的改动没有影响公开路由」。
    const member = await user(t, 'adm-f-member@example.com', { tier: 'basic', memberUntil: daysFrom(t, 30) });
    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: member.cookie },
    });
    // 这个项目属于 free 用户，会员不能发布它 —— 换成会员自己的项目
    assert.notEqual(pub.statusCode, 200, '不应能发布他人的项目');

    const own = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: member.cookie },
      payload: { pluginId: 'custom-page', title: '会员发布页' },
    });
    const ownId = JSON.parse(own.body).project.id as string;
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${ownId}`, headers: { cookie: member.cookie },
      payload: { spec: { title: '会员发布页', html } },
    });
    const published = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${ownId}/publish`, headers: { cookie: member.cookie },
    });
    assert.equal(published.statusCode, 200, published.body);
    const publicUrl = JSON.parse(published.body).publicUrl as string;

    // 匿名访问
    const anon = await get(t, new URL(publicUrl).pathname);
    assert.equal(anon.statusCode, 200, '公开页面应可匿名访问');
    assert.ok(anon.body.includes('普通页面'), '公开页面内容应正常');
  } finally {
    await t.dispose();
  }
});

test('场景G：逐一核对所有相关接口，不存在遗漏的绕过入口', async () => {
  const t = await createTestApp();
  try {
    const free = await user(t, 'adm-g-free@example.com', { tier: 'free' });
    const member = await user(t, 'adm-g-pro@example.com', { tier: 'pro', memberUntil: daysFrom(t, 30) });

    // ① 受 adminEnabled 保护的接口：逐一验证未授权一律被拒
    const protectedPaths = [
      '/api/platform/plugins/listing/admin',
      '/api/platform/plugins/custom-page/admin',
    ];
    for (const path of protectedPaths) {
      assert.equal((await get(t, path)).statusCode, 401, `${path} 未登录应 401`);
      assert.equal((await get(t, path, free.cookie)).statusCode, 403, `${path} 免费用户应 403`);
      assert.equal((await get(t, path, member.cookie)).statusCode, 200, `${path} 有权限时应 200`);
    }

    // ② 刻意**不**受该权限位保护的接口：确认它们对普通用户仍然开放
    //    （锁上任何一个都会破坏既有产品规则）
    const intentionallyOpen = [
      '/api/platform/plugins',      // 建项目需要插件目录
      '/api/platform/quota',        // 展示自己的额度
      '/api/platform/examples',     // 示例画廊
      '/api/platform/safety-stats', // 让用户知道请求为什么被拒
      '/api/platform/projects',     // 自己的项目列表
    ];
    for (const path of intentionallyOpen) {
      assert.equal((await get(t, path, free.cookie)).statusCode, 200, `${path} 应对免费用户开放`);
      assert.equal((await get(t, path)).statusCode, 401, `${path} 未登录应 401`);
    }

    // ③ 平台会话不能借道房东端后台（两套系统互不授权）
    for (const path of ['/api/admin/overview', '/api/admin/properties', '/api/admin/settings']) {
      assert.equal((await get(t, path, member.cookie)).statusCode, 401, `${path} 平台会话应被拒`);
    }

    // ④ 即使有管理能力，也不能读别人的数据：管理视图只统计自己的项目
    const other = await user(t, 'adm-g-other@example.com', { tier: 'pro', memberUntil: daysFrom(t, 30) });
    await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: other.cookie },
      payload: { pluginId: 'listing', title: '别人的房源项目' },
    });
    const view = JSON.parse((await get(t, ADMIN_PATH, member.cookie)).body) as Record<string, any>;
    assert.equal(view.usage.projects, 0, '管理视图不应统计到他人的项目');

    // ⑤ 管理视图不返回任何密钥或内部信息
    const raw = (await get(t, ADMIN_PATH, member.cookie)).body;
    for (const secret of ['adminPassword', 'sessionSecret', 'AI_API_KEY', 'password_hash', 'app.sqlite']) {
      assert.ok(!raw.includes(secret), `管理视图不得包含 ${secret}`);
    }
  } finally {
    await t.dispose();
  }
});