/**
 * AI 生成页面的安全校验门测试。
 *
 * 【这个文件的定位】它是模式 B 的安全边界，所以测试是**对抗性**的：
 * 每一条都在尝试绕过校验，而不是确认「正常页面能过」。
 *
 * 校验门的原则是**宁可误拒，不可放过**：
 * 拒绝一个本来无害的页面只是体验问题；
 * 放行一个能执行脚本的页面，就等于把平台数据交给了模型输出。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_GENERATED_PAGE_BYTES,
  describePageIssues,
  validateGeneratedPage,
} from '../../src/domain/page-safety.ts';

/** 一个最小但合法的页面 */
const GOOD = `<!doctype html>
<html lang="zh-CN"><head><title>我的介绍页</title>
<style>body{font-family:sans-serif;margin:0;padding:24px;color:#0f172a}</style>
</head><body><h1>你好，我是一名开发者</h1><p>这里是一段介绍文字。</p></body></html>`;

const rulesOf = (r: ReturnType<typeof validateGeneratedPage>): string[] =>
  r.ok ? [] : r.issues.map((i) => i.rule);

test('合法页面通过校验', () => {
  const r = validateGeneratedPage(GOOD);
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.issues));
  if (r.ok) assert.equal(r.html, GOOD.trim());
});

test('允许内联样式与 https 图片（生成页面要能好看）', () => {
  const html = GOOD.replace(
    '<p>这里是一段介绍文字。</p>',
    '<p>介绍</p><img src="https://cdn.example.com/me.png" alt="我">',
  );
  const r = validateGeneratedPage(html);
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.issues));
});

test('允许 data:image 内联图片，但禁止其它 data: 地址', () => {
  const okImg = GOOD.replace(
    '<p>这里是一段介绍文字。</p>',
    '<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">',
  );
  assert.equal(validateGeneratedPage(okImg).ok, true);

  // data:text/html 是经典的「用一个 data URL 承载一整个可执行文档」手法
  const evil = GOOD.replace('</body>', '<a href="data:text/html;base64,PHNjcmlwdD4=">点我</a></body>');
  const r = validateGeneratedPage(evil);
  assert.equal(r.ok, false);
  assert.ok(rulesOf(r).includes('unsafe_data_url'), JSON.stringify(rulesOf(r)));
});

test('拒绝任何形式的 <script>（含大小写、空格、SVG 内嵌）', () => {
  const attempts = [
    GOOD.replace('</body>', '<script>alert(1)</script></body>'),
    GOOD.replace('</body>', '<SCRIPT>alert(1)</SCRIPT></body>'),
    GOOD.replace('</body>', '< script >alert(1)</ script ></body>'),
    GOOD.replace('</body>', '<script\n src="https://evil.example.com/x.js"></script></body>'),
    // SVG 内嵌 script 是绕过「只过滤 script 标签」的经典手法
    GOOD.replace('</body>', '<svg><script>alert(1)</script></svg></body>'),
  ];
  for (const [i, html] of attempts.entries()) {
    const r = validateGeneratedPage(html);
    assert.equal(r.ok, false, `第 ${i + 1} 种 script 形式必须被拒`);
  }
});

test('拒绝事件处理器属性', () => {
  for (const attr of ['onclick="x()"', 'onerror="x()"', 'ONLOAD = "x()"', 'onmouseover=x()']) {
    const html = GOOD.replace('<h1>', `<h1 ${attr}>`);
    const r = validateGeneratedPage(html);
    assert.equal(r.ok, false, `${attr} 必须被拒`);
    assert.ok(rulesOf(r).includes('event_handler'), attr);
  }
});

test('拒绝 javascript: 协议', () => {
  const html = GOOD.replace('</body>', '<a href="javascript:alert(1)">x</a></body>');
  const r = validateGeneratedPage(html);
  assert.equal(r.ok, false);
  assert.ok(rulesOf(r).includes('dangerous_url'));
});

