/**
 * 房源编辑视图：基本信息、媒体、发布页面、多语言、域名与导出。
 * 对应方案第 1、2、3、4、5、6 阶段的真实用户路径。
 */

import { api } from '../api.js';
import { attachCombo, filterItems } from '../combobox.js';
import { LOCALES, getLocale, setLocale, t } from '../i18n.js';
import { icon } from '../icons.js';
import {
  applyFieldErrors,
  applyI18n,
  confirmAction,
  errorBlock,
  esc,
  field,
  fmtBytes,
  fmtDateTime,
  readForm,
  statusLabel,
  tag,
  toast,
} from '../ui.js';

const TABS = [
  ['basic', '基本信息'],
  ['media', '照片与视频'],
  ['publish', '发布页面'],
  ['i18n', '多语言'],
  ['domain', '自定义域名'],
];

/**
 * 贴在输入框右侧的附属下拉（币种、面积单位）。
 *
 * 这些单位跟数值是一体的：把「价格」和「币种」拆成两个字段，
 * 既占地方，又让人以为可以各自独立设置。贴在右边一眼就懂。
 */
function suffixSelect(name, value, options) {
  return `<select class="suffix" name="${esc(name)}" data-field="${esc(name)}" aria-label="${esc(name)}">
    ${options
      .map(
        (o) =>
          `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`,
      )
      .join('')}
  </select>`;
}

// ---------------------------------------------------------------------------
// 地址预设数据（按需加载，不拖慢首屏）
// ---------------------------------------------------------------------------

/** 国家：{ code, zh, en }；中国省市县：{ n, c: [{ n, a: [] }] } */
const world = { countries: [], provinces: [], loaded: false, loading: null };

/** 懒加载地址预设；只在打开「基本信息」时才拉，避免拖慢后台首页 */
async function ensureWorld() {
  if (world.loaded) return world;
  if (world.loading) return world.loading;

  world.loading = (async () => {
    try {
      const [c, d] = await Promise.all([
        fetch('data/countries.json').then((r) => (r.ok ? r.json() : { items: [] })),
        fetch('data/divisions-cn.json').then((r) => (r.ok ? r.json() : { tree: [] })),
      ]);
      // 中英名分开存：显示哪一种由「正在填写的语言」决定，
      // 而不是把两个名字并排堆在输入框里。
      world.countries = (c.items ?? []).map((x) => ({
        value: x.code,
        zh: x.zh,
        en: x.en,
        search: `${x.zh} ${x.en} ${x.code}`,
      }));
      world.provinces = d.tree ?? [];
      world.loaded = true;
    } catch {
      // 预设取不到不影响填写 —— 所有地址字段都允许自由输入
      world.countries = [];
      world.provinces = [];
      world.loaded = true;
    }
    return world;
  })();

  return world.loading;
}

/**
 * 当前正在填写的语言。
 *
 * 中文填的是「原文」（存在 properties 表），其它语言填的是译文
 * （存在 property_translations 表）。两者互不覆盖。
 */
const lang = {
  current: 'zh-CN',
  /** locale -> { title, description }，切换语言时先把当前输入存进来 */
  buffer: {},
};

const isOriginLang = () => lang.current === (state.translations?.origin.locale ?? 'zh-CN');

/** 国家候选：显示名跟随当前语言，搜索时中英名与代码都能命中 */
const countryItems = () =>
  world.countries.map((c) => ({
    value: c.value,
    label: lang.current === 'en' ? c.en : c.zh,
    search: c.search ?? `${c.zh} ${c.en} ${c.value}`,
  }));

/**
 * 国名显示。
 *
 * 预设只有中英两个名字（ISO 3166 名单本身也只到这一步）。
 * 中文界面用中文名，**其余语言一律回落英文** ——
 * 在法语界面上显示「中国」比显示「China」更难懂。
 */
const countryLabel = (code) => {
  const hit = world.countries.find((c) => c.value === code);
  if (!hit) return code ?? '';
  const ui = getLocale();
  return ui === 'zh-CN' ? hit.zh : hit.en;
};

const provinceItems = () =>
  world.provinces.map((p) => ({ value: p.n, label: p.n, search: p.n }));

const cityItems = (provinceName) => {
  const p = world.provinces.find((x) => x.n === provinceName);
  return (p?.c ?? []).map((c) => ({ value: c.n, label: c.n, search: c.n }));
};

const districtItems = (provinceName, cityName) => {
  const p = world.provinces.find((x) => x.n === provinceName);
  const c = p?.c.find((x) => x.n === cityName);
  return (c?.a ?? []).map((a) => ({ value: a, label: a, search: a }));
};

/**
 * 可搜索下拉字段。
 *
 * 国家特殊：下拉里显示「中国 China」，但**存的是 CN**。
 * 因此额外挂一个隐藏字段承载真正的值，输入框只负责展示与搜索。
 */
