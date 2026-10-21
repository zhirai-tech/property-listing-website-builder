/**
 * 展示页渲染器（方案第三章第 3 条、第 2 阶段验收）。
 *
 * 设计取向：**移动端优先、紧凑优先**。
 *  - 首图是可直接左右滑动的图集，不再另起一排缩略图（手机上省掉约 110px）；
 *  - 信息用胶囊标签横排，而不是大卡片网格；
 *  - 长内容一律放进原生 <details> 折叠区块，默认只展开「介绍 / 价格 / 联系方式」，
 *    位置、周边、视频、分享默认收起 —— 手机上基本一到两屏看完；
 *  - 底部固定操作栏（拨号 / 分享 / 地图），手机上任何位置都能一键操作；
 *  - 桌面端只是加宽与调整比例，结构完全一致，不做两套页面。
 *
 * 安全约束：
 *  - 所有动态字段一律转义，阻断存储型 XSS；
 *  - 联系方式只渲染用户明确标记为公开的渠道；
 *  - 地图使用项目内置的轻量实现，不引入任何第三方地图库。
 */

import type { PropertyAggregate, Workspace } from '../domain/types.ts';
import type { MapView, NearbyResult } from '../adapters/map.ts';
import type { AvailabilityResult } from '../domain/availability.ts';
import {
  contactChannelLabel,
  formatArea,
  formatDateOnly,
  formatMoney,
  formatPrice,
  nearbyCategoryLabel,
  pricePeriodLabel,
  propertyTypeLabel,
  resolveLocalizedText,
  t,
} from '../domain/i18n.ts';
import { escapeAttribute, escapeHtml, safeUrl } from './html.ts';
import { BASE_CSS, getTemplate } from './templates.ts';
import { renderQrSvg } from './qrcode.ts';
import { renderMiniMap, renderMiniMapScript } from './mini-map.ts';
import { icon } from './icons.ts';

export interface LocaleLink {
  tag: string;
  label: string;
  current: boolean;
  href?: string;
}

export interface RenderInput {
  aggregate: PropertyAggregate;
  workspace: Workspace;
  locale: string;
  publicUrl: string;
  templateId: string;
  mapView: MapView;
  nearby: NearbyResult | null;
  localeLinks: LocaleLink[];
  includeMapScript: boolean;
  includeQr: boolean;
  generatedAt: Date;
  exportNotice?: string;
  nonce?: string;
  interactive?: boolean;
  /** 对外展示的可租状态（已结合陈旧度推导），由调用方用 Clock 计算 */
  availability: AvailabilityResult;
}

/** 组装人类可读的地址文本（不按任何国家格式写死，仅按层级拼接） */
export function composeAddress(property: {
  addressLine: string;
  district: string;
  city: string;
  region: string;
  countryCode: string;
  postalCode: string;
}): string {
  return [
    property.countryCode,
    property.region,
    property.city,
    property.district,
    property.addressLine,
    property.postalCode,
  ]
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== '')
    .join(' ');
}

function mediaUrl(storageKey: string): string {
  return `/media/${storageKey.split('/').map(encodeURIComponent).join('/')}`;
}

function photoUrl(photo: { storageKey: string; externalUrl: string | null }): string {
  return safeUrl(
    photo.storageKey !== '' ? mediaUrl(photo.storageKey) : (photo.externalUrl ?? ''),
  );
}

// ---------------------------------------------------------------------------
// 图集
// ---------------------------------------------------------------------------