test('拒绝嵌套文档类标签（iframe / object / embed / base / form / meta / link）', () => {
  const injections: [string, string][] = [
    ['iframe', '<iframe src="https://evil.example.com"></iframe>'],
    ['object', '<object data="https://evil.example.com"></object>'],
    ['embed', '<embed src="https://evil.example.com">'],
    ['base', '<base href="https://evil.example.com/">'],
    ['form', '<form action="https://evil.example.com"><input name="x"></form>'],
    ['meta', '<meta http-equiv="refresh" content="0;url=https://evil.example.com">'],
    ['link', '<link rel="stylesheet" href="https://evil.example.com/x.css">'],
  ];
  for (const [tag, snippet] of injections) {
    // base / meta / link 属于 head，插到 head 里
    const html = ['base', 'meta', 'link'].includes(tag)
      ? GOOD.replace('</head>', `${snippet}</head>`)
      : GOOD.replace('</body>', `${snippet}</body>`);
    const r = validateGeneratedPage(html);
    assert.equal(r.ok, false, `<${tag}> 必须被拒`);
    // meta / link 已从「整类禁止」改为「按用途白名单」，规则名也随之变化
    const expected = tag === 'meta' ? 'meta_http_equiv' : tag === 'link' ? 'link_not_allowed' : `forbidden_tag:${tag}`;
    assert.ok(rulesOf(r).includes(expected), `${tag}: ${JSON.stringify(rulesOf(r))}`);
  }
});

test('拒绝样式里的外部引用（@import 与 url(http…)）', () => {
  const imp = GOOD.replace('<style>', '<style>@import url("https://evil.example.com/x.css");');
  const r1 = validateGeneratedPage(imp);
  assert.equal(r1.ok, false);
  assert.ok(rulesOf(r1).includes('css_import'));

  const bg = GOOD.replace('<style>', '<style>body{background:url(https://evil.example.com/x.png)}');
  const r2 = validateGeneratedPage(bg);
  assert.equal(r2.ok, false);
  assert.ok(rulesOf(r2).includes('css_external_url'));

  // data:image 的 url() 是允许的
  const okData = GOOD.replace('<style>', '<style>body{background:url(data:image/png;base64,iVBORw0KGgo=)}');
  assert.equal(validateGeneratedPage(okData).ok, true);
});

test('拒绝 http 明文资源与相对路径图片', () => {
  const http = GOOD.replace('</body>', '<img src="http://example.com/x.png" alt="x"></body>');
  const r1 = validateGeneratedPage(http);
  assert.equal(r1.ok, false);
  assert.ok(rulesOf(r1).includes('insecure_url'));

  // 相对路径指向的是我们不会一起打包的文件，下载后会变坏链
  const rel = GOOD.replace('</body>', '<img src="photo.png" alt="x"></body>');
  const r2 = validateGeneratedPage(rel);
  assert.equal(r2.ok, false);
  assert.ok(rulesOf(r2).includes('img_src_not_allowed'));
});

test('拒绝不是完整页面的片段', () => {
  assert.ok(rulesOf(validateGeneratedPage('<div>只有一段 div</div>')).includes('not_a_page'));
  // 有 html 但缺 body
  const noBody = '<html><head><title>t</title></head><h1>内容内容内容内容</h1></html>';
  assert.ok(rulesOf(validateGeneratedPage(noBody)).includes('not_a_page'));
});

test('拒绝缺少 title 与几乎没有文字的页面', () => {
  const noTitle = GOOD.replace(/<title>[^<]*<\/title>/, '');
  assert.ok(rulesOf(validateGeneratedPage(noTitle)).includes('no_title'));

  const emptyText = '<!doctype html><html><head><title>t</title></head><body><div></div></body></html>';
  assert.ok(rulesOf(validateGeneratedPage(emptyText)).includes('no_text_content'));
});

test('拒绝空结果、非字符串与超大结果', () => {
  assert.ok(rulesOf(validateGeneratedPage('')).includes('empty'));
  assert.ok(rulesOf(validateGeneratedPage('   \n  ')).includes('empty'));
  assert.ok(rulesOf(validateGeneratedPage(null)).includes('not_a_string'));
  assert.ok(rulesOf(validateGeneratedPage({ html: '<html></html>' })).includes('not_a_string'));
  assert.ok(rulesOf(validateGeneratedPage(123)).includes('not_a_string'));

  const huge = GOOD.replace('</body>', `<p>${'字'.repeat(MAX_GENERATED_PAGE_BYTES)}</p></body>`);
  assert.ok(rulesOf(validateGeneratedPage(huge)).includes('too_large'));
});

test('一次可以报出多个问题，便于用户一次改对', () => {
  const bad = '<html><body><script>x()</script><iframe src="https://e.com"></iframe></body></html>';
  const r = validateGeneratedPage(bad);
  assert.equal(r.ok, false);
  if (!r.ok) {
    const rules = r.issues.map((i) => i.rule);
    assert.ok(rules.includes('forbidden_tag:script'));
    assert.ok(rules.includes('forbidden_tag:iframe'));
    assert.ok(rules.includes('no_title'));
    assert.ok(rules.length >= 3);
  }
});

