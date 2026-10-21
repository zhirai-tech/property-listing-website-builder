/**
 * 领域模型类型定义（对应方案第四章「建议的核心数据结构」）。
 *
 * 设计约束：
 *  1. 所有展示页与导出内容都从这些结构生成，不允许各模块维护互不一致的副本。
 *  2. 面向国内外通用场景 —— 价格、面积、日期、地址一律带显式单位/币种/时区字段，
 *     绝不把某一国家的规则写死（方案基本原则上第 4 条）。
 *  3. 本文件为纯类型与常量，不包含任何 IO，可被单元测试直接引用。
 *
 * 注意：使用 as const 对象而非 TS enum，以兼容 Node 24 的原生类型擦除运行方式。
 */

// ---------------------------------------------------------------------------
// 枚举常量
// ---------------------------------------------------------------------------

/** 房源状态 */
export const PROPERTY_STATUSES = ['draft', 'active', 'reserved', 'closed', 'archived'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/** 发布页状态 */
export const LISTING_STATUSES = ['unpublished', 'published', 'withdrawn'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/**
 * 可租状态（对外展示的房源状态）。
 *
 * 与内部的 status（草稿/在售在租/已成交/已归档）分开：
 *  - available  出租中：房东确认仍可租
 *  - rented     已租：房东确认已租出
 *  - unconfirmed 未确认：房东长时间未更新信息，系统按陈旧度自动判定（见 domain/availability.ts）
 */
export const AVAILABILITY_STATUSES = ['available', 'rented'] as const;
/** 房东可设置的值（unconfirmed 由系统按陈旧度自动推导，不允许手工设置） */
export type AvailabilityStatusInput = (typeof AVAILABILITY_STATUSES)[number];
/** 实际对外展示的状态（含系统推导的 unconfirmed） */
export type AvailabilityStatus = AvailabilityStatusInput | 'unconfirmed';

/** 媒体类型 */
export const MEDIA_KINDS = ['photo', 'video_file', 'video_link'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** 面积单位 —— 不写死公制或英制 */
export const AREA_UNITS = ['square_meter', 'square_foot'] as const;
export type AreaUnit = (typeof AREA_UNITS)[number];

/** 计价周期 —— 不写死「按月收租」或「一次性总价」 */
export const PRICE_PERIODS = ['total', 'per_month', 'per_week', 'per_night', 'per_year'] as const;
export type PricePeriod = (typeof PRICE_PERIODS)[number];

/** 联系方式渠道 */
export const CONTACT_CHANNELS = [
  'phone',
  'email',
  'chat',
  'wechat',
  'whatsapp',
  'telegram',
  'other',
] as const;
export type ContactChannelKind = (typeof CONTACT_CHANNELS)[number];

/** 提醒类型（方案第三章第 9 条：第 7 天检查，第 15 天确认或更新） */
export const REMINDER_KINDS = ['check_day_7', 'confirm_day_15'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** 提醒状态 */
export const REMINDER_STATUSES = ['pending', 'completed', 'skipped', 'failed'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/** 工作区成员角色 */
export const USER_ROLES = ['owner', 'manager', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** 外部服务适配器种类 */
export const ADAPTER_KINDS = ['map', 'storage', 'mail', 'hosting'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** 展示模板标识 */
export const TEMPLATE_IDS = ['modern', 'classic', 'minimal'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

// ---------------------------------------------------------------------------
// 实体：User / Workspace（方案第四章第 6 条）
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  ownerUserId: string;
  /** 默认语言 / 币种 / 面积单位 / 时区 —— 全部可配置 */
  defaultLocale: string;
  defaultCurrency: string;
  defaultAreaUnit: AreaUnit;
  defaultTimezone: string;
  /** 托管配置（方案第三章第 8 条） */
  hostingProvider: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 实体：Property（方案第四章第 1 条）
// ---------------------------------------------------------------------------

export interface Property {
  id: string;
  workspaceId: string;

  title: string;
  description: string;

  // 地址 / 区域 —— 按通用行政区划层级建模，不假设任何国家的地址格式
  addressLine: string;
  district: string;
  city: string;
  region: string;
  countryCode: string; // ISO 3166-1 alpha-2，空字符串表示未指定
  postalCode: string;

  latitude: number | null;
  longitude: number | null;

  // 房型 / 面积
  propertyType: string; // 自由字典值：apartment / house / room / office ...
  bedrooms: number | null;
  bathrooms: number | null;
  areaValue: number | null;
  areaUnit: AreaUnit;
  floorNote: string;

  // 价格与费用 —— 金额与币种、周期绑定；附加费用用自由文本，不写死规则
  priceAmount: number | null;
  priceCurrency: string; // ISO 4217
  pricePeriod: PricePeriod;
  depositAmount: number | null;
  depositCurrency: string;
  extraFeesNote: string;

  /** 可入住日期（ISO 8601 日期字符串，仅日期部分） */
  availableFrom: string | null;

  status: PropertyStatus;

  /** 房东声明的可租状态；对外展示时会结合更新时间推导出 unconfirmed */
  availabilityStatus: AvailabilityStatusInput;

  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 实体：PropertyTranslation（方案第三章第 7 条：原文与译文分开保存）
// ---------------------------------------------------------------------------

export interface PropertyTranslation {
  id: string;
  propertyId: string;
  locale: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 实体：Contact（方案第四章第 3 条）
// ---------------------------------------------------------------------------

export interface Contact {
  id: string;
  workspaceId: string;
  /** null 表示工作区级默认联系方式；否则为房源级 */
  propertyId: string | null;
  displayName: string;
  channelKind: ContactChannelKind;
  channelValue: string;
  /** 公开策略：只有 isPublic = true 的渠道才会出现在公开展示页上 */
  isPublic: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 实体：Media（方案第四章第 2 条）
// ---------------------------------------------------------------------------

export interface Media {
  id: string;
  propertyId: string;
  kind: MediaKind;
  /** 本地存储相对键，例如 <propertyId>/<file> */
  storageKey: string;
  /** 外部视频链接（kind = video_link 时使用） */
  externalUrl: string | null;
  originalName: string;
  mimeType: string;
  byteSize: number;
  sortOrder: number;
  /** 封面标记 —— 每个房源至多一张封面，由服务层保证 */
  isCover: boolean;
  /** 素材来源或授权说明（方案第三章第 2 条要求记录） */
  sourceNote: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 实体：ListingPage（方案第四章第 4 条）
// ---------------------------------------------------------------------------

export interface ListingPage {
  id: string;
  propertyId: string;
  workspaceId: string;
  /** 公开访问标识，全局唯一 */
  slug: string;
  locale: string;
  templateId: TemplateId;
  status: ListingStatus;
  publishedAt: string | null;
  withdrawnAt: string | null;
  /** 自定义域名（第 6 阶段），未验证前不得绑定 */
  customDomain: string | null;
  domainVerifyToken: string | null;
  domainVerifiedAt: string | null;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 实体：Reminder（方案第四章第 5 条）
// ---------------------------------------------------------------------------

export interface Reminder {
  id: string;
  propertyId: string;
  listingPageId: string | null;
  kind: ReminderKind;
  /** 计划发送时间（ISO 8601，含时区） */
  dueAt: string;
  /** 提醒规则使用的时区（方案第三章第 9 条要求可配置） */
  timezone: string;
  status: ReminderStatus;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  completedAt: string | null;
  /** 幂等键：保证同一房源同一类型提醒不会重复创建 */
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 实体：ExternalServiceConfig（方案第四章第 7 条）
// ---------------------------------------------------------------------------

export interface ExternalServiceConfig {
  id: string;
  workspaceId: string;
  adapterKind: AdapterKind;
  provider: string;
  /** 非敏感配置（瓦片地址、归属说明、CNAME 目标等） */
  config: Record<string, string>;
  /**
   * 密钥引用 —— 存放环境变量名，而不是密钥本身。
   * 方案第四章第 7 条：密钥不能写入前端或提交到代码仓库。
   */
  secretRefs: string[];
  enabled: boolean;
  freeTierNote: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 实体：AuditLog（方案第八章第 6 条：记录计划时间、执行状态和失败原因）
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// 组合视图：渲染展示页 / 导出用的完整聚合（唯一数据源）
// ---------------------------------------------------------------------------

export interface PropertyAggregate {
  property: Property;
  media: Media[];
  contacts: Contact[];
  listingPage: ListingPage | null;
  translations: PropertyTranslation[];
}
