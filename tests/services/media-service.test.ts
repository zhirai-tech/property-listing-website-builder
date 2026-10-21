/**
 * 媒体服务单元测试（方案第 1 阶段：照片上传与封面设置）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, propertyInput, tinyPng } from '../helpers/test-app.ts';
import { createPropertyFromInput } from '../../src/services/property-service.ts';
import {
  addUploadedMedia,
  addVideoLink,
  coverOf,
  deleteMediaItem,
  listPropertyMedia,
  reorderMediaItems,
  setCoverMedia,
  updateMediaSourceNote,
} from '../../src/services/media-service.ts';
import { isDomainError } from '../../src/domain/errors.ts';

function setup() {
  const h = createHarness();
  const { property } = createPropertyFromInput(h.ctx, propertyInput());
  return { h, propertyId: property.id };
}

test('上传照片会写入存储并入库', async () => {
  const { h, propertyId } = setup();
  try {
    const media = await addUploadedMedia(h.ctx, propertyId, {
      filename: 'cover.png',
      declaredMime: 'image/png',
      data: tinyPng(),
      sourceNote: '自有拍摄',
    });

    assert.equal(media.kind, 'photo');
    assert.equal(media.mimeType, 'image/png');
    assert.ok(media.storageKey.startsWith(propertyId), '存储键应按房源分目录');
    assert.equal(await h.storage.exists(media.storageKey), true);
    assert.equal(media.sourceNote, '自有拍摄');
    assert.equal(h.storage.count, 1);
  } finally {
    h.dispose();
  }
});

test('第一张照片自动成为封面，后续照片不抢占', async () => {
  const { h, propertyId } = setup();
  try {
    const first = await addUploadedMedia(h.ctx, propertyId, {
      filename: 'a.png',
      declaredMime: 'image/png',
      data: tinyPng(),
    });
    const second = await addUploadedMedia(h.ctx, propertyId, {
      filename: 'b.png',
      declaredMime: 'image/png',
      data: tinyPng(),
    });

    assert.equal(first.isCover, true);
    assert.equal(second.isCover, false);
  } finally {
    h.dispose();
  }
});

test('伪装成图片的文本在后端被拒绝且不会落盘', async () => {
  const { h, propertyId } = setup();
  try {
    await assert.rejects(
      addUploadedMedia(h.ctx, propertyId, {
        filename: 'evil.png',
        declaredMime: 'image/png',
        data: new TextEncoder().encode('definitely not a png'),
      }),
      (error: unknown) => isDomainError(error),
    );

    assert.equal(h.storage.count, 0, '被拒绝的文件不应写入存储');
    assert.equal(listPropertyMedia(h.ctx, propertyId).length, 0);
  } finally {
    h.dispose();
  }
});

test('设置封面保证唯一性', async () => {
  const { h, propertyId } = setup();
  try {
    await addUploadedMedia(h.ctx, propertyId, { filename: 'a.png', declaredMime: 'image/png', data: tinyPng() });
    const second = await addUploadedMedia(h.ctx, propertyId, { filename: 'b.png', declaredMime: 'image/png', data: tinyPng() });

    const after = setCoverMedia(h.ctx, propertyId, second.id);
    assert.equal(after.filter((m) => m.isCover).length, 1);
    assert.equal(coverOf(h.ctx, propertyId)?.id, second.id);
  } finally {
    h.dispose();
  }
});

test('视频不能被设为封面', async () => {
  const { h, propertyId } = setup();
  try {
    const link = addVideoLink(h.ctx, propertyId, 'https://example.com/video');
    assert.throws(() => setCoverMedia(h.ctx, propertyId, link.id), (error: unknown) => isDomainError(error));
  } finally {
    h.dispose();
  }
});

test('删除素材会同时删除文件，并在删除封面后自动补选封面', async () => {
  const { h, propertyId } = setup();
  try {
    const first = await addUploadedMedia(h.ctx, propertyId, { filename: 'a.png', declaredMime: 'image/png', data: tinyPng() });
    const second = await addUploadedMedia(h.ctx, propertyId, { filename: 'b.png', declaredMime: 'image/png', data: tinyPng() });

    assert.equal(first.isCover, true);

    await deleteMediaItem(h.ctx, first.id);

    assert.equal(await h.storage.exists(first.storageKey), false, '文件应被删除');
    const remaining = listPropertyMedia(h.ctx, propertyId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, second.id);
    assert.equal(remaining[0]?.isCover, true, '删除封面后应自动补选');
  } finally {
    h.dispose();
  }
});

test('重排媒体顺序并保持条目不丢失', async () => {
  const { h, propertyId } = setup();
  try {
    const a = await addUploadedMedia(h.ctx, propertyId, { filename: 'a.png', declaredMime: 'image/png', data: tinyPng() });
    const b = await addUploadedMedia(h.ctx, propertyId, { filename: 'b.png', declaredMime: 'image/png', data: tinyPng() });
    const c = await addUploadedMedia(h.ctx, propertyId, { filename: 'c.png', declaredMime: 'image/png', data: tinyPng() });

    const ordered = reorderMediaItems(h.ctx, propertyId, [c.id, a.id, b.id]);
    const ids = ordered.map((m) => m.id);

    assert.deepEqual(ids, [c.id, a.id, b.id]);
  } finally {
    h.dispose();
  }
});

test('外部视频链接会被规范化并记录来源说明', () => {
  const { h, propertyId } = setup();
  try {
    const link = addVideoLink(h.ctx, propertyId, 'https://example.com/tour', '房东自摄');
    assert.equal(link.kind, 'video_link');
    assert.equal(link.externalUrl, 'https://example.com/tour');
    assert.equal(link.sourceNote, '房东自摄');
  } finally {
    h.dispose();
  }
});

test('危险的视频链接协议被拒绝', () => {
  const { h, propertyId } = setup();
  try {
    assert.throws(() => addVideoLink(h.ctx, propertyId, 'javascript:alert(1)'), (error: unknown) => isDomainError(error));
  } finally {
    h.dispose();
  }
});

test('可以更新素材来源说明（用于许可证核对）', async () => {
  const { h, propertyId } = setup();
  try {
    const media = await addUploadedMedia(h.ctx, propertyId, { filename: 'a.png', declaredMime: 'image/png', data: tinyPng() });
    const updated = updateMediaSourceNote(h.ctx, media.id, 'CC0 公共领域');

    assert.equal(updated.sourceNote, 'CC0 公共领域');
  } finally {
    h.dispose();
  }
});

test('跨工作区访问素材被拒绝', async () => {
  const { h, propertyId } = setup();
  try {
    const media = await addUploadedMedia(h.ctx, propertyId, { filename: 'a.png', declaredMime: 'image/png', data: tinyPng() });
    const other = { ...h.ctx, workspace: { ...h.ctx.workspace, id: 'wsp_other' } };

    await assert.rejects(deleteMediaItem(other, media.id), (error: unknown) => isDomainError(error));
  } finally {
    h.dispose();
  }
});