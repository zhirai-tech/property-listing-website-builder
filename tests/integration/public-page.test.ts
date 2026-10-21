/**
 * 公开展示页集成测试（方案第 2 阶段验收）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, multipart, propertyInput, tinyPng } from '../helpers/test-app.ts';

async function publishOne(t: Awaited<ReturnType<typeof createTestApp>>, overrides: Record<string, unknown> = {}) {
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/admin/properties',
    headers: { cookie: t.cookie },
    payload: propertyInput(overrides),
  });
  const id = (JSON.parse(created.body).property as { id: string }).id;

  const listing = await t.app.inject({
    method: 'GET',
    url: `/api/admin/properties/${id}/listing`,
    headers: { cookie: t.cookie },
  });
  const slug = (JSON.parse(listing.body).page as { slug: string }).slug;

  await t.app.inject({
    method: 'POST',
    url: `/api/admin/properties/${id}/publish`,
    headers: { cookie: t.cookie },
  });

  return { id, slug, listing: JSON.parse(listing.body) };
}

test('未发布页面公开访问返回 404 且不泄露房源是否存在', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });
    const id = (JSON.parse(created.body).property as { id: string }).id;

    const listing = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}/listing`,
      headers: { cookie: t.cookie },
    });
    const slug = (JSON.parse(listing.body).page as { slug: string }).slug;

    const notPublished = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` });
    const neverExisted = await t.app.inject({ method: 'GET', url: '/p/definitely-not-a-page' });

    assert.equal(notPublished.statusCode, 404);
    assert.equal(neverExisted.statusCode, 404);

    // 每次响应的 CSP nonce 不同，因此比较时先剥离 nonce，再确认正文完全一致，
    // 避免通过响应差异探测「该房源是否曾经存在」。
    const strip = (html: string): string => html.replace(/nonce="[^"]*"/g, 'nonce="X"');
    assert.equal(strip(notPublished.body), strip(neverExisted.body), '两种情况响应应完全一致');
  } finally {
    await t.dispose();
  }
});

test('发布后页面包含标题、价格、地址与二维码', async () => {
  const t = await createTestApp();
  try {
    const { slug } = await publishOne(t);
    const page = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` });

    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('测试房源 · 两居室'));
    assert.ok(page.body.includes('5,000'), '应包含格式化价格');
    assert.ok(page.body.includes('测试路 1 号'), '应包含地址');
    assert.ok(/<svg[^>]*shape-rendering/.test(page.body), '应内联二维码');
    assert.ok(page.body.includes('viewport'), '应包含响应式 viewport');
    assert.ok(page.body.includes('class="minimap"'), '在线页面应包含内置地图容器');
    assert.ok(!page.body.includes('leaflet'), '不应再依赖任何第三方地图库');
  } finally {
    await t.dispose();
  }
});

test('修改房源后展示页立即同步', async () => {
  const t = await createTestApp();
  try {
    const { id, slug } = await publishOne(t);

    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/properties/${id}`,
      headers: { cookie: t.cookie },
      payload: { priceAmount: 9999, title: '改名后的房源' },
    });

    const page = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` });
    assert.ok(page.body.includes('9,999'));
    assert.ok(page.body.includes('改名后的房源'));
  } finally {
    await t.dispose();
  }
});

test('撤下后立即不可访问，重新发布又可访问', async () => {
  const t = await createTestApp();
  try {
    const { id, slug } = await publishOne(t);
    const url = `/p/${encodeURIComponent(slug)}`;

    assert.equal((await t.app.inject({ method: 'GET', url })).statusCode, 200);

    await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/withdraw`,
      headers: { cookie: t.cookie },
    });
    assert.equal((await t.app.inject({ method: 'GET', url })).statusCode, 404);

    await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/publish`,
      headers: { cookie: t.cookie },
    });
    assert.equal((await t.app.inject({ method: 'GET', url })).statusCode, 200);
  } finally {
    await t.dispose();
  }
});

test('多语言：?lang=en 显示译文，原文仍在后台', async () => {
  const t = await createTestApp();
  try {
    const { id, slug } = await publishOne(t);

    await t.app.inject({
      method: 'PUT',
      url: `/api/admin/properties/${id}/translations`,
      headers: { cookie: t.cookie },
      payload: { locale: 'en', title: 'English title', description: 'English body' },
    });

    const en = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}?lang=en` });
    assert.ok(en.body.includes('English title'));
    assert.ok(en.body.includes('English body'));
    assert.ok(en.body.includes('Price'), '界面文案也应切换为英文');

    const detail = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}`,
      headers: { cookie: t.cookie },
    });
    assert.equal(JSON.parse(detail.body).property.description, '用于自动化测试的房源描述。');
  } finally {
    await t.dispose();
  }
});

test('语言切换链接只列出可用语言', async () => {
  const t = await createTestApp();
  try {
    const { slug } = await publishOne(t);
    const page = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` });

    // 只有原文语言时不应渲染语言切换栏
    assert.ok(!page.body.includes('class="langbar"'), '仅一种语言时不应显示切换栏');
  } finally {
    await t.dispose();
  }
});

test('只有公开的联系方式出现在页面上', async () => {
  const t = await createTestApp();
  try {
    const { slug } = await publishOne(t);
    const page = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` });

    assert.ok(page.body.includes('未公开联系方式'), '没有公开联系方式时应明确说明');
  } finally {
    await t.dispose();
  }
});

test('二维码接口返回 SVG', async () => {
  const t = await createTestApp();
  try {
    const { slug } = await publishOne(t);
    const qr = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}/qr.svg` });

    assert.equal(qr.statusCode, 200);
    assert.match(String(qr.headers['content-type']), /svg/);
    assert.ok(qr.body.includes('<svg'));
  } finally {
    await t.dispose();
  }
});

test('未发布房源的二维码同样返回 404', async () => {
  const t = await createTestApp();
  try {
    const qr = await t.app.inject({ method: 'GET', url: '/p/nonexistent/qr.svg' });
    assert.equal(qr.statusCode, 404);
  } finally {
    await t.dispose();
  }
});

test('页面内容对 HTML 特殊字符做转义（防存储型 XSS）', async () => {
  const t = await createTestApp();
  try {
    const { slug } = await publishOne(t, {
      title: '<script>alert(1)</script>恶意标题',
      description: '<img src=x onerror=alert(2)>',
    });

    const page = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` });

    assert.ok(!page.body.includes('<script>alert(1)</script>'), '标题中的脚本必须被转义');
    assert.ok(!page.body.includes('onerror=alert(2)>'), '描述中的事件处理器必须被转义');
    assert.ok(page.body.includes('&lt;script&gt;'), '应输出转义后的文本');
  } finally {
    await t.dispose();
  }
});

test('照片上传后出现在展示页且使用 /media 路径', async () => {
  const t = await createTestApp();
  try {
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

    const listing = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}/listing`,
      headers: { cookie: t.cookie },
    });
    const slug = (JSON.parse(listing.body).page as { slug: string }).slug;

    await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/publish`,
      headers: { cookie: t.cookie },
    });

    const page = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` });
    assert.ok(page.body.includes('/media/'), '展示页应引用 /media 下的图片');

    // 图片本身可被匿名访问
    const match = /\/media\/[^"]+\.png/.exec(page.body);
    assert.ok(match, '页面应包含图片地址');
    const image = await t.app.inject({ method: 'GET', url: match[0] });
    assert.equal(image.statusCode, 200);
  } finally {
    await t.dispose();
  }
});

/**
 * 展示页的移动端结构与状态标签（本轮新增能力的回归测试）。
 */

