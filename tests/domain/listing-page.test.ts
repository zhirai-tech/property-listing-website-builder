/**
 * 发布页与托管域名领域规则单元测试（方案第 2、6 阶段验收）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDomainBindable,
  assertPublishTransition,
  collectPublishReadiness,
  isDomainActive,
  isPubliclyVisible,
  slugSeedFor,
  verifyDomainOwnership,
} from '../../src/domain/listing-page.ts';
import { nextAvailableSlug, slugify, isValidDomain, normalizeDomainLabel } from '../../src/util/slug.ts';
import {
  buildDefaultPublicUrl,
  buildSubdomain,
  resolvePublicUrl,
  validateSubdomainLabel,
} from '../../src/domain/hosting.ts';
import { DomainError, isDomainError } from '../../src/domain/errors.ts';

const hostingOptions = {
  publicBaseUrl: 'https://listings.example.com',
  cnameTarget: 'listings.example.com',
  domainVerifyPrefix: '_pl-verify',
};

test('中文标题生成的 slug 不会被清空', () => {
  const slug = slugify('浦东新区精装两居室 · 近地铁 2 号线');
  assert.ok(slug.length > 0, '中文标题必须能生成可用 slug');
  assert.ok(slug.includes('浦东'), slug);
  assert.ok(!slug.includes(' '), '不应包含空格');
});

test('英文标题生成可读 slug', () => {
  assert.equal(slugify('Bright 2-Bedroom in Pudong!'), 'bright-2-bedroom-in-pudong');
});

test('连续标点被折叠为单个连字符', () => {
  const slug = slugify('A  --  B *** C !!! D');
  assert.equal(slug, 'a-b-c-d');
});

test('slug 长度受限且不会截断代理对', () => {
  const slug = slugify('好'.repeat(200));
  assert.ok(Array.from(slug).length <= 60, `长度应受限，实际 ${Array.from(slug).length}`);
});

test('slug 冲突时依次生成候选', () => {
  const taken = new Set(['listing', 'listing-2']);
  const result = nextAvailableSlug('listing', (candidate) => taken.has(candidate));
  assert.equal(result, 'listing-3');
});

test('slugSeedFor 在标题为空时回退城市与房型', () => {
  assert.equal(slugSeedFor({ title: '', city: '上海', propertyType: 'apartment' }), '上海-apartment');
});

test('发布状态迁移规则：未发布不能直接撤下', () => {
  assert.doesNotThrow(() => assertPublishTransition('unpublished', 'published'));
  assert.doesNotThrow(() => assertPublishTransition('published', 'withdrawn'));
  assert.doesNotThrow(() => assertPublishTransition('withdrawn', 'published'));
  assert.doesNotThrow(() => assertPublishTransition('published', 'published'), '重复发布应被允许');

  assert.throws(() => assertPublishTransition('unpublished', 'withdrawn'), (error: unknown) => {
    assert.ok(isDomainError(error));
    return true;
  });
});

test('只有已发布页面才对外可见', () => {
  assert.equal(isPubliclyVisible({ status: 'published' }), true);
  assert.equal(isPubliclyVisible({ status: 'unpublished' }), false);
  assert.equal(isPubliclyVisible({ status: 'withdrawn' }), false);
});

test('发布就绪检查会拦截缺失标题与地址', () => {
  const result = collectPublishReadiness({
    property: { title: '', addressLine: '', city: '', region: '' },
    media: [],
    contacts: [],
    locale: 'zh-CN',
    hasTranslationFor: () => true,
  });

  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((b) => /标题/.test(b)));
  assert.ok(result.blockers.some((b) => /地址/.test(b)));
});

test('发布就绪检查把照片与联系方式作为提示而非阻塞', () => {
  const result = collectPublishReadiness({
    property: { title: '标题', addressLine: '某某路 1 号', city: '', region: '' },
    media: [],
    contacts: [],
    locale: 'zh-CN',
    hasTranslationFor: () => true,
  });

  assert.equal(result.ready, true);
  assert.ok(result.warnings.some((w) => /照片/.test(w)));
  assert.ok(result.warnings.some((w) => /联系方式/.test(w)));
});

test('缺少目标语言译文时给出回退提示', () => {
  const result = collectPublishReadiness({
    property: { title: '标题', addressLine: '地址', city: '', region: '' },
    media: [{ kind: 'photo', storageKey: 'a.png', externalUrl: null }],
    contacts: [{ isPublic: true, channelValue: 'x' }],
    locale: 'en',
    hasTranslationFor: () => false,
  });

  assert.equal(result.ready, true);
  assert.ok(result.warnings.some((w) => /回退显示原文/.test(w)));
});

test('域名格式校验', () => {
  assert.equal(assertDomainBindable('Listings.Example.COM'), 'listings.example.com');
  assert.equal(isValidDomain('a.example.com'), true);
  assert.equal(isValidDomain('localhost'), false);
  assert.equal(isValidDomain('bad_domain.com'), false);
  assert.throws(() => assertDomainBindable('not a domain'));
});

test('子域名标签过滤保留字与非法字符', () => {
  assert.equal(validateSubdomainLabel('My Listing'), 'my-listing');
  assert.throws(() => validateSubdomainLabel('www'));
  assert.throws(() => validateSubdomainLabel('a'));
});

test('子域名与默认地址拼接正确', () => {
  assert.equal(buildDefaultPublicUrl('https://x.com/', 'abc'), 'https://x.com/p/abc');
  assert.equal(buildSubdomain('my-flat', 'listings.example.com'), 'my-flat.listings.example.com');
});

test('未验证的自定义域名不会生效', () => {
  const pending = resolvePublicUrl('abc', {
    customDomain: 'my.example.com',
    domainVerifyToken: 'tok',
    domainVerifiedAt: null,
  }, { ...hostingOptions, allowCustomDomain: true });

  assert.equal(pending.kind, 'default', '未验证时应回退默认地址');
  assert.match(pending.note, /尚未通过/);

  const verified = resolvePublicUrl('abc', {
    customDomain: 'my.example.com',
    domainVerifyToken: 'tok',
    domainVerifiedAt: '2026-01-01T00:00:00.000Z',
  }, { ...hostingOptions, allowCustomDomain: true });

  assert.equal(verified.kind, 'custom_domain');
  assert.equal(verified.url, 'https://my.example.com/p/abc');
});

test('关闭自定义域名时始终使用默认地址', () => {
  const result = resolvePublicUrl('abc', {
    customDomain: 'my.example.com',
    domainVerifyToken: 'tok',
    domainVerifiedAt: '2026-01-01T00:00:00.000Z',
  }, { ...hostingOptions, allowCustomDomain: false });

  assert.equal(result.kind, 'default');
});

test('域名所有权验证需匹配 TXT 记录', () => {
  const state = { domainVerifyToken: 'secret-token' };

  assert.equal(verifyDomainOwnership(state, ['_pl-verify=secret-token'], '_pl-verify'), true);
  assert.equal(verifyDomainOwnership(state, ['_pl-verify=other'], '_pl-verify'), false);
  assert.equal(verifyDomainOwnership(state, [], '_pl-verify'), false);
  assert.equal(verifyDomainOwnership({ domainVerifyToken: null }, ['_pl-verify=x'], '_pl-verify'), false);
});

test('isDomainActive 需要存在域名与验证时间', () => {
  assert.equal(isDomainActive({ customDomain: 'a.com', domainVerifyToken: 't', domainVerifiedAt: 'x' }), true);
  assert.equal(isDomainActive({ customDomain: 'a.com', domainVerifyToken: 't', domainVerifiedAt: null }), false);
  assert.equal(isDomainActive({ customDomain: null, domainVerifyToken: 't', domainVerifiedAt: 'x' }), false);
});

test('normalizeDomainLabel 只保留合法字符', () => {
  assert.equal(normalizeDomainLabel('Hello World!'), 'hello-world');
  assert.equal(normalizeDomainLabel('---'), '');
});