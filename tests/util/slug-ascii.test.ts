/**
 * 短链风格测试。
 *
 * 【为什么这项工作最后做成了「可配置」而不是直接改默认】
 * 保留 Unicode 是原项目里**写明了理由**的决定（见 util/slug.ts 的注释：
 * 「中文/日文等标题不会被清空」），而且既有页面已经用了中文短链、
 * 那些链接可能已经分享出去。单方面改默认会动到别人已经在用的地址。
 * 所以默认保持原样，需要 ASCII 的部署者用 SLUG_STYLE=ascii 打开。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asciiSlugSeed, slugify, slugifyAscii } from '../../src/util/slug.ts';

const CHINESE = '浦东新区精装两居室 · 近地铁 2 号线';
const ENGLISH = 'Sunny Two Bedroom Apartment';

test('slugifyAscii 只产出 ASCII，中文标题不会变成百分号编码', () => {
  const slug = slugifyAscii(CHINESE);
  // 关键断言：整个短链里不能有任何非 ASCII 字符
  assert.match(slug, /^[\x20-\x7e]*$/, `不应含非 ASCII 字符：${slug}`);
  assert.doesNotMatch(slug, /%/, '不应含百分号');
});

test('asciiSlugSeed 对纯中文标题给出可用的短标识，而不是空串', () => {
  const seed = asciiSlugSeed(CHINESE);
  assert.ok(seed.length >= 2, '不能是空串或过短');
  assert.match(seed, /^[a-z0-9-]+$/, '应只含小写字母、数字与连字符');
  // 纯中文时走兜底前缀
  assert.match(seed, /^page-/, '纯中文标题应走 page- 兜底');

  // 空标题、纯符号、纯 emoji 都不能产出空串
  for (const weird of ['', '   ', '···', '🎉🎉', '？？？']) {
    const s = asciiSlugSeed(weird);
    assert.ok(s.length >= 2, `「${weird}」不应产出过短的 slug：${s}`);
    assert.match(s, /^[a-z0-9-]+$/);
  }
});

test('纯英文标题在两种风格下结果一致（ascii 模式不损失可读性）', () => {
  assert.equal(slugifyAscii(ENGLISH), 'sunny-two-bedroom-apartment');
  assert.equal(asciiSlugSeed(ENGLISH), 'sunny-two-bedroom-apartment');
  // 与既有的 slugify 也一致 —— 说明 ascii 模式对英文标题没有任何行为变化
  assert.equal(slugify(ENGLISH), asciiSlugSeed(ENGLISH));
});

test('默认（unicode）行为完全没变 —— 既有中文短链不会被改写', () => {
  // 这条守的是「不擅自改变既有行为」：既有房源展示页的短链就是中文，
  // 那些链接可能已经分享出去过。
  assert.equal(slugify(CHINESE), '浦东新区精装两居室-近地铁-2-号线');
});

test('slugifyAscii 对英文数字混排、长标题的处理', () => {
  // 数字与英文混排保留
  assert.equal(slugifyAscii('Room 2B near Line 2'), 'room-2b-near-line-2');
  // 首尾与连续分隔符折叠
  assert.equal(slugifyAscii('  --Hello---World--  '), 'hello-world');
  // 超长标题被截断且不以连字符结尾
  const long = slugifyAscii('a'.repeat(200));
  assert.ok(long.length <= 60);
  assert.doesNotMatch(long, /-$/);
});