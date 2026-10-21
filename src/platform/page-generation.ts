/**
 * 模式 B（自由描述生成）的规格校验与提示词。
 *
 * 【校验门为什么放在这一层】
 * 需要被拦住的不只是「AI 生成的 HTML」，还有「用户自己改过的 HTML」。
 * 如果一个页面能靠「先让 AI 生成、再手动编辑」绕过检查，
 * 那这道门就是假的。因此两者走同一个函数，
 * 并且在 `saveDraft()` 里做最终的硬拦截（那里是写库的唯一入口）。
 */

import { validateGeneratedPage, type PageIssue } from '../domain/page-safety.ts';

/** 需要按「自由页面」规则校验的插件 */
const FREE_FORM_PLUGINS = new Set(['custom-page']);

export interface SpecCheck {
  ok: boolean;
  issues: PageIssue[];
}

/**
 * 检查一份规格是否合法。
 *
 * 目前只有「自定义页面」这类插件需要额外检查；
 * 其它插件（如房源）的字段由各自的结构化校验负责，这里直接放行。
 */
export function checkSpec(pluginId: string, spec: Record<string, unknown>): SpecCheck {
  if (!FREE_FORM_PLUGINS.has(pluginId)) return { ok: true, issues: [] };

  const html = spec['html'];
  if (html === undefined || html === null || html === '') {
    // 还没生成过 HTML 是允许的（项目刚建好的状态），不算违规
    return { ok: true, issues: [] };
  }

  const result = validateGeneratedPage(html);
  return result.ok ? { ok: true, issues: [] } : { ok: false, issues: result.issues };
}

/**
 * 保证一段 HTML 声明了 charset。
 *
 * 【为什么需要】「下载到自己电脑上打开」是免费用户的核心使用方式，
 * 而下载后的页面走的是 `file://`，**没有 HTTP 响应头可依赖**。
 * 如果页面里没有 `<meta charset>`，浏览器只能猜编码 —— 中文很容易变成乱码，
 * 用户会觉得「生成的东西是坏的」。
 *
 * 【做法】
 *   - 已经有 charset 就原样返回（不动用户/模型写好的东西）；
 *   - 没有就插在 `<head>` 之后（最靠前的位置，浏览器一旦读到就生效）；
 *   - 连 `<head>` 都没有时插在 `<html>` 之后。
 * 校验门已经保证了页面有 `<html>`/`<body>`/`<title>`，
 * 但这里仍然对「都没有」的情况留了兜底，不抛错。
 */
export function ensureCharset(html: string, charset = 'utf-8'): string {
  if (/<meta\b[^>]*\bcharset\s*=/i.test(html)) return html;

  const declaration = `<meta charset="${charset}">`;

  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}${declaration}${html.slice(at)}`;
  }

  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}${declaration}${html.slice(at)}`;
  }

  // 没有 html/head：直接放最前面。校验门本来就会拒掉这种页面，
  // 这里只保证函数本身在任何输入下都不抛错。
  return `${declaration}${html}`;
}

/**
 * 模式 B 的提示词。
 *
 * 这里写的每一条约束都对应校验门里的一条规则 ——
 * 提示词不是「尽量减少被拒的概率」，而是**把规则如实告诉模型**。
 * 模型仍然可能违反，所以门必须在服务端，不能只靠提示词。
 */
export const PAGE_CONSTRAINTS = [
    '请输出一个完整的、可以直接在浏览器打开的 HTML 单页。硬性要求：',
    '1. 必须包含 <html>、<head>、<title>、<body>，且标签都正确闭合。',
    '2. 样式写在 <style> 标签里（允许内联 CSS），不要引入任何外部样式表。',
    '3. 绝对不要包含 <script>、<iframe>、<form>、<link>、<meta>、<base>、<svg>。',
    '4. 不要使用 onclick / onload 这类事件属性，不要使用 javascript: 地址。',
    '5. 图片只能用 https:// 或 data:image/ 地址；不要引用本地相对路径。',
    '6. 页面要有中文可见文字内容，排版整洁，适配手机屏幕。',
    '只输出 JSON 对象，形如 {"title":"页面标题","html":"<!doctype html>..."}。',
  ].join('\n')