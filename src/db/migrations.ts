/**
 * 数据库迁移定义。
 *
 * 方案第六章第 5 条要求：检查迁移、旧数据兼容、保存后读取、删除/归档和失败回滚。
 * 因此：
 *  - 每个迁移都在独立事务中执行，失败自动回滚，不会留下半套结构；
 *  - 迁移是追加式的，已发布的迁移不可修改（只能新增）；
 *  - schema_migrations 记录版本，重复运行是幂等的。
 */

import type { Database } from './database.ts';
import { nowIso } from './database.ts';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

/**
 * 初始结构（对应方案第四章的逻辑模型）。
 *
 * 命名约定：表名复数、列名 snake_case，时间统一存储为 UTC ISO 8601 字符串。
 */
const initialSchema = `
CREATE TABLE workspaces (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  owner_user_id      TEXT NOT NULL,
  default_locale     TEXT NOT NULL,
  default_currency   TEXT NOT NULL,
  default_area_unit  TEXT NOT NULL,
  default_timezone   TEXT NOT NULL,
  hosting_provider   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_users_workspace ON users(workspace_id);
CREATE UNIQUE INDEX idx_users_email ON users(email);

CREATE TABLE properties (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  address_line     TEXT NOT NULL DEFAULT '',
  district         TEXT NOT NULL DEFAULT '',
  city             TEXT NOT NULL DEFAULT '',
  region           TEXT NOT NULL DEFAULT '',
  country_code     TEXT NOT NULL DEFAULT '',
  postal_code      TEXT NOT NULL DEFAULT '',
  latitude         REAL,
  longitude        REAL,
  property_type    TEXT NOT NULL DEFAULT '',
  bedrooms         INTEGER,
  bathrooms        INTEGER,
  area_value       REAL,
  area_unit        TEXT NOT NULL,
  floor_note       TEXT NOT NULL DEFAULT '',
  price_amount     REAL,
  price_currency   TEXT NOT NULL,
  price_period     TEXT NOT NULL,
  deposit_amount   REAL,
  deposit_currency TEXT NOT NULL,
  extra_fees_note  TEXT NOT NULL DEFAULT '',
  available_from   TEXT,
  status           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_properties_workspace ON properties(workspace_id, status);
CREATE INDEX idx_properties_updated   ON properties(updated_at DESC);

CREATE TABLE property_translations (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  locale       TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_translations_property_locale ON property_translations(property_id, locale);

CREATE TABLE contacts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  property_id   TEXT REFERENCES properties(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL DEFAULT '',
  channel_kind  TEXT NOT NULL,
  channel_value TEXT NOT NULL,
  is_public     INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_contacts_property  ON contacts(property_id, sort_order);
CREATE INDEX idx_contacts_workspace ON contacts(workspace_id, property_id);

CREATE TABLE media (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  storage_key   TEXT NOT NULL DEFAULT '',
  external_url  TEXT,
  original_name TEXT NOT NULL DEFAULT '',
  mime_type     TEXT NOT NULL DEFAULT '',
  byte_size     INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_cover      INTEGER NOT NULL DEFAULT 0,
  source_note   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_media_property ON media(property_id, sort_order);

CREATE TABLE listing_pages (
  id                 TEXT PRIMARY KEY,
  property_id        TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL,
  locale             TEXT NOT NULL,
  template_id        TEXT NOT NULL,
  status             TEXT NOT NULL,
  published_at       TEXT,
  withdrawn_at       TEXT,
  custom_domain      TEXT,
  domain_verify_token TEXT,
  domain_verified_at TEXT,
  view_count         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_listing_pages_slug     ON listing_pages(slug);
CREATE INDEX        idx_listing_pages_property ON listing_pages(property_id);
CREATE INDEX        idx_listing_pages_domain   ON listing_pages(custom_domain);

CREATE TABLE reminders (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  listing_page_id TEXT REFERENCES listing_pages(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  due_at          TEXT NOT NULL,
  timezone        TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT,
  completed_at    TEXT,
  idempotency_key TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_reminders_idempotency ON reminders(idempotency_key);
CREATE INDEX        idx_reminders_due         ON reminders(status, due_at);

CREATE TABLE external_service_configs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  adapter_kind    TEXT NOT NULL,
  provider        TEXT NOT NULL,
  config_json     TEXT NOT NULL DEFAULT '{}',
  secret_refs_json TEXT NOT NULL DEFAULT '[]',
  enabled         INTEGER NOT NULL DEFAULT 1,
  free_tier_note  TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_external_service_kind ON external_service_configs(workspace_id, adapter_kind);

CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_at     ON audit_logs(at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(initialSchema);
    },
  },
  {
    version: 2,
    name: 'property_availability_status',
    up: (db) => {
      // 房东声明的可租状态；「未确认」由更新时间自动推导，不落库。
      // 旧数据默认 available，语义与旧版本一致（原来只靠 status 字段）。
      db.exec(
        "ALTER TABLE properties ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'available'",
      );
    },
  },
  {
    version: 3,
    name: 'platform_foundation',
    up: (db) => {
      // AI 单网页生成平台的基础结构。
      //
      // 【设计原则：纯追加】
      // 本迁移**不重建任何表、不删除任何列、不修改任何既有数据** ——
      // 现有房源数据（properties / listing_pages / media / reminders / contacts）
      // 一行都不受影响，v3 失败时整体回滚，库仍停在 v2 可用状态。
      //
      // 之所以能纯追加：SQLite 的 ALTER TABLE ADD COLUMN 支持
      // 「可空列」与「NOT NULL + 常量默认值」两种形态，账号与套餐字段正属此类。

      // ---- 1) users 加账号与套餐字段（不动已有列与已有行） ----
      // password_hash 可空：现有那行「工作区所有者」没有口令，标记为系统账号（见下），
      // 保留它是为了让既有数据有归属，而不是造一个登不进去的幽灵账号。
      db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
      db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      db.exec("ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'");
      db.exec('ALTER TABLE users ADD COLUMN member_until TEXT');
      db.exec('ALTER TABLE users ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0');

      // 迁移前就存在的用户一律视为系统账号：它们没有口令、不应出现在用户列表里，
      // 但必须继续持有既有工作区与房源数据。
      db.exec('UPDATE users SET is_system = 1 WHERE password_hash IS NULL');

      db.exec('CREATE INDEX idx_users_status ON users(status)');

      // ---- 2) 生成项目：用户创建并编辑的源项目 ----
      db.exec(`
        CREATE TABLE projects (
          id                   TEXT PRIMARY KEY,
          user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          plugin_id            TEXT NOT NULL,
          title                TEXT NOT NULL,
          status               TEXT NOT NULL,
          spec_json            TEXT NOT NULL DEFAULT '{}',
          published_version_id TEXT,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        );
        CREATE INDEX idx_projects_user      ON projects(user_id, updated_at DESC);
        CREATE INDEX idx_projects_workspace ON projects(workspace_id);
        CREATE INDEX idx_projects_plugin    ON projects(plugin_id);
      `);

      // ---- 3) 项目版本：每次保存/发布产生一个不可变快照 ----
      // 「草稿」与「发布版本」分开存：改草稿不能破坏正在公开访问的版本。
      db.exec(`
        CREATE TABLE project_versions (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version_no INTEGER NOT NULL,
          kind       TEXT NOT NULL,
          spec_json  TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_project_versions_no ON project_versions(project_id, version_no);
        CREATE INDEX idx_project_versions_kind ON project_versions(project_id, kind, version_no DESC);
      `);

      // ---- 4) AI 用量台账（服务端可信记录 + 幂等） ----
      // task_id 唯一索引是「同一任务不重复扣费」的最终防线：
      // 重复提交、并发重试、刷新页面重放，都会撞上这个唯一约束。
      db.exec(`
        CREATE TABLE ai_usage (
          id             TEXT PRIMARY KEY,
          user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
          task_id        TEXT NOT NULL,
          kind           TEXT NOT NULL,
          provider       TEXT NOT NULL,
          model          TEXT NOT NULL,
          status         TEXT NOT NULL,
          input_tokens   INTEGER NOT NULL DEFAULT 0,
          output_tokens  INTEGER NOT NULL DEFAULT 0,
          total_tokens   INTEGER NOT NULL DEFAULT 0,
          cost_micros    INTEGER NOT NULL DEFAULT 0,
          failure_reason TEXT,
          created_at     TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_ai_usage_task ON ai_usage(task_id);
        CREATE INDEX idx_ai_usage_user ON ai_usage(user_id, created_at DESC);
        CREATE INDEX idx_ai_usage_project ON ai_usage(project_id);
      `);

      // ---- 5) 插件安装记录 ----
      db.exec(`
        CREATE TABLE plugin_installations (
          id            TEXT PRIMARY KEY,
          plugin_id     TEXT NOT NULL,
          version       TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          enabled       INTEGER NOT NULL DEFAULT 1,
          is_builtin    INTEGER NOT NULL DEFAULT 0,
          installed_at  TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_plugin_installations_plugin ON plugin_installations(plugin_id);
      `);

      // ---- 6) 平台级配置（管理员可调，避免限额硬编码） ----
      db.exec(`
        CREATE TABLE platform_settings (
          key        TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 4,
    name: 'session_revocation',
    up: (db) => {
      // 会话版本号：登出时把它 +1，已签发的令牌立刻失效。
      //
      // 【为什么需要】原先的登出只是下发一个清 Cookie 的指令，
      // 令牌本身在有效期内一直可用（审计报告里记为既有限制 F5）。
      // 后台会话只有 12 小时，尚可接受；但平台用户会话是 7 天，
      // 把「被截获的令牌 7 天内一直有效」留给终端用户是不合适的。
      //
      // 【为什么用版本号而不是会话表】
      // 会话表要存每一张令牌、要清理过期行、要多一次写；
      // 版本号只占一列，登出时一次 UPDATE 即可让该用户的
      // **全部**已签发令牌失效，语义更强且没有额外维护成本。
      //
      // 纯追加：默认 1，不动任何既有行、不动任何既有列。
      db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1');
    },
  },
  {
    version: 5,
    name: 'project_public_slug',
    up: (db) => {
      // 平台托管：项目发布后需要一个公开可访问的短链。
      //
      // 【为什么不用 listing_pages】
      // 那张表是**房源**的展示页（property_id NOT NULL，一对一指一套房源）。
      // 平台项目里还有「自定义单页」这种与房源无关的类型，
      // 硬塞进去要么破坏它的约束，要么为每种插件各建一张表 —— 两条都不该走。
      //
      // 【纯追加】可空列 + 部分索引：未发布的项目 slug 为 NULL，互不冲突。
      db.exec('ALTER TABLE projects ADD COLUMN public_slug TEXT');
      // 只对已分配的 slug 建唯一索引（NULL 不参与唯一性）
      db.exec(
        'CREATE UNIQUE INDEX idx_projects_public_slug ON projects(public_slug) WHERE public_slug IS NOT NULL',
      );
      // 托管状态与解绑时间：托管到期后要能判断「曾经发布过但现在停了」
      db.exec('ALTER TABLE projects ADD COLUMN published_at TEXT');
      db.exec('ALTER TABLE projects ADD COLUMN unpublished_at TEXT');
    },
  },
  {
    version: 6,
    name: 'project_version_snapshot',
    up: (db) => {
      // 发布快照：发布成功时把「当时的可渲染数据」冻结下来，
      // 公开页面从快照渲染，而不是读取正在编辑的草稿或当前房源记录。
      //
      // 【为什么需要】房源类项目的公开页原先直接读 properties，
      // 而 saveDraft 会把 spec 同步进 properties —— 于是用户一改草稿，
      // 已经发布出去的页面就当场变了，「发布了什么」无法保证。
      //
      // 【纯追加】可空列：老版本没有快照，读取时回退到原有逻辑，
      // 因此既有发布页不会因为这次迁移而打不开。
      db.exec('ALTER TABLE project_versions ADD COLUMN snapshot_json TEXT');
    },
  },
  {
    version: 7,
    name: 'plugin_installation_scope',
    up: (db) => {
      // 插件安装状态**按工作区**隔离。
      //
      // 【为什么必须改】原表的唯一索引是 `UNIQUE(plugin_id)` —— 平台级。
      // 那意味着「停用某个插件」会影响**所有用户**：一个会员点了停用，
      // 别人的项目就建不了、公开页也受影响。多租户平台里这是不能接受的。
      //
      // 【为什么代价极低】该表自建立以来**零读写代码**（是张死表），
      // 实际行数为 0，所以这次调整不涉及任何存量数据搬迁。
      //
      // 【为什么 workspace_id 可空】保持向后兼容：NULL 表示「平台级」记录。
      // 现有内置插件都会按工作区写入，不会产生 NULL 行。
      db.exec('ALTER TABLE plugin_installations ADD COLUMN workspace_id TEXT');
      // 旧的平台级唯一索引必须去掉，否则同一插件无法在不同工作区各存一行
      db.exec('DROP INDEX IF EXISTS idx_plugin_installations_plugin');
      // 新索引按 (工作区, 插件) 唯一；NULL 工作区仍按平台级去重
      db.exec(
        `CREATE UNIQUE INDEX idx_plugin_installations_scope
           ON plugin_installations(IFNULL(workspace_id, ''), plugin_id)`,
      );
      db.exec(
        'CREATE INDEX idx_plugin_installations_workspace ON plugin_installations(workspace_id)',
      );
    },
  },
];

/** 确保迁移记录表存在 */
function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

export function appliedVersions(db: Database): number[] {
  ensureMigrationTable(db);
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  return rows.map((row) => Number((row as { version: unknown }).version));
}

export interface MigrationResult {
  applied: { version: number; name: string }[];
  skipped: number[];
}

/**
 * 执行全部未应用的迁移。
 * 每个迁移单独事务：任一失败都会回滚该迁移，已成功的保持不变。
 */
export function runMigrations(db: Database): MigrationResult {
  ensureMigrationTable(db);
  const done = new Set(appliedVersions(db));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
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
