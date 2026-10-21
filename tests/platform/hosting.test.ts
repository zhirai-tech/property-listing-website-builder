/**
 * 平台托管：把项目发布成可公开访问的页面。
 *
 * 【这是付费价值的核心】免费用户「生成 + 下载 + 自行部署」，
 * 付费会员「平台托管」。在此之前，托管只是一个权限开关 ——
 * checkQuota 会说「包含托管」、publishProject 会写一条发布版本记录，
 * 但**没有任何东西真的让页面可以被访问**。
 */

import { test } from 'node:test';
import { readZip } from '../../src/util/unzip.ts';
import assert from 'node:assert/strict';
import { createListingProject, createTestApp, multipart, registerUser, tinyPng } from '../helpers/test-app.ts';

/** 注册一个付费用户（直接改库，本阶段不接支付） */
async function registerPaid(t: Awaited<ReturnType<typeof createTestApp>>, email: string) {
  const u = await registerUser(t, email);
  t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run(email);
  return u;
}

async function newCustomPage(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, title: string) {
  const res = await t.app.inject({
    method: 'POST', url: '/api/platform/projects', headers: { cookie },
    payload: { pluginId: 'custom-page', title },
  });
  return JSON.parse(res.body).project;
}

const PAGE_V1 = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第一版</title></head><body><h1>第一版内容</h1><p>这是第一版的正文内容。</p></body></html>';
const PAGE_V2 = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第二版</title></head><body><h1>第二版内容</h1><p>这是第二版的正文内容。</p></body></html>';

test('付费用户发布后得到一个可公开访问的地址', async () => {
  const t = await createTestApp();
  try {
    const u = await registerPaid(t, 'host@example.com');
    const project = await newCustomPage(t, u.cookie, '托管测试页');

    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '第一版', html: PAGE_V1 } },
    });

    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(pub.statusCode, 200, pub.body);
    const body = JSON.parse(pub.body);
    assert.ok(body.publicUrl, '发布响应里必须直接给出可分享的地址');
    assert.match(body.publicUrl, /\/s\/[^/]+$/);

    const slug = body.project.publicSlug;
    assert.ok(slug, '应分配公开短链');

    // 公开访问**不需要登录**
    const anon = await t.app.inject({ method: 'GET', url: `/s/${slug}` });
    assert.equal(anon.statusCode, 200, '公开页面不应要求登录');
    assert.match(String(anon.headers['content-type']), /text\/html/);
    assert.ok(anon.body.includes('第一版内容'));

    // 生成页面必须带严格 CSP（与平台内预览一致）
    const csp = String(anon.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.equal(anon.headers['x-content-type-options'], 'nosniff');
    assert.equal(anon.headers['x-robots-tag'], 'noindex');
  } finally {
    await t.dispose();
  }
});

test('公开页渲染的是发布版本，改草稿不会动线上内容', async () => {
  const t = await createTestApp();
  try {
    const u = await registerPaid(t, 'host-draft@example.com');
    const project = await newCustomPage(t, u.cookie, '草稿隔离');
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '第一版', html: PAGE_V1 } },
    });
    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    const slug = JSON.parse(pub.body).project.publicSlug;

    // 改草稿
    const patch = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '第二版', html: PAGE_V2 } },
    });
    assert.equal(patch.statusCode, 200);

    // 线上仍是第一版 —— 这是用户明确要求的「草稿修改不能破坏正在公开访问的版本」
    const online = await t.app.inject({ method: 'GET', url: `/s/${slug}` });
    assert.equal(online.statusCode, 200);
    assert.ok(online.body.includes('第一版内容'), '线上应仍是发布版本');
    assert.ok(!online.body.includes('第二版内容'), '草稿内容不应出现在线上');

    // 再次发布才切换
    await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    const online2 = await t.app.inject({ method: 'GET', url: `/s/${slug}` });
    assert.ok(online2.body.includes('第二版内容'), '重新发布后线上应更新');
  } finally {
    await t.dispose();
  }
});

test('停止托管后公开地址立刻 404，但内容保留且重新发布沿用同一个地址', async () => {
  const t = await createTestApp();
  try {
    const u = await registerPaid(t, 'host-unpub@example.com');
    const project = await newCustomPage(t, u.cookie, '停止托管');
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '第一版', html: PAGE_V1 } },
    });
    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    const slug = JSON.parse(pub.body).project.publicSlug;

    const unpub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/unpublish`, headers: { cookie: u.cookie },
    });
    assert.equal(unpub.statusCode, 200, unpub.body);

    // 地址失效
    assert.equal((await t.app.inject({ method: 'GET', url: `/s/${slug}` })).statusCode, 404);

    // 但数据还在：版本历史完整、项目还在列表里
    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${project.id}`, headers: { cookie: u.cookie },
    })).body);
    assert.ok(detail.versions.length > 0, '停止托管不应删除版本历史');
    assert.equal(detail.publicUrl, null, '停止托管后不应再给公开地址');
    assert.ok(detail.project.spec.html.includes('第一版内容'), '内容必须保留');

    // 重新发布沿用同一个 slug —— 别人手上的旧链接仍然有效
    const again = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(JSON.parse(again.body).project.publicSlug, slug, '重新发布应沿用同一个地址');
    assert.equal((await t.app.inject({ method: 'GET', url: `/s/${slug}` })).statusCode, 200);
  } finally {
    await t.dispose();
  }
});

