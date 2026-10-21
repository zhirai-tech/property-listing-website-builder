/**
 * 插件生命周期：安装 / 启用 / 停用 / 更新 / 卸载。
 *
 * 【修复前的状态】`plugin_installations` 表**零读写代码** ——
 * 是一张死表；插件既不能启停，也没有任何安装记录。
 *
 * 【作用域】按**工作区**隔离。迁移 v7 把 `UNIQUE(plugin_id)`（平台级）
 * 改成 `(workspace_id, plugin_id)` —— 一个人停用插件不该影响别人。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListingProject, createTestApp, registerUser } from '../helpers/test-app.ts';

function appTime(t: Awaited<ReturnType<typeof createTestApp>>): number {
  return t.harness.ctx.adapters.clock.now().getTime();
}

/** 有管理能力的会员 */
async function admin(t: Awaited<ReturnType<typeof createTestApp>>, email: string) {
  const u = await registerUser(t, email);
  t.harness.ctx.db
    .prepare("UPDATE users SET tier = 'basic', member_until = ? WHERE email = ?")
    .run(new Date(appTime(t) + 30 * 86_400_000).toISOString(), email);
  return u;
}

const post = (t: Awaited<ReturnType<typeof createTestApp>>, url: string, cookie: string) =>
  t.app.inject({ method: 'POST', url, headers: { cookie } });
const get = (t: Awaited<ReturnType<typeof createTestApp>>, url: string, cookie: string) =>
  t.app.inject({ method: 'GET', url, headers: { cookie } });
const del = (t: Awaited<ReturnType<typeof createTestApp>>, url: string, cookie: string) =>
  t.app.inject({ method: 'DELETE', url, headers: { cookie } });

async function makeProject(
  t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, pluginId = 'custom-page', title = '项目',
) {
  return t.app.inject({
    method: 'POST', url: '/api/platform/projects', headers: { cookie },
    payload: { pluginId, title },
  });
}

test('内置插件天然已安装，列表可查', async () => {
  const t = await createTestApp();
  try {
    const u = await admin(t, 'pl-a@example.com');
    const res = await get(t, '/api/platform/plugins/installations', u.cookie);
    assert.equal(res.statusCode, 200, res.body);
    const items = JSON.parse(res.body).items as Record<string, any>[];

    const ids = items.map((i) => i.pluginId).sort();
    assert.deepEqual(ids, ['custom-page', 'listing'], '两个内置插件都应在列');
    for (const i of items) {
      assert.equal(i.enabled, true, '内置插件默认启用');
      assert.equal(i.isBuiltin, true);
      assert.equal(i.executable, true, '内置插件是可执行的');
      assert.ok(Array.isArray(i.dependencies), '应声明依赖清单（当前为空数组）');
      assert.deepEqual(i.missingDependencies, [], '无缺失依赖');
    }
  } finally {
    await t.dispose();
  }
});

test('停用插件后服务端拒绝用它建项目（不是只隐藏按钮）', async () => {
  const t = await createTestApp();
  try {
    const u = await admin(t, 'pl-b@example.com');

    // 停用前可以建
    assert.equal((await makeProject(t, u.cookie, 'custom-page')).statusCode, 201);

    const off = await post(t, '/api/platform/plugins/custom-page/disable', u.cookie);
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(JSON.parse(off.body).installation.enabled, false);

    // 停用后：**直接调 API 也建不了**
    const blocked = await makeProject(t, u.cookie, 'custom-page', '停用后');
    assert.equal(blocked.statusCode, 403, `停用后应被服务端拒绝，实际 ${blocked.statusCode}`);
    assert.equal(JSON.parse(blocked.body).error?.code, 'FORBIDDEN');
    assert.match(JSON.parse(blocked.body).error?.message ?? '', /停用|启用/, '应提示如何恢复');

    // 其它插件不受影响
    assert.equal((await makeProject(t, u.cookie, 'listing', '房源项目')).statusCode, 201);

    // 重新启用后恢复
    assert.equal((await post(t, '/api/platform/plugins/custom-page/enable', u.cookie)).statusCode, 200);
    assert.equal((await makeProject(t, u.cookie, 'custom-page', '恢复后')).statusCode, 201);
  } finally {
    await t.dispose();
  }
});

