/**
 * 服务层失败码 → HTTP 状态与错误码的统一映射。
 *
 * 【修复前的缺陷】
 * 5 个路由各自写了一套三元表达式，规则还不一样：只有「发布」那条被补过 422，
 * 其余四条把**任何**失败都报成 403 FORBIDDEN。后果：
 *   - AI 没产出内容 → 403 FORBIDDEN（语义是「你没权限」，实际是「换个描述再来」）
 *   - 上游 AI 服务不可用 → 403 FORBIDDEN（实际是网关故障，重试可能就好）
 *   - 项目不存在 → 状态 404 但 **响应体里 code=FORBIDDEN**
 * 监控会把它们统计成越权尝试，客户端按 code 分支会显示「升级套餐」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createListingProject, registerUser } from '../helpers/test-app.ts';

async function paid(
  t: Awaited<ReturnType<typeof createTestApp>>,
  email: string,
): Promise<{ cookie: string }> {
  const u = await registerUser(t, email);
  t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run(email);
  return u;
}

const j = (r: { body: string }) => JSON.parse(r.body || '{}') as Record<string, any>;

test('AI 没产出内容 → 422 UNPROCESSABLE，不是 403 FORBIDDEN', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'err-a@example.com');
    // 注意必须用 custom-page：房源插件只需要 title 就能成功，
    // 「产不出内容」（no_page_output）只在需要 html 的自定义页面上触发。
    const made = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'custom-page', title: '错误语义' },
    });
    const pid = j(made).project.id as string;

    // 默认 mock provider 产不出自定义页面所需的 html → no_page_output
    const res = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${pid}/generate`,
      headers: { cookie: u.cookie }, payload: { prompt: 'title: 只有标题' },
    });

    assert.equal(res.statusCode, 422, `内容产出失败应为 422，实际 ${res.statusCode}`);
    const body = j(res);
    assert.equal(body.error?.code, 'UNPROCESSABLE', `错误码应为 UNPROCESSABLE，实际 ${body.error?.code}`);
    assert.notEqual(body.error?.code, 'FORBIDDEN', '不得报成权限错误（监控会误计为越权）');
    // 提示仍是可操作的
    assert.match(body.error?.message ?? '', /再点一次|更具体|内容/, '应给出可操作的建议');
  } finally {
    await t.dispose();
  }
});

test('项目不存在 → 404 且响应体 code 也是 NOT_FOUND（不是 FORBIDDEN）', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'err-b@example.com');
    const res = await t.app.inject({
      method: 'POST', url: '/api/platform/projects/prj_00000000-0000-0000-0000-000000000000/generate',
      headers: { cookie: u.cookie }, payload: { prompt: 'x' },
    });
    assert.equal(res.statusCode, 404);
    const body = j(res);
    assert.equal(body.error?.code, 'NOT_FOUND', `404 的错误码应同为 NOT_FOUND，实际 ${body.error?.code}`);
    assert.equal(body.error?.message, '项目不存在');
  } finally {
    await t.dispose();
  }
});

test('未知插件 → 400 VALIDATION_FAILED（调用方传错了参数）', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'err-c@example.com');
    const res = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'no-such-plugin', title: '未知插件' },
    });
    assert.equal(res.statusCode, 400, `未知插件应为 400，实际 ${res.statusCode}`);
    assert.equal(j(res).error?.code, 'VALIDATION_FAILED');
  } finally {
    await t.dispose();
  }
});

test('空内容发布 → 422 UNPROCESSABLE', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'err-d@example.com');
    const made = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'custom-page', title: '空项目' },
    });
    const pid = j(made).project.id as string;
    const res = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(j(res).error?.code, 'UNPROCESSABLE');
  } finally {
    await t.dispose();
  }
});

test('状态冲突 → 409 CONFLICT（恢复未归档的项目、停止未托管的项目）', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'err-e@example.com');
    const made = await createListingProject(t, u.cookie, '状态冲突');
    const pid = made.project.id;

    // 项目不在回收站里 → 恢复应 409
    const restore = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${pid}/restore`, headers: { cookie: u.cookie },
    });
    assert.equal(restore.statusCode, 409, `未归档时恢复应为 409，实际 ${restore.statusCode}`);
    assert.equal(j(restore).error?.code, 'CONFLICT');

    // 项目没有在托管 → 停止托管应 409
    const unpub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${pid}/unpublish`, headers: { cookie: u.cookie },
    });
    assert.equal(unpub.statusCode, 409, `未托管时停止应为 409，实际 ${unpub.statusCode}`);
    assert.equal(j(unpub).error?.code, 'CONFLICT');
  } finally {
    await t.dispose();
  }
});

test('额度/套餐类失败仍然是 403 FORBIDDEN（确实是不被允许）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'err-f@example.com');
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'free' WHERE email = ?").run('err-f@example.com');

    // 免费用户发布到托管 → 403（配额/套餐路径不能被这轮改动影响）
    const made = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'custom-page', title: '免费项目' },
    });
    const pid = j(made).project.id as string;
    const res = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(res.statusCode, 403, `套餐限制应仍是 403，实际 ${res.statusCode}`);
    assert.equal(j(res).error?.code, 'FORBIDDEN');
  } finally {
    await t.dispose();
  }
});

test('错误语义覆盖表：每种失败都落到正确的状态与错误码', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'err-g@example.com');
    const cases: { name: string; status: number; code: string; run: () => Promise<{ statusCode: number; body: string }> }[] = [];

    const made = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'custom-page', title: '覆盖表' },
    });
    const pid = j(made).project.id as string;
    const missing = 'prj_00000000-0000-0000-0000-000000000000';

    cases.push(
      { name: 'AI 产出为空 → 422', status: 422, code: 'UNPROCESSABLE',
        run: () => t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/generate`, headers: { cookie: u.cookie }, payload: { prompt: 'title: x' } }) },
      { name: '项目不存在 → 404', status: 404, code: 'NOT_FOUND',
        run: () => t.app.inject({ method: 'POST', url: `/api/platform/projects/${missing}/generate`, headers: { cookie: u.cookie }, payload: { prompt: 'x' } }) },
      { name: '未归档时恢复 → 409', status: 409, code: 'CONFLICT',
        run: () => t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/restore`, headers: { cookie: u.cookie } }) },
      { name: '未托管时停止 → 409', status: 409, code: 'CONFLICT',
        run: () => t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/unpublish`, headers: { cookie: u.cookie } }) },
      { name: '未知插件 → 400', status: 400, code: 'VALIDATION_FAILED',
        run: () => t.app.inject({ method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie }, payload: { pluginId: 'nope', title: 'x' } }) },
    );

    for (const c of cases) {
      const res = await c.run();
      assert.equal(res.statusCode, c.status, `${c.name}：状态应为 ${c.status}，实际 ${res.statusCode}`);
      assert.equal(j(res).error?.code, c.code, `${c.name}：错误码应为 ${c.code}，实际 ${j(res).error?.code}`);
    }

    // 所有失败响应都不得把 FORBIDDEN 用在非权限场景上
    const forbiddenOnContent = cases.filter((c) => c.code !== 'FORBIDDEN');
    for (const c of forbiddenOnContent) {
      const res = await c.run();
      assert.notEqual(j(res).error?.code, 'FORBIDDEN', `${c.name} 不应报成 FORBIDDEN`);
    }
  } finally {
    await t.dispose();
  }
});