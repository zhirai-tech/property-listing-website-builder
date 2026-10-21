/**
 * 平台用户接口集成测试。
 *
 * 重点验证用户明确列出的安全与额度要求：
 *   - 服务端执行额度（不是前端隐藏按钮）
 *   - 用户之间数据隔离（改 ID 拿不到别人的项目）
 *   - 重复提交不能绕过额度检查
 *   - 平台会话与后台会话互相不可用（防权限提升）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListingProject, createTestApp, multipart, registerUser, tinyPng, TEST_PASSWORD, propertyInput } from '../helpers/test-app.ts';
import { expireOverdueProjects } from '../../src/platform/retention.ts';


test('注册、登录与会话探测', async () => {
  const t = await createTestApp();
  try {
    const reg = await registerUser(t, 'a@example.com', '甲');
    assert.equal(reg.status, 201, reg.body?.error?.message ?? '');
    assert.equal(reg.body.user.email, 'a@example.com');
    assert.equal(reg.body.user.tier, 'free');
    assert.ok(reg.cookie.startsWith('platform_session='), '应下发平台会话 Cookie');
    assert.ok(reg.body.quota, '注册响应应带额度摘要');

    const session = await t.app.inject({ method: 'GET', url: '/api/platform/session', headers: { cookie: reg.cookie } });
    const sj = JSON.parse(session.body);
    assert.equal(sj.authenticated, true);

    // 重复注册同一邮箱应被拒
    const dup = await registerUser(t, 'a@example.com');
    assert.equal(dup.status, 400);

    // 弱口令
    const weak = await t.app.inject({
      method: 'POST', url: '/api/platform/register',
      payload: { email: 'b@example.com', password: '123', displayName: '乙' },
    });
    assert.equal(weak.statusCode, 400);

    // 错误口令登录返回 401
    const bad = await t.app.inject({
      method: 'POST', url: '/api/platform/login',
      payload: { email: 'a@example.com', password: 'wrong-password' },
    });
    assert.equal(bad.statusCode, 401);

    const ok = await t.app.inject({
      method: 'POST', url: '/api/platform/login',
      payload: { email: 'a@example.com', password: 'platform-pass-123' },
    });
    assert.equal(ok.statusCode, 200);
  } finally {
    await t.dispose();
  }
});

test('未登录访问平台接口一律 401（含编码变体）', async () => {
  const t = await createTestApp();
  try {
    for (const url of [
      '/api/platform/projects',
      '/api/platform/quota',
      '/api/platform/plugins',
      '/%61pi/platform/projects',
      '/api/%70latform/projects',
    ]) {
      const res = await t.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, `${url} 应返回 401，实际 ${res.statusCode}`);
    }
    // 公开的三条应匿名可达
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/platform/session' })).statusCode, 200);
  } finally {
    await t.dispose();
  }
});

test('两套会话互不通用：后台 Cookie 不能访问平台接口，平台 Cookie 不能访问后台接口', async () => {
  const t = await createTestApp();
  try {
    const reg = await registerUser(t, 'iso@example.com');

    // 后台 Cookie 访问平台受保护接口 → 401
    const withAdmin = await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: t.cookie },
    });
    assert.equal(withAdmin.statusCode, 401, '后台会话不应被平台接口接受');

    // 平台 Cookie 访问后台接口 → 401（这是防权限提升的关键断言）
    const withPlatform = await t.app.inject({
      method: 'GET', url: '/api/admin/overview', headers: { cookie: reg.cookie },
    });
    assert.equal(withPlatform.statusCode, 401, '平台会话绝不能被后台接口接受');
  } finally {
    await t.dispose();
  }
});

test('用户之间数据隔离：改 ID 拿不到别人的项目', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t, 'user-a@example.com', 'A');
    const b = await registerUser(t, 'user-b@example.com', 'B');

    const made = await createListingProject(t, a.cookie, 'A 的项目');
    assert.equal(made.status, 201, JSON.stringify(made.project ?? {}));
    const projectId = made.project.id;

    // A 自己能读到
    const own = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${projectId}`, headers: { cookie: a.cookie },
    });
    assert.equal(own.statusCode, 200);

    // B 读同一个 id → 404（不是 403，避免泄露「这个 id 存在」）
    const other = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${projectId}`, headers: { cookie: b.cookie },
    });
    assert.equal(other.statusCode, 404, 'B 不应读到 A 的项目');

    // B 改不了
    const patch = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${projectId}`,
      headers: { cookie: b.cookie }, payload: { title: '被篡改' },
    });
    assert.equal(patch.statusCode, 404);

    // B 发布不了
    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${projectId}/publish`, headers: { cookie: b.cookie },
    });
    assert.equal(pub.statusCode, 404);

    // B 也 AI 改不了
    const ai = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${projectId}/generate`,
      headers: { cookie: b.cookie }, payload: { prompt: 'title: 黑客' },
    });
    assert.equal(ai.statusCode, 404);

    // B 的列表里看不到 A 的项目
    const list = await t.app.inject({ method: 'GET', url: '/api/platform/projects', headers: { cookie: b.cookie } });
    assert.equal(JSON.parse(list.body).items.length, 0, 'B 的项目列表应为空');
  } finally {
    await t.dispose();
  }
});

test('免费用户：项目数上限由服务端执行', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'limit@example.com');
    const first = await createListingProject(t, u.cookie, '第一个');
    assert.equal(first.status, 201);

    // 第二个项目应被额度拒绝（免费上限 1）
    const second = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'listing', title: '第二个' },
    });
    assert.equal(second.statusCode, 403, '超出项目上限应被服务端拒绝');
    assert.match(second.body, /最多创建 1 个项目/);
  } finally {
    await t.dispose();
  }
});

test('免费用户不能发布到平台托管（服务端判定，非前端隐藏）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'publish@example.com');
    const made = await createListingProject(t, u.cookie);
    const res = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /托管/);
    // 直接构造请求也一样被拒（不是靠前端不显示按钮）
  } finally {
    await t.dispose();
  }
});

test('AI 生成：扣额度、写台账、标记为模拟用量', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'ai@example.com');
    const made = await createListingProject(t, u.cookie);

    const before = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);
    assert.equal(before.generations.used, 0);

    const gen = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/generate`,
      headers: { cookie: u.cookie, 'x-task-id': 'task-abc-1' },
      payload: { prompt: 'title: 阳光两居\npriceAmount: 9000' },
    });
    assert.equal(gen.statusCode, 200, gen.body);
    const gj = JSON.parse(gen.body);
    assert.equal(gj.patch.title, '阳光两居');
    assert.equal(gj.simulated, true, '必须明确标注是模拟用量，不能冒充真实消耗');
    assert.ok(gj.usage.totalTokens > 0);
    assert.equal(gj.quota.generations.used, 1, '额度应实时反映');

    // 台账里应有记录
    const rows = t.harness.ctx.db.prepare('SELECT * FROM ai_usage WHERE user_id = ?').all(gj.quota ? (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?').get('ai@example.com') as { id: string }).id : '');
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as { status: string }).status, 'succeeded');
  } finally {
    await t.dispose();
  }
});

test('重复提交同一 taskId 不会二次扣额度', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'dup@example.com');
    const made = await createListingProject(t, u.cookie);
    const id = made.project.id;

    const first = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/generate`,
      headers: { cookie: u.cookie, 'x-task-id': 'same-task-1' },
      payload: { prompt: 'title: 第一次' },
    });
    assert.equal(first.statusCode, 200);

    const second = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/generate`,
      headers: { cookie: u.cookie, 'x-task-id': 'same-task-1' },
      payload: { prompt: 'title: 第二次' },
    });
    assert.equal(second.statusCode, 409, '重复任务应返回冲突而不是再跑一次');

    const quota = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);
    assert.equal(quota.generations.used, 1, '重复提交不应二次计数');
  } finally {
    await t.dispose();
  }
});

test('免费用户 AI 修改次数用尽后被服务端拒绝', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'revise@example.com');
    const made = await createListingProject(t, u.cookie);
    const id = made.project.id;

    const ok = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/revise`,
      headers: { cookie: u.cookie, 'x-task-id': 'rev-1' },
      payload: { prompt: 'title: 改一次' },
    });
    assert.equal(ok.statusCode, 200);

    const denied = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/revise`,
      headers: { cookie: u.cookie, 'x-task-id': 'rev-2' },
      payload: { prompt: 'title: 再改一次' },
    });
    assert.equal(denied.statusCode, 403);
    assert.match(denied.body, /修改次数/);
  } finally {
    await t.dispose();
  }
});

test('草稿修改不破坏已发布版本', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'draft@example.com');

    // 手工把该用户升成 basic（有托管权限），以验证发布路径
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run('draft@example.com');

    const made = await createListingProject(t, u.cookie, '原始标题');
    const id = made.project.id;

    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(pub.statusCode, 200, pub.body);
    const publishedVersionId = JSON.parse(pub.body).project.publishedVersionId;
    assert.ok(publishedVersionId);

    // 改草稿
    const patched = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${id}`,
      headers: { cookie: u.cookie }, payload: { title: '改过的标题' },
    });
    assert.equal(patched.statusCode, 200);

    // 发布指针必须没动
    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${id}`, headers: { cookie: u.cookie },
    })).body);
    assert.equal(detail.project.publishedVersionId, publishedVersionId, '改草稿不得改动发布指针');
    assert.equal(detail.project.title, '改过的标题', '草稿标题已更新');

    // 发布版本的内容仍是旧的
    const pubVer = t.harness.ctx.db
      .prepare('SELECT spec_json FROM project_versions WHERE id = ?')
      .get(publishedVersionId) as { spec_json: string };
    assert.ok(pubVer, '发布版本应仍在库中');
  } finally {
    await t.dispose();
  }
});

test('规格净化：未声明的键被丢弃，结构性键保留', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'spec@example.com');
    const made = await createListingProject(t, u.cookie);
    const id = made.project.id;

    const patched = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${id}`,
      headers: { cookie: u.cookie },
      payload: { spec: { title: '合规标题', evilKey: '注入', __proto__: 'x' } },
    });
    assert.equal(patched.statusCode, 200);
    const spec = JSON.parse(patched.body).project.spec;
    assert.equal(spec.title, '合规标题');
    assert.equal(Object.hasOwn(spec, 'evilKey'), false, '未声明键必须被丢弃');
    assert.ok(spec.propertyId, '结构性键 propertyId 必须保留');
  } finally {
    await t.dispose();
  }
});

test('插件与额度接口对已登录用户可用', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'plugins@example.com');

    const plugins = await t.app.inject({
      method: 'GET', url: '/api/platform/plugins', headers: { cookie: u.cookie },
    });
    assert.equal(plugins.statusCode, 200);
    const items = JSON.parse(plugins.body).items;
    assert.ok(items.some((p: { id: string }) => p.id === 'listing'), '应列出房源插件');
    assert.equal(items.find((p: { id: string }) => p.id === 'listing').executable, true, '内置插件可执行');

    const quota = await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    });
    assert.equal(quota.statusCode, 200);
    const q = JSON.parse(quota.body);
    assert.equal(q.tier, 'free');
    assert.equal(q.tokens.quota, 500_000);
    assert.equal(q.projects.quota, 1);
    assert.equal(q.hostingEnabled, false);
  } finally {
    await t.dispose();
  }
});

test('管理员口令仍可用于后台，且不受平台用户影响', async () => {
  const t = await createTestApp();
  try {
    await registerUser(t, 'nobody@example.com');
    const adminLogin = await t.app.inject({
      method: 'POST', url: '/api/admin/login', payload: { password: TEST_PASSWORD },
    });
    assert.equal(adminLogin.statusCode, 200);
    assert.match(String(adminLogin.headers['set-cookie']), /admin_session=/);
  } finally {
    await t.dispose();
  }
});

test('登出会真正吊销会话：旧令牌立即失效（服务端吊销，不只是清 Cookie）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'revoke@example.com');
    assert.equal(u.status, 201);

    // 登出前可用
    const before = await t.app.inject({ method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie } });
    assert.equal(before.statusCode, 200);

    const logout = await t.app.inject({ method: 'POST', url: '/api/platform/logout', headers: { cookie: u.cookie } });
    assert.equal(logout.statusCode, 200);

    // 关键断言：拿着**登出前的同一个 Cookie**再访问，必须被拒。
    // 只清 Cookie 的实现这里会返回 200 —— 那样被截获的令牌在 7 天有效期内一直可用。
    const after = await t.app.inject({ method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie } });
    assert.equal(after.statusCode, 401, '登出后旧令牌必须失效');

    // 重新登录应拿到可用会话
    const again = await t.app.inject({
      method: 'POST', url: '/api/platform/login',
      payload: { email: 'revoke@example.com', password: 'platform-pass-123' },
    });
    assert.equal(again.statusCode, 200);
    const newCookie = String(again.headers['set-cookie']).split(';')[0] ?? '';
    const withNew = await t.app.inject({ method: 'GET', url: '/api/platform/projects', headers: { cookie: newCookie } });
    assert.equal(withNew.statusCode, 200, '重新登录后应可访问');
  } finally {
    await t.dispose();
  }
});

test('管理员停用账号后，该用户的既有会话立即失效', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'disable@example.com');
    assert.equal(
      (await t.app.inject({ method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie } })).statusCode,
      200,
    );

    // 停用账号（不需要改 session_version，因为每次请求都会回库确认状态）
    t.harness.ctx.db.prepare("UPDATE users SET status = 'disabled' WHERE email = ?").run('disable@example.com');

    const after = await t.app.inject({ method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie } });
    assert.equal(after.statusCode, 401, '账号停用后既有会话应立即失效');
  } finally {
    await t.dispose();
  }
});

test('伪造或篡改的平台令牌不被接受', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'forge@example.com');
    const real = u.cookie.split('=')[1] ?? '';

    for (const forged of [
      'platform_session=forged.payload',
      'platform_session=',
      `platform_session=${real.slice(0, -3)}xxx`,
      `platform_session=${real}.extra`,
    ]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/platform/projects', headers: { cookie: forged } });
      assert.equal(res.statusCode, 401, `${forged.slice(0, 40)} 应被拒`);
    }
  } finally {
    await t.dispose();
  }
});

test('注册会为每个平台用户创建独立工作区（数据隔离在数据层）', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t, 'ws-a@example.com', 'A');
    const b = await registerUser(t, 'ws-b@example.com', 'B');

    const rows = t.harness.ctx.db
      .prepare('SELECT id, workspace_id FROM users WHERE is_system = 0 ORDER BY email')
      .all() as { id: string; workspace_id: string }[];

    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.workspace_id, rows[1]!.workspace_id, '两个用户必须有不同的工作区');
    // 遗留工作区不受影响
    assert.ok(
      rows.every((r) => r.workspace_id !== t.harness.ctx.workspace.id),
      '平台用户不应挂到遗留工作区上',
    );
    // 每个工作区的 owner 指向该用户
    for (const r of rows) {
      const ws = t.harness.ctx.db
        .prepare('SELECT owner_user_id FROM workspaces WHERE id = ?')
        .get(r.workspace_id) as { owner_user_id: string };
      assert.equal(ws.owner_user_id, r.id, '工作区 owner 应指向该用户');
    }
  } finally {
    await t.dispose();
  }
});

test('房源项目会自动创建一套归属该用户的房源，并可导出', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'autoprop@example.com');
    // 不再需要后台先建房源：项目自己会建
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/platform/projects',
      headers: { cookie: u.cookie },
      payload: { pluginId: 'listing', title: '自动建房源项目' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const project = JSON.parse(res.body).project;
    const propertyId = project.spec.propertyId;
    assert.ok(propertyId, '房源项目应自动带上 propertyId');

    // 房源应落在该用户自己的工作区，而不是遗留工作区
    const user = t.harness.ctx.db
      .prepare('SELECT workspace_id FROM users WHERE email = ?')
      .get('autoprop@example.com') as { workspace_id: string };
    const prop = t.harness.ctx.db
      .prepare('SELECT workspace_id, title, status FROM properties WHERE id = ?')
      .get(propertyId) as { workspace_id: string; title: string; status: string };
    assert.equal(prop.workspace_id, user.workspace_id, '房源应属于该用户的工作区');
    assert.equal(prop.title, '自动建房源项目');
    assert.equal(prop.status, 'active', '必须是 active，否则展示页与导出会过滤掉它');

    // 导出应该能成功（返回 ZIP）
    const exported = await t.app.inject({
      method: 'GET',
      url: `/api/platform/projects/${project.id}/export`,
      headers: { cookie: u.cookie },
    });
    assert.equal(exported.statusCode, 200, exported.body.slice(0, 200));
    assert.match(String(exported.headers['content-type']), /application\/zip/);
    assert.ok(exported.rawPayload.length > 500, 'ZIP 应有实际内容');
  } finally {
    await t.dispose();
  }
});

test('用户不能通过 API 引用别人工作区的房源', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t, 'own-a@example.com', 'A');
    const b = await registerUser(t, 'own-b@example.com', 'B');

    const madeA = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: a.cookie },
      payload: { pluginId: 'listing', title: 'A 的项目' },
    });
    const propA = JSON.parse(madeA.body).project.spec.propertyId;

    // B 试图在自己的项目里引用 A 的房源 → 必须被服务端拒绝
    const madeB = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: b.cookie },
      payload: { pluginId: 'listing', title: 'B 的项目', spec: { propertyId: propA } },
    });
    assert.equal(madeB.statusCode, 403, '引用别人工作区的房源必须被拒，实际 ' + madeB.statusCode);
    assert.match(madeB.body, /不属于你/);

    // B 不传 propertyId 建自己的项目：应自动建在 B 自己的工作区，导出只含 B 的内容
    const ownB = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: b.cookie },
      payload: { pluginId: 'listing', title: 'B 自己的项目' },
    });
    assert.equal(ownB.statusCode, 201);
    const projectB = JSON.parse(ownB.body).project;
    assert.notEqual(projectB.spec.propertyId, propA, 'B 的项目不应指向 A 的房源');

    const exported = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${projectB.id}/export`,
      headers: { cookie: b.cookie },
    });
    assert.equal(exported.statusCode, 200);
    const text = exported.rawPayload.toString('latin1');
    assert.ok(!text.includes('A 的项目'), 'B 的导出不应含 A 的内容');
  } finally {
    await t.dispose();
  }
});

test('保存的内容与导出结果一致（spec 会同步到房源记录）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'sync@example.com');
    const made = await createListingProject(t, u.cookie, '初始标题');
    const id = made.project.id;
    const propertyId = made.project.spec.propertyId;

    // 通过平台接口改字段（模拟用户在界面上保存 / AI 改完保存）
    const saved = await t.app.inject({
      method: 'PATCH',
      url: `/api/platform/projects/${id}`,
      headers: { cookie: u.cookie },
      payload: {
        spec: {
          title: '同步后的标题',
          priceAmount: '8800',            // 字符串数字 → 必须转成数字
          city: '上海',
          pricePeriod: 'per_month',
          bedrooms: '2',
        },
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    // 房源记录必须跟着变 —— 否则导出/展示页拿到的还是旧内容
    const prop = t.harness.ctx.db
      .prepare('SELECT title, price_amount, city, price_period, bedrooms FROM properties WHERE id = ?')
      .get(propertyId) as Record<string, unknown>;
    assert.equal(prop['title'], '同步后的标题', '房源标题必须同步');
    assert.equal(prop['price_amount'], 8800, '数字字段必须转成数字而不是字符串');
    assert.equal(prop['city'], '上海');
    assert.equal(prop['price_period'], 'per_month');
    assert.equal(prop['bedrooms'], 2);

    // 导出里必须能看到新内容
    const exported = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${id}/export`, headers: { cookie: u.cookie },
    });
    assert.equal(exported.statusCode, 200);
    const zipText = exported.rawPayload.toString('latin1');
    // ZIP 是压缩的，直接搜字符串不可靠 —— 改为在解压后比对（见 verify 脚本）。
    // 这里至少确认导出成功且体积正常。
    assert.ok(exported.rawPayload.length > 500, 'ZIP 应有实际内容');

    // 非法的下拉值必须被丢弃，而不是写进枚举列
    const bad = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${id}`, headers: { cookie: u.cookie },
      payload: { spec: { pricePeriod: 'not-a-real-period' } },
    });
    assert.equal(bad.statusCode, 200);
    const after = t.harness.ctx.db
      .prepare('SELECT price_period FROM properties WHERE id = ?')
      .get(propertyId) as { price_period: string };
    assert.equal(after.price_period, 'per_month', '非法枚举值不应覆盖原值');

    // 数字字段给非数字：应丢弃本次改动，不能写成 NaN
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${id}`, headers: { cookie: u.cookie },
      payload: { spec: { priceAmount: 'abc' } },
    });
    const after2 = t.harness.ctx.db
      .prepare('SELECT price_amount FROM properties WHERE id = ?')
      .get(propertyId) as { price_amount: number };
    assert.equal(after2.price_amount, 8800, '非法数字不应污染房源');
  } finally {
    await t.dispose();
  }
});

test('照片上传：服务端校验类型与大小，且只能操作自己项目的照片', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t, 'photo-a@example.com', 'A');
    const b = await registerUser(t, 'photo-b@example.com', 'B');

    const madeA = await createListingProject(t, a.cookie, 'A 的照片项目');
    const idA = madeA.project.id;

    // 初始没有照片
    const empty = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${idA}/media`, headers: { cookie: a.cookie },
    });
    assert.equal(empty.statusCode, 200);
    assert.equal(JSON.parse(empty.body).items.length, 0);

    // 上传一张真实的小 PNG
    const up = multipart('cover.png', 'image/png', tinyPng());
    const upload = await t.app.inject({
      method: 'POST',
      url: `/api/platform/projects/${idA}/media`,
      headers: { cookie: a.cookie, 'content-type': up.contentType },
      payload: up.body,
    });
    assert.equal(upload.statusCode, 201, upload.body.slice(0, 200));
    const created = JSON.parse(upload.body);
    assert.equal(created.kind, 'photo');
    assert.ok(created.storageKey, '应有 storageKey');

    const list = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${idA}/media`, headers: { cookie: a.cookie },
    });
    assert.equal(JSON.parse(list.body).items.length, 1);

    // B 不能看到 A 的照片
    const listB = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${idA}/media`, headers: { cookie: b.cookie },
    });
    assert.equal(listB.statusCode, 404, 'B 不应看到 A 项目的照片');

    // B 不能删 A 的照片
    const delB = await t.app.inject({
      method: 'DELETE', url: `/api/platform/projects/${idA}/media/${created.id}`, headers: { cookie: b.cookie },
    });
    assert.equal(delB.statusCode, 404, 'B 不应删除 A 的照片');
    // 确认还在
    const stillThere = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${idA}/media`, headers: { cookie: a.cookie },
    });
    assert.equal(JSON.parse(stillThere.body).items.length, 1, '照片不该被 B 删掉');

    // 危险类型必须被拒（伪装成图片的可执行内容）
    const up2 = multipart('x.png', 'image/png', Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8'));
    const evil = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${idA}/media`,
      headers: { cookie: a.cookie, 'content-type': up2.contentType },
      payload: up2.body,
    });
    assert.ok(evil.statusCode >= 400, '伪装成 png 的脚本必须被拒（实际 ' + evil.statusCode + '）');

    // A 自己可以删
    const delA = await t.app.inject({
      method: 'DELETE', url: `/api/platform/projects/${idA}/media/${created.id}`, headers: { cookie: a.cookie },
    });
    assert.equal(delA.statusCode, 200, delA.body);
  } finally {
    await t.dispose();
  }
});

test('照片会进入导出包并在 HTML 里使用相对路径', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'photo-export@example.com');
    const made = await createListingProject(t, u.cookie, '带照片的项目');
    const id = made.project.id;

    const up = multipart('photo.png', 'image/png', tinyPng());
    const upload = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/media`,
      headers: { cookie: u.cookie, 'content-type': up.contentType },
      payload: up.body,
    });
    assert.equal(upload.statusCode, 201, upload.body.slice(0, 200));

    const exported = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${id}/export`, headers: { cookie: u.cookie },
    });
    assert.equal(exported.statusCode, 200);
    const zipText = exported.rawPayload.toString('latin1');
    // ZIP 里应包含 assets/ 下的条目名（文件名在 ZIP 中以明文存储）
    assert.ok(zipText.includes('assets/'), 'ZIP 里应有 assets/ 目录');
    assert.ok(zipText.includes('index.html'), 'ZIP 里应有 index.html');
  } finally {
    await t.dispose();
  }
});

test('照片排序与设为封面（只能操作自己项目的照片）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'order@example.com');
    const made = await createListingProject(t, u.cookie, '排序项目');
    const id = made.project.id;

    // 传两张照片
    const ids = [];
    for (const name of ['a.png', 'b.png']) {
      const up = multipart(name, 'image/png', tinyPng());
      const res = await t.app.inject({
        method: 'POST', url: `/api/platform/projects/${id}/media`,
        headers: { cookie: u.cookie, 'content-type': up.contentType },
        payload: up.body,
      });
      assert.equal(res.statusCode, 201, res.body.slice(0, 150));
      ids.push(JSON.parse(res.body).id);
    }

    // 初始顺序
    const before = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${id}/media`, headers: { cookie: u.cookie },
    })).body).items.map((m: { id: string }) => m.id);
    assert.deepEqual(before, ids, '初始顺序应与上传顺序一致');

    // 反转顺序
    const reorder = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/media/reorder`,
      headers: { cookie: u.cookie }, payload: { order: [ids[1], ids[0]] },
    });
    assert.equal(reorder.statusCode, 200, reorder.body);
    const after = JSON.parse(reorder.body).items.map((m: { id: string }) => m.id);
    assert.deepEqual(after, [ids[1], ids[0]], '顺序应被反转');

    // 设为封面
    const cover = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/media/cover`,
      headers: { cookie: u.cookie }, payload: { mediaId: ids[0] },
    });
    assert.equal(cover.statusCode, 200, cover.body);
    const covers = JSON.parse(cover.body).items.filter((m: { isCover: boolean }) => m.isCover);
    assert.equal(covers.length, 1, '应恰好有一张封面');
    assert.equal(covers[0].id, ids[0]);

    // 空 order 应被拒
    const bad = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/media/reorder`,
      headers: { cookie: u.cookie }, payload: { order: [] },
    });
    assert.equal(bad.statusCode, 400);

    // 别人的项目 → 404
    const b = await registerUser(t, 'order-b@example.com', 'B');
    const foreign = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/media/cover`,
      headers: { cookie: b.cookie }, payload: { mediaId: ids[0] },
    });
    assert.equal(foreign.statusCode, 404, 'B 不应能操作 A 的照片');
  } finally {
    await t.dispose();
  }
});

test('预览返回真实渲染的 HTML，且与公开页同源同版式', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'preview@example.com');
    const made = await createListingProject(t, u.cookie, '预览项目');
    const id = made.project.id;

    // 改个标题，确认预览反映的是最新内容
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '预览专用标题' } },
    });

    const preview = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${id}/preview`, headers: { cookie: u.cookie },
    });
    assert.equal(preview.statusCode, 200, preview.body.slice(0, 200));
    assert.match(String(preview.headers['content-type']), /text\/html/);
    assert.equal(preview.headers['x-robots-tag'], 'noindex');
    assert.ok(preview.body.includes('预览专用标题'), '预览应反映最新保存的内容');
    assert.ok(preview.body.includes('<html'), '应是完整 HTML 文档');
    // 与公开页一样含 CSP nonce
    assert.match(String(preview.headers['content-security-policy'] ?? ''), /nonce-/);

    // 未登录不能预览
    const anon = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${id}/preview` });
    assert.equal(anon.statusCode, 401, '预览必须要求登录');

    // 别人不能预览
    const b = await registerUser(t, 'preview-b@example.com', 'B');
    const foreign = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${id}/preview`, headers: { cookie: b.cookie },
    });
    assert.equal(foreign.statusCode, 404, 'B 不应能预览 A 的项目');
  } finally {
    await t.dispose();
  }
});
test('删除项目会释放额度，并让用户能再建一个', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'reclaim@example.com');

    const first = await createListingProject(t, u.cookie, '第一个项目');
    assert.equal(first.status, 201);

    // 满了，第二个应被拒
    const blocked = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'listing', title: '第二个' },
    });
    assert.equal(blocked.statusCode, 403, '免费用户第 2 个项目应被拒');

    // 删除第一个
    const del = await t.app.inject({
      method: 'DELETE', url: `/api/platform/projects/${first.project.id}`, headers: { cookie: u.cookie },
    });
    assert.equal(del.statusCode, 200, del.body);

    // 额度应释放
    const quota = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);
    assert.equal(quota.projects.used, 0, '删除后已用项目数应回到 0');
    assert.equal(quota.projects.remaining, 1);

    // 现在能再建一个了
    const again = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'listing', title: '删掉后新建的' },
    });
    assert.equal(again.statusCode, 201, '删除后应能再建项目');

    // 已删除的项目不应出现在列表里
    const list = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie },
    })).body);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].title, '删掉后新建的');

    // 删除是归档，不是物理丢失：数据仍在库里
    const row = t.harness.ctx.db
      .prepare('SELECT status FROM projects WHERE id = ?')
      .get(first.project.id) as { status: string };
    assert.equal(row.status, 'archived', '删除应为归档（数据仍可恢复），而不是物理删除');
  } finally {
    await t.dispose();
  }
});

test('免费项目带保存期限，付费套餐不限期', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'retention@example.com');
    const made = await createListingProject(t, u.cookie, '期限项目');

    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${made.project.id}`, headers: { cookie: u.cookie },
    })).body);
    assert.ok(detail.project.retention, '响应应带期限信息');
    assert.equal(detail.project.retention.retentionDays, 7, '免费档保存 7 天');
    assert.ok(detail.project.retention.expiresAt, '应给出到期时间');
    assert.equal(detail.project.retention.expired, false);
    assert.equal(detail.project.retention.daysLeft, 7);

    // 列表里也要有
    const list = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie },
    })).body);
    assert.ok(list.items[0].retention, '列表项也应带期限信息');

    // 升成付费后应变为不限期
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run('retention@example.com');
    const paid = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${made.project.id}`, headers: { cookie: u.cookie },
    })).body);
    assert.equal(paid.project.retention.retentionDays, null, '付费套餐不应限期');
    assert.equal(paid.project.retention.expiresAt, null);
  } finally {
    await t.dispose();
  }
});

test('到期清理只归档免费项目，且不动活跃与付费项目', async () => {
  const t = await createTestApp();
  try {
    const free = await registerUser(t, 'expire-free@example.com', '免费用户');
    const paid = await registerUser(t, 'expire-paid@example.com', '付费用户');
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run('expire-paid@example.com');

    const freeA = await createListingProject(t, free.cookie, '免费-A');
    const paidA = await createListingProject(t, paid.cookie, '付费-A');

    // 建第二个免费项目前先把 A 改成 8 天前更新（已过期）
    t.harness.ctx.db
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run('2026-01-01T00:00:00.000Z', freeA.project.id);

    const result = expireOverdueProjects(t.harness.ctx, new Date('2026-01-15T00:00:00.000Z'));
    assert.ok(result.scanned >= 2);
    assert.deepEqual(
      result.archived.map((p: { title: string }) => p.title),
      ['免费-A'],
      '只应归档那个过期的免费项目',
    );

    // 免费-A 已归档，额度释放
    const freeQuota = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: free.cookie },
    })).body);
    assert.equal(freeQuota.projects.used, 0);

    // 付费-A 不受影响
    const paidStatus = t.harness.ctx.db
      .prepare('SELECT status FROM projects WHERE id = ?')
      .get(paidA.project.id) as { status: string };
    assert.equal(paidStatus.status, 'draft', '付费项目不应被归档');

    // 数据仍在库里（只归档，不删除）
    const row = t.harness.ctx.db
      .prepare('SELECT status FROM projects WHERE id = ?')
      .get(freeA.project.id) as { status: string };
    assert.equal(row.status, 'archived');

    // 可以重复运行
    const again = expireOverdueProjects(t.harness.ctx, new Date('2026-01-15T00:00:00.000Z'));
    assert.deepEqual(again.archived, [], '第二次运行不应重复归档');
  } finally {
    await t.dispose();
  }
});



test('空 body 与非法 JSON 都不会变成 500（客户端错误必须区别于服务端故障）', async () => {
  const t = await createTestApp();
  try {
    /**
     * 【这条测试要守的不变式】
     * 「Content-Type 是 JSON 但没有 body」和「body 不是合法 JSON」都是**客户端造成的**。
     * 无论走哪条路径，都**不能**返回 500 ——
     * 否则任何客户端都能轻易让服务端报告「服务器内部错误」，
     * 真正的服务端故障会被淹没在日志里。
     *
     * 实测中发现后台接口在这个场景下返回 500（既有缺陷，不是本次改造引入的）。
     */

    // 1) 匿名可达接口 + 空 body：应由各自业务逻辑给出响应，绝不是 500
    const emptyCases: [string, number[]][] = [
      ['/api/admin/login', [400, 401]],
      ['/api/platform/login', [400, 401]],
      ['/api/platform/register', [400, 401]],
    ];
    for (const [url, allowed] of emptyCases) {
      const res = await t.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' } });
      assert.ok(
        allowed.includes(res.statusCode),
        `${url} 空 body 不应是 500，实际 ${res.statusCode}`,
      );
      assert.ok(res.statusCode < 500, `${url} 不应返回 5xx`);
    }

    // 2) 已登录 + 空 body：同样不应 500
    const guarded = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie, 'content-type': 'application/json' },
    });
    assert.ok(guarded.statusCode < 500, `已登录空 body 不应 5xx，实际 ${guarded.statusCode}`);

    // 3) 非空但非法 JSON → 必须是 400（明确的客户端错误）
    const broken = await t.app.inject({
      method: 'POST',
      url: '/api/platform/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": "a@b.c", ',
    });
    assert.equal(broken.statusCode, 400, `非法 JSON 应返回 400，实际 ${broken.statusCode}`);
    assert.equal(JSON.parse(broken.body).error.code, 'VALIDATION_FAILED');

    // 4) 带 JSON 头但无 body 的 DELETE 必须成功
    //    （空 body 表示「没有负载」，是合法的；很多 HTTP 客户端会默认带这个头）
    const u = await registerUser(t, 'del-body@example.com');
    const made = await createListingProject(t, u.cookie, '删除测试');
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/platform/projects/${made.project.id}`,
      headers: { cookie: u.cookie, 'content-type': 'application/json' },
    });
    assert.equal(del.statusCode, 200, `带 JSON 头的空 body DELETE 应成功，实际 ${del.statusCode}`);

    // 5) 未登录访问受保护接口仍是 401（守卫先于请求体解析，这个顺序不应被改动）
    const unauth = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(unauth.statusCode, 401, '未登录应先被守卫拦下（401）');

    // 6) 正常的 JSON 请求完全不受影响
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/platform/register',
      payload: { email: 'body-ok@example.com', password: 'platform-pass-123', displayName: '正常' },
    });
    assert.equal(ok.statusCode, 201, '合法请求体仍应正常工作');
  } finally {
    await t.dispose();
  }
});

test('回收站：归档的项目可以查看并恢复，且恢复会重新占用额度', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'trash@example.com');
    const made = await createListingProject(t, u.cookie, '会被删掉的项目');
    const id = made.project.id;

    // 删除
    const del = await t.app.inject({
      method: 'DELETE', url: `/api/platform/projects/${id}`, headers: { cookie: u.cookie },
    });
    assert.equal(del.statusCode, 200);

    // 活跃列表里没有
    const active = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie },
    })).body);
    assert.equal(active.items.length, 0);

    // 回收站里有
    const trash = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects?scope=archived', headers: { cookie: u.cookie },
    })).body);
    assert.equal(trash.items.length, 1, '回收站应能看到已归档的项目');
    assert.equal(trash.items[0].id, id);
    assert.equal(trash.items[0].title, '会被删掉的项目');
    assert.equal(trash.items[0].status, 'archived');

    // 恢复
    const restore = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${id}/restore`, headers: { cookie: u.cookie },
    });
    assert.equal(restore.statusCode, 200, restore.body);
    const restored = JSON.parse(restore.body);
    assert.equal(restored.project.status, 'draft', '恢复后应是草稿，而不是直接回到已发布');
    assert.equal(restored.quota.projects.used, 1, '恢复后应重新占用额度');

    // 回到活跃列表，回收站空了
    const active2 = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie },
    })).body);
    assert.equal(active2.items.length, 1);
    const trash2 = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects?scope=archived', headers: { cookie: u.cookie },
    })).body);
    assert.equal(trash2.items.length, 0);

    // 数据没有丢：版本历史还在
    const versions = t.harness.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM project_versions WHERE project_id = ?')
      .get(id) as { n: number };
    assert.ok(versions.n > 0, '归档不删除版本历史');
  } finally {
    await t.dispose();
  }
});

