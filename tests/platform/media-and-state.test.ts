/**
 * 媒体访问边界 / 发布与托管状态 / 导出回链 —— 现状核对与固化。
 *
 * 【为什么这三项合在一起】它们都是「查清边界并把现有产品规则钉死」，
 * 而不是新增功能。逐项验证比贸然改动更安全：
 * `/media/*` 一旦加错鉴权，**已发布页面的图片会全部失效**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListingProject, createTestApp, multipart, registerUser, tinyPng } from '../helpers/test-app.ts';
import { readZip } from '../../src/util/unzip.ts';

function appTime(t: Awaited<ReturnType<typeof createTestApp>>): number {
  return t.harness.ctx.adapters.clock.now().getTime();
}
async function paid(t: Awaited<ReturnType<typeof createTestApp>>, email: string) {
  const u = await registerUser(t, email);
  t.harness.ctx.db
    .prepare("UPDATE users SET tier = 'basic', member_until = ? WHERE email = ?")
    .run(new Date(appTime(t) + 30 * 86_400_000).toISOString(), email);
  return u;
}
const get = (t: Awaited<ReturnType<typeof createTestApp>>, url: string, cookie?: string) =>
  t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

// ===========================================================================
// 一、媒体访问边界
// ===========================================================================

test('媒体：路径穿越、盘符、空段与编码变体一律被拒', async () => {
  const t = await createTestApp();
  try {
    const attempts = [
      '/media/../app.sqlite',
      '/media/..%2fapp.sqlite',
      '/media/%2e%2e/app.sqlite',
      '/media/....//app.sqlite',
      '/media/C:/windows/win.ini',
      '/media/%00',
      '/media//etc/passwd',
      '/media/./x.png',
    ];
    for (const url of attempts) {
      const res = await get(t, url);
      assert.ok(
        res.statusCode === 400 || res.statusCode === 404,
        `${url} 应被拒（400/404），实际 ${res.statusCode}`,
      );
      // 绝不能返回真实文件内容
      assert.ok(!res.body.includes('SQLite format'), `${url} 不得泄露数据库内容`);
      assert.ok(!res.body.includes('[fonts]'), `${url} 不得泄露系统文件`);
    }
  } finally {
    await t.dispose();
  }
});

test('媒体：合法资源在未登录下可读（公开页面依赖它），但不存在的 key 是 404', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'md-a@example.com');
    const made = await createListingProject(t, u.cookie, '媒体边界');
    assert.ok(made.propertyId);
    const upload = multipart('cover.png', 'image/png', tinyPng());
    const up = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/media`,
      headers: { cookie: u.cookie, 'content-type': upload.contentType }, payload: upload.body,
    });
    assert.equal(up.statusCode, 201, up.body);
    const key = JSON.parse(up.body).storageKey as string;
    assert.ok(key, '应返回 storageKey');

    // 匿名可读 —— 这是刻意的：公开页面必须能加载自己的图片
    const anon = await get(t, `/media/${key}`);
    assert.equal(anon.statusCode, 200, '公开页面所需的图片必须匿名可读');
    assert.match(String(anon.headers['content-type']), /image\/png/);

    // 不存在的 key：404，且不泄露服务器路径
    const missing = await get(t, '/media/prp_nope/does-not-exist.png');
    assert.equal(missing.statusCode, 404);
    assert.ok(!/at \w+ \(|[A-Z]:\\|\/var\/|\/home\//.test(missing.body), '错误响应不得泄露服务器路径');
  } finally {
    await t.dispose();
  }
});

test('媒体：storageKey 含随机短码，无法通过房源 ID 枚举', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'md-b@example.com');
    const made = await createListingProject(t, u.cookie, '枚举抵抗');
    const upload = multipart('a.png', 'image/png', tinyPng());
    const up = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/media`,
      headers: { cookie: u.cookie, 'content-type': upload.contentType }, payload: upload.body,
    });
    const key = JSON.parse(up.body).storageKey as string;

    // key 形如 <propertyId>/<随机码>.png
    const parts = key.split('/');
    assert.equal(parts.length, 2, '应为「房源目录/文件名」两段');
    assert.equal(parts[0], made.propertyId, '第一段是房源 ID（可预测）');
    assert.ok((parts[1] ?? '').length >= 8, '第二段必须是足够长的随机码（不可预测）');
    assert.match(parts[1]!, /^[a-z0-9-]+\.png$/i, '文件名应由内部生成，不含用户输入');

    // 用可预测的部分去猜其它文件 —— 猜不到
    for (const guess of ['a.png', 'cover.png', '1.png', 'image.png']) {
      assert.notEqual((await get(t, `/media/${made.propertyId}/${guess}`)).statusCode, 200, `不应猜到 ${guess}`);
    }
  } finally {
    await t.dispose();
  }
});

test('媒体：一个用户拿不到另一个用户工作区的媒体清单', async () => {
  const t = await createTestApp();
  try {
    const a = await paid(t, 'md-c-a@example.com');
    const b = await paid(t, 'md-c-b@example.com');
    const madeA = await createListingProject(t, a.cookie, 'A 的媒体');

    // B 读 A 项目的媒体列表 → 404（所有权在 SQL 层）
    assert.equal((await get(t, `/api/platform/projects/${madeA.project.id}/media`, b.cookie)).statusCode, 404);
    // B 删 A 的媒体 → 404
    const del = await t.app.inject({
      method: 'DELETE', url: `/api/platform/projects/${madeA.project.id}/media/med_x`, headers: { cookie: b.cookie },
    });
    assert.equal(del.statusCode, 404);
  } finally {
    await t.dispose();
  }
});

// ===========================================================================
// 二、发布与托管状态：四种状态必须彼此独立
// ===========================================================================

test('四种状态彼此独立：会员到期 / 取消发布 / 归档 / 数据删除', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'st-a@example.com');
    const made = await createListingProject(t, u.cookie, '状态区分');
    const pid = made.project.id;

    const pub = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    assert.equal(pub.statusCode, 200, pub.body);
    const url = JSON.parse(pub.body).publicUrl as string;
    const path = new URL(url).pathname;
    assert.equal((await get(t, path)).statusCode, 200);

    // ① 会员到期：**不改变发布状态**，公开页面照旧可访问
    t.harness.ctx.db.prepare('UPDATE users SET member_until = ? WHERE email = ?')
      .run(new Date(appTime(t) - 1000).toISOString(), 'st-a@example.com');
    let d = JSON.parse((await get(t, `/api/platform/projects/${pid}`, u.cookie)).body);
    assert.equal(d.project.status, 'published', '会员到期不改变发布状态');
    assert.equal((await get(t, path)).statusCode, 200, '会员到期不自动下线已发布页面');
    // 但不能再发布
    assert.equal((await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } })).statusCode, 403);

    // ② 恢复会员 → 重新发布路径恢复可用
    t.harness.ctx.db.prepare('UPDATE users SET member_until = ? WHERE email = ?')
      .run(new Date(appTime(t) + 30 * 86_400_000).toISOString(), 'st-a@example.com');
    assert.equal(
      (await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } })).statusCode,
      200,
      '恢复会员后应能重新发布',
    );

    // ③ 取消发布：页面下线，但**数据与版本全部保留**
    const beforeUnpub = JSON.parse((await get(t, `/api/platform/projects/${pid}`, u.cookie)).body);
    assert.equal(
      (await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/unpublish`, headers: { cookie: u.cookie } })).statusCode,
      200,
    );
    assert.notEqual((await get(t, path)).statusCode, 200, '取消发布后页面应打不开');
    const afterUnpub = JSON.parse((await get(t, `/api/platform/projects/${pid}`, u.cookie)).body);
    assert.equal(afterUnpub.versions.length, beforeUnpub.versions.length, '取消发布不删除版本');
    assert.deepEqual(afterUnpub.project.spec, beforeUnpub.project.spec, '取消发布不删除内容');

    // ④ 归档：软删除，数据仍在
    const del = await t.app.inject({ method: 'DELETE', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie } });
    assert.equal(del.statusCode, 200, del.body);
    const archived = await t.harness.ctx.db
      .prepare('SELECT status FROM projects WHERE id = ?').get(pid) as { status: string };
    assert.equal(archived.status, 'archived', '归档是软删除');
    const rows = t.harness.ctx.db.prepare('SELECT COUNT(*) c FROM project_versions WHERE project_id = ?').get(pid) as { c: number };
    assert.ok(rows.c > 0, '归档后版本记录仍在库里');
  } finally {
    await t.dispose();
  }
});

test('托管到期机制不存在 —— 如实记录为未实现，而不是猜测规则', async () => {
  const t = await createTestApp();
  try {
    // 这条测试的作用是**固化事实**：数据库里没有托管到期字段，
    // 因此「托管到期」目前不是一个存在的产品状态。产品若需要，必须先定义规则。
    const cols = t.harness.ctx.db.prepare('PRAGMA table_info(projects)').all()
      .map((c) => (c as { name: string }).name);
    assert.ok(cols.includes('published_at'), '有发布时间');
    assert.ok(cols.includes('unpublished_at'), '有停止托管时间');
    assert.ok(
      !cols.some((c) => c.includes('expires') || c.includes('hosting_until')),
      '当前没有托管到期字段 —— 若新增，必须先定义产品规则',
    );
  } finally {
    await t.dispose();
  }
});

// ===========================================================================
// 三、导出包中的平台回链
// ===========================================================================

test('导出包：本地资源自足，平台链接是「可选外链」而非运行依赖', async () => {
  const t = await createTestApp();
  try {
    const u = await paid(t, 'ex-a@example.com');
    const made = await createListingProject(t, u.cookie, '回链核对');
    const upload = multipart('cover.png', 'image/png', tinyPng());
    await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/media`,
      headers: { cookie: u.cookie, 'content-type': upload.contentType }, payload: upload.body,
    });

    const res = await get(t, `/api/platform/projects/${made.project.id}/export`, u.cookie);
    assert.equal(res.statusCode, 200);
    const entries = readZip(Buffer.isBuffer(res.rawPayload) ? res.rawPayload : Buffer.from(res.rawPayload));
    const paths = entries.map((e) => e.path);
    const html = new TextDecoder('utf-8').decode(entries.find((e) => e.path === 'index.html')!.data);

    // ① 运行必需的资源全部在包内，且是相对路径
    const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(imgs.length > 0, '应有图片');
    for (const src of imgs) {
      assert.ok(!/^https?:/i.test(src), `运行必需的图片应是相对路径，实际 ${src}`);
      assert.ok(paths.includes(decodeURIComponent(src)), `${src} 必须存在于导出包内`);
    }
    assert.ok(!/\/api\//.test(html), '不得依赖平台私有 API');
    assert.ok(!/src="\/media\//.test(html), '不得残留站内 /media/ 依赖');

    // ② 区分「资源依赖」与「普通链接」
    //
    // 品牌外链（<a href="https://zhirai.cloud">）和分享链接是**超链接**，
    // 用户点才走网络，不点不影响页面运行 —— 它们的存在是合理的，也不该删。
    // 真正要守的是**承载资源的属性**：img/script/link/source 指向外部，
    // 才会让「离线打开」出现破图或缺样式。
    const resourceAttrs = [
      ...[...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!),
      ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!),
      ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]!),
      ...[...html.matchAll(/<source[^>]+src="([^"]+)"/g)].map((m) => m[1]!),
      ...[...html.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)].map((m) => m[2]!),
    ].filter((v) => v !== '' && !v.startsWith('data:'));
    const externalResources = resourceAttrs.filter((v) => /^https?:\/\//i.test(v));
    assert.deepEqual(
      externalResources, [],
      `运行必需的资源不应指向外部站点（离线会破），实际：${externalResources.join(', ')}`,
    );

    // 链接（<a href>）允许指向平台或品牌 —— 那是可选外链，不是运行依赖
    const anchorLinks = [...html.matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => m[1]!);
    for (const href of anchorLinks) {
      assert.ok(!href.startsWith('/api/'), `锚点不应指向平台私有 API：${href}`);
    }

    // ③ README 必须把「哪些需要联网」讲清楚，而不是宣称完全离线可用
    const readme = new TextDecoder('utf-8').decode(entries.find((e) => e.path === 'README.txt')!.data);
    assert.match(readme, /离线|在线/, 'README 应说明离线限制');
  } finally {
    await t.dispose();
  }
});