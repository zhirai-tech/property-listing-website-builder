/**
 * 地图适配器（方案第三章第 6 条、第 4 阶段验收）。
 *
 * 要求：
 *  - 地图接入必须采用可替换的适配层，按国家/地区配置服务和密钥；
 *  - 上线前明确免费额度及潜在费用；
 *  - 地图服务故障时仍可显示地址；
 *  - 密钥不得出现在前端。
 *
 * 默认实现使用 OpenStreetMap 瓦片（无需密钥），因此本项目开箱即可显示地图，
 * 同时保留切换到商业服务的能力。
 */

import type { Logger } from '../util/logger.ts';

export type NearbyCategory = 'transport' | 'shop' | 'school' | 'hospital' | 'park' | 'other';

export interface NearbyPlace {
  category: NearbyCategory;
  name: string;
  distanceMeters: number | null;
  latitude: number;
  longitude: number;
}

export interface NearbyResult {
  available: boolean;
  /** 不可用时的原因（用于界面提示，不抛异常） */
  reason: string;
  places: NearbyPlace[];
  /** 数据来源说明 */
  source: string;
}

export interface MapView {
  provider: string;
  /** 是否渲染交互地图 */
  enabled: boolean;
  hasCoordinates: boolean;
  latitude: number | null;
  longitude: number | null;
  zoom: number;
  tileUrl: string;
  attribution: string;
  /** 无论地图是否可用都要显示的地址文本 */
  fallbackAddress: string;
  freeTierNote: string;
  /** 降级说明：界面据此提示用户 */
  degraded: boolean;
  degradedReason: string;
}

export interface MapViewInput {
  latitude: number | null;
  longitude: number | null;
  addressText: string;
}

export interface MapProvider {
  readonly name: string;
  buildView(input: MapViewInput): MapView;
  nearby(
    input: { latitude: number; longitude: number; radiusMeters?: number },
    signal?: AbortSignal,
  ): Promise<NearbyResult>;
}

export interface OsmMapOptions {
  tileUrl: string;
  attribution: string;
  freeTierNote: string;
  apiKey?: string;
  /** Overpass 兼容端点；默认使用公共实例，可按地区替换 */
  overpassEndpoint?: string;
  logger?: Logger;
  /** 便于测试注入；默认使用全局 fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

const OVERPASS_FILTER = [
  'node["amenity"~"^(school|university|hospital|clinic|bus_station|pharmacy|marketplace)$"]',
  'node["shop"~"^(supermarket|convenience|mall)$"]',
  'node["highway"="bus_stop"]',
  'node["railway"~"^(station|subway_entrance)$"]',
  'node["leisure"="park"]',
].join(';');

function categoryOf(tags: Record<string, string>): NearbyCategory {
  const amenity = tags['amenity'] ?? '';
  const shop = tags['shop'] ?? '';
  const railway = tags['railway'] ?? '';
  const highway = tags['highway'] ?? '';
  const leisure = tags['leisure'] ?? '';

  if (amenity === 'school' || amenity === 'university') return 'school';
  if (railway === 'station' || railway === 'subway_entrance' || highway === 'bus_stop') {
    return 'transport';
  }
  if (amenity === 'bus_station') return 'transport';
  if (amenity === 'hospital' || amenity === 'clinic') return 'hospital';
  if (shop !== '' || amenity === 'marketplace' || amenity === 'pharmacy') return 'shop';
  if (leisure === 'park') return 'park';
  return 'other';
}

/** 使用 Haversine 公式估算距离（米） */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class OsmMapProvider implements MapProvider {
  readonly name = 'osm';
  private readonly options: OsmMapOptions;
  private readonly cache = new Map<string, { at: number; result: NearbyResult }>();

  constructor(options: OsmMapOptions) {
    this.options = options;
  }

  buildView(input: MapViewInput): MapView {
    const hasCoordinates = input.latitude !== null && input.longitude !== null;

    return {
      provider: this.name,
      enabled: true,
      hasCoordinates,
      latitude: input.latitude,
      longitude: input.longitude,
      zoom: 15,
      // 打包进 HTML 的瓦片地址属于公开信息，密钥绝不在此出现
      tileUrl: this.options.tileUrl,
      attribution: this.options.attribution,
      fallbackAddress: input.addressText,
      freeTierNote: this.options.freeTierNote,
      degraded: !hasCoordinates,
      degradedReason: hasCoordinates ? '' : '该房源尚未填写经纬度，仅显示地址文本',
    };
  }

  async nearby(
    input: { latitude: number; longitude: number; radiusMeters?: number },
    signal?: AbortSignal,
  ): Promise<NearbyResult> {
    const radius = input.radiusMeters ?? 1000;
    const key = `${input.latitude.toFixed(4)},${input.longitude.toFixed(4)},${radius}`;
    const ttl = this.options.cacheTtlMs ?? 24 * 60 * 60 * 1000;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < ttl) {
      return { ...cached.result, source: `${cached.result.source}（缓存）` };
    }

    const query = `[out:json][timeout:10];(${OVERPASS_FILTER}(around:${radius},${input.latitude},${input.longitude}););out body 30;`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8000);

