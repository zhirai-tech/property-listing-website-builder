/**
 * 插件生命周期：安装 / 启用 / 停用 / 更新 / 卸载。
 *
 * 【作用域是「工作区」而不是「平台」】
 * 原表的唯一索引是 `UNIQUE(plugin_id)`（平台级）。那意味着一个人停用插件，
 * **所有用户**都受影响 —— 多租户平台里不能这样做。迁移 v7 把作用域改成
 * `(workspace_id, plugin_id)`。该表此前零读写、行数为 0，调整不涉存量数据。
 *
 * 【内置插件不能被真正卸载】
 * 内置插件的实现**就在代码里**，不是从磁盘加载的包。所谓「卸载」只能有两种含义：
 *   ① 从这个工作区的可用列表里移除（可以做到，且**不动任何用户数据**）；
 *   ② 把代码删掉（做不到，也不该做）。
 * 本模块只做 ①，并把 ② 说清楚，而不是假装卸载成功。
 *
 * 【绝不执行来路不明的服务器代码】
 * `inspectUploadedPackage()` 恒返回 `executable: false`。
 * 因此上传的包**可以登记、可以查看、但不能启用** —— 启用一个无法执行的插件
 * 只会让用户以为它生效了。这条限制在这里被显式执行，而不是靠约定。
 *
 * 【卸载不动业务数据】
 * 卸载只删 `plugin_installations` 里那一行。项目、发布版本、公开页面、
 * 房源、照片、提醒、联系方式全都**原样保留** —— 有测试专门守着。
 */

import type { Database } from '../../db/database.ts';
import { randomUUID } from 'node:crypto';
import { getBuiltinPlugin, listBuiltinPlugins } from './registry.ts';
import type { PluginManifest } from './types.ts';

export interface InstallationView {
  pluginId: string;
  name: string;
  version: string;
  apiVersion: number;
  enabled: boolean;
  isBuiltin: boolean;
  /** 平台是否真的能执行它 —— 上传的包恒为 false */
  executable: boolean;
  installedAt: string;
  updatedAt: string;
  /** 该插件声明的依赖；缺失时列出，便于界面提示「还差什么」 */
  dependencies: string[];
  missingDependencies: string[];
}

export type LifecycleResult =
  | { ok: true; installation: InstallationView }
  | { ok: false; code: string; message: string };

interface RawRow {
  id: string;
  plugin_id: string;
  version: string;
  enabled: number;
  is_builtin: number;
  installed_at: string;
  updated_at: string;
}

/**
 * 把内置插件补齐到该工作区。
 *
 * 内置插件随代码发布，用户「天然拥有」它们，所以不需要先安装才能用。
 * 这里做的是**对账**：确保每个内置插件在该工作区都有一行记录，
 * 这样「启用/停用」才有地方落。已存在的行不动（用户的选择优先）。
 */
export function reconcileBuiltins(db: Database, workspaceId: string, now: string): void {
  // 【关键】只在该工作区**从未初始化**时对账。
  //
  // 一开始这里是无条件补齐，结果把「卸载」彻底架空了：
  // 卸载删掉那一行，下一次任何调用又把它插回来 —— 用户会发现插件自己复活了。
  // 对账的语义应该是「第一次给这个工作区建立默认状态」，而不是「每次都强行恢复默认」。
  // 一旦工作区有了记录，**用户的选择就是权威**。
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM plugin_installations WHERE IFNULL(workspace_id, '') = ?")
    .get(workspaceId) as { n: number } | undefined;
  if (Number(existing?.n ?? 0) > 0) return;

  const insert = db.prepare(
    `INSERT INTO plugin_installations
       (id, plugin_id, version, manifest_json, enabled, is_builtin, installed_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)
     ON CONFLICT(IFNULL(workspace_id, ''), plugin_id) DO NOTHING`,
  );
  for (const p of listBuiltinPlugins()) {
    insert.run(
      `pli_${randomUUID()}`, p.manifest.id, p.manifest.version,
      JSON.stringify(p.manifest), now, now, workspaceId,
    );
  }
}

function dependenciesOf(pluginId: string): string[] {
  const manifest = getBuiltinPlugin(pluginId);
  // 清单里目前没有 dependencies 字段（内置插件之间没有依赖）。
  // 这里如实返回空数组，而不是编造依赖关系。
  return manifest ? [] : [];
}

function toView(db: Database, workspaceId: string, row: RawRow): InstallationView {
  const manifest = getBuiltinPlugin(row.plugin_id);
  const deps = dependenciesOf(row.plugin_id);
  const missing = deps.filter((d) => !isInstalled(db, workspaceId, d));
  const builtin = listBuiltinPlugins().find((p) => p.manifest.id === row.plugin_id);
  return {
    pluginId: row.plugin_id,
    name: manifest?.name ?? row.plugin_id,
    version: row.version,
    apiVersion: manifest?.apiVersion ?? 0,
    enabled: row.enabled === 1,
    isBuiltin: row.is_builtin === 1,
    // 只有内置插件是可执行的；上传的包恒为 false（inspectUploadedPackage 的结论）
    executable: Boolean(builtin),
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    dependencies: deps,
    missingDependencies: missing,
  };
}

function findRow(db: Database, workspaceId: string, pluginId: string): RawRow | undefined {
  return db
    .prepare('SELECT * FROM plugin_installations WHERE IFNULL(workspace_id, \'\') = ? AND plugin_id = ?')
    .get(workspaceId, pluginId) as RawRow | undefined;
}

/** 该工作区里这个插件是否已安装且启用 */
export function isPluginEnabled(db: Database, workspaceId: string, pluginId: string): boolean {
  const row = findRow(db, workspaceId, pluginId);
  return row !== undefined && row.enabled === 1;
}

