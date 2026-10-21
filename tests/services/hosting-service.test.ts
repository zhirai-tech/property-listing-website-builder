/**
 * 托管与域名验证服务单元测试（方案第 6 阶段验收）。
 *
 * 说明：这里用 FakeDnsResolver 完整跑通「绑定 -> 添加 TXT -> 验证 -> 生效」的流程。
 * 真实公网 DNS 需要自有域名，无法在离线环境验证，已在验收报告中如实登记。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, propertyInput } from '../helpers/test-app.ts';
import { createPropertyFromInput } from '../../src/services/property-service.ts';
import { ensureListingPage, publishListing } from '../../src/services/publish-service.ts';
import {
  bindDomain,
  hostingState,
  suggestSubdomain,
  unbindDomain,
  verifyBoundDomain,
} from '../../src/services/hosting-service.ts';
import { isDomainError } from '../../src/domain/errors.ts';

function setup() {
  const h = createHarness();
  const { property } = createPropertyFromInput(h.ctx, propertyInput());
  publishListing(h.ctx, property.id);
  return { h, propertyId: property.id };
}

test('默认使用平台地址，未绑定时不出现自定义域名', () => {
  const { h, propertyId } = setup();
  try {
    const state = hostingState(h.ctx, propertyId);
    assert.equal(state.urlKind, 'default');
    assert.equal(state.customDomain, null);
    assert.match(state.publicUrl, /\/p\//);
  } finally {
    h.dispose();
  }
});

test('绑定域名后生成 TXT 验证指引，但地址仍是默认地址', () => {
  const { h, propertyId } = setup();
  try {
    const result = bindDomain(h.ctx, propertyId, 'My-Listing.Example.com');

    assert.equal(result.page.customDomain, 'my-listing.example.com', '域名应被规范化');
    assert.ok(result.page.domainVerifyToken);
    assert.equal(result.instructions.recordType, 'TXT');
    assert.match(result.instructions.recordValue, /^_property-listing-verify=/);
    assert.ok(!result.publicUrl.includes('my-listing.example.com'), '未验证前不得使用自定义域名');
    assert.match(result.publicUrl, /\/p\//, '应回退到平台默认地址');

    const state = hostingState(h.ctx, propertyId);
    assert.equal(state.urlKind, 'default');
    assert.match(state.note, /尚未通过所有权验证/);
  } finally {
    h.dispose();
  }
});

test('DNS 没有 TXT 记录时验证失败并说明原因', async () => {
  const { h, propertyId } = setup();
  try {
    bindDomain(h.ctx, propertyId, 'example.com');
    const result = await verifyBoundDomain(h.ctx, propertyId);

    assert.equal(result.verified, false);
    assert.match(result.detail, /未查询到/);
    assert.deepEqual(result.found, []);

    const state = hostingState(h.ctx, propertyId);
    assert.equal(state.urlKind, 'default', '验证失败时不得启用自定义域名');
  } finally {
    h.dispose();
  }
});

test('TXT 记录值不匹配时验证失败', async () => {
  const { h, propertyId } = setup();
  try {
    bindDomain(h.ctx, propertyId, 'example.com');
    h.dns.setTxt('example.com', [['_property-listing-verify=wrong-token']]);

    const result = await verifyBoundDomain(h.ctx, propertyId);
    assert.equal(result.verified, false);
    assert.match(result.detail, /没有匹配/);
    assert.deepEqual(result.found, ['_property-listing-verify=wrong-token']);
  } finally {
    h.dispose();
  }
});

test('TXT 记录正确时验证通过并切换到自定义域名', async () => {
  const { h, propertyId } = setup();
  try {
    const bound = bindDomain(h.ctx, propertyId, 'example.com');
    const token = bound.page.domainVerifyToken;
    assert.ok(token);

    h.dns.setTxt('example.com', [[`_property-listing-verify=${token}`]]);

    const result = await verifyBoundDomain(h.ctx, propertyId);
    assert.equal(result.verified, true);
    assert.match(result.detail, /已验证/);
    assert.equal(result.publicUrl, 'https://example.com/p/' + encodeURIComponent(bound.page.slug));

    const state = hostingState(h.ctx, propertyId);
    assert.equal(state.urlKind, 'custom_domain');
    assert.equal(state.domainVerifiedAt !== null, true);
  } finally {
    h.dispose();
  }
});

test('DNS 返回多段 TXT 记录时能正确拼接比对', async () => {
  const { h, propertyId } = setup();
  try {
    const bound = bindDomain(h.ctx, propertyId, 'example.com');
    const token = bound.page.domainVerifyToken;
    assert.ok(token);

    // 真实 DNS 会把长 TXT 记录拆成多段
    h.dns.setTxt('example.com', [['_property-listing-verify=', token]]);

    const result = await verifyBoundDomain(h.ctx, propertyId);
    assert.equal(result.verified, true);
  } finally {
    h.dispose();
  }
});

test('重新绑定域名会要求重新验证', async () => {
  const { h, propertyId } = setup();
  try {
    const first = bindDomain(h.ctx, propertyId, 'a.example.com');
    h.dns.setTxt('a.example.com', [[`_property-listing-verify=${first.page.domainVerifyToken}`]]);
    await verifyBoundDomain(h.ctx, propertyId);
    assert.equal(hostingState(h.ctx, propertyId).urlKind, 'custom_domain');

    bindDomain(h.ctx, propertyId, 'b.example.com');
    const state = hostingState(h.ctx, propertyId);
    assert.equal(state.urlKind, 'default', '换域名后必须重新验证');
    assert.equal(state.domainVerifiedAt, null);
  } finally {
    h.dispose();
  }
});

test('解绑后回到平台默认地址', async () => {
  const { h, propertyId } = setup();
  try {
    const bound = bindDomain(h.ctx, propertyId, 'example.com');
    h.dns.setTxt('example.com', [[`_property-listing-verify=${bound.page.domainVerifyToken}`]]);
    await verifyBoundDomain(h.ctx, propertyId);

    unbindDomain(h.ctx, propertyId);
    const state = hostingState(h.ctx, propertyId);

    assert.equal(state.customDomain, null);
    assert.equal(state.urlKind, 'default');
  } finally {
    h.dispose();
  }
});

test('已被其它房源占用的域名会被拒绝', () => {
  const h = createHarness();
  try {
    const a = createPropertyFromInput(h.ctx, propertyInput({ title: '房源甲', city: 'A' }));
    const b = createPropertyFromInput(h.ctx, propertyInput({ title: '房源乙', city: 'B' }));

    bindDomain(h.ctx, a.property.id, 'taken.example.com');

    assert.throws(() => bindDomain(h.ctx, b.property.id, 'taken.example.com'), (error: unknown) => {
      assert.ok(isDomainError(error));
      return true;
    });
  } finally {
    h.dispose();
  }
});

test('非法域名被拒绝', () => {
  const { h, propertyId } = setup();
  try {
    for (const bad of ['not a domain', 'localhost', 'http://example.com/a']) {
      assert.throws(() => bindDomain(h.ctx, propertyId, bad), `应拒绝：${bad}`);
    }
  } finally {
    h.dispose();
  }
});

test('未绑定域名时无法执行验证', async () => {
  const { h, propertyId } = setup();
  try {
    await assert.rejects(verifyBoundDomain(h.ctx, propertyId), (error: unknown) => isDomainError(error));
  } finally {
    h.dispose();
  }
});

test('子域名建议基于 slug 生成', () => {
  const { h, propertyId } = setup();
  try {
    const page = ensureListingPage(h.ctx, propertyId);
    const suggestion = suggestSubdomain(h.ctx, page.slug);

    assert.match(suggestion, /\.listings\.example\.com$/);
    assert.match(suggestion, /^[a-z0-9-]+\./, 'DNS 标签必须是 ascii，不能是中文');
  } finally {
    h.dispose();
  }
});

test('中文 slug 无法直接作为 DNS 标签时会回退为可用标签', () => {
  const { h, propertyId } = setup();
  try {
    const page = ensureListingPage(h.ctx, propertyId);
    // 该房源标题为中文，slug 也是中文
    assert.ok(/[\u4e00-\u9fff]/.test(page.slug), `前置条件：slug 应为中文，实际 ${page.slug}`);

    const suggestion = suggestSubdomain(h.ctx, page.slug);
    assert.match(suggestion, /^listing-[a-z0-9]{6}\.listings\.example\.com$/);
  } finally {
    h.dispose();
  }
});