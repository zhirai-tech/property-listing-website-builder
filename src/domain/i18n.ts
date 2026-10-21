/**
 * 多语言与国际化（方案第三章第 7 条、第 5 阶段验收）。
 *
 * 验收要点：
 *  - 切换语言不能丢失数据；
 *  - 原始描述不被翻译覆盖 —— 因此译文存在独立的表中，本模块只做「读取选择」；
 *  - 货币/日期/面积单位格式按配置正确显示。
 */

import type { AreaUnit, PricePeriod, PropertyTranslation } from './types.ts';

export interface SupportedLocale {
  tag: string;
  label: string;
}

/** 界面可选语言（可继续扩展，不影响数据结构） */
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = [
  { tag: 'zh-CN', label: '简体中文' },
  { tag: 'zh-TW', label: '繁體中文' },
  { tag: 'en', label: 'English' },
  { tag: 'ja', label: '日本語' },
  { tag: 'ko', label: '한국어' },
  { tag: 'es', label: 'Español' },
  { tag: 'fr', label: 'Français' },
  { tag: 'de', label: 'Deutsch' },
  { tag: 'ru', label: 'Русский' },
  { tag: 'ar', label: 'العربية' },
  { tag: 'th', label: 'ไทย' },
  { tag: 'vi', label: 'Tiếng Việt' },
];

/**
 * 展示页**当前对外开放**的语言。
 *
 * SUPPORTED_LOCALES 是数据结构与格式化能处理的全部语言；
 * 这个列表是界面文案**真正翻好了**的语言。
 *
 * 之所以分开：其它语言的界面文案尚未翻译，uiCatalog 会回落到英文 ——
 * 法语房东选了「Français」却看到英文界面，比不提供这个选项更糟。
 * 后续翻译做好了，往这里加一条即可，不用改调用方。
 */
export const PUBLIC_PAGE_LOCALES: readonly SupportedLocale[] = SUPPORTED_LOCALES.filter((l) =>
  ['zh-CN', 'en'].includes(l.tag),
);

export function isSupportedLocale(tag: string): boolean {
  return SUPPORTED_LOCALES.some((l) => l.tag.toLowerCase() === tag.toLowerCase());
}