function renderGallery(input: RenderInput, locale: string, title: string): string {
  const photos = input.aggregate.media.filter((m) => m.kind === 'photo');
  const slides = photos.map((photo) => photoUrl(photo)).filter((url) => url !== '');

  const status = input.availability.status;

  // 主图上的状态标签：出租中 / 已租 / 未确认
  const badge = `<span class="hero-badge st-${escapeAttribute(status)}">${escapeHtml(
    t(locale, statusKey(status)),
  )}</span>`;

  if (slides.length === 0) {
    return `<div class="hero-media">
      <div class="gallery"><div class="gallery-empty" role="img" aria-label="${escapeAttribute(
        t(locale, 'noPhotos'),
      )}">${escapeHtml(t(locale, 'noPhotos'))}</div></div>
      ${badge}
    </div>`;
  }

  const images = slides
    .map(
      (src, index) =>
        `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(
          t(locale, 'photoN', { title, n: index + 1 }),
        )}"${index === 0 ? ' loading="eager"' : ' loading="lazy"'} decoding="async">`,
    )
    .join('');

  const dots = slides
    .map((_, index) => `<i${index === 0 ? ' class="on"' : ''}></i>`)
    .join('');

  // 关键：状态标签、计数与圆点必须放在「不滚动」的外层容器里。
  // 它们若留在 .gallery（横向滚动容器）内部，会随图片一起滚出屏幕。
  // data-autoplay=1 让脚本自动轮播；用户一交互就暂停（见 galleryScript）。
  return `<div class="hero-media">
      <div class="gallery" id="gallery" role="group" aria-label="${escapeAttribute(
        t(locale, 'galleryLabel'),
      )}" data-autoplay="${slides.length > 1 ? '1' : '0'}">${images}</div>
      ${badge}
      ${
        slides.length > 1
          ? `<span class="counter" id="counter">1/${slides.length}</span><div class="dots" id="dots">${dots}</div>`
          : ''
      }
    </div>`;
}

/** 可租状态 -> i18n 键 */
function statusKey(status: AvailabilityResult['status']): 'stAvailable' | 'stRented' | 'stUnconfirmed' {
  if (status === 'rented') return 'stRented';
  if (status === 'unconfirmed') return 'stUnconfirmed';
  return 'stAvailable';
}

// ---------------------------------------------------------------------------
// 摘要（标题 / 价格 / 地址 / 关键信息胶囊）
// ---------------------------------------------------------------------------

function renderChips(input: RenderInput, locale: string): string {
  const { property } = input.aggregate;
  const chips: string[] = [];

  const chip = (label: string, value: string): void => {
    if (value === '') return;
    chips.push(`<li><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></li>`);
  };

  if (property.bedrooms !== null) chip(t(locale, 'bedrooms'), String(property.bedrooms));
  if (property.bathrooms !== null) chip(t(locale, 'bathrooms'), String(property.bathrooms));
  if (property.areaValue !== null) {
    chip(t(locale, 'area'), formatArea(property.areaValue, property.areaUnit, locale));
  }
  if (property.propertyType !== '') {
    chip(t(locale, 'type'), propertyTypeLabel(property.propertyType, locale));
  }
  chip(t(locale, 'floor'), property.floorNote);
  if (property.availableFrom) {
    chip(
      t(locale, 'availableFrom'),
      formatDateOnly(property.availableFrom, locale, input.workspace.defaultTimezone),
    );
  }

  if (chips.length === 0) return '';
  return `<ul class="chips">${chips.join('')}</ul>`;
}

/**
 * 顶部栏：标题 + 语言切换。
 * 语言切换从标题下方移到页面顶部，避免挤在摘要区里显得凌乱。
 */
function renderTopNav(input: RenderInput, locale: string, title: string): string {
  const languages =
    input.localeLinks.length <= 1
      ? ''
      : input.localeLinks
          .map((link) => {
            const href = link.href ?? `?lang=${encodeURIComponent(link.tag)}`;
            return `<a href="${escapeAttribute(href)}"${
              link.current ? ' aria-current="true"' : ''
            }>${escapeHtml(link.label)}</a>`;
          })
          .join('');

  return `<header class="topnav">
    <div class="topnav-inner">
      <span class="topnav-title">${escapeHtml(title)}</span>
      ${
        languages
          ? `<nav class="langbar" aria-label="${escapeAttribute(t(locale, 'langSwitch'))}">${languages}</nav>`
          : ''
      }
    </div>
  </header>`;
}

