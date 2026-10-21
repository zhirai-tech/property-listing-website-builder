/**
 * 静态导出服务（方案第三章第 4 条、第 3 阶段验收）。
 *
 * 验收要点：
 *  - 导出文件可在本地直接打开（file:// 协议，无需服务器）；
 *  - 图片路径有效（媒体复制到 assets/ 并使用相对路径）；
 *  - 核心展示不依赖内部管理后台；
 *  - 明确说明地图、在线字体等外部服务在离线环境下可能无法完整运行。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AppContext } from '../app-context.ts';
import { unprocessable } from '../domain/errors.ts';
import { renderListingPage, type LocaleLink } from '../render/page-renderer.ts';
import { SUPPORTED_LOCALES } from '../domain/i18n.ts';
import { resolveAvailability } from '../domain/availability.ts';
import { createZip, type ZipEntry } from '../util/zip.ts';
import { listMedia } from '../db/repositories/media-repo.ts';
import { listTranslations } from '../db/repositories/translation-repo.ts';
import { listEffectivePublicContacts } from '../db/repositories/contact-repo.ts';
import { recordAudit } from './audit-service.ts';
import { buildLocaleLinks } from './i18n-service.ts';
import { ensureListingPage, publicUrlFor } from './publish-service.ts';
import { requireProperty } from './property-service.ts';
import { mediaOrigins, rewriteMediaReferences } from './export-url.ts';

export interface ExportBundle {
  files: ZipEntry[];
  notes: string[];
  entryPath: string;
}

const OFFLINE_NOTES = [
  '离线打开说明：本目录已包含页面所需的全部样式与图片，双击 index.html 即可查看。',
  '多语言：每种语言各有一个 HTML 文件（index.html 为默认语言，其余为 index.<语言>.html），在离线状态下也能互相切换。',
  '周边信息查询需要在平台在线时使用，因此导出版本不提供该入口（不会出现打不开的死链）。',
  '地图：离线环境下在线地图瓦片无法加载，页面会自动降级为显示地址文本与经纬度。',
  '二维码：二维码已内联为 SVG，离线同样可以显示与扫描。',
  '字体：页面只使用系统内置字体，不依赖在线字体服务。',
  '联系方式：仅包含在后台被标记为「公开」的渠道。',
];

/**
 * 构建导出包（内存中）。
 * 同时用于「导出为目录」与「导出为 ZIP」两种交付形式。
 */
