/**
 * 模式 B（自由描述生成）的端到端测试。
 *
 * 【关键点】假上游返回的是**我们写死的 HTML**，
 * 因此可以精确构造「合法页面」「含脚本的页面」等场景，
 * 验证校验门在**真实链路**上确实拦得住，而不是只在单元测试里拦得住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createListingProject, createTestApp, multipart, registerUser } from '../helpers/test-app.ts';
import { runAiTask } from '../../src/platform/projects.ts';
import { createOpenAiCompatibleProvider } from '../../src/platform/ai/openai-provider.ts';
import { ensureCharset } from '../../src/platform/page-generation.ts';

const GOOD_PAGE = `<!doctype html><html lang="zh-CN"><head><title>我的介绍页</title>
<style>body{font-family:sans-serif;padding:24px}</style></head>
<body><h1>你好，我是张三</h1><p>这是一段介绍文字，用来验证生成流程。</p></body></html>`;

/** 起一个假上游，返回指定 content 的补丁 */
async function withFakeUpstream(patch: Record<string, unknown>, fn: (baseUrl: string) => Promise<void>) {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(patch) } }],
      usage: { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 造一个 basic 会员（本阶段不接支付，直接改库） */
async function paidUser(t: Awaited<ReturnType<typeof createTestApp>>, email: string) {
  const u = await registerUser(t, email);
  t.harness.ctx.db.prepare("UPDATE users SET tier = 'basic' WHERE email = ?").run(email);
  return u;
}

/** 超时测试专用：把超时压到 400ms，否则要等 3 秒 */
async function makeProviderWithTimeout(baseUrl: string, timeoutMs: number) {
  return createOpenAiCompatibleProvider({
    name: 'openai', baseUrl, apiKey: 'fake', model: 'fake-model', timeoutMs,
  });
}

async function makeProvider(baseUrl: string) {
  return createOpenAiCompatibleProvider({
    name: 'openai', baseUrl, apiKey: 'fake', model: 'fake-model', timeoutMs: 3000,
  });
}

async function newCustomProject(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, title: string) {
  const res = await t.app.inject({
    method: 'POST', url: '/api/platform/projects', headers: { cookie },
    payload: { pluginId: 'custom-page', title },
  });
  return JSON.parse(res.body).project;
}

test('自定义页面插件已注册且声明了必要的字段与能力', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'plugin-cp@example.com');
    const res = await t.app.inject({
      method: 'GET', url: '/api/platform/plugins', headers: { cookie: u.cookie },
    });
    const items = JSON.parse(res.body).items;
    const cp = items.find((p: { id: string }) => p.id === 'custom-page');
    assert.ok(cp, '应存在 custom-page 插件');
    assert.equal(cp.pageType, 'custom-page');
    assert.ok(cp.fields.some((f: { key: string }) => f.key === 'html'), '应声明 html 字段');
    assert.ok(cp.fields.some((f: { key: string }) => f.key === 'title'), '应声明 title 字段');
  } finally {
    await t.dispose();
  }
});

test('模式 B 端到端：合法页面被保存，用量记账，预览与下载可用', async () => {
  await withFakeUpstream({ title: '我的介绍页', html: GOOD_PAGE }, async (baseUrl) => {
    const t = await createTestApp();
    try {
      const u = await registerUser(t, 'modeb-ok@example.com');
      const project = await newCustomProject(t, u.cookie, '模式B项目');
      const userId = (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?')
        .get('modeb-ok@example.com') as { id: string }).id;

      const result = await runAiTask(t.harness.ctx, await makeProvider(baseUrl), userId, {
        projectId: project.id, kind: 'generate', prompt: '做一个自我介绍页', taskId: 'modeb-1',
      });

      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(result.patch['title'], '我的介绍页');
      assert.equal(result.usage.totalTokens, 500);

      // 内容真的存进去了
      const stored = t.harness.ctx.db
        .prepare('SELECT spec_json FROM projects WHERE id = ?')
        .get(project.id) as { spec_json: string };
      assert.ok(JSON.parse(stored.spec_json).html.includes('你好，我是张三'));

      // 预览：返回 HTML，且带严格的 CSP 与 sandbox 相关头
      const preview = await t.app.inject({
        method: 'GET', url: `/api/platform/projects/${project.id}/preview`, headers: { cookie: u.cookie },
      });
      assert.equal(preview.statusCode, 200);
      assert.match(String(preview.headers['content-type']), /text\/html/);
      assert.ok(preview.body.includes('你好，我是张三'));
      assert.equal(preview.headers['x-robots-tag'], 'noindex');
      assert.equal(preview.headers['x-content-type-options'], 'nosniff');
      const csp = String(preview.headers['content-security-policy']);
      assert.match(csp, /default-src 'none'/);
      assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);

      // 下载：直接下发 .html
      const dl = await t.app.inject({
        method: 'GET', url: `/api/platform/projects/${project.id}/export`, headers: { cookie: u.cookie },
      });
      assert.equal(dl.statusCode, 200);
      assert.match(String(dl.headers['content-disposition']), /attachment/);
      assert.ok(dl.body.includes('你好，我是张三'));

      // 额度按假上游返回的 500 扣
      const quota = JSON.parse((await t.app.inject({
        method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
      })).body);
      assert.equal(quota.tokens.used, 500);
    } finally {
      await t.dispose();
    }
  });
});