function isInstalled(db: Database, workspaceId: string, pluginId: string): boolean {
  return findRow(db, workspaceId, pluginId) !== undefined;
}

/** 列出该工作区的插件安装状态（会先对账内置插件） */
export function listInstallations(db: Database, workspaceId: string, now: string): InstallationView[] {
  reconcileBuiltins(db, workspaceId, now);
  const rows = db
    .prepare('SELECT * FROM plugin_installations WHERE IFNULL(workspace_id, \'\') = ? ORDER BY plugin_id')
    .all(workspaceId) as unknown as RawRow[];
  return rows.map((r) => toView(db, workspaceId, r));
}

/** 取单个插件的安装状态；没有记录返回 null */
export function getInstallation(db: Database, workspaceId: string, pluginId: string): InstallationView | null {
  const row = findRow(db, workspaceId, pluginId);
  return row ? toView(db, workspaceId, row) : null;
}

/**
 * 安装插件。
 *
 * 内置插件：对账即可（用户天然拥有），返回当前状态。
 * 上传的包：**拒绝** —— `inspectUploadedPackage` 判定它不可执行，
 * 安装一个执行不了的插件只会误导用户。
 */
export function installPlugin(
  db: Database, workspaceId: string, pluginId: string, now: string,
): LifecycleResult {
  reconcileBuiltins(db, workspaceId, now);

  const builtin = listBuiltinPlugins().find((p) => p.manifest.id === pluginId);
  if (!builtin) {
    return {
      ok: false,
      code: 'unsupported',
      message: '平台上没有这个插件。上传的插件包目前只能查看清单，无法安装执行。',
    };
  }

  const existing = findRow(db, workspaceId, pluginId);
  if (existing) {
    // 重复安装不报错，但要如实说明「已经装过了」
    return { ok: true, installation: toView(db, workspaceId, existing) };
  }

  db.prepare(
    `INSERT INTO plugin_installations
       (id, plugin_id, version, manifest_json, enabled, is_builtin, installed_at, updated_at, workspace_id)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`,
  ).run(
    `pli_${randomUUID()}`, pluginId, builtin.manifest.version,
    JSON.stringify(builtin.manifest), now, now, workspaceId,
  );
  const row = findRow(db, workspaceId, pluginId) as RawRow;
  return { ok: true, installation: toView(db, workspaceId, row) };
}

/** 启用 / 停用 */
export function setPluginEnabled(
  db: Database, workspaceId: string, pluginId: string, enabled: boolean, now: string,
): LifecycleResult {
  reconcileBuiltins(db, workspaceId, now);
  const row = findRow(db, workspaceId, pluginId);
  if (!row) return { ok: false, code: 'not_found', message: '这个插件还没有安装' };

  db.prepare(
    'UPDATE plugin_installations SET enabled = ?, updated_at = ? WHERE IFNULL(workspace_id, \'\') = ? AND plugin_id = ?',
  ).run(enabled ? 1 : 0, now, workspaceId, pluginId);

  return { ok: true, installation: toView(db, workspaceId, findRow(db, workspaceId, pluginId) as RawRow) };
}

/**
 * 更新插件。
 *
 * 内置插件的版本**来自代码**，不是磁盘上的包 —— 平台升级时它自然就是新的。
 * 所以这里没有「更新」可做；如实说明，而不是返回一个假的成功。
 */
export function updatePlugin(db: Database, workspaceId: string, pluginId: string, now: string): LifecycleResult {
  reconcileBuiltins(db, workspaceId, now);
  const row = findRow(db, workspaceId, pluginId);
  if (!row) return { ok: false, code: 'not_found', message: '这个插件还没有安装' };
  return {
    ok: false,
    code: 'not_supported',
    message: '内置插件随平台代码发布，版本由平台升级决定，无法单独更新。',
  };
}

/**
 * 卸载插件。
 *
 * **只删安装记录，不动任何业务数据。**
 * 项目、发布版本、公开页面、房源、照片、提醒、联系方式全部保留 ——
 * 用户卸载插件不等于同意丢掉自己的内容。
 */
export function uninstallPlugin(db: Database, workspaceId: string, pluginId: string, now: string): LifecycleResult {
  reconcileBuiltins(db, workspaceId, now);
  const row = findRow(db, workspaceId, pluginId);
  if (!row) return { ok: false, code: 'not_found', message: '这个插件还没有安装' };

  const view = toView(db, workspaceId, row);
  db.prepare('DELETE FROM plugin_installations WHERE IFNULL(workspace_id, \'\') = ? AND plugin_id = ?')
    .run(workspaceId, pluginId);

  // now 目前不参与（删除不需要时间戳），保留参数是为了让调用方统一传时钟
  void now;
  return { ok: true, installation: { ...view, enabled: false } };
}

/** 供建项目时校验：该插件在此工作区是否可用 */
export function pluginAvailability(
  db: Database, workspaceId: string, pluginId: string, now: string,
): { ok: true } | { ok: false; code: string; message: string } {
  reconcileBuiltins(db, workspaceId, now);
  const row = findRow(db, workspaceId, pluginId);
  // 对账之后仍然没有记录 —— 说明用户**主动卸载过**（不是「从未初始化」）。
  // 早期版本这里返回 ok（向后兼容），但那让卸载变成摆设。
  if (!row) {
    return {
      ok: false,
      code: 'plugin_disabled',
      message: '这个插件在当前工作区没有安装，安装后即可继续创建项目。',
    };
  }
  if (row.enabled !== 1) {
    return { ok: false, code: 'plugin_disabled', message: '这个插件在当前工作区已停用，启用后即可继续创建项目。' };
  }
  return { ok: true };
}

export type { PluginManifest };