test('插件启停按工作区隔离：一个人停用不影响别人', async () => {
  const t = await createTestApp();
  try {
    const a = await admin(t, 'pl-c-a@example.com');
    const b = await admin(t, 'pl-c-b@example.com');

    assert.equal((await post(t, '/api/platform/plugins/custom-page/disable', a.cookie)).statusCode, 200);

    // B 完全不受影响 —— 这正是迁移 v7 要解决的问题
    assert.equal((await makeProject(t, b.cookie, 'custom-page')).statusCode, 201, 'B 不应被 A 的停用影响');
    const bList = JSON.parse((await get(t, '/api/platform/plugins/installations', b.cookie)).body).items as Record<string, any>[];
    assert.equal(bList.find((i) => i.pluginId === 'custom-page')?.enabled, true, 'B 的插件仍是启用状态');

    // A 自己确实被拒
    assert.equal((await makeProject(t, a.cookie, 'custom-page')).statusCode, 403);
  } finally {
    await t.dispose();
  }
});

test('更新内置插件：如实说明无法单独更新，不伪造成功', async () => {
  const t = await createTestApp();
  try {
    const u = await admin(t, 'pl-d@example.com');
    const res = await post(t, '/api/platform/plugins/listing/update', u.cookie);
    assert.notEqual(res.statusCode, 200, '不应返回成功');
    const body = JSON.parse(res.body);
    assert.match(body.error?.message ?? '', /随平台代码发布|无法单独更新/, '应说明真实原因');
  } finally {
    await t.dispose();
  }
});

test('安装不存在的插件被拒（上传包不可执行，不假装装上）', async () => {
  const t = await createTestApp();
  try {
    const u = await admin(t, 'pl-e@example.com');
    const res = await post(t, '/api/platform/plugins/some-uploaded-package/install', u.cookie);
    assert.notEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.match(body.error?.message ?? '', /无法安装执行|没有这个插件/, '应说明上传包不能执行');
  } finally {
    await t.dispose();
  }
});

test('卸载插件不删除项目、版本、公开页面与房源数据', async () => {
  const t = await createTestApp();
  try {
    const u = await admin(t, 'pl-f@example.com');

    // 建一个房源项目并发布
    const lp = await createListingProject(t, u.cookie, '卸载保护');
    assert.ok(lp.propertyId, '应先关联房源');
    const pid = lp.project.id;
    const pub = await post(t, `/api/platform/projects/${pid}/publish`, u.cookie);
    assert.equal(pub.statusCode, 200, pub.body);
    const publicUrl = JSON.parse(pub.body).publicUrl as string;

    // 记录卸载前的一切
    const before = JSON.parse((await get(t, `/api/platform/projects/${pid}`, u.cookie)).body);
    const propsBefore = t.harness.ctx.db.prepare('SELECT COUNT(*) c FROM properties').get() as { c: number };

    // 卸载
    const un = await del(t, '/api/platform/plugins/listing/installation', u.cookie);
    assert.equal(un.statusCode, 200, un.body);

    // 项目、版本、内容都在
    const after = JSON.parse((await get(t, `/api/platform/projects/${pid}`, u.cookie)).body);
    assert.equal(after.project.status, before.project.status, '项目状态不变');
    assert.equal(after.project.publicSlug, before.project.publicSlug, '短链不变');
    assert.equal(after.versions.length, before.versions.length, '版本历史不应被删除');
    assert.deepEqual(after.project.spec, before.project.spec, '项目内容不应被改动');

    // 公开页面仍可访问
    const page = await t.app.inject({ method: 'GET', url: new URL(publicUrl).pathname });
    assert.equal(page.statusCode, 200, '卸载不应让已发布页面下线');

    // 房源数据仍在
    const propsAfter = t.harness.ctx.db.prepare('SELECT COUNT(*) c FROM properties').get() as { c: number };
    assert.equal(propsAfter.c, propsBefore.c, '房源数据不应被删除');
    const prop = t.harness.ctx.db.prepare('SELECT id FROM properties WHERE id = ?').get(lp.propertyId);
    assert.ok(prop, '该房源记录必须仍在');

    // 卸载后该插件不可再用于新建
    const blocked = await makeProject(t, u.cookie, 'listing', '卸载后');
    assert.equal(blocked.statusCode, 403, '卸载后不应还能用它建项目');

    // 重新安装可恢复
    assert.equal((await post(t, '/api/platform/plugins/listing/install', u.cookie)).statusCode, 200);
    assert.equal((await makeProject(t, u.cookie, 'listing', '重装后')).statusCode, 201);
  } finally {
    await t.dispose();
  }
});

