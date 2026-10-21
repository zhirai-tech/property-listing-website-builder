/**
 * 房源列表视图（卡片网格）。
 *
 * 移动端优先。布局取向参考「购物商城 App 的商品卡」：
 * 一屏能扫到多套房，封面图 + 名称 + 价格 + 面积 + 状态一目了然，
 * 操作按钮收进卡片右上角的编辑按钮，不占版面。
 *
 * 网格自适应：宽屏一排 4–5 张，平板 3 张，手机 2 张（由 CSS 的 auto-fill 决定）。
 */

import { api } from '../api.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { confirmAction, errorBlock, esc, fmtDateTime, statusLabel, tag, toast } from '../ui.js';

/** 面积单位显示：不写死公制，平方英尺房源必须显示正确单位 */
function areaUnitLabel(unit) {
  if (unit === 'square_foot') return 'sq ft';
  if (unit === 'square_meter') return '㎡';
  return unit ?? '';
}

function periodLabel(period) {
  return { per_month: '月', per_week: '周', per_night: '晚', per_year: '年', total: '' }[period] ?? '';
}

function money(property) {
  if (property.priceAmount === null) return t('面议');
  const period = property.pricePeriod === 'total' ? '' : `/${periodLabel(property.pricePeriod)}`;
  return `${property.priceAmount.toLocaleString('zh-CN')} ${property.priceCurrency}${period}`;
}

/** 可租状态标签（未确认由后端按陈旧度推导后返回） */
function availabilityTag(value) {
  const map = {
    available: ['active', '出租中'],
    rented: ['archived', '已租'],
    unconfirmed: ['pending', '未确认'],
  };
  const entry = map[value] ?? map.available;
  return `<span class="tag ${entry[0]}">${t(entry[1])}</span>`;
}

const state = {
  search: '',
  status: 'all',
  includeArchived: false,
  items: [],
  total: 0,
  statusCounts: {},
  expanded: new Set(),
};

function statCards(counts, total) {
  const order = ['draft', 'active', 'reserved', 'closed', 'archived'];
  return `<div class="stats">
    <div class="stat"><span class="k">${esc(t('房源总数'))}</span><span class="v">${total}</span></div>
    ${order
      .map(
        (key) =>
          `<div class="stat"><span class="k">${esc(t(statusLabel(key)))}</span><span class="v">${counts[key] ?? 0}</span></div>`,
      )
      .join('')}
  </div>`;
}

/** 单张房源卡片 */
function card(property) {
  const listing = property.listing;
  const area =
    property.areaValue === null ? '' : `${property.areaValue} ${areaUnitLabel(property.areaUnit)}`;
  const rooms = [
    property.bedrooms === null ? '' : `${property.bedrooms}室`,
    property.bathrooms === null ? '' : `${property.bathrooms}卫`,
  ]
    .filter(Boolean)
    .join('');

  // 封面：没有照片时渲染占位，而不是留一块破图
  const media = property.coverUrl
    ? `<img src="${esc(property.coverUrl)}" alt="" loading="lazy" decoding="async">`
    : `<div class="pcard-empty">${icon('home', { size: 30 })}<span>${esc(t('暂无照片'))}</span></div>`;

  const slugLine = listing
    ? `<div class="pcard-slug mono">/${esc(listing.slug)}</div>`
    : `<div class="pcard-slug muted">${esc(t('尚未创建页面'))}</div>`;

  const isOpen = state.expanded.has(property.id);

  return `<article class="pcard${isOpen ? ' is-open' : ''}" data-id="${esc(property.id)}" data-i18n-skip>
    <div class="pcard-media">
      ${media}
      <div class="pcard-badges">
        ${availabilityTag(property.availabilityStatus)}
        ${tag(property.status)}
      </div>
      <button type="button" class="pcard-edit" data-action="toggle"
              aria-expanded="${isOpen ? 'true' : 'false'}"
              aria-label="编辑「${esc(property.title)}」"
              title="编辑">${icon('edit', { size: 18 })}</button>
    </div>
    <div class="pcard-body">
      <h3 class="pcard-title">${esc(property.title)}</h3>
      <div class="pcard-price">${esc(money(property))}</div>
      <div class="pcard-meta">
        ${area ? `<span>${esc(area)}</span>` : ''}
        ${rooms ? `<span>${esc(rooms)}</span>` : ''}
        <span class="muted">${property.photoCount ?? 0} 张</span>
      </div>
      ${slugLine}
    </div>
    <div class="pcard-actions">
      <div class="pcard-updated muted">${esc(t('更新于'))} ${esc(fmtDateTime(property.updatedAt))}</div>
      <div class="row gap-sm">
        <a class="btn small primary" href="#/properties/${esc(property.id)}">${esc(t('编辑'))}</a>
        <button class="btn small" data-action="duplicate" data-id="${esc(property.id)}">${esc(t('复制'))}</button>
        ${
          property.status === 'archived'
            ? `<button class="btn small" data-action="restore" data-id="${esc(property.id)}">${esc(t('恢复'))}</button>`
            : `<button class="btn small" data-action="archive" data-id="${esc(property.id)}">${esc(t('归档'))}</button>`
        }
        <button class="btn small danger" data-action="delete" data-id="${esc(property.id)}"
                data-title="${esc(property.title)}">${esc(t('删除'))}</button>
      </div>
    </div>
  </article>`;
}

