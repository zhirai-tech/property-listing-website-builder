# 房东单页生成器 · 计划 A（结构翻转）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use the `subagent-driven-development` skill (recommended) or the `executing-plans` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有实现从「房源平台」（`properties` 为顶层、每套房一个页面）翻转为「业主单页生成器」（`landlord_pages` 为顶层、一个业主一个页面含多套房），并把公开路由从 `/p/<slug>` 搬到 `/<slug>`。

**Architecture:** 新建 `landlord_pages` 表（结构源自 `listing_pages`）作为新顶层；`properties` 增加归属列；`media` 与 `reminders` 因 SQLite 限制必须整表重建；`users` 表重建以承载账号字段（功能属计划 B，但表结构与迁移属本计划）。迁移为单个事务，备份在进入事务前由调用方完成。

**Tech Stack:** Node.js 24 原生 TypeScript 执行（无构建步骤）· Fastify 5 · `node:sqlite`（`DatabaseSync`）· 原生 ES Module 前端（无打包器）· 测试用 `node --test`

**Spec:** `docs/superpowers/specs/2026-10-12-landlord-single-page-redesign.md`
（本计划实现其中的**计划 A** 部分，见 spec §2.2。计划 B 的内容不在本计划内。）

---

## Global Constraints

以下为 spec 的项目级要求，**每个任务都隐含遵守**：

- **运行时**：Node `>=24.0.0`；源码直接以 TS 运行，命令一律带 `--disable-warning=ExperimentalWarning`
- **类型约束**：`erasableSyntaxOnly` —— **不得使用 `enum`，不得使用构造函数参数属性**
- **依赖策略**：运行期只允许 MIT 许可组件。**本计划不得新增任何依赖**
- **数据库**：`node:sqlite` 的 `DatabaseSync`；连接开启 `PRAGMA foreign_keys = ON`（`src/db/database.ts:29`）
- **迁移纪律**：迁移**只增不改**。本计划新增 `v3`，名称为 `landlord_single_page`，**不得修改 v1/v2**
- **状态取值域（两个 status 不可混用）**：
  - `landlord_pages.status` = `unpublished | published | withdrawn` —— **沿用现有三值，不新增**
  - `properties.status` = `draft | active | reserved | closed | archived`
- **`LISTING_STATUSES` 不改**：`assertPublishTransition`（`src/domain/listing-page.ts:71`）是穷举 `Record`，加新值会编译失败
- **品牌**：作者/版权/页脚 = ZHIRAI / 智睿；图标为自研 SVG（已落地，不重做）
- **注释与提交信息**：中文
- **工作区在 exFAT 上**：DSH 工具无法直接创建新文件，需先用 pwsh 预创建空文件
- **测试命令**：`pnpm test` 使用 glob（`node --test "tests/**/*.test.ts"`，目录参数会 `MODULE_NOT_FOUND`）；`pnpm smoke` 当前 73 项
- **验证底线**：每个任务结束时 `pnpm typecheck` 退出码 0

---

## Review Focus

以下是 spec 隐含、但没有哪个任务的测试会天然覆盖，却最容易在真人使用时出问题的五类输入。
**每一条都在下方对应任务里配了测试。**

1. **在已有数据的库上迁移**（不是空库）—— 3 条演示数据、每套 5 张照片、若干提醒、联系方式，
   迁移后**数量必须完全不变**。空库测试全绿而线上库丢数据，是这类改动最典型的翻车方式。→ Task 1 / 5 / 6 / 7
2. **同一业主页下多套房源的同类型提醒** —— 幂等键从 `${propertyId}:${kind}` 改为
   `${landlordPageId}:${kind}` 后会撞 `idx_reminders_idempotency` 唯一索引，
   不去重则**整个迁移事务回滚**。→ Task 7
3. **孤儿房源**（从未创建过 `listing_pages`，`listing-page-repo.ts:145` 存在删除路径）——
   必须有归属页，不能留 NULL，否则自检失败且公开页查不到。→ Task 3 / 4
4. **已发出去的旧链接** `/p/<slug>` —— 房东可能已经发到微信群里，301 必须能跳到新地址。→ 阶段三
5. **公开页首屏 HTML** —— 不得出现完整电话号码或二维码数据，
   否则「防抓取」形同虚设（爬虫读的是源码，不是屏幕）。→ 阶段三

---

## File Structure

### 新建

| 文件 | 职责 |
| --- | --- |
| `src/db/repositories/landlord-page-repo.ts` | 业主页的读写（由 `listing-page-repo.ts` 演进而来） |
| `src/domain/mask.ts` | 联系方式掩码规则（服务端唯一实现） |
| `src/http/contact-rate-limit.ts` | 联系方式取回限流（按 IP + 业主页） |
| `src/render/landlord-index-renderer.ts` | 业主页**列表页**渲染（新页面） |
| `tests/db/migration-v3.test.ts` | 迁移的完整测试（本阶段核心） |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/db/migrations.ts` | 新增 `v3 landlord_single_page`（15 步） |
| `src/db/migrate.ts` | 备份前置（R4：`createBackup` 需要 `AppContext`） |
| `src/db/repositories/property-repo.ts` | 归属列、按业主页查询 |
| `src/db/repositories/media-repo.ts` | `propertyId` 可空、`landlordPageId`、`wechat_qr` |
| `src/db/repositories/reminder-repo.ts` | 归属改业主页 |
| `src/db/repositories/contact-repo.ts` | 三级回退、公开页两级链 |
| `src/domain/hosting.ts` | **URL 构造改 `/<slug>`（全链路唯一构造点）** |
| `src/services/publish-service.ts` | 业主页发布就绪 |
| `src/services/reminder-service.ts` | 幂等键与收件人 |
| `src/services/media-service.ts` | 业主级上传入口 |
| `src/services/export-service.ts` | 导出整页（列表 + N 详情） |
| `src/services/backup-service.ts` | `BACKUP_TABLES` 换表 |
| `src/render/page-renderer.ts` | 联系方式区、费用区、介绍折叠 |
| `src/http/app.ts` | **CSP 判定改按路由**（`app.ts:117-118`）；404 页返回入口 |
| `src/http/routes/public-pages.ts` | `/<slug>` 系列 + `/p/` 301 |
| `src/http/routes/admin-pages.ts` | 以业主页为中心 |
| `public/admin/views/properties.js` | 改为业主列表 |

### 测试

`tests/db/migration-v3.test.ts`（新建，本阶段核心）、
`tests/integration/public-page.test.ts`、`tests/services/reminder-service.test.ts`、
`tests/services/hosting-service.test.ts`、`tests/integration/security.test.ts`（改写 `/p/` 引用）

---

## 阶段划分

| 阶段 | 任务 | 交付 |
| --- | --- | --- |
| **一、数据层** | Task 1–7 | 迁移 v3 可用，既有数据零丢失，仓储层可读写业主页 |
| **二、领域与服务层** | Task 8–12 | URL 构造、发布、提醒、导出全部切到业主页 |
| **三、路由与公开页** | Task 13–18 | `/<slug>` 系列可用，防抓取生效，`/p/` 兼容跳转 |
| **四、后台界面** | Task 19–22 | 业主表格、业主页详情、全屏修复 |
| **五、收口与验证** | Task 23–26 | 测试迁移、冒烟、CSP、文档、双视口浏览器验证 |

---

# 阶段一：数据层

## Task 1: 迁移前置备份 + v3 空壳 + 迁移测试基建

先把「在已有数据的库上迁移」这件事变得**可测**，否则后面每一步都是盲改。

**Files:**
- Modify: `src/db/migrate.ts`
- Modify: `src/db/migrations.ts`（仅追加 v3 空迁移 + `upTo` 选项）
- Create: `tests/db/migration-v3.test.ts`

**Interfaces:**
- Consumes: `runMigrations(db)`（`src/db/migrations.ts:240`，每个迁移单独事务）
- Produces:
  - `runMigrations(db: Database, options?: MigrationOptions): MigrationResult`，`MigrationOptions = { upTo?: number }`
  - `migrateToLatest(databaseFile: string, options?: MigrateOptions)`，`MigrateOptions = { beforeMigrate?: (db: DatabaseSync) => void }`
  - 测试助手 `buildV2Database(): { db: DatabaseSync; seed: SeedCounts }`

- [ ] **Step 1: 写失败测试 —— 空库与有数据的库都能迁移，且数据计数不变**

```ts
// tests/db/migration-v3.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/migrations.ts';

interface SeedCounts {
  properties: number;
  photos: number;
  reminders: number;
  contacts: number;
  pages: number;
}

