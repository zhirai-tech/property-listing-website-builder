/**
 * 安全相关集成测试（方案第 8 阶段安全检查项）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_PASSWORD, createTestApp, multipart, propertyInput, tinyPng } from '../helpers/test-app.ts';
import { LoginRateLimiter } from '../../src/http/security.ts';

/** 创建并发布一条房源，返回其公开 slug */
async function publishOne(t: Awaited<ReturnType<typeof createTestApp>>): Promise<string> {
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

  await t.app.inject({
    method: 'POST',
    url: `/api/admin/properties/${id}/publish`,
    headers: { cookie: t.cookie },
  });

  return slug;
}

test('公开页 CSP 使用 nonce 且脚本不允许 unsafe-inline', async () => {
  const t = await createTestApp();
  try {
    const slug = await publishOne(t);
    const page = await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` });
    const csp = String(page.headers['content-security-policy']);

    assert.match(csp, /script-src 'self' 'nonce-[^']+'/, '脚本应使用 nonce');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'script-src 不得包含 unsafe-inline');
    assert.ok(!/script-src[^;]*unsafe-eval/.test(csp), 'script-src 不得包含 unsafe-eval');
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);

    // 页面里的内联脚本必须带上同一个 nonce
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce);
    assert.ok(page.body.includes(`nonce="${nonce}"`), '内联脚本/样式应带 nonce');
  } finally {
    await t.dispose();
  }
});

test('含地图的公开页允许内联样式（Leaflet 必需），但不放宽脚本', async () => {
  const t = await createTestApp();
  try {
    const slug = await publishOne(t);
    const csp = String(
      (await t.app.inject({ method: 'GET', url: `/p/${encodeURIComponent(slug)}` })).headers[
        'content-security-policy'
      ],
    );

    // Leaflet 通过 style 属性定位瓦片，因此公开页的 style-src 必须允许内联样式；
    // 注意：style-src 带 nonce 时浏览器会忽略 unsafe-inline，所以二者不能并存。
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.ok(!/style-src[^;]*nonce/.test(csp), 'style-src 不应同时带 nonce');
  } finally {
    await t.dispose();
  }
});

test('后台预览页使用与公开页一致的 CSP（含 nonce 与地图所需的内联样式）', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });
    const id = (JSON.parse(created.body).property as { id: string }).id;

    const preview = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${id}/preview`,
      headers: { cookie: t.cookie },
    });

    assert.equal(preview.statusCode, 200);

    const csp = String(preview.headers['content-security-policy']);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];

    // 预览页同样渲染内联脚本，必须带 nonce，否则交互与地图会被 CSP 拦掉
    assert.ok(nonce, '预览页 CSP 应包含 nonce');
    assert.ok(preview.body.includes(`nonce="${nonce}"`), '预览页的内联脚本/样式应带同一个 nonce');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), '预览页脚本不得放宽 unsafe-inline');
    assert.match(csp, /style-src 'self' 'unsafe-inline'/, '预览页含地图，样式需允许内联');
    assert.equal(preview.headers['x-robots-tag'], 'noindex', '预览页不应被搜索引擎收录');
  } finally {
    await t.dispose();
  }
});

test('后台接口的 CSP 不放宽内联样式', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie: t.cookie } });
    const csp = String(response.headers['content-security-policy']);

    assert.ok(!/style-src[^;]*unsafe-inline/.test(csp), '后台不应放宽内联样式');
    assert.match(csp, /style-src 'self' 'nonce-/);
  } finally {
    await t.dispose();
  }
});

test('统一安全响应头存在', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/healthz' });

    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.ok(response.headers['permissions-policy']);
  } finally {
    await t.dispose();
  }
});

test('后台接口不缓存', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie: t.cookie } });
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    await t.dispose();
  }
});

test('登录失败次数过多会被限流', async () => {
  const t = await createTestApp();
  try {
    let sawRateLimit = false;

    for (let i = 0; i < 8; i += 1) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/admin/login',
        payload: { password: `wrong-${i}` },
      });

      if (response.statusCode === 429) {
        sawRateLimit = true;
        assert.match(JSON.parse(response.body).error.message, /过于频繁/);
        break;
      }
    }

    assert.equal(sawRateLimit, true, '连续失败应触发限流');
  } finally {
    await t.dispose();
  }
});

test('退出登录后会话失效', async () => {
  const t = await createTestApp();
  try {
    const before = await t.app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie: t.cookie } });
    assert.equal(JSON.parse(before.body).authenticated, true);

    const logout = await t.app.inject({ method: 'POST', url: '/api/admin/logout', headers: { cookie: t.cookie } });
    const cleared = String(logout.headers['set-cookie']);
    assert.match(cleared, /admin_session=;/, '应下发清除 Cookie 的指令');
  } finally {
    await t.dispose();
  }
});

