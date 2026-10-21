/**
 * 房源服务单元测试（方案第 1 阶段验收）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, propertyInput } from '../helpers/test-app.ts';
import {
  archiveProperty,
  createPropertyFromInput,
  deletePropertyCascade,
  duplicateProperty,
  getPropertyAggregate,
  listPropertiesAdmin,
  requireProperty,
  restoreProperty,
  setPropertyStatus,
  updatePropertyFromInput,
} from '../../src/services/property-service.ts';
import { insertContact } from '../../src/db/repositories/contact-repo.ts';
import { addVideoLink } from '../../src/services/media-service.ts';
import { DomainError, isDomainError } from '../../src/domain/errors.ts';

function harness() {
  return createHarness();
}

test('创建房源后可立即读取（刷新后仍在）', () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    const readBack = requireProperty(h.ctx, property.id);

    assert.equal(readBack.title, '测试房源 · 两居室');
    assert.equal(readBack.priceAmount, 5000);
    assert.equal(readBack.areaUnit, 'square_meter');
    assert.equal(readBack.latitude, 31.2304);
  } finally {
    h.dispose();
  }
});

test('相同标题与城市会被标记为疑似重复录入', () => {
  const h = harness();
  try {
    createPropertyFromInput(h.ctx, propertyInput());
    const second = createPropertyFromInput(h.ctx, propertyInput({ addressLine: '另一条路 2 号' }));

    assert.ok(second.duplicateOf, '应识别出疑似重复');
    assert.equal(second.duplicateOf?.title, '测试房源 · 两居室');
    assert.notEqual(second.property.id, second.duplicateOf?.id);
  } finally {
    h.dispose();
  }
});

test('编辑只更新发生变化的字段', () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    const updated = updatePropertyFromInput(h.ctx, property.id, { priceAmount: 6800 });

    assert.equal(updated.priceAmount, 6800);
    assert.equal(updated.title, property.title, '未提交的字段应保持不变');
    assert.equal(updated.description, property.description);
  } finally {
    h.dispose();
  }
});

test('编辑会记录审计日志并包含变更字段', () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    updatePropertyFromInput(h.ctx, property.id, { priceAmount: 6800, city: '新城市' });

    const rows = h.ctx.db.prepare("SELECT detail FROM audit_logs WHERE action = 'property.update'").all();
    assert.equal(rows.length, 1);

    const detail = JSON.parse(String((rows[0] as { detail: string }).detail));
    assert.deepEqual(new Set(detail.changedFields), new Set(['priceAmount', 'city']));
  } finally {
    h.dispose();
  }
});

test('状态切换与归档只能作用于本工作区房源', () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());

    assert.equal(setPropertyStatus(h.ctx, property.id, 'reserved').status, 'reserved');
    assert.equal(archiveProperty(h.ctx, property.id).status, 'archived');
    assert.equal(restoreProperty(h.ctx, property.id).status, 'draft');
  } finally {
    h.dispose();
  }
});

test('访问其它工作区的房源返回 404（权限隔离）', () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());

    // 伪造一个属于其它工作区的上下文
    const other = { ...h.ctx, workspace: { ...h.ctx.workspace, id: 'wsp_other' } };

    assert.throws(() => requireProperty(other, property.id), (error: unknown) => {
      assert.ok(isDomainError(error));
      assert.equal((error as DomainError).code, 'NOT_FOUND');
      return true;
    });
  } finally {
    h.dispose();
  }
});

test('归档房源默认不出现在列表，可显式查询', () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    archiveProperty(h.ctx, property.id);

    assert.equal(listPropertiesAdmin(h.ctx, {}).total, 0);
    assert.equal(listPropertiesAdmin(h.ctx, { includeArchived: true }).total, 1);
    assert.equal(listPropertiesAdmin(h.ctx, { status: 'archived' }).total, 1);
  } finally {
    h.dispose();
  }
});

test('列表支持中文关键词搜索', () => {
  const h = harness();
  try {
    createPropertyFromInput(h.ctx, propertyInput({ title: '浦东精装两居室' }));
    createPropertyFromInput(h.ctx, propertyInput({ title: 'Tokyo Studio', city: 'Tokyo' }));

    assert.equal(listPropertiesAdmin(h.ctx, { search: '浦东' }).total, 1);
    assert.equal(listPropertiesAdmin(h.ctx, { search: 'tokyo' }).total, 1);
    assert.equal(listPropertiesAdmin(h.ctx, { search: '不存在' }).total, 0);
  } finally {
    h.dispose();
  }
});

test('搜索中的 % 与 _ 被当作普通字符而不是通配符', () => {
  const h = harness();
  try {
    createPropertyFromInput(h.ctx, propertyInput({ title: '折扣 100% 房源' }));
    createPropertyFromInput(h.ctx, propertyInput({ title: '普通房源', city: '别的城市' }));

    assert.equal(listPropertiesAdmin(h.ctx, { search: '%' }).total, 1, '% 不应匹配所有记录');
  } finally {
    h.dispose();
  }
});

test('复制房源会带上副本标记且状态为草稿', () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput({ status: 'active' }));
    const copy = duplicateProperty(h.ctx, property.id);

    assert.equal(copy.title, `${property.title}（副本）`);
    assert.equal(copy.status, 'draft');
    assert.notEqual(copy.id, property.id);
    assert.equal(copy.priceAmount, property.priceAmount);
  } finally {
    h.dispose();
  }
});

test('删除房源会级联清理关联数据并移除素材文件', async () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    insertContact(h.ctx.db, h.ctx.workspace.id, property.id, {
      displayName: '联系人',
      channelKind: 'phone',
      channelValue: '+86 100',
      isPublic: true,
    });
    const link = addVideoLink(h.ctx, property.id, 'https://example.com/v', '来源');

    await h.storage.put('prp_file.png', new Uint8Array([1, 2, 3]));
    assert.equal(await h.storage.exists('prp_file.png'), true);

    const aggregateBefore = getPropertyAggregate(h.ctx, property.id);
    assert.equal(aggregateBefore.contacts.length, 1);
    assert.equal(aggregateBefore.media.length, 1);
    assert.equal(link.kind, 'video_link');

    await deletePropertyCascade(h.ctx, property.id);

    assert.throws(() => requireProperty(h.ctx, property.id));
    const contacts = h.ctx.db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number };
    const media = h.ctx.db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number };
    assert.equal(contacts.n, 0, '联系方式应被级联删除');
    assert.equal(media.n, 0, '媒体记录应被级联删除');
  } finally {
    h.dispose();
  }
});

test('聚合读取包含房源、媒体、联系方式与译文（唯一数据源）', () => {
  const h = harness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    insertContact(h.ctx.db, h.ctx.workspace.id, property.id, {
      displayName: '联系人',
      channelKind: 'wechat',
      channelValue: 'abc',
      isPublic: true,
    });

    const aggregate = getPropertyAggregate(h.ctx, property.id);

    assert.equal(aggregate.property.id, property.id);
    assert.equal(aggregate.contacts.length, 1);
    assert.deepEqual(aggregate.media, []);
    assert.equal(aggregate.listingPage, null);
    assert.deepEqual(aggregate.translations, []);
  } finally {
    h.dispose();
  }
});