function comboField({ label, name, value, tip = '', span = 1, display = null, hiddenName = null }) {
  const id = `f-${name}`;
  const shown = display ?? value;
  const hidden = hiddenName
    ? `<input type="hidden" name="${esc(hiddenName)}" data-field="${esc(hiddenName)}" value="${esc(value ?? '')}">`
    : '';
  return `<label class="field${span > 1 ? ` span-${span}` : ''}" data-for="${esc(name)}">
    <span class="label-row"><span data-i18n="${esc(label)}">${esc(label)}</span>${
      tip
        ? `<i class="q" tabindex="0" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}" data-i18n-tip="${esc(tip)}">?</i>`
        : ''
    }</span>
    <div class="combo">
      <input id="${id}"${hiddenName ? '' : ` data-field="${esc(name)}"`} name="${esc(name)}"
             value="${esc(shown ?? '')}"
             autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list">
      <ul class="combo-list" role="listbox"></ul>
      ${hidden}
    </div>
    <div class="err hidden"></div>
  </label>`;
}

const state = {
  container: null,
  id: 'new',
  tab: 'basic',
  meta: null,
  property: null,
  media: [],
  listing: null,
  translations: null,
  hosting: null,
  readiness: null,
  error: null,
};

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function loadAll() {
  state.meta = await api.get('/api/admin/meta');

  if (state.id === 'new') {
    state.property = null;
    return;
  }

  const detail = await api.get(`/api/admin/properties/${state.id}`);
  state.property = detail.property;
  state.media = detail.media ?? [];
  state.listing = detail.listingPage;
  state.readiness = detail.readiness;

  state.translations = await api.get(`/api/admin/properties/${state.id}/translations`);
  state.hosting = await api.get(`/api/admin/properties/${state.id}/hosting`);
}

async function reload() {
  try {
    await loadAll();
    state.error = null;
  } catch (error) {
    state.error = error;
  }
  paint();
}

// ---------------------------------------------------------------------------
// 视图渲染
// ---------------------------------------------------------------------------

function paint() {
  const isNew = state.id === 'new';
  const title = isNew ? '新增房源' : state.property?.title ?? '房源';
  const meta = state.meta;

  state.container.innerHTML = `
    <div class="page-head spread">
      <div>
        <p class="muted small"><a class="back-link" href="#/properties">${icon('back', { size: 16 })}<span data-i18n="返回房源列表">返回房源列表</span></a></p>
        <h2>${esc(title)}</h2>
        ${
          isNew
            ? '<p class="muted small">填写基本信息后保存，即可继续上传照片与生成展示页。</p>'
            : `<p class="muted small">ID：<span class="mono">${esc(state.id)}</span> · 最后更新 ${esc(fmtDateTime(state.property?.updatedAt))}</p>`
        }
      </div>
      ${
        isNew || !state.listing
          ? ''
          : `<div class="row">
              ${tag(state.listing.status)}
              ${
                state.hosting
                  ? `<a class="btn small" href="${esc(state.hosting.state.publicUrl)}" target="_blank" rel="noopener">打开展示页</a>`
                  : ''
              }
            </div>`
      }
    </div>

    ${state.error ? errorBlock(state.error) : ''}
    ${isNew ? '' : `<nav class="row mb">${TABS.map(tabButton).join('')}</nav>`}
    <div id="tab-body"></div>
  `;

  if (!isNew) {
    state.container.querySelectorAll('nav.row button[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.tab = button.dataset.tab;
        paint();
      });
    });
  }

  const body = state.container.querySelector('#tab-body');

  if (isNew || state.tab === 'basic') renderBasic(body, meta);
  else if (state.tab === 'media') renderMedia(body);
  else if (state.tab === 'publish') renderPublish(body);
  else if (state.tab === 'i18n') renderI18n(body);
  else if (state.tab === 'domain') renderDomain(body);
}

function tabButton([key, label]) {
  const active = state.tab === key ? ' primary' : '';
  return `<button class="btn small${active}" data-tab="${key}" type="button" data-i18n="${esc(label)}">${esc(label)}</button>`;
}

// ---------------------------------------------------------------------------
// 基本信息
// ---------------------------------------------------------------------------

/**
 * 地址四件套的联想接线。
 *
 * 级联规则：改了「省」就清空「市」和「区」的候选，改了「市」就清空「区」——
 * 否则会出现「上海市 + 东城区」这种对不上的组合。
 * 所有字段都允许自由输入，因为国外地址不在中国区划预设里。
 */
async function wireAddress(form, p) {
  await ensureWorld();

  const countryInput = form.querySelector('#f-countryDisplay');
  const countryHidden = form.querySelector('[data-field="countryCode"]');
  const regionInput = form.querySelector('[data-field="region"]');
  const cityInput = form.querySelector('[data-field="city"]');
  const districtInput = form.querySelector('[data-field="district"]');

  if (countryInput) {
    // 服务端存的是两位代码，这里按当前语言翻译成可读名称（中文下是「中国」，英文下是「China」）
    const raw = (countryHidden?.value || p.countryCode || '').toUpperCase();
    if (raw) {
      countryInput.value = countryLabel(raw);
      if (countryHidden) countryHidden.value = raw;
    }
    attachCombo(countryInput, countryItems, {
      displayLabel: true,
      onPick(item) { if (countryHidden) countryHidden.value = item.value; },
    });
    // 手打国家名（没点下拉）时反查代码；查不到就清空，避免存下对不上的组合
    countryInput.addEventListener('change', () => {
      const text = countryInput.value.trim();
      const upper = text.toUpperCase();
      const matched = world.countries.find(
        (c) => c.zh === text || c.en === text || c.value === upper,
      );
      if (countryHidden) countryHidden.value = matched ? matched.value : '';
    });
  }

  if (regionInput) {
    attachCombo(regionInput, provinceItems, {
      onPick() { if (cityInput) cityInput.value = ''; if (districtInput) districtInput.value = ''; },
    });
    regionInput.addEventListener('change', () => {
      if (cityInput) cityInput.value = '';
      if (districtInput) districtInput.value = '';
    });
  }
  if (cityInput) {
    attachCombo(cityInput, () => cityItems(regionInput?.value ?? ''), {
      onPick() { if (districtInput) districtInput.value = ''; },
    });
  }
  if (districtInput) {
    attachCombo(districtInput, () => districtItems(regionInput?.value ?? '', cityInput?.value ?? ''));
  }
}

/**
 * 单价 = 总价 ÷ 面积。房东不该自己拿计算器按。
 * 只在两个数都填了、且面积不为 0 时显示；面积单位跟随「面积单位」字段。
 */
function wireUnitPrice(form) {
  const price = form.querySelector('[data-field="priceAmount"]');
  const area = form.querySelector('[data-field="areaValue"]');
  const unitSel = form.querySelector('[data-field="areaUnit"]');
  const currencySel = form.querySelector('[data-field="priceCurrency"]');
  if (!price || !area) return;

  const host = price.closest('.field');
  const out = document.createElement('div');
  out.className = 'unit-price';
  host?.appendChild(out);

  const update = () => {
    const pv = Number(price.value);
    const av = Number(area.value);
    if (!Number.isFinite(pv) || !Number.isFinite(av) || pv <= 0 || av <= 0) {
      out.textContent = '';
      out.classList.remove('on');
      return;
    }
    const unit = unitSel?.value === 'square_foot' ? 'sq ft' : 'm²';
    const currency = currencySel?.value ?? '';
    const per = Math.round((pv / av) * 100) / 100;
    out.textContent = `${t('单价约')} ${per.toLocaleString('zh-CN')} ${currency}/${unit}`;
    out.classList.add('on');
  };

  for (const el of [price, area, unitSel, currencySel]) el?.addEventListener('input', update);
  for (const el of [unitSel, currencySel]) el?.addEventListener('change', update);
  update();
}

function renderBasic(body, meta) {
  const p = state.property ?? {
    title: '', description: '',
    addressLine: '', district: '', city: '', region: '', countryCode: '', postalCode: '',
    latitude: null, longitude: null,
    propertyType: '', bedrooms: null, bathrooms: null, areaValue: null, areaUnit: meta.areaUnit, floorNote: '',
    priceAmount: null, priceCurrency: meta.currency, pricePeriod: 'total',
    depositAmount: null, depositCurrency: meta.currency, extraFeesNote: '',
    availableFrom: null, status: 'draft', availabilityStatus: 'available',
  };

  // 单容器 + 紧凑网格。
  // 说明文字不再常驻显示，而是收进每个标签右上角的问号（tip），
  // 鼠标悬停或键盘聚焦即可看到 —— 这样字段能排得很密，不再占三四个表单的高度。
  body.innerHTML = `
    <form id="property-form" novalidate>
      <div class="lang-switch" id="lang-switch">
        <span class="muted small" data-i18n="正在填写">正在填写</span>
        ${LOCALES.map((l) => `<button type="button" data-lang="${esc(l.tag)}">${esc(l.label)}</button>`).join('')}
        <span class="muted small lang-note" id="lang-note"></span>
      </div>
      <div class="grid form compact">

        <h4 class="fgroup" data-i18n="基本信息">基本信息</h4>
        ${field({
          label: '标题', name: 'title', value: p.title, required: true, span: 2,
          tip: '显示在展示页最上方。建议写清地段与户型，例如「浦东世纪大道精装两居」',
        })}
        ${field({ label: '房源状态', name: 'status', value: p.status, options: meta.statuses,
          tip: '内部管理用：草稿不会出现在展示页上' })}
        ${field({ label: '可租状态', name: 'availabilityStatus', value: p.availabilityStatus ?? 'available',
          options: meta.availabilityStatuses,
          tip: '对外展示的标签。长时间不更新会自动变成「未确认」，提醒租客先跟你核实' })}
        ${field({ label: '房型', name: 'propertyType', value: p.propertyType,
          options: [{ value: '', label: '未指定' }, ...meta.propertyTypes] })}
        ${field({ label: '房源描述', name: 'description', value: p.description, type: 'textarea', span: 3, rows: 3,
          tip: '这里是「原文」。译文在「多语言」里单独维护，保存原文不会覆盖译文' })}

        <h4 class="fgroup" data-i18n="地址与位置">地址与位置</h4>
        ${comboField({ label: '国家/地区', name: 'countryDisplay', hiddenName: 'countryCode', value: p.countryCode,
          tip: '输入中文、英文或两位代码都能搜到，例如「中」「chi」「CN」' })}
        ${comboField({ label: '省/州', name: 'region', value: p.region,
          tip: '中国省份可直接搜索；国外地址可自由输入' })}
        ${comboField({ label: '城市', name: 'city', value: p.city })}
        ${comboField({ label: '区/县', name: 'district', value: p.district })}
        ${field({ label: '详细地址', name: 'addressLine', value: p.addressLine, span: 3,
          tip: '街道、门牌、楼栋房号。展示页会按「国家 省 城市 区 详细地址」的顺序拼接' })}

        <h4 class="fgroup" data-i18n="面积与房型">面积与房型</h4>
        ${field({ label: '面积', name: 'areaValue', value: p.areaValue ?? '',
          append: suffixSelect('areaUnit', p.areaUnit, meta.areaUnits) })}
        ${field({ label: '卧室', name: 'bedrooms', value: p.bedrooms ?? '' })}
        ${field({ label: '卫生间', name: 'bathrooms', value: p.bathrooms ?? '' })}
        ${field({ label: '楼层说明', name: 'floorNote', value: p.floorNote, span: 2,
          tip: '自由填写，如「15/28 层有电梯」或「两层 + 屋顶露台」' })}

        <h4 class="fgroup" data-i18n="价格与费用">价格与费用</h4>
        ${field({ label: '价格', name: 'priceAmount', value: p.priceAmount ?? '',
          append: suffixSelect('priceCurrency', p.priceCurrency, meta.currencies.map((c) => ({ value: c, label: c }))),
          tip: '填总价即可，单价会自动算出来给你看' })}
        ${field({ label: '计价周期', name: 'pricePeriod', value: p.pricePeriod, options: meta.pricePeriods })}
        ${field({ label: '押金', name: 'depositAmount', value: p.depositAmount ?? '',
          tip: '与价格使用同一种币种。留空表示不收押金' })}
        ${field({ label: '可入住日期', name: 'availableFrom', value: p.availableFrom ?? '', type: 'date' })}
        ${field({ label: '附加费用说明', name: 'extraFeesNote', value: p.extraFeesNote, type: 'textarea', span: 3, rows: 2,
          tip: '自由文本，不预设任何国家的收费规则。写清谁承担、怎么结算，能减少来回问' })}

        <!-- 经纬度绝大多数房东都不会用，默认收起来，不占版面。
             需要在地图上标位置时展开填写；留空则展示页不显示地图。 -->
        <details class="fgroup-optional"${p.latitude !== null || p.longitude !== null ? ' open' : ''}>
          <summary><span data-i18n="地图定位">地图定位</span><span class="hint"><span data-i18n="选填">选填</span> · <span data-i18n="${
            p.latitude !== null || p.longitude !== null ? '已填写' : '未填则不显示地图'
          }">${
            p.latitude !== null || p.longitude !== null ? '已填写' : '未填则不显示地图'
          }</span></span></summary>
          <div class="opt-body">
            <p class="fgrouphint">
              想让展示页显示地图时再填。在任意地图应用里长按你的房子，复制那两个数字即可。
            </p>
            <div class="grid form compact inner">
              ${field({ label: '纬度', name: 'latitude', value: p.latitude ?? '', tip: '例如 31.2304' })}
              ${field({ label: '经度', name: 'longitude', value: p.longitude ?? '', tip: '例如 121.4737' })}
            </div>
          </div>
        </details>

      </div>

      <div id="form-error"></div>

      <div class="formactions">
        <button type="submit" class="btn primary" data-i18n="${state.id === 'new' ? '创建房源' : '保存修改'}">${
          state.id === 'new' ? '创建房源' : '保存修改'
        }</button>
        <span class="muted small">${state.id === 'new' ? '保存后继续上传照片' : '保存后展示页立即同步'}</span>
      </div>
    </form>
  `;

  /** 把非原文语言的 buffer 写进译文表；空的不写，避免产生一堆空译文 */
  async function saveTranslations() {
    for (const [locale, vals] of Object.entries(lang.buffer)) {
      if (locale === origin.locale) continue;
      if (!vals.title.trim() && !vals.description.trim()) continue;
      await api.put(`/api/admin/properties/${state.id}/translations`, {
        locale,
        title: vals.title,
        description: vals.description,
      });
    }
  }

  const form = body.querySelector('#property-form');
  void wireAddress(form, p);
  wireUnitPrice(form);

  // ---- 语言切换 ----
  // 中文填「原文」（properties 表），其它语言填「译文」（property_translations 表）。
  // 切换时先把当前输入存进 buffer，再换成另一种语言的值，避免来回切丢字。
  const origin = state.translations?.origin ?? { locale: 'zh-CN', title: p.title, description: p.description };
  lang.buffer = { [origin.locale]: { title: p.title ?? '', description: p.description ?? '' } };
  for (const item of state.translations?.items ?? []) {
    lang.buffer[item.locale] = { title: item.title ?? '', description: item.description ?? '' };
  }
  // 数据语言跟随界面语言：界面已经是英文时，直接落在英文那一份上，
  // 否则会出现「界面英文、标题却是中文」的错位。
  const uiLocale = getLocale();
  lang.current = uiLocale !== origin.locale && lang.buffer[uiLocale] ? uiLocale : origin.locale;

  const titleInput = form.querySelector('[data-field="title"]');
  const descInput = form.querySelector('[data-field="description"]');
  const countryInputEl = form.querySelector('#f-countryDisplay');
  const countryHiddenEl = form.querySelector('[data-field="countryCode"]');
  const noteEl = form.querySelector('#lang-note');

  function stash() {
    if (titleInput && descInput) {
      lang.buffer[lang.current] = { title: titleInput.value, description: descInput.value };
    }
  }

  function paintLang() {
    for (const btn of form.querySelectorAll('#lang-switch button[data-lang]')) {
      btn.classList.toggle('on', btn.dataset.lang === lang.current);
    }
    const vals = lang.buffer[lang.current] ?? { title: '', description: '' };
    if (titleInput) titleInput.value = vals.title;
    if (descInput) descInput.value = vals.description;

    // 还没翻译这一语言时，把原文放进 placeholder。
    // 空白的标题框看上去像「数据丢了」，用原文做提示能让人知道该翻什么，
    // 同时**不会**把原文写进输入框 —— 保存逻辑只认原文那一份 buffer。
    const originVals = lang.buffer[origin.locale] ?? { title: '', description: '' };
    const untranslated = !isOriginLang() && !vals.title && !vals.description;
    if (titleInput) titleInput.placeholder = untranslated ? originVals.title : '';
    if (descInput) descInput.placeholder = untranslated ? originVals.description : '';

    // 国家名跟随语言：中文下「中国」，英文下「China」
    if (countryInputEl && countryHiddenEl?.value) {
      countryInputEl.value = countryLabel(countryHiddenEl.value);
    }

    if (noteEl) {
      noteEl.textContent = isOriginLang()
        ? t('原文 · 存于房源主记录')
        : `${t('译文')} · ${lang.current}`;
    }
  }

  /**
   * 切换语言 = 同时改两件事：
   *  1. 界面文字（标签、按钮、分组标题）由系统翻译；
   *  2. 标题与描述换成该语言那一份（用户自己登记的资料，不翻译）。
   * 选择记进 localStorage，下次进后台保持一致。
   */
  form.querySelector('#lang-switch')?.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-lang]');
    if (!btn) return;
    const next = btn.dataset.lang;
    // 必须同时比较**界面语言**和**数据语言**。
    // 只比数据语言会漏掉这种情况：界面停在德语、数据语言还是中文（新建时没有德语译文），
    // 此时点「中文」会被判定为「没变化」而直接返回，界面卡在德语。
    if (next === lang.current && next === getLocale()) return;
    stash();
    lang.current = next;
    setLocale(next);
    if (!lang.buffer[next]) lang.buffer[next] = { title: '', description: '' };
    try {
      localStorage.setItem('adminLocale', btn.dataset.lang);
    } catch {
      /* 隐私模式下忽略 */
    }
    paintLang();
    // 必须传 document 而不是 state.container ——
    // 侧边栏、顶部栏、手机底部标签栏都在视图容器之外，只更新容器它们不会变
    applyI18n(document);
  });

  paintLang();
  applyI18n(document);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // 先把当前语言输入框里的内容收进 buffer，否则切走那一份会丢
    stash();
    const values = readForm(form);
    // 押金不再单独选币种：与价格保持一致。表单里没有该字段时后端会沿用旧值，
    // 所以这里必须显式同步，否则改完价格币种后押金还是旧币种。
    if (values.priceCurrency) values.depositCurrency = values.priceCurrency;
    // 标题与描述永远提交「原文」那一份；译文单独走 translations 接口
    const originVals = lang.buffer[origin.locale] ?? { title: '', description: '' };
    values.title = originVals.title;
    values.description = originVals.description;
    const errorBox = form.querySelector('#form-error');
    errorBox.innerHTML = '';

    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;

    try {
      if (state.id === 'new') {
        const created = await api.post('/api/admin/properties', values);
        state.id = created.property.id;
        state.tab = 'basic';
        if (created.duplicateOf) {
          toast(`已创建。注意：与「${created.duplicateOf.title}」标题与城市相同，可能是重复录入。`, 'error');
        } else {
          toast('房源已创建');
        }
        await saveTranslations();
        window.location.hash = `#/properties/${state.id}`;
        await reload();
      } else {
        await api.patch(`/api/admin/properties/${state.id}`, values);
        await saveTranslations();
        toast('已保存');
        await reload();
      }
    } catch (error) {
      errorBox.innerHTML = errorBlock(error);
      applyFieldErrors(form, error?.issues);
      // 校验失败时把出错字段所在的分组展开，否则用户看不到提示
      const firstInvalid = form.querySelector('.field.invalid');
      if (firstInvalid) {
        const group = firstInvalid.closest('details');
        if (group) group.open = true;
        firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      toast(error?.message ?? '保存失败', 'error');
    } finally {
      submit.disabled = false;
    }
  });
}
// ---------------------------------------------------------------------------
// 照片与视频
// ---------------------------------------------------------------------------