test('伪造的会话 Cookie 不被接受', async () => {
  const t = await createTestApp();
  try {
    // 结构合法、签名伪造
    const forgedPayload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 1e9, role: 'admin' }))
      .toString('base64url');

    const forged = await t.app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: `admin_session=${forgedPayload}.forged-signature` },
    });

    assert.equal(forged.statusCode, 401);
  } finally {
    await t.dispose();
  }
});

test('过期会话不被接受', async () => {
  const t = await createTestApp();
  try {
    const expiredPayload = Buffer.from(
      JSON.stringify({ iat: Date.now() - 1e6, exp: Date.now() - 1000, role: 'admin' }),
    ).toString('base64url');

    const response = await t.app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: `admin_session=${expiredPayload}.whatever` },
    });

    assert.equal(response.statusCode, 401);
  } finally {
    await t.dispose();
  }
});

test('诊断接口不泄露密钥明文', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({ method: 'GET', url: '/api/admin/diagnostics', headers: { cookie: t.cookie } });

    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes(t.harness.config.adminPassword), '不得返回管理口令');
    assert.ok(!response.body.includes(t.harness.config.sessionSecret), '不得返回会话密钥');
    assert.ok(response.body.includes('已设置'), '应只说明是否已设置');
  } finally {
    await t.dispose();
  }
});

test('媒体路径穿越与非法路径被拒绝', async () => {
  const t = await createTestApp();
  try {
    for (const path of ['/media/../../package.json', '/media/..%2F..%2Fpackage.json', '/media/']) {
      const response = await t.app.inject({ method: 'GET', url: path });
      assert.ok(
        [400, 404].includes(response.statusCode),
        `${path} 应被拒绝，实际 ${response.statusCode}`,
      );
    }
  } finally {
    await t.dispose();
  }
});

test('媒体内容不能被当作 HTML 执行（nosniff + 正确 Content-Type）', async () => {
  const t = await createTestApp();
  try {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });
    const id = (JSON.parse(created.body).property as { id: string }).id;

    const upload = multipart('a.png', 'image/png', tinyPng());
    const uploaded = await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${id}/media`,
      headers: { cookie: t.cookie, 'content-type': upload.contentType },
      payload: upload.body,
    });
    const media = JSON.parse(uploaded.body) as { storageKey: string };

    const response = await t.app.inject({ method: 'GET', url: `/media/${media.storageKey}` });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(String(response.headers['content-type']), /image\/png/);
  } finally {
    await t.dispose();
  }
});

test('错误响应不泄漏内部堆栈', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: { title: '' },
    });

    assert.equal(response.statusCode, 400);
    assert.ok(!response.body.includes('at Object.'), '不得返回堆栈');
    assert.ok(!response.body.includes('node_modules'), '不得返回内部路径');
  } finally {
    await t.dispose();
  }
});

test('超长请求体被拒绝', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x'.repeat(3 * 1024 * 1024) }),
    });

    assert.ok(response.statusCode >= 400, `超长请求应被拒绝，实际 ${response.statusCode}`);
  } finally {
    await t.dispose();
  }
});

test('带疑似密钥字段的外部服务配置被拒绝保存', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/external-services',
      headers: { cookie: t.cookie },
      payload: {
        adapterKind: 'map',
        provider: 'mapbox',
        config: { tileUrl: 'https://example.com/{z}', apiKey: 'sk-secret-value' },
        secretRefs: ['MAP_API_KEY'],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body, /疑似密钥/);

    // 合法配置可以保存，且密钥只以环境变量名的形式存在
    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/external-services',
      headers: { cookie: t.cookie },
      payload: {
        adapterKind: 'map',
        provider: 'mapbox',
        config: { tileUrl: 'https://example.com/{z}' },
        secretRefs: ['MAP_API_KEY'],
      },
    });

    assert.equal(ok.statusCode, 200);
    assert.deepEqual(JSON.parse(ok.body).secretRefs, ['MAP_API_KEY']);
    assert.ok(!ok.body.includes('sk-secret-value'), '响应中不得出现密钥值');
  } finally {
    await t.dispose();
  }
});


// ---------------------------------------------------------------------------
// 后台鉴权：路径解析差异导致的绕过（回归测试）
// ---------------------------------------------------------------------------

/**
 * 生成一个路径的百分号编码变体。
 *
 * 漏洞原理：守卫跑在 `onRequest` 阶段（**路由匹配之前**），只能拿原始 URL 判断前缀；
 * 而 Fastify 路由用**解码后**的路径匹配。把 `api` / `admin` 里的任意字母写成 `%XX`，
 * 守卫认不出前缀而路由器照样命中后台路由 —— 鉴权就被跳过了。
 *
 * 这里**逐位生成**变体，而不是只测报告里那几个 URL：
 * 只要「守卫看的路径」与「路由器匹配的路径」还能不一致，任何一个位置都会成为入口。
 */
function encodedPathVariants(path: string): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [{ label: '原文', url: path }];

  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i] as string;
    if (!/[a-zA-Z]/.test(ch)) continue;
    const enc = `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
    out.push({ label: `第 ${i} 位 ${ch}→${enc}`, url: path.slice(0, i) + enc + path.slice(i + 1) });
  }

  out.push({ label: 'api 整段编码', url: path.replace('/api/', '/%61%70%69/') });
  out.push({ label: 'admin 整段编码', url: path.replace('/admin/', '/%61%64%6d%69%6e/') });
  return out;
}