function priceText(input: RenderInput, locale: string): string {
  const { property } = input.aggregate;
  if (property.priceAmount === null) return t(locale, 'priceOnRequest');
  return formatPrice(property.priceAmount, property.priceCurrency, property.pricePeriod, locale);
}

// ---------------------------------------------------------------------------
// 折叠区块
// ---------------------------------------------------------------------------

interface SectionOptions {
  id: string;
  title: string;
  hint?: string;
  open?: boolean;
  body: string;
}

function section(options: SectionOptions): string {
  if (options.body.trim() === '') return '';
  return `<details class="sec"${options.open ? ' open' : ''}>
      <summary>${escapeHtml(options.title)}${
        options.hint ? `<span class="hint">${escapeHtml(options.hint)}</span>` : ''
      }</summary>
      <div class="body">${options.body}</div>
    </details>`;
}

function renderAbout(input: RenderInput, locale: string, description: string, translated: boolean, usedLocale: string): string {
  if (description.trim() === '') return '';

  const notice = translated
    ? `<p class="muted small" style="margin:8px 0 0">${escapeHtml(
        t(locale, 'translationNotice', { locale: usedLocale }),
      )}</p>`
    : '';

  return section({
    id: 'about',
    title: t(locale, 'about'),
    open: true,
    body: `<div class="prose">${escapeHtml(description)}</div>${notice}`,
  });
}

function renderCosts(input: RenderInput, locale: string): string {
  const { property } = input.aggregate;
  const rows: string[] = [];

  if (property.priceAmount !== null) {
    rows.push(
      `<div><dt>${escapeHtml(t(locale, 'price'))}</dt><dd>${escapeHtml(
        formatPrice(property.priceAmount, property.priceCurrency, property.pricePeriod, locale),
      )}</dd></div>`,
    );
  }
  if (property.depositAmount !== null) {
    rows.push(
      `<div><dt>${escapeHtml(t(locale, 'deposit'))}</dt><dd>${escapeHtml(
        formatMoney(property.depositAmount, property.depositCurrency, locale),
      )}</dd></div>`,
    );
  }
  rows.push(
    `<div><dt>${escapeHtml(t(locale, 'billingPeriod'))}</dt><dd>${escapeHtml(
      pricePeriodLabel(property.pricePeriod, locale),
    )}</dd></div>`,
  );
  if (property.availableFrom) {
    rows.push(
      `<div><dt>${escapeHtml(t(locale, 'availableFrom'))}</dt><dd>${escapeHtml(
        formatDateOnly(property.availableFrom, locale, input.workspace.defaultTimezone),
      )}</dd></div>`,
    );
  }
  if (property.extraFeesNote.trim() !== '') {
    rows.push(
      `<div><dt>${escapeHtml(t(locale, 'extraFees'))}</dt><dd class="prose">${escapeHtml(
        property.extraFeesNote,
      )}</dd></div>`,
    );
  }

  return section({
    id: 'costs',
    title: t(locale, 'priceFees'),
    hint: priceText(input, locale),
    open: true,
    body: `<dl class="kv">${rows.join('')}</dl>`,
  });
}