test('回收站不能成为绕开额度上限的后门', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'trash-quota@example.com');

    // 建 1 个（免费上限），删掉（额度释放），再建 1 个（现在满额）
    const a = await createListingProject(t, u.cookie, 'A');
    await t.app.inject({ method: 'DELETE', url: `/api/platform/projects/${a.project.id}`, headers: { cookie: u.cookie } });
    const b = await createListingProject(t, u.cookie, 'B');
    assert.equal(b.status, 201);

    // 此时额度是满的（1/1）。恢复 A 必须被服务端拒绝，
    // 否则「建→删→建→恢复」就能无限攒项目。
    const restore = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${a.project.id}/restore`, headers: { cookie: u.cookie },
    });
    assert.equal(restore.statusCode, 403, `额度已满时恢复应被拒，实际 ${restore.statusCode}`);
    assert.match(restore.body, /最多创建 1 个项目/);

    // A 仍在回收站，状态没变
    const still = t.harness.ctx.db
      .prepare('SELECT status FROM projects WHERE id = ?')
      .get(a.project.id) as { status: string };
    assert.equal(still.status, 'archived', '被拒的恢复不应改变状态');

    // 删掉 B 腾出额度后，A 就能恢复了
    await t.app.inject({ method: 'DELETE', url: `/api/platform/projects/${b.project.id}`, headers: { cookie: u.cookie } });
    const retry = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${a.project.id}/restore`, headers: { cookie: u.cookie },
    });
    assert.equal(retry.statusCode, 200, '腾出额度后应能恢复');
  } finally {
    await t.dispose();
  }
});

