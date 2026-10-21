/**
 * AI 单网页生成平台 —— 基础架构测试。
 *
 * 覆盖：迁移、统一配置、插件契约、用量台账幂等、服务端额度判定。
 * 全部跑在独立临时库上（createHarness），不触碰 var/ 下的真实数据。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHarness } from '../helpers/test-app.ts';
import { runMigrations } from '../../src/db/migrations.ts';
import {
  DEFAULT_TIER_LIMITS,
  PLATFORM_LIMITS,
  envTierOverrides,
  limitsFor,
  mergeLimits,
  resolvePlatformLimits,
} from '../../src/platform/config.ts';
import {
  PLUGIN_API_VERSION,
  validateManifest,
} from '../../src/platform/plugins/types.ts';
import {
  findPluginByPageType,
  getBuiltinPlugin,
  inspectUploadedPackage,
  listBuiltinPlugins,
} from '../../src/platform/plugins/registry.ts';
import { claimTask, getByTaskId, settleTask, taskExists, usageSince } from '../../src/platform/ai/usage.ts';
import { checkQuota, countProjects, periodStartFor, quotaSummary, writeStoredSetting } from '../../src/platform/quota.ts';
import { projectRetention } from '../../src/platform/retention.ts';
import { safetyStats, safetyStatsBreakdown } from '../../src/platform/ai/safety-stats.ts';
import { createMockProvider } from '../../src/platform/ai/mock-provider.ts';

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

test('迁移可应用到最新版本，且包含 v3 平台基础结构', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const result = runMigrations(db);

  assert.ok(result.applied.some((m) => m.version === 3), '应应用 v3');
  assert.equal(result.applied.find((m) => m.version === 3)?.name, 'platform_foundation');

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => String((r as { name: string }).name));
  for (const t of ['projects', 'project_versions', 'ai_usage', 'plugin_installations', 'platform_settings']) {
    assert.ok(tables.includes(t), `应存在新表 ${t}`);
  }

  // users 的新列
  const cols = db
    .prepare('PRAGMA table_info(users)')
    .all()
    .map((c) => String((c as { name: string }).name));
  for (const c of ['password_hash', 'status', 'tier', 'member_until', 'is_system']) {
    assert.ok(cols.includes(c), `users 应有列 ${c}`);
  }

  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('迁移是幂等的：重复运行不重复应用', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const first = runMigrations(db);
  const second = runMigrations(db);

  assert.equal(second.applied.length, 0, '第二次不应有新应用');
  // 不硬编码版本号：断言「跳过数 = 已应用数」，新增迁移时这条测试自动仍然成立
  assert.equal(second.skipped.length, first.applied.length, '第二次应跳过第一次应用过的全部版本');
  assert.deepEqual(
    [...second.skipped].sort((a, b) => a - b),
    first.applied.map((m) => m.version).sort((a, b) => a - b),
  );
  db.close();
});

test('ai_usage 的 task_id 唯一索引是重复扣费的最终防线', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  db.exec(
    "INSERT INTO workspaces (id,name,owner_user_id,default_locale,default_currency,default_area_unit,default_timezone,hosting_provider,created_at,updated_at) VALUES ('w','w','u','zh-CN','CNY','square_meter','Asia/Shanghai','default','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
  );
  db.exec(
    "INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at) VALUES ('u','w','a@b.c','甲','owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
  );

  assert.equal(claimTask(db, { taskId: 't1', userId: 'u', projectId: null, kind: 'generate', provider: 'mock', model: 'm' }).claimed, true);
  // 第二次抢占同一 taskId 必须失败 —— 这是「同一任务不得重复扣费」的机制
  assert.equal(claimTask(db, { taskId: 't1', userId: 'u', projectId: null, kind: 'generate', provider: 'mock', model: 'm' }).claimed, false);

  const rows = db.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE task_id = ?').get('t1') as { n: number };
  assert.equal(rows.n, 1, '同一 taskId 只应有一条记录');
  db.close();
});

// ---------------------------------------------------------------------------
// 统一配置
// ---------------------------------------------------------------------------

test('免费套餐默认值符合产品规则（1 项目 / 1 次修改 / 50 万 Token）', () => {
  const free = DEFAULT_TIER_LIMITS['free']!;
  assert.equal(free.maxProjects, 1);
  assert.equal(free.maxAiRevisions, 1);
  assert.equal(free.tokenQuota, 500_000);
  assert.equal(free.hostingEnabled, false, '免费用户不享有平台托管');
  assert.equal(free.adminEnabled, false, '免费用户不享有插件管理后台');
  assert.equal(free.quotaPeriod, 'none', '免费额度是一次性总额度');
});

test('限额可通过环境变量覆盖，且只认白名单字段', () => {
  const overrides = envTierOverrides({
    PLATFORM_FREE_TOKEN_QUOTA: '12345',
    PLATFORM_FREE_MAX_PROJECTS: '9',
    PLATFORM_FREE_HOSTING_ENABLED: 'true',
    PLATFORM_FREE_NOT_A_FIELD: 'x',
  } as NodeJS.ProcessEnv);

  assert.equal(overrides['free']?.['tokenQuota'], 12345);
  assert.equal(overrides['free']?.['maxProjects'], 9);
  assert.equal(overrides['free']?.['hostingEnabled'], true);
  assert.equal(Object.hasOwn(overrides['free'] ?? {}, 'notAField'), false, '未知字段必须被忽略');
});

test('数据库里的管理员调整优先于环境变量与默认值', () => {
  const stored = { 'limits.free': { tokenQuota: 777, maxAiRevisions: 5 } };
  const all = resolvePlatformLimits(stored, { PLATFORM_FREE_TOKEN_QUOTA: '12345' } as NodeJS.ProcessEnv);
  assert.equal(all['free']?.tokenQuota, 777, 'DB 覆盖应压过 env');
  assert.equal(all['free']?.maxAiRevisions, 5);
  assert.equal(all['free']?.maxProjects, 1, '未覆盖的字段保持默认');
});

test('未知套餐退回最严格的免费档，绝不默认放行', () => {
  const limits = limitsFor('enterprise-unlimited-does-not-exist');
  assert.equal(limits.tier, 'free');
  assert.equal(limits.tokenQuota, 500_000);
});

test('mergeLimits 忽略非法值，不产生负数或 NaN 额度', () => {
  const base = DEFAULT_TIER_LIMITS['free']!;
  const merged = mergeLimits(base, { tokenQuota: -1, maxProjects: 'abc', hostingEnabled: 'true' });
  assert.equal(merged.tokenQuota, base.tokenQuota, '负数应被忽略');
  assert.equal(merged.maxProjects, base.maxProjects, '非数字应被忽略');
  assert.equal(merged.hostingEnabled, true, '布尔字符串应被接受');
});

// ---------------------------------------------------------------------------
// 插件契约
// ---------------------------------------------------------------------------

test('内置房源插件已注册且清单合法', () => {
  const plugins = listBuiltinPlugins();
  assert.ok(plugins.length >= 1);
  const listing = getBuiltinPlugin('listing');
  assert.ok(listing, '应存在 listing 插件');
  assert.equal(listing.pageType, 'listing');
  assert.equal(listing.apiVersion, PLUGIN_API_VERSION);
  assert.ok(listing.fields.length >= 20, '房源插件应声明完整的可编辑字段');
  assert.ok(listing.capabilities.includes('render.server'));
  assert.equal(findPluginByPageType('listing')?.id, 'listing');
});

test('清单校验：拒绝非法 id、版本、契约版本与未知能力', () => {
  const bad = validateManifest({
    id: 'Bad_ID',
    name: '',
    version: 'v1',
    pageType: '',
    apiVersion: 999,
    capabilities: ['execute.arbitrary.shell'],
    fields: [{ key: 'a', label: 'A', kind: 'unknown-widget' }],
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    const fields = bad.issues.map((i) => i.field);
    for (const f of ['id', 'name', 'version', 'pageType', 'apiVersion', 'capabilities', 'fields[0].kind']) {
      assert.ok(fields.includes(f), `应报告 ${f} 的问题`);
    }
  }
});

test('清单校验：拒绝重复字段键与原型污染式键', () => {
  const dup = validateManifest({
    id: 'p', name: 'P', version: '1.0.0', pageType: 'x', apiVersion: PLUGIN_API_VERSION,
    capabilities: [], fields: [{ key: 'k', label: 'A', kind: 'text' }, { key: 'k', label: 'B', kind: 'text' }],
  });
  assert.equal(dup.ok, false);

  const proto = validateManifest({
    id: 'p', name: 'P', version: '1.0.0', pageType: 'x', apiVersion: PLUGIN_API_VERSION,
    capabilities: [], fields: [{ key: '__proto__', label: 'A', kind: 'text' }],
  });
  assert.equal(proto.ok, false);
});

test('上传的插件包只可登记、不可执行（沙箱落地前不执行任意上传代码）', () => {
  const good = inspectUploadedPackage({
    id: 'my-page', name: '个人主页', version: '1.0.0', pageType: 'profile',
    apiVersion: PLUGIN_API_VERSION, capabilities: ['render.server'],
    fields: [{ key: 'nickname', label: '昵称', kind: 'text' }],
  });
  assert.equal(good.installable, true);
  if (good.installable) {
    assert.equal(good.executable, false, '未内置插件在沙箱落地前不得可执行');
  }

  // 占用已被内置插件使用的 pageType 应被拒绝
  const clash = inspectUploadedPackage({
    id: 'fake-listing', name: '假的房源插件', version: '1.0.0', pageType: 'listing',
    apiVersion: PLUGIN_API_VERSION, capabilities: [], fields: [],
  });
  assert.equal(clash.installable, false);
});

// ---------------------------------------------------------------------------
// 用量台账
// ---------------------------------------------------------------------------

test('用量结算：成功任务计入消耗，失败与拒绝不计入', () => {
  const h = createHarness();
  try {
    const db = h.ctx.db;
    const uid = 'usr_test';
    db.exec(
      `INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at)
       VALUES ('${uid}','${h.ctx.workspace.id}','t@e.st','测试','owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );

    const mk = (taskId: string, kind: 'generate' | 'revise') =>
      claimTask(db, { taskId, userId: uid, projectId: null, kind, provider: 'mock', model: 'm' });

    // 成功
    mk('ok1', 'generate');
    settleTask(db, {
      taskId: 'ok1', userId: uid, projectId: null, kind: 'generate', status: 'succeeded',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costMicros: 0 },
      provider: 'mock', model: 'm',
    });
    // 失败：供应商报错，按实际用量（此处为 0）结算
    mk('fail1', 'generate');
    settleTask(db, {
      taskId: 'fail1', userId: uid, projectId: null, kind: 'generate', status: 'failed',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
      provider: 'mock', model: 'm', failureReason: '供应商超时',
    });

    const totals = usageSince(db, uid, null);
    assert.equal(totals.tokens, 150, '只有成功任务计入 Token');
    assert.equal(totals.generations, 1, '只有成功任务计入生成次数');

    assert.equal(getByTaskId(db, 'fail1')?.status, 'failed');
    assert.equal(getByTaskId(db, 'fail1')?.failureReason, '供应商超时');
  } finally {
    h.dispose();
  }
});

test('重复结算同一任务不会二次累加', () => {
  const h = createHarness();
  try {
    const db = h.ctx.db;
    const uid = 'usr_test';
    db.exec(
      `INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at)
       VALUES ('${uid}','${h.ctx.workspace.id}','t@e.st','测试','owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );

    claimTask(db, { taskId: 'dup', userId: uid, projectId: null, kind: 'generate', provider: 'mock', model: 'm' });
    const first = settleTask(db, {
      taskId: 'dup', userId: uid, projectId: null, kind: 'generate', status: 'succeeded',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, costMicros: 0 }, provider: 'mock', model: 'm',
    });
    const second = settleTask(db, {
      taskId: 'dup', userId: uid, projectId: null, kind: 'generate', status: 'succeeded',
      usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998, costMicros: 0 }, provider: 'mock', model: 'm',
    });

    assert.equal(first, 1, '首次结算应命中一行');
    assert.equal(second, 0, '二次结算不应命中');
    assert.equal(usageSince(db, uid, null).tokens, 20, '用量不应被二次累加');
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// 额度判定
// ---------------------------------------------------------------------------

test('免费用户额度：生成、修改、Token、项目数四条限制都由服务端判定', () => {
  const h = createHarness();
  try {
    const db = h.ctx.db;
    const uid = 'usr_q';
    db.exec(
      `INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at)
       VALUES ('${uid}','${h.ctx.workspace.id}','q@e.st','Q','owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );

    // 初始：允许
    assert.equal(checkQuota(db, { userId: uid, tier: 'free', action: 'generate' }).allowed, true);
    assert.equal(checkQuota(db, { userId: uid, tier: 'free', action: 'revise' }).allowed, true);
    assert.equal(checkQuota(db, { userId: uid, tier: 'free', action: 'create_project' }).allowed, true);
    assert.equal(checkQuota(db, { userId: uid, tier: 'free', action: 'hosting.publish' }).allowed, false, '免费不含托管');
    assert.equal(checkQuota(db, { userId: uid, tier: 'free', action: 'plugin.admin' }).allowed, false, '免费不含管理后台');

    // 用掉唯一一次修改
    claimTask(db, { taskId: 'r1', userId: uid, projectId: null, kind: 'revise', provider: 'mock', model: 'm' });
    settleTask(db, {
      taskId: 'r1', userId: uid, projectId: null, kind: 'revise', status: 'succeeded',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costMicros: 0 }, provider: 'mock', model: 'm',
    });
    const revised = checkQuota(db, { userId: uid, tier: 'free', action: 'revise' });
    assert.equal(revised.allowed, false);
    assert.equal(revised.code, 'revision_limit');
    assert.ok((revised.message ?? '').includes('1'), '提示应包含实际次数');

    // 用掉项目额度
    db.exec(
      `INSERT INTO projects (id,user_id,workspace_id,plugin_id,title,status,spec_json,created_at,updated_at)
       VALUES ('prj_1','${uid}','${h.ctx.workspace.id}','listing','测试','draft','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );
    assert.equal(countProjects(db, uid), 1);
    const proj = checkQuota(db, { userId: uid, tier: 'free', action: 'create_project' });
    assert.equal(proj.allowed, false);
    assert.equal(proj.code, 'project_limit');
  } finally {
    h.dispose();
  }
});

test('Token 额度耗尽后拒绝，且管理员可在运行时调整额度', () => {
  const h = createHarness();
  try {
    const db = h.ctx.db;
    const uid = 'usr_t';
    db.exec(
      `INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at)
       VALUES ('${uid}','${h.ctx.workspace.id}','t2@e.st','T','owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );

    claimTask(db, { taskId: 'big', userId: uid, projectId: null, kind: 'generate', provider: 'mock', model: 'm' });
    settleTask(db, {
      taskId: 'big', userId: uid, projectId: null, kind: 'generate', status: 'succeeded',
      usage: { inputTokens: 300_000, outputTokens: 250_000, totalTokens: 550_000, costMicros: 0 },
      provider: 'mock', model: 'm',
    });

    const denied = checkQuota(db, { userId: uid, tier: 'free', action: 'generate' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 'token_limit');

    // 管理员提高额度后立即可用（不需要重启）
    writeStoredSetting(db, 'limits.free', { tokenQuota: 2_000_000 }, '2026-01-02T00:00:00Z');
    const allowed = checkQuota(db, { userId: uid, tier: 'free', action: 'generate' });
    assert.equal(allowed.allowed, true, '管理员调整后应恢复可用');
    assert.equal(allowed.limits.tokenQuota, 2_000_000);
  } finally {
    h.dispose();
  }
});

test('额度周期：免费是一次性总额度，付费按月重置', () => {
  const now = new Date('2026-03-15T10:00:00.000Z');
  assert.equal(periodStartFor(DEFAULT_TIER_LIMITS['free']!, now), null, '免费无周期');
  assert.equal(periodStartFor(DEFAULT_TIER_LIMITS['basic']!, now), '2026-03-01T00:00:00.000Z');
});

test('额度摘要反映剩余量', () => {
  const h = createHarness();
  try {
    const db = h.ctx.db;
    const uid = 'usr_s';
    db.exec(
      `INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at)
       VALUES ('${uid}','${h.ctx.workspace.id}','s@e.st','S','owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );
    claimTask(db, { taskId: 'g1', userId: uid, projectId: null, kind: 'generate', provider: 'mock', model: 'm' });
    settleTask(db, {
      taskId: 'g1', userId: uid, projectId: null, kind: 'generate', status: 'succeeded',
      usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500, costMicros: 0 }, provider: 'mock', model: 'm',
    });

    const s = quotaSummary(db, uid, 'free');
    assert.equal(s.tier, 'free');
    assert.equal(s.tokens.used, 500);
    assert.equal(s.tokens.remaining, 500_000 - 500);
    assert.equal(s.generations.used, 1);
    assert.equal(s.projects.remaining, 1);
    assert.equal(s.hostingEnabled, false);
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

test('Mock Provider 产出结构化补丁，不发起任何网络请求', async () => {
  const provider = createMockProvider();
  assert.equal(provider.live, false, 'Mock 必须标记为非真实供应商');

  const result = await provider.call({
    taskId: 't',
    kind: 'generate',
    prompt: 'title: 阳光两居\npriceAmount: 8500',
    fields: [
      { key: 'title', label: '标题', kind: 'text' },
      { key: 'priceAmount', label: '价格', kind: 'money' },
    ],
    maxOutputTokens: 1000,
  });

  assert.equal(result.patch['title'], '阳光两居');
  assert.equal(result.patch['priceAmount'], 8500, '数字字段应被转成数字');
  assert.equal(result.provider, 'mock');
  assert.ok(result.usage.totalTokens > 0);
  assert.equal(result.usage.costMicros, 0, 'Mock 不计费');
});

test('Mock Provider 只接受插件声明过的字段', async () => {
  const provider = createMockProvider();
  const result = await provider.call({
    taskId: 't', kind: 'revise',
    prompt: 'title: 好的\nhackTheServer: yes',
    fields: [{ key: 'title', label: '标题', kind: 'text' }],
    maxOutputTokens: 100,
  });
  assert.equal(result.patch['title'], '好的');
  assert.equal(Object.hasOwn(result.patch, 'hackTheServer'), false, '未声明字段必须被忽略');
});

test('平台全局限额有明确上限，防止一次调用烧穿额度', () => {
  assert.ok(PLATFORM_LIMITS.maxOutputTokensPerCall > 0);
  assert.ok(PLATFORM_LIMITS.maxOutputTokensPerCall <= 32_000);
  assert.ok(PLATFORM_LIMITS.maxSpecBytes > 0);
  assert.equal(typeof taskExists, 'function');
});

test('期限配置只在一处定义，且能被管理员运行时调整', () => {
  // 免费 7 天、付费不限期
  assert.equal(DEFAULT_TIER_LIMITS['free']?.projectRetentionDays, 7);
  assert.equal(DEFAULT_TIER_LIMITS['basic']?.projectRetentionDays, null);
  assert.equal(DEFAULT_TIER_LIMITS['pro']?.projectRetentionDays, null);

  // 环境变量可覆盖
  const env = envTierOverrides({ PLATFORM_FREE_PROJECT_RETENTION_DAYS: '30' } as NodeJS.ProcessEnv);
  assert.equal(env['free']?.['projectRetentionDays'], 30);

  // 到期时间按最后修改时间算，不是创建时间
  const limits = DEFAULT_TIER_LIMITS['free']!;
  const r = projectRetention('2026-01-01T00:00:00.000Z', limits, new Date('2026-01-04T00:00:00.000Z'));
  assert.equal(r.daysLeft, 4, '7 天期限过了 3 天，应剩 4 天');
  assert.equal(r.expired, false);

  const overdue = projectRetention('2026-01-01T00:00:00.000Z', limits, new Date('2026-01-09T00:00:00.000Z'));
  assert.equal(overdue.expired, true);

  // 坏时间戳不能判为过期（宁可不归档，也不要因脏数据丢项目）
  const bad = projectRetention('not-a-date', limits, new Date('2030-01-01T00:00:00.000Z'));
  assert.equal(bad.expired, false, '时间戳坏掉时不应归档');
});

// ---------------------------------------------------------------------------
// 拒绝率观测
// ---------------------------------------------------------------------------

test('safetyStats 从台账汇总拒绝率与各规则命中次数', () => {
  const h = createHarness();
  try {
    const db = h.ctx.db;
    const uid = 'usr_stats';
    db.exec(
      `INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at)
       VALUES ('${uid}','${h.ctx.workspace.id}','s@e.st','统计','owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );

    const mk = (taskId: string, status: string, reason: string | null, at: string) =>
      db
        .prepare(
          `INSERT INTO ai_usage (id,user_id,project_id,task_id,kind,provider,model,status,
             input_tokens,output_tokens,total_tokens,cost_micros,failure_reason,created_at)
           VALUES (?,?,NULL,?,'generate','openai','m',?,0,0,0,0,?,?)`,
        )
        .run(`aiu_${taskId}`, uid, taskId, status, reason, at);

    // 3 次成功、2 次被门拒（共 3 条规则命中）、1 次上游错误
    mk('t1', 'succeeded', null, '2026-01-01T00:00:01Z');
    mk('t2', 'succeeded', null, '2026-01-01T00:00:02Z');
    mk('t3', 'succeeded', null, '2026-01-01T00:00:03Z');
    mk('t4', 'failed', '生成结果未通过安全检查：forbidden_tag:script', '2026-01-01T00:00:04Z');
    mk('t5', 'failed', '生成结果未通过安全检查：meta_not_allowed, no_title', '2026-01-01T00:00:05Z');
    mk('t6', 'failed', '上游返回 500：boom', '2026-01-01T00:00:06Z');

    const stats = safetyStats(db, { limit: 0, scope: 'all' });
    assert.equal(stats.totalTasks, 6);
    assert.equal(stats.succeeded, 3);
    assert.equal(stats.rejectedByGate, 2, '两次是被校验门拒的');
    assert.equal(stats.failedOther, 1, '上游错误不计入校验拒绝');
    assert.ok(Math.abs(stats.rejectRate - 2 / 6) < 1e-9, `拒绝率应为 2/6，实际 ${stats.rejectRate}`);

    // 规则按命中次数排序，同次数按名字排
    assert.deepEqual(stats.rules, [
      { rule: 'forbidden_tag:script', count: 1 },
      { rule: 'meta_not_allowed', count: 1 },
      { rule: 'no_title', count: 1 },
    ]);
  } finally {
    h.dispose();
  }
});

test('safetyStats 在空库上返回全零而不是崩掉', () => {
  const h = createHarness();
  try {
    const stats = safetyStats(h.ctx.db, { limit: 0, scope: 'all' });
    assert.equal(stats.totalTasks, 0);
    assert.equal(stats.rejectRate, 0, '没有任务时不应出现 NaN');
    assert.deepEqual(stats.rules, []);
  } finally {
    h.dispose();
  }
});

test('拒绝率按插件拆开：不受门约束的任务不会稀释数字', () => {
  const h = createHarness();
  try {
    const db = h.ctx.db;
    const uid = 'usr_scope';
    db.exec(
      `INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at)
       VALUES ('${uid}','${h.ctx.workspace.id}','sc@e.st','口径','owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );
    // 两个项目：一个受门约束（custom-page），一个不受（listing）
    db.exec(
      `INSERT INTO projects (id,user_id,workspace_id,plugin_id,title,status,spec_json,created_at,updated_at)
       VALUES ('prj_cp','${uid}','${h.ctx.workspace.id}','custom-page','自由页','draft','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
              ('prj_ls','${uid}','${h.ctx.workspace.id}','listing','房源页','draft','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );

    let n = 0;
    const mk = (projectId: string | null, status: string, reason: string | null) => {
      n += 1;
      db.prepare(
        `INSERT INTO ai_usage (id,user_id,project_id,task_id,kind,provider,model,status,
           input_tokens,output_tokens,total_tokens,cost_micros,failure_reason,created_at)
         VALUES (?,?,?,?,'generate','openai','m',?,0,0,0,0,?,?)`,
      ).run(`aiu_${n}`, uid, projectId, `t${n}`, status, reason, `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`);
    };

    // 受门约束：2 次成功 + 2 次被拒（拒绝率 50%）
    mk('prj_cp', 'succeeded', null);
    mk('prj_cp', 'succeeded', null);
    mk('prj_cp', 'failed', '生成结果未通过安全检查：forbidden_tag:script');
    mk('prj_cp', 'failed', '生成结果未通过安全检查：meta_not_allowed');
    // 不受门约束：8 次成功（把总体拒绝率稀释成 2/12 ≈ 17%）
    for (let i = 0; i < 8; i += 1) mk('prj_ls', 'succeeded', null);

    const gated = safetyStats(db, { limit: 0, scope: 'gated' });
    assert.equal(gated.totalTasks, 4, 'gated 口径只应含 custom-page 的 4 次');
    assert.equal(gated.rejectedByGate, 2);
    assert.equal(gated.rejectRate, 0.5, '真实拒绝率是 50%');

    const excluded = safetyStats(db, { limit: 0, scope: 'gatedExcluded' });
    assert.equal(excluded.totalTasks, 8);
    assert.equal(excluded.rejectedByGate, 0);

    const all = safetyStats(db, { limit: 0, scope: 'all' });
    assert.equal(all.totalTasks, 12);
    assert.ok(Math.abs(all.rejectRate - 2 / 12) < 1e-9, '总体口径会被稀释成 17%');

    // 这正是为什么要拆：用总体数字会低估一倍以上
    assert.ok(gated.rejectRate > all.rejectRate * 2, 'gated 口径的拒绝率应显著高于总体');

    // 项目已删除（project_id 为 NULL）的记录不能被静默丢掉，
    // 但也不能算进 gated（来源不明）
    mk(null, 'failed', '生成结果未通过安全检查：no_title');
    assert.equal(safetyStats(db, { limit: 0, scope: 'gated' }).totalTasks, 4, 'NULL 项目不计入 gated');
    assert.equal(safetyStats(db, { limit: 0, scope: 'gatedExcluded' }).totalTasks, 9, 'NULL 项目计入 excluded');
    assert.equal(safetyStats(db, { limit: 0, scope: 'all' }).totalTasks, 13, 'NULL 项目仍计入 all');
  } finally {
    h.dispose();
  }
});

test('safetyStatsBreakdown 同时给出三种口径', () => {
  const h = createHarness();
  try {
    const b = safetyStatsBreakdown(h.ctx.db, 0);
    assert.equal(b.gated.scope, 'gated');
    assert.equal(b.gatedExcluded.scope, 'gatedExcluded');
    assert.equal(b.all.scope, 'all');
    assert.deepEqual(b.gatedPlugins, ['custom-page']);
    assert.equal(b.gated.rejectRate, 0, '空库不应出现 NaN');
  } finally {
    h.dispose();
  }
});