function renderLocation(input: RenderInput, locale: string): string {
  const address = composeAddress(input.aggregate.property);
  const { mapView } = input;

  const addressLine = `<p class="addr">${
    address !== '' ? escapeHtml(address) : escapeHtml(t(locale, 'noAddress'))
  }</p>`;

  if (!mapView.hasCoordinates || !mapView.enabled || !input.includeMapScript) {
    const reason = !mapView.hasCoordinates
      ? t(locale, 'mapNoCoordinates')
      : t(locale, 'mapOffline');

    // 降级时仍然要显示经纬度 —— 提示语让用户「复制经纬度到地图应用」，
    // 就必须真的把经纬度给出来，否则这条提示是空的。
    const coordinates = mapView.hasCoordinates
      ? `<p class="muted small">${escapeHtml(t(locale, 'coordinates'))}：${escapeHtml(
          `${mapView.latitude}, ${mapView.longitude}`,
        )}</p>`
      : '';

    return section({
      id: 'location',
      title: t(locale, 'location'),
      hint: address,
      body: `${addressLine}${coordinates}<p class="muted small">${escapeHtml(reason)}</p>`,
    });
  }

  const latitude = mapView.latitude as number;
  const longitude = mapView.longitude as number;

  const map = renderMiniMap({
    latitude,
    longitude,
    zoom: mapView.zoom,
    tileUrl: mapView.tileUrl,
    attribution: mapView.attribution,
    openUrl: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${mapView.zoom}/${latitude}/${longitude}`,
    label: t(locale, 'location'),
    zoomInLabel: t(locale, 'zoomIn'),
    zoomOutLabel: t(locale, 'zoomOut'),
    openLabel: t(locale, 'openInMap'),
  });

  const note = mapView.freeTierNote
    ? `<p class="muted small map-note">${escapeHtml(t(locale, 'mapFreeTier', { note: mapView.freeTierNote }))}</p>`
    : '';

  return section({
    id: 'location',
    title: t(locale, 'location'),
    hint: address,
    body: `${addressLine}<p class="muted small">${escapeHtml(
      t(locale, 'coordinates'),
    )}：${escapeHtml(`${latitude}, ${longitude}`)}</p>${map}${note}`,
  });
}

function renderNearby(input: RenderInput, locale: string): string {
  const { nearby } = input;

  if (!nearby) {
    if (!input.mapView.enabled || !input.mapView.hasCoordinates || input.interactive === false) {
      return '';
    }
    return section({
      id: 'nearby',
      title: t(locale, 'nearby'),
      body: `<p class="muted small">${escapeHtml(t(locale, 'nearbyHint'))}</p>
        <p style="margin:8px 0 0"><a class="btn ghost" href="?nearby=1">${escapeHtml(
          t(locale, 'viewNearby'),
        )}</a></p>`,
    });
  }

  if (!nearby.available) {
    return section({
      id: 'nearby',
      title: t(locale, 'nearby'),
      body: `<p class="muted small">${escapeHtml(nearby.reason)}</p>`,
    });
  }

  if (nearby.places.length === 0) {
    return section({
      id: 'nearby',
      title: t(locale, 'nearby'),
      body: `<p class="muted small">${escapeHtml(t(locale, 'nearbyEmpty'))}</p>`,
    });
  }

  const items = nearby.places
    .map(
      (place) => `<li><span>${escapeHtml(place.name)}</span><span class="cat">${escapeHtml(
        nearbyCategoryLabel(place.category, locale),
      )}${place.distanceMeters !== null ? ` · ${place.distanceMeters} m` : ''}</span></li>`,
    )
    .join('');

  return section({
    id: 'nearby',
    title: t(locale, 'nearby'),
    body: `<ul class="nearby-list">${items}</ul>
      <p class="muted small map-note">${escapeHtml(
        t(locale, 'nearbySource', { source: nearby.source }),
      )}</p>`,
  });
}

function renderVideos(input: RenderInput, locale: string): string {
  const videos = input.aggregate.media.filter(
    (m) => m.kind === 'video_file' || m.kind === 'video_link',
  );
  if (videos.length === 0) return '';

  const blocks = videos
    .map((video) => {
      if (video.kind === 'video_file' && video.storageKey !== '') {
        const src = safeUrl(mediaUrl(video.storageKey));
        return `<video class="media-video" controls preload="metadata" src="${escapeAttribute(src)}"></video>`;
      }
      const external = safeUrl(video.externalUrl ?? '');
      if (external === '') return '';
      return `<p style="margin:0 0 8px"><a class="btn ghost" href="${escapeAttribute(
        external,
      )}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(t(locale, 'watchExternal'))}</a></p>`;
    })
    .filter((b) => b !== '')
    .join('');

  if (blocks === '') return '';

  return section({
    id: 'video',
    title: t(locale, 'video'),
    body: blocks,
  });
}

function renderContacts(input: RenderInput, locale: string, open: boolean): string {
  const effective = input.aggregate.contacts.filter(
    (c) => c.isPublic && c.channelValue.trim() !== '',
  );

  if (effective.length === 0) {
    return section({
      id: 'contact',
      title: t(locale, 'contact'),
      body: `<p class="muted">${escapeHtml(t(locale, 'noPublicContact'))}</p>`,
    });
  }

  const buttons = effective.map((contact) => {
    const label = contactChannelLabel(contact.channelKind, locale);

    if (contact.channelKind === 'phone') {
      const tel = contact.channelValue.replace(/[^\d+]/g, '');
      return `<a class="btn" href="tel:${escapeAttribute(tel)}">${escapeHtml(label)} · ${escapeHtml(
        contact.channelValue,
      )}</a>`;
    }
    if (contact.channelKind === 'email') {
      return `<a class="btn" href="mailto:${escapeAttribute(contact.channelValue)}">${escapeHtml(
        label,
      )} · ${escapeHtml(contact.channelValue)}</a>`;
    }
    return `<span class="btn ghost">${escapeHtml(label)} · ${escapeHtml(contact.channelValue)}</span>`;
  });

  const hint = effective[0]?.channelValue ?? '';

  return section({
    id: 'contact',
    title: t(locale, 'contact'),
    hint,
    open,
    body: `<div class="actions">${buttons.join('')}</div>
      <p class="muted small map-note">${escapeHtml(t(locale, 'contactPrivacy'))}</p>`,
  });
}

function renderShare(input: RenderInput, locale: string): string {
  const url = input.publicUrl;
  const qr = input.includeQr
    ? `<div class="qr">${renderQrSvg(url, { cellSize: 4, margin: 2, label: t(locale, 'share') }).svg}</div>`
    : '';

  return section({
    id: 'share',
    title: t(locale, 'share'),
    body: `<div class="share">${qr}
        <div>
          <p class="share-url">${escapeHtml(url)}</p>
          <p class="muted small" style="margin:6px 0 0">${escapeHtml(t(locale, 'shareHint'))}</p>
        </div>
      </div>`,
  });
}

// ---------------------------------------------------------------------------
// 底部固定操作栏（仅手机显示）
// ---------------------------------------------------------------------------

function renderActionBar(input: RenderInput, locale: string, address: string): string {
  if (input.interactive === false) return '';

  const contacts = input.aggregate.contacts.filter(
    (c) => c.isPublic && c.channelValue.trim() !== '',
  );
  const phone = contacts.find((c) => c.channelKind === 'phone');
  const email = contacts.find((c) => c.channelKind === 'email');

  const callHref = phone
    ? `tel:${escapeAttribute(phone.channelValue.replace(/[^\d+]/g, ''))}`
    : email
      ? `mailto:${escapeAttribute(email.channelValue)}`
      : '#contact';

  const mapHref = input.mapView.hasCoordinates
    ? `https://www.openstreetmap.org/?mlat=${input.mapView.latitude}&mlon=${input.mapView.longitude}#map=${input.mapView.zoom}/${input.mapView.latitude}/${input.mapView.longitude}`
    : '#location';

  return `<nav class="appbar" aria-label="${escapeAttribute(t(locale, 'menu'))}">
    <a href="#top">${icon('home')}<span>${escapeHtml(t(locale, 'menuHome'))}</span></a>
    <a href="${callHref}" class="primary">${icon('phone')}<span>${escapeHtml(t(locale, 'menuCall'))}</span></a>
    <button type="button" id="btn-share">${icon('share')}<span>${escapeHtml(t(locale, 'menuShare'))}</span></button>
    <a href="${escapeAttribute(mapHref)}"${input.mapView.hasCoordinates ? ' target="_blank" rel="noopener noreferrer"' : ''}>${icon('map')}<span>${escapeHtml(t(locale, 'menuMap'))}</span></a>
  </nav>`;
}