/** 常用货币，仅用于后台下拉建议；数据层不限制任何 ISO 4217 代码 */
export const COMMON_CURRENCIES = [
  'CNY',
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'KRW',
  'HKD',
  'TWD',
  'SGD',
  'AUD',
  'CAD',
  'THB',
  'VND',
  'AED',
] as const;

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/** 金额格式化；非法币种代码时降级为「金额 + 代码」，绝不抛错 */
export function formatMoney(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${new Intl.NumberFormat(locale).format(amount)} ${currency}`;
  }
}

const AREA_LABELS: Record<AreaUnit, Record<string, string>> = {
  square_meter: { 'zh-CN': '平方米', 'zh-TW': '平方公尺', en: 'm²', ja: '㎡', ko: '㎡' },
  square_foot: { 'zh-CN': '平方英尺', 'zh-TW': '平方英尺', en: 'sq ft', ja: 'sq ft', ko: 'sq ft' },
};

export function areaUnitLabel(unit: AreaUnit, locale: string): string {
  const table = AREA_LABELS[unit];
  return table[locale] ?? table[locale.split('-')[0] ?? ''] ?? table['en'] ?? unit;
}

export function formatArea(value: number, unit: AreaUnit, locale: string): string {
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  return `${num} ${areaUnitLabel(unit, locale)}`;
}

const PERIOD_LABELS: Record<PricePeriod, Record<string, string>> = {
  total: { 'zh-CN': '总价', en: 'total', ja: '総額', ko: '총액' },
  per_month: { 'zh-CN': '每月', en: 'per month', ja: '月額', ko: '월' },
  per_week: { 'zh-CN': '每周', en: 'per week', ja: '週額', ko: '주' },
  per_night: { 'zh-CN': '每晚', en: 'per night', ja: '1泊', ko: '1박' },
  per_year: { 'zh-CN': '每年', en: 'per year', ja: '年額', ko: '연' },
};

export function pricePeriodLabel(period: PricePeriod, locale: string): string {
  const table = PERIOD_LABELS[period];
  return table[locale] ?? table[locale.split('-')[0] ?? ''] ?? table['en'] ?? period;
}

/** 组合价格：金额 + 币种 + 周期，例如「¥5,000 / 每月」 */
export function formatPrice(
  amount: number,
  currency: string,
  period: PricePeriod,
  locale: string,
): string {
  const money = formatMoney(amount, currency, locale);
  if (period === 'total') return money;
  return `${money} / ${pricePeriodLabel(period, locale)}`;
}

/** 仅日期（不含时间），按目标时区渲染 */
export function formatDateOnly(iso: string, locale: string, timeZone: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    dateStyle: 'long',
  }).format(date);
}

// ---------------------------------------------------------------------------
// 译文选择（原文与译文分离，切换语言不覆盖原文）
// ---------------------------------------------------------------------------

export interface LocalizedText {
  title: string;
  description: string;
  /** 实际使用的语言 */
  usedLocale: string;
  /** 是否命中了译文；false 表示回退到原文 */
  translated: boolean;
}

/**
 * 依据请求语言选择文案。
 * 找不到译文时回退原文，并且永远不修改原文本身。
 */
export function resolveLocalizedText(
  original: { title: string; description: string },
  translations: readonly PropertyTranslation[],
  requestedLocale: string,
): LocalizedText {
  const exact = translations.find(
    (t) => t.locale.toLowerCase() === requestedLocale.toLowerCase(),
  );
  if (exact && exact.title.trim() !== '') {
    return {
      title: exact.title,
      description: exact.description,
      usedLocale: exact.locale,
      translated: true,
    };
  }

  // 语言族回退：zh-CN 请求可命中 zh
  const base = requestedLocale.split('-')[0]?.toLowerCase() ?? '';
  const family = translations.find(
    (t) => t.locale.split('-')[0]?.toLowerCase() === base && t.title.trim() !== '',
  );
  if (family) {
    return {
      title: family.title,
      description: family.description,
      usedLocale: family.locale,
      translated: true,
    };
  }

  return {
    title: original.title,
    description: original.description,
    usedLocale: '',
    translated: false,
  };
}

/** 后台展示：某个房源已有哪些译文 */
export function availableLocales(
  translations: readonly PropertyTranslation[],
  originLocale: string,
): string[] {
  const set = new Set<string>();
  if (originLocale) set.add(originLocale);
  for (const t of translations) set.add(t.locale);
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// 界面文案（多语言界面，对应方案第 5 阶段「支持多语言界面」）
// ---------------------------------------------------------------------------

export type UiKey =
  | 'langSwitch' | 'about' | 'video' | 'watchExternal' | 'priceFees' | 'price' | 'deposit'
  | 'billingPeriod' | 'extraFees' | 'location' | 'coordinates' | 'nearby' | 'nearbyHint'
  | 'viewNearby' | 'nearbyEmpty' | 'nearbySource' | 'contact' | 'noPublicContact'
  | 'contactPrivacy' | 'share' | 'shareHint' | 'priceOnRequest' | 'noAddress' | 'noPhotos'
  | 'type' | 'bedrooms' | 'bathrooms' | 'area' | 'floor' | 'availableFrom'
  | 'translationNotice' | 'footerGenerated' | 'footerDisclaimer' | 'coverPhoto' | 'photoN'
  | 'mapNoCoordinates' | 'mapDisabled' | 'mapOffline' | 'mapLoading' | 'mapFailed'
  | 'mapFreeTier' | 'catTransport' | 'catShop' | 'catSchool' | 'catHospital' | 'catPark' | 'catOther'
  | 'contactPhone' | 'contactEmail' | 'contactChat' | 'contactWechat' | 'contactWhatsapp'
  | 'contactTelegram' | 'contactOther' | 'typeApartment' | 'typeHouse' | 'typeRoom' | 'typeStudio'
  | 'call' | 'shareAction' | 'mapAction' | 'openInMap' | 'zoomIn' | 'zoomOut'
  | 'photosCount' | 'galleryLabel' | 'copied' | 'aboutHint' | 'contactHint'
  | 'stAvailable' | 'stRented' | 'stUnconfirmed' | 'stUnconfirmedNote' | 'menu' | 'menuHome' | 'menuCall' | 'menuShare' | 'menuMap'
  | 'brandPowered' | 'brandSlogan' | 'brandRights'
  | 'typeTownhouse' | 'typeOffice' | 'typeShop' | 'typeLand' | 'typeOther';

type UiCatalog = Record<UiKey, string>;

const ZH_CN: UiCatalog = {
  langSwitch: '语言切换',
  call: '打电话',
  shareAction: '分享',
  mapAction: '地图',
  openInMap: '在地图中打开',
  zoomIn: '放大',
  zoomOut: '缩小',
  photosCount: '{n} 张照片',
  galleryLabel: '房源照片',
  copied: '链接已复制',
  aboutHint: '点击展开',
  contactHint: '联系方式',
  stAvailable: '出租中',
  stRented: '已租',
  stUnconfirmed: '未确认',
  stUnconfirmedNote: '房东已 {days} 天未更新房源信息，当前状态待确认，请联系房东核实。',
  menu: '页面菜单',
  menuHome: '房源',
  menuCall: '电话',
  menuShare: '分享',
  menuMap: '地图',
  brandPowered: 'Powered by 智睿',
  brandSlogan: '把想法变成现实',
  brandRights: '© 2026 智睿科技 保留所有权利。',
  about: '房源介绍',
  video: '视频',
  watchExternal: '观看视频（外部链接）',
  priceFees: '价格与费用',
  price: '价格',
  deposit: '押金',
  billingPeriod: '计价方式',
  extraFees: '附加费用',
  location: '位置',
  coordinates: '经纬度',
  nearby: '周边信息',
  nearbyHint: '周边交通、商店、学校等信息按需查询，不在打开页面时自动请求。',
  viewNearby: '查看周边信息',
  nearbyEmpty: '该位置附近未查询到已登记的周边设施。',
  nearbySource: '数据来源：{source}，仅供参考，请以实地情况为准。',
  contact: '联系方式',
  noPublicContact: '房源所有者未公开联系方式。',
  contactPrivacy: '联系方式由房源所有者自行选择是否公开，平台不代用户发布未授权信息。',
  share: '分享这个房源',
  shareHint: '复制上面的链接即可分享；二维码可用手机扫码打开。',
  priceOnRequest: '价格面议',
  noAddress: '未填写地址',
  noPhotos: '暂无照片',
  type: '房型',
  bedrooms: '卧室',
  bathrooms: '卫生间',
  area: '面积',
  floor: '楼层',
  availableFrom: '可入住',
  translationNotice: '当前显示 {locale} 译文；原始描述始终保留在后台，未被覆盖。',
  footerGenerated: '本页面由「轻量化房源管理与一键房源网站生成平台」生成 · {time}',
  footerDisclaimer: '页面内容由房源所有者提供；如信息有误或需撤下，请联系发布者。',
  coverPhoto: '{title} 封面照片',
  photoN: '{title} 照片 {n}',
  mapNoCoordinates: '未填写经纬度，无法在地图上定位。',
  mapDisabled: '地图服务已通过配置关闭，仅显示地址文本。',
  mapOffline: '当前未加载在线地图（离线导出或未注入脚本），可复制上方经纬度到任意地图应用查看。',
  mapLoading: '正在加载地图…若长时间无法加载，说明地图服务不可用，上方地址仍然有效。',
  mapFailed: '地图组件未能加载（可能处于离线环境或脚本被拦截），上方地址信息不受影响。',
  mapFreeTier: '地图服务说明：{note}',
  catTransport: '交通', catShop: '购物', catSchool: '学校', catHospital: '医疗', catPark: '休闲', catOther: '其他',
  contactPhone: '电话', contactEmail: '邮箱', contactChat: '在线咨询', contactWechat: '微信',
  contactWhatsapp: 'WhatsApp', contactTelegram: 'Telegram', contactOther: '联系方式',
  typeApartment: '公寓', typeHouse: '独立住宅', typeRoom: '单间', typeStudio: '开间',
  typeTownhouse: '联排', typeOffice: '办公', typeShop: '商铺', typeLand: '土地', typeOther: '其他',
};

const ZH_TW: UiCatalog = {
  ...ZH_CN,
  langSwitch: '語言切換',
  call: '打電話',
  shareAction: '分享',
  mapAction: '地圖',
  openInMap: '在地圖中開啟',
  zoomIn: '放大',
  zoomOut: '縮小',
  photosCount: '{n} 張照片',
  galleryLabel: '房源照片',
  copied: '連結已複製',
  aboutHint: '點擊展開',
  contactHint: '聯絡方式',
  stAvailable: '出租中',
  stRented: '已租',
  stUnconfirmed: '未確認',
  stUnconfirmedNote: '房東已 {days} 天未更新房源資訊，目前狀態待確認，請聯絡房東核實。',
  menu: '頁面選單',
  menuHome: '房源',
  menuCall: '電話',
  menuShare: '分享',
  menuMap: '地圖',
  brandPowered: 'Powered by 智睿',
  brandSlogan: '把想法變成現實',
  brandRights: '© 2026 智睿科技 保留所有權利。',
  about: '房源介紹',
  priceFees: '價格與費用',
  price: '價格',
  deposit: '押金',
  billingPeriod: '計價方式',
  extraFees: '附加費用',
  location: '位置',
  coordinates: '經緯度',
  nearby: '周邊資訊',
  nearbyHint: '周邊交通、商店、學校等資訊按需查詢，不在開啟頁面時自動請求。',
  viewNearby: '查看周邊資訊',
  contact: '聯絡方式',
  noPublicContact: '房源所有者未公開聯絡方式。',
  share: '分享這個房源',
  priceOnRequest: '價格面議',
  noAddress: '未填寫地址',
  noPhotos: '暫無照片',
  bedrooms: '臥室', bathrooms: '衛浴', area: '面積', floor: '樓層', availableFrom: '可入住',
  footerDisclaimer: '頁面內容由房源所有者提供；如資訊有誤或需撤下，請聯絡發布者。',
  mapNoCoordinates: '未填寫經緯度，無法在地圖上定位。',
};

const EN: UiCatalog = {
  langSwitch: 'Language',
  call: 'Call',
  shareAction: 'Share',
  mapAction: 'Map',
  openInMap: 'Open in map',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  photosCount: '{n} photos',
  galleryLabel: 'Property photos',
  copied: 'Link copied',
  aboutHint: 'Tap to expand',
  contactHint: 'Contact',
  stAvailable: 'Available',
  stRented: 'Rented out',
  stUnconfirmed: 'Unconfirmed',
  stUnconfirmedNote: 'The owner has not updated this listing for {days} days, so its status is unconfirmed — please verify with the owner.',
  menu: 'Page menu',
  menuHome: 'Listing',
  menuCall: 'Call',
  menuShare: 'Share',
  menuMap: 'Map',
  brandPowered: 'Powered by ZHIRAI',
  brandSlogan: 'Build Ideas Into Reality',
  brandRights: '© 2026 ZHIRAI. All Rights Reserved.',
  about: 'About this property',
  video: 'Video',
  watchExternal: 'Watch video (external link)',
  priceFees: 'Price & fees',
  price: 'Price',
  deposit: 'Deposit',
  billingPeriod: 'Billing period',
  extraFees: 'Additional fees',
  location: 'Location',
  coordinates: 'Coordinates',
  nearby: 'Nearby',
  nearbyHint: 'Transport, shops and schools are looked up on demand — not requested automatically when the page opens.',
  viewNearby: 'View nearby places',
  nearbyEmpty: 'No registered places of interest were found near this location.',
  nearbySource: 'Source: {source}. For reference only — please verify on site.',
  contact: 'Contact',
  noPublicContact: 'The owner has not published any contact details.',
  contactPrivacy: 'Contact details are published only with the owner’s consent; the platform never discloses unauthorised information.',
  share: 'Share this listing',
  shareHint: 'Copy the link above to share it, or scan the QR code with a phone.',
  priceOnRequest: 'Price on request',
  noAddress: 'Address not provided',
  noPhotos: 'No photos yet',
  type: 'Type',
  bedrooms: 'Bedrooms',
  bathrooms: 'Bathrooms',
  area: 'Area',
  floor: 'Floor',
  availableFrom: 'Available from',
  translationNotice: 'Showing the {locale} translation. The original description is always preserved in the back office and never overwritten.',
  footerGenerated: 'Generated by the Lightweight Property Listing Platform · {time}',
  footerDisclaimer: 'Content is provided by the property owner. Contact the publisher if anything is inaccurate or needs to be taken down.',
  coverPhoto: '{title} cover photo',
  photoN: '{title} photo {n}',
  mapNoCoordinates: 'No coordinates provided, so the property cannot be mapped.',
  mapDisabled: 'The map service is disabled by configuration; only the address text is shown.',
  mapOffline: 'The online map is not loaded (offline export or script not injected). Copy the coordinates above into any map app.',
  mapLoading: 'Loading map… If it does not load, the map service is unavailable — the address above is still valid.',
  mapFailed: 'The map component could not be loaded (offline environment or blocked script). The address above is unaffected.',
  mapFreeTier: 'Map service note: {note}',
  catTransport: 'Transport', catShop: 'Shops', catSchool: 'Schools', catHospital: 'Healthcare',
  catPark: 'Leisure', catOther: 'Other',
  contactPhone: 'Phone', contactEmail: 'Email', contactChat: 'Live chat', contactWechat: 'WeChat',
  contactWhatsapp: 'WhatsApp', contactTelegram: 'Telegram', contactOther: 'Contact',
  typeApartment: 'Apartment', typeHouse: 'House', typeRoom: 'Room', typeStudio: 'Studio',
  typeTownhouse: 'Townhouse', typeOffice: 'Office', typeShop: 'Retail', typeLand: 'Land', typeOther: 'Other',
};

const JA: UiCatalog = {
  ...EN,
  langSwitch: '言語',
  call: '電話',
  shareAction: '共有',
  mapAction: '地図',
  openInMap: '地図で開く',
  zoomIn: '拡大',
  zoomOut: '縮小',
  photosCount: '写真 {n} 枚',
  galleryLabel: '物件写真',
  copied: 'リンクをコピーしました',
  aboutHint: 'タップで展開',
  contactHint: 'お問い合わせ',
  stAvailable: '募集中',
  stRented: '成約済み',
  stUnconfirmed: '未確認',
  stUnconfirmedNote: 'オーナーが {days} 日間情報を更新していないため、状況は未確認です。オーナーにご確認ください。',
  menu: 'ページメニュー',
  menuHome: '物件',
  menuCall: '電話',
  menuShare: '共有',
  menuMap: '地図',
  brandPowered: 'Powered by ZHIRAI',
  brandSlogan: 'Build Ideas Into Reality',
  brandRights: '© 2026 ZHIRAI. All Rights Reserved.',
  about: '物件について',
  video: '動画',
  watchExternal: '動画を見る（外部リンク）',
  priceFees: '価格と費用',
  price: '価格',
  deposit: '敷金',
  billingPeriod: '支払サイクル',
  extraFees: 'その他費用',
  location: '所在地',
  coordinates: '緯度経度',
  nearby: '周辺情報',
  nearbyHint: '交通・店舗・学校などの情報は必要時にのみ取得します。ページを開いただけでは外部サービスへ問い合わせません。',
  viewNearby: '周辺情報を見る',
  contact: 'お問い合わせ',
  noPublicContact: 'オーナーは連絡先を公開していません。',
  share: 'この物件を共有',
  shareHint: '上のリンクをコピーして共有できます。QR コードはスマートフォンで読み取れます。',
  priceOnRequest: '価格は応相談',
  noAddress: '住所未入力',
  noPhotos: '写真はまだありません',
  type: '間取り種別',
  bedrooms: '寝室',
  bathrooms: '浴室',
  area: '面積',
  floor: '階',
  availableFrom: '入居可能',
  footerDisclaimer: '掲載内容はオーナーが提供したものです。誤りや掲載停止のご要望は掲載者までご連絡ください。',
  catTransport: '交通', catShop: '買い物', catSchool: '学校', catHospital: '医療', catPark: 'レジャー', catOther: 'その他',
  typeApartment: 'マンション', typeHouse: '一戸建て', typeRoom: '個室', typeStudio: 'ワンルーム',
  typeTownhouse: 'タウンハウス', typeOffice: 'オフィス', typeShop: '店舗', typeLand: '土地', typeOther: 'その他',
};

const UI_CATALOGS: Record<string, UiCatalog> = {
  'zh-CN': ZH_CN,
  'zh-TW': ZH_TW,
  en: EN,
  ja: JA,
};

/** 依次尝试：精确语言 -> 语言族 -> 英文 -> 中文 */
export function uiCatalog(locale: string): UiCatalog {
  const exact = UI_CATALOGS[locale];
  if (exact) return exact;

  const base = locale.split('-')[0]?.toLowerCase() ?? '';
  const familyKey = Object.keys(UI_CATALOGS).find((key) => key.split('-')[0] === base);
  if (familyKey) return UI_CATALOGS[familyKey] as UiCatalog;

  return EN;
}

/** 取界面文案并做 {var} 占位替换 */
export function t(locale: string, key: UiKey, vars?: Record<string, string | number>): string {
  const template = uiCatalog(locale)[key] ?? ZH_CN[key] ?? key;
  if (!vars) return template;

  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : `{${name}}`,
  );
}

const PROPERTY_TYPE_KEYS: Record<string, UiKey> = {
  apartment: 'typeApartment',
  house: 'typeHouse',
  room: 'typeRoom',
  studio: 'typeStudio',
  townhouse: 'typeTownhouse',
  office: 'typeOffice',
  shop: 'typeShop',
  land: 'typeLand',
  other: 'typeOther',
};

/** 房型显示名：已知字典值翻译，未知值原样显示（字段本身是可配置的） */
export function propertyTypeLabel(value: string, locale: string): string {
  const key = PROPERTY_TYPE_KEYS[value.toLowerCase()];
  return key ? t(locale, key) : value;
}

const CHANNEL_KEYS: Record<string, UiKey> = {
  phone: 'contactPhone',
  email: 'contactEmail',
  chat: 'contactChat',
  wechat: 'contactWechat',
  whatsapp: 'contactWhatsapp',
  telegram: 'contactTelegram',
  other: 'contactOther',
};

export function contactChannelLabel(kind: string, locale: string): string {
  const key = CHANNEL_KEYS[kind];
  return key ? t(locale, key) : t(locale, 'contactOther');
}

const CATEGORY_KEYS: Record<string, UiKey> = {
  transport: 'catTransport',
  shop: 'catShop',
  school: 'catSchool',
  hospital: 'catHospital',
  park: 'catPark',
  other: 'catOther',
};

export function nearbyCategoryLabel(category: string, locale: string): string {
  const key = CATEGORY_KEYS[category];
  return key ? t(locale, key) : t(locale, 'catOther');
}