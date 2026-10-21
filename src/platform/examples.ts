/**
 * 示例画廊：用**真实的生成结果**做引导。
 *
 * 【为什么需要它】
 * 文字引导能说清「怎么写描述」，但用户仍然**不知道生成出来会长什么样** ——
 * 第一次生成本质上是个盲盒，而他要在那之前决定要不要花额度。
 * 给他几个真实渲染出来的页面看，比任何文字说明都有效。
 *
 * 【为什么放在代码里而不是静态文件】
 * 因为这些页面**必须自己能通过校验门**。放在这里，
 * 测试可以直接拿 `validateGeneratedPage()` 逐个验一遍 ——
 * 一个展示「平台能生成什么」的画廊，如果展示的页面平台自己都会拒绝，
 * 那它就是在误导用户，而且这种错误在静态文件里不会被任何测试发现。
 *
 * 【为什么每个示例都带 descriptions（多种说法）】
 * 如果画廊只给一个句式，用户会直接抄，生成结果就趋同了。
 * 给每个示例配几种不同的说法，是在暗示「这样说也行、那样说也行」。
 */

export interface PageExample {
  /** 唯一标识 */
  id: string;
  /** 展示给用户的名称 */
  name: string;
  /** 一句话说明这是什么页面 */
  summary: string;
  /** 用户可以直接用的描述（可编辑） */
  prompt: string;
  /** 这个示例值得注意的地方 */
  highlight: string;
  /** 页面内容本身 */
  html: string;
}

/**
 * 画廊必须对用户说的实话。
 *
 * 【为什么这条不能省】
 * 这三个页面是**手工整理的样例，不是模型生成的**。
 * 如果画廊只说「平台能生成这样的页面」，用户看完示例去生成、
 * 结果明显更差，**落差带来的失望比没有示例更大** —— 这比功能缺失更伤产品。
 *
 * 所以界面上必须同时给出两件事：
 *   1. 这句标注（说清示例是什么）；
 *   2. 「用这段描述生成一次」的入口（让用户自己看到真实结果）。
 * 承诺就从「我们能做到这样」变成「你可以自己试试能做到什么」。
 */
export const SAMPLE_DISCLAIMER =
  '下面这些是手工整理的样例，用来说明「一个页面大概长什么样」，不是模型生成的。' +
  '实际效果取决于你的描述 —— 可以用同一段描述自己生成一次看看。';

