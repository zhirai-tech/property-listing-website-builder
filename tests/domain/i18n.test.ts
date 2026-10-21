/**
 * 多语言与格式化单元测试（方案第 5 阶段验收）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areaUnitLabel,
  contactChannelLabel,
  formatArea,
  formatDateOnly,
  formatMoney,
  formatPrice,
  nearbyCategoryLabel,
  pricePeriodLabel,
  propertyTypeLabel,
  resolveLocalizedText,
  t,
  uiCatalog,
} from '../../src/domain/i18n.ts';
import type { PropertyTranslation } from '../../src/domain/types.ts';

function translation(locale: string, title: string, description = ''): PropertyTranslation {
  return {
    id: `trn_${locale}`,
    propertyId: 'prp_1',
    locale,
    title,
    description,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const original = { title: '浦东两居室', description: '原文描述' };

test('命中译文时返回译文', () => {
  const result = resolveLocalizedText(original, [translation('en', 'Pudong 2-Bedroom', 'English text')], 'en');
  assert.equal(result.title, 'Pudong 2-Bedroom');
  assert.equal(result.description, 'English text');
  assert.equal(result.translated, true);
  assert.equal(result.usedLocale, 'en');
});

test('没有译文时回退原文，且绝不修改原文', () => {
  const result = resolveLocalizedText(original, [], 'en');
  assert.equal(result.title, original.title);
  assert.equal(result.description, original.description);
  assert.equal(result.translated, false);
  assert.equal(original.title, '浦东两居室', '原文对象不应被改动');
});

test('语言族回退：请求 zh-CN 可命中 zh 译文', () => {
  const result = resolveLocalizedText(original, [translation('zh', '简体译文')], 'zh-CN');
  assert.equal(result.title, '简体译文');
  assert.equal(result.usedLocale, 'zh');
});

test('译文标题为空时视为未翻译，回退原文', () => {
  const result = resolveLocalizedText(original, [translation('en', '   ')], 'en');
  assert.equal(result.title, original.title);
  assert.equal(result.translated, false);
});

test('金额格式化按语言与币种变化', () => {
  const zh = formatMoney(8500, 'CNY', 'zh-CN');
  const en = formatMoney(8500, 'CNY', 'en');

  assert.ok(zh.includes('8,500'), `中文格式应包含 8,500：${zh}`);
  assert.ok(en.includes('8,500'), `英文格式应包含 8,500：${en}`);
  assert.notEqual(zh, en, '不同语言下的货币展示应不同');
});

test('非法币种代码不会抛错，降级显示', () => {
  const result = formatMoney(100, 'NOT_A_CODE', 'en');
  assert.ok(result.includes('100'));
  assert.ok(result.includes('NOT_A_CODE'));
});

test('价格按周期拼接文案', () => {
  assert.equal(formatPrice(5000, 'CNY', 'total', 'zh-CN'), formatMoney(5000, 'CNY', 'zh-CN'));
  assert.match(formatPrice(5000, 'CNY', 'per_month', 'zh-CN'), /每月/);
  assert.match(formatPrice(5000, 'CNY', 'per_month', 'en'), /per month/);
});

test('面积单位不写死公制', () => {
  assert.equal(areaUnitLabel('square_meter', 'zh-CN'), '平方米');
  assert.equal(areaUnitLabel('square_foot', 'zh-CN'), '平方英尺');
  assert.match(formatArea(1450, 'square_foot', 'en'), /sq ft/);
});

test('计价周期文案随语言变化', () => {
  assert.equal(pricePeriodLabel('per_night', 'zh-CN'), '每晚');
  assert.equal(pricePeriodLabel('per_night', 'en'), 'per night');
});

test('日期按目标时区渲染且不受本地时区影响', () => {
  const result = formatDateOnly('2026-03-01', 'zh-CN', 'Asia/Shanghai');
  assert.ok(result.includes('2026'), result);
  assert.ok(result.includes('3'), result);
});

test('房型字典值被翻译，未知值原样保留（字段可配置）', () => {
  assert.equal(propertyTypeLabel('apartment', 'en'), 'Apartment');
  assert.equal(propertyTypeLabel('apartment', 'zh-CN'), '公寓');
  assert.equal(propertyTypeLabel('house', 'ja'), '一戸建て');
  assert.equal(propertyTypeLabel('custom_type', 'en'), 'custom_type');
});

test('联系方式与周边分类都有本地化标签', () => {
  assert.equal(contactChannelLabel('phone', 'zh-CN'), '电话');
  assert.equal(contactChannelLabel('phone', 'en'), 'Phone');
  assert.equal(contactChannelLabel('unknown_kind', 'en'), 'Contact');
  assert.equal(nearbyCategoryLabel('school', 'zh-CN'), '学校');
  assert.equal(nearbyCategoryLabel('school', 'en'), 'Schools');
});

test('界面文案支持占位替换', () => {
  assert.equal(t('zh-CN', 'price'), '价格');
  assert.equal(t('en', 'price'), 'Price');

  const notice = t('en', 'translationNotice', { locale: 'en' });
  assert.ok(notice.includes('en'), notice);
  assert.ok(!notice.includes('{locale}'), '占位符应被替换');
});

test('未知语言回退到英文词条', () => {
  assert.equal(uiCatalog('xx-YY')['price'], 'Price');
  assert.equal(t('xx-YY', 'price'), 'Price');
});

test('各语言词条键集合完整，不存在遗漏', () => {
  const zhKeys = Object.keys(uiCatalog('zh-CN')).sort();
  for (const locale of ['zh-TW', 'en', 'ja']) {
    const keys = Object.keys(uiCatalog(locale)).sort();
    assert.deepEqual(keys, zhKeys, `${locale} 词条键与 zh-CN 不一致`);
  }
});