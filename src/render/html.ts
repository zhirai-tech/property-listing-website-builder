/**
 * HTML 转义与安全 URL 处理。
 *
 * 方案第 8 阶段要求检查 XSS 与权限隔离：展示页所有动态内容都必须经过转义，
 * 哪怕是后台管理员录入的内容（管理员账号一旦被接管，未转义的字段就是存储型 XSS）。
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 转义为 HTML 文本/属性安全的内容 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * 仅允许 http/https 的 URL 进入 href/src，其余一律返回 ''。
 * 用于阻断 javascript: / data: 等危险协议。
 */
export function safeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';

  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    return '';
  } catch {
    // 相对路径（例如 /media/xxx）原样放行，但必须不以 // 开头（协议相对 URL）
    if (trimmed.startsWith('//')) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return '';
    return trimmed;
  }
}

/** 属性值转义（在 escapeHtml 基础上再防御换行注入） */
export function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/[\r\n]/g, ' ');
}

/** 生成安全的内联 JSON（用于把数据传给页面脚本） */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