test('describePageIssues 给出可直接展示的中文说明', () => {
  const r = validateGeneratedPage('<html><body><script>x</script></body></html>');
  assert.equal(r.ok, false);
  if (!r.ok) {
    const text = describePageIssues(r.issues);
    assert.match(text, /没有通过安全检查/);
    // 面向用户的文案里不应出现规则名或英文标识符
    assert.doesNotMatch(text, /forbidden_tag|meta_not_allowed|onclick/i, '不应把规则名抛给用户');
    // 必须给出下一步该做什么，而不只是说明「哪里不对」
    assert.match(text, /再试一次|重试/);
    assert.ok(text.length > 10);
  }
  // 问题很多时会被截断，但要有「另有 N 项」的提示
  const many = describePageIssues([
    { rule: 'a', message: '一' }, { rule: 'b', message: '二' },
    { rule: 'c', message: '三' }, { rule: 'd', message: '四' },
  ]);
  assert.match(many, /另外还有 2 项/);
});

// ---------------------------------------------------------------------------
// 按用途放行（让模型正常的输出能通过）
// ---------------------------------------------------------------------------

test('允许 <meta charset> 与 <meta name="viewport">（下载后不乱码、手机上排版正常）', () => {
  // 这两项是模型几乎必然会加的，也正是它们让「整类禁止 meta」不可用
  const charset = GOOD.replace('<head>', '<head><meta charset="utf-8">');
  const r1 = validateGeneratedPage(charset);
  assert.equal(r1.ok, true, r1.ok ? '' : JSON.stringify(r1.issues));

  const viewport = GOOD.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">');
  assert.equal(validateGeneratedPage(viewport).ok, true);

  // 两种写法（单引号 / 无引号）都要认
  assert.equal(validateGeneratedPage(GOOD.replace('<head>', "<head><meta charset='utf-8'>")).ok, true);
  assert.equal(validateGeneratedPage(GOOD.replace('<head>', '<head><meta charset=utf-8>')).ok, true);
  // 大小写不敏感
  assert.equal(validateGeneratedPage(GOOD.replace('<head>', '<head><META CHARSET="UTF-8">')).ok, true);

  // 常见的其它无害 meta
  assert.equal(validateGeneratedPage(GOOD.replace('<head>', '<head><meta name="description" content="我的介绍页">')).ok, true);
});

test('仍然拒绝 http-equiv（可用于跳转或放宽页面策略）', () => {
  for (const tag of [
    '<meta http-equiv="refresh" content="0;url=https://evil.example.com">',
    '<meta http-equiv="Content-Security-Policy" content="default-src *">',
    '<meta HTTP-EQUIV="refresh" content="5">',
  ]) {
    const r = validateGeneratedPage(GOOD.replace('<head>', `<head>${tag}`));
    assert.equal(r.ok, false, `${tag} 必须被拒`);
    assert.ok(rulesOf(r).includes('meta_http_equiv'), JSON.stringify(rulesOf(r)));
  }
});

test('拒绝非 utf-8 的 charset（乱码页面对用户没有价值）', () => {
  const r = validateGeneratedPage(GOOD.replace('<head>', '<head><meta charset="gb2312">'));
  assert.equal(r.ok, false);
  assert.ok(rulesOf(r).includes('meta_not_allowed'));

  // 没有 charset 属性、也没有 name 的 meta 也不放行
  const weird = validateGeneratedPage(GOOD.replace('<head>', '<head><meta property="og:title" content="x">'));
  assert.equal(weird.ok, false);
});

test('link 只放行 data:image 的图标，样式表与预加载仍然拒绝', () => {
  const icon = GOOD.replace(
    '<head>',
    '<head><link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">',
  );
  assert.equal(validateGeneratedPage(icon).ok, true);

  for (const tag of [
    '<link rel="stylesheet" href="https://evil.example.com/x.css">',
    '<link rel="preload" href="https://evil.example.com/x.js" as="script">',
    '<link rel="prefetch" href="https://evil.example.com/x">',
    // icon 但指向外部地址 → 仍然拒绝（会产生外部请求）
    '<link rel="icon" href="https://evil.example.com/favicon.ico">',
    '<link rel="icon" href="/favicon.ico">',
  ]) {
    const r = validateGeneratedPage(GOOD.replace('<head>', `<head>${tag}`));
    assert.equal(r.ok, false, `${tag} 必须被拒`);
    assert.ok(rulesOf(r).includes('link_not_allowed'), `${tag}: ${JSON.stringify(rulesOf(r))}`);
  }
});

