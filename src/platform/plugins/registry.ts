/**
 * 插件注册表。
 *
 * 【本阶段的实现边界 —— 明确说明，不含糊】
 * 现在的注册表只管理**内置插件**（随代码走，清单在编译期已可信）。
 *
 * 用户要求「插件应能通过标准化的插件包安装」。
 * 完整的上传安装需要解决一个真问题：
 * **如何在主服务进程之外执行插件自带的服务端逻辑**。
 * 本阶段不做这件事 —— 因为在主进程里 `import()` 一个上传的模块
 * 等于把服务器交给上传者，而用户同时要求「不得直接在主服务进程中
 * 不受限制地执行任意上传的服务器端代码」。
 *
 * 因此本阶段提供的是一条**可扩展但安全**的路径：
 *   - 清单校验（`validateManifest`）已实现并测试，上传包必须通过它；
 *   - 已安装插件记录在 `plugin_installations` 表；
 *   - 只有 `builtin: true` 的插件会被加载执行；
 *   - 未内置的插件可以被**登记和停用**，但在沙箱执行能力落地前不会被执行。
 * 这样后续加沙箱时，安装、校验、启停、升级的接口都已就位，不需要重做。
 */

import type { PluginManifest, PublishCheck } from './types.ts';
import { validateManifest } from './types.ts';
import { listingPluginManifest, listingPublishCheck, listingSpecToPropertyPatch } from './listing-plugin.ts';
import { customPagePublishCheck, customPagePluginManifest } from './custom-page-plugin.ts';

/**
 * 插件的内容同步钩子。
 *
 * 插件可以声明「我的 spec 如何落到它自己的数据表上」。
 * 平台在保存草稿后调用它，保证**用户看到的、保存的、导出的三者一致**。
 * 没有声明钩子的插件（例如纯静态网页）无需同步。
 */
const SPEC_SYNCERS = new Map<string, (spec: Record<string, unknown>) => Record<string, unknown>>([
  [listingPluginManifest.id, listingSpecToPropertyPatch],
]);

/** 取某个插件的内容同步函数；没有则返回 null */
export function specSyncerFor(pluginId: string): ((spec: Record<string, unknown>) => Record<string, unknown>) | null {
  return SPEC_SYNCERS.get(pluginId) ?? null;
}

/**
 * 各插件的「发布前内容校验」。
 *
 * 【为什么按插件注册，而不是在发布逻辑里写 if】
 * 「有内容」对不同插件是不同的事：自定义页面要有一份可渲染的 HTML，
 * 房源项目要关联到一套真实房源。把规则放在插件自己那里，
 * 平台发布逻辑只需要问一句「这个插件说能发吗」——
 * 既不用维护一张 if 表，新增插件时也不会漏掉校验。
 */
const PUBLISH_CHECKS = new Map<string, (spec: Record<string, unknown>) => PublishCheck>([
  [listingPluginManifest.id, listingPublishCheck],
  [customPagePluginManifest.id, customPagePublishCheck],
]);

/** 取某个插件的发布校验函数；没有则返回 null（调用方应据此拒绝发布） */
export function publishCheckFor(pluginId: string): ((spec: Record<string, unknown>) => PublishCheck) | null {
  return PUBLISH_CHECKS.get(pluginId) ?? null;
}

/** 平台内置插件清单 */
const BUILTIN_MANIFESTS: readonly PluginManifest[] = [listingPluginManifest, customPagePluginManifest];

export interface RegisteredPlugin {
  manifest: PluginManifest;
  /** 是否可执行 —— 只有内置插件在本阶段可执行 */
  executable: boolean;
}

/** 内置插件注册表（进程内单例，随代码发布） */
const builtinById = new Map<string, PluginManifest>();
for (const m of BUILTIN_MANIFESTS) {
  const checked = validateManifest(m);
  if (!checked.ok) {
    // 内置插件清单写错属于开发期错误，直接抛出让 CI 拦住，
    // 而不是静默跳过导致「插件没加载但没人知道」。
    throw new Error(
      `内置插件清单非法（${m.id}）：${checked.issues.map((i) => `${i.field} ${i.message}`).join('; ')}`,
    );
  }
  builtinById.set(checked.manifest.id, checked.manifest);
}

/** 列出全部内置插件 */
export function listBuiltinPlugins(): RegisteredPlugin[] {
  return [...builtinById.values()].map((manifest) => ({ manifest, executable: true }));
}

/** 按 id 取内置插件 */
export function getBuiltinPlugin(id: string): PluginManifest | null {
  return builtinById.get(id) ?? null;
}

/** 按 pageType 找插件 */
export function findPluginByPageType(pageType: string): PluginManifest | null {
  for (const m of builtinById.values()) if (m.pageType === pageType) return m;
  return null;
}

/**
 * 校验一个「上传的插件包描述」是否可以登记。
 *
 * 返回 `installable: true` 只代表**清单合法、可以登记**；
 * `executable` 恒为 false —— 在沙箱落地前，上传的插件不会被加载执行。
 */
export function inspectUploadedPackage(
  input: unknown,
): { installable: true; manifest: PluginManifest; executable: false } | { installable: false; issues: { field: string; message: string }[] } {
  const checked = validateManifest(input);
  if (!checked.ok) return { installable: false, issues: checked.issues };

  const pageTypeOwner = findPluginByPageType(checked.manifest.pageType);
  if (pageTypeOwner && pageTypeOwner.id !== checked.manifest.id) {
    return {
      installable: false,
      issues: [
        {
          field: 'pageType',
          message: `网页类型 ${checked.manifest.pageType} 已被插件 ${pageTypeOwner.id} 占用`,
        },
      ],
    };
  }

  return { installable: true, manifest: checked.manifest, executable: false };
}