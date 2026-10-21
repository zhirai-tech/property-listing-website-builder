/**
 * 发布前内容校验（纯函数）单元测试。
 *
 * 【为什么与集成测试并存】
 * 集成测试走真实 API，但有一条分支从接口进不去：
 * **房源项目的 spec 里没有 propertyId** —— `saveDraft` 会保留结构性键，
 * 保存部分字段不会把项目与房源解绑（这是正确行为）。
 * 那条分支只能直接调用校验函数来覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  customPagePublishCheck,
  customPagePluginManifest,
} from '../../src/platform/plugins/custom-page-plugin.ts';
import { listingPublishCheck, listingPluginManifest } from '../../src/platform/plugins/listing-plugin.ts';
import { publishCheckFor } from '../../src/platform/plugins/registry.ts';

const VALID_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>有效页面</title></head>' +
  '<body><h1>有效页面</h1><p>这是一段足够长的正文内容，用于通过内容质量检查。</p></body></html>';

test('custom-page：空对象、缺 html、空串、纯空白都要拒绝', () => {
  for (const spec of [{}, { title: '只有标题' }, { html: '' }, { html: '   \n  ' }, { html: 123 }]) {
    const r = customPagePublishCheck(spec as Record<string, unknown>);
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(spec)}`);
    if (!r.ok) {
      assert.ok(r.message.length > 0, '必须给出可读原因');
      assert.match(r.message, /还没有内容|无法发布/);
    }
  }
});

test('custom-page：有效内容通过', () => {
  const r = customPagePublishCheck({ title: '有效页面', html: VALID_HTML });
  assert.equal(r.ok, true);
});

test('custom-page：内容不通过校验门时拒绝（与草稿门同一套规则）', () => {
  const withScript = VALID_HTML.replace('</body>', '<script>alert(1)</script></body>');
  const r = customPagePublishCheck({ html: withScript });
  assert.equal(r.ok, false, '含脚本的内容不该能发布出去');
  if (!r.ok) assert.match(r.message, /安全检查|没有通过|脚本/);
});

test('listing：缺 propertyId 或为空都要拒绝', () => {
  for (const spec of [{}, { title: '没关联房源' }, { propertyId: '' }, { propertyId: 123 }]) {
    const r = listingPublishCheck(spec as Record<string, unknown>);
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(spec)}`);
    if (!r.ok) assert.match(r.message, /房源/, '原因应说明房源问题');
  }
});

test('listing：有 propertyId 即通过（不因其它可选字段为空而误拒）', () => {
  // 房源项目的 spec 里本来就没有 html —— 校验不该拿自定义页面的规则去卡它
  const r = listingPublishCheck({ propertyId: 'prp_x', title: '标题', priceAmount: null, city: '' });
  assert.equal(r.ok, true, '可选字段为空不该导致拒绝');
});

test('注册表：两个内置插件都注册了发布校验', () => {
  for (const manifest of [listingPluginManifest, customPagePluginManifest]) {
    assert.ok(publishCheckFor(manifest.id), `${manifest.id} 应注册发布校验`);
  }
  assert.equal(publishCheckFor('does-not-exist'), null, '未知插件应返回 null（调用方据此拒绝发布）');
});

test('两个插件的校验规则确实不同（不是同一条规则套所有插件）', () => {
  const spec = { propertyId: 'prp_x' };
  assert.equal(listingPublishCheck(spec).ok, true, 'listing 视角：合法');
  assert.equal(customPagePublishCheck(spec).ok, false, 'custom-page 视角：缺 html，不合法');
});