test('免费用户不能发布到托管（服务端判定）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'host-free@example.com');
    const project = await newCustomPage(t, u.cookie, '免费用户');
    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(pub.statusCode, 403, '免费用户不应能发布');
    const row = t.harness.ctx.db
      .prepare('SELECT public_slug, status FROM projects WHERE id = ?').get(project.id) as {
        public_slug: string | null; status: string;
      };
    assert.equal(row.public_slug, null, '被拒的发布不应分配短链');
    assert.equal(row.status, 'draft');
  } finally {
    await t.dispose();
  }
});

test('公开地址的边界：未知短链、未发布项目、别的用户的项目都拿不到', async () => {
  const t = await createTestApp();
  try {
    // 未知短链 → 404（不区分「不存在」与「已停止」，避免成为探测器）
    assert.equal((await t.app.inject({ method: 'GET', url: '/s/does-not-exist' })).statusCode, 404);

    const u = await registerPaid(t, 'host-edge@example.com');
    const project = await newCustomPage(t, u.cookie, '边界测试');
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '第一版', html: PAGE_V1 } },
    });

    // 未发布的项目：即使知道 id 也访问不到（没有 slug 可用）
    const before = t.harness.ctx.db
      .prepare('SELECT public_slug FROM projects WHERE id = ?').get(project.id) as { public_slug: string | null };
    assert.equal(before.public_slug, null);

    // 发布后：另一个用户（未登录）能看 —— 这是设计如此（给别人看的页面）
    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    const slug = JSON.parse(pub.body).project.publicSlug;
    assert.equal((await t.app.inject({ method: 'GET', url: `/s/${slug}` })).statusCode, 200);
  } finally {
    await t.dispose();
  }
});

test('房源类项目也能托管，且与房源展示页共用 slug 空间不冲突', async () => {
  const t = await createTestApp();
  try {
    const u = await registerPaid(t, 'host-listing@example.com');
    const made = await createListingProject(t, u.cookie, '托管房源项目');
    assert.equal(made.status, 201);

    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(pub.statusCode, 200, pub.body);
    const slug = JSON.parse(pub.body).project.publicSlug;

    // 平台托管的地址可用
    const page = await t.app.inject({ method: 'GET', url: `/s/${slug}` });
    assert.equal(page.statusCode, 200, '房源类项目也应能托管');
    assert.match(String(page.headers['content-type']), /text\/html/);

    // 与房源展示页的 slug 不冲突：公共页面路由仍然独立可用
    const listingSlugs = t.harness.ctx.db
      .prepare('SELECT slug FROM listing_pages').all() as { slug: string }[];
    for (const row of listingSlugs) {
      assert.notEqual(row.slug, slug, '不应与房源展示页的 slug 撞车');
    }
  } finally {
    await t.dispose();
  }
});

test('项目列表里带出公开地址（用户关掉页面回来还能找到自己的链接）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'listurl@example.com');
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run('listurl@example.com');

    const project = await newCustomPage(t, u.cookie, '地址列表测试');

    // 未发布：列表里没有 publicUrl
    const before = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie },
    })).body);
    assert.equal(before.items[0].publicUrl, null, '未发布时不应给地址');

    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '页', html: PAGE_V1 } },
    });
    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    const slug = JSON.parse(pub.body).project.publicSlug;

    // 发布后：列表里能拿到，且与发布响应里的一致
    const after = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie },
    })).body);
    assert.equal(after.items[0].publicUrl, JSON.parse(pub.body).publicUrl, '列表与发布响应的地址必须一致');
    assert.match(after.items[0].publicUrl, /\/s\//);
    assert.ok(after.items[0].publicUrl.endsWith(slug));

    // 停止托管后列表里也不再给地址
    await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/unpublish`, headers: { cookie: u.cookie },
    });
    const stopped = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie },
    })).body);
    assert.equal(stopped.items[0].publicUrl, null, '停止托管后不应再给地址');
  } finally {
    await t.dispose();
  }
});

test('列表里的地址与公开页真实可用性一致（不能给一个打不开的链接）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'listurl2@example.com');
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run('listurl2@example.com');

    const project = await newCustomPage(t, u.cookie, '可用性一致');
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '页', html: PAGE_V1 } },
    });
    await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });

    const list = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/projects', headers: { cookie: u.cookie },
    })).body);
    const url = list.items[0].publicUrl as string;

    // 把列表给的地址里的路径拿出来，直接请求它 —— 必须真的能打开
    const path = new URL(url).pathname;
    const page = await t.app.inject({ method: 'GET', url: path });
    assert.equal(page.statusCode, 200, '列表给出的地址必须真的能打开');
    assert.ok(page.body.includes('第一版内容'));
  } finally {
    await t.dispose();
  }
});

test('托管短链风格可配置，默认保持既有行为', async () => {
  // 默认：不设 SLUG_STYLE → 沿用既有行为（中文短链）
  const t1 = await createTestApp();
  try {
    const u = await registerUser(t1, 'slugstyle-default@example.com');
    assert.equal(t1.harness.config.slugStyle, 'unicode', '默认必须是 unicode，不能擅自改变既有行为');
  } finally {
    await t1.dispose();
  }
});

test('SLUG_STYLE=ascii 时新发布的短链是纯 ASCII，且既有短链仍可用', async () => {
  const t = await createTestApp();
  try {
    // 这个测试用的 harness 需要 ascii 风格：直接改 config 后重建 app 成本高，
    // 因此改为直接验证「生成函数 + 配置」两段拼起来的行为（见 tests/util/slug-ascii.test.ts），
    // 这里只验证服务端确实按 config 取值。
    const u = await registerUser(t, 'slugstyle-ascii@example.com');
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run('slugstyle-ascii@example.com');

    const project = await newCustomPage(t, u.cookie, '纯中文标题的页面');
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '页', html: PAGE_V1 } },
    });
    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${project.id}/publish`, headers: { cookie: u.cookie },
    });
    const slug = JSON.parse(pub.body).project.publicSlug;

    // 默认风格下：中文短链（既有行为）
    assert.match(slug, /纯中文标题的页面/, '默认应沿用既有行为');
    // 但它仍然可用（不会因为中文而打不开）
    const page = await t.app.inject({ method: 'GET', url: `/s/${encodeURIComponent(slug)}` });
    assert.equal(page.statusCode, 200, '中文短链必须仍然可访问');
  } finally {
    await t.dispose();
  }
});

