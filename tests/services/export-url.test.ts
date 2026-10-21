/**
 * 导出资源引用改写测试。
 *
 * 【缺陷背景】
 * 原先导出只有 `html.replaceAll('/media/', 'assets/')`。它不认 URL 边界，
 * 把 `http://host:3210/media/a.png` 变成 `http://host:3210assets/a.png` —— 缺斜杠，
 * 任何环境都解析不了。og:image 正是这种绝对 URL。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaOrigins, rewriteMediaReferences } from '../../src/services/export-url.ts';

const ORIGINS = ['http://127.0.0.1:3210'];
const KEYS = new Set(['prp_a/cover.png', 'prp_a/room 2.png']);

function rewrite(html: string) {
  return rewriteMediaReferences(html, { origins: ORIGINS, exportedKeys: KEYS });
}

test('场景A：完整 URL 不再被替换成畸形地址', () => {
  const html = '<meta property="og:image" content="http://127.0.0.1:3210/media/prp_a/cover.png">';
  const r = rewrite(html);

  // 核心断言：绝不能出现 host:portassets 这种缺斜杠的地址
  assert.doesNotMatch(r.html, /3210assets/, '不得产生 host:portassets 畸形 URL');
  assert.doesNotMatch(r.html, /:\d+assets/, '不得出现端口后直接跟 assets 的形式');
  assert.match(r.html, /content="assets\/prp_a\/cover\.png"/, '应改写为相对路径');
  assert.equal(r.rewritten, 1);
  assert.deepEqual(r.missing, []);
});

test('场景A2：旧实现会产出的畸形串，现在不会出现', () => {
  // 直接用旧逻辑复现一次，确保我们断言的是真实的旧缺陷形状
  const html = 'http://127.0.0.1:3210/media/prp_a/cover.png';
  const oldWay = html.replaceAll('/media/', 'assets/');
  assert.equal(oldWay, 'http://127.0.0.1:3210assets/prp_a/cover.png', '旧逻辑确实产生畸形 URL');

  const newWay = rewrite(html).html;
  assert.doesNotMatch(newWay, /3210assets/);
  assert.equal(newWay, 'assets/prp_a/cover.png');
});

test('场景B：站内 /media/ 相对路径改写为 assets/', () => {
  const html = '<img src="/media/prp_a/cover.png" alt="封面">';
  const r = rewrite(html);
  assert.match(r.html, /src="assets\/prp_a\/cover\.png"/);
  assert.equal(r.rewritten, 1);
});

test('场景C：查询串与片段原样保留，不被误改', () => {
  const html = '<img src="/media/prp_a/cover.png?v=2#frag">';
  const r = rewrite(html);
  assert.match(r.html, /src="assets\/prp_a\/cover\.png\?v=2#frag"/, '查询串与片段应保留');
});

test('场景C2：URL 编码的空格保持可解析', () => {
  const html = '<img src="/media/prp_a/room%202.png">';
  const r = rewrite(html);
  // 解码后是 'prp_a/room 2.png'，在导出包内 → 改写且保留编码形式
  assert.match(r.html, /src="assets\/prp_a\/room%202\.png"/);
  assert.equal(r.rewritten, 1);
});

test('场景C3：不相干的文本与其它路径不受影响', () => {
  const html = [
    '<p>这段话提到 /media/ 这个词，但不是资源引用</p>',
    '<a href="/p/some-slug">原文链接</a>',
    '<img src="https://cdn.example.com/logo.png">',
    '<img src="data:image/png;base64,iVBORw0KGgo=">',
    '<link rel="icon" href="data:image/svg+xml,<svg/>">',
  ].join('\n');
  const r = rewrite(html);
  assert.equal(r.rewritten, 0, '不应改写任何引用');
  assert.equal(r.html, html, '内容应原样返回');
});

test('场景C4：外部站点的绝对 URL 保持原样（不把外部主机拼进本地路径）', () => {
  const html = '<img src="https://cdn.example.com/media/prp_a/cover.png">';
  const r = rewrite(html);
  assert.equal(r.html, html, '外部主机的资源应原样保留');
  assert.equal(r.rewritten, 0);
  assert.doesNotMatch(r.html, /assets\//, '不得改写成导出包内的相对路径');
});

test('场景D：协议相对 URL —— 本站的改写，外站的保留', () => {
  const ours = rewrite('<img src="//127.0.0.1:3210/media/prp_a/cover.png">');
  assert.match(ours.html, /src="assets\/prp_a\/cover\.png"/);
  assert.equal(ours.rewritten, 1);

  const theirs = '<img src="//cdn.example.com/media/prp_a/cover.png">';
  const foreign = rewrite(theirs);
  assert.equal(foreign.html, theirs, '外站协议相对 URL 应保留');
  assert.equal(foreign.rewritten, 0);
});

test('未打包的资源：保持原样并记入 missing，不生成看似有效的地址', () => {
  const html = '<img src="/media/prp_a/missing.png">';
  const r = rewrite(html);
  assert.equal(r.html, html, '不应改写成指向不存在文件的 assets/ 路径');
  assert.equal(r.rewritten, 0);
  assert.deepEqual(r.missing, ['prp_a/missing.png'], '应报告未打包的资源');
});

test('多个引用混合时各自处理正确', () => {
  const html = [
    '<img src="/media/prp_a/cover.png">',
    '<meta property="og:image" content="http://127.0.0.1:3210/media/prp_a/cover.png">',
    '<img src="https://cdn.example.com/x.png">',
    '<img src="/media/prp_a/missing.png">',
  ].join('\n');
  const r = rewrite(html);
  assert.equal(r.rewritten, 2, '应改写两个本站引用');
  assert.deepEqual(r.missing, ['prp_a/missing.png']);
  assert.ok(!r.html.includes('3210assets'));
  assert.ok(r.html.includes('https://cdn.example.com/x.png'), '外部资源应保留');
});

test('非法百分号编码不猜，按未打包资源处理', () => {
  const html = '<img src="/media/prp_a/%E0%A4%A.png">';
  const r = rewrite(html);
  assert.equal(r.rewritten, 0);
  assert.equal(r.html, html);
});

test('mediaOrigins 只收集合法 origin，忽略空值与非法值', () => {
  assert.deepEqual(mediaOrigins('http://127.0.0.1:3210/p/x', undefined, '', 'not a url'), [
    'http://127.0.0.1:3210',
  ]);
});