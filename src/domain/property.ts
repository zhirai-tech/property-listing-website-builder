/**
 * 房源（Property）领域校验与规范化（方案第三章第 1 条、第四章第 1 条）。
 *
 * 核心策略：以「基准值 + 覆盖」的方式解析表单。
 *  - 新建时基准为空表单：必填项缺失会直接报错；
 *  - 编辑时基准为当前房源：未提交的字段沿用原值，因此校验规则天然适用于 PATCH；
 *  - 所有字段都做类型收敛与规范化，返回的永远是完整、可直接写库的对象。
 */

import { Validator } from './validate.ts';
import { validationFailed } from './errors.ts';
import type {
  AreaUnit,
  AvailabilityStatusInput,
  PricePeriod,
  Property,
  PropertyStatus,
} from './types.ts';
import {
  AREA_UNITS,
  AVAILABILITY_STATUSES,
  PRICE_PERIODS,
  PROPERTY_STATUSES,
} from './types.ts';

/** 可写字段集合（不含 id / 工作区 / 时间戳） */
export type PropertyFormValues = Omit<
  Property,
  'id' | 'workspaceId' | 'createdAt' | 'updatedAt'
>;

export interface PropertyDefaults {
  currency: string;
  areaUnit: AreaUnit;
}

/** 空表单：新建房源时的基准 */
export function emptyPropertyForm(defaults: PropertyDefaults): PropertyFormValues {
  return {
    title: '',
    description: '',
    addressLine: '',
    district: '',
    city: '',
    region: '',
    countryCode: '',
    postalCode: '',
    latitude: null,
    longitude: null,
    propertyType: '',
    bedrooms: null,
    bathrooms: null,
    areaValue: null,
    areaUnit: defaults.areaUnit,
    floorNote: '',
    priceAmount: null,
    priceCurrency: defaults.currency,
    pricePeriod: 'total',
    depositAmount: null,
    depositCurrency: defaults.currency,
    extraFeesNote: '',
    availableFrom: null,
    status: 'draft',
    availabilityStatus: 'available',
  };
}

/** 从实体提取表单值（编辑时的基准） */
export function propertyFormFromProperty(p: Property): PropertyFormValues {
  return {
    title: p.title,
    description: p.description,
    addressLine: p.addressLine,
    district: p.district,
    city: p.city,
    region: p.region,
    countryCode: p.countryCode,
    postalCode: p.postalCode,
    latitude: p.latitude,
    longitude: p.longitude,
    propertyType: p.propertyType,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    areaValue: p.areaValue,
    areaUnit: p.areaUnit,
    floorNote: p.floorNote,
    priceAmount: p.priceAmount,
    priceCurrency: p.priceCurrency,
    pricePeriod: p.pricePeriod,
    depositAmount: p.depositAmount,
    depositCurrency: p.depositCurrency,
    extraFeesNote: p.extraFeesNote,
    availableFrom: p.availableFrom,
    status: p.status,
    availabilityStatus: p.availabilityStatus,
  };
}

const NUMERIC_LIMITS = {
  bedrooms: { min: 0, max: 200, integer: true },
  bathrooms: { min: 0, max: 200, integer: true },
  areaValue: { min: 0, max: 10_000_000 },
  priceAmount: { min: 0, max: 1_000_000_000_000 },
  depositAmount: { min: 0, max: 1_000_000_000_000 },
  latitude: { min: -90, max: 90 },
  longitude: { min: -180, max: 180 },
} as const;

/**
 * 解析房源表单。
 *
 * @param raw   来自 HTTP 的原始输入（不可信）
 * @param base  基准值：新建传 emptyPropertyForm(...)，编辑传 propertyFormFromProperty(...)
 */