/** 建一个只跑到 v2 的库，并塞入接近真实形态的演示数据 */
function buildV2Database(): { db: DatabaseSync; seed: SeedCounts } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, { upTo: 2 });

  const now = '2026-10-12T00:00:00.000Z';
  db.exec(`INSERT INTO workspaces (id,name,owner_user_id,default_locale,default_currency,default_area_unit,default_timezone,hosting_provider,created_at,updated_at)
           VALUES ('ws1','测试','u1','zh-CN','CNY','square_meter','Asia/Shanghai','default','${now}','${now}')`);
  db.exec(`INSERT INTO users (id,workspace_id,email,display_name,role,created_at,updated_at)
           VALUES ('u1','ws1','a@b.c','甲','owner','${now}','${now}')`);

  for (const n of [1, 2, 3]) {
    db.exec(`INSERT INTO properties (id,workspace_id,title,description,address_line,district,city,region,country_code,postal_code,
             latitude,longitude,property_type,bedrooms,bathrooms,area_value,area_unit,floor_note,price_amount,price_currency,
             price_period,deposit_amount,deposit_currency,extra_fees_note,available_from,status,availability_status,created_at,updated_at)
             VALUES ('p${n}','ws1','房源${n}','','地址${n}','','上海','','CN','',31.2,121.4,'apartment',2,1,88,'square_meter','',
             8500,'CNY','per_month',NULL,'CNY','','2026-11-01','active','available','${now}','${now}')`);
    db.exec(`INSERT INTO listing_pages (id,property_id,workspace_id,slug,locale,template_id,status,published_at,view_count,created_at,updated_at)
             VALUES ('lp${n}','p${n}','ws1','slug-${n}','zh-CN','modern','published','${now}',0,'${now}','${now}')`);
    for (let i = 1; i <= 5; i++) {
      db.exec(`INSERT INTO media (id,property_id,kind,storage_key,external_url,mime_type,bytes,width,height,sort_order,is_cover,source_note,created_at)
               VALUES ('m${n}-${i}','p${n}','photo','p${n}/a${i}.jpg',NULL,'image/jpeg',1000,1600,1200,${i},${i === 1 ? 1 : 0},'','${now}')`);
    }
    db.exec(`INSERT INTO reminders (id,property_id,listing_page_id,kind,due_at,timezone,status,attempts,idempotency_key,created_at,updated_at)
             VALUES ('r${n}','p${n}','lp${n}','day7','2026-10-19T00:00:00.000Z','Asia/Shanghai','pending',0,'p${n}:day7','${now}','${now}')`);
    db.exec(`INSERT INTO contacts (id,workspace_id,property_id,display_name,channel_kind,channel_value,is_public,sort_order,created_at,updated_at)
             VALUES ('c${n}','ws1','p${n}','甲','phone','1380000123${n}',1,0,'${now}','${now}')`);
  }

  const count = (t: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return {
    db,
    seed: {
      properties: count('properties'),
      photos: (db.prepare("SELECT COUNT(*) AS n FROM media WHERE kind='photo'").get() as { n: number }).n,
      reminders: count('reminders'),
      contacts: count('contacts'),
      pages: count('listing_pages'),
    },
  };
}

test('空库可以迁移到 v3', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const result = runMigrations(db);
  assert.ok(result.applied.some((m) => m.version === 3), '应应用 v3');
  db.close();
});

test('已有数据的库迁移到 v3 后，各类数据计数不变', () => {
  const { db, seed } = buildV2Database();
  runMigrations(db);
  const count = (t: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

  assert.equal(count('properties'), seed.properties, '房源数不变');
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM media WHERE kind='photo'").get() as { n: number }).n,
    seed.photos,
    '照片数不变',
  );
  assert.equal(count('reminders'), seed.reminders, '提醒数不变');
  assert.equal(count('contacts'), seed.contacts, '联系方式数不变');
  assert.equal(count('landlord_pages'), seed.pages, '业主页数与原页面数一致');
  db.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: FAIL —— `runMigrations` 不接受第二个参数；且不存在 v3

- [ ] **Step 3: 给 `runMigrations` 加 `upTo` 选项，并追加 v3 空迁移**

```ts
// src/db/migrations.ts
export interface MigrationOptions {
  /** 只应用到该版本为止（测试用：构造旧版库） */
  upTo?: number;
}

export function runMigrations(db: Database, options: MigrationOptions = {}): MigrationResult {
  ensureMigrationTable(db);
  const done = new Set(appliedVersions(db));
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (options.upTo !== undefined && migration.version > options.upTo) break;
    if (done.has(migration.version)) {
      result.skipped.push(migration.version);
      continue;
    }

    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        nowIso(),
      );
      db.exec('COMMIT');
      result.applied.push({ version: migration.version, name: migration.name });
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 保留原始错误
      }
      throw new Error(
        `迁移 v${migration.version} (${migration.name}) 执行失败并已回滚：${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  return result;
}
```

```ts
// src/db/migrations.ts —— MIGRATIONS 数组追加（先空实现，后续任务逐步填充）
{
  version: 3,
  name: 'landlord_single_page',
  up: (db) => {
    // 按 spec §3.6.2 的 15 步依次填充
    void db;
  },
},
```

- [ ] **Step 4: 迁移前置备份（R4）**

`VACUUM INTO` 不能在事务内运行，因此备份必须由调用方在 `runMigrations` **之前**做。
`migrateToLatest` 目前只持有 `db`，改为接受一个可选回调，由上层注入备份能力：

```ts
// src/db/migrate.ts
export interface MigrateOptions {
  /** 在进入迁移事务前调用；用于生成备份快照。失败即中止迁移。 */
  beforeMigrate?: (db: DatabaseSync) => void;
}

export function migrateToLatest(
  databaseFile: string,
  options: MigrateOptions = {},
): { applied: string[]; skipped: number[] } {
  const db = openDatabase(databaseFile);
  try {
    options.beforeMigrate?.(db);
    const result = runMigrations(db);
    return {
      applied: result.applied.map((m) => `v${m.version} ${m.name}`),
      skipped: result.skipped,
    };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 6: 全量回归**

Run: `pnpm typecheck && pnpm test`
Expected: `tsc` 退出码 0；测试全绿（v3 此时为空迁移，不影响既有行为）

- [ ] **Step 7: 提交**

```bash
git add src/db/migrations.ts src/db/migrate.ts tests/db/migration-v3.test.ts
git commit -m "feat(db): 迁移 v3 空壳 + 迁移前备份接口 + 迁移测试基建"
```

---

## Task 2: `users` 表重建 + 历史数据用户

> **为什么 A 阶段就要做**：`landlord_pages.user_id` 是 `NOT NULL`，没有用户表就没有归属对象（spec §2.2）。

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/db/repositories/workspace-repo.ts`（`insertUser` 需补新增的 NOT NULL 列）
- Test: `tests/db/migration-v3.test.ts`

**Interfaces:**
- Consumes: Task 1 的 v3 空迁移
- Produces:
  - 表 `users` 新列：`password_hash` / `status` / `tier` / `member_until` / `free_quota_consumed` / `oneoff_credits` / `is_system`
  - 导出常量 `LEGACY_USER_ID = 'usr_legacy'`

- [ ] **Step 1: 写失败测试**

```ts
test('users 重建后具备账号字段，且既有用户被标记为系统账号', () => {
  const { db } = buildV2Database();
  runMigrations(db);

  const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['password_hash', 'status', 'tier', 'member_until', 'free_quota_consumed', 'oneoff_credits', 'is_system']) {
    assert.ok(cols.includes(c), `users 应有列 ${c}`);
  }

  // 既有 owner 用户必须标记为系统账号，否则会成为用户列表里一个永远登不上的账号
  const u = db.prepare("SELECT * FROM users WHERE id='u1'").get() as Record<string, unknown>;
  assert.equal(u['is_system'], 1);
  assert.equal(u['status'], 'active');
  assert.equal(u['tier'], 'pro');
});

test('迁移创建了历史数据用户，且其密码为不可登录的哨兵值', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  const legacy = db.prepare("SELECT * FROM users WHERE id='usr_legacy'").get() as Record<string, unknown>;
  assert.ok(legacy, '应存在历史数据用户');
  assert.equal(legacy['is_system'], 1);
  assert.equal(legacy['role'], 'viewer', 'role 不承载权限，不用 owner');
  assert.match(String(legacy['password_hash']), /^scrypt\$/, '哨兵值也应是结构合法的哈希');
});

test('users 的索引在重建后仍然存在', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  const idx = (db.prepare('PRAGMA index_list(users)').all() as { name: string }[]).map((i) => i.name);
  assert.ok(idx.includes('idx_users_email'), '邮箱唯一索引必须重建');
  assert.ok(idx.includes('idx_users_workspace'), '工作区索引必须重建');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: FAIL —— `users` 缺列

- [ ] **Step 3: 实现 v3 第 1–2 步**

```ts
// src/db/migrations.ts —— 常量
/** 迁移期的「历史数据」用户：承接所有既有业主页，运营者随后可改派 */
export const LEGACY_USER_ID = 'usr_legacy';
/** 不可登录的哨兵哈希：结构合法但永不匹配任何口令 */
const SENTINEL_PASSWORD_HASH = `scrypt$16384$8$1$${'0'.repeat(22)}$${'0'.repeat(86)}`;
```

```ts
// v3.up 内 —— 第 1 步：重建 users
// 不能用 ALTER TABLE ADD COLUMN：password_hash / status 是 NOT NULL，
// SQLite 会报 "Cannot add a NOT NULL column with default value NULL"。
// 选择重建而非加 DEFAULT：默认值会永久留在表定义里，
// 今后漏填 tier 的插入会静默变成 pro（最大配额）。
// 重建安全：此时 landlord_pages 尚未创建，且【全库没有任何表 REFERENCES users】。
db.exec(`
  CREATE TABLE users_new (
    id                   TEXT PRIMARY KEY,
    workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email                TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    role                 TEXT NOT NULL,
    password_hash        TEXT NOT NULL,
    status               TEXT NOT NULL,
    tier                 TEXT NOT NULL,
    member_until         TEXT,
    free_quota_consumed  INTEGER NOT NULL DEFAULT 0,
    oneoff_credits       INTEGER NOT NULL DEFAULT 0,
    is_system            INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  );
  INSERT INTO users_new
    (id, workspace_id, email, display_name, role, password_hash, status, tier,
     member_until, free_quota_consumed, oneoff_credits, is_system, created_at, updated_at)
  SELECT id, workspace_id, email, display_name, role,
         '${SENTINEL_PASSWORD_HASH}', 'active', 'pro', NULL, 1, 0, 1,
         created_at, updated_at
  FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE INDEX        idx_users_workspace ON users(workspace_id);
  CREATE UNIQUE INDEX idx_users_email     ON users(email);
  CREATE INDEX        idx_users_system    ON users(is_system);
`);
```

```ts
// v3.up 内 —— 第 2 步：历史数据用户
const ws = db.prepare('SELECT id FROM workspaces ORDER BY created_at LIMIT 1').get() as { id: string } | undefined;
if (!ws) throw new Error('迁移中止：库中没有工作区，无法归属历史数据');
db.prepare(
  `INSERT INTO users (id, workspace_id, email, display_name, role, password_hash,
                      status, tier, member_until, free_quota_consumed, oneoff_credits, is_system,
                      created_at, updated_at)
   VALUES (?, ?, 'legacy@local', '历史数据', 'viewer', ?, 'active', 'pro', NULL, 1, 0, 1, ?, ?)`,
).run(LEGACY_USER_ID, ws.id, SENTINEL_PASSWORD_HASH, nowIso(), nowIso());
```

- [ ] **Step 4: 同步 `insertUser`（新增 NOT NULL 列会让既有插入失败）**

```ts
// src/db/repositories/workspace-repo.ts
export function insertUser(
  db: Database,
  workspaceId: string,
  input: { email: string; displayName: string; role: string },
): void {
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, display_name, role, password_hash,
                        status, tier, member_until, free_quota_consumed, oneoff_credits, is_system,
                        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'pro', NULL, 1, 0, 1, ?, ?)`,
  ).run(
    `usr_${randomUUID()}`,
    workspaceId,
    input.email.trim().toLowerCase(),
    input.displayName,
    input.role,
    SENTINEL_PASSWORD_HASH,
    nowIso(),
    nowIso(),
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 6: 全量回归**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/db/migrations.ts src/db/repositories/workspace-repo.ts tests/db/migration-v3.test.ts
git commit -m "feat(db): v3 重建 users 表并创建历史数据用户"
```

---

## Task 3: 建 `landlord_pages` + 从 `listing_pages` 拷贝 + 孤儿补建

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `tests/db/migration-v3.test.ts`

**Interfaces:**
- Produces: 表 `landlord_pages`（列见 spec §3.1），索引 `idx_landlord_pages_slug` / `_user` / `_domain` / `_showcase`

- [ ] **Step 1: 写失败测试**

```ts
test('landlord_pages 承接 listing_pages 的 slug 与状态，且归属历史用户', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  const rows = db
    .prepare('SELECT id, slug, status, user_id, max_properties FROM landlord_pages ORDER BY slug')
    .all() as Record<string, unknown>[];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r['slug']), ['slug-1', 'slug-2', 'slug-3']);
  assert.ok(rows.every((r) => r['status'] === 'published'), 'status 原样拷贝');
  assert.ok(rows.every((r) => r['user_id'] === 'usr_legacy'), '归属历史数据用户');
  assert.ok(rows.every((r) => Number(r['max_properties']) >= 5), 'max_properties 不小于现有照片数');
  db.close();
});

