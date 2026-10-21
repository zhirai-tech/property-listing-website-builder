/**
 * 平台项目服务。
 *
 * 【三件事必须分清】（用户明确要求，不能混为一谈）
 *   生成项目   projects              —— 用户创建并编辑的源
 *   发布版本   project_versions(kind='published') —— 对外实际展示的版本
 *   导出文件   由 export-service 产出 —— 用户下载到本地的文件
 *
 * 草稿存在 `kind='draft'` 的版本里，**发布版本不受草稿影响** ——
 * 这是用户要求的「草稿修改不能直接破坏当前正在公开访问的发布版本」。
 *
 * 【所有权】
 * 本文件的每个读取函数都要求传 `userId` 并**在 SQL 里带上 user_id 条件**，
 * 而不是「先取出来再在 JS 里比对」—— 前者根本取不到别人的数据，
 * 后者一旦忘了写 if 就是越权。这是防 IDOR 的结构性做法。
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { AppContext } from '../app-context.ts';
import { checkQuota } from './quota.ts';
import { claimTask, settleTask } from './ai/usage.ts';
import type { AiProvider } from './ai/types.ts';
import { PLATFORM_LIMITS } from './config.ts';
import { getBuiltinPlugin, specSyncerFor } from './plugins/registry.ts';
import { PAGE_CONSTRAINTS, checkSpec } from './page-generation.ts';
import { describePageIssues } from '../domain/page-safety.ts';
import { insertProperty, updateProperty } from '../db/repositories/property-repo.ts';
import { emptyPropertyForm } from '../domain/property.ts';
import { allocateSlug } from '../services/publish-service.ts';
import { captureListingSnapshot, serializeSnapshot } from './publish-snapshot.ts';
import { publishCheckFor } from './plugins/registry.ts';
import { AiProviderError } from './ai/openai-provider.ts';
import { pluginAvailability } from './plugins/lifecycle.ts';
import { membershipForUser, resolveMembership } from './membership.ts';
import { asciiSlugSeed, slugify } from '../util/slug.ts';

export interface ProjectRow {
  id: string;
  userId: string;
  workspaceId: string;
  pluginId: string;
  title: string;
  status: string;
  spec: Record<string, unknown>;
  publishedVersionId: string | null;
  /** 公开短链；未发布时为 null */
  publicSlug: string | null;
  /** 首次发布时间；从未发布为 null */
  publishedAt: string | null;
  /** 最近一次停止托管的时间 */
  unpublishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectVersionRow {
  id: string;
  projectId: string;
  versionNo: number;
  kind: string;
  spec: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  /**
   * 该版本是否带发布快照。
   *
   * 房源类项目的公开页渲染的是发布快照而不是 spec，所以「能不能真正回滚到这一版」
   * 取决于有没有快照 —— 把这件事告诉调用方，比让它去猜要诚实。
   */
  hasSnapshot: boolean;
}

function parseSpec(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapProject(raw: Record<string, unknown>): ProjectRow {
  return {
    id: String(raw['id']),
    userId: String(raw['user_id']),
    workspaceId: String(raw['workspace_id']),
    pluginId: String(raw['plugin_id']),
    title: String(raw['title']),
    status: String(raw['status']),
    spec: parseSpec(raw['spec_json']),
    publishedVersionId: raw['published_version_id'] === null ? null : String(raw['published_version_id'] ?? ''),
    publicSlug: raw['public_slug'] === null || raw['public_slug'] === undefined ? null : String(raw['public_slug']),
    publishedAt: raw['published_at'] === null || raw['published_at'] === undefined ? null : String(raw['published_at']),
    unpublishedAt:
      raw['unpublished_at'] === null || raw['unpublished_at'] === undefined ? null : String(raw['unpublished_at']),
    createdAt: String(raw['created_at']),
    updatedAt: String(raw['updated_at']),
  };
}

function mapVersion(raw: Record<string, unknown>): ProjectVersionRow {
  return {
    id: String(raw['id']),
    projectId: String(raw['project_id']),
    versionNo: Number(raw['version_no']),
    kind: String(raw['kind']),
    spec: parseSpec(raw['spec_json']),
    createdBy: String(raw['created_by']),
    createdAt: String(raw['created_at']),
    hasSnapshot: typeof raw['snapshot_json'] === 'string' && raw['snapshot_json'] !== '',
  };
}

/**
 * 按 id 取项目，**并且要求它属于该用户**。
 *
 * 注意 SQL 里直接带 `user_id = ?`：
 * 别人的项目在这里**根本查不出来**，返回 null，而不是取出来再判断。
 */
export function getOwnedProject(db: Database, userId: string, projectId: string): ProjectRow | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
  return row ? mapProject(row as Record<string, unknown>) : null;
}

/**
 * 列出用户的项目。
 *
 * @param scope `active`（默认）只列未归档的；`archived` 只列回收站里的。
 *
 * 未归档列表**必须**保持排除 archived —— 额度就是按它算的
 * （见 quota.ts 的 countProjects）。恢复一个项目会重新占用额度，
 * 因此恢复时也要过一遍额度检查，否则回收站就成了绕开上限的后门。
 */
