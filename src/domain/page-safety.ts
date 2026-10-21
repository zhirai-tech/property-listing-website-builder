/**
 * AI 生成页面的**安全校验门**。
 *
 * 【为什么这是模式 B 最关键的一个文件】
 * 模式 B 让模型直接产出 HTML —— 这是整个平台里唯一一处
 * 「外部产生的内容会作为网页被浏览器执行」的地方。
 * 校验不通过就**必须拒绝保存**，绝不能先把坏页面存下来再想办法。
 *
 * 【本项目的威胁模型】
 * 生成结果会出现在两个地方：
 *   1. 平台内的预览（与平台**同源**）
 *   2. 用户下载后自己部署的站点
 * 第 1 条是关键：同源意味着生成页面里的脚本可以读写平台的 Cookie 与接口。
 * 因此规则刻意定得很紧 —— **一律不允许任何脚本**，而不是靠过滤关键字。
 *
 * 【设计原则：白名单而非黑名单】
 * 黑名单（「过滤掉 eval / alert / ...」）永远列不全。
 * 这里的做法是：**先禁止整类能力**（脚本、事件处理器、嵌套文档），
 * 再对剩下的东西做结构检查。宁可拒绝一个本来无害的页面，
 * 也不要放行一个能执行脚本的页面。
 */

/** 生成页面的体量上限 */
export const MAX_GENERATED_PAGE_BYTES = 256 * 1024;

export interface PageIssue {
  /** 面向用户的说明 */
  message: string;
  /** 命中的规则名，便于日志与测试断言 */
  rule: string;
}

export type PageValidation =
  | { ok: true; html: string }
  | { ok: false; issues: PageIssue[] };

/**
 * 被整类禁止的标签。
 *
 * 逐个说明为什么：
 *  - script      ：能在同源预览里读写平台数据（最严重的一条）
 *  - iframe/frame/object/embed：可嵌套加载外部文档，绕过本文件的其它检查
 *  - base        ：能改写页面内所有相对链接的基准，进而劫持所有资源
 *  - form        ：能向外部地址提交数据（钓鱼/外传）
 *  - meta        ：`http-equiv=refresh` 可以立刻跳转到外部站点
 *  - link        ：能引入外部样式表与预加载，也是外传通道
 *  - style       ：见下方注释 —— 允许，但要求不含 url() 外链
 *  - svg         ：可内嵌 script（`<svg><script>` 是经典绕过手法），一并禁止
 */
const FORBIDDEN_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'form',
  // meta 与 link 不在这里整类禁止 —— 见下面的 ALLOWED_META / ALLOWED_LINK。
  // 整类禁止会把 <meta charset> 和 <meta name="viewport"> 一起挡掉，
  // 而这两项恰恰是「下载后在本地打开不乱码、手机上看排版正常」的必需项。
  // 一个把模型正常输出也拒掉的门，用户不会用第二次。
  'svg',
  'math',
] as const;

/**
 * 允许的 `<meta>` 用途白名单。
 *
 * 【为什么按用途而不是整类禁止】
 * `<meta charset="utf-8">` 与 `<meta name="viewport" ...>` 是**无害且必需**的：
 * 前者决定下载到本地用 file:// 打开时中文是否乱码，
 * 后者决定手机上排版是否正常。模型也几乎必然会加上它们。
 * 而 `<meta http-equiv="refresh">` 能立刻把访客跳转到外部站点 —— 必须继续禁止。
 *
 * 做法：先把 `http-equiv` 一律拒掉，再只放行 charset 与几个无害的 name。
 */
const META_TAG = /<meta\b[^>]*>/gi;

