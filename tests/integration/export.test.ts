/**
 * 导出接口集成测试（方案第 3 阶段验收）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, multipart, propertyInput, tinyPng } from '../helpers/test-app.ts';
import { readZip } from '../../src/util/unzip.ts';

async function publish(t: Awaited<ReturnType<typeof createTestApp>>) {
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/admin/properties',
    headers: { cookie: t.cookie },
    payload: propertyInput(),
  });
  const id = (JSON.parse(created.body).property as { id: string }).id;

  const upload = multipart('cover.png', 'image/png', tinyPng());
  await t.app.inject({
    method: 'POST',
    url: `/api/admin/properties/${id}/media`,
    headers: { cookie: t.cookie, 'content-type': upload.contentType },
    payload: upload.body,
  });

  await t.app.inject({
    method: 'POST',
    url: `/api/admin/properties/${id}/publish`,
    headers: { cookie: t.cookie },
  });

  return id;
}

test('未登录不能下载导出包', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/api/admin/properties/prp_x/export.zip' });
    assert.equal(response.statusCode, 401);
  } finally {
    await t.dispose();
  }
});

test('下载 ZIP 返回可解包的归档，含页面与素材', async () => {
  const t = await createTestApp();
  try {
    const id = await publish(t);
    const response = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}/export.zip`,
      headers: { cookie: t.cookie },
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /zip/);
    assert.match(String(response.headers['content-disposition']), /attachment/);
    assert.match(String(response.headers['content-disposition']), /filename\*=UTF-8''/, '中文文件名应使用 RFC 5987 编码');

    const entries = readZip(new Uint8Array(response.rawPayload));
    const paths = entries.map((e) => e.path);

    assert.ok(paths.includes('index.html'));
    assert.ok(paths.includes('README.txt'));
    assert.ok(paths.some((p) => p.startsWith('assets/')));

    const html = new TextDecoder().decode(entries.find((e) => e.path === 'index.html')!.data);
    assert.ok(html.includes('assets/'));
    assert.ok(!html.includes('/api/admin/'));
  } finally {
    await t.dispose();
  }
});

test('导出到服务器目录会返回真实路径', async () => {
  const t = await createTestApp();
  try {
    const id = await publish(t);
    const response = await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/export`,
      headers: { cookie: t.cookie },
      payload: {},
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as { entry: string; files: string[] };

    assert.ok(body.entry.endsWith('index.html'));
    assert.ok(body.files.includes('index.html'));

    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(body.entry), '导出的 index.html 应真实存在');
  } finally {
    await t.dispose();
  }
});

test('导出预览返回可渲染的 HTML', async () => {
  const t = await createTestApp();
  try {
    const id = await publish(t);
    const response = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}/export-preview`,
      headers: { cookie: t.cookie },
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /html/);
    assert.ok(response.body.includes('测试房源'));
  } finally {
    await t.dispose();
  }
});

test('导出未发布的房源也可以（导出不等于发布）', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });
    const id = (JSON.parse(created.body).property as { id: string }).id;

    const response = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}/export.zip`,
      headers: { cookie: t.cookie },
    });

    assert.equal(response.statusCode, 200);
  } finally {
    await t.dispose();
  }
});

test('导出不存在的房源返回 404', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/admin/properties/prp_missing/export.zip',
      headers: { cookie: t.cookie },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await t.dispose();
  }
});

test('多语言房源导出多个 HTML 文件', async () => {
  const t = await createTestApp();
  try {
    const id = await publish(t);
    await t.app.inject({
      method: 'PUT',
      url: `/api/admin/properties/${id}/translations`,
      headers: { cookie: t.cookie },
      payload: { locale: 'en', title: 'English', description: 'body' },
    });

    const response = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}/export.zip`,
      headers: { cookie: t.cookie },
    });

    const paths = readZip(new Uint8Array(response.rawPayload)).map((e) => e.path);
    assert.ok(paths.includes('index.html'));
    assert.ok(paths.includes('index.en.html'), `应包含英文页面，实际：${paths.join(', ')}`);
  } finally {
    await t.dispose();
  }
});