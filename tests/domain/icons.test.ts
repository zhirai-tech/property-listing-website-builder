/**
 * 图标与「禁止表情符号」的回归测试。
 *
 * 背景：界面一度用表情符号（房子、电话、链接等）充当图标。这类字符在不同系统上的
 * 字形差异很大、无法随主题着色、也不能保证商用字形一致，因此全站改为自研
 * 内联 SVG 图标（`src/render/icons.ts` 与 `public/admin/icons.js`）。
 *
 * 这里加两道防线：
 *  1. 两份图标实现必须完全一致（避免服务端与前端各改一半）；
 *  2. 界面源码里不得再出现表情符号。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ICON_PATHS, icon } from '../../src/render/icons.ts';
// 后台图标模块是纯浏览器 JS，没有类型声明文件
// @ts-expect-error 运行时由 Node 直接以 ESM 加载
import { ICON_PATHS as ADMIN_PATHS } from '../../public/admin/icons.js';

test('服务端与后台的图标路径数据完全一致', () => {
  const serverKeys = Object.keys(ICON_PATHS).sort();
  const adminKeys = Object.keys(ADMIN_PATHS).sort();

  assert.deepEqual(adminKeys, serverKeys, '两份实现的图标名必须一致');

  for (const key of serverKeys) {
    assert.equal(
      ADMIN_PATHS[key as keyof typeof ADMIN_PATHS],
      ICON_PATHS[key as keyof typeof ICON_PATHS],
      `图标 ${key} 的路径数据在两份实现中不一致`,
    );
  }
});

test('每个图标都只使用基础几何元素，不含外部引用', () => {
  for (const [name, markup] of Object.entries(ICON_PATHS)) {
    assert.ok(markup.length > 0, `${name} 不应为空`);
    assert.ok(!/<image|href=|xlink|url\(/i.test(markup), `${name} 不应引用外部资源`);
    assert.ok(!/<script/i.test(markup), `${name} 不应包含脚本`);
  }
});

test('生成的 SVG 使用 currentColor 描边，可跟随文字颜色', () => {
  const svg = icon('home');
  assert.ok(svg.startsWith('<svg'), '应输出 svg 元素');
  assert.ok(svg.includes('stroke="currentColor"'), '描边应跟随文字颜色');
  assert.ok(svg.includes('fill="none"'), '应为纯描边图标');
  assert.ok(svg.includes('viewBox="0 0 24 24"'), '应使用统一的 24x24 视图框');
});

test('默认作为装饰性图标（旁边已有文字标签），提供 title 时才暴露可访问名称', () => {
  assert.ok(icon('phone').includes('aria-hidden="true"'), '默认应 aria-hidden');
  const named = icon('phone', { title: '打电话' });
  assert.ok(named.includes('role="img"'), '提供 title 时应为 role=img');
  assert.ok(named.includes('aria-label="打电话"'), '应带 aria-label');
});

test('可访问名称中的特殊字符会被转义，不会破坏标签', () => {
  const svg = icon('map', { title: '地图 "><script>alert(1)</script>' });
  assert.ok(!svg.includes('<script>'), '不应注入脚本标签');
  assert.ok(svg.includes('&quot;'), '双引号应被转义');
});

test('界面源码中不得再出现表情符号', () => {
  // 覆盖用户可见的界面源码：展示页渲染、模板样式、后台外壳与视图
  const files = [
    'src/render/page-renderer.ts',
    'src/render/templates.ts',
    'src/render/icons.ts',
    'src/domain/i18n.ts',
    'public/admin/index.html',
    'public/admin/app.js',
    'public/admin/icons.js',
    'public/admin/styles.css',
    'public/admin/views/properties.js',
    'public/admin/views/property-edit.js',
    'public/admin/views/pages.js',
    'public/admin/views/reminders.js',
    'public/admin/views/settings.js',
    'public/admin/views/backup.js',
  ];

  // 只拦截表情符号、杂项符号与变体选择符。
  // 刻意不含箭头（U+2190–U+21FF）等排版字符：→ 在流程描述里是正常标点，不是图标。
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2705}\u{274C}]/u;

  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, index) => {
      const found = [...new Set([...line].filter((ch) => EMOJI.test(ch)))];
      if (found.length > 0) {
        offenders.push(`${file}:${index + 1} 含 ${found.join(' ')}`);
      }
    });
  }

  assert.deepEqual(offenders, [], '界面源码不应包含表情符号，请改用 src/render/icons.ts 中的自研图标');
});

/**
 * 品牌图标（ZR 标）回归测试。
 *
 * 站点 favicon 一度是一个自绘的通用房子 SVG，与品牌无关。
 * 现在统一使用品牌方提供的 ZR 图标（E:\images\logo\profile\32x32.png），
 * 以 data URI 内联，保证联网与离线导出两种场景都能显示。
 */
test('展示页与后台的 favicon 使用品牌 ZR 图标，而不是通用占位图', () => {
  const pageRenderer = readFileSync('src/render/page-renderer.ts', 'utf8');
  const adminShell = readFileSync('public/admin/index.html', 'utf8');

  for (const [name, text] of [
    ['展示页渲染器', pageRenderer],
    ['后台外壳', adminShell],
  ] as const) {
    const match = /<link rel="icon"[^>]*>/.exec(text);
    assert.ok(match, `${name} 应有 favicon 声明`);
    const tag = match[0];

    assert.ok(tag.includes('type="image/png"'), `${name} 的 favicon 应为 PNG`);
    assert.ok(tag.includes('sizes="32x32"'), `${name} 的 favicon 应声明 32x32`);
    assert.ok(
      tag.includes('data:image/png;base64,'),
      `${name} 的 favicon 应内联为 data URI（离线导出也要能显示）`,
    );
    assert.ok(
      !tag.includes('image/svg+xml'),
      `${name} 不应再使用原先自绘的 SVG 占位图标`,
    );
  }
});

test('内联的 favicon 确实是一张 32x32 的 PNG', () => {
  const adminShell = readFileSync('public/admin/index.html', 'utf8');
  const base64 = /href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(adminShell)?.[1];
  assert.ok(base64, '应能取出 base64 数据');

  const bytes = Buffer.from(base64, 'base64');
  assert.equal(bytes[0], 0x89, 'PNG 魔数第 1 字节');
  assert.equal(bytes.toString('latin1', 1, 4), 'PNG', 'PNG 魔数');

  // IHDR：紧随 8 字节签名 + 4 字节长度 + 4 字节类型之后
  assert.equal(bytes.readUInt32BE(16), 32, '宽度应为 32');
  assert.equal(bytes.readUInt32BE(20), 32, '高度应为 32');
});