test('模式 B：含脚本的输出被校验门拦住，不保存且不计入消耗', async () => {
  const evil = GOOD_PAGE.replace('</body>', '<script>fetch("/api/admin/overview")</script></body>');
  await withFakeUpstream({ title: '恶意页', html: evil }, async (baseUrl) => {
    const t = await createTestApp();
    try {
      const u = await registerUser(t, 'modeb-evil@example.com');
      const project = await newCustomProject(t, u.cookie, '恶意项目');
      const userId = (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?')
        .get('modeb-evil@example.com') as { id: string }).id;

      const result = await runAiTask(t.harness.ctx, await makeProvider(baseUrl), userId, {
        projectId: project.id, kind: 'generate', prompt: '做个页面', taskId: 'modeb-evil-1',
      });

      assert.equal(result.ok, false, '含脚本的输出必须被拒');
      if (!result.ok) {
        assert.equal(result.code, 'unsafe_output');
        assert.match(result.message, /没有通过安全检查/);
        // 提示必须能说清哪里不对，而不是一句「生成失败」
        assert.match(result.message, /脚本/);
      }

      // 没有写入任何内容
      const stored = t.harness.ctx.db
        .prepare('SELECT spec_json FROM projects WHERE id = ?')
        .get(project.id) as { spec_json: string };
      assert.equal(JSON.parse(stored.spec_json).html, undefined, '被拒的输出不应写入项目');

      // 任务记 failed，且**不计入消耗**
      const row = t.harness.ctx.db
        .prepare('SELECT * FROM ai_usage WHERE task_id = ?')
        .get('modeb-evil-1') as Record<string, unknown>;
      assert.equal(row['status'], 'failed');
      assert.match(String(row['failure_reason']), /未通过安全检查/);

      const quota = JSON.parse((await t.app.inject({
        method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
      })).body);
      assert.equal(quota.tokens.used, 0, '被拒的输出不应扣额度');
      assert.equal(quota.generations.used, 0);
    } finally {
      await t.dispose();
    }
  });
});

test('模式 B：用户手改 HTML 也要过同一道门（不能靠「先生成再编辑」绕过）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'modeb-edit@example.com');
    const project = await newCustomProject(t, u.cookie, '手改项目');

    // 先存一份合法内容
    const ok = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '页', html: GOOD_PAGE } },
    });
    assert.equal(ok.statusCode, 200, ok.body);

    // 再手改成一个含脚本的页面 → 必须被拒
    const evil = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie },
      payload: { spec: { html: GOOD_PAGE.replace('</body>', '<script>x()</script></body>') } },
    });
    assert.equal(evil.statusCode, 422, `手改的非法内容必须被拒，实际 ${evil.statusCode}`);
    assert.match(evil.body, /没有通过安全检查/);

    // 库里的内容仍是上一份合法版本
    const stored = t.harness.ctx.db
      .prepare('SELECT spec_json FROM projects WHERE id = ?')
      .get(project.id) as { spec_json: string };
    assert.doesNotMatch(JSON.parse(stored.spec_json).html, /<script/i, '被拒的修改不应落库');

    // 非法内容返回的是 422 而不是 404（否则用户会以为项目没了）
    assert.notEqual(evil.statusCode, 404);
  } finally {
    await t.dispose();
  }
});