function renderMedia(body) {
  const policy = state.uploadPolicy ?? {};
  const photos = state.media.filter((m) => m.kind === 'photo');
  const videos = state.media.filter((m) => m.kind !== 'photo');

  body.innerHTML = `
    <div class="card">
      <h3>上传照片</h3>
      <p class="muted small">
        支持 JPG / PNG / WebP / GIF，单张最大 ${esc(fmtBytes(policy.maxUploadBytes ?? 0))}；
        每个房源最多 ${esc(String(policy.maxPhotosPerProperty ?? ''))} 张。上传时会校验文件真实类型。
      </p>
      <form id="upload-form" class="row mt">
        <input type="file" id="upload-file" accept="image/*,video/mp4,video/webm,video/quicktime" required>
        <input type="text" id="upload-note" placeholder="素材来源/授权说明（选填）" class="input grow-220">
        <button class="btn primary" type="submit">上传</button>
      </form>
      <div id="upload-status" class="mt"></div>
    </div>

    <div class="card">
      <div class="spread">
        <h3>照片（${photos.length}）</h3>
        <span class="muted small">第一张自动成为封面；可调整顺序或指定封面。</span>
      </div>
      ${
        photos.length === 0
          ? '<p class="muted">尚未上传照片。</p>'
          : `<div class="media-grid">${photos.map(mediaCard).join('')}</div>`
      }
    </div>

    <div class="card">
      <h3>视频</h3>
      ${
        videos.length === 0
          ? '<p class="muted">暂无视频。</p>'
          : `<div class="media-grid">${videos.map(mediaCard).join('')}</div>`
      }
      <form id="link-form" class="row mt">
        <input type="url" id="link-url" placeholder="外部视频链接 https://…" required class="input grow-260">
        <input type="text" id="link-note" placeholder="素材来源说明（选填）" class="input grow-180">
        <button class="btn" type="submit">添加链接</button>
      </form>
    </div>
  `;

  body.querySelector('#upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const fileInput = body.querySelector('#upload-file');
    const file = fileInput.files?.[0];
    const status = body.querySelector('#upload-status');
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    const note = body.querySelector('#upload-note').value;
    if (note) formData.append('sourceNote', note);

    status.innerHTML = '<p class="muted">上传中…</p>';

    try {
      await api.upload(`/api/admin/properties/${state.id}/media`, formData);
      toast('上传成功');
      fileInput.value = '';
      body.querySelector('#upload-note').value = '';
      await reload();
    } catch (error) {
      status.innerHTML = errorBlock(error);
    }
  });

  body.querySelector('#link-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.post(`/api/admin/properties/${state.id}/media/link`, {
        url: body.querySelector('#link-url').value,
        sourceNote: body.querySelector('#link-note').value,
      });
      toast('已添加视频链接');
      await reload();
    } catch (error) {
      toast(error?.message ?? '添加失败', 'error');
    }
  });

  body.querySelector('.media-grid')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-media-action]');
    if (button) void handleMediaAction(button);
  });
}

