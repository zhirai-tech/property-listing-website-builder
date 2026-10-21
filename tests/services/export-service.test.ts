/**
 * 导出服务单元测试（方案第 3 阶段验收：导出文件可本地打开、不依赖后台）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, propertyInput, tinyPng } from '../helpers/test-app.ts';
import { createPropertyFromInput } from '../../src/services/property-service.ts';
import { addUploadedMedia } from '../../src/services/media-service.ts';
import { publishListing } from '../../src/services/publish-service.ts';
import { saveTranslation } from '../../src/services/i18n-service.ts';
import { buildExportBundle, exportListingAsZip, exportListingToDirectory } from '../../src/services/export-service.ts';
import { readZip } from '../../src/util/unzip.ts';

async function setup(options: { withTranslation?: boolean } = {}) {
  const h = createHarness();
  const { property } = createPropertyFromInput(h.ctx, propertyInput());
  await addUploadedMedia(h.ctx, property.id, {
    filename: 'a.png',
    declaredMime: 'image/png',
    data: tinyPng(),
  });
  publishListing(h.ctx, property.id);

  if (options.withTranslation) {
    saveTranslation(h.ctx, property.id, { locale: 'en', title: 'English title', description: 'English body' });
  }

  return { h, propertyId: property.id };
}

test('导出包包含 index.html、说明文件与素材', async () => {
  const { h, propertyId } = await setup();
  try {
    const bundle = await buildExportBundle(h.ctx, propertyId);
    const paths = bundle.files.map((f) => f.path);

    assert.ok(paths.includes('index.html'));
    assert.ok(paths.includes('README.txt'));
    assert.ok(paths.includes('share-url.txt'));
    assert.ok(paths.some((p) => p.startsWith('assets/')), '应包含媒体资源');
    assert.equal(bundle.notes.length > 0, true);
  } finally {
    h.dispose();
  }
});

test('导出的 HTML 使用相对路径且不引用管理后台', async () => {
  const { h, propertyId } = await setup();
  try {
    const bundle = await buildExportBundle(h.ctx, propertyId);
    const html = new TextDecoder().decode(bundle.files.find((f) => f.path === 'index.html')!.data);

    assert.ok(html.includes('assets/'), '图片应使用相对路径');
    assert.ok(!html.includes('/media/'), '不应出现绝对 /media/ 路径');
    assert.ok(!html.includes('/api/admin/'), '不应引用后台接口');
    assert.ok(!html.includes('?lang='), '导出版本不应包含会变成死链的语言查询参数');
    assert.ok(!html.includes('?nearby='), '导出版本不应包含周边信息查询链接');
    assert.ok(/<svg[^>]*shape-rendering/.test(html), '二维码应内联为 SVG');
  } finally {
    h.dispose();
  }
});

test('导出不注入地图脚本，地图直接降级为地址文本', async () => {
  const { h, propertyId } = await setup();
  try {
    const bundle = await buildExportBundle(h.ctx, propertyId);
    const html = new TextDecoder().decode(bundle.files.find((f) => f.path === 'index.html')!.data);

    assert.ok(!html.includes('leaflet.js'), '离线导出不应依赖地图库');
    assert.ok(html.includes('离线'), '应说明离线环境的地图限制');
    assert.ok(html.includes('31.2304'), '仍应显示经纬度');
  } finally {
    h.dispose();
  }
});

test('多语言导出为多个 HTML 文件并互相链接', async () => {
  const { h, propertyId } = await setup({ withTranslation: true });
  try {
    const bundle = await buildExportBundle(h.ctx, propertyId);
    const paths = bundle.files.map((f) => f.path);

    assert.ok(paths.includes('index.html'));
    assert.ok(paths.includes('index.en.html'), `应包含英文文件，实际：${paths.join(', ')}`);

    const html = new TextDecoder().decode(bundle.files.find((f) => f.path === 'index.html')!.data);
    assert.ok(html.includes('index.en.html'), '语言切换应指向本地文件');

    const enHtml = new TextDecoder().decode(bundle.files.find((f) => f.path === 'index.en.html')!.data);
    assert.ok(enHtml.includes('English title'), '英文文件应包含译文');
  } finally {
    h.dispose();
  }
});

test('导出为 ZIP 时可被正确解包，且文件名带日期', async () => {
  const { h, propertyId } = await setup();
  try {
    const result = await exportListingAsZip(h.ctx, propertyId);

    assert.ok(result.filename.endsWith('.zip'));
    assert.match(result.filename, /\d{4}-\d{2}-\d{2}/);

    const entries = readZip(result.data);
    assert.ok(entries.some((e) => e.path === 'index.html'));
    assert.equal(entries.length, result.entryCount);
  } finally {
    h.dispose();
  }
});

test('导出到目录会真实写入文件', async () => {
  const { h, propertyId } = await setup();
  try {
    const result = await exportListingToDirectory(h.ctx, propertyId, {
      outDir: `${h.workDir}/export-out`,
    });

    assert.ok(result.files.includes('index.html'));
    assert.ok(result.totalBytes > 0);

    const { existsSync, statSync } = await import('node:fs');
    const index = `${result.outDir}/index.html`;
    assert.ok(existsSync(index));
    assert.ok(statSync(index).size > 0);
  } finally {
    h.dispose();
  }
});

test('导出未发布的房源同样可用（导出不要求已发布）', async () => {
  const h = createHarness();
  try {
    const { property } = createPropertyFromInput(h.ctx, propertyInput());
    // 不调用 publishListing

    const bundle = await buildExportBundle(h.ctx, property.id);
    assert.ok(bundle.files.some((f) => f.path === 'index.html'));
  } finally {
    h.dispose();
  }
});

test('导出内容随房源修改同步更新', async () => {
  const { h, propertyId } = await setup();
  try {
    const { updatePropertyFromInput } = await import('../../src/services/property-service.ts');
    updatePropertyFromInput(h.ctx, propertyId, { priceAmount: 8888 });

    const bundle = await buildExportBundle(h.ctx, propertyId);
    const html = new TextDecoder().decode(bundle.files.find((f) => f.path === 'index.html')!.data);

    assert.ok(html.includes('8,888'), '导出内容应反映最新数据');
  } finally {
    h.dispose();
  }
});