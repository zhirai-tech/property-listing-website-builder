/**
 * 测试辅助：构建隔离的应用上下文与 HTTP 实例。
 *
 * 约定：
 *  - 每个测试使用独立临时目录与内存数据库，互不影响；
 *  - 注入 FakeClock 与 MemoryStorage，使时间与文件系统完全可控；
 *  - 不污染 var/ 下的真实数据。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { closeContext, createAppContext, type AppContext } from '../../src/app-context.ts';
import { buildApp } from '../../src/http/app.ts';
import { FakeClock } from '../../src/adapters/clock.ts';
import { FakeDnsResolver } from '../../src/adapters/dns.ts';
import { MemoryMailProvider } from '../../src/adapters/mail.ts';
import { MemoryStorageProvider } from '../../src/adapters/storage.ts';
import { createLogger } from '../../src/util/logger.ts';

export interface TestHarness {
  ctx: AppContext;
  config: AppConfig;
  clock: FakeClock;
  mail: MemoryMailProvider;
  storage: MemoryStorageProvider;
  dns: FakeDnsResolver;
  workDir: string;
  dispose: () => void;
}

export const TEST_PASSWORD = 'test-password-123456';

export function createHarness(options: { start?: string; adminPassword?: string } = {}): TestHarness {
  const workDir = mkdtempSync(join(tmpdir(), 'pl-test-'));

  const base = loadConfig({ rootDir: workDir, readEnvFile: false });

  const config: AppConfig = {
    ...base,
    env: 'test',
    databaseFile: join(workDir, 'db', 'app.sqlite'),
    uploadDir: join(workDir, 'uploads'),
    backupDir: join(workDir, 'backups'),
    dataDir: workDir,
    adminPassword: options.adminPassword ?? TEST_PASSWORD,
    sessionSecret: 'test-session-secret-at-least-32-characters-long',
    hosting: { ...base.hosting, provider: 'custom_domain' },
    reminders: { ...base.reminders, recipient: 'owner@example.com' },
    devTimeTravel: false,
  };

  const clock = new FakeClock(options.start ?? '2026-01-15T02:00:00.000Z');
  const mail = new MemoryMailProvider();
  const storage = new MemoryStorageProvider();
  const dns = new FakeDnsResolver();

  const ctx = createAppContext({
    config,
    adapters: { clock, mail, storage, dns },
    logger: createLogger({ level: 'error', sink: () => {} }),
  });

  return {
    ctx,
    config,
    clock,
    mail,
    storage,
    dns,
    workDir,
    dispose: () => {
      closeContext(ctx);
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响测试结论
      }
    },
  };
}

export interface TestApp {
  app: FastifyInstance;
  harness: TestHarness;
  cookie: string;
  dispose: () => Promise<void>;
}

/** 构建已登录的 HTTP 测试实例 */
export async function createTestApp(options: { start?: string } = {}): Promise<TestApp> {
  const harness = createHarness(options);
  const app = await buildApp(harness.ctx);

  const login = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    payload: { password: TEST_PASSWORD },
  });

  const setCookie = login.headers['set-cookie'];
  const raw = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)) ?? '';
  const cookie = raw.split(';')[0] ?? '';

  return {
    app,
    harness,
    cookie,
    dispose: async () => {
      await app.close();
      harness.dispose();
    },
  };
}

/** 生成一张合法的最小 PNG（用于上传测试） */
export function tinyPng(): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
}

/** 构造 multipart 请求体 */
export function multipart(filename: string, contentType: string, data: Uint8Array): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----test${Date.now()}${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    body: Buffer.concat([head, Buffer.from(data), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** 一份完整的房源输入，测试可按需覆盖字段 */
export function propertyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '测试房源 · 两居室',
    description: '用于自动化测试的房源描述。',
    addressLine: '测试路 1 号',
    district: '测试区',
    city: '测试市',
    region: '测试省',
    countryCode: 'CN',
    latitude: 31.2304,
    longitude: 121.4737,
    propertyType: 'apartment',
    bedrooms: 2,
    bathrooms: 1,
    areaValue: 88,
    areaUnit: 'square_meter',
    priceAmount: 5000,
    priceCurrency: 'CNY',
    pricePeriod: 'per_month',
    depositAmount: 10000,
    depositCurrency: 'CNY',
    availableFrom: '2026-03-01',
    status: 'active',
    ...overrides,
  };
}

/**
 * 注册一个平台用户，返回它的会话 Cookie。
 *
 * 放在共享 helper 里，避免各个测试文件各自复制一份
 * （重复的测试辅助会在接口变化时变成多处需要同步修改的负担）。
 */
export async function registerUser(
  t: { app: FastifyInstance },
  email: string,
  displayName = '测试用户',
): Promise<{ status: number; cookie: string; body: any }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/platform/register',
    payload: { email, password: 'platform-pass-123', displayName },
  });
  const setCookie = res.headers['set-cookie'];
  const raw = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)) ?? '';
  return { status: res.statusCode, cookie: raw.split(';')[0] ?? '', body: JSON.parse(res.body || '{}') };
}

/**
 * 建一个属于该用户的房源项目。
 *
 * 不传 propertyId：房源项目会在该用户自己的工作区里自动创建一套房源。
 * 传后台建的房源 id 属于跨工作区引用，会被服务端拒绝。
 */
export async function createListingProject(
  t: { app: FastifyInstance },
  cookie: string,
  title = '我的展示页',
): Promise<{ status: number; project: any; propertyId?: string }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/platform/projects',
    headers: { cookie },
    payload: { pluginId: 'listing', title },
  });
  const project = JSON.parse(res.body || '{}').project;
  return { status: res.statusCode, project, propertyId: project?.spec?.propertyId };
}