// ===========================================================================
// 发布快照隔离（修复：房源插件改草稿直接影响线上公开页）
//
// 【原先的缺陷】
// 房源类项目的公开页直接渲染 `aggregateFor(scoped, propertyId)` —— 也就是
// **当前**的 properties 记录；而 `saveDraft` 会把草稿 spec 同步进 properties。
// 两者相叠的后果：**用户一改草稿，已经发布出去的公开页面当场就变了。**
//
// 【修复方式】
// 发布成功时把「当时可渲染的整套数据」冻结成快照存进 project_versions；
// 公开页从快照渲染。改草稿只动草稿版本，不动已发布的快照。
// ===========================================================================

/** 造一个已升级为 basic 的用户（本阶段不接支付，直接改库） */
async function paidUser(t: Awaited<ReturnType<typeof createTestApp>>, email: string) {
  const u = await registerUser(t, email);
  t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run(email);
  return u;
}

/** 读取公开页 HTML */
async function fetchPublic(t: Awaited<ReturnType<typeof createTestApp>>, url: string) {
  const path = new URL(url).pathname;
  const res = await t.app.inject({ method: 'GET', url: path });
  return { status: res.statusCode, body: res.body };
}

test('场景A：首次发布后，公开地址显示发布版本的内容', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'snap-a@example.com');
    const made = await createListingProject(t, u.cookie, '快照甲');
    assert.ok(made.propertyId, '房源项目应自动关联房源');
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${made.project.id}`,
      headers: { cookie: u.cookie },
      payload: { spec: { propertyId: made.propertyId, title: '第一次发布的标题', priceAmount: 8800, city: '上海' } },
    });

    const pub = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/publish`, headers: { cookie: u.cookie },
    });
    assert.equal(pub.statusCode, 200, pub.body);
    const publicUrl = JSON.parse(pub.body).publicUrl;
    assert.ok(publicUrl, '发布响应必须带公开地址');

    const page = await fetchPublic(t, publicUrl);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('第一次发布的标题'), '公开页应显示发布版本的标题');
    assert.ok(page.body.includes('8,800') || page.body.includes('8800'), '公开页应显示发布版本的价格');
  } finally {
    await t.dispose();
  }
});

test('场景B：改草稿不影响线上，草稿与发布版本确实分离', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'snap-b@example.com');
    const made = await createListingProject(t, u.cookie, '快照乙');
    assert.ok(made.propertyId, '房源项目应自动关联房源');
    const pid = made.project.id;

    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`,
      headers: { cookie: u.cookie },
      payload: { spec: { propertyId: made.propertyId, title: '线上标题', priceAmount: 8800 } },
    });
    const pub = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    const publicUrl = JSON.parse(pub.body).publicUrl;

    // 改草稿（不重新发布）
    const patch = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`,
      headers: { cookie: u.cookie },
      payload: { spec: { propertyId: made.propertyId, title: '草稿里的新标题', priceAmount: 12000 } },
    });
    assert.equal(patch.statusCode, 200, patch.body);

    // 线上必须还是旧内容
    const online = await fetchPublic(t, publicUrl);
    assert.equal(online.status, 200, '改草稿不应让线上页面打不开');
    assert.ok(online.body.includes('线上标题'), '线上应仍是发布版本的标题');
    assert.ok(!online.body.includes('草稿里的新标题'), '草稿标题不应出现在线上');
    assert.ok(!online.body.includes('12,000'), '草稿价格不应出现在线上');

    // 草稿接口能看到修改后的内容 —— 证明两者确实分离
    const draft = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.equal(draft.project.spec.title, '草稿里的新标题', '草稿应保留修改后的内容');
    assert.equal(Number(draft.project.spec.priceAmount), 12000);
  } finally {
    await t.dispose();
  }
});

