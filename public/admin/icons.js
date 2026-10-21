/**
 * 内置矢量图标（后台 SPA 版本）。
 *
 * 路径数据与 src/render/icons.ts 保持一致 —— 同一套自研图标，
 * 服务端渲染与前端渲染各用一份实现，图案必须完全相同。
 * （一致性由 tests/domain/icons.test.ts 断言，避免两边改歪。）
 */

export const ICON_PATHS = {
  home:
    '<path d="M3 10.4 12 3.3l9 7.1"/>' +
    '<path d="M5.7 9.2V19a1.5 1.5 0 0 0 1.5 1.5h9.6A1.5 1.5 0 0 0 18.3 19V9.2"/>' +
    '<path d="M9.8 20.5v-5.2h4.4v5.2"/>',

  page:
    '<path d="M14 3.2H7.5A1.8 1.8 0 0 0 5.7 5v14a1.8 1.8 0 0 0 1.8 1.8h9A1.8 1.8 0 0 0 18.3 19V7.8Z"/>' +
    '<path d="M14 3.2v4.6h4.3"/>' +
    '<path d="M9 12.4h6M9 16h4.2"/>',

  bell:
    '<path d="M6.2 9.5a5.8 5.8 0 0 1 11.6 0c0 3.9 1.4 5.3 1.4 5.3H4.8s1.4-1.4 1.4-5.3Z"/>' +
    '<path d="M10.2 18.2a2 2 0 0 0 3.6 0"/>',

  settings:
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M12 2.6v2.3M12 19.1v2.3M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.6 12h2.3M19.1 12h2.3M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',

  backup:
    '<ellipse cx="12" cy="6.2" rx="7" ry="3"/>' +
    '<path d="M5 6.2v5.6c0 1.7 3.1 3 7 3s7-1.3 7-3V6.2"/>' +
    '<path d="M5 11.8v5.6c0 1.7 3.1 3 7 3s7-1.3 7-3v-5.6"/>',

  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',

  phone:
    '<path d="M7.2 3.4h2.4l1.6 4.1-2 1.5a11.4 11.4 0 0 0 5.3 5.3l1.5-2 4.1 1.6v2.4a2.8 2.8 0 0 1-3.1 2.8A15.6 15.6 0 0 1 4.4 6.5a2.8 2.8 0 0 1 2.8-3.1Z"/>',

  share:
    '<circle cx="17.5" cy="6" r="2.6"/>' +
    '<circle cx="6.5" cy="12" r="2.6"/>' +
    '<circle cx="17.5" cy="18" r="2.6"/>' +
    '<path d="m8.8 10.7 6.4-3.4M8.8 13.3l6.4 3.4"/>',

  map:
    '<path d="M12 21.2s6.8-5.8 6.8-10.8a6.8 6.8 0 1 0-13.6 0c0 5 6.8 10.8 6.8 10.8Z"/>' +
    '<circle cx="12" cy="10.2" r="2.5"/>',

  edit:
    '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/>' +
    '<path d="M13.6 6.4 16.6 9.4"/>',

  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
};

/** 生成一个内联 <svg> 图标；旁边已有文字标签时保持装饰性 */
export function icon(name, options = {}) {
  const size = options.size ?? 22;
  const cls = options.className ? ` class="${options.className}"` : '';
  const a11y = options.title ? ` role="img" aria-label="${options.title}"` : ' aria-hidden="true"';
  return (
    `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' +
    `${a11y}>${ICON_PATHS[name]}</svg>`
  );
}