export async function buildExportBundle(
  ctx: AppContext,
  propertyId: string,
  options: { locale?: string } = {},
): Promise<ExportBundle> {
  const property = requireProperty(ctx, propertyId);
  const page = ensureListingPage(ctx, propertyId);

  const locale = options.locale ?? page.locale ?? ctx.workspace.defaultLocale;
  const media = listMedia(ctx.db, propertyId);
  const translations = listTranslations(ctx.db, propertyId);
  const aggregate = {
    property,
    media,
    contacts: listEffectivePublicContacts(ctx.db, ctx.workspace.id, propertyId),
    listingPage: page,
    translations,
  };

  const publicUrl = publicUrlFor(ctx, page);
  const mapView = ctx.adapters.map.buildView({
    latitude: property.latitude,
    longitude: property.longitude,
    addressText: '',
  });

  // 可离线使用的多语言：
  // 默认语言写 index.html，其它语言写 index.<tag>.html，切换链接指向本地文件。
  const availableLocales = [
    ...new Set([locale, ...translations.map((tr) => tr.locale)]),
  ].filter((tag) => tag !== '');

  const fileFor = (tag: string): string =>
    tag.toLowerCase() === locale.toLowerCase() ? 'index.html' : `index.${tag}.html`;

  const labelFor = (tag: string): string =>
    SUPPORTED_LOCALES.find((l) => l.tag.toLowerCase() === tag.toLowerCase())?.label ?? tag;

  const localeLinks: LocaleLink[] = availableLocales.map((tag) => ({
    tag,
    label: labelFor(tag),
    current: tag.toLowerCase() === locale.toLowerCase(),
    href: fileFor(tag),
  }));

  // 先把媒体文件读出来，确定**哪些 key 真的会进导出包**。
  // 必须放在渲染之前：改写时只认可被打包的 key，
  // 引用了没打包的资源就保持原样并提示，而不是悄悄给一个加载不到的地址。
  const includedMedia: { storageKey: string; data: Uint8Array }[] = [];
  for (const item of media) {
    if (item.storageKey === '') continue;
    const data = await ctx.adapters.storage.read(item.storageKey);
    if (!data) continue;
    includedMedia.push({ storageKey: item.storageKey, data });
  }
  const exportedKeys = new Set(includedMedia.map((m) => m.storageKey));

  // 判断「绝对 URL 是否指向本站」时用的 origin 集合。
  // 只把**确实属于本站**的 origin 算进来 —— 指向别的站点的图片不该被改写成
  // 导出包里的相对路径（那会指到一个不存在的文件）。
  const origins = mediaOrigins(ctx.config.publicBaseUrl, publicUrl);

  const missingRefs = new Set<string>();
  const files: ZipEntry[] = availableLocales.map((tag) => {
    const html = renderListingPage({
      aggregate,
      workspace: ctx.workspace,
      locale: tag,
      publicUrl,
      templateId: page.templateId,
      mapView,
      nearby: null,
      localeLinks,
      // 离线导出不注入地图脚本，直接使用静态降级视图
      includeMapScript: false,
      includeQr: true,
      generatedAt: ctx.adapters.clock.now(),
      availability: resolveAvailability(property, ctx.adapters.clock.now(), ctx.config.listingStaleDays),
      exportNotice:
        '这是从平台导出的静态页面快照。在线地图等外部服务在离线环境下可能无法完整运行，页面已自动降级显示地址信息。',
      interactive: false,
    });

    // 把媒体引用改写为相对路径，保证 file:// 下也能打开。
    //
    // 这里**不能**用 replaceAll('/media/', 'assets/')：它不认 URL 边界，
    // 会把 `http://host:3210/media/a.png` 变成 `http://host:3210assets/a.png`
    // （缺斜杠，任何环境都解析不了）。og:image 正是这种绝对 URL。
    const rewritten = rewriteMediaReferences(html, { origins, exportedKeys });
    for (const key of rewritten.missing) missingRefs.add(key);

    return { path: fileFor(tag), data: new TextEncoder().encode(rewritten.html) };
  });

  files.push({
    path: 'README.txt',
    data: new TextEncoder().encode(
      [
        ...OFFLINE_NOTES,
        '',
        `默认语言：${locale}`,
        `可离线切换的语言：${availableLocales.join(', ')}`,
        `语言文件：${availableLocales.map((tag) => fileFor(tag)).join(', ')}`,
        `分享链接：${publicUrl}`,
        `导出时间：${ctx.adapters.clock.now().toISOString()}`,
      ].join('\n'),
    ),
  });
  files.push({ path: 'share-url.txt', data: new TextEncoder().encode(`${publicUrl}\n`) });

  for (const item of includedMedia) {
    files.push({ path: `assets/${item.storageKey}`, data: item.data });
  }

  // 引用了没被打包的资源时如实告知 —— 而不是让它变成一个加载不到的地址
  const notes = [...OFFLINE_NOTES];
  if (missingRefs.size > 0) {
    notes.push(
      `注意：有 ${missingRefs.size} 个资源引用未能包含在导出包中（文件缺失或不可读取），` +
        '页面里保留了原路径，这些位置在离线状态下会显示为空白：' +
        [...missingRefs].join(', '),
    );
  }

  return { files, notes, entryPath: 'index.html' };
}

export interface ExportDirectoryResult {
  outDir: string;
  files: string[];
  totalBytes: number;
  notes: string[];
}

/** 导出到本地目录 */
export async function exportListingToDirectory(
  ctx: AppContext,
  propertyId: string,
  options: { outDir: string; locale?: string },
): Promise<ExportDirectoryResult> {
  const bundle = await buildExportBundle(ctx, propertyId, options);
  const outDir = resolve(options.outDir);

  const written: string[] = [];
  let totalBytes = 0;

  for (const file of bundle.files) {
    const full = resolve(outDir, file.path);
    if (!full.startsWith(outDir + sep)) {
      throw unprocessable(`导出路径越界：${file.path}`);
    }

    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, file.data);
    written.push(file.path);
    totalBytes += file.data.length;
  }

  recordAudit(ctx, {
    action: 'export.directory',
    entityType: 'property',
    entityId: propertyId,
    detail: { outDir, files: written.length, totalBytes },
  });

  return { outDir, files: written, totalBytes, notes: bundle.notes };
}

export interface ExportZipResult {
  data: Uint8Array;
  filename: string;
  entryCount: number;
  totalBytes: number;
}

/** 导出为 ZIP 归档（浏览器直接下载） */
export async function exportListingAsZip(
  ctx: AppContext,
  propertyId: string,
  options: { locale?: string } = {},
): Promise<ExportZipResult> {
  const property = requireProperty(ctx, propertyId);
  const bundle = await buildExportBundle(ctx, propertyId, options);
  const now = ctx.adapters.clock.now();

  const zip = createZip(bundle.files);

  const safeTitle = property.title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'listing';
  const filename = `${safeTitle}-${now.toISOString().slice(0, 10)}.zip`;

  recordAudit(ctx, {
    action: 'export.zip',
    entityType: 'property',
    entityId: propertyId,
    detail: { filename, entries: zip.entryCount, totalBytes: zip.totalBytes },
  });

  return {
    data: zip.data,
    filename,
    entryCount: zip.entryCount,
    totalBytes: zip.totalBytes,
  };
}