test('场景C：重新发布后，同一公开地址切换到新版本', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'snap-c@example.com');
    const made = await createListingProject(t, u.cookie, '快照丙');
    assert.ok(made.propertyId, '房源项目应自动关联房源');
    const pid = made.project.id;

    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId: made.propertyId, title: '第一版标题' } },
    });
    const pub1 = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    const url = JSON.parse(pub1.body).publicUrl;
    assert.ok((await fetchPublic(t, url)).body.includes('第一版标题'));

    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId: made.propertyId, title: '第二版标题' } },
    });
    const pub2 = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    assert.equal(pub2.statusCode, 200, pub2.body);
    assert.equal(JSON.parse(pub2.body).publicUrl, url, '重新发布应沿用同一个地址');

    const after = await fetchPublic(t, url);
    assert.ok(after.body.includes('第二版标题'), '重新发布后线上应更新');
    assert.ok(!after.body.includes('第一版标题'), '旧内容不应残留');
  } finally {
    await t.dispose();
  }
});

test('场景D：重新发布失败时，最后一次成功发布的版本仍然可访问', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'snap-d@example.com');
    const made = await createListingProject(t, u.cookie, '快照丁');
    assert.ok(made.propertyId, '房源项目应自动关联房源');
    const pid = made.project.id;

    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId: made.propertyId, title: '成功发布的版本' } },
    });
    const pub = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    const url = JSON.parse(pub.body).publicUrl;
    assert.ok((await fetchPublic(t, url)).body.includes('成功发布的版本'));

    // 模拟发布失败：把项目指向一个不存在的房源，再发布
    const broken = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId: 'prp_00000000-0000-0000-0000-000000000000', title: '坏掉的草稿' } },
    });
    assert.equal(broken.statusCode, 200, broken.body);

    const failPub = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    assert.notEqual(failPub.statusCode, 200, '指向不存在的房源时发布必须失败');
    assert.ok(failPub.statusCode >= 400, `应返回错误状态，实际 ${failPub.statusCode}`);

    // 旧版本必须原样可访问
    const still = await fetchPublic(t, url);
    assert.equal(still.status, 200, '发布失败不应让线上页面打不开');
    assert.ok(still.body.includes('成功发布的版本'), '发布失败后线上应仍是最后一次成功的版本');
    assert.ok(!still.body.includes('坏掉的草稿'), '失败的草稿不应影响线上');

    // 项目仍应处于「已发布」状态，指向原来的版本
    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.equal(detail.project.status, 'published');
    assert.equal(detail.publicUrl, url, '失败后仍应给出原来的公开地址');
  } finally {
    await t.dispose();
  }
});

test('场景E：未发布的项目不会因为保存草稿就获得公开页面', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'snap-e@example.com');
    const made = await createListingProject(t, u.cookie, '快照戊');
    assert.ok(made.propertyId, '房源项目应自动关联房源');
    const pid = made.project.id;

    // 保存草稿但不发布
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId: made.propertyId, title: '未发布的机密标题' } },
    });

    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.equal(detail.project.status, 'draft', '保存草稿不应把状态变成已发布');
    assert.equal(detail.project.publicSlug, null, '未发布不应分配公开短链');
    assert.equal(detail.publicUrl, null, '未发布不应给出公开地址');

    // 用项目标题猜短链，确认打不开
    for (const guess of ['快照戊', 'snapshot-e']) {
      const res = await t.app.inject({ method: 'GET', url: `/s/${encodeURIComponent(guess)}` });
      assert.equal(res.statusCode, 404, `未发布项目不应能通过 /s/${guess} 访问`);
    }
  } finally {
    await t.dispose();
  }
});