export function parsePropertyForm(
  raw: Record<string, unknown>,
  base: PropertyFormValues,
): PropertyFormValues {
  const v = new Validator();
  const pick = (field: keyof PropertyFormValues): unknown =>
    Object.hasOwn(raw, field) ? raw[field] : base[field];

  const status = v.enumOf<PropertyStatus>(
    pick('status'),
    'status',
    '房源状态',
    PROPERTY_STATUSES,
    base.status,
  );

  const availabilityStatus = v.enumOf<AvailabilityStatusInput>(
    pick('availabilityStatus'),
    'availabilityStatus',
    '可租状态',
    AVAILABILITY_STATUSES,
    base.availabilityStatus,
  );

  const form: PropertyFormValues = {
    title: v.str(pick('title'), 'title', '标题', { required: true, min: 1, max: 200 }),
    description: v.text(pick('description'), 'description', '房源描述', { max: 20000 }),

    addressLine: v.str(pick('addressLine'), 'addressLine', '详细地址', { max: 300 }),
    district: v.str(pick('district'), 'district', '区/县', { max: 120 }),
    city: v.str(pick('city'), 'city', '城市', { max: 120 }),
    region: v.str(pick('region'), 'region', '省/州', { max: 120 }),
    countryCode: v.countryCode(pick('countryCode'), 'countryCode', '国家/地区代码'),
    postalCode: v.str(pick('postalCode'), 'postalCode', '邮政编码', { max: 20 }),

    latitude: v.num(pick('latitude'), 'latitude', '纬度', NUMERIC_LIMITS.latitude),
    longitude: v.num(pick('longitude'), 'longitude', '经度', NUMERIC_LIMITS.longitude),

    propertyType: v.str(pick('propertyType'), 'propertyType', '房型', { max: 60 }),
    bedrooms: v.num(pick('bedrooms'), 'bedrooms', '卧室数量', NUMERIC_LIMITS.bedrooms),
    bathrooms: v.num(pick('bathrooms'), 'bathrooms', '卫生间数量', NUMERIC_LIMITS.bathrooms),
    areaValue: v.num(pick('areaValue'), 'areaValue', '面积', NUMERIC_LIMITS.areaValue),
    areaUnit: v.enumOf<AreaUnit>(pick('areaUnit'), 'areaUnit', '面积单位', AREA_UNITS, base.areaUnit),
    floorNote: v.str(pick('floorNote'), 'floorNote', '楼层说明', { max: 120 }),

    priceAmount: v.num(pick('priceAmount'), 'priceAmount', '价格', NUMERIC_LIMITS.priceAmount),
    priceCurrency: v.currency(pick('priceCurrency'), 'priceCurrency', '价格币种', base.priceCurrency),
    pricePeriod: v.enumOf<PricePeriod>(
      pick('pricePeriod'),
      'pricePeriod',
      '计价周期',
      PRICE_PERIODS,
      base.pricePeriod,
    ),
    depositAmount: v.num(pick('depositAmount'), 'depositAmount', '押金', NUMERIC_LIMITS.depositAmount),
    depositCurrency: v.currency(
      pick('depositCurrency'),
      'depositCurrency',
      '押金币种',
      base.depositCurrency,
    ),
    extraFeesNote: v.text(pick('extraFeesNote'), 'extraFeesNote', '附加费用说明', { max: 2000 }),

    availableFrom: v.isoDate(pick('availableFrom'), 'availableFrom', '可入住日期'),

    status,
    availabilityStatus,
  };

  // 交叉字段校验（字段级校验之后的业务规则）
  const crossIssues = [];
  if ((form.latitude === null) !== (form.longitude === null)) {
    crossIssues.push({
      field: form.latitude === null ? 'latitude' : 'longitude',
      message: '经纬度必须成对填写，只填一个无法在地图上定位',
    });
  }
  v.done();
  if (crossIssues.length > 0) throw validationFailed(crossIssues, '位置信息不完整');

  return form;
}

/** 计算两个表单值之间的差异字段，用于 PATCH 只更新变化部分 */
export function diffPropertyForm(
  next: PropertyFormValues,
  base: PropertyFormValues,
): Partial<PropertyFormValues> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof PropertyFormValues)[]) {
    if (next[key] !== base[key]) patch[key] = next[key];
  }
  return patch as Partial<PropertyFormValues>;
}

export function hasCoordinates(p: Pick<Property, 'latitude' | 'longitude'>): boolean {
  return p.latitude !== null && p.longitude !== null;
}

/** 状态中文名，供后台与验收报告使用 */
export function propertyStatusLabel(status: PropertyStatus): string {
  switch (status) {
    case 'draft':
      return '草稿';
    case 'active':
      return '在售/在租';
    case 'reserved':
      return '已预订';
    case 'closed':
      return '已成交';
    case 'archived':
      return '已归档';
    default:
      return status;
  }
}

/** 归档房源是否允许直接公开 —— 归档属于「撤下」语义 */
export function isArchived(status: PropertyStatus): boolean {
  return status === 'archived';
}