/** 给房源上传 n 张照片（轮播、页码等只在多图时才渲染） */
async function uploadPhotos(
  t: Awaited<ReturnType<typeof createTestApp>>,
  propertyId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const upload = multipart(`photo-${i}.png`, 'image/png', tinyPng());
    const response = await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/media`,
      headers: { cookie: t.cookie, 'content-type': upload.contentType },
      payload: upload.body,
    });
    if (response.statusCode >= 300) throw new Error('上传照片失败: ' + response.body);
  }
}
test('展示页包含顶部栏、主图状态标签、自动轮播与底部菜单栏', async () => {
  const t = await createTestApp();
  try {
    const { id, slug } = await publishOne(t, { availabilityStatus: 'available' });
    await uploadPhotos(t, id, 2);

    // 有译文时才会出现语言切换（只有一种语言时无需切换）
    await t.app.inject({
      method: 'PUT',
      url: `/api/admin/properties/${id}/translations`,
      headers: { cookie: t.cookie },
      payload: { locale: 'en', title: 'English title', description: 'English body' },
    });

    const page = await t.app.inject({ method: 'GET', url: '/p/' + encodeURIComponent(slug) });

    assert.ok(page.body.includes('class="topnav"'), '应有顶部栏');
    assert.ok(page.body.includes('class="langbar"'), '语言切换应位于顶部栏内');

    // 语言切换必须出现在顶部栏之后、摘要之前，不能又回到标题下面
    const topnavAt = page.body.indexOf('class="topnav"');
    const summaryAt = page.body.indexOf('class="summary"');
    assert.ok(topnavAt > 0 && topnavAt < summaryAt, '语言切换应排在标题摘要之前');

    assert.ok(page.body.includes('hero-badge st-available'), '主图应有「出租中」状态标签');
    assert.ok(page.body.includes('class="appbar"'), '手机端应有底部菜单栏');
    assert.ok(page.body.includes('data-autoplay="1"'), '多张照片时应启用自动轮播');
  } finally {
    await t.dispose();
  }
});

test('状态标签、计数与圆点必须位于滚动容器之外', async () => {
  const t = await createTestApp();
  try {
    const { id, slug } = await publishOne(t);
    await uploadPhotos(t, id, 2);
    const page = await t.app.inject({ method: 'GET', url: '/p/' + encodeURIComponent(slug) });

    // .gallery 是横向滚动容器；标签若在它内部会随图片滚出屏幕。
    const mediaAt = page.body.indexOf('class="hero-media"');
    const galleryAt = page.body.indexOf('class="gallery"');
    const galleryEnd = page.body.indexOf('</div>', page.body.indexOf('id="gallery"'));
    // 注意：内联 CSS 里也有 .hero-badge，必须搜真正的元素，否则会匹配到 <head> 里的规则
    const badgeAt = page.body.indexOf('<span class="hero-badge');
    const counterAt = page.body.indexOf('id="counter"');

    assert.ok(mediaAt > 0, '应有不滚动的外层容器 .hero-media');
    assert.ok(badgeAt > galleryEnd, '状态标签应在滚动容器之外');
    assert.ok(counterAt > galleryEnd, '页码计数应在滚动容器之外');
    assert.ok(galleryAt > mediaAt, '.gallery 应位于 .hero-media 内部');
  } finally {
    await t.dispose();
  }
});

test('可租状态经 API 往返后仍正确，并反映在展示页上', async () => {
  const t = await createTestApp();
  try {
    const { id, slug } = await publishOne(t, { availabilityStatus: 'rented' });
    const page = await t.app.inject({ method: 'GET', url: '/p/' + encodeURIComponent(slug) });

    const detail = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}`,
      headers: { cookie: t.cookie },
    });
    const property = (JSON.parse(detail.body).property) as { availabilityStatus: string };
    assert.equal(property.availabilityStatus, 'rented', '已租状态应被持久化');

    assert.ok(page.body.includes('hero-badge st-rented'), '展示页应显示「已租」标签');
    assert.ok(!page.body.includes('<p class="stale-note">'), '已租不应再提示未确认');
  } finally {
    await t.dispose();
  }
});

test('拒绝非法的可租状态取值', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput({ availabilityStatus: 'unconfirmed' }),
    });

    // unconfirmed 只能由系统按陈旧度推导，不允许房东手工设置
    assert.equal(created.statusCode, 400, '手工设置 unconfirmed 应被拒绝');
  } finally {
    await t.dispose();
  }
});