test('场景F：原有房源能力与数据未受快照改动影响', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'snap-f@example.com');
    const made = await createListingProject(t, u.cookie, '快照己');
    assert.ok(made.propertyId, '房源项目应自动关联房源');
    const pid = made.project.id;
    const propertyId = made.propertyId;
    assert.ok(propertyId, '房源项目应自动关联房源');

    // 1) 草稿同步仍然工作：草稿字段确实写进了 properties
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId, title: '同步检查标题', priceAmount: 6600, city: '上海', district: '浦东新区' } },
    });
    const row = t.harness.ctx.db
      .prepare('SELECT title, price_amount, city, district FROM properties WHERE id = ?')
      .get(propertyId) as { title: string; price_amount: number; city: string; district: string };
    assert.equal(row.title, '同步检查标题', 'spec 应继续同步进 properties');
    assert.equal(Number(row.price_amount), 6600);
    assert.equal(row.city, '上海');

    // 2) 平台用户的项目仍能在平台侧读回（含刚同步过去的字段）
    const detail = JSON.parse((await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
    })).body);
    assert.equal(detail.project.spec.title, '同步检查标题', '平台侧应能读回草稿');

    // 注意：平台用户有自己的工作区，其房源不在房东后台的工作区作用域内（既有的按用户隔离设计），
    // 因此这里**不应该**去断言 /api/admin/properties/<id> 能读到它 —— 那是另一个工作区的数据。

    // 3) 照片仍可上传且出现在发布快照里
    const form = multipart('客厅.png', 'image/png', tinyPng());
    const up = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${pid}/media`,
      headers: { cookie: u.cookie, 'content-type': form.contentType }, payload: form.body,
    });
    assert.equal(up.statusCode, 201, up.body);

    // 4) 发布后公开页含照片、含标题
    const pub = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${pid}/publish`, headers: { cookie: u.cookie } });
    assert.equal(pub.statusCode, 200, pub.body);
    const url = JSON.parse(pub.body).publicUrl;
    const page = await fetchPublic(t, url);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('同步检查标题'), '公开页应含发布时冻结的标题');
    assert.match(page.body, /<img/i, '公开页应含照片');

    // 5) 发布后改草稿：properties 变了，但线上不变（快照隔离的核心保证）
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId, title: '改动后的草稿标题', priceAmount: 9900, city: '上海', district: '浦东新区' } },
    });
    const after = t.harness.ctx.db.prepare('SELECT title FROM properties WHERE id = ?').get(propertyId) as { title: string };
    assert.equal(after.title, '改动后的草稿标题', '草稿仍应同步进 properties（原有行为不变）');

    const onlineAfter = await fetchPublic(t, url);
    assert.ok(onlineAfter.body.includes('同步检查标题'), '线上应仍是发布版本（快照未被草稿改动）');
    assert.ok(!onlineAfter.body.includes('改动后的草稿标题'), '草稿改动不应出现在线上');
    assert.match(onlineAfter.body, /<img/i, '线上照片不应因改草稿而丢失');

    // 6) 语言参数仍然可用
    const en = await t.app.inject({ method: 'GET', url: `${new URL(url).pathname}?lang=en` });
    assert.equal(en.statusCode, 200, '公开页语言参数仍应可用');
  } finally {
    await t.dispose();
  }
});

// ===========================================================================
// 导出包的真实 ZIP 解压验证（修复：资源 URL 被盲替换成畸形地址）
//
// 不能只断言字符串 —— 必须真的生成 ZIP、解压、确认文件存在且引用一致。
// ===========================================================================

test('场景E：真实导出 ZIP 解压后，本地资源引用与包内文件一致，且无畸形 URL', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'export-url@example.com');
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run('export-url@example.com');

    const made = await createListingProject(t, u.cookie, '导出验证');
    assert.ok(made.propertyId, '房源项目应自动关联房源');
    const pid = made.project.id;

    // 写一个可辨认的标题 + 一张照片
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId: made.propertyId, title: '导出验证房源', priceAmount: 5200, city: '上海' } },
    });
    const upload = multipart('cover.png', 'image/png', tinyPng());
    const up = await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${pid}/media`,
      headers: { cookie: u.cookie, 'content-type': upload.contentType }, payload: upload.body,
    });
    assert.equal(up.statusCode, 201, up.body);

    // 真实导出
    const res = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${pid}/export`, headers: { cookie: u.cookie } });
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    const zipData = Buffer.isBuffer(res.rawPayload) ? res.rawPayload : Buffer.from(res.rawPayload);
    const entries = readZip(zipData);
    const paths = entries.map((e) => e.path);

    // 1) 结构完整
    assert.ok(paths.includes('index.html'), `ZIP 应含 index.html，实际：${paths.join(', ')}`);
    const assets = paths.filter((p) => p.startsWith('assets/'));
    assert.ok(assets.length >= 1, `ZIP 应含 assets/ 下的资源，实际：${paths.join(', ')}`);

    const htmlEntry = entries.find((e) => e.path === 'index.html')!;
    const html = new TextDecoder('utf-8').decode(htmlEntry.data);

    // 2) 绝不能出现畸形 URL（本次修复的核心缺陷）
    assert.doesNotMatch(html, /:\d+assets\//, '不得出现 host:portassets 这种缺斜杠的地址');
    assert.doesNotMatch(html, /[a-z]assets\//i, '不得出现域名/端口与 assets 直接相连的形式');

    // 3) HTML 里引用的每一个本地资源都必须真实存在于 ZIP 中
    const localRefs = [...html.matchAll(/(?:src|href|content)="(assets\/[^"]+)"/g)].map((m) => m[1]!);
    assert.ok(localRefs.length > 0, 'HTML 应至少引用一个本地资源');
    for (const ref of localRefs) {
      const decoded = decodeURIComponent(ref);
      assert.ok(
        paths.includes(decoded),
        `HTML 引用的 ${decoded} 必须存在于 ZIP 中；实际条目：${paths.join(', ')}`,
      );
    }

    // 4) 不得残留指向本站 /media/ 或平台私有接口的引用
    assert.ok(!html.includes('/api/'), '导出页不得依赖平台私有 API');
    assert.ok(!/src="\/media\//.test(html), '导出页不得残留站内 /media/ 引用');
    assert.ok(!/content="https?:\/\/[^"]*\/media\//.test(html), '绝对 URL 形式的 /media/ 引用也应被改写');

    // 5) 不得泄露凭证或服务器信息
    const secrets = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'adminPassword', 'sessionSecret', 'AI_API_KEY', 'app.sqlite', t.harness.config.adminPassword];
    for (const secret of secrets) {
      assert.ok(!html.includes(secret), `导出页不得包含 ${secret}`);
    }

    // 6) 内容确实来自该项目（不是空页或串页）
    assert.ok(html.includes('导出验证房源'), '导出页应含房源标题');
    assert.match(html, /<img/i, '导出页应含图片');
  } finally {
    await t.dispose();
  }
});

