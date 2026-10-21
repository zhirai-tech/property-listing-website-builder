/**
 * 示例画廊测试。
 *
 * 【这里最重要的一条】示例必须**自己过得了校验门**。
 * 一个展示「平台能生成什么」的画廊，如果展示的页面平台自己都会拒绝，
 * 那它就是在误导用户。把示例放在代码里而不是静态文件里，
 * 就是为了让这条断言能成立。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_EXAMPLES, SAMPLE_DISCLAIMER, exampleSummaries, getPageExample } from '../../src/platform/examples.ts';
import { validateGeneratedPage } from '../../src/domain/page-safety.ts';
import { createTestApp, registerUser } from '../helpers/test-app.ts';

test('每个示例页面都能通过平台自己的安全校验门', () => {
  assert.ok(PAGE_EXAMPLES.length >= 3, '至少要有几个示例可看');
  for (const example of PAGE_EXAMPLES) {
    const result = validateGeneratedPage(example.html);
    assert.equal(
      result.ok,
      true,
      `示例「${example.name}」没通过校验门：${result.ok ? '' : JSON.stringify(result.issues)}`,
    );
  }
});

test('示例的元信息完整且可用于预填', () => {
  const ids = new Set<string>();
  for (const example of PAGE_EXAMPLES) {
    assert.ok(example.id.length > 0 && !ids.has(example.id), `id 重复或为空：${example.id}`);
    ids.add(example.id);
    assert.ok(example.name.length > 0);
    assert.ok(example.summary.length > 0);
    assert.ok(example.highlight.length > 0, '每个示例要说清它值得注意的地方');
    // 描述要够长、够具体 —— 太短的描述生成不出好结果
    assert.ok(example.prompt.length >= 20, `示例「${example.name}」的描述太短，起不到示范作用`);
    // 示例页面要有中文可见内容
    assert.match(example.html, /[\u4e00-\u9fa5]{6,}/, `示例「${example.name}」应有中文内容`);
  }
});

test('示例页面自带 charset 与 viewport（下载后不乱码、手机上看正常）', () => {
  for (const example of PAGE_EXAMPLES) {
    assert.match(example.html, /<meta charset="utf-8">/i, `示例「${example.name}」缺 charset`);
    assert.match(example.html, /<meta name="viewport"/i, `示例「${example.name}」缺 viewport`);
  }
});

test('示例页面不含任何脚本 —— 与平台规则一致', () => {
  for (const example of PAGE_EXAMPLES) {
    assert.doesNotMatch(example.html, /<script/i, `示例「${example.name}」含脚本`);
    assert.doesNotMatch(example.html, /\son[a-z]+\s*=/i, `示例「${example.name}」含事件属性`);
    assert.doesNotMatch(example.html, /\bhttp-equiv\s*=/i, `示例「${example.name}」含 http-equiv`);
  }
});

test('exampleSummaries 不返回页面内容，且带着诚实标注', () => {
  const { items, disclaimer } = exampleSummaries();
  // 标注必须存在且说清「示例是手工的」—— 这是产品诚实性的一部分
  assert.ok(disclaimer.length > 10);
  assert.match(disclaimer, /手工|不是模型生成/, '必须说清示例的来源');
  assert.match(disclaimer, /自己生成|实际效果/, '必须给出「自己试一次」的指引');
  assert.equal(items.length, PAGE_EXAMPLES.length);
  for (const item of items) {
    assert.equal(Object.hasOwn(item, 'html'), false, '列表项不应带 html');
  }
  // 完整的页面内容只在按 id 取时才有
  const first = PAGE_EXAMPLES[0]!;
  assert.equal(getPageExample(first.id)?.html, first.html);
  assert.equal(getPageExample('does-not-exist'), null);
});

test('画廊接口：未登录不可见，登录后能列出与预览', async () => {
  const t = await createTestApp();
  try {
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/platform/examples' })).statusCode, 401);
    assert.equal(
      (await t.app.inject({ method: 'GET', url: `/api/platform/examples/${PAGE_EXAMPLES[0]!.id}/preview` })).statusCode,
      401,
    );

    const u = await registerUser(t, 'gallery@example.com');
    const list = await t.app.inject({
      method: 'GET', url: '/api/platform/examples', headers: { cookie: u.cookie },
    });
    assert.equal(list.statusCode, 200);
    const items = JSON.parse(list.body).items;
    assert.equal(items.length, PAGE_EXAMPLES.length);
    assert.ok(items[0].prompt.length > 0, '列表要带上可直接用的描述');

    // 预览：与自定义页面同一套严格 CSP
    const preview = await t.app.inject({
      method: 'GET', url: `/api/platform/examples/${PAGE_EXAMPLES[0]!.id}/preview`, headers: { cookie: u.cookie },
    });
    assert.equal(preview.statusCode, 200);
    assert.match(String(preview.headers['content-type']), /text\/html/);
    const csp = String(preview.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.equal(preview.headers['x-content-type-options'], 'nosniff');
    assert.equal(preview.headers['x-robots-tag'], 'noindex');

    // 不存在的示例 → 404（而不是 500 或空白页）
    const missing = await t.app.inject({
      method: 'GET', url: '/api/platform/examples/nope/preview', headers: { cookie: u.cookie },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await t.dispose();
  }
});

test('画廊不消耗额度（示例是静态内容，不调用 AI）', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'gallery-free@example.com');
    const before = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);

    for (const example of PAGE_EXAMPLES) {
      await t.app.inject({
        method: 'GET', url: `/api/platform/examples/${example.id}/preview`, headers: { cookie: u.cookie },
      });
    }
    const after = JSON.parse((await t.app.inject({
      method: 'GET', url: '/api/platform/quota', headers: { cookie: u.cookie },
    })).body);

    assert.equal(after.tokens.used, before.tokens.used, '看示例不应消耗 Token');
    assert.equal(after.generations.used, before.generations.used, '看示例不应消耗生成次数');

    // 台账里也不该多出任务
    const rows = t.harness.ctx.db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get() as { n: number };
    assert.equal(rows.n, 0, '看示例不应产生任何 AI 任务记录');
  } finally {
    await t.dispose();
  }
});

test('画廊接口带出诚实标注，且标注说明了示例的真实来源', async () => {
  const t = await createTestApp();
  try {
    const u = await registerUser(t, 'disclaimer@example.com');
    const list = await t.app.inject({
      method: 'GET', url: '/api/platform/examples', headers: { cookie: u.cookie },
    });
    const body = JSON.parse(list.body);

    assert.ok(typeof body.disclaimer === 'string' && body.disclaimer.length > 10, '接口必须带出标注');
    // 标注必须回答两件事：示例是什么、我该怎么做
    assert.match(body.disclaimer, /手工|不是模型生成/, '要说清示例不是模型生成的');
    assert.match(body.disclaimer, /自己生成|实际效果/, '要给出「自己试一次」的指引');
    // 不能出现「保证」「一定能」这类过度承诺
    assert.doesNotMatch(body.disclaimer, /保证|一定能|必然/, '不应出现过度承诺');
    assert.ok(Array.isArray(body.items), 'items 仍是数组');
  } finally {
    await t.dispose();
  }
});

test('标注只在接口一处定义（前端不写死），便于将来示例改成真实产出', () => {
  // 这条是防止「标注被写死在前端」导致两处不一致
  assert.equal(typeof SAMPLE_DISCLAIMER, 'string');
  assert.equal(exampleSummaries().disclaimer, SAMPLE_DISCLAIMER, '接口必须用同一个常量');
});