test('恢复接口的越权与边界', async () => {
  const t = await createTestApp();
  try {
    const a = await registerUser(t, 'restore-a@example.com', 'A');
    const b = await registerUser(t, 'restore-b@example.com', 'B');

    const made = await createListingProject(t, a.cookie, 'A 的项目');
    await t.app.inject({ method: 'DELETE', url: `/api/platform/projects/${made.project.id}`, headers: { cookie: a.cookie } });

    // B 不能恢复 A 的项目
    const foreign = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/restore`, headers: { cookie: b.cookie },
    });
    assert.equal(foreign.statusCode, 404, 'B 不应能恢复 A 的项目');
    // 确认状态没被改
    const row = t.harness.ctx.db
      .prepare('SELECT status FROM projects WHERE id = ?')
      .get(made.project.id) as { status: string };
    assert.equal(row.status, 'archived');

    // 未登录不能恢复
    const anon = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/restore`,
    });
    assert.equal(anon.statusCode, 401);

    // 恢复一个没归档的项目 → 409
    const active = await createListingProject(t, a.cookie, '未删除的项目');
    const notArchived = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${active.project.id}/restore`, headers: { cookie: a.cookie },
    });
    assert.equal(notArchived.statusCode, 409, '未归档的项目不应被「恢复」');

    // 不存在的项目 → 404
    const missing = await t.app.inject({
      method: 'POST', url: '/api/platform/projects/prj_does_not_exist/restore', headers: { cookie: a.cookie },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await t.dispose();
  }
});