test('从未建过页面的孤儿房源也会被补建业主页，不留 NULL 归属', () => {
  const { db } = buildV2Database();
  const now = '2026-10-12T00:00:00.000Z';
  db.exec(`INSERT INTO properties (id,workspace_id,title,description,address_line,district,city,region,country_code,postal_code,
           latitude,longitude,property_type,bedrooms,bathrooms,area_value,area_unit,floor_note,price_amount,price_currency,
           price_period,deposit_amount,deposit_currency,extra_fees_note,available_from,status,availability_status,created_at,updated_at)
           VALUES ('p_orphan','ws1','孤儿房源','','','','','','','',NULL,NULL,'','','','',NULL,'',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'draft','available','${now}','${now}')`);

  runMigrations(db);

  const orphan = db.prepare("SELECT landlord_page_id FROM properties WHERE id='p_orphan'").get() as { landlord_page_id: string | null };
  assert.ok(orphan.landlord_page_id, '孤儿房源必须有归属');
  const page = db.prepare('SELECT * FROM landlord_pages WHERE id=?').get(orphan.landlord_page_id) as Record<string, unknown>;
  assert.ok(page, '应存在对应业主页');
  assert.equal(page['owner_name'], '孤儿房源', '用标题兜底 owner_name');
  assert.equal(page['status'], 'unpublished', '新补建的页面未发布');
  db.close();
});