// ---------------------------------------------------------------------------
// 脚本
// ---------------------------------------------------------------------------

function galleryScript(locale: string, nonce?: string): string {
  const messages = JSON.stringify({ copied: t(locale, 'copied') });

  return `<script${nonceAttribute(nonce)}>
(function () {
  var M = ${messages};
  var gallery = document.getElementById('gallery');
  var counter = document.getElementById('counter');
  var dots = document.getElementById('dots');

  if (gallery) {
    var total = gallery.querySelectorAll('img').length;
    var ticking = false;

    function paint(index) {
      if (counter) counter.textContent = (index + 1) + '/' + total;
      if (dots) {
        var items = dots.children;
        for (var i = 0; i < items.length; i++) items[i].className = i === index ? 'on' : '';
      }
    }

    gallery.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        paint(Math.round(gallery.scrollLeft / gallery.clientWidth));
      });
    }, { passive: true });

    // ---- 自动轮播 ----
    // 只在「多于一张照片」「用户未交互」「页面可见」「未开启减少动效」时运行；
    // 用户一旦手动滑动、点击或悬停就永久停止，不跟用户抢控制权。
    var autoplay = gallery.dataset.autoplay === '1' && total > 1;
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var stopped = false;
    var timer = null;

    function stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    }

    function step() {
      if (stopped || document.hidden) return;
      var index = Math.round(gallery.scrollLeft / gallery.clientWidth);
      var next = (index + 1) % total;
      gallery.scrollTo({ left: next * gallery.clientWidth, behavior: 'smooth' });
    }

    if (autoplay && !reduceMotion) {
      timer = setInterval(step, 4200);
      gallery.addEventListener('pointerdown', stop, { once: true, passive: true });
      gallery.addEventListener('wheel', stop, { once: true, passive: true });
      gallery.addEventListener('touchstart', stop, { once: true, passive: true });
      gallery.addEventListener('mouseenter', stop, { once: true });
    }
  }

  var shareBtn = document.getElementById('btn-share');
  if (shareBtn) {
    shareBtn.addEventListener('click', function () {
      var url = location.href;
      if (navigator.share) {
        navigator.share({ title: document.title, url: url }).catch(function () {});
        return;
      }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          var label = shareBtn.querySelector('span');
          if (!label) return;
          var old = label.textContent;
          label.textContent = M.copied;
          setTimeout(function () { label.textContent = old; }, 1600);
        }).catch(function () {});
      }
    });
  }
})();
</script>`;
}

