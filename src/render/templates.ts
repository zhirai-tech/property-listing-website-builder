/**
 * 展示模板（方案第 3 阶段：提供模板选择）。
 *
 * 设计取向（移动端优先）：
 *  - 手机是主要使用场景，默认样式即手机版；桌面版只是加宽与分栏，不是两套结构；
 *  - 页面必须紧凑：多用折叠区块（原生 <details>，无需 JS）、信息用胶囊标签横排，
 *    避免长卡片堆叠导致要滚动很久；
 *  - 底部固定操作栏，手机上一屏内即可拨号、分享、看地图。
 *
 * 模板以 TypeScript 定义而非独立 HTML 文件：避免自研模板引擎的转义风险，
 * 同时便于导出静态 HTML 时内联样式。
 *
 * 视觉结构参考了单房源展示页的常见信息分区，但代码与图片均为自行实现/CC0，
 * 未复制任何第三方模板资源。
 */

import type { TemplateId } from '../domain/types.ts';

export interface TemplateDefinition {
  id: TemplateId;
  name: string;
  description: string;
  variantCss: string;
  /** 首图区布局 */
  heroLayout: 'overlay' | 'stacked' | 'plain';
  showQr: boolean;
}

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --accent:#0f766e;--accent-soft:#ccfbf1;--ink:#0f172a;--muted:#64748b;
  --line:#e6e9ee;--bg:#f4f5f7;--card:#fff;--radius:14px;--maxw:1080px;
}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.55;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
  -webkit-font-smoothing:antialiased;
}
img{max-width:100%;display:block}
a{color:var(--accent);text-decoration:none}
h1,h2,h3{margin:0;line-height:1.3}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 12px}
.muted{color:var(--muted)}
.small{font-size:.82rem}
.prose{white-space:pre-wrap;word-break:break-word}