function mediaCard(item) {
  const url = item.storageKey
    ? `/media/${item.storageKey.split('/').map(encodeURIComponent).join('/')}`
    : item.externalUrl ?? '';

  const preview =
    item.kind === 'photo'
      ? `<img src="${esc(url)}" alt="${esc(item.originalName)}" loading="lazy">`
      : `<div class="video-thumb">视频</div>`;

  return `<div class="media-item${item.isCover ? ' cover' : ''}">
    ${preview}
    <div class="meta">
      <div>${item.isCover ? '<strong class="accent">封面</strong> · ' : ''}${esc(fmtBytes(item.byteSize))}</div>
      <div class="mono" title="${esc(item.originalName)}">${esc((item.originalName || item.externalUrl || '').slice(0, 22))}</div>
      ${item.sourceNote ? `<div title="${esc(item.sourceNote)}">来源：${esc(item.sourceNote.slice(0, 16))}</div>` : ''}
      <div class="row gap-xs mt-xs">
        ${item.kind === 'photo' && !item.isCover ? `<button class="btn small" data-media-action="cover" data-id="${esc(item.id)}">设为封面</button>` : ''}
        <button class="btn small" data-media-action="note" data-id="${esc(item.id)}">来源</button>
        <button class="btn small danger" data-media-action="delete" data-id="${esc(item.id)}">删除</button>
      </div>
    </div>
  </div>`;
}