test('模式 B：项目不存在与内容不合规是两种不同的响应', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'modeb-distinct@example.com');

    const missing = await t.app.inject({
      method: 'PATCH', url: '/api/platform/projects/prj_nope', headers: { cookie: u.cookie },
      payload: { spec: { html: GOOD_PAGE } },
    });
    assert.equal(missing.statusCode, 404, '不存在的项目应返回 404');

    const project = await newCustomProject(t, u.cookie, '区分项目');
    const bad = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`, headers: { cookie: u.cookie },
      payload: { spec: { html: '<html><body><script>x</script></body></html>' } },
    });
    assert.equal(bad.statusCode, 422, '存在但不合规应返回 422');
  } finally {
    await t.dispose();
  }
});

test('模式 B：还没生成内容时预览与下载给出明确提示，而不是空白页', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'modeb-empty@example.com');
    const project = await newCustomProject(t, u.cookie, '空项目');

    const preview = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${project.id}/preview`, headers: { cookie: u.cookie },
    });
    assert.equal(preview.statusCode, 404);
    assert.match(preview.body, /还没有生成内容/);

    const dl = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${project.id}/export`, headers: { cookie: u.cookie },
    });
    assert.equal(dl.statusCode, 400);
    assert.match(dl.body, /还没有生成内容/);
  } finally {
    await t.dispose();
  }
});

test('模式 B 与照片上传互不干扰：自定义页面项目里没有房源，媒体接口给出明确错误', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'modeb-media@example.com');
    const project = await newCustomProject(t, u.cookie, '无房源项目');

    const res = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${project.id}/media`, headers: { cookie: u.cookie },
    });
    assert.equal(res.statusCode, 404, '没有关联房源时应给出明确错误而不是 500');
    // 顺带确认 multipart 也没被误用
    assert.equal(typeof multipart, 'function');
  } finally {
    await t.dispose();
  }
});

