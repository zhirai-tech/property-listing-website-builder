/**
 * 问号帮助图标（后台版本）。
 *
 * 【规则】说明类文案一律收进这个图标，不直接铺在页面上。
 * 详见技能 ui-help-icons —— 该约定适用于所有项目。
 *
 * 这里不依赖 ui.js 的 el()（那个接收 HTML 字符串，签名不同），
 * 直接用 DOM API 构建，避免为了一个图标去改公共辅助函数。
 */

function makeHelp(text) {
  const wrap = document.createElement('span');
  wrap.className = 'help';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'help-btn';
  btn.textContent = '?';
  btn.setAttribute('aria-label', '说明');

  const tip = document.createElement('span');
  tip.className = 'help-tip';
  tip.textContent = text;

  wrap.append(btn, tip);

  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // 一次只开一个：同时展开多个就重新变成「到处是说明」
    for (const other of document.querySelectorAll('.help.open')) {
      if (other !== wrap) other.classList.remove('open');
    }
    wrap.classList.toggle('open');
  });

  return wrap;
}

document.addEventListener('click', () => {
  for (const open of document.querySelectorAll('.help.open')) open.classList.remove('open');
});

/**
 * 把页面里 data-help 的挂载点渲染成问号图标。
 * 静态标记里只写文案，图标由这里生成 —— 标记里不出现可见的说明元素。
 */
export function mountHelpSlots(root = document) {
  for (const slot of root.querySelectorAll('.help-slot[data-help]')) {
    if (slot.dataset.mounted === '1') continue;
    slot.dataset.mounted = '1';
    slot.appendChild(makeHelp(slot.dataset.help ?? ''));
  }
}

export { makeHelp };