/** 需要鉴权的接口样本：覆盖读、写、删三类能力 */
const PROTECTED_TARGETS: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string }[] = [
  { method: 'GET', path: '/api/admin/overview' },
  { method: 'GET', path: '/api/admin/properties' },
  { method: 'GET', path: '/api/admin/settings' },
  { method: 'GET', path: '/api/admin/backups' },
  { method: 'POST', path: '/api/admin/properties/validate' },
  { method: 'DELETE', path: '/api/admin/properties/prp_nonexistent' },
];

test('后台接口：未登录时路径编码变体不能绕过鉴权', async () => {
  const t = await createTestApp();
  try {
    const bypassed: string[] = [];

    for (const target of PROTECTED_TARGETS) {
      for (const variant of encodedPathVariants(target.path)) {
        const response = await t.app.inject({
          method: target.method,
          url: variant.url,
          ...(target.method === 'POST' ? { payload: {} } : {}),
        });

        // 401 = 被正确拦截；404 = 压根没匹配到路由（同样安全）。
        // 其余任何状态码都意味着守卫被跳过、请求摸到了后端逻辑。
        if (response.statusCode !== 401 && response.statusCode !== 404) {
          bypassed.push(`${target.method} ${variant.url} （${variant.label}）→ ${response.statusCode}`);
        }
      }
    }

    assert.deepEqual(bypassed, [], `以下编码变体绕过了后台鉴权：\n${bypassed.join('\n')}`);
  } finally {
    await t.dispose();
  }
});

test('后台接口：未登录时不得产生任何业务副作用', async () => {
  const t = await createTestApp();
  try {
    // 这条路径若被放行会真的创建一条发布页记录（ensureListingPage 有写操作）
    const before = t.harness.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM listing_pages')
      .get() as { n: number };

    await t.app.inject({ method: 'GET', url: '/%61pi/admin/properties' });
    await t.app.inject({ method: 'GET', url: '/%61pi/admin/pages' });
    await t.app.inject({ method: 'POST', url: '/%61pi/admin/properties/validate', payload: {} });

    const after = t.harness.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM listing_pages')
      .get() as { n: number };

    assert.equal(after.n, before.n, '未授权请求不应产生任何写入');
  } finally {
    await t.dispose();
  }
});

test('后台接口：已登录的合法请求仍然可用（修复不得误伤）', async () => {
  const t = await createTestApp();
  try {
    for (const target of PROTECTED_TARGETS) {
      const response = await t.app.inject({
        method: target.method,
        url: target.path,
        headers: { cookie: t.cookie },
        ...(target.method === 'POST' ? { payload: { title: '测试房源' } } : {}),
      });

      assert.notEqual(
        response.statusCode,
        401,
        `已登录访问 ${target.method} ${target.path} 不应被拒绝（实际 ${response.statusCode}）`,
      );
    }
  } finally {
    await t.dispose();
  }
});

test('后台接口：已登录时编码路径同样可用（合法请求不应因编码被误判）', async () => {
  const t = await createTestApp();
  try {
    const response = await t.app.inject({
      method: 'GET',
      url: '/%61pi/admin/overview',
      headers: { cookie: t.cookie },
    });
    assert.equal(response.statusCode, 200, '已登录时编码路径也应正常返回');
  } finally {
    await t.dispose();
  }
});