function nonceAttribute(nonce?: string): string {
  return nonce ? ` nonce="${escapeAttribute(nonce)}"` : '';
}

// ---------------------------------------------------------------------------
// 主渲染
// ---------------------------------------------------------------------------

export function renderListingPage(input: RenderInput): string {
  const locale = input.locale;
  const template = getTemplate(input.templateId);

  const localized = resolveLocalizedText(
    input.aggregate.property,
    input.aggregate.translations,
    locale,
  );

  const address = composeAddress(input.aggregate.property);
  const gallery = renderGallery(input, locale, localized.title);
  const overlay = template.heroLayout === 'overlay';

  const hero = overlay
    ? `<div class="hero-overlay">${gallery}
        <div class="hero-caption">
          <h1>${escapeHtml(localized.title)}</h1>
          <p class="price">${escapeHtml(priceText(input, locale))}</p>
        </div>
      </div>`
    : `<div class="hero-overlay">${gallery}</div>`;

  const summaryHeading = overlay ? '' : `<h1>${escapeHtml(localized.title)}</h1>`;
  const summaryPrice = overlay ? '' : `<p class="price">${escapeHtml(priceText(input, locale))}</p>`;

  const sections = [
    renderAbout(input, locale, localized.description, localized.translated, localized.usedLocale),
    renderCosts(input, locale),
    renderVideos(input, locale),
    renderLocation(input, locale),
    renderNearby(input, locale),
    renderContacts(input, locale, true),
    renderShare(input, locale),
  ]
    .filter((html) => html !== '')
    .join('');

  // 「未确认」时给出明确提示，避免访客误以为房源仍可租
  const availabilityNote = input.availability.stale
    ? `<p class="stale-note">${escapeHtml(
        t(locale, 'stUnconfirmedNote', { days: input.availability.staleDays }),
      )}</p>`
    : '';

  const notice = input.exportNotice
    ? `<p class="notice">${escapeHtml(input.exportNotice)}</p>`
    : '';

  const rtl = /^(ar|he|fa|ur)/i.test(locale) ? ' dir="rtl"' : '';
  const useMap = input.includeMapScript && input.mapView.enabled && input.mapView.hasCoordinates;

  return `<!doctype html>
<html lang="${escapeAttribute(locale)}"${rtl}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(localized.title)}</title>
<meta name="description" content="${escapeAttribute(localized.description.slice(0, 160))}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeAttribute(localized.title)}">
<meta property="og:description" content="${escapeAttribute(localized.description.slice(0, 200))}">
${renderOgImage(input)}
<meta name="generator" content="lightweight-property-listing">
<meta name="theme-color" content="#0f766e">
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,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">
<style${nonceAttribute(input.nonce)}>${BASE_CSS}${template.variantCss}</style>
</head>
<body>
${renderTopNav(input, locale, localized.title)}

<header class="hero" id="top">
  ${hero}
</header>

<section class="summary">
  <div class="wrap">
    ${summaryHeading}
    ${summaryPrice}
    ${availabilityNote}
    <p class="addr">${escapeHtml(address || t(locale, 'noAddress'))}</p>
    ${renderChips(input, locale)}
  </div>
</section>

<main class="sections">
  ${sections || `<p class="body muted" style="padding:14px 12px">${escapeHtml(t(locale, 'noPhotos'))}</p>`}
</main>

${notice}

<footer class="foot">
  <p>${escapeHtml(
    t(locale, 'footerGenerated', {
      time: formatGeneratedAt(input.generatedAt, input.workspace.defaultTimezone, locale),
    }),
  )}</p>
  <p>${escapeHtml(t(locale, 'footerDisclaimer'))}</p>
  <p class="brand">
    <a href="https://zhirai.cloud" target="_blank" rel="noopener noreferrer">${escapeHtml(t(locale, 'brandPowered'))}</a>
    <span aria-hidden="true">·</span>
    ${escapeHtml(t(locale, 'brandSlogan'))}
  </p>
  <p class="brand-rights">${escapeHtml(t(locale, 'brandRights'))}</p>
</footer>

${renderActionBar(input, locale, address)}
${input.includeQr ? '' : ''}
${galleryScript(locale, input.nonce)}
${useMap ? renderMiniMapScript(input.nonce) : ''}
</body>
</html>`;
}

