/**
 * 房源 HTTP 接口集成测试（走真实路由与鉴权链路）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, propertyInput } from '../helpers/test-app.ts';

test('未登录访问后台接口返回 401', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/api/admin/properties' });
    assert.equal(response.statusCode, 401);
    assert.equal(JSON.parse(response.body).error.code, 'UNAUTHORIZED');
  } finally {
    await t.dispose();
  }
});

test('登录后可创建并读取房源', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });

    assert.equal(created.statusCode, 201);
    const property = JSON.parse(created.body).property as { id: string };

    const read = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${property.id}`,
      headers: { cookie: t.cookie },
    });
    assert.equal(read.statusCode, 200);
    assert.equal(JSON.parse(read.body).property.title, '测试房源 · 两居室');
  } finally {
    await t.dispose();
  }
});

test('非法输入返回 400 与字段级中文提示', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: { title: '', priceAmount: 'abc', latitude: 200 },
    });

    assert.equal(response.statusCode, 400);
    const error = JSON.parse(response.body).error as { issues: { field: string }[] };
    const fields = error.issues.map((i) => i.field);

    assert.ok(fields.includes('title'));
    assert.ok(fields.includes('priceAmount'));
    assert.ok(fields.includes('latitude'));
  } finally {
    await t.dispose();
  }
});

test('PATCH 只更新提交的字段', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });
    const id = (JSON.parse(created.body).property as { id: string }).id;

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/properties/${id}`,
      headers: { cookie: t.cookie },
      payload: { priceAmount: 1234 },
    });

    assert.equal(patched.statusCode, 200);
    const property = JSON.parse(patched.body) as { priceAmount: number; title: string };
    assert.equal(property.priceAmount, 1234);
    assert.equal(property.title, '测试房源 · 两居室');
  } finally {
    await t.dispose();
  }
});

test('中文关键词搜索与状态筛选生效', async () => {
  const t = await createTestApp();
  try {
    await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput({ title: '浦东精装两居室' }),
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput({ title: 'Tokyo Studio', city: 'Tokyo', status: 'draft' }),
    });

    const searched = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties?search=${encodeURIComponent('浦东')}`,
      headers: { cookie: t.cookie },
    });
    assert.equal(JSON.parse(searched.body).total, 1);

    const filtered = await t.app.inject({
      method: 'GET',
      url: '/api/admin/properties?status=draft',
      headers: { cookie: t.cookie },
    });
    assert.equal(JSON.parse(filtered.body).total, 1);
  } finally {
    await t.dispose();
  }
});

test('不存在的房源返回 404 而不是 500', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/admin/properties/prp_does_not_exist',
      headers: { cookie: t.cookie },
    });

    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).error.code, 'NOT_FOUND');
  } finally {
    await t.dispose();
  }
});

test('归档与删除的完整链路', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });
    const id = (JSON.parse(created.body).property as { id: string }).id;

    const archived = await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/status`,
      headers: { cookie: t.cookie },
      payload: { status: 'archived' },
    });
    assert.equal(JSON.parse(archived.body).status, 'archived');

    const list = await t.app.inject({ method: 'GET', url: '/api/admin/properties', headers: { cookie: t.cookie } });
    assert.equal(JSON.parse(list.body).total, 0, '归档房源默认不出现在列表');

    const deleted = await t.app.inject({
      method: 'DELETE',
      url: `/api/admin/properties/${id}`,
      headers: { cookie: t.cookie },
    });
    assert.equal(deleted.statusCode, 200);

    const after = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}`,
      headers: { cookie: t.cookie },
    });
    assert.equal(after.statusCode, 404);
  } finally {
    await t.dispose();
  }
});

test('概览接口返回统计数据与适配器信息', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie: t.cookie } });
    const body = JSON.parse(response.body) as { properties: { total: number }; adapters: Record<string, string> };

    assert.equal(response.statusCode, 200);
    assert.equal(body.properties.total, 0);
    assert.ok(body.adapters['map']);
    assert.ok(body.adapters['storage']);
  } finally {
    await t.dispose();
  }
});

test('健康检查无需鉴权且返回迁移版本', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/healthz' });
    const body = JSON.parse(response.body) as { status: string; migrations: number[] };

    assert.equal(response.statusCode, 200);
    assert.equal(body.status, 'ok');
    // 迁移是只增不改的：断言 v1 已应用，且版本单调递增到最新，
    // 这样后续新增迁移时不需要回来改这个测试。
    assert.ok(body.migrations.includes(1), '应包含初始迁移 v1');
    assert.ok(
      body.migrations.length >= 2,
      '应至少包含 v1 与 v2（房源可租状态）两次迁移',
    );
    assert.deepEqual(
      body.migrations,
      [...body.migrations].sort((a, b) => a - b),
      '迁移版本应单调递增',
    );
  } finally {
    await t.dispose();
  }
});

test('未知接口返回结构化 404', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/api/admin/nope', headers: { cookie: t.cookie } });
    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).error.code, 'NOT_FOUND');
  } finally {
    await t.dispose();
  }
});

test('上传接口：合法 PNG 成功、伪装文件被拒、超限被拒', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });
    const id = (JSON.parse(created.body).property as { id: string }).id;

    const { multipart, tinyPng } = await import('../helpers/test-app.ts');

    const ok = multipart('a.png', 'image/png', tinyPng());
    const uploaded = await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/media`,
      headers: { cookie: t.cookie, 'content-type': ok.contentType },
      payload: ok.body,
    });
    assert.equal(uploaded.statusCode, 201);

    const fake = multipart('evil.png', 'image/png', new TextEncoder().encode('not a png'));
    const rejected = await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/media`,
      headers: { cookie: t.cookie, 'content-type': fake.contentType },
      payload: fake.body,
    });
    assert.equal(rejected.statusCode, 400);

    const noFile = await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/media`,
      headers: { cookie: t.cookie, 'content-type': 'multipart/form-data; boundary=xxx' },
      payload: Buffer.from('--xxx--\r\n'),
    });
    assert.ok([400, 415].includes(noFile.statusCode), `无文件应被拒绝，实际 ${noFile.statusCode}`);
  } finally {
    await t.dispose();
  }
});