/**
 * 可搜索下拉框（联想搜索）。
 *
 * 为什么不直接用 <datalist>：
 *  - datalist 只能匹配 value 本身，无法「输入中文名 或 英文名 或 国家代码 都能命中」；
 *  - datalist 无法做级联（选了省要换市的候选）；
 *  - datalist 在不同浏览器里的展现差异很大，手机上尤其不可控。
 *
 * 因此自行实现一个最小可用的下拉：
 *  - 输入即筛（匹配 label 与 search 关键字）；
 *  - 上下键 + 回车选择，Esc 关闭；
 *  - 允许自由输入（国外地址可能不在预设里）；
 *  - 点选后触发 onPick，供级联使用。
 */

/** 把候选列表按关键词过滤；关键词为空时返回全部（最多 max 条） */
export function filterItems(items, query, max = 60) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return items.slice(0, max);
  const hit = items.filter((it) => {
    const hay = `${it.label} ${it.search ?? ''} ${it.value}`.toLowerCase();
    return hay.includes(q);
  });
  // 前缀命中排前面，输入体验更接近「输入即得」
  hit.sort((a, b) => {
    const ap = `${a.label} ${a.search ?? ''}`.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = `${b.label} ${b.search ?? ''}`.toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp;
  });
  return hit.slice(0, max);
}

/**
 * 给一个 input 挂上下拉行为。
 * @param {HTMLInputElement} input
 * @param {() => Array<{value:string,label:string,search?:string}>} getItems
 * @param {{onPick?: (item) => void}} handlers
 */
export function attachCombo(input, getItems, handlers = {}) {
  const wrap = input.closest('.combo');
  const list = wrap?.querySelector('.combo-list');
  if (!wrap || !list) return;

  let items = [];
  let active = -1;

  function close() {
    list.classList.remove('open');
    list.innerHTML = '';
    active = -1;
  }

  function paint() {
    if (items.length === 0) { close(); return; }
    list.innerHTML = items
      .map((it, i) => `<li class="${i === active ? 'on' : ''}" data-i="${i}">${it.label}</li>`)
      .join('');
    list.classList.add('open');
  }

  function refresh() {
    items = filterItems(getItems(), input.value);
    // 输入内容与当前选项完全一致时没必要弹
    const exact = items.length === 1 && items[0].value === input.value;
    active = -1;
    if (exact) close();
    else paint();
  }

  function pick(index) {
    const it = items[index];
    if (!it) return;
    // 国家这类「显示名称、存代码」的字段：输入框放 label，真正的值由 onPick 写进隐藏字段
    input.value = handlers.displayLabel ? it.label : it.value;
    close();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    handlers.onPick?.(it);
  }

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);

  input.addEventListener('keydown', (event) => {
    if (!list.classList.contains('open')) {
      if (event.key === 'ArrowDown') { refresh(); event.preventDefault(); }
      return;
    }
    if (event.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); paint(); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { active = Math.max(active - 1, 0); paint(); event.preventDefault(); }
    else if (event.key === 'Enter') { if (active >= 0) { pick(active); event.preventDefault(); } }
    else if (event.key === 'Escape') { close(); }
  });

  list.addEventListener('mousedown', (event) => {
    const li = event.target.closest('li[data-i]');
    if (!li) return;
    event.preventDefault();   // 防止 input 先失焦
    pick(Number(li.dataset.i));
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

/** 把一组候选塞进一个 <datalist>，用于不要求严格取值的字段 */
export function fillDatalist(id, values) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = values.map((v) => `<option value="${String(v).replace(/"/g, '&quot;')}"></option>`).join('');
}