test('鉴权改动不影响登录接口、会话接口与公开页面', async () => {
  const t = await createTestApp();
  try {
    // 登录接口必须保持匿名可达，否则谁也进不来。
    // 注意：错误口令本来就返回 401（凭据错误），所以无法用状态码区分
    // 「被守卫拦下」与「口令不对」—— 必须用**正确口令能否匿名登录成功**来证明。
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: TEST_PASSWORD },
    });
    assert.equal(login.statusCode, 200, '登录接口必须保持匿名可达，且正确口令应登录成功');

    // 会话探测接口匿名可达
    const session = await t.app.inject({ method: 'GET', url: '/api/admin/session' });
    assert.notEqual(session.statusCode, 401, '会话探测接口应匿名可达');

    // 后台静态界面匿名可达（登录页必须能打开）
    const adminIndex = await t.app.inject({ method: 'GET', url: '/admin/' });
    assert.equal(adminIndex.statusCode, 200, '后台登录页应可访问');

    // 公开房源页不受影响
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/admin/properties',
      headers: { cookie: t.cookie },
      payload: propertyInput(),
    });
    const propertyId = (JSON.parse(created.body) as { property: { id: string } }).property.id;
    await t.app.inject({
      method: 'POST',
      url: `/api/admin/properties/${propertyId}/publish`,
      headers: { cookie: t.cookie },
    });
    const listing = await t.app.inject({
      method: 'GET',
      url: `/api/admin/properties/${propertyId}/listing`,
      headers: { cookie: t.cookie },
    });
    const slug = (JSON.parse(listing.body) as { page: { slug: string } }).page.slug;

    const publicPage = await t.app.inject({ method: 'GET', url: `/p/${slug}` });
    assert.equal(publicPage.statusCode, 200, '公开房源页必须仍可匿名访问');

    const health = await t.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200, '健康检查必须仍可匿名访问');
  } finally {
    await t.dispose();
  }
});

// ---------------------------------------------------------------------------
// 限流不可被 X-Forwarded-For 绕过（回归测试）
// ---------------------------------------------------------------------------

/**
 * 漏洞原理：`trustProxy: true` 时 Fastify 的 `request.ip` 读的是
 * `X-Forwarded-For` 头 —— 那是**客户端可以随便写的**。
 * 用它做限流键，等于把限流键交给攻击者：轮换伪造 IP 就能无限尝试口令。
 *
 * 修法：默认 `trustProxy: false`（此时 request.ip 取 TCP 对端地址，
 * 伪造的 XFF 头完全不起作用），同时增加**不依赖任何客户端输入**的全局失败上限。
 */
test('伪造 X-Forwarded-For 不能绕过登录限流（默认不信任代理）', async () => {
  const t = await createTestApp();
  try {
    let rateLimited = 0;

    // 每次换一个伪造 IP —— 若限流键取自 XFF，这里会全部通过
    for (let i = 0; i < 10; i += 1) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/admin/login',
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
        payload: { password: `wrong-${i}` },
      });
      if (response.statusCode === 429) rateLimited += 1;
    }

    assert.ok(
      rateLimited > 0,
      '轮换伪造 IP 也必须被限流 —— 若这里为 0，说明限流键仍来自客户端可控的头',
    );
  } finally {
    await t.dispose();
  }
});

test('全局失败上限能挡住 IP 轮换式爆破（不依赖任何客户端输入）', async () => {
  const t = await createTestApp();
  try {
    // 把单键上限设得很高、全局上限设得很低，
    // 这样唯一能拦住请求的就是全局计数
    let rateLimited = 0;

    for (let i = 0; i < 20; i += 1) {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/platform/login',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
        payload: { email: 'nobody@example.com', password: `wrong-${i}` },
      });
      if (response.statusCode === 429) rateLimited += 1;
    }

    assert.ok(rateLimited > 0, '全局上限应在若干次失败后生效');
  } finally {
    await t.dispose();
  }
});

test('限流器会清理过期键，不会无限增长', async () => {
  const t = await createTestApp();
  try {
    const limiter = new LoginRateLimiter({
      maxAttempts: 100,
      windowMs: 1000,
      blockMs: 1000,
      globalMaxAttempts: 100_000,
      globalWindowMs: 1000,
    });

    const base = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 50; i += 1) {
      limiter.recordFailure(`key-${i}`, base);
    }
    assert.equal(limiter.trackedKeys(), 50, '50 个不同的键应被跟踪');

    // 时间推进到窗口之外后再 check 一次；prune 被摊在 check 里执行
    const later = new Date(base.getTime() + 10 * 60 * 1000);
    limiter.check('probe', later);

    assert.equal(limiter.trackedKeys(), 0, '过期键应已被清理 —— 否则 Map 会无限增长');
  } finally {
    await t.dispose();
  }
});