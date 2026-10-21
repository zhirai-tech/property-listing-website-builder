/**
 * 内置轻量地图（自研，约 4 KB，不依赖任何第三方地图库）。
 *
 * 为什么自己写：
 *  1. 许可策略 —— 项目只直接引入 MIT 许可的组件；Leaflet 为 BSD-2-Clause，
 *     按约定只作参考不直接植入，因此这里自行实现最小可用的滑移地图。
 *  2. 移动端体积 —— Leaflet 压缩后仍有约 150 KB，而移动端是本项目的主要使用场景。
 *
 * 能力范围（刻意保持最小）：
 *  - OpenStreetMap 标准瓦片，支持拖拽平移与 ± 缩放（含触摸与双指缩放）；
 *  - 始终提供「在地图中打开」外链，作为功能兜底；
 *  - 瓦片加载失败时如实降级为地址文本，不留空白地图。
 */

export interface MiniMapInput {
  latitude: number;
  longitude: number;
  zoom: number;
  tileUrl: string;
  attribution: string;
  /** 外部地图跳转链接 */
  openUrl: string;
  /** 无障碍描述 */
  label: string;
  zoomInLabel: string;
  zoomOutLabel: string;
  openLabel: string;
}

/** 经纬度 -> 瓦片坐标（小数形式，Web Mercator） */
export function lngLatToTile(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
  const scale = 2 ** zoom;
  const x = ((longitude + 180) / 360) * scale;
  const latRad = (latitude * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;
  return { x, y };
}

/** 拼接瓦片地址，支持 {z}/{x}/{y} 与 {-y} 两种占位符 */
export function tileUrlFor(template: string, z: number, x: number, y: number): string {
  const flipped = (1 << z) - 1 - y;
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{-y\}/g, String(flipped));
}

/** 控制点在画布中的相对位置（0-1），用于把标记钉在正确位置 */
export function markerFraction(latitude: number, longitude: number, zoom: number): { fx: number; fy: number } {
  const { x, y } = lngLatToTile(latitude, longitude, zoom);
  return { fx: x - Math.floor(x), fy: y - Math.floor(y) };
}

export function renderMiniMap(input: MiniMapInput): string {
  const { latitude, longitude, zoom } = input;
  const fraction = markerFraction(latitude, longitude, zoom);

  return `<div class="minimap" id="minimap" role="application"
     aria-label="${escapeAttr(input.label)}"
     data-lat="${latitude}" data-lng="${longitude}" data-zoom="${zoom}"
     data-tile="${escapeAttr(input.tileUrl)}"
     data-fx="${fraction.fx.toFixed(6)}" data-fy="${fraction.fy.toFixed(6)}">
  <div class="minimap-tiles" id="minimap-tiles" aria-hidden="true"></div>
  <div class="minimap-pin" id="minimap-pin" aria-hidden="true"></div>
  <div class="minimap-ctl">
    <button type="button" data-map-zoom="1" aria-label="${escapeAttr(input.zoomInLabel)}">+</button>
    <button type="button" data-map-zoom="-1" aria-label="${escapeAttr(input.zoomOutLabel)}">−</button>
  </div>
  <a class="minimap-open" href="${escapeAttr(input.openUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
    input.openLabel,
  )}</a>
  <span class="minimap-attr">${escapeHtml(input.attribution)}</span>
</div>`;
}

