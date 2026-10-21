/**
 * 发布服务单元测试（方案第 2 阶段验收）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, propertyInput } from '../helpers/test-app.ts';
import { createPropertyFromInput } from '../../src/services/property-service.ts';
import {
  ensureListingPage,
  findPublicPage,
  listPagesAdmin,
  publishListing,
  readiness,
  updateListingSettings,
  withdrawListing,
} from '../../src/services/publish-service.ts';
import { insertContact } from '../../src/db/repositories/contact-repo.ts';
import { DomainError, isDomainError } from '../../src/domain/errors.ts';
import { listRemindersByProperty } from '../../src/db/repositories/reminder-repo.ts';

test('首次访问发布设置会自动创建发布页并生成中文 slug', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput({ title: '浦东精装两居室' }));
    const page = ensureListingPage(h.ctx, property.id);

    assert.ok(page.slug.length > 0);
    assert.ok(page.slug.includes('浦东'), page.slug);
    assert.equal(page.status, 'unpublished');
    assert.equal(page.locale, 'zh-CN');
  } finally {
    h.dispose();
  }
});

test('重复调用不会创建第二个发布页', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    const first = ensureListingPage(h.ctx, property.id);
    const second = ensureListingPage(h.ctx, property.id);

    assert.equal(first.id, second.id);
    const count = h.ctx.db.prepare('SELECT COUNT(*) AS n FROM listing_pages').get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    h.dispose();
  }
});

test('slug 冲突时自动加序号，不覆盖已有房源', () => {
  const h = createHarness();
  try {
    const a = createPropertyFromInput(h.ctx, propertyInput({ title: '同名房源', city: 'A' }));
    const b = createPropertyFromInput(h.ctx, propertyInput({ title: '同名房源', city: 'B' }));

    const pageA = ensureListingPage(h.ctx, a.property.id);
    const pageB = ensureListingPage(h.ctx, b.property.id);

    assert.notEqual(pageA.slug, pageB.slug);
    assert.equal(pageB.slug, `${pageA.slug}-2`);
  } finally {
    h.dispose();
  }
});

test('手动设置已被占用的 slug 会被拒绝', () => {
  const h = createHarness();
  try {
    const a = createPropertyFromInput(h.ctx, propertyInput({ title: '房源甲', city: 'A' }));
    const b = createPropertyFromInput(h.ctx, propertyInput({ title: '房源乙', city: 'B' }));

    const pageA = ensureListingPage(h.ctx, a.property.id);
    ensureListingPage(h.ctx, b.property.id);

    assert.throws(() => updateListingSettings(h.ctx, b.property.id, { slug: pageA.slug }), (error: unknown) => {
      assert.ok(isDomainError(error));
      assert.match((error as DomainError).message, /已被其它房源占用/);
      return true;
    });
  } finally {
    h.dispose();
  }
});

test('缺少标题或地址时不允许发布', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(
      h.ctx,
      propertyInput({ addressLine: '', city: '', region: '' }),
    );

    assert.throws(() => publishListing(h.ctx, property.id), (error: unknown) => {
      assert.ok(isDomainError(error));
      assert.equal((error as DomainError).code, 'UNPROCESSABLE');
      assert.match((error as DomainError).message, /地址/);
      return true;
    });
  } finally {
    h.dispose();
  }
});

test('发布后公开可访问，未发布与撤下均不可访问', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    const page = ensureListingPage(h.ctx, property.id);

    assert.equal(findPublicPage(h.ctx, page.slug), null, '未发布不应可访问');

    publishListing(h.ctx, property.id);
    assert.ok(findPublicPage(h.ctx, page.slug), '发布后应可访问');

    withdrawListing(h.ctx, property.id);
    assert.equal(findPublicPage(h.ctx, page.slug), null, '撤下后不应可访问');
  } finally {
    h.dispose();
  }
});

test('发布后展示页内容与后台数据一致（唯一数据源）', async () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    publishListing(h.ctx, property.id);

    const page = ensureListingPage(h.ctx, property.id);
    const found = findPublicPage(h.ctx, page.slug);
    assert.ok(found);

    assert.equal(found.aggregate.property.title, property.title);
    assert.equal(found.aggregate.property.priceAmount, 5000);

    // 后台改价后，公开读取应立刻反映
    const { updatePropertyFromInput } = await import('../../src/services/property-service.ts');
    updatePropertyFromInput(h.ctx, property.id, { priceAmount: 7777 });

    const after = findPublicPage(h.ctx, page.slug);
    assert.equal(after?.aggregate.property.priceAmount, 7777);
  } finally {
    h.dispose();
  }
});

test('发布只渲染用户标记为公开的联系方式', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());

    insertContact(h.ctx.db, h.ctx.workspace.id, property.id, {
      displayName: '公开',
      channelKind: 'phone',
      channelValue: '+86 111',
      isPublic: true,
    });
    insertContact(h.ctx.db, h.ctx.workspace.id, property.id, {
      displayName: '私密',
      channelKind: 'email',
      channelValue: 'secret@example.com',
      isPublic: false,
    });

    publishListing(h.ctx, property.id);
    const page = ensureListingPage(h.ctx, property.id);
    const found = findPublicPage(h.ctx, page.slug);

    assert.equal(found?.aggregate.contacts.length, 1);
    assert.equal(found?.aggregate.contacts[0]?.channelValue, '+86 111');
  } finally {
    h.dispose();
  }
});

test('发布时按配置生成第 7/15 天提醒，且重复发布不新增记录', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());

    publishListing(h.ctx, property.id);
    let reminders = listRemindersByProperty(h.ctx.db, property.id);
    assert.equal(reminders.length, 2);
    assert.deepEqual(reminders.map((r) => r.kind), ['check_day_7', 'confirm_day_15']);

    withdrawListing(h.ctx, property.id);
    publishListing(h.ctx, property.id);

    reminders = listRemindersByProperty(h.ctx.db, property.id);
    assert.equal(reminders.length, 2, '重新发布应复用同一批提醒而不是新增');
  } finally {
    h.dispose();
  }
});

test('发布与撤下可以反复执行', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());

    for (let i = 0; i < 3; i += 1) {
      assert.doesNotThrow(() => publishListing(h.ctx, property.id));
      assert.doesNotThrow(() => withdrawListing(h.ctx, property.id));
    }
  } finally {
    h.dispose();
  }
});

test('发布后修改 slug 会更新公开地址', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    publishListing(h.ctx, property.id);

    const updated = updateListingSettings(h.ctx, property.id, { slug: 'my-custom-slug' });
    assert.equal(updated.slug, 'my-custom-slug');

    assert.ok(findPublicPage(h.ctx, 'my-custom-slug'), '新 slug 应可访问');
  } finally {
    h.dispose();
  }
});

test('发布总览列出公开地址与就绪状态', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    publishListing(h.ctx, property.id);

    const rows = listPagesAdmin(h.ctx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.propertyTitle, property.title);
    assert.match(rows[0]?.publicUrl ?? '', /\/p\//);
    assert.equal(rows[0]?.readiness.ready, true);
  } finally {
    h.dispose();
  }
});

test('就绪检查会提示缺少照片与联系方式', () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    const result = readiness(h.ctx, property.id, 'zh-CN');

    assert.equal(result.ready, true);
    assert.ok(result.warnings.some((w) => /照片/.test(w)));
  } finally {
    h.dispose();
  }
});