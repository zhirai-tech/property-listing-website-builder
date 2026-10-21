/**
 * 二维码渲染（方案第三章第 3 条：提供唯一分享链接及二维码）。
 *
 * 使用 MIT 许可的 qrcode-generator（Kazuhiko Arase）生成矩阵，
 * 再由本项目渲染为内联 SVG —— 这样导出的静态 HTML 无需联网也能显示二维码。
 * 许可证归档见 docs/licenses.md。
 */

import qrcode from 'qrcode-generator';

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrOptions {
  /** 每个模块的像素尺寸 */
  cellSize?: number;
  /** 静默区宽度（模块数），QR 规范建议至少 4 */
  margin?: number;
  errorCorrection?: QrErrorCorrection;
  /** 无障碍标签 */
  label?: string;
}

export interface QrResult {
  svg: string;
  moduleCount: number;
  /** 版本号 = (moduleCount - 17) / 4 */
  version: number;
}

/**
 * 生成二维码 SVG。
 * 使用矢量路径（rect 合并）而不是逐模块 rect，体积更小。
 */
export function renderQrSvg(text: string, options: QrOptions = {}): QrResult {
  const cellSize = options.cellSize ?? 4;
  const margin = options.margin ?? 4;
  const errorCorrection = options.errorCorrection ?? 'M';

  // typeNumber 0 = 自动选择最小可容纳版本
  const qr = qrcode(0, errorCorrection);
  qr.addData(text);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const size = (moduleCount + margin * 2) * cellSize;

  // 逐行合并连续深色模块，减少路径指令数量
  const segments: string[] = [];
  for (let row = 0; row < moduleCount; row += 1) {
    let col = 0;
    while (col < moduleCount) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < moduleCount && qr.isDark(row, col)) col += 1;
      const width = col - start;
      const x = (start + margin) * cellSize;
      const y = (row + margin) * cellSize;
      segments.push(`M${x} ${y}h${width * cellSize}v${cellSize}h${-width * cellSize}z`);
    }
  }

  const label = options.label ?? '分享二维码';

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeAttr(label)}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path d="${segments.join('')}" fill="#111827"/>`,
    '</svg>',
  ].join('');

  return {
    svg,
    moduleCount,
    version: (moduleCount - 17) / 4,
  };
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