/** 从标签里取出某个属性的值（支持双引号、单引号、无引号三种写法） */
function attrValue(tag: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/** 判断一个 meta 标签是否被允许 */
function isAllowedMeta(tag: string): boolean {
  // http-equiv 一律拒绝：refresh 可跳转，content-security-policy 可放宽页面策略
  if (/\bhttp-equiv\s*=/i.test(tag)) return false;
  const name = attrValue(tag, 'name');
  if (name === null) return false;
  const lower = name.toLowerCase();
  return lower === 'viewport' || lower === 'description' || lower === 'author';
}

/** 只允许 utf-8 的 charset 声明 */
function isAllowedCharset(tag: string): boolean {
  const cs = attrValue(tag, 'charset');
  if (cs === null) return false;
  return cs.toLowerCase().replace(/[\s"']/g, '') === 'utf-8';
}

/**
 * 允许的 `<link>` 用途白名单。
 *
 * 只放行 `rel="icon"` 且地址是 `data:image/` 的图标 ——
 * 那是「下载后标签页有个图标」这一件事，不需要任何外部请求。
 * 其余一律拒绝：stylesheet / preload / prefetch 都是外传通道。
 */
function isAllowedLink(tag: string): boolean {
  const rel = (attrValue(tag, 'rel') ?? '').toLowerCase();
  if (rel !== 'icon' && rel !== 'shortcut icon') return false;
  const href = attrValue(tag, 'href') ?? '';
  return /^data:image\//i.test(href);
}

/** 事件处理器属性：onclick / onerror / onload … 一律禁止 */
const EVENT_HANDLER = /\son[a-z]+\s*=/i;

/**
 * 危险协议。
 *
 * 注意这里**不包含 `data:`** —— 因为图片允许用 `data:image/...` 内联。
 * `data:` 的整体禁止由下面的 `UNSAFE_DATA_URL` 单独处理：
 * 只有当它不是 `data:image/` 开头时才判为危险。
 * （把两者混在一条正则里会导致「禁止 data:」与「允许 data:image」自相矛盾，
 * 这是本文件早期版本的一个真实错误。）
 */
const DANGEROUS_URL = /(?:javascript|vbscript)\s*:/i;

/** `data:` 只允许用于内联图片 */
const UNSAFE_DATA_URL = /data\s*:(?!image\/)/i;

/** 外部资源引用（http 明文）；https 图片是允许的，见下方说明 */
const INSECURE_URL = /(?:src|href)\s*=\s*["']?http:\/\//i;

/** 允许的图片地址形态：https 或 data:image */
const SAFE_IMAGE_SRC = /^(?:https:\/\/|data:image\/)/i;

function stripTagsForText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 校验一段 AI 生成的页面。
 *
 * 返回 `ok: false` 时调用方**必须**放弃这次生成（任务记 failed、零扣费、
 * 不写入任何版本），并把 issues 里的说明展示给用户。
 */
export function validateGeneratedPage(raw: unknown): PageValidation {
  const issues: PageIssue[] = [];
  const push = (rule: string, message: string) => issues.push({ rule, message });

  if (typeof raw !== 'string') {
    return { ok: false, issues: [{ rule: 'not_a_string', message: '生成结果不是一段文本' }] };
  }

  const html = raw.trim();

  if (html === '') {
    return { ok: false, issues: [{ rule: 'empty', message: '生成结果为空' }] };
  }

  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_GENERATED_PAGE_BYTES) {
    return {
      ok: false,
      issues: [{ rule: 'too_large', message: `生成结果过大（${bytes} 字节，上限 ${MAX_GENERATED_PAGE_BYTES}）` }],
    };
  }

  // ---- 必须是一个完整的页面，而不是一个片段 ----
  const hasHtmlTag = /<html[\s>]/i.test(html) && /<\/html\s*>/i.test(html);
  const hasBodyTag = /<body[\s>]/i.test(html) && /<\/body\s*>/i.test(html);
  if (!hasHtmlTag || !hasBodyTag) {
    push('not_a_page', '生成结果不是完整的 HTML 页面（需要包含 <html> 与 <body>）');
  }
  if (!/<title[\s>]/i.test(html)) {
    push('no_title', '页面缺少 <title>，下载后标签页会没有名字');
  }

  // ---- 整类禁止的标签 ----
  for (const tag of FORBIDDEN_TAGS) {
    // 匹配 <tag ...> 与 </tag>
    const re = new RegExp(`<\\s*/?\\s*${tag}(?=[\\s/>])`, 'i');
    if (re.test(html)) {
      const why: Record<string, string> = {
        script: '不允许包含任何脚本（预览页与平台同源，脚本能读取平台数据）',
        iframe: '不允许嵌套其它文档',
        frame: '不允许嵌套其它文档',
        frameset: '不允许嵌套其它文档',
        object: '不允许嵌入外部对象',
        embed: '不允许嵌入外部对象',
        applet: '不允许嵌入外部对象',
        base: '不允许改写页面链接基准',
        form: '不允许包含表单',
        meta: '不允许使用 meta 标签（可用于跳转或声明策略）',
        link: '不允许引入外部样式或资源',
        svg: '不允许内嵌 SVG（可携带脚本）',
        math: '不允许内嵌 MathML（可携带脚本）',
      };
      push(`forbidden_tag:${tag}`, why[tag] ?? `不允许使用 <${tag}>`);
    }
  }

  // ---- meta 按用途检查 ----
  for (const match of html.matchAll(META_TAG)) {
    const tag = match[0];
    if (isAllowedMeta(tag) || isAllowedCharset(tag)) continue;
    if (/\bhttp-equiv\s*=/i.test(tag)) {
      push('meta_http_equiv', '不允许使用 <meta http-equiv>（可用于跳转或放宽页面策略）');
    } else {
      push('meta_not_allowed', `不允许这个 <meta> 标签：${tag.slice(0, 80)}`);
    }
  }

  // ---- link 按用途检查 ----
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (isAllowedLink(tag)) continue;
    push('link_not_allowed', '只允许 rel="icon" 且地址为 data:image 的 <link>');
  }

  // ---- 事件处理器 ----
  if (EVENT_HANDLER.test(html)) {
    push('event_handler', '不允许使用 onclick / onerror 这类事件属性');
  }

  // ---- 危险协议 ----
  if (DANGEROUS_URL.test(html)) {
    push('dangerous_url', '不允许使用 javascript: 或 vbscript: 这类地址');
  }
  if (UNSAFE_DATA_URL.test(html)) {
    push('unsafe_data_url', 'data: 地址只允许用于内联图片（data:image/...）');
  }

  // ---- style 里的外链 ----
  // 允许行内样式（生成页面要靠它才能好看），但不允许从外部拉资源
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? '');
  for (const css of styleBlocks) {
    if (/@import/i.test(css)) {
      push('css_import', '样式里不允许使用 @import 引入外部样式');
      break;
    }
    if (/url\s*\(\s*["']?(?!data:)[^)]*:\/\//i.test(css)) {
      push('css_external_url', '样式里不允许引用外部地址的资源');
      break;
    }
  }

  // ---- 明文 http 资源 ----
  if (INSECURE_URL.test(html)) {
    push('insecure_url', '不允许引用 http:// 的明文资源（请使用 https）');
  }

  // ---- 图片地址形态 ----
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    const src = m[1] ?? '';
    if (/^(?:https:\/\/|data:image\/)/i.test(src)) continue;
    if (/^https?:\/\//i.test(src)) continue; // 上面已单独报 insecure_url
    if (/^javascript:/i.test(src)) continue; // 上面已单独报 dangerous_url
    push('img_src_not_allowed', `图片地址不被允许：${src.slice(0, 60)}（只能用 https 或 data:image）`);
  }

  // ---- 内容不能是空的 ----
  // 一个只有标签没有文字的页面，基本可以断定是生成失败的产物
  if (stripTagsForText(html).length < 10) {
    push('no_text_content', '页面里几乎没有可见文字内容');
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, html };
}

/**
 * 把一条校验规则翻译成**用户能照着做的一句话**。
 *
 * 【为什么要做这层翻译】
 * 校验门返回的是「不允许使用 <meta http-equiv>」这种**规则描述**。
 * 对写代码的人来说这句话很清楚，但对平台的目标用户（房东、个体经营者）
 * 来说它既不可理解也不可操作 —— 他不知道那是什么，更不知道该怎么改。
 *
 * 所以这里按规则给出**下一步该做什么**：
 *   - 绝大多数情况是「点重试」：模型的输出有随机性，重试往往就好了；
 *   - 如果是「要求了平台不支持的能力」（例如带交互的小游戏），
 *     则要明确告诉他这件事当前做不到，而不是让他反复重试。
 */
const ADVICE: Record<string, string> = {
  forbidden_tag: '生成结果里包含了不被允许的标签。点「AI 生成」再试一次通常就能得到不同的结果。',
  event_handler: '生成结果里包含了事件处理代码。点「AI 生成」再试一次即可。',
  dangerous_url: '生成结果里包含了可执行的链接地址。点「AI 生成」再试一次即可。',
  unsafe_data_url: '生成结果里包含了一段内嵌的网页数据。点「AI 生成」再试一次即可。',
  meta_http_equiv: '生成结果里有一段「自动跳转」声明。点「AI 生成」再试一次即可。',
  link_not_allowed: '生成结果里引用了外部样式或资源。点「AI 生成」再试一次即可。',
  meta_not_allowed: '生成结果里有一段不被允许的页面声明。点「AI 生成」再试一次即可。',
  css_import: '生成结果里的样式引用了外部文件。点「AI 生成」再试一次即可。',
  css_external_url: '生成结果里的样式引用了外部图片。点「AI 生成」再试一次即可。',
  insecure_url: '生成结果引用了 http 开头的图片。点「AI 生成」再试一次即可。',
  img_src_not_allowed: '生成结果引用了本地图片文件（下载后会打不开）。点「AI 生成」再试一次即可。',
  not_a_page: '生成结果不是一整页。可能是描述太短了 —— 试着多写几句你想要的页面内容。',
  no_title: '生成结果缺少页面标题。在描述里写明「页面标题是……」通常就能解决。',
  no_text_content: '生成结果几乎没有文字内容。可能是描述太短了 —— 试着多写几句。',
  empty: '这次没有生成出内容。请把你的需求写得更具体一些再试。',
  too_large: '生成结果太大了。试着把需求拆小一点，一次只做一页。',
  not_a_string: '这次没有生成出内容。请再试一次。',
};

/** 平台当前确实做不到的事 —— 这类要直说，而不是让用户反复重试 */
const LIMITATION_HINT =
  '提示：当前平台生成的是纯静态页面，不支持脚本、表单和交互功能。' +
  '如果你想要的是小游戏或需要点击交互的页面，这个版本还做不到。';

/**
 * 把校验问题拼成一段**可操作**的说明。
 *
 * 返回的文案面向终端用户，不是给开发者看的规则清单。
 */
export function describePageIssues(issues: readonly PageIssue[]): string {
  if (issues.length === 0) return '生成结果未通过安全检查，未保存。';

  // 按规则去重，保留首次出现的顺序
  const rules = [...new Set(issues.map((i) => i.rule))];

  // 命中「整类禁止的标签」时给出更贴切的说明（区分是脚本还是别的标签）
  const advices = rules.map((rule) => {
    if (rule.startsWith('forbidden_tag:')) {
      const tag = rule.slice('forbidden_tag:'.length);
      if (tag === 'script') {
        return '生成结果里含有脚本，平台不允许把脚本放进生成的页面（预览页与平台同源，脚本能读取平台数据）。点「AI 生成」再试一次通常就能得到不含脚本的结果。';
      }
      // 对目标用户（房东、个体经营者）来说 <iframe> 这类标签名同样是天书，
      // 因此这里逐个翻译成「它会带来什么」的白话，而不是把标签名原样抛出。
      const plain: Record<string, string> = {
        iframe: '生成结果里嵌入了另一个网页',
        frame: '生成结果里嵌入了另一个网页',
        frameset: '生成结果里嵌入了另一个网页',
        object: '生成结果里嵌入了外部内容',
        embed: '生成结果里嵌入了外部内容',
        applet: '生成结果里嵌入了外部程序',
        base: '生成结果里改写了页面的链接基准',
        form: '生成结果里含有表单（可以向外部提交数据）',
        svg: '生成结果里含有矢量图形块（可能携带脚本）',
        math: '生成结果里含有数学公式块（可能携带脚本）',
      };
      return `${plain[tag] ?? '生成结果里含有平台不允许的内容'}。点「AI 生成」再试一次即可。`;
    }
    return ADVICE[rule] ?? '生成结果不符合平台的页面规范。点「AI 生成」再试一次即可。';
  });

  const head = advices.slice(0, 2);
  const rest = advices.length > 2 ? `（另外还有 ${advices.length - 2} 项需要调整）` : '';

  // 只要求了脚本 / 表单 / 嵌套文档时，多半是用户在描述里要了平台做不到的能力
  const wantsUnsupported = rules.some(
    (r) => r === 'forbidden_tag:script' || r === 'forbidden_tag:form' || r === 'forbidden_tag:iframe',
  );

  return [
    '这次生成的内容没有通过安全检查，所以没有保存（也没有消耗你的额度）。',
    ...head,
    rest,
    wantsUnsupported ? LIMITATION_HINT : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}