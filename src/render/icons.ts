/**
 * 内置矢量图标（自研，MIT）。
 *
 * 为什么自己写而不用图标库：
 *  - 许可纪律 —— 项目只直接引入 MIT 组件。自研图标不存在任何第三方授权问题，
 *    也不需要随包分发 LICENSE 或署名；
 *  - 体积 —— 全站只用 8 个图标，引入整套图标库得不偿失；
 *  - 统一 —— 同一份路径数据同时供服务端渲染（本文件）与后台 SPA（public/admin/icons.js）使用。
 *
 * 约定：
 *  - 24x24 视图框，纯描边（stroke=currentColor），因此颜色跟随文字，无需额外 CSS；
 *  - 图形全部由直线、圆、圆弧等基础几何构成，无第三方素材；
 *  - 旁边通常已有文字标签，所以默认 aria-hidden，避免读屏重复朗读。
 */

export type IconName =
  | 'home'
  | 'page'
  | 'bell'
  | 'settings'
  | 'backup'
  | 'phone'
  | 'share'
  | 'map'
  | 'back'
  | 'edit';

/** 各图标的 SVG 路径（仅内部元素，外层 <svg> 由 icon() 统一生成） */
export const ICON_PATHS: Record<IconName, string> = {
  // 房子：屋顶 + 墙体 + 门
  home:
    '<path d="M3 10.4 12 3.3l9 7.1"/>' +
    '<path d="M5.7 9.2V19a1.5 1.5 0 0 0 1.5 1.5h9.6A1.5 1.5 0 0 0 18.3 19V9.2"/>' +
    '<path d="M9.8 20.5v-5.2h4.4v5.2"/>',

  // 文档：纸页 + 折角 + 文字行
  page:
    '<path d="M14 3.2H7.5A1.8 1.8 0 0 0 5.7 5v14a1.8 1.8 0 0 0 1.8 1.8h9A1.8 1.8 0 0 0 18.3 19V7.8Z"/>' +
    '<path d="M14 3.2v4.6h4.3"/>' +
    '<path d="M9 12.4h6M9 16h4.2"/>',

  // 铃铛：钟身 + 底部摆锤
  bell:
    '<path d="M6.2 9.5a5.8 5.8 0 0 1 11.6 0c0 3.9 1.4 5.3 1.4 5.3H4.8s1.4-1.4 1.4-5.3Z"/>' +
    '<path d="M10.2 18.2a2 2 0 0 0 3.6 0"/>',

  // 设置：中心圆 + 八根辐条
  settings:
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M12 2.6v2.3M12 19.1v2.3M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.6 12h2.3M19.1 12h2.3M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',

  // 备份：数据库三层叠放
  backup:
    '<ellipse cx="12" cy="6.2" rx="7" ry="3"/>' +
    '<path d="M5 6.2v5.6c0 1.7 3.1 3 7 3s7-1.3 7-3V6.2"/>' +
    '<path d="M5 11.8v5.6c0 1.7 3.1 3 7 3s7-1.3 7-3v-5.6"/>',

  // 返回：左向箭头
  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',

  // 编辑：铅笔 + 笔尖分隔线
  edit:
    '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/>' +
    '<path d="M13.6 6.4 16.6 9.4"/>',

  // 电话：话筒
  phone:
    '<path d="M7.2 3.4h2.4l1.6 4.1-2 1.5a11.4 11.4 0 0 0 5.3 5.3l1.5-2 4.1 1.6v2.4a2.8 2.8 0 0 1-3.1 2.8A15.6 15.6 0 0 1 4.4 6.5a2.8 2.8 0 0 1 2.8-3.1Z"/>',

  // 分享：三个节点 + 连线
  share:
    '<circle cx="17.5" cy="6" r="2.6"/>' +
    '<circle cx="6.5" cy="12" r="2.6"/>' +
    '<circle cx="17.5" cy="18" r="2.6"/>' +
    '<path d="m8.8 10.7 6.4-3.4M8.8 13.3l6.4 3.4"/>',

  // 定位：水滴形图钉
  map:
    '<path d="M12 21.2s6.8-5.8 6.8-10.8a6.8 6.8 0 1 0-13.6 0c0 5 6.8 10.8 6.8 10.8Z"/>' +
    '<circle cx="12" cy="10.2" r="2.5"/>',
};

export interface IconOptions {
  /** 像素尺寸（正方形），默认 22 */
  size?: number;
  className?: string;
  /** 提供后作为可访问名称（role=img）；不提供则视为装饰性图标 */
  title?: string;
}

/** 生成一个内联 <svg> 图标 */
export function icon(name: IconName, options: IconOptions = {}): string {
  const size = options.size ?? 22;
  const cls = options.className ? ` class="${escapeAttribute(options.className)}"` : '';
  const a11y = options.title
    ? ` role="img" aria-label="${escapeAttribute(options.title)}"`
    : ' aria-hidden="true"';

  return (
    `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' +
    `${a11y}>${ICON_PATHS[name]}</svg>`
  );
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}