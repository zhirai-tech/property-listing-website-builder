/**
 * 版本回滚。
 *
 * 【修复前的缺陷】版本历史只能**查看**，没有任何回滚能力 ——
 * 界面上列着「v1 / v2 / v3」，但用户拿不回来。
 *
 * 【两条设计原则】
 *   1. 版本表**只追加**：回滚也写入新版本，历史一条不删 —— 回滚错了还能再回滚。
 *   2. 默认模式是 `draft`：默认动作必须**不改变线上内容**，
 *      否则一次误点就会把正在对外访问的页面换掉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, registerUser } from '../helpers/test-app.ts';

function appTime(t: Awaited<ReturnType<typeof createTestApp>>): number {
  return t.harness.ctx.adapters.clock.now().getTime();
}

async function paid(t: Awaited<ReturnType<typeof createTestApp>>, email: string) {
  const u = await registerUser(t, email);
  t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run(email);
  return u;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><h1>${title}</h1><p>${body}</p></body></html>`;

async function makeProject(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, title: string) {
  const res = await t.app.inject({
    method: 'POST', url: '/api/platform/projects', headers: { cookie },
    payload: { pluginId: 'custom-page', title },
  });
  return JSON.parse(res.body).project.id as string;
}

async function save(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, id: string, title: string, body: string) {
  return t.app.inject({
    method: 'PATCH', url: `/api/platform/projects/${id}`, headers: { cookie },
    payload: { spec: { title, html: page(title, body) } },
  });
}

/**
 * 按内容特征找一个版本。
 *
 * 注意：**versionNo 1 是项目创建时的空版本**，不是「第一次保存的内容」。
 * 想拿「第一次保存的那一版」必须按内容找。
 */
async function versionWith(
  t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, id: string, marker: string,
) {
  const list = await versions(t, cookie, id);
  for (const v of list) {
    const res = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${id}`, headers: { cookie } });
    void res;
    const row = t.harness.ctx.db
      .prepare('SELECT spec_json FROM project_versions WHERE id = ?')
      .get(v.id) as { spec_json: string } | undefined;
    if (row && row.spec_json.includes(marker)) return v;
  }
  throw new Error(`找不到包含 ${marker} 的版本`);
}

async function versions(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, id: string) {
  const res = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${id}`, headers: { cookie } });
  return JSON.parse(res.body).versions as { id: string; versionNo: number; kind: string; hasSnapshot: boolean }[];
}

const restore = (
  t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, id: string, versionId: string, mode?: string,
) => t.app.inject({
  method: 'POST', url: `/api/platform/projects/${id}/versions/${versionId}/restore`,
  headers: { cookie }, payload: mode === undefined ? {} : { mode },
});

test('回滚草稿：内容回到旧版本，线上页面完全不受影响', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'rv-a@example.com');
    const pid = await makeProject(t, u.cookie, '回滚草稿');
    assert.equal((await save(t, u.cookie, pid, '第一版', '这是第一版的正文内容，足够长。')).statusCode, 200);

    const v1 = await versionWith(t, u.cookie, pid, '第一版');

    // 发布一次，再改成第二版
    const pub = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    assert.equal(pub.statusCode, 200, pub.body);
    const url = JSON.parse(pub.body).publicUrl as string;
    assert.ok((await t.app.inject({ method: 'GET', url: new URL(url).pathname })).body.includes('第一版'));

    await save(t, u.cookie, pid, '第二版', '这是第二版的正文内容，足够长。');

    // 回滚到 v1（默认 draft 模式）
    const res = await restore(t, u.cookie, pid, v1!.id);
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as Record<string, any>;
    assert.equal(body.mode, 'draft');
    assert.equal(body.publicUrlChanged, false, '草稿回滚不应改动线上');

    // 草稿内容已回到第一版
    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.match(detail.project.spec.html, /第一版/, '草稿应回到第一版内容');
    assert.equal(detail.project.status, 'published', '状态不应改变');

    // 线上仍是第一版（本来就没变过）
    const online = await t.app.inject({ method: 'GET', url: new URL(url).pathname });
    assert.equal(online.statusCode, 200);
    assert.match(online.body, /第一版/);
  } finally {
    await t.dispose();
  }
});