test('重复操作是幂等的，且都有明确结果', async () => {
  const t = await createTestApp();
  try {
    const u = await admin(t, 'pl-g@example.com');

    // 重复安装
    for (let i = 0; i < 3; i += 1) {
      const r = await post(t, '/api/platform/plugins/listing/install', u.cookie);
      assert.equal(r.statusCode, 200, `第 ${i + 1} 次安装应成功`);
    }
    // 重复停用
    for (let i = 0; i < 3; i += 1) {
      const r = await post(t, '/api/platform/plugins/listing/disable', u.cookie);
      assert.equal(r.statusCode, 200, `第 ${i + 1} 次停用应成功`);
      assert.equal(JSON.parse(r.body).installation.enabled, false);
    }
    // 重复卸载
    assert.equal((await del(t, '/api/platform/plugins/listing/installation', u.cookie)).statusCode, 200);
    const second = await del(t, '/api/platform/plugins/listing/installation', u.cookie);
    assert.equal(second.statusCode, 404, '已卸载后再卸载应明确 404，而不是假装成功');
  } finally {
    await t.dispose();
  }
});

test('生命周期接口受 adminEnabled 保护', async () => {
  const t = await createTestApp();
  try {
    // 未登录
    for (const [method, url] of [
      ['GET', '/api/platform/plugins/installations'],
      ['POST', '/api/platform/plugins/listing/install'],
      ['POST', '/api/platform/plugins/listing/disable'],
      ['DELETE', '/api/platform/plugins/listing/installation'],
    ] as const) {
      const r = await t.app.inject({ method, url });
      assert.equal(r.statusCode, 401, `${method} ${url} 未登录应 401`);
    }

    // 免费用户：登录了但没有管理能力
    const free = await registerUser(t, 'pl-h-free@example.com');
    const res = await get(t, '/api/platform/plugins/installations', free.cookie);
    assert.equal(res.statusCode, 403, '免费用户应 403');

    // 到期会员同样不行
    const expired = await admin(t, 'pl-h-exp@example.com');
    t.harness.ctx.db
      .prepare('UPDATE users SET member_until = ? WHERE email = ?')
      .run(new Date(appTime(t) - 1000).toISOString(), 'pl-h-exp@example.com');
    assert.equal((await get(t, '/api/platform/plugins/installations', expired.cookie)).statusCode, 403);
  } finally {
    await t.dispose();
  }
});

test('篡改请求参数不能绕过插件启停', async () => {
  const t = await createTestApp();
  try {
    const u = await admin(t, 'pl-i@example.com');
    await post(t, '/api/platform/plugins/custom-page/disable', u.cookie);

    // 建项目时在请求体里声称插件已启用 —— 无效
    const res = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'custom-page', title: '伪造', enabled: true, pluginEnabled: true },
    });
    assert.equal(res.statusCode, 403, '请求体伪造插件状态不应生效');

    // 库里的状态没有被改写
    const ws = t.harness.ctx.db.prepare('SELECT workspace_id FROM users WHERE email = ?')
      .get('pl-i@example.com') as { workspace_id: string };
    const row = t.harness.ctx.db
      .prepare("SELECT enabled FROM plugin_installations WHERE plugin_id = 'custom-page' AND workspace_id = ?")
      .get(ws.workspace_id) as { enabled: number } | undefined;
    assert.equal(row?.enabled, 0, '库中状态不应被客户端改写');
  } finally {
    await t.dispose();
  }
});