/* ---------- 图集：手机可左右滑动，不再堆叠缩略图 ---------- */
.hero{background:#0b1220}
.gallery{position:relative;display:flex;overflow-x:auto;scroll-snap-type:x mandatory;
  -webkit-overflow-scrolling:touch;scrollbar-width:none;overscroll-behavior-x:contain}
.gallery::-webkit-scrollbar{display:none}
.gallery img{flex:0 0 100%;scroll-snap-align:center;aspect-ratio:4/3;object-fit:cover;background:#1e293b}
.gallery-empty{aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;color:#94a3b8;background:#111827}
.hero-overlay{position:relative}
.hero-media{position:relative}
.hero-caption{position:absolute;left:0;right:0;bottom:0;max-width:var(--maxw);margin:0 auto;padding:26px 12px 12px;
  background:linear-gradient(to top,rgba(3,7,18,.88),rgba(3,7,18,0));color:#fff;pointer-events:none}
.hero-caption h1{font-size:1.25rem;margin:0 0 2px;color:#fff}
.hero-caption .price{font-size:1.15rem;font-weight:700;margin:0}
.counter{position:absolute;top:10px;right:10px;background:rgba(3,7,18,.6);color:#fff;
  font-size:.72rem;padding:3px 9px;border-radius:999px;backdrop-filter:blur(4px)}
.dots{position:absolute;left:0;right:0;bottom:6px;display:flex;gap:5px;justify-content:center}
.dots i{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.45)}
.dots i.on{background:#fff;width:14px;border-radius:3px}

/* ---------- 紧凑信息条 ---------- */
.summary{background:var(--card);border-bottom:1px solid var(--line)}
.summary .wrap{padding:12px 12px 10px}
.summary h1{font-size:1.15rem;margin-bottom:4px}
.summary .price{font-size:1.3rem;font-weight:700;color:var(--accent)}
.summary .addr{color:var(--muted);font-size:.85rem;margin:4px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.chips li{background:var(--bg);border:1px solid var(--line);border-radius:999px;
  padding:3px 10px;font-size:.8rem;white-space:nowrap}
.chips b{font-weight:600}
.chips span{color:var(--muted);margin-right:4px}

/* ---------- 折叠区块（原生 details，无 JS） ---------- */
.sections{background:var(--card);margin:8px auto 0;max-width:var(--maxw);
  border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.sec{border-bottom:1px solid var(--line)}
.sec:last-child{border-bottom:0}
.sec>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:13px 12px;font-weight:600;font-size:.95rem;cursor:pointer;list-style:none;
  -webkit-tap-highlight-color:transparent}
.sec>summary::-webkit-details-marker{display:none}
.sec>summary::after{content:"";flex:none;width:7px;height:7px;margin-right:2px;
  border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);
  transform:rotate(45deg);transition:transform .18s}
.sec[open]>summary::after{transform:rotate(-135deg)}
.sec>summary .hint{color:var(--muted);font-weight:400;font-size:.82rem;margin-left:auto;margin-right:4px;
  max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sec .body{padding:0 12px 14px}
.sec[open]>summary{border-bottom:1px dashed var(--line)}

/* ---------- 键值行 ---------- */
.kv{margin:0}
.kv>div{display:flex;justify-content:space-between;gap:14px;padding:6px 0;border-bottom:1px dashed var(--line)}
.kv>div:last-child{border-bottom:0}
.kv dt{color:var(--muted);flex:none}
.kv dd{margin:0;text-align:right;font-weight:500;word-break:break-word}

/* ---------- 联系方式 / 按钮 ---------- */
.actions{display:flex;flex-wrap:wrap;gap:8px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  min-height:42px;padding:9px 16px;border-radius:999px;text-decoration:none;
  background:var(--accent);color:#fff;font-weight:600;font-size:.92rem;border:1px solid var(--accent)}
.btn.ghost{background:transparent;color:var(--accent)}
.btn:focus-visible{outline:3px solid var(--accent-soft);outline-offset:2px}


/* ---------- 内置地图 ---------- */
.minimap{position:relative;height:220px;border:1px solid var(--line);border-radius:var(--radius);
  overflow:hidden;background:var(--bg);touch-action:none;cursor:grab}
.minimap.is-dragging{cursor:grabbing}
.minimap-tiles{position:absolute;inset:0}
.minimap-tiles img{position:absolute;user-select:none;-webkit-user-drag:none}
.minimap-pin{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}
.minimap-pin::after{content:"";position:absolute;left:-7px;top:-7px;width:14px;height:14px;
  border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:var(--accent);
  border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)}
.minimap-ctl{position:absolute;right:8px;top:8px;display:flex;flex-direction:column;gap:6px}
.minimap-ctl button{width:34px;height:34px;border:1px solid var(--line);border-radius:9px;background:#fff;
  font-size:1.1rem;line-height:1;cursor:pointer;color:var(--ink)}
.minimap-open{position:absolute;left:8px;bottom:8px;background:rgba(255,255,255,.94);
  border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:.78rem}
.minimap-attr{position:absolute;right:6px;bottom:5px;font-size:.66rem;color:#475569;
  background:rgba(255,255,255,.85);padding:1px 5px;border-radius:4px}
.minimap-fallback{display:flex;align-items:center;gap:8px;height:100%;padding:14px;
  background:var(--bg);border:1px dashed var(--line);font-size:.85rem;color:var(--muted)}
.map-note{margin-top:8px}

/* ---------- 分享 ---------- */
.share{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.share .qr{background:#fff;padding:8px;border:1px solid var(--line);border-radius:10px;line-height:0;flex:none}
.share .qr svg{width:104px;height:104px}
.share-url{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem}


/* ---------- 视频 ---------- */
.media-video{width:100%;border-radius:10px;background:#000}


/* ---------- 顶部栏：标题 + 语言切换 ---------- */
.topnav{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.97);
  border-bottom:1px solid var(--line);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.topnav-inner{max-width:var(--maxw);margin:0 auto;padding:8px 12px;
  display:flex;align-items:center;gap:10px;min-height:48px}
.topnav-title{flex:1 1 auto;min-width:0;font-weight:600;font-size:.92rem;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.langbar{display:flex;gap:6px;flex:none;margin:0}
.langbar a{font-size:.78rem;padding:4px 10px;border:1px solid var(--line);border-radius:999px;
  color:var(--muted);text-decoration:none;white-space:nowrap}
.langbar a[aria-current="true"]{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600}

/* ---------- 主图状态标签 ---------- */
.hero-badge{position:absolute;left:10px;top:10px;z-index:3;display:inline-flex;align-items:center;gap:5px;
  padding:4px 12px;border-radius:999px;font-size:.8rem;font-weight:700;color:#fff;
  box-shadow:0 2px 8px rgba(0,0,0,.28)}
.hero-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9}
.hero-badge.st-available{background:#16a34a}
.hero-badge.st-rented{background:#475569}
.hero-badge.st-unconfirmed{background:#d97706}
.hero-badge.st-available::before{animation:badgePulse 2.4s ease-in-out infinite}
@keyframes badgePulse{0%,100%{opacity:.9}50%{opacity:.35}}
.stale-note{margin:6px 0 0;padding:7px 10px;border-radius:9px;font-size:.8rem;
  background:#fffbeb;border:1px solid #fde68a;color:#92400e}

/* ---------- 底部菜单栏（仅手机） ---------- */
.appbar{position:fixed;left:0;right:0;bottom:0;z-index:30;display:flex;
  background:rgba(255,255,255,.98);border-top:1px solid var(--line);
  padding-bottom:env(safe-area-inset-bottom);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.appbar a,.appbar button{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
  min-height:56px;border:0;background:transparent;color:var(--muted);font:inherit;font-size:.7rem;
  text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent;padding:0}
.appbar svg{display:block;width:22px;height:22px}
.appbar a.primary{color:var(--accent);font-weight:700}
body{padding-bottom:calc(56px + env(safe-area-inset-bottom))}
/* ---------- 页脚 ---------- */
.foot{padding:16px 12px 22px;text-align:center;color:var(--muted);font-size:.75rem;max-width:var(--maxw);margin:0 auto}
.foot p{margin:2px 0}
.foot .brand{margin-top:8px;font-size:.78rem}
.foot .brand a{color:var(--accent);text-decoration:none}
.foot .brand span{margin:0 5px;color:var(--line)}
.foot .brand-rights{font-size:.72rem;opacity:.75}
.notice{margin:0;padding:10px 12px;background:#fffbeb;border-top:1px solid #fde68a;
  border-bottom:1px solid #fde68a;color:#92400e;font-size:.8rem}
.nearby-list{list-style:none;padding:0;margin:0;display:grid;gap:6px}
.nearby-list li{display:flex;justify-content:space-between;gap:10px;padding:6px 10px;
  background:var(--bg);border-radius:9px;font-size:.86rem}
.nearby-list .cat{color:var(--muted);font-size:.78rem;flex:none}

/* ---------- 平板 / 桌面：加宽与分栏，结构不变 ---------- */
@media (min-width:720px){
  body{font-size:16px}
  .wrap{padding:0 20px}
  .gallery img{aspect-ratio:16/9}
  .hero-caption{padding:40px 12px 18px}
  .hero-caption h1{font-size:1.9rem}
  .hero-caption .price{font-size:1.5rem}
  .summary .wrap{padding:16px 12px 14px}
  .summary h1{font-size:1.4rem}
  .sections{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-top:12px}
  .sec>summary{padding:15px 12px}
  .sec .body{padding:0 12px 16px}
  .minimap{height:300px}
  .share .qr svg{width:128px;height:128px}
}
@media (min-width:900px){
  body{padding-bottom:0}
  .appbar{display:none}
  .hero-caption h1{font-size:2.1rem}
}
@media (max-width:520px){
  /* 键值行保持左右两栏：标签不收缩，数值换行，这样最省纵向空间 */
  .kv>div{gap:10px}
  .kv dt{font-size:.85rem}
  .kv dd{font-size:.88rem}
  .chips li{font-size:.76rem;padding:3px 9px}
  .sec>summary{padding:12px}
  .sec .body{padding:0 12px 12px}
}
@media print{
  .gallery,.minimap,.share .qr,.topnav,.appbar,.dots,.counter{display:none!important}
  body{background:#fff;padding-bottom:0}
  .sec{border-color:#ddd}
  .sec .body{display:block!important}
}
`;

export const TEMPLATES: Record<TemplateId, TemplateDefinition> = {
  modern: {
    id: 'modern',
    name: '现代卡片',
    description: '圆角卡片、青绿强调色，图片横向滑动，适合长租与短租。',
    heroLayout: 'overlay',
    showQr: true,
    variantCss: `
:root{--accent:#0f766e;--accent-soft:#ccfbf1;--radius:14px}
`,
  },
  classic: {
    id: 'classic',
    name: '经典稳重',
    description: '衬线标题、深蓝强调色，图片在上标题在下，适合买卖房源。',
    heroLayout: 'stacked',
    showQr: true,
    variantCss: `
:root{--accent:#1e3a8a;--accent-soft:#dbeafe;--radius:8px;--bg:#f5f3ef}
h1,h2,.summary h1{font-family:Georgia,"Songti SC","SimSun",serif}
`,
  },
  minimal: {
    id: 'minimal',
    name: '极简文字',
    description: '低对比排版、无大图，适合网络较慢或需要打印的场景。',
    heroLayout: 'plain',
    showQr: false,
    variantCss: `
:root{--accent:#111827;--accent-soft:#f3f4f6;--radius:4px;--bg:#fff}
.sections,.summary{border-color:#e5e7eb}
.gallery img{aspect-ratio:21/9;max-height:200px}
`,
  },
};

export function getTemplate(id: string): TemplateDefinition {
  return TEMPLATES[id as TemplateId] ?? TEMPLATES.modern;
}

export function listTemplates(): TemplateDefinition[] {
  return Object.values(TEMPLATES);
}

export { BASE_CSS };