/**
 * 公开链接标识（slug）生成与唯一化。
 *
 * 关键设计：面向国内外通用场景（方案基本原则上第 4 条）。
 *  - 英文标题生成 readable-ascii-slug；
 *  - 中文/日文等标题不会被清空 —— 保留 Unicode 字母与数字，
 *    否则「浦东新区三居室」会退化成空字符串。
 *  - 链接输出时由调用方做 encodeURIComponent。
 */

const MAX_SLUG_CODE_POINTS = 60;

/**
 * 把任意标题转换为 URL 安全的 slug。
 * 保留所有 Unicode 字母/数字，其余字符折叠为 '-'。
 */
export function slugify(input: string): string {
  const normalized = input.normalize('NFKC').toLowerCase();

  const replaced = normalized
    // 空白与常见分隔符 -> '-'
    .replace(/[\s\u3000]+/g, '-')
    // 保留：Unicode 字母、数字；其余（标点、符号、emoji）-> '-'
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return truncateCodePoints(replaced, MAX_SLUG_CODE_POINTS).replace(/-+$/g, '');
}

/**
 * 生成**纯 ASCII** 的 slug。
 *
 * 【为什么需要它，而不是直接用 slugify】
 * `slugify` 刻意保留 Unicode 字母 —— 于是「浦东新区三居室」会生成一个中文 slug。
 * 这在国内场景下「看起来没问题」（浏览器地址栏会显示原文），
 * 但**一旦要把链接发给别人就出问题**：复制到微信、短信、邮件里会变成
 * `%E6%B5%A6%E4%B8%9C%E6%96%B0%E5%8C%BA...`。用户看到这么一串会怀疑链接坏了。
 *
 * 这正是平台托管的核心用途（把地址分享出去），所以新分配的 slug 一律用 ASCII。
 *
 * 【中文标题怎么办】
 * 不带拼音表就无法把中文转成有意义的 ASCII。与其塞一张可能不全的对照表
 * （遇到生僻字就会退化成空），不如**诚实地生成一个短标识**：
 * 例如「浦东新区三居室」→ `page-a3f9k2`。
 * 它不可读，但**可以正常复制粘贴、不会被打断**，这才是这个场景真正需要的。
 *
 * 【不改动既有 slug】
 * 这个函数只作用于**新分配**。已经存在的（中文）slug 保持原样，
 * 因此已经分享出去的链接继续有效 —— 有测试守着这一点。
 */
export function slugifyAscii(input: string): string {
  const normalized = input.normalize('NFKC').toLowerCase();

  const replaced = normalized
    // 非 ASCII 字母数字一律折叠为 '-'（中文、日文、emoji 都在这里被处理掉）
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return truncateCodePoints(replaced, MAX_SLUG_CODE_POINTS).replace(/-+$/g, '');
}

/**
 * 生成一个**一定可用**的 ASCII slug。
 *
 * 标题是纯中文时 `slugifyAscii` 会返回空串 —— 这时用 `page-<随机>` 兜底。
 * 前缀用 `page` 而不是继续用 `listing`，是因为这个函数同时服务于
 * 房源展示页与平台托管页，用中性的词更不容易误导。
 */
export function asciiSlugSeed(input: string): string {
  const ascii = slugifyAscii(input);
  // 太短的（例如标题只有一个中文标点）也用兜底，避免出现 `-2` 这种难看的短链
  if (ascii.length >= 2) return ascii;
  return `page-${randomSuffix()}`;
}

/** 按码点截断，避免切断代理对（emoji / 生僻字） */
function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return points.slice(0, max).join('');
}

/**
 * 在 slug 已存在时生成候选序列：base, base-2, base-3, ...
 * 由调用方提供 isTaken 判定，便于在不同存储上复用。
 */
export function nextAvailableSlug(base: string, isTaken: (candidate: string) => boolean): string {
  const seed = base === '' ? 'listing' : base;
  if (!isTaken(seed)) return seed;

  for (let i = 2; i <= 500; i += 1) {
    const candidate = `${seed}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }
  // 极端情况（同名房源极多）退化为随机后缀，保证一定成功
  return `${seed}-${randomSuffix()}`;
}

/** 短随机后缀，仅使用小写字母与数字 */
export function randomSuffix(length = 6): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** 域名标签规范化：用于自定义子域名（第 6 阶段） */
export function normalizeDomainLabel(input: string): string {
  const value = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateCodePoints(value, 63).replace(/-+$/g, '');
}

/** 校验一个完整域名（含至少一个点，且各标签合法） */
export function isValidDomain(domain: string): boolean {
  const value = domain.trim().toLowerCase();
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
