/**
 * 房源领域规则单元测试（方案第 1 阶段验收：错误输入有明确提示）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPropertyForm, parsePropertyForm, diffPropertyForm, propertyFormFromProperty } from '../../src/domain/property.ts';
import { DomainError, isDomainError } from '../../src/domain/errors.ts';
import { propertyInput } from '../helpers/test-app.ts';
import type { Property } from '../../src/domain/types.ts';

const defaults = { currency: 'CNY', areaUnit: 'square_meter' as const };

function expectIssues(input: Record<string, unknown>, expectedFields: string[]): void {
  try {
    parsePropertyForm(input, emptyPropertyForm(defaults));
    assert.fail('应当抛出校验错误，但没有');
  } catch (error) {
    assert.ok(isDomainError(error), '应抛出 DomainError');
    const fields = (error as DomainError).issues.map((i) => i.field);
    for (const field of expectedFields) {
      assert.ok(fields.includes(field), `缺少字段 ${field} 的错误，实际：${fields.join(',')}`);
    }
  }
}

test('标题为空时给出字段级中文提示', () => {
  expectIssues(propertyInput({ title: '' }), ['title']);
});

test('标题超长会被截断并提示', () => {
  const long = 'a'.repeat(260);
  try {
    parsePropertyForm(propertyInput({ title: long }), emptyPropertyForm(defaults));
    assert.fail('应当报错');
  } catch (error) {
    const domainError = error as DomainError;
    const issue = domainError.issues.find((i) => i.field === 'title');
    assert.ok(issue, '应有 title 的错误');
    assert.match(issue.message, /最多 200 个字符/);
  }
});

test('非数字价格被拒绝', () => {
  expectIssues(propertyInput({ priceAmount: 'abc' }), ['priceAmount']);
});

test('负价格被拒绝', () => {
  expectIssues(propertyInput({ priceAmount: -1 }), ['priceAmount']);
});

test('币种必须是 3 位字母代码并自动大写', () => {
  const parsed = parsePropertyForm(propertyInput({ priceCurrency: 'cny' }), emptyPropertyForm(defaults));
  assert.equal(parsed.priceCurrency, 'CNY');

  expectIssues(propertyInput({ priceCurrency: 'RMB1' }), ['priceCurrency']);
});

test('国家代码必须是 2 位字母', () => {
  assert.equal(
    parsePropertyForm(propertyInput({ countryCode: 'cn' }), emptyPropertyForm(defaults)).countryCode,
    'CN',
  );
  expectIssues(propertyInput({ countryCode: 'CHN' }), ['countryCode']);
});

test('经纬度必须成对填写', () => {
  try {
    parsePropertyForm(propertyInput({ latitude: 31.2, longitude: null }), emptyPropertyForm(defaults));
    assert.fail('应当报错');
  } catch (error) {
    const domainError = error as DomainError;
    assert.ok(domainError.issues.some((i) => i.field === 'longitude'));
    assert.match(domainError.message, /位置信息不完整/);
  }
});

test('经纬度范围校验', () => {
  expectIssues(propertyInput({ latitude: 91 }), ['latitude']);
  expectIssues(propertyInput({ longitude: -181 }), ['longitude']);
});

test('无效日期被拒绝，合法日期保留', () => {
  expectIssues(propertyInput({ availableFrom: '2026-02-30' }), ['availableFrom']);
  expectIssues(propertyInput({ availableFrom: '2026/03/01' }), ['availableFrom']);

  const parsed = parsePropertyForm(propertyInput({ availableFrom: '2026-03-01' }), emptyPropertyForm(defaults));
  assert.equal(parsed.availableFrom, '2026-03-01');
});

test('面积单位非法值被拒绝', () => {
  expectIssues(propertyInput({ areaUnit: 'hectare' }), ['areaUnit']);
});

test('未知房源状态被拒绝', () => {
  expectIssues(propertyInput({ status: 'pending_review' }), ['status']);
});

test('描述保留换行（不被折叠为空格）', () => {
  const parsed = parsePropertyForm(
    propertyInput({ description: '第一行\n\n第二行' }),
    emptyPropertyForm(defaults),
  );
  assert.equal(parsed.description, '第一行\n\n第二行');
});

test('编辑（PATCH）语义：未提交字段沿用原值', () => {
  const base = parsePropertyForm(propertyInput(), emptyPropertyForm(defaults));

  const fakeProperty = {
    ...base,
    id: 'prp_x',
    workspaceId: 'wsp_x',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Property;

  const current = propertyFormFromProperty(fakeProperty);
  const next = parsePropertyForm({ priceAmount: 6500 }, current);

  assert.equal(next.priceAmount, 6500, '价格应更新');
  assert.equal(next.title, base.title, '标题应保持原值');
  assert.equal(next.city, base.city, '城市应保持原值');

  const patch = diffPropertyForm(next, current);
  assert.deepEqual(Object.keys(patch), ['priceAmount'], '差异应只包含变化的字段');
});

test('编辑时把标题清空仍然报错', () => {
  const base = parsePropertyForm(propertyInput(), emptyPropertyForm(defaults));
  const fakeProperty = {
    ...base,
    id: 'prp_x',
    workspaceId: 'wsp_x',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Property;

  expectIssues({ title: '' }, ['title']);
  assert.equal(propertyFormFromProperty(fakeProperty).title, base.title);
});

test('多个字段同时出错时会一次性返回全部问题', () => {
  try {
    parsePropertyForm({ title: '', priceAmount: 'x', latitude: 200 }, emptyPropertyForm(defaults));
    assert.fail('应当报错');
  } catch (error) {
    const fields = (error as DomainError).issues.map((i) => i.field);
    assert.ok(fields.length >= 3, `应返回至少 3 个问题，实际 ${fields.length}`);
  }
});