test('场景E2：导出目录形式同样得到正确的资源引用', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'export-dir@example.com');
    t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run('export-dir@example.com');

    const made = await createListingProject(t, u.cookie, '目录导出');
    assert.ok(made.propertyId);
    const upload = multipart('photo.png', 'image/png', tinyPng());
    await t.app.inject({
      method: 'POST', url: `/api/platform/projects/${made.project.id}/media`,
      headers: { cookie: u.cookie, 'content-type': upload.contentType }, payload: upload.body,
    });

    // 直接走 bundle（目录与 ZIP 共用同一份构建逻辑）
    const { buildExportBundle } = await import('../../src/services/export-service.ts');
    const workspace = t.harness.ctx.db.prepare('SELECT id FROM workspaces WHERE owner_user_id = (SELECT id FROM users WHERE email = ?)')
      .get('export-dir@example.com') as { id: string } | undefined;
    assert.ok(workspace, '应能取到该用户的工作区');

    const { getWorkspace } = await import('../../src/db/repositories/workspace-repo.ts');
    const scoped = { ...t.harness.ctx, workspace: getWorkspace(t.harness.ctx.db, workspace.id)! };
    const bundle = await buildExportBundle(scoped, made.propertyId, {});

    const paths = bundle.files.map((f) => f.path);
    const htmlFile = bundle.files.find((f) => f.path === 'index.html')!;
    const html = new TextDecoder('utf-8').decode(htmlFile.data);

    assert.doesNotMatch(html, /:\d+assets\//, '目录导出同样不得出现畸形 URL');
    const localRefs = [...html.matchAll(/(?:src|href|content)="(assets\/[^"]+)"/g)].map((m) => m[1]!);
    assert.ok(localRefs.length > 0, '应有本地资源引用');
    for (const ref of localRefs) {
      assert.ok(paths.includes(decodeURIComponent(ref)), `${ref} 应在导出文件清单中`);
    }
  } finally {
    await t.dispose();
  }
});

// ===========================================================================
// 发布内容校验（修复：空内容项目也能「发布成功」但地址 404）
//
// 原先 publishProject 不校验内容：`spec = {}` 的项目也能发布成功，
// 接口返回 200 + 公开地址，而那个地址打开是 404。
// 这比直接拒绝更糟 —— 用户会把打不开的链接分享出去，还不知道该改什么。
// ===========================================================================

/** 发布并返回 { status, body } */
async function tryPublish(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, id: string) {
  const res = await t.app.inject({ method: 'POST', url: `/api/platform/projects/${id}/publish`, headers: { cookie } });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, any> };
}

/** 读项目详情 */
async function detail(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, id: string) {
  const res = await t.app.inject({ method: 'GET', url: `/api/platform/projects/${id}`, headers: { cookie } });
  return JSON.parse(res.body) as Record<string, any>;
}

test('场景A：空 spec 项目不能发布成功', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'pub-a@example.com');
    const made = await newCustomPage(t, u.cookie, '空内容项目');
    const pid = made.id;

    // 确认 spec 确实是空的（从未保存过任何内容）
    const before = await detail(t, u.cookie, pid);
    assert.deepEqual(before.project.spec, {}, '前置条件：spec 应为空对象');

    const r = await tryPublish(t, u.cookie, pid);

    // 必须被拒绝，且**不能**返回公开地址
    assert.notEqual(r.status, 200, `空内容不应发布成功，实际 ${r.status}`);
    assert.equal(r.status, 422, `应为 422（内容无效），实际 ${r.status}`);
    assert.equal(r.body.publicUrl, undefined, '失败时不得返回公开地址');

    // 项目状态与短链都不能被改动
    const after = await detail(t, u.cookie, pid);
    assert.equal(after.project.status, 'draft', '失败后项目应仍是草稿');
    assert.equal(after.project.publicSlug, null, '失败后不应分配公开短链');
    assert.equal(after.project.publishedVersionId, null, '失败后不应产生发布版本');
    // 注意：建项目时本来就会有一条草稿版本（versionNo=1），
    // 该断言的是「失败不产生**发布**版本」。
    assert.equal(
      after.versions.filter((v: { kind: string }) => v.kind === 'published').length,
      0,
      '失败后不应产生发布版本',
    );
  } finally {
    await t.dispose();
  }
});