function grid() {
  if (state.items.length === 0) {
    return `<p class="muted">${esc(t('暂无房源。点击右上角「新增房源」开始录入。'))}</p>`;
  }
  return state.items.map(card).join('');
}

async function load() {
  const params = new URLSearchParams();
  if (state.search) params.set('search', state.search);
  if (state.status !== 'all') params.set('status', state.status);
  if (state.includeArchived) params.set('includeArchived', 'true');

  const data = await api.get(`/api/admin/properties?${params.toString()}`);
  state.items = data.items;
  state.total = data.total;
  state.statusCounts = data.statusCounts ?? {};
}

function paint(container) {
  container.innerHTML = `
    <div class="page-head spread">
      <div>
        <h2>${esc(t('房源管理'))}</h2>
        <p class="muted small">${esc(t('一次录入，展示页与导出内容都从这份数据生成。'))}</p>
      </div>
      <a class="btn primary" href="#/properties/new">${esc(t('+ 新增房源'))}</a>
    </div>

    <div id="stats">${statCards(state.statusCounts, state.total)}</div>

    <div class="card">
      <div class="row">
        <input id="search" class="grow input" type="search" placeholder="${esc(t('搜索标题 / 城市 / 区域 / 地址'))}" value="${esc(state.search)}">
        <select id="status-filter" class="input">
          ${[
            ['all', '全部状态'],
            ['draft', '草稿'],
            ['active', '在售/在租'],
            ['reserved', '已预订'],
            ['closed', '已成交'],
            ['archived', '已归档'],
          ]
            .map(([value, label]) => `<option value="${value}"${state.status === value ? ' selected' : ''}>${esc(t(label))}</option>`)
            .join('')}
        </select>
        <label class="row small gap-sm">
          <input type="checkbox" id="include-archived"${state.includeArchived ? ' checked' : ''}>
          ${esc(t('含归档'))}
        </label>
      </div>
    </div>

    <div id="list-error"></div>
    <div class="pgrid" id="grid">${grid()}</div>
  `;

  const searchInput = container.querySelector('#search');
  let debounce = null;
  searchInput.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      state.search = searchInput.value.trim();
      await refresh(container);
    }, 320);
  });

  container.querySelector('#status-filter').addEventListener('change', async (event) => {
    state.status = event.target.value;
    await refresh(container);
  });

  container.querySelector('#include-archived').addEventListener('change', async (event) => {
    state.includeArchived = event.target.checked;
    await refresh(container);
  });

  container.querySelector('#grid').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    if (button.dataset.action === 'toggle') {
      // 就地展开：只重绘该卡片，避免整页重排导致滚动位置跳动
      const cardEl = button.closest('.pcard');
      const id = cardEl.dataset.id;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      cardEl.outerHTML = card(state.items.find((p) => p.id === id));
      return;
    }

    void handleAction(container, button);
  });
}

async function refresh(container) {
  try {
    await load();
    paint(container);
  } catch (error) {
    const box = container.querySelector('#list-error');
    if (box) box.innerHTML = errorBlock(error);
  }
}

async function handleAction(container, button) {
  const { action, id, title } = button.dataset;

  try {
    if (action === 'archive') {
      if (!confirmAction(`${t('确定归档「')}${title}${t('」？归档后默认不出现在列表中，数据仍保留。')}`)) return;
      await api.post(`/api/admin/properties/${id}/status`, { status: 'archived' });
      toast(t('已归档'));
    } else if (action === 'restore') {
      await api.post(`/api/admin/properties/${id}/status`, { status: 'restore' });
      toast(t('已恢复为草稿'));
    } else if (action === 'duplicate') {
      const copy = await api.post(`/api/admin/properties/${id}/duplicate`);
      toast(`${t('已复制为「')}${copy.title}」`);
    } else if (action === 'delete') {
      if (!confirmAction(`${t('确定要彻底删除「')}${title}${t('」？\n\n将同时删除该房源的展示页、照片文件与提醒，且不可恢复。')}`)) return;
      await api.del(`/api/admin/properties/${id}`);
      toast(t('已删除'));
    }
    await refresh(container);
  } catch (error) {
    const box = container.querySelector('#list-error');
    if (box) box.innerHTML = errorBlock(error);
    toast(error?.message ?? '操作失败', 'error');
  }
}

export async function render(container) {
  await load().catch(() => {});
  paint(container);
  await refresh(container);
}