/** 共用的样式基线 —— 让示例看起来是一致的、也是够用的 */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#0d9488; }
* { box-sizing:border-box; }
body { margin:0; padding:28px 20px 44px; font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       color:var(--ink); line-height:1.65; max-width:720px; margin-inline:auto; }
h1 { font-size:1.6rem; margin:0 0 6px; }
h2 { font-size:1.05rem; margin:26px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
p { margin:0 0 10px; }
.lead { color:var(--muted); margin-bottom:20px; }
.card { border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:12px; }
.row { display:flex; justify-content:space-between; gap:12px; padding:7px 0; border-bottom:1px dashed var(--line); }
.row:last-child { border-bottom:none; }
.k { color:var(--muted); }
.tag { display:inline-block; padding:2px 9px; border-radius:999px; background:#ccfbf1; color:#0f766e; font-size:.78rem; }
footer { margin-top:32px; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:.82rem; }
@media (max-width:520px) { body { padding:20px 14px 36px; } h1 { font-size:1.35rem; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export const PAGE_EXAMPLES: readonly PageExample[] = [
  {
    id: 'profile',
    name: '个人介绍页',
    summary: '一页讲清你是谁、做什么、怎么联系',
    prompt: '我的个人介绍页。包含姓名「林小满」、一句话介绍、三个擅长方向，以及联系方式（邮箱和微信）。风格简洁清爽，适合手机阅读。',
    highlight: '最常用的形态：标题 + 几段文字 + 联系方式，几乎不需要改就能用。',
    html: shell(
      '林小满 · 个人介绍',
      `<h1>林小满</h1>
<p class="lead">独立的室内设计师，专注小户型改造。</p>

<h2>我擅长的事</h2>
<div class="card">
<div class="row"><span>小户型空间规划</span><span class="tag">8 年经验</span></div>
<div class="row"><span>旧房翻新与收纳设计</span><span class="tag">常做</span></div>
<div class="row"><span>软装搭配与预算控制</span><span class="tag">可承接</span></div>
</div>

<h2>关于我</h2>
<p>做过一百多套小户型，最擅长的不是把房子变好看，而是让它在真实生活里好用。会先问清楚你每天怎么过，再动手画图。</p>

<h2>联系方式</h2>
<div class="card">
<div class="row"><span class="k">邮箱</span><span>xiaoman@example.com</span></div>
<div class="row"><span class="k">微信</span><span>xiaoman_design</span></div>
<div class="row"><span class="k">所在城市</span><span>杭州</span></div>
</div>

<footer>本页由 AI 生成，内容可随时在平台修改后重新发布。</footer>`,
    ),
  },
  {
    id: 'shop',
    name: '小店介绍页',
    summary: '店名、招牌、营业时间、到店信息',
    prompt: '一家咖啡店的介绍页。店名「拾光咖啡」，主营手冲和简餐，营业时间早上八点到晚上八点，地址在南京市鼓楼区某条街。风格温暖一点。',
    highlight: '把「营业时间」「地址」这类顾客最常问的信息集中放在一张卡片里。',
    html: shell(
      '拾光咖啡',
      `<h1>拾光咖啡</h1>
<p class="lead">手冲、简餐，和一段不赶时间的下午。</p>

<h2>招牌</h2>
<div class="card">
<div class="row"><span>耶加雪菲（手冲）</span><span class="tag">最受欢迎</span></div>
<div class="row"><span>厚切吐司套餐</span><span class="tag">全天供应</span></div>
<div class="row"><span>当日冷萃</span><span class="tag">限量</span></div>
</div>

<h2>到店信息</h2>
<div class="card">
<div class="row"><span class="k">营业时间</span><span>每天 08:00 – 20:00</span></div>
<div class="row"><span class="k">地址</span><span>南京市鼓楼区 某某路 12 号</span></div>
<div class="row"><span class="k">电话</span><span>025-0000-0000</span></div>
<div class="row"><span class="k">座位</span><span>约 24 个，工作日通常有位</span></div>
</div>

<h2>关于这家店</h2>
<p>开在小区门口，做的多是熟客生意。豆子每周烘一次，简餐当天备料、卖完为止。带电脑来坐一下午也没问题。</p>

<footer>本页由 AI 生成，内容可随时在平台修改后重新发布。</footer>`,
    ),
  },
  {
    id: 'event',
    name: '活动说明页',
    summary: '时间、地点、注意事项、怎么参加',
    prompt: '一次社区旧物交换活动的说明页。活动叫「旧物新生」，时间是下个月第一个周六下午两点到五点，地点在社区中心一楼，需要提醒大家带上还能用的闲置物品。',
    highlight: '用「注意事项」代替长篇说明，读者扫一眼就知道要准备什么。',
    html: shell(
      '旧物新生 · 社区旧物交换',
      `<h1>旧物新生</h1>
<p class="lead">把家里用不上的东西，交给正需要它的人。</p>

<h2>时间与地点</h2>
<div class="card">
<div class="row"><span class="k">时间</span><span>下月第一个周六 14:00 – 17:00</span></div>
<div class="row"><span class="k">地点</span><span>社区中心一楼多功能厅</span></div>
<div class="row"><span class="k">费用</span><span>免费，无需报名</span></div>
</div>

<h2>怎么参加</h2>
<p>当天带上闲置物品直接到场即可。现场按物品类别分区摆放，看上什么直接拿走，不涉及金钱交易。</p>

<h2>注意事项</h2>
<div class="card">
<div class="row"><span>带来的是干净、还能正常使用的物品</span></div>
<div class="row"><span>大件家具请先拍照贴在公告栏，不要搬来现场</span></div>
<div class="row"><span>食品、药品、贴身衣物不参与交换</span></div>
<div class="row"><span>活动结束后未被取走的物品请自行带回</span></div>
</div>

<footer>本页由 AI 生成，内容可随时在平台修改后重新发布。</footer>`,
    ),
  },
];

/** 按 id 取示例 */
export function getPageExample(id: string): PageExample | null {
  return PAGE_EXAMPLES.find((e) => e.id === id) ?? null;
}

/** 画廊列表用的精简结构（不含页面内容，避免列表响应过大） */
export interface ExampleSummary {
  id: string;
  name: string;
  summary: string;
  prompt: string;
  highlight: string;
}

/**
 * 画廊列表。
 *
 * 返回体里带上 `disclaimer`：**这不是可选文案，是产品诚实性的一部分**。
 * 放在接口里而不是写死在前端，是为了让「示例是什么」这件事只有一个来源 ——
 * 将来若示例改成模型真实产出，只需要改这里一处。
 */
export function exampleSummaries(): { items: ExampleSummary[]; disclaimer: string } {
  return {
    disclaimer: SAMPLE_DISCLAIMER,
    items: PAGE_EXAMPLES.map((e) => ({
      id: e.id,
      name: e.name,
      summary: e.summary,
      prompt: e.prompt,
      highlight: e.highlight,
    })),
  };
}