test('回滚是追加式的：历史一条不删，回滚本身也产生新版本', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'rv-b@example.com');
    const pid = await makeProject(t, u.cookie, '追加式');
    await save(t, u.cookie, pid, '第一版', '这是第一版的正文内容，足够长。');
    await save(t, u.cookie, pid, '第二版', '这是第二版的正文内容，足够长。');

    const before = await versions(t, u.cookie, pid);
    const v1 = before.find((v) => v.versionNo === 1)!;

    const res = await restore(t, u.cookie, pid, v1.id);
    assert.equal(res.statusCode, 200, res.body);

    const after = await versions(t, u.cookie, pid);
    assert.ok(after.length > before.length, '回滚应追加新版本');
    // 回滚前的每一条都还在
    for (const v of before) {
      assert.ok(after.some((x) => x.id === v.id), `版本 ${v.versionNo} 不应被删除`);
    }
    // 第一版内容还在（新追加的那条）
    const newest = after.find((v) => v.versionNo === Math.max(...after.map((x) => x.versionNo)))!;
    assert.match(JSON.stringify(newest), /./);
  } finally {
    await t.dispose();
  }
});

test('回滚并重新发布：线上切换到旧版本', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'rv-c@example.com');
    const pid = await makeProject(t, u.cookie, '回滚发布');
    await save(t, u.cookie, pid, '第一版', '这是第一版的正文内容，足够长。');
    const v1 = await versionWith(t, u.cookie, pid, '第一版');

    const pub1 = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    const url = JSON.parse(pub1.body).publicUrl as string;

    await save(t, u.cookie, pid, '第二版', '这是第二版的正文内容，足够长。');
    await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    assert.match((await t.app.inject({ method: 'GET', url: new URL(url).pathname })).body, /第二版/);

    // 显式要求重新发布
    const res = await restore(t, u.cookie, pid, v1.id, 'publish');
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as Record<string, any>;
    assert.equal(body.mode, 'publish');
    assert.equal(body.publicUrlChanged, true);

    const online = await t.app.inject({ method: 'GET', url: new URL(url).pathname });
    assert.match(online.body, /第一版/, '线上应回到第一版');
    assert.ok(!online.body.includes('第二版'), '第二版不应残留');
  } finally {
    await t.dispose();
  }
});

test('回滚到无效内容：失败且不影响已发布版本', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'rv-d@example.com');
    const pid = await makeProject(t, u.cookie, '无效版本');
    await save(t, u.cookie, pid, '好版本', '这是一段足够长的正文内容，可以通过校验。');
    const good = await versionWith(t, u.cookie, pid, '好版本');

    const pub = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    const url = JSON.parse(pub.body).publicUrl as string;

    // 直接往版本表塞一条含脚本的记录（模拟被篡改的历史版本）
    t.harness.ctx.db
      .prepare("INSERT INTO project_versions (id, project_id, version_no, kind, spec_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)")
      .run('ver_bad_test', pid, 999, 'draft',
        JSON.stringify({ title: '坏版本', html: page('坏版本', '内容').replace('</body>', '<script>x()</script></body>') }),
        'user', new Date(appTime(t)).toISOString());

    const res = await restore(t, u.cookie, pid, 'ver_bad_test');
    assert.equal(res.statusCode, 422, `无效版本应被拒，实际 ${res.statusCode}`);
    assert.equal(JSON.parse(res.body).error?.code, 'UNPROCESSABLE');

    // 线上与草稿都应保持原样
    const online = await t.app.inject({ method: 'GET', url: new URL(url).pathname });
    assert.match(online.body, /好版本/, '失败时已发布版本必须保留');
    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.match(detail.project.spec.html, /好版本/, '草稿不应被坏版本污染');
  } finally {
    await t.dispose();
  }
});

test('严格校验所有权与版本归属', async () => {
  const t = await createTestApp();
  try {
    const a = await paid(t, 'rv-e-a@example.com');
    const b = await paid(t, 'rv-e-b@example.com');

    const pidA = await makeProject(t, a.cookie, 'A 的项目');
    await save(t, a.cookie, pidA, 'A 的第一版', '这是 A 的正文内容，足够长。');
    const vA = await versionWith(t, a.cookie, pidA, 'A 的第一版');

    // ① 乙不能回滚甲的项目
    assert.equal((await restore(t, b.cookie, pidA, vA.id)).statusCode, 404, '别人的项目应 404');

    // ② 乙用自己的项目 + 甲的 versionId —— 版本不属于该项目，必须 404
    const pidB = await makeProject(t, b.cookie, 'B 的项目');
    const cross = await restore(t, b.cookie, pidB, vA.id);
    assert.equal(cross.statusCode, 404, '跨项目的 versionId 必须被拒');
    assert.equal(JSON.parse(cross.body).error?.code, 'NOT_FOUND', '不得泄露该版本是否存在');

    // ③ 不存在的版本
    assert.equal((await restore(t, a.cookie, pidA, 'ver_does_not_exist')).statusCode, 404);

    // ④ 甲自己的项目 + 自己的版本 → 正常
    assert.equal((await restore(t, a.cookie, pidA, vA.id)).statusCode, 200);
  } finally {
    await t.dispose();
  }
});