async function handleMediaAction(button) {
  const { mediaAction, id } = button.dataset;

  try {
    if (mediaAction === 'cover') {
      await api.post(`/api/admin/properties/${state.id}/media/cover`, { mediaId: id });
      toast('已设为封面');
    } else if (mediaAction === 'delete') {
      if (!confirmAction('确定删除该素材？文件会一并从磁盘移除。')) return;
      await api.del(`/api/admin/media/${id}`);
      toast('已删除');
    } else if (mediaAction === 'note') {
      const current = state.media.find((m) => m.id === id);
      const note = window.prompt('素材来源 / 授权说明（用于商用前的许可证核对）', current?.sourceNote ?? '');
      if (note === null) return;
      await api.patch(`/api/admin/media/${id}`, { sourceNote: note });
      toast('已更新来源说明');
    }
    await reload();
  } catch (error) {
    toast(error?.message ?? '操作失败', 'error');
  }
}

// ---------------------------------------------------------------------------
// 发布页面
// ---------------------------------------------------------------------------

function renderPublish(body) {
  const listing = state.listing;
  const readiness = state.readiness ?? { ready: false, blockers: [], warnings: [] };
  const url = state.hosting?.state?.publicUrl ?? '';

  body.innerHTML = `
    <div class="card">
      <div class="spread">
        <h3>发布状态</h3>
        ${listing ? tag(listing.status) : '<span class="muted">尚未创建</span>'}
      </div>

      ${
        readiness.blockers.length
          ? `<div class="alert error"><strong>发布前需要先完善：</strong><ul class="issues">${readiness.blockers
              .map((b) => `<li>${esc(b)}</li>`)
              .join('')}</ul></div>`
          : ''
      }
      ${
        readiness.warnings.length
          ? `<div class="alert warn"><strong>提示：</strong><ul class="issues">${readiness.warnings
              .map((w) => `<li>${esc(w)}</li>`)
              .join('')}</ul></div>`
          : ''
      }

      <div class="row mt">
        ${
          listing?.status === 'published'
            ? '<button class="btn" id="btn-withdraw">撤下页面</button>'
            : `<button class="btn primary" id="btn-publish"${readiness.ready ? '' : ' disabled'}>发布页面</button>`
        }
        <a class="btn" href="/api/admin/properties/${esc(state.id)}/preview" target="_blank" rel="noopener">预览效果</a>
        <span class="muted small">预览与发布后的页面完全同源；发布后页面才会被匿名访问，撤下后立即返回 404。</span>
      </div>
    </div>

    ${
      !listing
        ? ''
        : `
    <div class="card">
      <h3>分享链接与二维码</h3>
      <div class="split">
        <div>
          <p class="mono">${esc(url)}</p>
          <div class="row mt">
            <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">打开展示页</a>
            <button class="btn" id="btn-copy">复制链接</button>
            <a class="btn" href="/p/${encodeURIComponent(listing.slug)}/qr.svg" target="_blank" rel="noopener">打开二维码</a>
          </div>
          <p class="muted small mt">${esc(state.hosting?.state?.note ?? '')}</p>
        </div>
        <div class="qr-box" id="qr">${state.qrSvg ?? ''}</div>
      </div>
    </div>

    <div class="card">
      <h3>发布设置</h3>
      <form id="listing-form" novalidate>
        <div class="grid form">
          ${field({ label: '分享链接标识 (slug)', name: 'slug', value: listing.slug, hint: '只能包含字母、数字、汉字与连字符；留空则按标题重新生成' })}
          ${field({ label: '展示语言', name: 'locale', value: listing.locale,
            options: (state.translations?.pageLocales ?? state.translations?.supportedLocales ?? []).map((l) => ({ value: l.tag, label: l.label })),
            tip: '展示页界面文字用哪种语言。房东自己填的标题、描述、地址不受影响，永远按登记的原样显示' })}
          ${field({ label: '展示模板', name: 'templateId', value: listing.templateId, options: (state.templates ?? []).map((t) => ({ value: t.id, label: t.name })) })}
        </div>
        <div class="formactions"><button class="btn primary" type="submit">保存发布设置</button></div>
      </form>
    </div>

    <div class="card">
      <h3>静态 HTML 导出</h3>
      <p class="muted small">
        导出包内含 index.html、assets/ 图片与说明文件，可直接双击打开或部署到任意静态空间。
        离线环境下在线地图无法加载，页面会自动降级为地址文本，二维码已内联为 SVG。
      </p>
      <div class="row mt">
        <a class="btn primary" href="/api/admin/properties/${esc(state.id)}/export.zip">下载 ZIP</a>
        <button class="btn" id="btn-export-dir">导出到服务器目录</button>
        <a class="btn" href="/api/admin/properties/${esc(state.id)}/export-preview" target="_blank" rel="noopener">预览导出页面</a>
      </div>
      <div id="export-status" class="mt"></div>
    </div>
    `
    }
  `;

  body.querySelector('#btn-publish')?.addEventListener('click', async () => {
    try {
      const result = await api.post(`/api/admin/properties/${state.id}/publish`);
      toast(`已发布：${result.publicUrl}`);
      await reload();
    } catch (error) {
      toast(error?.message ?? '发布失败', 'error');
    }
  });

  body.querySelector('#btn-withdraw')?.addEventListener('click', async () => {
    try {
      await api.post(`/api/admin/properties/${state.id}/withdraw`);
      toast('已撤下，公开访问将返回 404');
      await reload();
    } catch (error) {
      toast(error?.message ?? '撤下失败', 'error');
    }
  });

  body.querySelector('#btn-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('链接已复制');
    } catch {
      toast('复制失败，请手动选择链接复制', 'error');
    }
  });

  body.querySelector('#listing-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = readForm(event.target);
    try {
      await api.patch(`/api/admin/properties/${state.id}/listing`, values);
      toast('发布设置已保存');
      await reload();
    } catch (error) {
      toast(error?.message ?? '保存失败', 'error');
    }
  });

  body.querySelector('#btn-export-dir')?.addEventListener('click', async () => {
    const box = body.querySelector('#export-status');
    box.innerHTML = '<p class="muted">导出中…</p>';
    try {
      const result = await api.post(`/api/admin/properties/${state.id}/export`);
      box.innerHTML = `<div class="alert ok">已导出 ${result.files.length} 个文件到：<br><span class="mono">${esc(result.entry)}</span></div>`;
    } catch (error) {
      box.innerHTML = errorBlock(error);
    }
  });
}