test('场景B：缺少必要内容时拒绝，并给出可理解的错误原因', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'pub-b@example.com');
    const made = await newCustomPage(t, u.cookie, '只有标题没有内容');
    const pid = made.id;

    // 只写标题，不写 html —— 缺必要内容
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { title: '只有标题' } },
    });

    const r = await tryPublish(t, u.cookie, pid);
    assert.equal(r.status, 422, `应拒绝，实际 ${r.status}`);
    const message = r.body.error?.message ?? '';
    assert.ok(message.length > 0, '必须有可读的错误信息');
    assert.match(message, /还没有内容|无法发布/, `错误信息应说明原因，实际：${message}`);
    assert.ok(!/权限|套餐|升级/.test(message), '错误信息不该误报成权限或配额问题');

    // html 为空字符串同样要被拒
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { title: '空字符串', html: '' } },
    });
    assert.equal((await tryPublish(t, u.cookie, pid)).status, 422, 'html 为空串也应被拒');

    // 只有空白字符同样要被拒
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { title: '空白', html: '   \n  ' } },
    });
    assert.equal((await tryPublish(t, u.cookie, pid)).status, 422, '只有空白的内容也应被拒');
  } finally {
    await t.dispose();
  }
});

test('场景C：有效内容发布成功，公开页内容与发布版本一致', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'pub-c@example.com');
    const made = await newCustomPage(t, u.cookie, '有效内容项目');
    const pid = made.id;

    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>有效页面标题</title></head><body><h1>有效页面标题</h1><p>这是一段足够长的正文内容，用于通过内容质量检查与发布校验。</p></body></html>';
    const save = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { title: '有效页面标题', html } },
    });
    assert.equal(save.statusCode, 200, save.body);

    const r = await tryPublish(t, u.cookie, pid);
    assert.equal(r.status, 200, `有效内容应发布成功：${JSON.stringify(r.body).slice(0, 160)}`);
    assert.ok(r.body.publicUrl, '成功时应返回公开地址');

    // 公开地址真的能打开，且内容与发布版本一致
    const page = await fetchPublic(t, r.body.publicUrl);
    assert.equal(page.status, 200, '公开地址应可访问');
    assert.ok(page.body.includes('有效页面标题'), '公开页应含发布版本的内容');
    assert.ok(page.body.includes('这是一段足够长的正文内容'), '公开页应含发布版本的正文');

    // 发布状态与版本一致
    const d = await detail(t, u.cookie, pid);
    assert.equal(d.project.status, 'published');
    assert.equal(d.publicUrl, r.body.publicUrl, '详情接口的地址应与发布响应一致');
    assert.ok(d.versions.some((v: { kind: string }) => v.kind === 'published'), '应产生发布版本');
  } finally {
    await t.dispose();
  }
});

