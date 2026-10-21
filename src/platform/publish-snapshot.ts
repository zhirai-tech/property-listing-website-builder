/**
 * 发布快照：把「发布那一刻能渲染出页面的数据」冻结下来。
 *
 * 【为什么必须有这个模块】
 * 房源类项目的公开页原先是这样渲染的：
 *
 *     const aggregate = aggregateFor(scoped, propertyId);   // 读当前房源
 *     renderListingPage({ aggregate, ... });
 *
 * 而 `saveDraft` 会把 spec 同步写进 `properties` 表。两件事合在一起意味着：
 * **用户一改草稿，已经发布出去的公开页面当场就变了。**
 * 「我发布的是什么」因此无法保证 —— 而这正是「发布」这个动作的意义。
 *
 * 自定义页面（custom-page）没有这个问题：它的公开路由读的就是发布版本的 spec。
 * 本模块把同样的保证补给房源类插件。
 *
 * 【快照里放什么】
 * 放**渲染所需的全部数据**，而不是渲染结果：
 *   - 渲染结果（HTML）里含 CSP nonce，是**每次请求**生成的；
 *     把它冻在发布时会导致 nonce 与响应头不匹配，页面上的脚本全部被拦。
 *   - 所以冻结数据、渲染仍然在请求时做，nonce 才是对的。
 *
 * 【兼容】
 * 老版本（本修复之前发布的）没有快照，读取返回 null，
 * 调用方回退到原有逻辑 —— 既有发布页不会因此打不开。
 */

import type { Database } from '../db/database.ts';
import type { AppContext } from '../app-context.ts';
import { getWorkspace } from '../db/repositories/workspace-repo.ts';
import { aggregateFor, ensureListingPage } from '../services/publish-service.ts';
import type { PropertyAggregate } from '../domain/types.ts';

/** 快照格式版本。将来结构变化时可据此判断，而不是靠猜字段。 */
export const SNAPSHOT_VERSION = 1;

export interface ListingSnapshot {
  version: number;
  /** 冻结的渲染数据：房源、照片、联系方式、展示页设置、译文 */
  aggregate: PropertyAggregate;
  /** 发布时确定并冻结的语言 —— 之后改工作区默认语言不影响已发布页面 */
  locale: string;
}

/**
 * 采集一份房源类项目的发布快照。
 *
 * 返回 null 表示「这个项目当前状态无法生成可发布快照」
 * （例如没有关联房源、房源已被删除）—— 调用方应据此**拒绝发布**，
 * 而不是发布一个空页面。
 */
export function captureListingSnapshot(
  ctx: AppContext,
  workspaceId: string,
  propertyId: string,
): ListingSnapshot | null {
  const workspace = getWorkspace(ctx.db, workspaceId);
  if (!workspace) return null;
  const scoped: AppContext = { ...ctx, workspace };

  // 先确保展示页存在：快照里需要它的 slug / 模板 / 语言 / 自定义域名设置。
  // 这一步沿用既有能力，不新增展示页逻辑。
  let page;
  try {
    page = ensureListingPage(scoped, propertyId);
  } catch {
    // 房源不存在或发布前置条件不满足 —— 交给调用方拒绝发布
    return null;
  }

  let aggregate: PropertyAggregate;
  try {
    aggregate = aggregateFor(scoped, propertyId);
  } catch {
    return null;
  }

  return {
    version: SNAPSHOT_VERSION,
    aggregate,
    locale: page.locale ?? workspace.defaultLocale,
  };
}

/** 把快照序列化为可入库的字符串 */
export function serializeSnapshot(snapshot: ListingSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * 读取某个项目**最近一次成功发布**的快照。
 *
 * 没有发布过、或老版本没有快照 → 返回 null（调用方回退到原有逻辑）。
 * 解析失败也返回 null —— 宁可回退，也不要因为一条坏数据让公开页 500。
 */
export function readPublishedSnapshot(db: Database, publishedVersionId: string | null): ListingSnapshot | null {
  if (!publishedVersionId) return null;
  const row = db.prepare('SELECT snapshot_json FROM project_versions WHERE id = ?').get(publishedVersionId) as
    | { snapshot_json: string | null }
    | undefined;
  const raw = row?.snapshot_json;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as ListingSnapshot;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.aggregate !== 'object' || parsed.aggregate === null) return null;
    if (typeof parsed.locale !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}