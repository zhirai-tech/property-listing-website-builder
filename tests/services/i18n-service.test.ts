/**
 * 多语言服务单元测试（方案第 5 阶段验收：切换语言不覆盖原文）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, propertyInput } from '../helpers/test-app.ts';
import { createPropertyFromInput } from '../../src/services/property-service.ts';
import {
  buildLocaleLinks,
  listPropertyTranslations,
  removeTranslation,
  saveTranslation,
} from '../../src/services/i18n-service.ts';
import { requireProperty } from '../../src/services/property-service.ts';
import { isDomainError } from '../../src/domain/errors.ts';

function setup() {
  const h = createHarness();
  const { property } = createPropertyFromInput(h.ctx, propertyInput());
  return { h, propertyId: property.id };
}

test('保存译文后原文完全不变', () => {
  const { h, propertyId } = setup();
  try {
    const before = requireProperty(h.ctx, propertyId);

    saveTranslation(h.ctx, propertyId, {
      locale: 'en',
      title: 'Test listing · 2 bedrooms',
      description: 'English description',
    });

    const after = requireProperty(h.ctx, propertyId);
    assert.equal(after.title, before.title, '原文标题不得被覆盖');
    assert.equal(after.description, before.description, '原文描述不得被覆盖');
    assert.equal(after.updatedAt, before.updatedAt, '原文记录不应被触碰');
  } finally {
    h.dispose();
  }
});

test('同一语言重复保存为更新而不是新增', () => {
  const { h, propertyId } = setup();
  try {
    saveTranslation(h.ctx, propertyId, { locale: 'en', title: 'First', description: 'a' });
    saveTranslation(h.ctx, propertyId, { locale: 'en', title: 'Second', description: 'b' });

    const items = listPropertyTranslations(h.ctx, propertyId);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, 'Second');
  } finally {
    h.dispose();
  }
});

test('可以为同一房源保存多种语言', () => {
  const { h, propertyId } = setup();
  try {
    saveTranslation(h.ctx, propertyId, { locale: 'en', title: 'English', description: '' });
    saveTranslation(h.ctx, propertyId, { locale: 'ja', title: '日本語', description: '' });

    const locales = listPropertyTranslations(h.ctx, propertyId).map((t) => t.locale).sort();
    assert.deepEqual(locales, ['en', 'ja']);
  } finally {
    h.dispose();
  }
});

test('拒绝用同语言译文覆盖原文（原文必须在房源主记录里改）', () => {
  const { h, propertyId } = setup();
  try {
    assert.throws(
      () => saveTranslation(h.ctx, propertyId, { locale: 'zh-CN', title: '试图覆盖', description: 'x' }),
      (error: unknown) => {
        assert.ok(isDomainError(error));
        return true;
      },
    );

    assert.equal(listPropertyTranslations(h.ctx, propertyId).length, 0);
  } finally {
    h.dispose();
  }
});

test('译文标题为空会被拒绝', () => {
  const { h, propertyId } = setup();
  try {
    assert.throws(() => saveTranslation(h.ctx, propertyId, { locale: 'en', title: '', description: '' }));
  } finally {
    h.dispose();
  }
});

test('非法语言标签被拒绝', () => {
  const { h, propertyId } = setup();
  try {
    assert.throws(() => saveTranslation(h.ctx, propertyId, { locale: '!!!', title: 'x', description: '' }));
  } finally {
    h.dispose();
  }
});

test('删除译文不影响原文与其它语言', () => {
  const { h, propertyId } = setup();
  try {
    const original = requireProperty(h.ctx, propertyId);
    saveTranslation(h.ctx, propertyId, { locale: 'en', title: 'English', description: '' });
    saveTranslation(h.ctx, propertyId, { locale: 'ja', title: '日本語', description: '' });

    assert.equal(removeTranslation(h.ctx, propertyId, 'en'), true);

    const remaining = listPropertyTranslations(h.ctx, propertyId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.locale, 'ja');
    assert.equal(requireProperty(h.ctx, propertyId).title, original.title);
  } finally {
    h.dispose();
  }
});

test('删除不存在的译文返回 false', () => {
  const { h, propertyId } = setup();
  try {
    assert.equal(removeTranslation(h.ctx, propertyId, 'de'), false);
  } finally {
    h.dispose();
  }
});

test('语言切换链接包含原文语言与已有译文语言', () => {
  const { h, propertyId } = setup();
  try {
    saveTranslation(h.ctx, propertyId, { locale: 'en', title: 'English', description: '' });

    const links = buildLocaleLinks(h.ctx, propertyId, 'zh-CN');
    const tags = links.map((l) => l.tag).sort();

    assert.deepEqual(tags, ['en', 'zh-CN']);
    assert.equal(links.find((l) => l.tag === 'zh-CN')?.current, true);
    assert.equal(links.find((l) => l.tag === 'en')?.current, false);
    assert.equal(links.find((l) => l.tag === 'en')?.label, 'English');
  } finally {
    h.dispose();
  }
});

test('跨工作区无法读写译文', () => {
  const { h, propertyId } = setup();
  try {
    const other = { ...h.ctx, workspace: { ...h.ctx.workspace, id: 'wsp_other' } };
    assert.throws(() => listPropertyTranslations(other, propertyId), (error: unknown) => isDomainError(error));
  } finally {
    h.dispose();
  }
});