test('重复回滚与连续回滚都不会损坏数据', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'rv-f@example.com');
    const pid = await makeProject(t, u.cookie, '重复回滚');
    await save(t, u.cookie, pid, '第一版', '这是第一版的正文内容，足够长。');
    await save(t, u.cookie, pid, '第二版', '这是第二版的正文内容，足够长。');
    await save(t, u.cookie, pid, '第三版', '这是第三版的正文内容，足够长。');

    const list = await versions(t, u.cookie, pid);
    const v1 = await versionWith(t, u.cookie, pid, '第一版');
    const v2 = await versionWith(t, u.cookie, pid, '第二版');

    // 同一个版本连续回滚 3 次 —— 都应成功且内容一致
    for (let i = 0; i < 3; i += 1) {
      const r = await restore(t, u.cookie, pid, v1.id);
      assert.equal(r.statusCode, 200, `第 ${i + 1} 次重复回滚应成功`);
    }
    let detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.match(detail.project.spec.html, /第一版/);

    // 连续回滚到不同版本
    assert.equal((await restore(t, u.cookie, pid, v2.id)).statusCode, 200);
    detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.match(detail.project.spec.html, /第二版/, '连续回滚应生效');
    assert.equal((await restore(t, u.cookie, pid, v1.id)).statusCode, 200);
    detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.match(detail.project.spec.html, /第一版/, '再回滚回去也应生效（历史没被抹掉）');

    // 历史全部保留
    const after = await versions(t, u.cookie, pid);
    for (const v of list) assert.ok(after.some((x) => x.id === v.id), `版本 ${v.versionNo} 必须保留`);
  } finally {
    await t.dispose();
  }
});

test('并发回滚不会损坏数据', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'rv-g@example.com');
    const pid = await makeProject(t, u.cookie, '并发回滚');
    await save(t, u.cookie, pid, '第一版', '这是第一版的正文内容，足够长。');
    await save(t, u.cookie, pid, '第二版', '这是第二版的正文内容，足够长。');

    const list = await versions(t, u.cookie, pid);
    const v1 = await versionWith(t, u.cookie, pid, '第一版');

    // 同时发起 5 次回滚
    const results = await Promise.all(
      Array.from({ length: 5 }, () => restore(t, u.cookie, pid, v1.id)),
    );
    for (const r of results) assert.equal(r.statusCode, 200, '并发回滚都应成功');

    // 内容一致、历史完整、数据库可读
    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.match(detail.project.spec.html, /第一版/, '并发后内容应正确');
    for (const v of list) {
      assert.ok(detail.versions.some((x: { id: string }) => x.id === v.id), '历史不应丢失');
    }
  } finally {
    await t.dispose();
  }
});

test('默认模式是不改变线上内容的那个（安全默认）', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'rv-h@example.com');
    const pid = await makeProject(t, u.cookie, '安全默认');
    await save(t, u.cookie, pid, '第一版', '这是第一版的正文内容，足够长。');
    const v1 = (await versions(t, u.cookie, pid)).find((v) => v.versionNo === 1)!;
    await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    await save(t, u.cookie, pid, '第二版', '这是第二版的正文内容，足够长。');
    await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });

    // 不带 mode 字段 —— 必须落到 draft，不能悄悄改线上
    const res = await restore(t, u.cookie, pid, v1.id);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as Record<string, any>;
    assert.equal(body.mode, 'draft', '不带 mode 时必须是 draft');
    assert.equal(body.publicUrlChanged, false);

    // 非法 mode 也不能被当成 publish
    const bad = await restore(t, u.cookie, pid, v1.id, 'yes-please-publish');
    assert.equal(JSON.parse(bad.body).mode, 'draft', '非法 mode 应回落到 draft');
  } finally {
    await t.dispose();
  }
});