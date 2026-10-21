import { hasKey, isEnglish, t } from './i18n.js';

/**
 * 轻量 DOM 与展示辅助。
 * 所有动态内容都经过 esc() 转义，避免后台界面出现 XSS。
 */

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

export function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

let toastTimer = null;

export function toast(message, kind = 'ok') {
  const node = document.getElementById('toast');
  if (!node) return;

  node.textContent = message;
  node.className = `toast ${kind}`;

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 4200);
}

/** 把 API 错误渲染成一致的提示块 */
export function errorBlock(error) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  const list = issues.length
    ? `<ul class="issues">${issues.map((i) => `<li>${esc(i.field)}：${esc(i.message)}</li>`).join('')}</ul>`
    : '';
  return `<div class="alert error"><strong>${esc(error?.message ?? '操作失败')}</strong>${list}</div>`;
}

const STATUS_LABELS = {
  draft: '草稿', active: '在售/在租', reserved: '已预订', closed: '已成交', archived: '已归档',
  unpublished: '未发布', published: '已发布', withdrawn: '已撤下',
  pending: '待处理', completed: '已完成', skipped: '已关闭', failed: '发送失败',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status ?? '';
}

export function tag(status) {
  return `<span class="tag ${esc(status)}">${esc(statusLabel(status))}</span>`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtDateTime(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 按指定 IANA 时区格式化时间。
 * 提醒的「计划时间」必须用它自己的时区渲染 —— 用浏览器本地时区显示
 * 却标注 Asia/Shanghai 会直接误导用户（例如把当地 09:00 显示成 03:00）。
 */
export function fmtDateTimeInZone(iso, timeZone) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);

  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'medium',
      hour12: false,
    }).format(date);
  } catch {
    return fmtDateTime(iso);
  }
}

export function fmtDate(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('zh-CN');
}

/** 表单字段容器 */
/**
 * 就地套用当前语言的界面文字。
 *
 * 刻意不整页重绘：切换语言时用户可能已经填了一半，
 * 重绘会把这些未保存的输入抹掉。这里只改文字节点。
 */
/** 不该被自动扫描碰到的容器：用户登记的资料，以及非文字节点 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT']);

/**
 * 自动翻译文本节点。
 *
 * 为什么需要它：后台有 6 个视图、两百多条界面文字。逐条在模板里挂 data-i18n
 * 既啰嗦又容易漏。这里在渲染完成后扫一遍文本节点，
 * **内容与词典键完全一致时**才替换 —— 这也天然避开了用户数据：
 * 用户填的标题不可能恰好等于「设置」这种界面词，真撞上了也只是显示成译文，
 * 而且房源卡片、标题、描述这些容器都标了 data-i18n-skip 主动跳过。
 */
function scanTextNodes(node) {
  if (!node) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode(textNode) {
      const value = textNode.nodeValue;
      if (!value || !/[\u4e00-\u9fa5]/.test(value)) return NodeFilter.FILTER_REJECT;
      const parent = textNode.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-i18n]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) hits.push(n);

  for (const textNode of hits) {
    const raw = textNode.nodeValue;
    const trimmed = raw.trim();
    if (!hasKey(trimmed)) continue;
    const translated = t(trimmed);
    if (translated === trimmed) continue;
    textNode.nodeValue = raw.replace(trimmed, translated);
  }
}

export function applyI18n(root) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  // 下拉选项：OPTION 不在扫描范围内（它的文本不是普通文本节点），单独处理
  for (const el of root.querySelectorAll('option')) {
    const zh = el.dataset.i18nZh ?? el.textContent;
    if (!hasKey(zh.trim())) continue;
    el.dataset.i18nZh = zh;
    el.textContent = t(zh.trim());
  }
  // 输入框占位符：扫描碰不到，也只在这里处理
  for (const el of root.querySelectorAll('input[placeholder]')) {
    const zh = el.dataset.i18nZhPh ?? el.getAttribute('placeholder');
    if (!hasKey((zh ?? '').trim())) continue;
    el.dataset.i18nZhPh = zh;
    el.setAttribute('placeholder', t(zh.trim()));
  }
  for (const el of root.querySelectorAll('[data-i18n-tip]')) {
    const tip = t(el.dataset.i18nTip);
    el.dataset.tip = tip;
    el.setAttribute('aria-label', tip);
  }
  for (const el of root.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
  }
  if (isEnglish()) scanTextNodes(root);
}

export function field({
  label,
  name,
  value = '',
  type = 'text',
  hint = '',
  tip = '',
  placeholder = '',
  required = false,
  options = null,
  rows = 3,
  span = 1,
  append = '',
}) {
  const id = `f-${name}`;
  let control;

  if (options) {
    control = `<select id="${id}" name="${esc(name)}" data-field="${esc(name)}">
      ${options
        .map(
          (o) =>
            `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`,
        )
        .join('')}
    </select>`;
  } else if (type === 'textarea') {
    control = `<textarea id="${id}" name="${esc(name)}" data-field="${esc(name)}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
  } else {
    control = `<input id="${id}" name="${esc(name)}" data-field="${esc(name)}" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}"${required ? ' required' : ''}>`;
  }

  // tip：把说明收进标签右上角的问号，鼠标悬停或键盘聚焦即可看到。
  // 这样默认不占任何版面，字段能排得很密。
  // span：跨列数，用于「标题」这类需要整行的字段。
  // append：把「单位 / 币种」这类附属控件**贴在输入框右侧**，
  // 而不是另起一个字段。价格与币种、面积与单位本该是一体的，
  // 拆成两个字段既占地方，又让人以为可以各自独立。
  const body = append ? `<div class="input-group">${control}${append}</div>` : control;

  return `<label class="field${span > 1 ? ` span-${span}` : ''}" data-for="${esc(name)}">
    <span class="label-row"><span data-i18n="${esc(label)}">${esc(label)}</span>${required ? ' *' : ''}${
      tip
        ? `<i class="q" tabindex="0" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}" data-i18n-tip="${esc(tip)}">?</i>`
        : ''
    }</span>
    ${body}
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    <div class="err hidden"></div>
  </label>`;
}

/** 读取表单内所有 data-field */
export function readForm(root) {
  const values = {};
  root.querySelectorAll('[data-field]').forEach((node) => {
    const key = node.dataset.field;
    if (!key) return;
    values[key] = node.type === 'checkbox' ? node.checked : node.value;
  });
  return values;
}

/** 把字段级错误标注到对应输入框 */
export function applyFieldErrors(root, issues) {
  root.querySelectorAll('.field.invalid').forEach((n) => n.classList.remove('invalid'));
  root.querySelectorAll('.field .err').forEach((n) => {
    n.textContent = '';
    n.classList.add('hidden');
  });

  for (const issue of issues ?? []) {
    const holder = root.querySelector(`[data-for="${issue.field}"]`);
    if (!holder) continue;
    holder.classList.add('invalid');
    const err = holder.querySelector('.err');
    if (err) {
      err.textContent = issue.message;
      err.classList.remove('hidden');
    }
  }
}

/** 简单的确认对话框封装 */
export function confirmAction(message) {
  return window.confirm(message);
}