// ---------------------------------------------------------------------------
// 多语言
// ---------------------------------------------------------------------------

function renderI18n(body) {
  const data = state.translations;
  if (!data) {
    body.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
    return;
  }

  const existing = new Map(data.items.map((t) => [t.locale, t]));
  const candidates = data.supportedLocales.filter((l) => l.tag !== data.origin.locale);

  body.innerHTML = `
    <div class="card">
      <h3>原文（${esc(data.origin.locale)}）</h3>
      <p class="muted small">原文保存在房源主记录中，译文单独保存，切换语言不会覆盖这里的文字。</p>
      <p><strong>${esc(data.origin.title)}</strong></p>
      <p class="muted pre-wrap">${esc(data.origin.description || '（无描述）')}</p>
    </div>

    <div class="card">
      <h3>已有译文（${data.items.length}）</h3>
      ${
        data.items.length === 0
          ? '<p class="muted">尚未添加任何译文。</p>'
          : `<table class="list-table"><thead><tr><th>语言</th><th>标题</th><th>更新时间</th><th></th></tr></thead><tbody>
              ${data.items
                .map(
                  (t) => `<tr>
                    <td data-label="语言">${esc(t.locale)}</td>
                    <td data-label="标题">${esc(t.title)}</td>
                    <td data-label="更新时间" class="muted small">${esc(fmtDateTime(t.updatedAt))}</td>
                    <td class="actions">
                      <button class="btn small" data-edit-locale="${esc(t.locale)}">编辑</button>
                      <button class="btn small danger" data-del-locale="${esc(t.locale)}">删除</button>
                    </td>
                  </tr>`,
                )
                .join('')}
            </tbody></table>`
      }
    </div>

    <div class="card">
      <h3>添加 / 更新译文</h3>
      <form id="translation-form" novalidate>
        <div class="grid form">
          ${field({
            label: '语言',
            name: 'locale',
            value: '',
            options: [{ value: '', label: '请选择语言' }, ...candidates.map((l) => ({ value: l.tag, label: `${l.label} (${l.tag})` }))],
          })}
        </div>
        ${field({ label: '译文标题', name: 'title', value: '', required: true })}
        ${field({ label: '译文描述', name: 'description', value: '', type: 'textarea' })}
        <div id="translation-error"></div>
        <div class="formactions"><button class="btn primary" type="submit">保存译文</button></div>
      </form>
    </div>
  `;

  const form = body.querySelector('#translation-form');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = readForm(form);
    const errorBox = form.querySelector('#translation-error');
    errorBox.innerHTML = '';

    try {
      await api.put(`/api/admin/properties/${state.id}/translations`, values);
      toast('译文已保存');
      await reload();
    } catch (error) {
      errorBox.innerHTML = errorBlock(error);
      applyFieldErrors(form, error?.issues);
    }
  });

  body.addEventListener('click', async (event) => {
    const editButton = event.target.closest('button[data-edit-locale]');
    if (editButton) {
      const locale = editButton.dataset.editLocale;
      const record = existing.get(locale);
      form.querySelector('[data-field=locale]').value = locale;
      form.querySelector('[data-field=title]').value = record?.title ?? '';
      form.querySelector('[data-field=description]').value = record?.description ?? '';
      form.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const delButton = event.target.closest('button[data-del-locale]');
    if (delButton) {
      const locale = delButton.dataset.delLocale;
      if (!confirmAction(`确定删除 ${locale} 的译文？原文不会受影响。`)) return;
      try {
        await api.del(`/api/admin/properties/${state.id}/translations/${encodeURIComponent(locale)}`);
        toast('译文已删除');
        await reload();
      } catch (error) {
        toast(error?.message ?? '删除失败', 'error');
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 自定义域名
// ---------------------------------------------------------------------------

function renderDomain(body) {
  const hosting = state.hosting;
  const h = hosting?.state;

  body.innerHTML = `
    <div class="card">
      <h3>托管方式</h3>
      <p>当前适配器：<span class="mono">${esc(h?.provider ?? '-')}</span></p>
      ${
        h?.allowsCustomDomain
          ? '<p class="muted small">已启用自定义域名绑定。域名必须通过 DNS TXT 记录完成所有权验证后才会生效。</p>'
          : `<div class="alert warn">当前托管模式为「平台默认地址」，未启用自定义域名。
              如需绑定自己的域名，请设置环境变量 <span class="mono">HOSTING_PROVIDER=custom_domain</span> 与
              <span class="mono">HOSTING_CNAME_TARGET</span> 后重启服务。</div>`
      }
      <p>当前公开地址：<span class="mono">${esc(h?.publicUrl ?? '')}</span></p>
      ${h?.note ? `<p class="muted small">${esc(h.note)}</p>` : ''}
    </div>

    ${
      h?.allowsCustomDomain
        ? `
    <div class="card">
      <h3>绑定自定义域名</h3>
      <form id="domain-form" class="row" novalidate>
        <input type="text" id="domain-input" placeholder="例如 listings.example.com" value="${esc(h.customDomain ?? '')}" class="input grow-260">
        <button class="btn" type="submit">绑定</button>
        ${
          h.customDomain
            ? '<button class="btn" type="button" id="btn-verify">验证域名</button><button class="btn danger" type="button" id="btn-unbind">解绑</button>'
            : ''
        }
      </form>
      <div id="domain-status" class="mt">
        ${
          h.customDomain
            ? h.domainVerifiedAt
              ? `<div class="alert ok">域名 ${esc(h.customDomain)} 已于 ${esc(fmtDateTime(h.domainVerifiedAt))} 通过验证。</div>`
              : `<div class="alert warn">域名 ${esc(h.customDomain)} 尚未通过验证，展示页仍使用平台默认地址。请按下方指引添加 TXT 记录后点击「验证域名」。</div>`
            : ''
        }
      </div>
      ${
        h.verifyToken
          ? `<details class="mt"><summary>DNS 验证指引</summary>
              <p class="mt">请添加一条 TXT 记录：</p>
              <pre class="code">主机记录：@
记录类型：TXT
记录值：${esc(hosting.verifyPrefix)}=${esc(h.verifyToken)}</pre>
              <p class="muted small">保存后等待 DNS 生效（通常几分钟到几小时），再点击「验证域名」。</p>
            </details>`
          : ''
      }
    </div>`
        : ''
    }
  `;

  body.querySelector('#domain-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const domain = body.querySelector('#domain-input').value;
    try {
      const result = await api.post(`/api/admin/properties/${state.id}/hosting/domain`, { domain });
      body.querySelector('#domain-status').innerHTML = `<div class="alert ok">已绑定 ${esc(
        result.page.customDomain,
      )}。${esc(result.instructions.steps[1])}</div>`;
      toast('域名已绑定，等待验证');
      await reload();
    } catch (error) {
      body.querySelector('#domain-status').innerHTML = errorBlock(error);
    }
  });

  body.querySelector('#btn-verify')?.addEventListener('click', async () => {
    const box = body.querySelector('#domain-status');
    box.innerHTML = '<p class="muted">正在查询 DNS…</p>';
    try {
      const result = await api.post(`/api/admin/properties/${state.id}/hosting/verify`);
      box.innerHTML = result.verified
        ? `<div class="alert ok">${esc(result.detail)}<br>公开地址：<span class="mono">${esc(result.publicUrl)}</span></div>`
        : `<div class="alert warn">${esc(result.detail)}</div>`;
      await reload();
    } catch (error) {
      box.innerHTML = errorBlock(error);
    }
  });

  body.querySelector('#btn-unbind')?.addEventListener('click', async () => {
    if (!confirmAction('确定解绑该域名？')) return;
    try {
      await api.del(`/api/admin/properties/${state.id}/hosting/domain`);
      toast('已解绑');
      await reload();
    } catch (error) {
      toast(error?.message ?? '解绑失败', 'error');
    }
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function render(container, params) {
  state.container = container;
  state.id = params.id;
  state.tab = 'basic';
  state.error = null;

  try {
    state.meta = await api.get('/api/admin/meta');
  } catch (error) {
    container.innerHTML = errorBlock(error);
    return;
  }

  try {
    state.uploadPolicy = await api.get('/api/admin/upload-policy');
  } catch {
    state.uploadPolicy = {};
  }

  if (state.id !== 'new') {
    try {
      const listing = await api.get(`/api/admin/properties/${state.id}/listing`);
      state.qrSvg = listing.qrSvg;
      state.templates = listing.templates;
    } catch {
      state.qrSvg = '';
      state.templates = [];
    }
  }

  await reload();
}