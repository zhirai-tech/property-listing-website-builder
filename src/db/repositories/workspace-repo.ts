/**
 * 工作区与用户仓储（方案第四章第 6 条）。
 *
 * 首次启动时自动创建一个工作区、一个所有者用户与默认联系方式，
 * 保证系统开箱即用，且不依赖外部身份服务。
 */

import type { Database } from '../database.ts';
import { asText, nowIso } from '../database.ts';
import { buildUpdate } from '../sql.ts';
import { newId } from '../../util/ids.ts';
import type { AreaUnit, User, UserRole, Workspace } from '../../domain/types.ts';

const SELECT_COLUMNS = `
  id, name, owner_user_id, default_locale, default_currency, default_area_unit,
  default_timezone, hosting_provider, created_at, updated_at
`;

export function mapWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: asText(row['id']),
    name: asText(row['name']),
    ownerUserId: asText(row['owner_user_id']),
    defaultLocale: asText(row['default_locale']),
    defaultCurrency: asText(row['default_currency']),
    defaultAreaUnit: asText(row['default_area_unit']) as AreaUnit,
    defaultTimezone: asText(row['default_timezone']),
    hostingProvider: asText(row['hosting_provider']),
    createdAt: asText(row['created_at']),
    updatedAt: asText(row['updated_at']),
  };
}

export function mapUser(row: Record<string, unknown>): User {
  return {
    id: asText(row['id']),
    workspaceId: asText(row['workspace_id']),
    email: asText(row['email']),
    displayName: asText(row['display_name']),
    role: asText(row['role']) as UserRole,
    createdAt: asText(row['created_at']),
    updatedAt: asText(row['updated_at']),
  };
}

export function getWorkspace(db: Database, id: string): Workspace | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM workspaces WHERE id = ?`).get(id);
  return row ? mapWorkspace(row as Record<string, unknown>) : null;
}

/** 取第一个工作区（单工作区部署下的默认选择） */
export function getFirstWorkspace(db: Database): Workspace | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM workspaces ORDER BY created_at ASC LIMIT 1`)
    .get();
  return row ? mapWorkspace(row as Record<string, unknown>) : null;
}

const WORKSPACE_COLUMNS: Record<string, string> = {
  name: 'name',
  defaultLocale: 'default_locale',
  defaultCurrency: 'default_currency',
  defaultAreaUnit: 'default_area_unit',
  defaultTimezone: 'default_timezone',
  hostingProvider: 'hosting_provider',
};

export function updateWorkspace(
  db: Database,
  id: string,
  patch: Record<string, unknown>,
): Workspace | null {
  const { sql, values } = buildUpdate('workspaces', WORKSPACE_COLUMNS, patch, 'id = ?');
  if (sql !== '') db.prepare(sql).run(...values, id);
  db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  return getWorkspace(db, id);
}

export function insertUser(
  db: Database,
  input: { workspaceId: string; email: string; displayName: string; role: UserRole },
): User {
  const id = newId('user');
  const now = nowIso();
  // 本函数建立的账号没有口令哈希 —— 它只用于 bootstrap 时创建「工作区所有者」。
  // 按迁移 v3 确立的不变式「没有 password_hash 的账号就是系统账号」，
  // 这里必须显式标记 is_system = 1。
  //
  // 【为什么不能只靠迁移里的 UPDATE】那个 UPDATE 只作用于迁移执行时已存在的行；
  // 全新安装时迁移先跑、seed 后跑，owner 是迁移之后才建的，会漏掉标记，
  // 结果它会被当成平台用户（邮箱被占用、且没有口令登不进去）。
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, display_name, role, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, input.workspaceId, input.email, input.displayName, input.role, now, now);

  return {
    id,
    workspaceId: input.workspaceId,
    email: input.email,
    displayName: input.displayName,
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };
}

export function listUsers(db: Database, workspaceId: string): User[] {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, email, display_name, role, created_at, updated_at
       FROM users WHERE workspace_id = ? ORDER BY created_at ASC`,
    )
    .all(workspaceId);
  return rows.map((row) => mapUser(row as Record<string, unknown>));
}

export interface BootstrapDefaults {
  workspaceName: string;
  defaultLocale: string;
  defaultCurrency: string;
  defaultAreaUnit: AreaUnit;
  defaultTimezone: string;
  hostingProvider: string;
  ownerEmail: string;
  ownerDisplayName: string;
}

/**
 * 幂等地保证存在一个可用工作区。
 * 供启动流程调用；重复执行不会创建第二套数据。
 */
export function ensureDefaultWorkspace(db: Database, defaults: BootstrapDefaults): Workspace {
  const existing = getFirstWorkspace(db);
  if (existing) return existing;

  const workspaceId = newId('workspace');
  const now = nowIso();

  // 顺序很重要：users.workspace_id 有外键约束，
  // 因此必须先插入工作区（owner_user_id 先用空串占位），再插入所有者用户，最后回填。
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, default_locale, default_currency,
                               default_area_unit, default_timezone, hosting_provider,
                               created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      defaults.workspaceName,
      defaults.defaultLocale,
      defaults.defaultCurrency,
      defaults.defaultAreaUnit,
      defaults.defaultTimezone,
      defaults.hostingProvider,
      now,
      now,
    );

    const owner = insertUser(db, {
      workspaceId,
      email: defaults.ownerEmail,
      displayName: defaults.ownerDisplayName,
      role: 'owner',
    });

    db.prepare('UPDATE workspaces SET owner_user_id = ?, updated_at = ? WHERE id = ?').run(
      owner.id,
      now,
      workspaceId,
    );

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 保留原始错误
    }
    throw error;
  }

  const created = getWorkspace(db, workspaceId);
  if (!created) throw new Error('工作区创建后读取失败');
  return created;
}