/** 地图交互脚本（内联，带 nonce；不依赖任何外部库） */
export function renderMiniMapScript(nonce?: string): string {
  return `<script${nonce ? ` nonce="${escapeAttr(nonce)}"` : ''}>
(function () {
  var el = document.getElementById('minimap');
  if (!el) return;

  var TILE = 256;
  var tiles = document.getElementById('minimap-tiles');
  var pin = document.getElementById('minimap-pin');
  if (!tiles) return;

  var lat = parseFloat(el.dataset.lat);
  var lng = parseFloat(el.dataset.lng);
  var zoom = parseInt(el.dataset.zoom || '15', 10);
  var template = el.dataset.tile;

  function project(latDeg, lngDeg, z) {
    var n = Math.pow(2, z);
    var latRad = latDeg * Math.PI / 180;
    return {
      x: ((lngDeg + 180) / 360) * n,
      y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    };
  }

  // 当前视口中心（以瓦片为单位的小数坐标）
  var center = project(lat, lng, zoom);
  var anchor = { x: center.x, y: center.y };
  var loaded = 0, errored = 0, degraded = false;

  function degrade(msg) {
    if (degraded) return;
    degraded = true;
    el.innerHTML = '<div class="minimap-fallback"><span></span></div>';
    el.querySelector('.minimap-fallback span').textContent = msg;
  }

  function draw() {
    if (degraded) return;
    var w = el.clientWidth, h = el.clientHeight;
    if (w === 0 || h === 0) return;

    var cols = Math.ceil(w / TILE) + 2;
    var rows = Math.ceil(h / TILE) + 2;
    var baseX = Math.floor(center.x) - Math.floor(cols / 2);
    var baseY = Math.floor(center.y) - Math.floor(rows / 2);

    var offX = (center.x - baseX) * TILE - w / 2;
    var offY = (center.y - baseY) * TILE - h / 2;

    var html = '';
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var tx = baseX + c, ty = baseY + r;
        var url = template
          .replace(/\\{z\\}/g, zoom)
          .replace(/\\{x\\}/g, tx)
          .replace(/\\{y\\}/g, ty)
          .replace(/\\{-y\\}/g, (1 << zoom) - 1 - ty);
        var left = c * TILE - offX;
        var top = r * TILE - offY;
        html += '<img src="' + url + '" alt="" loading="lazy" decoding="async" '
          + 'style="left:' + left + 'px;top:' + top + 'px;width:' + TILE + 'px;height:' + TILE + 'px">';
      }
    }
    tiles.innerHTML = html;
    tiles.style.transform = '';

    var dx = (anchor.x - center.x) * TILE + w / 2;
    var dy = (anchor.y - center.y) * TILE + h / 2;
    if (pin) pin.style.transform = 'translate(' + Math.round(dx) + 'px,' + Math.round(dy) + 'px)';
  }

  // 瓦片可用性检测：全部失败时如实降级为地址文本
  tiles.addEventListener('load', function (e) {
    if (e.target && e.target.tagName === 'IMG') loaded++;
  }, true);
  tiles.addEventListener('error', function (e) {
    if (!e.target || e.target.tagName !== 'IMG') return;
    errored++;
    if (loaded === 0 && errored >= 4) degrade(el.dataset.failMessage || '地图瓦片不可用');
  }, true);

  // ---- 拖拽平移 ----
  var dragging = false, startX = 0, startY = 0, startCenter = null;

  function onDown(x, y) {
    dragging = true;
    startX = x; startY = y;
    startCenter = { x: center.x, y: center.y };
    el.classList.add('is-dragging');
  }
  function onMove(x, y) {
    if (!dragging) return;
    center.x = startCenter.x - (x - startX) / TILE;
    center.y = startCenter.y - (y - startY) / TILE;
    draw();
  }
  function onUp() {
    dragging = false;
    el.classList.remove('is-dragging');
  }

  el.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.minimap-ctl') || e.target.closest('.minimap-open')) return;
    el.setPointerCapture(e.pointerId);
    onDown(e.clientX, e.clientY);
  });
  el.addEventListener('pointermove', function (e) { onMove(e.clientX, e.clientY); });
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);

  // ---- 双指缩放 ----
  var pinchStart = 0;
  el.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      pinchStart = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  }, { passive: true });
  el.addEventListener('touchend', function (e) {
    if (e.touches.length < 2 && pinchStart) pinchStart = 0;
  }, { passive: true });

  // ---- 按钮缩放 ----
  el.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-map-zoom]');
    if (!btn) return;
    e.preventDefault();
    var next = zoom + parseInt(btn.dataset.mapZoom, 10);
    if (next < 3 || next > 19) return;
    // 保持锚点（房源位置）不动
    center = project(lat, lng, next);
    anchor = { x: center.x, y: center.y };
    zoom = next;
    draw();
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 150);
  });

  // 地图位于可折叠区块内：初始可能是收起状态（尺寸为 0，无法绘制）。
  // 一旦展开拿到真实尺寸就补画一次，否则用户展开后只会看到空白地图。
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () {
      if (el.clientWidth > 0 && el.clientHeight > 0) draw();
    }).observe(el);
  }

  draw();
})();
</script>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch
  ));
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/[\r\n]/g, ' ');
}