test('安全边界没有被这次放宽破坏：脚本与嵌套文档依然全拒', () => {
  // 放宽 meta/link 之后，重新确认最关键的几条还在
  const attempts = [
    GOOD.replace('<head>', '<head><meta charset="utf-8">').replace('</body>', '<script>x()</script></body>'),
    GOOD.replace('<head>', '<head><meta charset="utf-8">').replace('</body>', '<iframe src="https://e.com"></iframe></body>'),
    GOOD.replace('<head>', '<head><meta charset="utf-8">').replace('<h1>', '<h1 onclick="x()">'),
    GOOD.replace('<head>', '<head><meta charset="utf-8">').replace('</body>', '<a href="javascript:x()">x</a></body>'),
  ];
  for (const [i, html] of attempts.entries()) {
    assert.equal(validateGeneratedPage(html).ok, false, `第 ${i + 1} 种必须仍被拒`);
  }
});

// ---------------------------------------------------------------------------
// 失败提示必须「可操作」
// ---------------------------------------------------------------------------

test('失败提示给的是下一步该做什么，而不是规则名', () => {
  // 对平台的目标用户（房东、个体经营者）来说，「不允许使用 <meta http-equiv>」
  // 这类描述既不可理解也不可操作。提示必须告诉他该做什么。

  // 1) 含脚本：应说明「点重试」并点出平台不支持脚本这件事
  const script = validateGeneratedPage('<html><body><script>x()</script><p>文字内容内容</p></body></html>');
  assert.equal(script.ok, false);
  if (!script.ok) {
    const text = describePageIssues(script.issues);
    assert.match(text, /再试一次/, '要给出「重试」这个动作');
    assert.match(text, /不支持脚本/, '要说明平台确实不支持，避免用户反复重试');
  }

  // 2) 任何规则名都不应出现在面向用户的文案里
  const cases = [
    '<html><body><iframe src="https://e.com"></iframe><p>文字内容内容</p></body></html>',
    '<html><body><p>文字内容内容</p><a href="javascript:x()">x</a></body></html>',
    '<html><head><meta http-equiv="refresh" content="0"></head><body><p>文字内容内容</p></body></html>',
    '<html><head><link rel="stylesheet" href="https://e.com/x.css"></head><body><p>文字内容内容</p></body></html>',
    '<div>只是片段</div>',
    '<html><body><p>文字内容内容</p><img src="photo.png"></body></html>',
  ];
  const forbidden = /forbidden_tag|event_handler|dangerous_url|unsafe_data_url|meta_http_equiv|link_not_allowed|meta_not_allowed|css_import|css_external_url|insecure_url|img_src_not_allowed|not_a_page|no_title|no_text_content|too_large|not_a_string|empty/i;

  for (const html of cases) {
    const r = validateGeneratedPage(html);
    assert.equal(r.ok, false, `应被拒：${html.slice(0, 40)}`);
    if (r.ok) continue;
    const text = describePageIssues(r.issues);
    assert.doesNotMatch(text, forbidden, `文案里不应出现规则名：${text.slice(0, 80)}`);
    assert.doesNotMatch(text, /<[a-z]+>/i, `文案里不应出现 HTML 标签名：${text.slice(0, 80)}`);
    assert.ok(text.length > 15, '应有实际内容');
  }

  // 3) 说明里要明确「没有被扣额度」—— 这是用户最关心的一件事
  const r = validateGeneratedPage('<html><body><script>x()</script><p>文字内容内容</p></body></html>');
  if (!r.ok) assert.match(describePageIssues(r.issues), /没有消耗你的额度/);
});

test('描述太短导致的失败，提示应指向「描述」而不是「重试」', () => {
  // 「没有可见文字」这类问题多半是描述写得太少，让用户重试是没用的
  const r = validateGeneratedPage('<html><head><title>t</title></head><body><div></div></body></html>');
  assert.equal(r.ok, false);
  if (!r.ok) {
    const text = describePageIssues(r.issues);
    assert.match(text, /描述/, '应引导用户把描述写具体，而不是让他无脑重试');
    assert.doesNotMatch(text, /forbidden_tag|no_text_content/);
  }
});

test('提示文案里不残留 markdown 标记（界面是纯文本渲染）', () => {
  const r = validateGeneratedPage('<html><body><script>x()</script><p>文字内容内容</p></body></html>');
  if (!r.ok) {
    const text = describePageIssues(r.issues);
    assert.doesNotMatch(text, /\*\*/, '不应出现 markdown 加粗标记');
    assert.doesNotMatch(text, /（另有 \d+ 项问题）/, '不应残留旧版措辞');
  }
});