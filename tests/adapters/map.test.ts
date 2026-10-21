/**
 * 地图适配器单元测试（方案第 4 阶段：可替换适配层 + 故障降级）。
 *
 * 通过注入 fetch 实现确定性验证，不依赖真实网络。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisabledMapProvider, OsmMapProvider, haversineMeters } from '../../src/adapters/map.ts';
import { FakeClock, SystemClock } from '../../src/adapters/clock.ts';
import { MemoryStorageProvider } from '../../src/adapters/storage.ts';
import { assertSafeKey, resolveKeyPath } from '../../src/adapters/storage.ts';
import { MemoryMailProvider, buildSmtpPayload, assertSafeRecipient } from '../../src/adapters/mail.ts';
import { FakeDnsResolver, flattenTxtRecords } from '../../src/adapters/dns.ts';

const options = {
  tileUrl: 'https://tile.example.com/{z}/{x}/{y}.png',
  attribution: '© 测试署名',
  freeTierNote: '免费额度说明',
};

const coords = { latitude: 31.2304, longitude: 121.4737 };

test('有经纬度时地图视图可用，且不包含任何密钥', () => {
  const provider = new OsmMapProvider({ ...options, apiKey: 'super-secret-key' });
  const view = provider.buildView({ ...coords, addressText: '上海市某路 1 号' });

  assert.equal(view.enabled, true);
  assert.equal(view.hasCoordinates, true);
  assert.equal(view.degraded, false);
  assert.equal(view.attribution, '© 测试署名');

  // 瓦片地址是公开信息；密钥绝不能出现在渲染输入里
  assert.ok(!JSON.stringify(view).includes('super-secret-key'), '渲染数据不得包含密钥');
});

test('没有经纬度时降级为地址文本', () => {
  const provider = new OsmMapProvider(options);
  const view = provider.buildView({ latitude: null, longitude: null, addressText: '只有地址' });

  assert.equal(view.hasCoordinates, false);
  assert.equal(view.degraded, true);
  assert.match(view.degradedReason, /经纬度/);
  assert.equal(view.fallbackAddress, '只有地址', '降级时仍必须提供地址');
});

test('关闭地图时明确说明并保留地址', () => {
  const view = new DisabledMapProvider().buildView({ ...coords, addressText: '地址' });

  assert.equal(view.enabled, false);
  assert.equal(view.degraded, true);
  assert.match(view.degradedReason, /已通过配置关闭/);
  assert.equal(view.fallbackAddress, '地址');
});

test('周边信息服务不可用时返回可读原因而不是抛错', async () => {
  const provider = new OsmMapProvider({
    ...options,
    fetchImpl: async () => new Response('blocked', { status: 406 }),
  });

  const result = await provider.nearby(coords);

  assert.equal(result.available, false);
  assert.match(result.reason, /HTTP 406/);
  assert.deepEqual(result.places, []);
});

test('周边信息被限流时给出配额提示', async () => {
  const provider = new OsmMapProvider({
    ...options,
    fetchImpl: async () => new Response('rate limited', { status: 429 }),
  });

  const result = await provider.nearby(coords);
  assert.match(result.reason, /限流/);
});

test('网络异常时降级而不是让页面报错', async () => {
  const provider = new OsmMapProvider({
    ...options,
    fetchImpl: async () => {
      throw new Error('网络不可达');
    },
  });

  const result = await provider.nearby(coords);
  assert.equal(result.available, false);
  assert.match(result.reason, /不可用/);
});

test('周边信息按距离排序并解析分类', async () => {
  const payload = {
    elements: [
      { lat: 31.2404, lon: 121.4737, tags: { amenity: 'school', name: '较远小学' } },
      { lat: 31.2314, lon: 121.4737, tags: { highway: 'bus_stop', name: '近处车站' } },
      { lat: 31.2324, lon: 121.4737, tags: { shop: 'supermarket', name: '超市' } },
      { lat: 31.2305, lon: 121.4737, tags: { amenity: 'school' } }, // 无名称，应被跳过
    ],
  };

  const provider = new OsmMapProvider({
    ...options,
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });

  const result = await provider.nearby(coords, undefined);

  assert.equal(result.available, true);
  assert.equal(result.places.length, 3, '无名称的节点应被跳过');
  assert.equal(result.places[0]?.category, 'transport', '最近的应是交通');
  assert.equal(result.places[0]?.name, '近处车站');

  const distances = result.places.map((p) => p.distanceMeters ?? 0);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b), '应按距离升序');
});

test('相同位置的结果会命中缓存，不重复请求外部服务', async () => {
  let calls = 0;
  const provider = new OsmMapProvider({
    ...options,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    },
  });

  await provider.nearby(coords);
  await provider.nearby(coords);

  assert.equal(calls, 1, '第二次应命中缓存');
});

test('请求超时会降级为不可用', async () => {
  const provider = new OsmMapProvider({
    ...options,
    timeoutMs: 20,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });

  const result = await provider.nearby(coords);
  assert.equal(result.available, false);
  assert.match(result.reason, /超时|不可用/);
});

test('haversine 距离计算符合已知量级', () => {
  // 上海人民广场 -> 陆家嘴，直线约 3 km
  const meters = haversineMeters(
    { latitude: 31.2304, longitude: 121.4737 },
    { latitude: 31.2397, longitude: 121.4998 },
  );

  assert.ok(meters > 2000 && meters < 3500, `距离应约 3 km，实际 ${Math.round(meters)} m`);
});

// ---------------------------------------------------------------------------
// 存储适配器：路径穿越防护
// ---------------------------------------------------------------------------

test('存储键拒绝目录穿越与非法路径段', () => {
  for (const bad of ['../secret', 'a/../../b', 'C:/windows', '', 'a//b', 'a/./b', 'x\u0000y']) {
    assert.throws(() => assertSafeKey(bad), `应拒绝：${bad}`);
  }
});

test('存储键会规范化前导斜杠（仍是存储根目录内的相对键）', () => {
  assert.equal(assertSafeKey('prp_1/photo.png'), 'prp_1/photo.png');
  assert.equal(assertSafeKey('/prp_1/photo.png'), 'prp_1/photo.png');

  // 关键点：'/etc/passwd' 会被规范化为存储根目录下的 'etc/passwd'，
  // 而不是系统绝对路径 —— 由 resolveKeyPath 再次确认确实落在根目录内。
  const root = process.cwd();
  const resolved = resolveKeyPath(root, '/etc/passwd');
  assert.ok(resolved.startsWith(root), `应落在存储根目录内，实际 ${resolved}`);
  assert.ok(!resolved.includes('Windows'), '不得解析到系统目录');
});

test('解析后的路径必须位于存储根目录内', () => {
  const root = process.cwd();
  const inside = resolveKeyPath(root, 'prp_1/a.png');
  assert.ok(inside.startsWith(root));

  assert.throws(() => resolveKeyPath(root, '../outside.txt'));
});

test('内存存储读写删一致', async () => {
  const storage = new MemoryStorageProvider();
  const data = new Uint8Array([1, 2, 3]);

  await storage.put('a/b.bin', data);
  assert.equal(await storage.exists('a/b.bin'), true);
  assert.deepEqual([...(await storage.read('a/b.bin')) ?? []], [1, 2, 3]);
  assert.equal(await storage.size('a/b.bin'), 3);

  await storage.remove('a/b.bin');
  assert.equal(await storage.exists('a/b.bin'), false);
  assert.equal(await storage.read('a/b.bin'), null);
});

// ---------------------------------------------------------------------------
// 邮件适配器：头注入防护与主题编码
// ---------------------------------------------------------------------------

test('收件人非法或含换行时被拒绝（防头注入）', () => {
  assert.throws(() => assertSafeRecipient('not-an-email'));
  assert.throws(() => assertSafeRecipient('a@b.com\r\nBcc: evil@x.com'));
  assert.equal(assertSafeRecipient(' a@b.com '), 'a@b.com');
});

test('中文主题使用 RFC 2047 编码，正文使用 base64', () => {
  const payload = buildSmtpPayload('from@example.com', {
    to: 'to@example.com',
    subject: '房源提醒：第 7 天检查',
    text: '正文内容',
  });

  assert.match(payload, /Subject: =\?UTF-8\?B\?/);
  assert.match(payload, /Content-Transfer-Encoding: base64/);
  assert.ok(!payload.includes('\r\n.\r\n'), '正文中不应出现提前结束的标记');
});

test('内存邮件适配器记录发送内容', async () => {
  const mail = new MemoryMailProvider();
  await mail.send({ to: 'a@b.com', subject: 's', text: 't' });

  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0]?.to, 'a@b.com');

  mail.clear();
  assert.equal(mail.sent.length, 0);
});

// ---------------------------------------------------------------------------
// 时钟与 DNS 适配器
// ---------------------------------------------------------------------------

test('可控时钟只能前进或设定，不能凭空回退', () => {
  const clock = new FakeClock('2026-01-01T00:00:00.000Z');

  clock.advanceDays(7);
  assert.equal(clock.now().toISOString(), '2026-01-08T00:00:00.000Z');

  clock.advanceMs(1000);
  assert.equal(clock.now().toISOString(), '2026-01-08T00:00:01.000Z');

  clock.set('2026-02-01T00:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-02-01T00:00:00.000Z');

  // now() 返回副本，外部修改不影响内部状态
  const snapshot = clock.now();
  snapshot.setFullYear(2030);
  assert.equal(clock.now().getUTCFullYear(), 2026);
});

test('系统时钟不支持时间旅行', () => {
  assert.throws(() => new SystemClock().advanceDays());
  assert.throws(() => new SystemClock().set());
  assert.equal(new SystemClock().now() instanceof Date, true);
});

test('假 DNS 解析器返回预设 TXT 记录并支持分片拼接', async () => {
  const dns = new FakeDnsResolver();
  dns.setTxt('example.com', [['part1=', 'part2']]);

  const records = await dns.resolveTxt('example.com');
  assert.deepEqual(flattenTxtRecords(records), ['part1=part2']);

  assert.deepEqual(await dns.resolveTxt('unknown.com'), []);

  dns.clear();
  assert.deepEqual(await dns.resolveTxt('example.com'), []);
});