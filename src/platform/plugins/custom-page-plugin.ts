/**
 * 自定义页面插件 —— 对应方案里的「模式 B：自由描述生成」。
 *
 * 【与房源插件的区别】
 *   房源插件（模式 A）：用户填结构化字段 → 平台用既有渲染器生成页面。
 *                       内容稳定、可逐字段编辑，但页面形态是固定的。
 *   自定义页面（模式 B）：用户描述想要的页面 → 模型直接产出 HTML。
 *                       形态自由，但**必须过安全校验门**才能保存。
 *
 * 【为什么 html 是一个可编辑字段】
 * 高级用户可能想微调生成结果。把它做成 textarea 而不是藏起来，
 * 意味着「保存时同样要过校验门」—— 见 projects.ts 的 saveDraft。
 * 用户手改的内容和模型产出的内容受同一套规则约束，不存在特例。
 */

import type { PluginField, PluginManifest, PublishCheck } from './types.ts';
import { describePageIssues, validateGeneratedPage } from '../../domain/page-safety.ts';
import { PLUGIN_API_VERSION } from './types.ts';

const FIELDS: readonly PluginField[] = [
  {
    key: 'title',
    label: '页面标题',
    kind: 'text',
    required: true,
    max: 120,
    hint: '显示在浏览器标签页上',
  },
  {
    key: 'html',
    label: '页面内容（HTML）',
    kind: 'textarea',
    max: 200000,
    hint: '由 AI 生成，也可以自己微调。保存时会做安全检查：不允许脚本、表单、嵌套文档。',
  },
];

export const CUSTOM_PAGE_PLUGIN_ID = 'custom-page';

/**
 * 发布前校验（自定义页面）。
 *
 * 【与 checkSpec 的区别 —— 这是刻意的】
 * `checkSpec` 服务于**保存草稿**，它明确允许「还没有 html」：
 * 项目刚建好、用户还没生成时，保存草稿不该报错。
 *
 * 但**发布**是另一回事：公开页面必须真的有内容，否则用户拿到一个
 * 「发布成功」的地址，打开却是 404 —— 这比直接拒绝更糟。
 * 所以这里是更严格的规则：没有内容就不许发布。
 */
export function customPagePublishCheck(spec: Record<string, unknown>): PublishCheck {
  const html = spec['html'];
  if (typeof html !== 'string' || html.trim() === '') {
    return {
      ok: false,
      message: '这个页面还没有内容，无法发布。先用 AI 生成，或者自己写好页面内容再发布。',
    };
  }

  // 与草稿保存同一套校验门：发布出去的内容也必须通过它，
  // 否则会出现「草稿存下了、发布也成功了，但公开页打不开」的错位。
  const validation = validateGeneratedPage(html);
  if (!validation.ok) {
    return { ok: false, message: describePageIssues(validation.issues) };
  }

  return { ok: true };
}

export const customPagePluginManifest: PluginManifest = {
  id: CUSTOM_PAGE_PLUGIN_ID,
  name: '自定义单页',
  version: '1.0.0',
  pageType: 'custom-page',
  description: '用一句话描述你想要的网页，AI 直接生成一个可下载、可自行部署的单页。',
  fields: FIELDS,
  // 页面由平台直接产出 HTML，不需要服务端渲染器，也不需要访问存储里的媒体
  capabilities: ['ai.generate', 'hosting.publish'],
  apiVersion: PLUGIN_API_VERSION,
  builtin: true,
  structuralKeys: [],
};