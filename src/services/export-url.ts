/**
 * 导出时的资源引用改写。
 *
 * 【修的是什么】
 * 原先导出只有一行：
 *
 *     html.replaceAll('/media/', 'assets/')
 *
 * 这对**站内相对路径**是对的：
 *
 *     <img src="/media/prp_x/a.png">   →  assets/prp_x/a.png        ✅
 *
 * 但对**完整 URL** 是错的 —— `replaceAll` 不认 URL 边界：
 *
 *     <meta property="og:image" content="http://host:3210/media/prp_x/a.png">
 *       →  http://host:3210assets/prp_x/a.png                       ❌ 缺斜杠
 *
 * 那个地址在任何环境下都解析不了。og:image 正是这样产生的：
 * `page-renderer.ts` 用 `publicUrl` 去掉 `/p/<slug>` 得到基址，
 * 再拼上 `mediaUrl()`，于是拿到一个**绝对 URL**。
 *
 * 【怎么修的】
 * 按 URL 边界识别三类引用，分别处理：
 *
 *   1. `http(s)://<本站>/media/<key>`  → `assets/<key>`（去掉 origin，变相对路径）
 *   2. `//<本站>/media/<key>`          → `assets/<key>`
 *   3. `/media/<key>`                  → `assets/<key>`
 *   4. 指向**别的站点**的绝对 URL       → 原样保留（那不是我们的资源，
 *                                        改了会指向导出包里不存在的文件）
 *
 * 【未知资源不猜】
 * 只有**确实已经打进导出包**的 key 才会被改写（`exportedKeys`）。
 * 引用了一个没被打包的 key 时：**保持原样并记入 `missing`** ——
 * 悄悄改成 `assets/<key>` 会生成一个「看起来有效、实际加载不到」的地址，
 * 那比留着一个明显的平台路径更糟。
 */

/** 与「资源引用」相关的匹配：完整 URL、协议相对 URL、站内 /media/ 路径 */
const MEDIA_REFERENCE = /https?:\/\/[^\s"'<>()\\]+|\/\/[^\s"'<>()\\]+|\/media\/[^\s"'<>()\\]*/g;

/** 从 `/media/<key>` 里取出已解码的 key（去掉查询串与片段） */
function keyFromMediaPath(path: string): string | null {
  if (!path.startsWith('/media/')) return null;
  const withoutQuery = path.slice('/media/'.length).split(/[?#]/)[0] ?? '';
  if (withoutQuery === '') return null;
  try {
    return withoutQuery
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    // 非法的百分号编码：不猜，交给调用方按「未打包资源」处理
    return null;
  }
}

/** 取 `scheme://host[:port]` 形式的 origin；解析不了返回 null */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export interface RewriteOptions {
  /** 视为「本站」的 origin 集合，例如 http://127.0.0.1:3210 */
  origins: readonly string[];
  /** 已经打进导出包的资源 key（storageKey） */
  exportedKeys: ReadonlySet<string>;
}

export interface RewriteResult {
  html: string;
  /** 成功改写为相对路径的引用数 */
  rewritten: number;
  /** 引用了 /media/ 但不在导出包里的 key（已保持原样，供调用方提示用户） */
  missing: string[];
}

/** 把导出的 HTML 里指向本站媒体资源的引用改写为相对路径 */
export function rewriteMediaReferences(html: string, options: RewriteOptions): RewriteResult {
  const originSet = new Set(options.origins.filter((o) => o !== ''));
  let rewritten = 0;
  const missing = new Set<string>();

  const output = html.replace(MEDIA_REFERENCE, (match) => {
    const isAbsolute = /^https?:\/\//i.test(match);
    const isProtocolRelative = match.startsWith('//');

    let mediaPath: string;
    if (isAbsolute || isProtocolRelative) {
      // 只处理指向本站的绝对 URL。外部站点的资源保持原样 ——
      // 它们本来就不在导出包里，改写只会产生更糟的结果。
      const origin = originOf(isAbsolute ? match : `http:${match}`);
      if (origin === null || !originSet.has(origin)) return match;
      const pathStart = match.indexOf('/', match.indexOf('//') + 2);
      if (pathStart < 0) return match;
      mediaPath = match.slice(pathStart);
    } else {
      mediaPath = match;
    }

    if (!mediaPath.startsWith('/media/')) return match;

    // 分离查询串与片段：它们要原样保留
    const suffixIndex = mediaPath.search(/[?#]/);
    const suffix = suffixIndex >= 0 ? mediaPath.slice(suffixIndex) : '';
    const barePath = suffixIndex >= 0 ? mediaPath.slice(0, suffixIndex) : mediaPath;

    const key = keyFromMediaPath(barePath);
    if (key === null) return match;

    if (!options.exportedKeys.has(key)) {
      // 没有被打进导出包 —— 保持原样，并记下来让调用方提示
      missing.add(key);
      return match;
    }

    rewritten += 1;
    return `assets/${barePath.slice('/media/'.length)}${suffix}`;
  });

  return { html: output, rewritten, missing: [...missing] };
}

/** 站内媒体路径用的 origin 集合（用于判断绝对 URL 是否指向本站） */
export function mediaOrigins(...urls: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const url of urls) {
    if (typeof url !== 'string' || url === '') continue;
    const origin = originOf(url);
    if (origin !== null) out.add(origin);
  }
  return [...out];
}