test('模式 B 的约束走 system 指令，不混进用户的 prompt', async () => {
  // 记录假上游收到的完整请求体，确认两段内容各就各位
  let received: Record<string, any> | null = null;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received = JSON.parse(raw);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ title: '页', html: GOOD_PAGE }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'instr@example.com');
    const project = await newCustomProject(t, u.cookie, '指令分离');
    const userId = (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?')
      .get('instr@example.com') as { id: string }).id;

    await runAiTask(t.harness.ctx, await makeProvider(`http://127.0.0.1:${port}/v1`), userId, {
      projectId: project.id, kind: 'generate', prompt: '做一个自我介绍页', taskId: 'instr-1',
    });

    assert.ok(received, '假上游应收到请求');
    const messages = (received as Record<string, any>)['messages'] as { role: string; content: string }[];
    const system = messages.find((m) => m.role === 'system');
    const user = messages.find((m) => m.role === 'user');

    // 用户的 prompt 必须**原样**是用户说的话，不能掺进平台约束
    assert.equal(user?.content, '做一个自我介绍页');
    assert.doesNotMatch(user?.content ?? '', /硬性要求/, '用户消息里不应出现平台约束');

    // 约束必须在 system 消息里
    assert.match(system?.content ?? '', /硬性要求/);
    assert.match(system?.content ?? '', /不要包含 <script>/);
  } finally {
    await t.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 导出保证 charset
// ---------------------------------------------------------------------------

test('ensureCharset：已有声明就原样返回，没有就插到最靠前的位置', () => {
  // 已有 → 一个字节都不动
  const has = '<html><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>';
  assert.equal(ensureCharset(has), has, '已有 charset 时不应改动');
  assert.equal(ensureCharset('<meta CHARSET=utf-8>'), '<meta CHARSET=utf-8>', '大小写与无引号写法都要认');

  // 没有 head → 插在 <html> 之后
  const out1 = ensureCharset('<html lang="zh"><body><p>中文内容</p></body></html>');
  assert.match(out1, /<html lang="zh"><meta charset="utf-8">/);

  // 有 head → 插在 <head> 之后（最靠前，浏览器一读到就生效）
  const out2 = ensureCharset('<html><head><title>中文标题</title></head><body>中文</body></html>');
  assert.match(out2, /<head><meta charset="utf-8"><title>/);

  // 带属性的 head 也要认
  const out3 = ensureCharset('<html><head lang="zh">t</head><body>x</body></html>');
  assert.match(out3, /<head lang="zh"><meta charset="utf-8">/);

  // 任何输入都不抛错
  assert.equal(ensureCharset(''), '<meta charset="utf-8">');
  assert.match(ensureCharset('随便一段文字'), /^<meta charset="utf-8">/);
});

test('下载的自定义页面一定带 charset（下载后 file:// 打开不乱码）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'charset@example.com');
    const project = await newCustomProject(t, u.cookie, '编码测试');

    // 刻意保存一份**没有** charset 的页面（校验门允许，模型也常忘）
    const noCharset = '<!doctype html><html lang="zh-CN"><head><title>中文标题</title><style>body{padding:20px}</style></head><body><h1>你好，世界</h1><p>这是一段中文内容。</p></body></html>';
    const saved = await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie }, payload: { spec: { title: '中文标题', html: noCharset } },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    // 库里存的仍是用户/模型给的原样（不改存储内容）
    const stored = t.harness.ctx.db
      .prepare('SELECT spec_json FROM projects WHERE id = ?').get(project.id) as { spec_json: string };
    assert.doesNotMatch(JSON.parse(stored.spec_json).html, /charset/i, '存储内容不应被改写');

    // 下载时才补 —— 补的是「交付物」，不是「数据」
    const dl = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${project.id}/export`, headers: { cookie: u.cookie },
    });
    assert.equal(dl.statusCode, 200);
    assert.match(dl.body, /<meta charset="utf-8">/, '下载的文件必须自带 charset');
    assert.ok(dl.body.includes('你好，世界'));
    // 位置要在 title 之前，浏览器读到 head 就生效
    assert.ok(
      dl.body.indexOf('charset') < dl.body.indexOf('<title>'),
      'charset 应在 <title> 之前',
    );

    // 已经带 charset 的页面下载后不应出现两个声明
    await t.app.inject({
      method: 'PATCH', url: `/api/platform/projects/${project.id}`,
      headers: { cookie: u.cookie },
      payload: { spec: { html: noCharset.replace('<head>', '<head><meta charset="utf-8">') } },
    });
    const dl2 = await t.app.inject({
      method: 'GET', url: `/api/platform/projects/${project.id}/export`, headers: { cookie: u.cookie },
    });
    assert.equal((dl2.body.match(/charset=/gi) ?? []).length, 1, '不应重复插入 charset');
  } finally {
    await t.dispose();
  }
});

test('自定义页面只回了标题、没回 html 时算失败，不能报成功', async () => {
  // 实测发现的场景：Mock provider 只按「键: 值」抽取，不理解页面生成的提示词模板，
  // 于是它只返回一个 title。如果这算「成功」，用户会看到「已应用 1 个字段」
  // 然后对着一个空页面发呆 —— 他以为自己成功了。
  const upstream = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: '只有一个标题' }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;

  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'nopage@example.com');
    const project = await newCustomProject(t, u.cookie, '没产出页面');
    const userId = (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?')
      .get('nopage@example.com') as { id: string }).id;

    const result = await runAiTask(t.harness.ctx, await makeProvider(`http://127.0.0.1:${port}/v1`), userId, {
      projectId: project.id, kind: 'generate', prompt: '做一个介绍页', taskId: 'nopage-1',
    });

    assert.equal(result.ok, false, '没产出页面时不应报成功');
    if (!result.ok) {
      assert.equal(result.code, 'no_page_output');
      // 提示要给出下一步，而不是干巴巴一句「失败了」
      assert.match(result.message, /再点一次|更具体/, '要给出可操作的下一步');
    }

    // 任务记 failed 且不扣额度
    const row = t.harness.ctx.db
      .prepare('SELECT status, failure_reason FROM ai_usage WHERE task_id = ?')
      .get('nopage-1') as { status: string; failure_reason: string };
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason, /没有生成出页面内容/);

    const quota = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);
    assert.equal(quota.tokens.used, 0, '没产出页面的调用不应扣额度');
    assert.equal(quota.generations.used, 0);

    // 项目里没有写入任何内容
    const stored = t.harness.ctx.db
      .prepare('SELECT spec_json FROM projects WHERE id = ?').get(project.id) as { spec_json: string };
    assert.equal(JSON.parse(stored.spec_json).html, undefined);
  } finally {
    await t.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('空补丁不算成功 —— 对任何插件都成立，不只是自定义页面', async () => {
  // 上游回 200 但补丁是空的：如果当作成功，用户看到「已应用 0 个字段」、
  // 额度被扣、项目毫无变化 —— 系统告诉他成功了，而什么都没发生。
  const upstream = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 80, completion_tokens: 2, total_tokens: 82 },
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;

  const t = await createTestApp();
  try {
    // 用**房源插件**（模式 A）验证 —— 上一阶段的防护只做在 custom-page 上，
    // 这条要证明它对模式 A 同样成立。
    const u = await registerUser(t, 'emptypatch@example.com');
    const res = await t.app.inject({
      method: 'POST', url: '/api/platform/projects', headers: { cookie: u.cookie },
      payload: { pluginId: 'listing', title: '空补丁项目' },
    });
    const project = JSON.parse(res.body).project;
    const userId = (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?')
      .get('emptypatch@example.com') as { id: string }).id;

    const result = await runAiTask(t.harness.ctx, await makeProvider(`http://127.0.0.1:${port}/v1`), userId, {
      projectId: project.id, kind: 'generate', prompt: 'title: 随便写点什么', taskId: 'empty-1',
    });

    assert.equal(result.ok, false, '空补丁不应报成功');
    if (!result.ok) {
      assert.equal(result.code, 'empty_patch');
      assert.match(result.message, /再点一次|更具体/, '要给出可操作的下一步');
    }

    const row = t.harness.ctx.db
      .prepare('SELECT status, failure_reason FROM ai_usage WHERE task_id = ?')
      .get('empty-1') as { status: string; failure_reason: string };
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason, /空补丁/);

    // 额度完全没动
    const quota = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);
    assert.equal(quota.tokens.used, 0, '空补丁不应扣额度');
    assert.equal(quota.generations.used, 0);

    // 项目内容没被改动
    const after = t.harness.ctx.db
      .prepare('SELECT spec_json FROM projects WHERE id = ?').get(project.id) as { spec_json: string };
    assert.equal(JSON.parse(after.spec_json).title, undefined, '空补丁不应写入任何字段');
  } finally {
    await t.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

// ===========================================================================
// AI 链路的失败重试（**本地假上游，不调用任何付费服务**）
//
// 判据是「有没有可能已经产生了输出」，不是「错得严不严重」：
// 重试要花钱，若上游已经生成并计费，重试就是再花一次。
// ===========================================================================

test('重试：连接失败（一定没生成）会重试，且只结算一次', async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits += 1;
    if (hits === 1) {
      // 第一次直接断开 —— 连接没建起来，确定没产生生成结果
      res.destroy();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ title: '重试成功的标题' }) } }],
      usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;

  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'retry-a@example.com');
    const made = await createListingProject(t, u.cookie, '重试项目');
    const userId = (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?')
      .get('retry-a@example.com') as { id: string }).id;

    const result = await runAiTask(t.harness.ctx, await makeProvider(`http://127.0.0.1:${port}/v1`), userId, {
      projectId: made.project.id, kind: 'generate', prompt: 'title: 重试成功的标题', taskId: 'retry-1',
    });

    assert.equal(result.ok, true, `连接失败应重试并成功：${JSON.stringify(result).slice(0, 200)}`);
    assert.equal(hits, 2, '应正好请求两次（首次失败 + 一次重试）');

    // 只结算一次、只扣一次额度
    const rows = t.harness.ctx.db
      .prepare('SELECT status, total_tokens FROM ai_usage WHERE task_id = ?').all('retry-1') as { status: string; total_tokens: number }[];
    assert.equal(rows.length, 1, '同一任务只应有一条台账记录（防重复扣费）');
    assert.equal(rows[0]!.status, 'succeeded');
    assert.equal(rows[0]!.total_tokens, 50, '只应记入成功那一次的用量');
  } finally {
    await t.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('重试：上游超时**不**重试（可能已经生成并计费）', async () => {
  let hits = 0;
  const upstream = createServer((_req, _res) => {
    hits += 1;
    // 永不响应 —— 触发超时
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = (upstream.address() as AddressInfo).port;

  const t = await createTestApp();
  try {
    const u = await paidUser(t, 'retry-b@example.com');
    const made = await createListingProject(t, u.cookie, '超时不重试');
    const userId = (t.harness.ctx.db.prepare('SELECT id FROM users WHERE email = ?')
      .get('retry-b@example.com') as { id: string }).id;

    const result = await runAiTask(t.harness.ctx, await makeProviderWithTimeout(`http://127.0.0.1:${port}/v1`, 400), userId, {
      projectId: made.project.id, kind: 'generate', prompt: 'title: x', taskId: 'retry-2',
    });

    assert.equal(result.ok, false);
    assert.equal(hits, 1, '超时只应请求一次 —— 重试可能让上游再生成一次，那是白花钱');
    if (!result.ok) assert.match(result.message, /AI 服务暂时不可用/);
  } finally {
    await t.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});