    // 调用方传入的 signal 也要生效
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const endpoint = this.options.overpassEndpoint ?? DEFAULT_OVERPASS_ENDPOINT;

      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // 【HTTP 头必须是 ASCII】这里原先写了中文说明，Node 会在发请求前抛
        // 「Cannot convert argument to a ByteString…」—— 而 HTTP 头本来就不允许非 ASCII。
        // 后果不是「周边信息偶发失败」，而是**这个功能 100% 不可用**：
        // 展示页上的「附近」区块永远显示不出来，而且错误信息把 Node 的内部报错
        // 原样透给了访客（见 map.ts 的 reason 字段）。
        // 说明文字改到注释里，头值保持纯 ASCII。
        'User-Agent': 'lightweight-property-listing/1.0 (+https://example.com)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });

      if (!response.ok) {
        return this.unavailable(
          response.status === 429
            ? '周边信息服务已触发限流（免费公共实例有配额限制）'
            : `周边信息服务返回 HTTP ${response.status}（可能被网络策略拦截或服务不可用）`,
        );
      }

      const payload = (await response.json()) as {
        elements?: { lat?: number; lon?: number; tags?: Record<string, string> }[];
      };

      const origin = { latitude: input.latitude, longitude: input.longitude };
      const places: NearbyPlace[] = [];

      for (const element of payload.elements ?? []) {
        if (typeof element.lat !== 'number' || typeof element.lon !== 'number') continue;
        const tags = element.tags ?? {};
        const name = tags['name'] ?? tags['name:zh'] ?? tags['operator'] ?? '';
        if (name === '') continue;

        places.push({
          category: categoryOf(tags),
          name,
          distanceMeters: Math.round(
            haversineMeters(origin, { latitude: element.lat, longitude: element.lon }),
          ),
          latitude: element.lat,
          longitude: element.lon,
        });
      }

      places.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
      const limited = places.slice(0, 12);

      const result: NearbyResult = {
        available: true,
        reason: '',
        places: limited,
        source: 'OpenStreetMap Overpass API',
      };

      this.cache.set(key, { at: Date.now(), result });
      return result;
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? '周边信息服务请求超时'
          : `周边信息服务不可用：${error instanceof Error ? error.message : String(error)}`;
      this.options.logger?.warn('周边信息查询失败，已降级', { reason });
      return this.unavailable(reason);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private unavailable(reason: string): NearbyResult {
    return {
      available: false,
      reason: `${reason}；展示页仍会正常显示地址文本与地图定位`,
      places: [],
      source: 'unavailable',
    };
  }
}

/** 完全关闭地图（例如没有任何地图服务可用时） */
export class DisabledMapProvider implements MapProvider {
  readonly name = 'disabled';

  buildView(input: MapViewInput): MapView {
    return {
      provider: this.name,
      enabled: false,
      hasCoordinates: input.latitude !== null && input.longitude !== null,
      latitude: input.latitude,
      longitude: input.longitude,
      zoom: 15,
      tileUrl: '',
      attribution: '',
      fallbackAddress: input.addressText,
      freeTierNote: '',
      degraded: true,
      degradedReason: '地图服务已通过配置关闭，仅显示地址文本',
    };
  }

  async nearby(): Promise<NearbyResult> {
    return {
      available: false,
      reason: '地图服务已关闭，不提供周边信息',
      places: [],
      source: 'disabled',
    };
  }
}