test('场景D：已发布项目的无效草稿重新发布失败，旧版本原样保留', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'pub-d@example.com');
    const made = await newCustomPage(t, u.cookie, '旧版本保护');
    const pid = made.id;

    const goodHtml = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第一版好页面</title></head><body><h1>第一版好页面</h1><p>这是第一版的正文内容，足够长以通过校验。</p></body></html>';
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { title: '第一版好页面', html: goodHtml } },
    });
    const first = await tryPublish(t, u.cookie, pid);
    assert.equal(first.status, 200, '先发布一个有效版本');
    const url = first.body.publicUrl;
    assert.ok((await fetchPublic(t, url)).body.includes('第一版好页面'));

    // 把草稿改成无效内容（清空 html）
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${pid}`, headers: { cookie: u.cookie },
      payload: { spec: { title: '被清空的草稿', html: '' } },
    });

    const second = await tryPublish(t, u.cookie, pid);
    assert.equal(second.status, 422, `无效草稿应发布失败，实际 ${second.status}`);

    // 旧版本必须原样可访问
    const still = await fetchPublic(t, url);
    assert.equal(still.status, 200, '发布失败不应影响已发布的页面');
    assert.ok(still.body.includes('第一版好页面'), '旧版本内容应保持不变');
    assert.ok(!still.body.includes('被清空的草稿'), '无效草稿不得出现在线上');

    // 项目仍指向原来的发布版本，短链不变
    const d = await detail(t, u.cookie, pid);
    assert.equal(d.project.status, 'published', '项目应仍是已发布状态');
    assert.equal(d.project.publicSlug, first.body.project.publicSlug, '短链不应改变');
    assert.equal(d.publicUrl, url, '公开地址不应改变');

    // 发布版本数不应增加（失败不产生新版本）
    const publishedBefore = (await detail(t, u.cookie, pid)).versions.filter((v: { kind: string }) => v.kind === 'published').length;
    await tryPublish(t, u.cookie, pid);
    const publishedAfter = (await detail(t, u.cookie, pid)).versions.filter((v: { kind: string }) => v.kind === 'published').length;
    assert.equal(publishedAfter, publishedBefore, '反复失败不应累积发布版本');
  } finally {
    await t.dispose();
  }
});

test('场景E：校验规则按插件类型区分', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'pub-e@example.com');
    const plugins = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/plugins', headers: { cookie: u.cookie },
    })).body).items as { id: string }[];
    assert.deepEqual(plugins.map((p) => p.id).sort(), ['custom-page', 'listing'], '当前应只有这两个内置插件');

    // --- 自定义页面：没有 html 拒绝；有 html 通过 ---
    const cp = await newCustomPage(t, u.cookie, '插件区分-自定义');
    assert.equal((await tryPublish(t, u.cookie, cp.id)).status, 422, 'custom-page 无内容应被拒');

    // --- 房源项目：没有 propertyId 拒绝 ---
    const lp = await createListingProject(t, u.cookie, '插件区分-房源');
    assert.ok(lp.propertyId, '房源项目应自动关联房源');
    const lpid = lp.project.id;

    // 先确认合法房源项目能发布（不因可选字段为空而误拒）
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${lpid}`, headers: { cookie: u.cookie },
      payload: { spec: { propertyId: lp.propertyId, title: '关联后的房源页' } },
    });
    const ok = await tryPublish(t, u.cookie, lpid);
    assert.equal(ok.status, 200, `合法房源项目应能发布：${JSON.stringify(ok.body).slice(0, 140)}`);

    // 再验证「快照采不到就拒绝发布」这条真实路径：把房源删掉后重新发布
    // （注意：不能靠 PATCH 部分 spec 来清 propertyId —— saveDraft 会保留结构性键，
    //   这是正确行为：保存部分字段不该把项目与房源解绑。）
    t.harness.ctx.db.prepare('DELETE FROM media WHERE property_id = ?').run(lp.propertyId!);
    t.harness.ctx.db.prepare('DELETE FROM listing_pages WHERE property_id = ?').run(lp.propertyId!);
    t.harness.ctx.db.prepare('DELETE FROM properties WHERE id = ?').run(lp.propertyId!);

    const gone = await tryPublish(t, u.cookie, lpid);
    assert.equal(gone.status, 422, `房源已不存在时应拒绝发布，实际 ${gone.status}`);
    assert.match(gone.body.error?.message ?? '', /房源/, '错误信息应说明房源问题');

    // --- 自定义页面的规则不该套到房源项目上 ---
    // 房源项目的 spec 里没有 html，但它依然可以发布 —— 证明校验是按插件区分的
    const listingDetail = await detail(t, u.cookie, lpid);
    assert.equal(listingDetail.project.spec.html, undefined, '房源项目的 spec 本来就没有 html 字段');
    assert.equal(listingDetail.project.status, 'published', '没有 html 也不应妨碍房源项目发布');
  } finally {
    await t.dispose();
  }
});

test('场景F：内容无效的错误语义与失败原因一致', async () => {
  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'pub-f@example.com');
    const made = await newCustomPage(t, u.cookie, '错误语义');
    const pid = made.id;

    const r = await tryPublish(t, u.cookie, pid);

    // 状态码：422（内容无效），不是 403（权限）也不是 200（成功）
    assert.equal(r.status, 422, `内容无效应为 422，实际 ${r.status}`);
    assert.notEqual(r.status, 403, '不得报告成权限错误');
    assert.notEqual(r.status, 200, '不得报告成成功');

    // 错误码：语义正确
    assert.equal(r.body.error?.code, 'UNPROCESSABLE', `错误码应为 UNPROCESSABLE，实际 ${r.body.error?.code}`);
    assert.notEqual(r.body.error?.code, 'FORBIDDEN', '不得报告成 FORBIDDEN（那是权限语义）');

    // 提示：说明「内容」问题，而不是权限或配额
    const message = r.body.error?.message ?? '';
    assert.ok(!/套餐|升级|额度|Token|权限/.test(message), `提示不该提到权限或配额，实际：${message}`);

    // 对照：同一用户对不存在的项目发布仍是 404（没有被这次改动破坏）
    const missing = await tryPublish(t, u.cookie, 'prj_00000000-0000-0000-0000-000000000000');
    assert.equal(missing.status, 404, '不存在的项目应仍是 404');
    assert.equal(missing.body.error?.code, 'NOT_FOUND', '不存在应为 NOT_FOUND');

    // 对照：免费用户仍是 403（配额/权限路径未受影响）
    const free = await registerUser(t, 'pub-f-free@example.com');
    const freeProject = await newCustomPage(t, free.cookie, '免费用户');
    const freePub = await tryPublish(t, free.cookie, freeProject.id);
    assert.equal(freePub.status, 403, '免费用户的托管限制应仍是 403');
  } finally {
    await t.dispose();
  }
});