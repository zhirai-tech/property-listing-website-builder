/**
 * ZIP 打包与解包单元测试（导出与备份都依赖它）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZip, crc32 } from '../../src/util/zip.ts';
import { readZip, ZipFormatError } from '../../src/util/unzip.ts';

const encoder = new TextEncoder();

test('crc32 与标准测试向量一致', () => {
  // 标准向量：字符串 "123456789" 的 CRC-32 为 0xCBF43926
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
});

test('打包后可以原样解包', () => {
  const files = [
    { path: 'index.html', data: encoder.encode('<html>你好</html>') },
    { path: 'assets/pic.bin', data: new Uint8Array([1, 2, 3, 4, 5]) },
  ];

  const zip = createZip(files);
  assert.equal(zip.entryCount, 2);
  assert.equal(zip.totalBytes, files[0]!.data.length + files[1]!.data.length);

  const entries = readZip(zip.data);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.path, 'index.html');
  assert.equal(new TextDecoder().decode(entries[0]!.data), '<html>你好</html>');
  assert.deepEqual([...entries[1]!.data], [1, 2, 3, 4, 5]);
});

test('中文文件名可正确往返（UTF-8 标志位）', () => {
  const zip = createZip([{ path: '导出说明/房源图片.png', data: encoder.encode('x') }]);
  const entries = readZip(zip.data);

  assert.equal(entries[0]!.path, '导出说明/房源图片.png');
});

test('空归档也能解包', () => {
  const zip = createZip([]);
  assert.equal(readZip(zip.data).length, 0);
});

test('非 ZIP 数据会被明确拒绝而不是静默返回空', () => {
  assert.throws(() => readZip(encoder.encode('this is not a zip file at all')), ZipFormatError);
});

test('损坏的归档会被明确拒绝', () => {
  const zip = createZip([{ path: 'a.txt', data: encoder.encode('hello') }]);
  // 破坏中央目录签名
  const corrupted = new Uint8Array(zip.data);
  corrupted[corrupted.length - 22] = 0x00;

  assert.throws(() => readZip(corrupted), ZipFormatError);
});

test('较大的二进制内容保持完整', () => {
  const data = new Uint8Array(200_000);
  for (let i = 0; i < data.length; i += 1) data[i] = i % 256;

  const zip = createZip([{ path: 'big.bin', data }]);
  const entries = readZip(zip.data);

  assert.equal(entries[0]!.data.length, data.length);
  assert.deepEqual(entries[0]!.data.subarray(0, 16), data.subarray(0, 16));
  assert.deepEqual(entries[0]!.data.subarray(-16), data.subarray(-16));
});