function renderOgImage(input: RenderInput): string {
  const photos = input.aggregate.media.filter((m) => m.kind === 'photo');
  const cover = photos.find((m) => m.isCover) ?? photos[0];
  if (!cover || cover.storageKey === '') return '';

  const base = input.publicUrl.replace(/\/p\/.*$/, '');
  const url = safeUrl(`${base}${mediaUrl(cover.storageKey)}`);
  if (url === '') return '';

  return `<meta property="og:image" content="${escapeAttribute(url)}">`;
}

function formatGeneratedAt(instant: Date, timeZone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(instant);
  } catch {
    return instant.toISOString();
  }
}

/** 未发布 / 不存在时统一返回的页面（不泄露房源是否存在） */
export function renderUnavailablePage(options: {
  status: number;
  title: string;
  message: string;
  locale?: string;
  nonce?: string;
}): string {
  const locale = options.locale ?? 'zh-CN';
  return `<!doctype html>
<html lang="${escapeAttribute(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<style${nonceAttribute(options.nonce)}>${BASE_CSS}</style>
</head>
<body>
<main class="wrap" style="max-width:560px;padding-top:56px">
  <div class="sections" style="border-radius:14px;border:1px solid var(--line)">
    <div class="sec" style="padding:18px">
      <h1 style="font-size:1.2rem">${escapeHtml(options.title)}</h1>
      <p class="muted" style="margin:8px 0 0">${escapeHtml(options.message)}</p>
    </div>
  </div>
</main>
</body>
</html>`;
}