/**
 * 媒体与上传安全单元测试（方案第 8 阶段：上传文件校验）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kindForMime,
  resolveCover,
  reorderMedia,
  sniffMimeType,
  validateExternalVideoUrl,
  validateUpload,
} from '../../src/domain/media.ts';
import { DomainError, isDomainError } from '../../src/domain/errors.ts';

const policy = { maxUploadBytes: 1000, maxVideoBytes: 5000, maxPhotosPerProperty: 3 };

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const mp4 = new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const quicktime = new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);

test('通过文件头识别真实类型，而不是相信扩展名', () => {
  assert.equal(sniffMimeType(png), 'image/png');
  assert.equal(sniffMimeType(jpeg), 'image/jpeg');
  assert.equal(sniffMimeType(gif), 'image/gif');
  assert.equal(sniffMimeType(webp), 'image/webp');
  assert.equal(sniffMimeType(mp4), 'video/mp4');
  assert.equal(sniffMimeType(quicktime), 'video/quicktime');
  assert.equal(sniffMimeType(webm), 'video/webm');
});

test('无法识别的文件返回 null', () => {
  assert.equal(sniffMimeType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
  assert.equal(sniffMimeType(new TextEncoder().encode('this is definitely not an image')), null);
});

test('kindForMime 区分照片与视频', () => {
  assert.equal(kindForMime('image/png'), 'photo');
  assert.equal(kindForMime('video/mp4'), 'video_file');
  assert.equal(kindForMime('application/pdf'), null);
});

test('伪装成 PNG 的文本文件被拒绝', () => {
  const result = () => validateUpload({
    filename: 'evil.png',
    declaredMime: 'image/png',
    actualMime: sniffMimeType(new TextEncoder().encode('not an image at all')),
    byteSize: 20,
    existingPhotoCount: 0,
    policy,
  });

  assert.throws(result, (error: unknown) => {
    assert.ok(isDomainError(error));
    assert.match((error as DomainError).message, /文件校验未通过/);
    return true;
  });
});

test('扩展名与实际内容不一致会被拒绝（改名绕过）', () => {
  try {
    validateUpload({
      filename: 'photo.png',
      declaredMime: 'image/png',
      actualMime: 'image/jpeg', // 实际是 jpeg
      byteSize: 100,
      existingPhotoCount: 0,
      policy,
    });
    assert.fail('应当报错');
  } catch (error) {
    const domainError = error as DomainError;
    assert.ok(
      domainError.issues.some((i) => /不一致/.test(i.message)),
      `应提示不一致，实际：${JSON.stringify(domainError.issues)}`,
    );
  }
});

test('浏览器声明类型与实际类型不一致会被拒绝', () => {
  try {
    validateUpload({
      filename: 'a.png',
      declaredMime: 'video/mp4',
      actualMime: 'image/png',
      byteSize: 100,
      existingPhotoCount: 0,
      policy,
    });
    assert.fail('应当报错');
  } catch (error) {
    const domainError = error as DomainError;
    assert.ok(domainError.issues.some((i) => /声明/.test(i.message)));
  }
});

test('超出大小上限的照片被拒绝', () => {
  try {
    validateUpload({
      filename: 'big.png',
      declaredMime: 'image/png',
      actualMime: 'image/png',
      byteSize: 5000,
      existingPhotoCount: 0,
      policy,
    });
    assert.fail('应当报错');
  } catch (error) {
    assert.match((error as DomainError).message, /文件校验未通过/);
  }
});

test('超出数量上限的照片被拒绝', () => {
  try {
    validateUpload({
      filename: 'a.png',
      declaredMime: 'image/png',
      actualMime: 'image/png',
      byteSize: 100,
      existingPhotoCount: 3,
      policy,
    });
    assert.fail('应当报错');
  } catch (error) {
    const domainError = error as DomainError;
    assert.ok(domainError.issues.some((i) => /最多上传 3 张/.test(i.message)));
  }
});

test('不支持的扩展名被拒绝', () => {
  try {
    validateUpload({
      filename: 'script.exe',
      declaredMime: 'image/png',
      actualMime: 'image/png',
      byteSize: 100,
      existingPhotoCount: 0,
      policy,
    });
    assert.fail('应当报错');
  } catch (error) {
    assert.ok((error as DomainError).issues.some((i) => /不支持的文件扩展名/.test(i.message)));
  }
});

test('合法 PNG 通过校验并识别为照片', () => {
  const result = validateUpload({
    filename: 'ok.png',
    declaredMime: 'image/png',
    actualMime: 'image/png',
    byteSize: 500,
    existingPhotoCount: 0,
    policy,
  });

  assert.equal(result.kind, 'photo');
  assert.equal(result.mimeType, 'image/png');
});

test('外部视频链接拒绝 javascript: 等危险协议', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'not a url']) {
    assert.throws(() => validateExternalVideoUrl(bad), `应拒绝：${bad}`);
  }
});

test('外部视频链接接受 http/https 并规范化', () => {
  const url = validateExternalVideoUrl('https://example.com/video?id=1');
  assert.equal(url, 'https://example.com/video?id=1');
});

test('重排媒体时未出现在请求中的条目会追加到末尾，不会丢失', () => {
  const current = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ordered = reorderMedia(current, ['c', 'a']);

  assert.deepEqual(ordered, ['c', 'a', 'b']);
});

test('重排会忽略未知 id', () => {
  const current = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(reorderMedia(current, ['zzz', 'b', 'a']), ['b', 'a']);
});

test('封面解析保证每个房源至多一张封面', () => {
  const current = [
    { id: 'p1', isCover: false, kind: 'photo' as const },
    { id: 'p2', isCover: true, kind: 'photo' as const },
    { id: 'v1', isCover: false, kind: 'video_link' as const },
  ];

  const map = resolveCover(current, null);
  assert.equal(map.get('p2'), true);
  assert.equal([...map.values()].filter(Boolean).length, 1);
});

test('指定封面时以指定项为准', () => {
  const current = [
    { id: 'p1', isCover: true, kind: 'photo' as const },
    { id: 'p2', isCover: false, kind: 'photo' as const },
  ];

  const map = resolveCover(current, 'p2');
  assert.equal(map.get('p2'), true);
  assert.equal(map.get('p1'), false);
});

test('没有照片时不会产生封面', () => {
  const map = resolveCover([{ id: 'v1', isCover: false, kind: 'video_link' as const }], null);
  assert.equal([...map.values()].filter(Boolean).length, 0);
});