export function listProjectsOfUser(
  db: Database,
  userId: string,
  scope: 'active' | 'archived' = 'active',
): ProjectRow[] {
  const condition = scope === 'archived' ? "status = 'archived'" : "status <> 'archived'";
  const rows = db
    .prepare(`SELECT * FROM projects WHERE user_id = ? AND ${condition} ORDER BY updated_at DESC`)
    .all(userId);
  return rows.map((r) => mapProject(r as Record<string, unknown>));
}

export function listVersionsOfProject(db: Database, projectId: string, limit = 30): ProjectVersionRow[] {
  const rows = db
    .prepare('SELECT * FROM project_versions WHERE project_id = ? ORDER BY version_no DESC LIMIT ?')
    .all(projectId, Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => mapVersion(r as Record<string, unknown>));
}

/** 追加一个版本快照，返回新版本 */
function appendVersion(
  db: Database,
  projectId: string,
  kind: 'draft' | 'published',
  spec: Record<string, unknown>,
  createdBy: 'user' | 'ai',
  at: string,
  /**
   * 发布快照（仅发布版本需要）。
   *
   * 草稿版本传 undefined —— 草稿本来就应该跟着编辑走，
   * 需要冻结的只有「已经对外公开的那一份」。
   */
  snapshotJson?: string,
): ProjectVersionRow {
  const row = db
    .prepare('SELECT COALESCE(MAX(version_no), 0) AS n FROM project_versions WHERE project_id = ?')
    .get(projectId) as { n: number } | undefined;
  const versionNo = Number(row?.n ?? 0) + 1;
  const id = `ver_${randomUUID()}`;
  db.prepare(
    `INSERT INTO project_versions (id, project_id, version_no, kind, spec_json, created_by, created_at, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, versionNo, kind, JSON.stringify(spec), createdBy, at, snapshotJson ?? null);
  return { id, projectId, versionNo, kind, spec, createdBy, createdAt: at, hasSnapshot: typeof snapshotJson === 'string' && snapshotJson !== '' };
}

/** 把 spec 限制在插件声明过的字段里 —— 防止用户往规格里塞任意键 */
function sanitizeSpec(pluginId: string, spec: Record<string, unknown>): Record<string, unknown> {
  const manifest = getBuiltinPlugin(pluginId);
  if (!manifest) return {};
  // 允许的键 = 插件的可编辑字段 + 结构性键。
  // 其余一律丢弃 —— 用户不能往规格里塞任意键，这是防注入的一层。
  const allowed = new Set([...manifest.fields.map((f) => f.key), ...manifest.structuralKeys]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

export type CreateProjectResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; code: string; message: string };

/** 创建项目 —— 先过服务端额度，再写库 */
export function createProject(
  ctx: AppContext,
  userId: string,
  input: { pluginId: string; title: string; spec?: Record<string, unknown> },
  // 默认时间取自应用时钟，而不是 new Date()。
  // 应用可能启用了 devTimeTravel（此时 clock 是可控的 FakeClock），
  // 而会话里的会员到期判定用的就是应用时钟 —— 两边必须是同一个「现在」，
  // 否则会出现「会话说已到期、发布流程说没到期」这种自相矛盾。
  // 生产环境没有 FakeClock，clock 就是系统时钟，与 new Date() 等价。
  now: Date = ctx.adapters.clock.now(),
): CreateProjectResult {
  const manifest = getBuiltinPlugin(input.pluginId);
  if (!manifest) {
    return { ok: false, code: 'unknown_plugin', message: `未知的网页类型：${input.pluginId}` };
  }

  const user = ctx.db.prepare('SELECT tier, member_until, workspace_id FROM users WHERE id = ?').get(userId) as
    | { tier: string; member_until: string | null; workspace_id: string }
    | undefined;
  if (!user) return { ok: false, code: 'unknown_user', message: '用户不存在' };

  // 插件必须在**该用户自己的工作区**里处于启用状态。
  // 这是服务端强制：前端即使还留着入口，直接调 API 也建不了项目。
  const availability = pluginAvailability(ctx.db, user.workspace_id, input.pluginId, now.toISOString());
  if (!availability.ok) {
    return { ok: false, code: availability.code, message: availability.message };
  }
  // 生效套餐（已考虑到期）
  const membership = resolveMembership(
    { tier: user.tier, memberUntil: user.member_until },
    now,
  );

  const decision = checkQuota(
    ctx.db,
    { userId, tier: membership.tier, action: 'create_project', membership },
    now,
  );
  if (!decision.allowed) {
    return { ok: false, code: decision.code ?? 'quota', message: decision.message ?? '额度不足' };
  }

  const title = input.title.trim().slice(0, 120) || '未命名项目';
  let spec = sanitizeSpec(input.pluginId, input.spec ?? {});
  const id = `prj_${randomUUID()}`;
  const at = nowIso();

  // 房源插件需要一个被展示的房源。平台用户在自己的工作区里还没有任何房源，
  // 因此在这里为它建一套 —— 用户随后在表单里填标题、价格、描述等字段。
  //
  // 复用既有的 `insertProperty` 仓储与 `emptyPropertyForm`，
  // 不另写一套房源创建逻辑。
  if (input.pluginId === 'listing') {
    const supplied = spec['propertyId'];
    if (typeof supplied === 'string' && supplied !== '') {
      // 【安全】调用方可以自己指定 propertyId —— 必须校验它属于该用户的工作区，
      // 否则用户 B 就能在自己的项目里引用用户 A 的房源，导出时把 A 的内容打包走。
      const owned = ctx.db
        .prepare('SELECT id FROM properties WHERE id = ? AND workspace_id = ?')
        .get(supplied, user.workspace_id);
      if (!owned) {
        return { ok: false, code: 'property_not_owned', message: '指定的房源不存在或不属于你' };
      }
    } else {
      // 平台用户在自己的工作区里还没有房源，为它建一套 ——
      // 用户随后在表单里填标题、价格、描述等字段。
      // 复用既有的 insertProperty 仓储与 emptyPropertyForm，不另写一套创建逻辑。
      const form = emptyPropertyForm({
        currency: ctx.workspace.defaultCurrency,
        areaUnit: ctx.workspace.defaultAreaUnit,
      });
      form.title = title;
      // 必须是 active：draft 状态的房源在展示页与导出里会被过滤掉
      form.status = 'active';
      const property = insertProperty(ctx.db, user.workspace_id, form);
      spec = { ...spec, propertyId: property.id };
    }
  }
  ctx.db
    .prepare(
      `INSERT INTO projects (id, user_id, workspace_id, plugin_id, title, status, spec_json,
                             published_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, ?, ?)`,
    )
    .run(id, userId, user.workspace_id, input.pluginId, title, JSON.stringify(spec), at, at);

  appendVersion(ctx.db, id, 'draft', spec, 'user', at);
  const created = getOwnedProject(ctx.db, userId, id);
  return created ? { ok: true, project: created } : { ok: false, code: 'internal', message: '创建后无法读回' };
}

/**
 * 保存草稿 —— 只写 draft 版本，**不动 published_version_id**。
 * 这就是「改草稿不破坏线上版本」的实现点。
 */
export function saveDraft(
  ctx: AppContext,
  userId: string,
  projectId: string,
  patch: { title?: string; spec?: Record<string, unknown> },
  createdBy: 'user' | 'ai' = 'user',
): ProjectRow | null {
  const project = getOwnedProject(ctx.db, userId, projectId);
  if (!project) return null;

  const spec = sanitizeSpec(project.pluginId, { ...project.spec, ...(patch.spec ?? {}) });
  const title = patch.title === undefined ? project.title : patch.title.trim().slice(0, 120) || project.title;

  // 【硬拦截】自由页面的安全校验门。
  // 放在这里而不是只在路由层：saveDraft 是写规格的唯一入口，
  // 把门设在这里，AI 产出与用户手改就都绕不过去。
  // 调用方若需要「为什么被拒」，用 checkSpec() 先判一次拿具体原因。
  if (!checkSpec(project.pluginId, spec).ok) return null;

  const specJson = JSON.stringify(spec);
  if (specJson.length > PLATFORM_LIMITS.maxSpecBytes) return null;

  const at = nowIso();
  // 【关键】保存草稿**不能**把状态从 published 改成 draft。
  // 公开访问要求 status = 'published'；如果改草稿时把它改回 draft，
  // 用户一编辑，正在对外访问的页面就**立刻下线**了 ——
  // 这正好违反用户明确要求的「草稿修改不能直接破坏当前正在公开访问的发布版本」。
  // 托管状态只由 publish / unpublish 两个动作改变。
  ctx.db
    .prepare(
      `UPDATE projects
          SET title = ?, spec_json = ?, updated_at = ?,
              status = CASE WHEN status = 'published' THEN 'published' ELSE 'draft' END
        WHERE id = ? AND user_id = ?`,
    )
    .run(title, specJson, at, projectId, userId);

  // 【关键：让「保存的」等于「导出的」】
  // 平台内容存在 spec_json，而导出与展示页渲染的是 properties 记录。
  // 不同步的话，用户改完下载拿到的还是旧内容。
  const syncer = specSyncerFor(project.pluginId);
  const propertyId = spec['propertyId'];
  if (syncer && typeof propertyId === 'string' && propertyId !== '') {
    const patch = syncer(spec);
    if (Object.keys(patch).length > 0) {
      // 带上 workspace_id 条件：即使 propertyId 被以某种方式构造成别人的，
      // 这条 UPDATE 也不会命中（纵深防御，创建时已校验过一次）。
      const owns = ctx.db
        .prepare('SELECT id FROM properties WHERE id = ? AND workspace_id = ?')
        .get(propertyId, project.workspaceId);
      if (owns) {
        updateProperty(ctx.db, propertyId, patch as Parameters<typeof updateProperty>[2]);
      }
    }
  }

  appendVersion(ctx.db, projectId, 'draft', spec, createdBy, at);
  return getOwnedProject(ctx.db, userId, projectId);
}

export type PublishResult =
  | { ok: true; project: ProjectRow; version: ProjectVersionRow }
  | { ok: false; code: string; message: string };

/**
 * 发布 —— 用户要求的「发布失败时必须保留最后一个可正常访问的版本」。
 *
 * 实现方式：先把发布版本写进 project_versions（一次性插入，失败即整体不动），
 * **最后一步**才更新 projects.published_version_id 指针。
 * 因此任何中途失败都不会让线上指针指向一个不存在的版本。
 */
export function publishProject(
  ctx: AppContext,
  userId: string,
  projectId: string,
  // 默认时间取自应用时钟，而不是 new Date()。
  // 应用可能启用了 devTimeTravel（此时 clock 是可控的 FakeClock），
  // 而会话里的会员到期判定用的就是应用时钟 —— 两边必须是同一个「现在」，
  // 否则会出现「会话说已到期、发布流程说没到期」这种自相矛盾。
  // 生产环境没有 FakeClock，clock 就是系统时钟，与 new Date() 等价。
  now: Date = ctx.adapters.clock.now(),
  /**
   * 复用一份既有的发布快照（版本回滚用）。
   *
   * 【为什么需要它】房源类项目的公开页渲染的是**发布时冻结的快照**。
   * 如果回滚到某个历史发布版本时重新采集快照，拿到的是**当前**房源数据 ——
   * 那等于「回滚了个寂寞」：页面看起来还是最新的。
   * 传入这一版自己的快照，才是真正的回滚。
   */
  options: { reuseSnapshotJson?: string } = {},
): PublishResult {
  const project = getOwnedProject(ctx.db, userId, projectId);
  if (!project) return { ok: false, code: 'not_found', message: '项目不存在' };

  // 生效套餐（已考虑到期）—— 不能直接读 users.tier，否则到期会员仍能发布
  const membership = membershipForUser(ctx.db, userId, now);
  const decision = checkQuota(
    ctx.db,
    {
      userId,
      tier: membership?.tier ?? 'free',
      action: 'hosting.publish',
      membership: membership ?? undefined,
    },
    now,
  );
  if (!decision.allowed) {
    return { ok: false, code: decision.code ?? 'quota', message: decision.message ?? '当前套餐不包含平台托管' };
  }

  // ---- 发布前内容校验 ----
  //
  // 【为什么必须在服务端做】
  // 之前发布不校验内容：一个 `spec = {}` 的空项目也能「发布成功」，
  // 接口返回 200 和一个公开地址，但那个地址打开是 404。
  // 这比直接拒绝更糟 —— 用户会把打不开的链接分享出去，而且不知道该改什么。
  //
  // 校验规则由**插件自己**声明（见 registry 的 PUBLISH_CHECKS）：
  // 自定义页面要求有一份可渲染的 HTML，房源项目要求关联到真实房源。
  // 这里不做任何 if 分支判断插件类型 —— 新增插件不会漏掉校验。
  const publishCheck = publishCheckFor(project.pluginId);
  if (!publishCheck) {
    return { ok: false, code: 'not_publishable', message: '这个插件类型暂不支持发布到平台托管。' };
  }
  const check = publishCheck(project.spec);
  if (!check.ok) {
    // 校验失败发生在写任何东西之前：不产生版本、不改状态、不动公开地址，
    // 因此已经发布过的旧版本原样保留。
    return { ok: false, code: 'not_publishable', message: check.message };
  }

  // ---- 冻结发布快照 ----
  //
  // 这一步也必须在写版本之前完成：拿不到快照就**拒绝发布**，
  // 而不是先写一个「已发布」的版本、页面却渲染不出东西
  // （那正是本次修复要消除的「接口说成功、地址打不开」）。
  //
  // 只有房源类插件需要数据快照：它的公开页渲染的是一整套房源数据
  // （房源 + 照片 + 联系方式 + 展示页设置 + 译文），
  // 而这些数据会被 `saveDraft` 的同步逻辑改动。
  // 自定义页面的内容就是它自己的 spec，发布版本已经把它冻住了。
  let snapshotJson: string | undefined;
  if (project.pluginId === 'listing') {
    if (options.reuseSnapshotJson) {
      // 回滚：直接用那一版自己的快照，才是真的回到当时的样子
      snapshotJson = options.reuseSnapshotJson;
    } else {
      const propertyId = project.spec['propertyId'];
      if (typeof propertyId !== 'string' || propertyId === '') {
        return { ok: false, code: 'not_publishable', message: '这个房源项目还没有关联房源，无法发布' };
      }
      const snapshot = captureListingSnapshot(ctx, project.workspaceId, propertyId);
      if (!snapshot) {
        return { ok: false, code: 'not_publishable', message: '找不到可发布的房源数据，无法发布' };
      }
      snapshotJson = serializeSnapshot(snapshot);
    }
  }

  const at = nowIso();
  const version = appendVersion(ctx.db, projectId, 'published', project.spec, 'user', at, snapshotJson);

  // 首次发布时分配公开短链；再次发布沿用同一个（已分享出去的链接不能变）。
  // 复用既有的 allocateSlug —— 它与房源展示页共用同一套「短链是否被占用」的判断，
  // 因此不会出现项目与房源撞 slug 的情况（查重范围包含 listing_pages）。
  // slug 风格由配置决定（默认沿用既有行为，见 config.ts 的 slugStyle 说明）
  const slug =
    project.publicSlug ??
    allocateSlug(ctx, ctx.config.slugStyle === 'ascii' ? asciiSlugSeed(project.title) : slugify(project.title) || asciiSlugSeed(project.title));
  ctx.db
    .prepare(
      "UPDATE projects SET status = 'published', published_version_id = ?, public_slug = ?, published_at = ?, unpublished_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .run(version.id, slug, at, at, projectId, userId);

  const updated = getOwnedProject(ctx.db, userId, projectId);
  return updated ? { ok: true, project: updated, version } : { ok: false, code: 'internal', message: '发布后无法读回' };
}

export type RestoreVersionMode = 'draft' | 'publish';

export type RestoreVersionResult =
  | { ok: true; mode: RestoreVersionMode; project: ProjectRow; version: ProjectVersionRow }
  | { ok: false; code: string; message: string };

/**
 * 把项目恢复到某个历史版本。
 *
 * 【两种模式是**不同的事**，必须分开】
 *
 *   `draft`（默认）—— 只把那一版的内容写回**草稿**。
 *     已经发布的线上页面**完全不受影响**：`saveDraft` 明确保留 published 状态。
 *     这是「我想看看旧版本 / 想基于旧版本继续改」的安全操作。
 *
 *   `publish` —— 把那一版重新发布出去。
 *     会经过完整的内容校验与托管额度判定；失败时**最后一个正常发布版本原样保留**。
 *     这是「我要回到当时对外的那一版」的显式操作。
 *
 * 【为什么回滚不是「回到过去」而是「追加一个新的当前状态」】
 * 版本表是**只追加**的：回滚会写入一个新版本，历史一条都不删。
 * 这样「回滚错了」本身也能再回滚回去 —— 如果回滚是把历史抹掉，
 * 用户就没有第二次机会了。
 *
 * 【为什么回滚发布版本要复用它的快照】
 * 房源类项目的公开页渲染的是发布时冻结的快照。若回滚时重新采集快照，
 * 拿到的是**当前**房源数据 —— 页面看起来还是最新的，等于没回滚。
 * 所以带上那一版自己的快照（`reuseSnapshotJson`）才是真的回到当时。
 *
 * 【所有权】
 * 项目必须属于该用户，且**版本必须属于这个项目** ——
 * 只凭一个 versionId 是拿不到别的项目、别的用户的版本的。
 */
export function restoreVersion(
  ctx: AppContext,
  userId: string,
  projectId: string,
  versionId: string,
  mode: RestoreVersionMode = 'draft',
  now: Date = ctx.adapters.clock.now(),
): RestoreVersionResult {
  const project = getOwnedProject(ctx.db, userId, projectId);
  if (!project) return { ok: false, code: 'not_found', message: '项目不存在' };

  // 版本必须属于这个项目 —— 否则拿别人的 versionId 就能读到别人的内容
  const row = ctx.db
    .prepare('SELECT * FROM project_versions WHERE id = ? AND project_id = ?')
    .get(versionId, projectId) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, code: 'not_found', message: '版本不存在' };

  const target = mapVersion(row);
  const snapshotJson = typeof row['snapshot_json'] === 'string' ? row['snapshot_json'] : undefined;

  // 先判一次，拿到具体原因 —— saveDraft 只返回 null，说不出为什么
  const check = checkSpec(project.pluginId, target.spec);
  if (!check.ok) {
    return { ok: false, code: 'unsafe_output', message: describePageIssues(check.issues) };
  }

  // 写回草稿（这一步会再追加一条 draft 版本，历史不动）
  const saved = saveDraft(ctx, userId, projectId, { spec: target.spec }, 'user');
  if (!saved) {
    return { ok: false, code: 'unsafe_output', message: '该版本的内容未通过校验，无法恢复' };
  }

  if (mode === 'draft') {
    const versions = listVersionsOfProject(ctx.db, projectId, 5);
    return { ok: true, mode, project: saved, version: versions[0] as ProjectVersionRow };
  }

  // ---- 重新发布 ----
  // 走既有的 publishProject：校验、额度、快照、短链复用全都在那里，不另写一套。
  // 它只在**成功时**才写发布版本与状态，所以失败时最后一个正常发布版本原样保留。
  const published = publishProject(ctx, userId, projectId, now, {
    reuseSnapshotJson: snapshotJson,
  });
  if (!published.ok) {
    return { ok: false, code: published.code, message: published.message };
  }
  return { ok: true, mode, project: published.project, version: published.version };
}

/**
 * 这次失败值不值得重试。
 *
 * 【判据是「有没有可能已经产生了输出」，不是「错得严不严重」】
 * 重试要花钱：若上游已经生成并计费，重试就是再花一次。所以只重试**确定没生成**的两类。
 */
function isRetriableProviderFailure(error: unknown): boolean {
  if (!(error instanceof AiProviderError)) return false;
  if (error.kind === 'network') return true;
  if (error.kind === 'http' && typeof error.status === 'number') {
    return error.status === 502 || error.status === 503 || error.status === 504;
  }
  return false;
}

/** 取当前发布版本的规格；没有发布过则返回 null */
export function getPublishedSpec(db: Database, project: ProjectRow): Record<string, unknown> | null {
  if (!project.publishedVersionId) return null;
  const row = db.prepare('SELECT * FROM project_versions WHERE id = ?').get(project.publishedVersionId);
  return row ? mapVersion(row as Record<string, unknown>).spec : null;
}

// ---------------------------------------------------------------------------
// AI 任务编排
// ---------------------------------------------------------------------------

export type AiTaskResult =
  | { ok: true; patch: Record<string, unknown>; spec: Record<string, unknown>; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; provider: string; model: string }
  | { ok: false; code: string; message: string };

/**
 * 跑一次 AI 任务（生成或修改）。
 *
 * 顺序刻意设计成这样，每一步都有理由：
 *   1. 校验项目归属 —— 别人的项目根本不该进入这个流程
 *   2. **服务端额度判定** —— 不够就直接拒，连模型都不调（不白花钱）
 *   3. **claimTask 抢占 taskId** —— 撞唯一约束即表示重复提交，立刻放弃
 *   4. 调模型 —— 用量由 Provider 返回，不采信任何请求体里的数字
 *   5. settleTask 写终态 —— 只允许从占位态改一次
 *
 * taskId 由调用方提供（HTTP 层从请求头 X-Task-Id 取，缺省时服务端生成），
 * 这样用户在浏览器上重复点、刷新重放都会撞上第 3 步的幂等键。
 */
export async function runAiTask(
  ctx: AppContext,
  provider: AiProvider,
  userId: string,
  input: {
    projectId: string;
    kind: 'generate' | 'revise';
    prompt: string;
    taskId: string;
    /** 局部修改时指定的字段子集；不传则整份可编辑字段都在范围内 */
    targetFields?: string[];
  },
  // 默认时间取自应用时钟，而不是 new Date()。
  // 应用可能启用了 devTimeTravel（此时 clock 是可控的 FakeClock），
  // 而会话里的会员到期判定用的就是应用时钟 —— 两边必须是同一个「现在」，
  // 否则会出现「会话说已到期、发布流程说没到期」这种自相矛盾。
  // 生产环境没有 FakeClock，clock 就是系统时钟，与 new Date() 等价。
  now: Date = ctx.adapters.clock.now(),
): Promise<AiTaskResult> {
  const project = getOwnedProject(ctx.db, userId, input.projectId);
  if (!project) return { ok: false, code: 'not_found', message: '项目不存在' };

  // 生效套餐（已考虑到期）
  const membership = membershipForUser(ctx.db, userId, now);
  const tier = membership?.tier ?? 'free';

  const decision = checkQuota(
    ctx.db,
    { userId, tier, action: input.kind, membership: membership ?? undefined },
    now,
  );
  if (!decision.allowed) {
    return { ok: false, code: decision.code ?? 'quota', message: decision.message ?? '额度不足' };
  }

  const manifest = getBuiltinPlugin(project.pluginId);
  const allFields = manifest?.fields ?? [];
  const fields = input.targetFields
    ? allFields.filter((f) => input.targetFields!.includes(f.key))
    : allFields;

  const claim = claimTask(ctx.db, {
    taskId: input.taskId,
    userId,
    projectId: input.projectId,
    kind: input.kind,
    provider: provider.name,
    model: provider.model,
  });
  if (!claim.claimed) {
    return { ok: false, code: 'duplicate_task', message: '该任务已提交过，未重复执行' };
  }

  try {
    // 自由页面的提示词要带上平台的硬性约束（不得有脚本等），
    // 否则模型大概率会产出一个被校验门拒掉的结果，白白消耗额度。
    // 约束走 instructions（进 system 消息），而不是拼进用户的 prompt ——
    // 见 AiCallInput.instructions 的说明。
    const instructions = project.pluginId === 'custom-page' ? PAGE_CONSTRAINTS : undefined;

    const callInput = {
      taskId: input.taskId,
      kind: input.kind,
      prompt: input.prompt,
      ...(instructions ? { instructions } : {}),
      currentSpec: project.spec,
      fields: fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind })),
      maxOutputTokens: PLATFORM_LIMITS.maxOutputTokensPerCall,
    };

    // ---- 有界重试（**只重试确定没有产生生成结果**的失败）----
    //
    // 【为什么只重试这两种】
    // 重试是要花钱的：如果上游可能已经生成并计费，重试就是**再花一次钱**。
    // 所以判据不是「错得严不严重」，而是「这次失败有没有可能已经产生了输出」：
    //
    //   network           连接就没建起来 → 一定没生成 → 可以重试
    //   http 502/503/504  网关类错误，模型通常还没开始生成 → 可以重试
    //   timeout           可能已经生成完了只是回不来 → **不重试**（重试=再花一次）
    //   protocol          模型已经产出了内容（已计费）→ **不重试**
    //   usage_missing     上游没告诉我们用量 → 重试只会累积更多「无法计费」的消耗
    //   http 4xx          请求本身有问题，重试还是错
    //
    // 【幂等性】整次任务共用同一个 taskId，结算只发生一次，
    // 因此重试不会导致重复扣费（`ai_usage.task_id` 唯一约束是最终防线）。
    let result: Awaited<ReturnType<AiProvider['call']>> | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= PLATFORM_LIMITS.aiMaxRetries; attempt += 1) {
      try {
        result = await provider.call(callInput);
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= PLATFORM_LIMITS.aiMaxRetries || !isRetriableProviderFailure(error)) throw error;
      }
    }
    if (result === undefined) throw lastError;

    // 【空补丁不算成功】
    // 上游（模型、代理、任何中间层）回了 200 但补丁是空的，如果当作成功，
    // 用户会看到「已应用 0 个字段」、额度被扣、项目毫无变化 ——
    // 系统告诉他成功了，而什么都没发生。这比直接报错更糟：他不知道自己该做什么。
    // 这条对所有插件都成立，不是某个插件的特例。
    if (typeof result.patch !== 'object' || result.patch === null || Object.keys(result.patch).length === 0) {
      settleTask(ctx.db, {
        taskId: input.taskId,
        userId,
        projectId: input.projectId,
        kind: input.kind,
        status: 'failed',
        usage: result.usage,
        provider: result.provider,
        model: result.model,
        failureReason: '上游没有返回任何可应用的修改（空补丁）',
      });
      return {
        ok: false,
        code: 'empty_patch',
        message:
          'AI 没有返回任何可应用的修改。可以再点一次，或者把要求写得更具体一些（例如直接写明「标题改成…」「价格改成…」）。',
      };
    }

    // 【自定义页面必须真的产出一个页面】
    // 模型（或任何上游）只回了标题、没回 html 时，如果当作「成功」，
    // 用户会看到「已应用 1 个字段」然后对着一个空页面发呆 ——
    // 他以为自己成功了。这种情况必须明确报失败。
    // 实测中 Mock provider 就是这样：它只按「键: 值」抽取，不理解页面生成的提示词模板。
    if (project.pluginId === 'custom-page') {
      const produced = result.patch['html'];
      if (typeof produced !== 'string' || produced.trim() === '') {
        settleTask(ctx.db, {
          taskId: input.taskId,
          userId,
          projectId: input.projectId,
          kind: input.kind,
          status: 'failed',
          usage: result.usage,
          provider: result.provider,
          model: result.model,
          failureReason: '这次没有生成出页面内容（只返回了标题）',
        });
        return {
          ok: false,
          code: 'no_page_output',
          message:
            '这次没有生成出页面内容。可以再点一次「AI 生成」，或者把你的描述写得更具体一些（想放哪些内容、什么风格）。',
        };
      }
    }

    // 【安全校验门】生成结果必须先过检查才能保存。
    // 放在结算**之前**：没通过校验的结果不写入版本，也不计入消耗 ——
    // 用户不应该为一段被拒的输出付额度。
    const merged = { ...project.spec, ...result.patch };
    const check = checkSpec(project.pluginId, merged);
    if (!check.ok) {
      settleTask(ctx.db, {
        taskId: input.taskId,
        userId,
        projectId: input.projectId,
        kind: input.kind,
        status: 'failed',
        usage: result.usage,
        provider: result.provider,
        model: result.model,
        // 用**规则名**而不是中文说明：便于按规则汇总（见 ai/safety-stats.ts）。
        // 中文说明是给用户看的，走 message 返回，不落库。
        failureReason: `生成结果未通过安全检查：${check.issues.map((i) => i.rule).join(', ')}`,
      });
      return { ok: false, code: 'unsafe_output', message: describePageIssues(check.issues) };
    }

    settleTask(ctx.db, {
      taskId: input.taskId,
      userId,
      projectId: input.projectId,
      kind: input.kind,
      status: 'succeeded',
      usage: result.usage,
      provider: result.provider,
      model: result.model,
    });

    // 局部修改：把补丁合并进规格，而不是整份替换
    const saved = saveDraft(ctx, userId, input.projectId, { spec: result.patch }, 'ai');
    return {
      ok: true,
      patch: result.patch,
      spec: saved?.spec ?? project.spec,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      },
      provider: result.provider,
      model: result.model,
    };
  } catch (error) {
    // 失败也结算：按供应商实际返回的用量；没有返回就记 0（不猜测）
    settleTask(ctx.db, {
      taskId: input.taskId,
      userId,
      projectId: input.projectId,
      kind: input.kind,
      status: 'failed',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
      provider: provider.name,
      model: provider.model,
      failureReason: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: 'provider_error', message: 'AI 服务暂时不可用，请稍后重试' };
  }
}

export type RestoreResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; code: string; message: string };

/**
 * 从回收站恢复项目。
 *
 * 【为什么恢复也必须过额度检查】
 * 额度按「未归档项目数」计算。如果恢复不检查额度，
 * 免费用户可以「建 1 个 → 归档 → 再建 1 个 → 恢复」地无限攒项目 ——
 * 回收站就成了绕开上限的后门。所以这里跟 `createProject` 走同一套判定。
 */
export function restoreProject(
  ctx: AppContext,
  userId: string,
  projectId: string,
  // 默认时间取自应用时钟，而不是 new Date()。
  // 应用可能启用了 devTimeTravel（此时 clock 是可控的 FakeClock），
  // 而会话里的会员到期判定用的就是应用时钟 —— 两边必须是同一个「现在」，
  // 否则会出现「会话说已到期、发布流程说没到期」这种自相矛盾。
  // 生产环境没有 FakeClock，clock 就是系统时钟，与 new Date() 等价。
  now: Date = ctx.adapters.clock.now(),
): RestoreResult {
  // 注意这里要能查到已归档的项目，所以不能用 getOwnedProject 之外的方式；
  // getOwnedProject 不带 status 条件，正好能取到归档项。
  const project = getOwnedProject(ctx.db, userId, projectId);
  if (!project) return { ok: false, code: 'not_found', message: '项目不存在' };
  if (project.status !== 'archived') {
    return { ok: false, code: 'not_archived', message: '该项目不在回收站里' };
  }

  // 生效套餐（已考虑到期）—— 否则到期会员可以靠「恢复」绕过项目数上限
  const membership = membershipForUser(ctx.db, userId, now);
  const decision = checkQuota(
    ctx.db,
    {
      userId,
      tier: membership?.tier ?? 'free',
      action: 'create_project',
      membership: membership ?? undefined,
    },
    now,
  );
  if (!decision.allowed) {
    return { ok: false, code: decision.code ?? 'quota', message: decision.message ?? '额度不足，无法恢复' };
  }

  // 恢复到「草稿」状态，而不是恢复成 archived 之前的状态：
  // 归档前可能是 published，但托管权限可能已经变了，直接恢复成 published
  // 会让一个没有托管权限的用户凭空得到一个线上项目。
  ctx.db
    .prepare("UPDATE projects SET status = 'draft', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'archived'")
    .run(nowIso(), projectId, userId);

  const restored = getOwnedProject(ctx.db, userId, projectId);
  return restored ? { ok: true, project: restored } : { ok: false, code: 'internal', message: '恢复后无法读回' };
}

/**
 * 停止平台托管。
 *
 * 【保留 slug 与发布版本，只把状态改掉】
 * 用户明确要求「不能因为托管到期而擅自删除用户已经下载的文件」——
 * 同理，停止托管也不应该销毁内容。改状态之后公开 URL 立刻返回 404，
 * 但数据仍在库里，重新发布即可恢复（且**沿用同一个 URL**，
 * 因为重新发布后别人手上的旧链接仍然有效）。
 */
export function unpublishProject(
  ctx: AppContext,
  userId: string,
  projectId: string,
): { ok: true; project: ProjectRow } | { ok: false; code: string; message: string } {
  const project = getOwnedProject(ctx.db, userId, projectId);
  if (!project) return { ok: false, code: 'not_found', message: '项目不存在' };
  if (project.status !== 'published') {
    return { ok: false, code: 'not_published', message: '该项目当前没有在托管中' };
  }

  const at = nowIso();
  ctx.db
    .prepare("UPDATE projects SET status = 'draft', unpublished_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(at, at, projectId, userId);

  const updated = getOwnedProject(ctx.db, userId, projectId);
  return updated ? { ok: true, project: updated } : { ok: false, code: 'internal', message: '更新后无法读回' };
}

/** 按公开短链取项目（**不需要登录** —— 这是给别人看的页面） */
export function getProjectBySlug(db: Database, slug: string): ProjectRow | null {
  const row = db
    .prepare("SELECT * FROM projects WHERE public_slug = ? AND status = 'published'")
    .get(slug);
  return row ? mapProject(row as Record<string, unknown>) : null;
}

/** 归档项目（软删除，不物理删除用户数据） */
export function archiveProject(ctx: AppContext, userId: string, projectId: string): boolean {
  const result = ctx.db
    .prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ? AND user_id = ?")
    .run(nowIso(), projectId, userId);
  return Number(result.changes ?? 0) > 0;
}