test('owner_name 或 slug 为空时有兜底，不会因 NOT NULL 失败', () => {
  const { db } = buildV2Database();
  const now = '2026-10-12T00:00:00.000Z';
  db.exec(`INSERT INTO properties (id,workspace_id,title,description,address_line,district,city,region,country_code,postal_code,
           latitude,longitude,property_type,bedrooms,bathrooms,area_value,area_unit,floor_note,price_amount,price_currency,
           price_period,deposit_amount,deposit_currency,extra_fees_note,available_from,status,availability_status,created_at,updated_at)
           VALUES ('p_empty','ws1','***','','','','','','','',NULL,NULL,'','','','',NULL,'',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'draft','available','${now}','${now}')`);
  runMigrations(db);
  const page = db
    .prepare("SELECT lp.owner_name, lp.slug FROM properties p JOIN landlord_pages lp ON lp.id = p.landlord_page_id WHERE p.id='p_empty'")
    .get() as Record<string, unknown>;
  assert.equal(page['owner_name'], '未命名房东');
  assert.match(String(page['slug']), /^landlord-/, 'slug 兜底为 landlord-<n>');
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: FAIL —— 表不存在

- [ ] **Step 3: 实现 v3 第 3–5 步**

```ts
// 第 3 步：建表 + 4 个索引
db.exec(`
  CREATE TABLE landlord_pages (
    id                  TEXT PRIMARY KEY,
    workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug                TEXT NOT NULL,
    owner_name          TEXT NOT NULL,
    max_properties      INTEGER NOT NULL,
    quota_source        TEXT NOT NULL,
    is_showcase         INTEGER NOT NULL DEFAULT 0,
    locale              TEXT NOT NULL,
    template_id         TEXT NOT NULL,
    status              TEXT NOT NULL,
    published_at        TEXT,
    withdrawn_at        TEXT,
    custom_domain       TEXT,
    domain_verify_token TEXT,
    domain_verified_at  TEXT,
    view_count          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_landlord_pages_slug     ON landlord_pages(slug);
  CREATE        INDEX idx_landlord_pages_user     ON landlord_pages(user_id);
  CREATE        INDEX idx_landlord_pages_domain   ON landlord_pages(custom_domain);
  CREATE        INDEX idx_landlord_pages_showcase ON landlord_pages(is_showcase, status);
`);

// 第 4 步：从 listing_pages 拷贝。
// 【关键】一套房源可能存在多条 listing_pages（存在删除路径），必须取 MIN(id) 那条，
// 否则要么命中唯一索引冲突，要么子查询返回多行。
db.exec(`
  INSERT INTO landlord_pages
    (id, workspace_id, user_id, slug, owner_name, max_properties, quota_source, is_showcase,
     locale, template_id, status, published_at, withdrawn_at, custom_domain,
     domain_verify_token, domain_verified_at, view_count, created_at, updated_at)
  SELECT
    lp.id, lp.workspace_id, '${LEGACY_USER_ID}',
    lp.slug,
    COALESCE(NULLIF(TRIM(p.title), ''), '未命名房东'),
    MAX(20, (SELECT COUNT(*) FROM media m WHERE m.property_id = p.id AND m.kind = 'photo')),
    'admin', 0,
    lp.locale, lp.template_id, lp.status, lp.published_at, lp.withdrawn_at, lp.custom_domain,
    lp.domain_verify_token, lp.domain_verified_at, lp.view_count, lp.created_at, lp.updated_at
  FROM listing_pages lp
  JOIN properties p ON p.id = lp.property_id
  WHERE lp.id = (SELECT MIN(l2.id) FROM listing_pages l2 WHERE l2.property_id = lp.property_id);
`);

// 第 5 步：孤儿房源补建业主页（有房源但没有任何 listing_pages）
// 在 JS 侧逐条处理，以便复用 slugify 与唯一 slug 生成：
const orphans = db.prepare(`
  SELECT p.id, p.title, p.created_at FROM properties p
  WHERE NOT EXISTS (SELECT 1 FROM listing_pages lp WHERE lp.property_id = p.id)
`).all() as { id: string; title: string; created_at: string }[];

// 用临时表记录「房源 → 业主页」映射，供第 8 步回填使用，
// 避免第 8 步用启发式匹配（标题可能重名）而连错。
db.exec('CREATE TEMP TABLE orphan_map (property_id TEXT PRIMARY KEY, landlord_page_id TEXT NOT NULL)');

for (const [index, orphan] of orphans.entries()) {
  const ownerName = orphan.title.trim() === '' || /^[^\p{L}\p{N}]+$/u.test(orphan.title.trim())
    ? '未命名房东'
    : orphan.title.trim();
  const base = slugify(ownerName) || `landlord-${index + 1}`;
  const slug = nextAvailableSlug(db, base);   // 复用既有实现，保证不与已拷贝的 slug 冲突
  const pageId = `lp_${orphan.id}`;
  db.prepare(`
    INSERT INTO landlord_pages
      (id, workspace_id, user_id, slug, owner_name, max_properties, quota_source, is_showcase,
       locale, template_id, status, view_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 20, 'admin', 0, 'zh-CN', 'modern', 'unpublished', 0, ?, ?)
  `).run(pageId, wsId, LEGACY_USER_ID, slug, ownerName, orphan.created_at, orphan.created_at);
  db.prepare('INSERT INTO orphan_map (property_id, landlord_page_id) VALUES (?, ?)').run(orphan.id, pageId);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/db/migrations.ts tests/db/migration-v3.test.ts
git commit -m "feat(db): v3 建 landlord_pages 承接 listing_pages，孤儿房源补建归属"
```

---

## Task 4: `properties` 归属列 + 索引 + 回填

> **SQLite 限制（spec §3.6.1 / D17）**：`NOT NULL` 外键列**无法**用 `ALTER TABLE ADD COLUMN` 添加
> （`NOT NULL` 要求非空默认值，而带 `REFERENCES` 的列在有外键约束时又要求默认值为 NULL，二者互斥）。
> 因此 DDL 上建成**可空**，靠「迁移回填 + 服务层校验 + 自检」三重保证实际非空。

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `tests/db/migration-v3.test.ts`

**Interfaces:**
- Produces: `properties.landlord_page_id`（可空 + `REFERENCES landlord_pages(id) ON DELETE CASCADE`）、`idx_properties_landlord`

- [ ] **Step 1: 写失败测试**

```ts
test('properties 归属列有索引，且迁移后不存在 NULL 归属', () => {
  const { db } = buildV2Database();
  runMigrations(db);

  const cols = (db.prepare('PRAGMA table_info(properties)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('landlord_page_id'), '应有归属列');

  const idx = (db.prepare('PRAGMA index_list(properties)').all() as { name: string }[]).map((i) => i.name);
  assert.ok(idx.includes('idx_properties_landlord'), '新维度必须有索引，否则等于全表扫描');

  const nulls = (db.prepare('SELECT COUNT(*) AS n FROM properties WHERE landlord_page_id IS NULL').get() as { n: number }).n;
  assert.equal(nulls, 0, '迁移结束后不得有 NULL 归属');
  db.close();
});

test('外键被真实启用：删除业主页会级联删除其房源', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  const pageId = (db.prepare("SELECT landlord_page_id AS id FROM properties WHERE id='p1'").get() as { id: string }).id;
  db.prepare('DELETE FROM landlord_pages WHERE id=?').run(pageId);
  const left = (db.prepare("SELECT COUNT(*) AS n FROM properties WHERE id='p1'").get() as { n: number }).n;
  assert.equal(left, 0, 'ON DELETE CASCADE 应生效');
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: FAIL —— 列不存在

- [ ] **Step 3: 实现 v3 第 6–8 步**

```ts
// 第 6 步：ADD COLUMN（可空 —— SQLite 无法给已有表加 NOT NULL 外键列）
db.exec('ALTER TABLE properties ADD COLUMN landlord_page_id TEXT REFERENCES landlord_pages(id) ON DELETE CASCADE');

// 第 7 步：索引（翻转后「按业主页查房源」是列表页与后台的主查询路径）
db.exec('CREATE INDEX idx_properties_landlord ON properties(landlord_page_id)');

// 第 8 步：回填
// (a) 有 listing_pages 的：按原 property_id 映射（取 MIN(id)，与第 4 步一致）
db.exec(`
  UPDATE properties SET landlord_page_id = (
    SELECT lp.landlord_page_id FROM listing_pages lp
    WHERE lp.property_id = properties.id ORDER BY lp.id LIMIT 1
  ) WHERE EXISTS (SELECT 1 FROM listing_pages lp WHERE lp.property_id = properties.id);
`);
// (b) 孤儿房源：按第 5 步记下的映射精确回填（不用标题启发式匹配，标题可能重名）
db.exec(`
  UPDATE properties SET landlord_page_id = (
    SELECT m.landlord_page_id FROM orphan_map m WHERE m.property_id = properties.id
  ) WHERE landlord_page_id IS NULL;
`);
// 复用完成后的临时表
db.exec('DROP TABLE orphan_map');
```

> **注意**：`orphan_map` 是 TEMP 表，不会持久化，但它在本迁移事务内有效 —— 第 5 步写入、第 8 步读取，顺序正确。若实施时选择不用临时表，则必须保证回填**不依赖标题匹配**。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/db/migrations.ts tests/db/migration-v3.test.ts
git commit -m "feat(db): v3 为 properties 增加归属列与索引并精确回填"
```

---

## Task 5: `contacts` 归属列 + 公开联系方式上移

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `tests/db/migration-v3.test.ts`

**Interfaces:**
- Produces: `contacts.landlord_page_id`、`idx_contacts_landlord`

- [ ] **Step 1: 写失败测试**

```ts
test('公开联系方式被上移到业主页级，房源级原件删除，总数不变', () => {
  const { db, seed } = buildV2Database();
  runMigrations(db);

  const total = (db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
  assert.equal(total, seed.contacts, 'contacts 总行数不变');

  const atPage = (db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE landlord_page_id IS NOT NULL').get() as { n: number }).n;
  assert.equal(atPage, seed.contacts, '公开记录应全部挂到业主页');

  const atProperty = (db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE property_id IS NOT NULL').get() as { n: number }).n;
  assert.equal(atProperty, 0, '公开的房源级记录应已上移并删除');
  db.close();
});

test('非公开的房源级联系方式原地保留', () => {
  const { db } = buildV2Database();
  const now = '2026-10-12T00:00:00.000Z';
  db.exec(`INSERT INTO contacts (id,workspace_id,property_id,display_name,channel_kind,channel_value,is_public,sort_order,created_at,updated_at)
           VALUES ('c_priv','ws1','p1','甲','phone','13900000000',0,1,'${now}','${now}')`);
  runMigrations(db);
  const row = db.prepare("SELECT property_id, landlord_page_id FROM contacts WHERE id='c_priv'").get() as Record<string, unknown>;
  assert.equal(row['property_id'], 'p1', '非公开记录不上移');
  assert.equal(row['landlord_page_id'], null);
  db.close();
});

test('上移时连同展示字段与排序一起拷贝', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  const row = db
    .prepare('SELECT * FROM contacts WHERE landlord_page_id IS NOT NULL ORDER BY channel_value LIMIT 1')
    .get() as Record<string, unknown>;
  assert.equal(row['channel_kind'], 'phone');
  assert.equal(row['display_name'], '甲');
  assert.equal(Number(row['sort_order']), 0);
  assert.equal(Number(row['is_public']), 1);
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 v3 第 9–10 步**

```ts
// 第 9 步：ADD COLUMN（contacts.property_id 本就可空，无需重建表）
db.exec('ALTER TABLE contacts ADD COLUMN landlord_page_id TEXT REFERENCES landlord_pages(id) ON DELETE CASCADE');
db.exec('CREATE INDEX idx_contacts_landlord ON contacts(landlord_page_id, sort_order)');

// 第 10 步：把【公开】的房源级联系方式上移到业主页级。
// 迁移时 1 页 : 1 房源，语义等价。连同展示字段与排序一起拷贝，保持展示顺序不变。
db.exec(`
  INSERT INTO contacts (id, workspace_id, property_id, landlord_page_id, display_name,
                        channel_kind, channel_value, is_public, sort_order, created_at, updated_at)
  SELECT 'ct_' || c.id, c.workspace_id, NULL, p.landlord_page_id, c.display_name,
         c.channel_kind, c.channel_value, c.is_public, c.sort_order, c.created_at, c.updated_at
  FROM contacts c
  JOIN properties p ON p.id = c.property_id
  WHERE c.is_public = 1 AND c.property_id IS NOT NULL AND p.landlord_page_id IS NOT NULL;
`);
// 删除已上移的原件（只删公开的；非公开的原地保留，因此总行数不变）
db.exec(`
  DELETE FROM contacts
  WHERE is_public = 1 AND property_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM properties p WHERE p.id = contacts.property_id AND p.landlord_page_id IS NOT NULL);
`);
```

> **为什么公开记录要「上移」**：公开页的联系方式链是「房源级 → 业主页级」。
> 若不上移，迁移后房源级公开记录为空，列表页就没有任何联系方式可显示。
> 上移是**本设计明确认可的例外**，「数据未丢失」应按**计数与归属**判定（spec 验收 12）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: PASS（13 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/db/migrations.ts tests/db/migration-v3.test.ts
git commit -m "feat(db): v3 联系方式归属业主页并上移公开记录"
```

---

## Task 6: 重建 `media`（`property_id` 可空 + `wechat_qr`）

**Files:**
- Modify: `src/db/migrations.ts`
- Test: `tests/db/migration-v3.test.ts`

**Interfaces:**
- Produces: `media.property_id` 可空、`media.landlord_page_id`、`idx_media_property`、`idx_media_landlord`

- [ ] **Step 1: 写失败测试**

```ts
test('media 重建后 property_id 可空，但既有照片仍挂在原房源上', () => {
  const { db, seed } = buildV2Database();
  runMigrations(db);

  const col = (db.prepare('PRAGMA table_info(media)').all() as { name: string; notnull: number }[])
    .find((c) => c.name === 'property_id');
  assert.equal(col?.notnull, 0, 'property_id 应改为可空');

  // 【关键】既有照片必须保留 property_id，不得置 NULL，否则房源照片全部消失
  const orphanPhotos = (db.prepare("SELECT COUNT(*) AS n FROM media WHERE kind='photo' AND property_id IS NULL").get() as { n: number }).n;
  assert.equal(orphanPhotos, 0, '既有照片不得丢归属');

  const total = (db.prepare("SELECT COUNT(*) AS n FROM media WHERE kind='photo'").get() as { n: number }).n;
  assert.equal(total, seed.photos, '照片总数不变');
  db.close();
});

test('media 的两个索引在重建后仍存在', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  const idx = (db.prepare('PRAGMA index_list(media)').all() as { name: string }[]).map((i) => i.name);
  assert.ok(idx.includes('idx_media_property'));
  assert.ok(idx.includes('idx_media_landlord'));
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 v3 第 11 步**

```ts
// 第 11 步：重建 media（SQLite 无法用 ALTER TABLE 去掉 NOT NULL）
// media 是叶子表（无子表），重建不会触发级联。
// 【关键】既有行的 property_id 原样保留 —— 置 NULL 会让所有房源照片从页面上消失。
db.exec(`
  CREATE TABLE media_new (
    id               TEXT PRIMARY KEY,
    property_id      TEXT REFERENCES properties(id) ON DELETE CASCADE,
    landlord_page_id TEXT REFERENCES landlord_pages(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL,
    storage_key      TEXT NOT NULL,
    external_url     TEXT,
    mime_type        TEXT NOT NULL,
    bytes            INTEGER NOT NULL,
    width            INTEGER,
    height           INTEGER,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    is_cover         INTEGER NOT NULL DEFAULT 0,
    source_note      TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL
  );
  INSERT INTO media_new
    (id, property_id, landlord_page_id, kind, storage_key, external_url, mime_type, bytes,
     width, height, sort_order, is_cover, source_note, created_at)
  SELECT id, property_id, NULL, kind, storage_key, external_url, mime_type, bytes,
         width, height, sort_order, is_cover, source_note, created_at
  FROM media;
  DROP TABLE media;
  ALTER TABLE media_new RENAME TO media;
  CREATE INDEX idx_media_property ON media(property_id, sort_order);
  CREATE INDEX idx_media_landlord ON media(landlord_page_id, sort_order);
`);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: PASS（15 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/db/migrations.ts tests/db/migration-v3.test.ts
git commit -m "feat(db): v3 重建 media 支持业主页归属，照片归属保持不变"
```

---

## Task 7: 重建 `reminders`（含去重）+ 删旧表 + 自检 + `BACKUP_TABLES`

> **这是最容易让迁移整个失败的一步**：幂等键改为 `${landlordPageId}:${kind}` 后，
> 一个业主页下多套房源的同类型提醒会撞 `idx_reminders_idempotency` 唯一索引，
> 不去重则**整个迁移事务回滚**。

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/services/backup-service.ts`
- Test: `tests/db/migration-v3.test.ts`

**Interfaces:**
- Produces: `reminders.landlord_page_id`（NOT NULL）、`idx_reminders_idempotency`（UNIQUE）、`idx_reminders_due`；`BACKUP_TABLES` 含 `landlord_pages`

- [ ] **Step 1: 写失败测试**

```ts
test('reminders 归属业主页，且索引（含唯一索引）全部重建', () => {
  const { db, seed } = buildV2Database();
  runMigrations(db);

  const total = (db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as { n: number }).n;
  assert.equal(total, seed.reminders, '提醒数不变');

  const cols = (db.prepare('PRAGMA table_info(reminders)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('landlord_page_id'));
  assert.ok(!cols.includes('property_id'), 'property_id 应已移除');

  const idx = db.prepare('PRAGMA index_list(reminders)').all() as { name: string; unique: number }[];
  const idem = idx.find((i) => i.name === 'idx_reminders_idempotency');
  assert.ok(idem, '幂等唯一索引必须重建 —— 「不重复轰炸用户」建立在它上面');
  assert.equal(idem?.unique, 1, '且必须是 UNIQUE');
  assert.ok(idx.some((i) => i.name === 'idx_reminders_due'));
  db.close();
});

test('同一业主页下多套房源的同类型提醒会去重，不会撞唯一索引', () => {
  // 构造：让 p1 与 p2 共享同一条 listing_pages，迁移后它们自然同页
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, { upTo: 2 });
  // …（按 buildV2Database 的同样方式插入数据，但把 lp2.property_id 设为 'p1'）
  // 于是 p1、p2 都映射到同一个 landlord_page，且各有一条 day7 提醒

  assert.doesNotThrow(() => runMigrations(db), '迁移不得因唯一索引冲突而回滚');

  const keys = (db.prepare('SELECT idempotency_key FROM reminders').all() as { idempotency_key: string }[])
    .map((r) => r.idempotency_key);
  assert.equal(new Set(keys).size, keys.length, '幂等键必须唯一');
  db.close();
});

test('自检：迁移后无 NULL 归属、外键完整', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM properties WHERE landlord_page_id IS NULL').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM landlord_pages WHERE user_id IS NULL').get() as { n: number }).n, 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], '不得有外键违规');
  db.close();
});

test('BACKUP_TABLES 已切换为 landlord_pages，备份校验不会误报缺表', () => {
  assert.ok(BACKUP_TABLES.includes('landlord_pages'));
  assert.ok(!(BACKUP_TABLES as readonly string[]).includes('listing_pages'));
});
```

> 第二个用例需要改造 `buildV2Database`：给它加一个可选参数
> `sharedPage?: boolean`，为真时让 `lp2.property_id` 指向 `p1`，
> 从而制造「迁移后同页同类提醒」的场景。实现时按此扩展。

- [ ] **Step 2: 运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 v3 第 12 步（含去重与冲突检测）**

```ts
// 第 12 步：重建 reminders。
// 【关键】幂等键由 ${propertyId}:${kind} 改为 ${landlordPageId}:${kind} 后，
// 同页多房源的同类型提醒会重写成同一个键 —— 不去重会撞 UNIQUE 索引，
// 导致【整个迁移事务回滚】。
db.exec(`
  CREATE TABLE reminders_new (
    id               TEXT PRIMARY KEY,
    landlord_page_id TEXT NOT NULL REFERENCES landlord_pages(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL,
    due_at           TEXT NOT NULL,
    timezone         TEXT NOT NULL,
    status           TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at  TEXT,
    last_error       TEXT,
    completed_at     TEXT,
    idempotency_key  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
`);

// 去重：按 (landlord_page_id, kind) 分组，保留 due_at 最早的一条（相同则取 id 最小）
db.exec(`
  INSERT INTO reminders_new
    (id, landlord_page_id, kind, due_at, timezone, status, attempts,
     last_attempt_at, last_error, completed_at, idempotency_key, created_at, updated_at)
  SELECT r.id, p.landlord_page_id, r.kind, r.due_at, r.timezone, r.status, r.attempts,
         r.last_attempt_at, r.last_error, r.completed_at,
         p.landlord_page_id || ':' || r.kind,
         r.created_at, r.updated_at
  FROM reminders r
  JOIN properties p ON p.id = r.property_id
  WHERE r.id = (
    SELECT r2.id FROM reminders r2
    JOIN properties p2 ON p2.id = r2.property_id
    WHERE p2.landlord_page_id = p.landlord_page_id AND r2.kind = r.kind
    ORDER BY r2.due_at ASC, r2.id ASC
    LIMIT 1
  );
`);

// 写入前冲突检测：若仍重复则报错中止（不静默丢数据）
const dup = db.prepare(
  'SELECT idempotency_key FROM reminders_new GROUP BY idempotency_key HAVING COUNT(*) > 1',
).all() as { idempotency_key: string }[];
if (dup.length > 0) {
  throw new Error(`迁移中止：提醒幂等键去重后仍有冲突 → ${dup.map((d) => d.idempotency_key).join(', ')}`);
}

db.exec(`
  DROP TABLE reminders;
  ALTER TABLE reminders_new RENAME TO reminders;
  CREATE UNIQUE INDEX idx_reminders_idempotency ON reminders(idempotency_key);
  CREATE        INDEX idx_reminders_due         ON reminders(status, due_at);
`);
```

- [ ] **Step 4: 实现 v3 第 13–14 步（删旧表 + 自检）**

```ts
// 第 13 步：删除 listing_pages（此时已无外键指向它）
db.exec('DROP TABLE listing_pages');

// 第 14 步：自检 —— 任一不满足即抛错，整个迁移回滚（不静默通过）
const nullProps = (db.prepare('SELECT COUNT(*) AS n FROM properties WHERE landlord_page_id IS NULL').get() as { n: number }).n;
if (nullProps > 0) throw new Error(`迁移自检失败：${nullProps} 条房源没有归属业主页`);
const nullPages = (db.prepare('SELECT COUNT(*) AS n FROM landlord_pages WHERE user_id IS NULL').get() as { n: number }).n;
if (nullPages > 0) throw new Error(`迁移自检失败：${nullPages} 个业主页没有归属用户`);
const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
if (fkViolations.length > 0) throw new Error(`迁移自检失败：存在外键违规 ${JSON.stringify(fkViolations)}`);
```

- [ ] **Step 5: 更新 `BACKUP_TABLES`**

```ts
// src/services/backup-service.ts:22-33
export const BACKUP_TABLES = [
  'workspaces',
  'users',
  'properties',
  'property_translations',
  'contacts',
  'media',
  'landlord_pages',   // ← 由 listing_pages 换为 landlord_pages
  'reminders',
  'external_service_configs',
  'audit_logs',
] as const;
```

> **不做这一步的后果**：`verifyBackupFile()`（`backup-service.ts:265-267`）对计数为 -1 的表
> 报「快照中缺少表」→ **迁移后每一份备份都 `ok=false`**，备份体系静默失效。

- [ ] **Step 6: 迁移后实跑一次备份 + 校验，确认 `ok=true`（硬要求）**

```bash
pnpm start          # 另开一个终端保持服务运行
# 登录后触发备份与校验（或直接调用服务层函数）
curl -s -X POST http://127.0.0.1:3210/api/admin/backups \
  -H "Cookie: admin_session=<登录后拿到的 cookie>" | head -c 400
curl -s -X POST http://127.0.0.1:3210/api/admin/backups/verify \
  -H "Content-Type: application/json" \
  -H "Cookie: admin_session=<登录后拿到的 cookie>" \
  -d '{"file":"<上一步返回的备份文件名>"}'
```

Expected: 校验返回 `"ok": true`。**若为 false，本任务不算完成。**

- [ ] **Step 7: 运行测试确认通过**

Run: `node --disable-warning=ExperimentalWarning --test tests/db/migration-v3.test.ts`
Expected: PASS（19 个用例）

- [ ] **Step 8: 在真实演示库上演练（不是空库）**

```bash
cp var/db/app.sqlite var/db/app.sqlite.before-v3   # 先留一份后路
pnpm migrate
pnpm smoke
node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('var/db/app.sqlite');
console.log('photos =', db.prepare(\"SELECT COUNT(*) n FROM media WHERE kind='photo'\").get().n);
console.log('landlord_pages =', db.prepare('SELECT COUNT(*) n FROM landlord_pages').get().n);
console.log('nulls =', db.prepare('SELECT COUNT(*) n FROM properties WHERE landlord_page_id IS NULL').get().n);
db.close();
"
```

Expected: 照片 15 张、业主页 3 个、NULL 归属 0；`pnpm smoke` 全绿

- [ ] **Step 9: 提交**

```bash
git add src/db/migrations.ts src/services/backup-service.ts tests/db/migration-v3.test.ts
git commit -m "feat(db): v3 重建 reminders 去重、删旧表、加自检并更新备份表清单"
```



---

# 阶段二：领域与服务层

## Task 8: `hosting.ts` URL 构造改 `/<slug>`

> **这是全链路唯一的 URL 构造点**：分享链接、二维码内容、提醒邮件正文、导出包 `share-url.txt`
> 都由它产出。漏改则前端、邮件、导出全部输出旧地址。

**Files:**
- Modify: `src/domain/hosting.ts:26/40`
- Test: `tests/services/hosting-service.test.ts:105`

**Interfaces:**
- Produces: `buildDefaultPublicUrl(base, slug)` → `${base}/${slug}`；`buildCustomDomainUrl(domain, slug)` → `https://${domain}/${slug}`

- [ ] **Step 1: 写失败测试**

```ts
test('分享链接指向 /<slug> 而不是 /p/<slug>', () => {
  assert.equal(buildDefaultPublicUrl('https://zhirai.cloud', 'wang-ayi'), 'https://zhirai.cloud/wang-ayi');
  assert.equal(buildCustomDomainUrl('listings.example.com', 'wang-ayi'), 'https://listings.example.com/wang-ayi');
});

test('slug 会被安全编码，中文后缀不产生非法 URL', () => {
  assert.equal(buildDefaultPublicUrl('https://x.test', '王阿姨'), 'https://x.test/%E7%8E%8B%E9%98%BF%E5%A7%A8');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --disable-warning=ExperimentalWarning --test tests/services/hosting-service.test.ts`
Expected: FAIL —— 仍是 `/p/<slug>`

- [ ] **Step 3: 实现**

```ts
// src/domain/hosting.ts
export function buildDefaultPublicUrl(base: string, slug: string): string {
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(slug)}`;
}
export function buildCustomDomainUrl(domain: string, slug: string): string {
  return `https://${domain}/${encodeURIComponent(slug)}`;
}
```

- [ ] **Step 4: 同步改写所有断言旧地址的用例**

Run: `grep -rn "'/p/" tests/ src/ public/ | grep -v node_modules`
逐条处理（`tests/services/hosting-service.test.ts`、`tests/services/reminder-service.test.ts:73`、
`tests/integration/security.test.ts:39/63`、`public/admin/views/property-edit.js:479` 等）。
**本任务只改 URL 构造与断言；路由本身在 Task 13 处理。**

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/domain/hosting.ts tests/
git commit -m "feat(hosting): 分享链接地址由 /p/<slug> 改为 /<slug>"
```

---

## Task 9: `landlord-page-repo` + `domain/landlord-page.ts`

**Files:**
- Create: `src/db/repositories/landlord-page-repo.ts`（由 `listing-page-repo.ts` 演进）
- Create: `src/domain/landlord-page.ts`（由 `domain/listing-page.ts` 演进）
- Delete: `src/db/repositories/listing-page-repo.ts`、`src/domain/listing-page.ts`（迁移完成后）

**Interfaces:**
- Consumes: 表 `landlord_pages`（Task 3）
- Produces:
  - `getLandlordPageBySlug(db, slug): LandlordPage | null`
  - `getLandlordPageByProperty(db, propertyId): LandlordPage | null`
  - `listPropertiesOfPage(db, pageId): Property[]`
  - `nextAvailableSlug(db, base): string`（从旧 repo 平移）
  - `assertPublishTransition(current, next)`（**签名与实现完全不变**，只改文件名与导入路径）

- [ ] **Step 1: 先平移文件，保持行为不变**

将 `listing-page-repo.ts` 复制为 `landlord-page-repo.ts`，把表名与类型名从 `listing_pages`/`ListingPage`
改为 `landlord_pages`/`LandlordPage`，**保留 `nextAvailableSlug` 与全部查询逻辑**。
`domain/listing-page.ts` 同理改为 `domain/landlord-page.ts`，
**`LISTING_STATUSES` / `assertPublishTransition` / `statusLabel` 的实现一个字都不改**
（穷举 `Record` 加值会编译失败 —— 见全局约束）。

- [ ] **Step 2: 写测试**

```ts
test('按 slug 能取到业主页，按房源能反查所属业主页', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  const page = getLandlordPageBySlug(db, 'slug-1');
  assert.ok(page);
  assert.equal(page.slug, 'slug-1');

  const back = getLandlordPageByProperty(db, 'p1');
  assert.equal(back?.id, page.id);
});

test('一个业主页下的多套房源都能列出来', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  // 把 p2 也挂到 p1 的业主页，验证「一页多房」
  const pageId = getLandlordPageByProperty(db, 'p1')!.id;
  db.prepare('UPDATE properties SET landlord_page_id=? WHERE id=?').run(pageId, 'p2');
  assert.equal(listPropertiesOfPage(db, pageId).length, 2);
});

test('nextAvailableSlug 能避开已占用的地址', () => {
  const { db } = buildV2Database();
  runMigrations(db);
  assert.equal(nextAvailableSlug(db, 'slug-1'), 'slug-1-2');
  assert.equal(nextAvailableSlug(db, 'brand-new'), 'brand-new');
});
```

- [ ] **Step 3: 运行 + 提交**

Run: `pnpm typecheck && pnpm test`

```bash
git add src/db/repositories/landlord-page-repo.ts src/domain/landlord-page.ts tests/
git commit -m "refactor: listing-page 演进为 landlord-page（仓储与领域）"
```

---

## Task 10: `publish-service` 改为业主页发布

**Files:**
- Modify: `src/services/publish-service.ts:145/178-182`
- Test: `tests/services/publish-service.test.ts`

**Interfaces:**
- Produces: `publishLandlordPage(ctx, pageId)`、`collectPublishReadiness(db, pageId)`（**改动点**：`aggregateFor` 的联系方式链改为「房源级 → 业主页级」，不下探工作区级）

- [ ] **Step 1: 写失败测试**

```ts
test('预览与就绪校验不下探工作区级联系方式', () => {
  // 工作区级有一条公开电话（运营者自己的）
  insertWorkspaceContact(db, wsId, { channelKind: 'phone', channelValue: '13900000000', isPublic: true });
  // 业主页级没有任何联系方式
  const readiness = collectPublishReadiness(db, pageId);
  assert.ok(!JSON.stringify(readiness).includes('13900000000'), '不得把运营者号码算作可用联系方式');
});

test('就绪校验要求至少一套可展示房源', () => {
  // 把该页所有房源置为 draft
  db.prepare("UPDATE properties SET status='draft' WHERE landlord_page_id=?").run(pageId);
  const r = collectPublishReadiness(db, pageId);
  assert.equal(r.ready, false);
  assert.ok(r.blockers.some((b) => b.includes('房源')), '应明确指出「没有可展示的房源」');
});
```

- [ ] **Step 2: 实现**

`aggregateFor` 的联系方式取值改为 `listEffectivePublicContactsForPage(db, pageId)`
（新函数，链为「房源级 → 业主页级」，见 Task 11）；就绪校验追加一条
「至少一套 `properties.status NOT IN ('draft','archived')` 的房源」。

- [ ] **Step 3: 运行 + 提交**

```bash
git add src/services/publish-service.ts tests/
git commit -m "feat(publish): 发布与就绪校验改为业主页维度"
```

---

## Task 11: `contact-repo` 两级公开链

**Files:**
- Modify: `src/db/repositories/contact-repo.ts:119-127`
- Test: `tests/services/property-service.test.ts`、新增用例

**Interfaces:**
- Produces:
  - `listEffectivePublicContacts(db, workspaceId, propertyId)` —— **改为**「房源级 → 业主页级」，**不再回落工作区级**
  - `listPublicContactsForPage(db, pageId)` —— 仅业主页级（列表页用）
  - `listContactsWithSource(...)` —— 后台内部用，保持三级不变

- [ ] **Step 1: 写失败测试**

```ts
test('公开链为「房源级 → 业主页级」，工作区级绝不出现', () => {
  insertWorkspaceContact(db, wsId, { channelKind: 'phone', channelValue: '13900000000', isPublic: true });
  const none = listEffectivePublicContacts(db, wsId, 'p1');
  assert.deepEqual(none, [], '工作区级不得成为兜底 —— 否则运营者号码会出现在每个业主页');
});

test('房源级优先，无房源级时回落到业主页级', () => {
  // 仅业主页级有联系方式
  const list = listEffectivePublicContacts(db, wsId, 'p1');
  assert.equal(list[0]?.channelValue, '13800001231');  // 来自 Task 5 上移的记录
});
```

- [ ] **Step 2: 实现**

```ts
export function listEffectivePublicContacts(db: Database, _workspaceId: string, propertyId: string): Contact[] {
  const propertyContacts = listPropertyContacts(db, propertyId).filter((c) => c.isPublic);
  if (propertyContacts.length > 0) return propertyContacts;

  const page = getLandlordPageByProperty(db, propertyId);
  if (!page) return [];
  return listPageContacts(db, page.id).filter((c) => c.isPublic);
  // 注意：刻意不回落工作区级 —— 新模型下工作区级即运营者本人
}
```

- [ ] **Step 3: 运行 + 提交**

```bash
git add src/db/repositories/contact-repo.ts tests/
git commit -m "feat(contact): 公开联系方式链改为房源级→业主页级，不再暴露工作区级"
```

---

## Task 12: 提醒与导出切到业主页

**Files:**
- Modify: `src/services/reminder-service.ts:56-71/249`、`src/db/repositories/reminder-repo.ts`
- Modify: `src/services/export-service.ts:74-113`

**Interfaces:**
- Produces: 幂等键 `${landlordPageId}:${kind}`；导出产物为「列表页 × 语言 + 每套详情页 × 语言 + assets」

- [ ] **Step 1: 写失败测试（提醒）**

```ts
test('幂等键以业主页为维度', () => {
  const page = getLandlordPageByProperty(db, 'p1')!;
  const plan = buildReminderPlan(page.id, new Date());
  assert.ok(plan.every((r) => r.idempotencyKey.startsWith(`${page.id}:`)));
});

test('同一业主页下多套房源只生成一对提醒', () => {
  db.prepare('UPDATE properties SET landlord_page_id=? WHERE id=?').run(pageId, 'p2');
  scheduleRemindersForPage(ctx, pageId);
  const rows = db.prepare('SELECT * FROM reminders WHERE landlord_page_id=?').all(pageId);
  assert.equal(rows.length, 2, '第 7 天 + 第 15 天，各一条');
});
```

- [ ] **Step 2: 写失败测试（导出）**

```ts
test('导出产物含列表页与每套详情页，页间为相对链接', async () => {
  const files = await exportLandlordPage(ctx, pageId);
  assert.ok(files.some((f) => f.path === 'index.html'), '应有列表页');
  assert.ok(files.some((f) => /^p-.*\.html$/.test(f.path)), '应有详情页');
  const list = files.find((f) => f.path === 'index.html')!;
  assert.ok(!list.content.includes('href="/'), '不得有绝对路径，离线包必须可相对打开');
});
```

- [ ] **Step 3: 实现 + 运行 + 提交**

```bash
git add src/services/reminder-service.ts src/db/repositories/reminder-repo.ts src/services/export-service.ts tests/
git commit -m "feat: 提醒与静态导出切换到业主页维度"
```

---

# 阶段三：路由与公开页

## Task 13: 公开路由搬到 `/<slug>`

**Files:**
- Modify: `src/http/routes/public-pages.ts:20/104/124`
- Test: `tests/integration/public-page.test.ts`

**Interfaces:**
- Produces: `GET /<slug>`、`GET /<slug>/<propertyId>`、`GET /<slug>/qr.svg`、`GET /<slug>/nearby.json`

- [ ] **Step 1: 写失败测试**

```ts
test('业主页列表可通过 /<slug> 匿名访问', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('房源1'), '应列出该业主页下的房源');
});

test('房源详情在 /<slug>/<id>', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1/p1' });
  assert.equal(res.statusCode, 200);
});

test('路由匹配优先级：保留字优先于房源 id', async () => {
  // 造一个 id 恰好叫 qr.svg 的房源（极端情况）
  const res = await t.app.inject({ method: 'GET', url: '/slug-1/qr.svg' });
  assert.equal(res.headers['content-type'], 'image/svg+xml', '应命中二维码路由而非房源查询');
});

test('未发布的业主页返回 404，不泄露它是否存在', async () => {
  db.prepare("UPDATE landlord_pages SET status='unpublished' WHERE slug='slug-2'").run();
  const res = await t.app.inject({ method: 'GET', url: '/slug-2' });
  assert.equal(res.statusCode, 404);
});
```

- [ ] **Step 2: 实现路由匹配顺序**

```ts
const RESERVED = new Set(['qr.svg', 'nearby.json', 'contact']);

app.get('/:slug', handlerForIndex);
app.get('/:slug/:second', async (request, reply) => {
  const { slug, second } = request.params;
  if (RESERVED.has(second)) return handleReserved(slug, second, request, reply);
  return handlePropertyDetail(slug, second, request, reply);   // 查不到 → 404
});
```

- [ ] **Step 3: 运行 + 提交**

```bash
git add src/http/routes/public-pages.ts tests/
git commit -m "feat(routes): 公开页路由搬到 /<slug>，含保留字匹配优先级"
```

---

## Task 14: `/p/<slug>` 301 兼容（含子路径）

> **房东可能已经把旧链接发到微信群里了。** 不做这一步，那些链接全部失效。

**Files:**
- Modify: `src/http/routes/public-pages.ts`
- Test: `tests/integration/public-page.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('旧链接 /p/<slug> 301 到 /<slug>', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/p/slug-1' });
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers['location'], '/slug-1');
});

test('旧子路径也被覆盖', async () => {
  for (const [from, to] of [['/p/slug-1/qr.svg', '/slug-1/qr.svg'], ['/p/slug-1/nearby.json', '/slug-1/nearby.json']]) {
    const res = await t.app.inject({ method: 'GET', url: from });
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers['location'], to);
  }
});

test('重定向是 301 而不是 302（已发出的链接应被永久改写）', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/p/slug-1' });
  assert.equal(res.statusCode, 301);
});
```

- [ ] **Step 2: 实现 + 运行 + 提交**

```bash
git add src/http/routes/public-pages.ts tests/
git commit -m "feat(routes): 旧链接 /p/<slug> 及其子路径 301 到新地址"
```

---

## Task 15: 联系方式防抓取（首屏直出 + 点击取回 + 限流）

> **Review Focus #5**：爬虫读的是源码，不是屏幕。仅用 CSS/JS 遮蔽等于没做。

**Files:**
- Create: `src/domain/mask.ts`、`src/http/contact-rate-limit.ts`
- Modify: `src/http/routes/public-pages.ts`、`src/render/page-renderer.ts`

**Interfaces:**
- Produces:
  - `maskContact(kind: string, value: string): string`
  - `GET /<slug>/contact/<contactId>` → `{ kind, masked, value }`（限流）
  - `GET /<slug>/contact/<contactId>/qr` → 图片或 404
  - 首屏 HTML 只渲染 `{ kind, masked, contactId }`

- [ ] **Step 1: 写失败测试（掩码规则，六类渠道）**

```ts
test('掩码规则覆盖全部渠道类型', () => {
  assert.equal(maskContact('phone', '13800001234'), '138****1234');
  assert.equal(maskContact('phone', '1234567'), '*****67');        // <8 位只留末 2
  assert.equal(maskContact('email', 'zhang@example.com'), 'z***@example.com');
  assert.equal(maskContact('wechat', 'zhangsan'), 'zh***n');       // 首 2 末 1
  assert.equal(maskContact('wechat', 'ab'), '**');                 // 长度 ≤3 全替换
  assert.equal(maskContact('other', 'x'), '*');
});

test('掩码后不得残留完整原值', () => {
  for (const [k, v] of [['phone', '13800001234'], ['email', 'zhang@example.com'], ['wechat', 'zhangsan']]) {
    assert.ok(!maskContact(k, v).includes(v), `${k} 的掩码不得包含原值`);
  }
});
```

- [ ] **Step 2: 写失败测试（首屏不含敏感数据）**

```ts
test('首屏 HTML 不含完整电话号码与二维码数据', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1' });
  assert.ok(!res.body.includes('13800001231'), '首屏不得出现完整号码');
  assert.ok(!/data:image\/[a-z+]+;base64,/.test(res.body), '首屏不得内联二维码图片');
  assert.ok(res.body.includes('138****1231'), '但应显示掩码');
});

test('点击后才可取回完整值', async () => {
  const list = await t.app.inject({ method: 'GET', url: '/slug-1' });
  const id = /data-contact-id="([^"]+)"/.exec(list.body)?.[1];
  assert.ok(id, '首屏应带 contactId 供点击时取回');

  const res = await t.app.inject({ method: 'GET', url: `/slug-1/contact/${id}` });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).value, '13800001231');
});

test('取回接口按 IP + 业主页限流，超限 429', async () => {
  for (let i = 0; i < 20; i++) await t.app.inject({ method: 'GET', url: `/slug-1/contact/${id}` });
  const res = await t.app.inject({ method: 'GET', url: `/slug-1/contact/${id}` });
  assert.equal(res.statusCode, 429);
  assert.ok(JSON.parse(res.body).error.message.includes('频繁'), '应给出可读提示');
});

test('二维码未上传时返回 404，前端回退为显示微信号', async () => {
  const res = await t.app.inject({ method: 'GET', url: `/slug-1/contact/${qrContactId}/qr` });
  assert.equal(res.statusCode, 404);
});
```

- [ ] **Step 3: 实现**

`src/domain/mask.ts` 按上表实现四类规则；限流器用内存 Map（`ip + pageId` → 时间戳数组，
阈值从配置读，默认 20 次 / 10 分钟），超限返回 429。

- [ ] **Step 4: 运行 + 提交**

```bash
git add src/domain/mask.ts src/http/contact-rate-limit.ts src/http/routes/public-pages.ts src/render/page-renderer.ts tests/
git commit -m "feat(contact): 首屏只出掩码，完整值与二维码点击后取回并按 IP 限流"
```

---

## Task 16: 业主页列表页渲染

**Files:**
- Create: `src/render/landlord-index-renderer.ts`
- Test: `tests/integration/public-page.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('列表页展示业主称呼与每套房的卡片，卡片链到详情', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1' });
  assert.ok(res.body.includes('房源1'), '应显示房源标题');
  assert.ok(res.body.includes('href="/slug-1/p1"'), '卡片应链到详情');
  assert.ok(res.body.includes('¥8,500'), '应显示价格');
});

test('列表页不展示 draft 与 archived 的房源', async () => {
  db.prepare("UPDATE properties SET status='draft' WHERE id='p2'").run();
  db.prepare("UPDATE properties SET status='archived' WHERE id='p3'").run();
  const res = await t.app.inject({ method: 'GET', url: '/slug-1' });
  assert.ok(!res.body.includes('房源2'));
  assert.ok(!res.body.includes('房源3'));
});

test('底栏联系渠道只取业主页级；没有则不渲染底栏', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1' });
  assert.ok(!res.body.includes('13900000000'), '运营者号码不得出现');
});
```

- [ ] **Step 2: 实现（移动端优先，复用既有卡片语言与图标）**

产物为完整 HTML：顶部业主称呼、房源卡片列表（主图 + 标题 + 价格 + 室卫 + 状态标签）、
底部固定联系栏。样式复用 `BASE_CSS`，图标用 `src/render/icons.ts`。

- [ ] **Step 3: 运行 + 提交**

```bash
git add src/render/landlord-index-renderer.ts tests/
git commit -m "feat(render): 业主页列表页（卡片列表 + 底部联系栏）"
```

---

## Task 17: 详情页三处改造（联系方式 / 费用区 / 介绍折叠）

**Files:**
- Modify: `src/render/page-renderer.ts`（`renderContacts` / `renderCosts` / `renderAbout`）
- Test: `tests/integration/public-page.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('费用区四项同排，价格单位紧跟价格', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1/p1' });
  const html = res.body;
  assert.ok(/8,500\s*元\/月|8,500\s*CNY\/月/.test(html), '价格应带单位');
  for (const label of ['价格', '押金', '计价方式', '可入住']) {
    assert.ok(html.includes(label), `费用区应有「${label}」`);
  }
  assert.ok(html.includes('附加费用'), '附加费用应单独一排');
});

test('房源介绍默认折叠为三行并可展开', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1/p1' });
  assert.ok(res.body.includes('<details'), '应用原生 details 折叠');
  assert.ok(res.body.includes('line-clamp') || res.body.includes('-webkit-line-clamp'), '默认只显示前三行');
});

test('联系方式区只有图标按钮，没有明文号码', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1/p1' });
  assert.ok(!res.body.includes('tel:'), '首屏不得生成 tel: 链接');
  assert.ok(res.body.includes('data-contact-id'), '应带 contactId 供点击取回');
});
```

- [ ] **Step 2: 实现 + 运行 + 提交**

```bash
git add src/render/page-renderer.ts src/render/templates.ts tests/
git commit -m "feat(render): 详情页联系方式图标化、费用区四项同排、介绍默认折叠"
```

---

## Task 18: CSP 判定改按路由

> **不改的后果**：路由搬到 `/<slug>` 后，`app.ts:118` 仍按 `/p/` 前缀判断是否允许内联样式，
> **地图瓦片与全部内联 style 会被 CSP 拦掉** —— 页面表现为地图空白、样式错乱。

**Files:**
- Modify: `src/http/app.ts:117-118`、`src/http/app.ts:197`（404 页返回入口）
- Test: `tests/integration/security.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('业主页的 CSP 允许内联样式（地图与 tile 定位需要）', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/slug-1' });
  assert.match(String(res.headers['content-security-policy']), /style-src[^;]*'unsafe-inline'/);
});

test('后台页面的 CSP 仍不允许内联样式（保持严格）', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/admin/' });
  assert.ok(!/style-src[^;]*'unsafe-inline'/.test(String(res.headers['content-security-policy'])));
});
```

- [ ] **Step 2: 实现**

```ts
// src/http/app.ts:117-118 —— 由「/p/ 前缀」改为「按路由判定」
const isPublicListingPage =
  request.url.startsWith('/p/') ||                      // 兼容期保留
  isLandlordPageUrl(request.url) ||                     // /<slug> 与 /<slug>/<id>
  /\/api\/admin\/properties\/[^/]+\/preview(\?|$)/.test(request.url);
```

`isLandlordPageUrl` 放在 `src/http/routes/public-pages.ts` 并导出，
判定规则：单段路径，或两段且第二段不是保留字；且**排除全部保留前缀**
（`/admin`、`/api`、`/media`、`/healthz`、`/assets`、`/favicon.ico`、`/login`、`/register`、`/app`、`/p`）。

- [ ] **Step 3: 运行 + 提交**

```bash
git add src/http/app.ts src/http/routes/public-pages.ts tests/
git commit -m "fix(csp): 内联样式判定改按路由，修复新地址下地图与样式被拦"
```

---

# 阶段四：后台界面

## Task 19: 后台首页改为业主表格

**Files:**
- Modify: `public/admin/views/properties.js` → 重命名为 `landlords.js`
- Modify: `public/admin/app.js`（路由与导航）
- Test: 浏览器验证（阶段五）

- [ ] **Step 1: 实现**

统计条改为**业主口径**：业主数 · 已发布 · 总访问量 · 本月生成。
表格列：业主 · 地址 · 房源数 · 状态 · 访问量 · 创建时间 · 操作
（管理 / 复制分享链接 / 二维码 / 导出HTML / 撤下）。
「撤下」复用既有 `withdraw` 路由 —— **不新增归档状态**。

- [ ] **Step 2: 窄屏卡片化（沿用既有 `.list-table` + `data-label` 机制）**

- [ ] **Step 3: 提交**

```bash
git add public/admin/
git commit -m "feat(admin): 后台首页改为业主表格与业主口径指标"
```

---

## Task 20: 后台业主页详情

**Files:**
- Modify: `public/admin/views/property-edit.js` → `landlord-edit.js`

- [ ] **Step 1: 实现**

区块：基本信息（称呼/地址/状态/模板/语言）· 房源列表（该业主的多套房，可增删改）·
联系方式（**业主页级** + 微信二维码上传/删除）· 分享与导出 · 改动记录。

**移除**原「发布页」标签 —— 页面就是业主页本身，不再是房源的附属。

- [ ] **Step 2: 提交**

```bash
git add public/admin/
git commit -m "feat(admin): 业主页详情，移除「发布页」标签"
```

---

## Task 21: 全屏修复（两处 `max-width`）

> **Review Focus 之外但 spec 验收 1 硬要求**：`public/admin/styles.css` 有**两处**
> `max-width:1100px`（`:81` 基础规则、`:228` 桌面媒体查询内）。
> **后者在 ≥900px 时覆盖前者** —— 只改 `:81` 在 1920px 下毫无效果。

**Files:**
- Modify: `public/admin/styles.css:81/228`

- [ ] **Step 1: 两处同时去掉硬上限**

```css
/* :81 */
.view{padding:12px 12px 24px;margin:0 auto}
/* :228（@media (min-width:900px) 内） */
.view{padding:20px 22px 48px;margin:0}
```

- [ ] **Step 2: 浏览器实测内容区利用率**

在 1920×1080 下打开 `/admin/`，断言
`document.querySelector('.view').getBoundingClientRect().width >= 1500`
（1920 − 侧栏 210 − 内边距）。

- [ ] **Step 3: 提交**

```bash
git add public/admin/styles.css
git commit -m "fix(admin): 去掉两处 max-width:1100px，修复 1920px 下只用半屏"
```

---

## Task 22: 房源列表数据源改为业主页维度

**Files:**
- Modify: `src/http/routes/admin-properties.ts`、`src/db/repositories/property-repo.ts`

- [ ] **Step 1: 写失败测试**

```ts
test('后台按业主页列出房源，无 N+1 查询', async () => {
  const res = await t.app.inject({ method: 'GET', url: `/api/admin/landlord-pages/${pageId}/properties`, headers: { cookie: t.cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).items.length, 3);
});
```

- [ ] **Step 2: 实现（保留既有的一次性 JOIN，不要退化成逐条查询）**

- [ ] **Step 3: 运行 + 提交**

```bash
git add src/http/routes/admin-properties.ts src/db/repositories/property-repo.ts tests/
git commit -m "feat(admin): 房源列表按业主页维度查询"
```

---

# 阶段五：收口与验证

## Task 23: 测试迁移（改写而非删除）

**Files:**
- Modify: `tests/integration/public-page.test.ts`、`tests/services/reminder-service.test.ts:45`、
  `tests/services/hosting-service.test.ts:105`、`tests/integration/security.test.ts:39/63`

- [ ] **Step 1: 逐条处理 `/p/` 与 `listing_pages` 引用**

```bash
grep -rn "listing_pages\|'/p/\|\"/p/\|propertyId" tests/ | grep -v node_modules
```

**要求**：每一条都**改写为新语义**，不得直接删除用例。
`reminder-service.test.ts:45` 的 `day7.propertyId` 改为 `day7.landlordPageId`。

- [ ] **Step 2: 全量回归**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。**用例总数不得少于改写前**（删除用例需要逐条说明理由）

- [ ] **Step 3: 提交**

```bash
git add tests/
git commit -m "test: 既有用例迁移到业主页语义，逐条改写而非删除"
```

---

## Task 24: 冒烟脚本更新

> `scripts/smoke.ts` 有 5 处 `/p/`（`:200/210/225/238/402`），
> 且 **`inject` 默认不跟随 301** —— 只靠兼容跳转会让「未发布 404 / 发布后 200」这几条直接失败。

**Files:**
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: 路径改为新地址，并补一条 301 断言**

```ts
// 改为 /<slug>；另加：
await check('旧链接 /p/<slug> 返回 301', async () => {
  const res = await app.inject({ method: 'GET', url: `/p/${slug}` });
  return res.statusCode === 301 && res.headers['location'] === `/${slug}`;
});
```

- [ ] **Step 2: 运行**

Run: `pnpm smoke`
Expected: 全部通过（项数应 ≥ 原 73 项 + 新增）

- [ ] **Step 3: 提交**

```bash
git add scripts/smoke.ts
git commit -m "test(smoke): 端到端路径切换到业主页地址并补 301 断言"
```

---

## Task 25: 双视口真实浏览器验证

**Files:**
- Modify: `docs/evidence/`（新增截图）、`README.md`、`docs/reports/`

- [ ] **Step 1: 手机视口（390×844）逐项走查**

业主列表 → 详情 → 点开联系方式图标 → 取回完整值 → 分享 → 地图展开。
**必须截图留档**，并确认首屏 HTML 中不含完整号码（用开发者工具查源码，不是看屏幕）。

- [ ] **Step 2: 桌面视口（1920×1080）逐项走查**

后台业主表格 → 业主页详情 → 确认内容区撑满、表格不换行。

- [ ] **Step 3: 更新文档**

README 的数据模型、路由、配置三节；`docs/reports/` 补本轮验收报告。
**已知限制**补一条：「导出的静态包包含完整联系方式，请勿当作公开页面分发」。

- [ ] **Step 4: 提交**

```bash
git add docs/ README.md
git commit -m "docs: 计划 A 验收报告与截图，更新 README"
```

---

## Task 26: 最终回归与迁移演练

- [ ] **Step 1: 从零跑一遍完整流程**

```bash
rm -rf var/db var/uploads
pnpm migrate && pnpm seed && pnpm smoke
```

- [ ] **Step 2: 在「迁移前」的库副本上演练**

```bash
cp var/db/app.sqlite.before-v3 var/db/app.sqlite
pnpm migrate
pnpm smoke
```

Expected: 数据零丢失、`pnpm smoke` 全绿、迁移后备份校验 `ok=true`

- [ ] **Step 3: 三项硬性检查**

```bash
node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('var/db/app.sqlite');
const q = (s) => db.prepare(s).get().n;
console.log('房源无归属:', q('SELECT COUNT(*) n FROM properties WHERE landlord_page_id IS NULL'));
console.log('业主页无归属:', q('SELECT COUNT(*) n FROM landlord_pages WHERE user_id IS NULL'));
console.log('照片总数:', q(\"SELECT COUNT(*) n FROM media WHERE kind='photo'\"));
console.log('外键违规:', db.prepare('PRAGMA foreign_key_check').all().length);
db.close();
"
```

Expected: 前两项为 0、照片数正确、外键违规 0

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: 计划 A 最终回归与迁移演练"
```
