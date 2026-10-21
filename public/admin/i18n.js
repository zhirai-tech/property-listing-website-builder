import { DE } from './i18n-de.js';
import { FR } from './i18n-fr.js';
import { IT } from './i18n-it.js';

/**
 * 后台界面多语言。
 *
 * 结构上刻意用 [中文, 英文] 数组而不是对象字面量。
 * 原因：中文原文里会出现「；」「。」「/」「（）」这类字符，
 * 直接当对象键必须逐个加引号，漏一个就是语法错误。
 * 用数组两边都写成字符串，没有这个问题。
 *
 * 用中文原文当键的好处：
 *  1. 调用处写 t('标题') 一眼能看出这句有没有被翻译；
 *  2. 漏翻时自动回落成中文，界面不会出现 ??? 或空白；
 *  3. 新增字段忘了加译文，最坏情况是显示中文，不会报错。
 *
 * 注意区分两类文字：
 *  - 界面文字（本文件）：按钮、标签、分组标题、提示 —— 由系统翻译；
 *  - 用户登记的资料：房源标题、描述、地址 —— 登记什么语言就显示什么，不翻译。
 */

export const LOCALES = [
  { tag: 'zh-CN', label: '中文' },
  { tag: 'en', label: 'English' },
  { tag: 'fr', label: 'Français' },
  { tag: 'it', label: 'Italiano' },
  { tag: 'de', label: 'Deutsch' },
];

/** [中文原文, 英文译文] */
const PAIRS = [
  // ---- 侧边栏与页脚 ----
  ['房源管理', 'Listings'],
  ['我的房源工作区', 'My workspace'],
  ['发布页面', 'Pages'],
  ['发布提醒', 'Reminders'],
  ['设置', 'Settings'],
  ['备份与恢复', 'Backup & restore'],
  ['退出登录', 'Sign out'],
  ['管理后台', 'Admin'],

  // ---- 列表页 ----
  ['房源总数', 'Total'],
  ['草稿', 'Draft'],
  ['在售/在租', 'Active'],
  ['已预订', 'Reserved'],
  ['已成交', 'Closed'],
  ['已归档', 'Archived'],
  ['搜索标题 / 城市 / 区域 / 地址', 'Search title / city / district / address'],
  ['全部状态', 'All statuses'],
  ['含归档', 'Include archived'],
  ['一次录入，展示页与导出内容都从这份数据生成。',
    'Enter once — the public page and the export are both generated from this data.'],
  ['暂无房源。点击右上角「新增房源」开始录入。',
    'No listings yet. Use "New listing" in the top right to add one.'],
  ['+ 新增房源', '+ New listing'],
  ['新增房源', 'New listing'],
  ['编辑', 'Edit'],
  ['复制', 'Duplicate'],
  ['归档', 'Archive'],
  ['恢复', 'Restore'],
  ['删除', 'Delete'],
  ['更新于', 'Updated'],
  ['暂无照片', 'No photos'],
  ['尚未创建页面', 'No page yet'],
  ['出租中', 'Available'],
  ['已租', 'Rented'],
  ['未确认', 'Unconfirmed'],
  ['面议', 'Price on request'],

  // ---- 标签页 ----
  ['基本信息', 'Basics'],
  ['照片与视频', 'Photos & videos'],
  ['多语言', 'Languages'],
  ['自定义域名', 'Custom domain'],

  // ---- 字段标签 ----
  ['标题', 'Title'],
  ['房源状态', 'Listing status'],
  ['可租状态', 'Availability'],
  ['房型', 'Property type'],
  ['房源描述', 'Description'],
  ['国家/地区', 'Country / region'],
  ['省/州', 'State / province'],
  ['城市', 'City'],
  ['区/县', 'District'],
  ['详细地址', 'Street address'],
  ['面积', 'Area'],
  ['卧室', 'Bedrooms'],
  ['卫生间', 'Bathrooms'],
  ['楼层说明', 'Floor notes'],
  ['价格', 'Price'],
  ['计价周期', 'Billing period'],
  ['押金', 'Deposit'],
  ['可入住日期', 'Available from'],
  ['附加费用说明', 'Extra fees'],
  ['纬度', 'Latitude'],
  ['经度', 'Longitude'],
  ['分享链接标识 (slug)', 'URL slug'],
  ['展示语言', 'Page language'],
  ['展示模板', 'Template'],
  ['译文标题', 'Translated title'],
  ['译文描述', 'Translated description'],

  // ---- 分组标题 ----
  ['地址与位置', 'Location'],
  ['面积与房型', 'Size & layout'],
  ['价格与费用', 'Price & fees'],
  ['地图定位', 'Map location'],
  ['选填', 'optional'],
  ['已填写', 'filled in'],
  ['未填则不显示地图', 'leave empty to hide the map'],

  // ---- 字段提示 ----
  ['显示在展示页最上方。建议写清地段与户型，例如「浦东世纪大道精装两居」',
    'Shown at the top of the public page. Include the area and layout, e.g. "Bright 2-bed on Century Avenue, Pudong".'],
  ['内部管理用：草稿不会出现在展示页上',
    'For your own tracking — drafts never appear on the public page.'],
  ['对外展示的标签。长时间不更新会自动变成「未确认」，提醒租客先跟你核实',
    'The badge renters see. If you go a long time without updating it becomes "Unconfirmed", so renters know to check with you first.'],
  ['这里是「原文」。译文在「多语言」里单独维护，保存原文不会覆盖译文',
    'This is the original. Translations live under "Languages" and are never overwritten when you save here.'],
  ['输入中文、英文或两位代码都能搜到，例如「中」「chi」「CN」',
    'Search by Chinese name, English name or two-letter code — e.g. "中", "chi", "CN".'],
  ['中国省份可直接搜索；国外地址可自由输入',
    'Chinese provinces are searchable; foreign addresses can be typed freely.'],
  ['街道、门牌、楼栋房号。展示页会按「国家 省 城市 区 详细地址」的顺序拼接',
    'Street, number, building, unit. The public page joins these as country → province → city → district → street.'],
  ['自由填写，如「15/28 层有电梯」或「两层 + 屋顶露台」',
    'Free text, e.g. "15th of 28 floors, lift" or "two storeys + roof terrace".'],
  ['填总价即可，单价会自动算出来给你看',
    'Just enter the total — the unit price is worked out for you.'],
  ['与价格使用同一种币种。留空表示不收押金',
    'Uses the same currency as the price. Leave empty if no deposit is required.'],
  ['自由文本，不预设任何国家的收费规则。写清谁承担、怎么结算，能减少来回问',
    'Free text — no country-specific rules are assumed. Say who pays what and how it is settled to save back-and-forth.'],
  ['例如 31.2304', 'e.g. 31.2304'],
  ['例如 121.4737', 'e.g. 121.4737'],
  ['想让展示页显示地图时再填。在任意地图应用里长按你的房子，复制那两个数字即可。',
    'Only needed if you want a map on the public page. Long-press your home in any map app and copy the two numbers.'],
  ['只能包含字母、数字、汉字与连字符；留空则按标题重新生成',
    'Letters, digits, Chinese characters and hyphens only. Leave empty to regenerate from the title.'],

  // ---- 按钮 ----
  ['保存修改', 'Save changes'],
  ['创建房源', 'Create listing'],
  ['保存', 'Save'],
  ['取消', 'Cancel'],
  ['确认', 'Confirm'],
  ['保存发布设置', 'Save page settings'],
  ['打开展示页', 'Open public page'],
  ['打开二维码', 'Open QR code'],
  ['下载 ZIP', 'Download ZIP'],
  ['预览导出页面', 'Preview export'],
  ['导出到服务器目录', 'Export to server folder'],
  ['添加 / 更新译文', 'Add / update translation'],
  ['绑定自定义域名', 'Connect custom domain'],
  ['验证域名', 'Verify domain'],
  ['解绑', 'Disconnect'],
  ['上传照片', 'Upload photos'],
  ['添加视频链接', 'Add video link'],
  ['设为封面', 'Set as cover'],
  ['清理过期备份', 'Prune old backups'],
  ['立即备份', 'Back up now'],
  ['校验备份', 'Verify backup'],
  ['恢复演练', 'Restore drill'],
  ['立即投递', 'Deliver now'],
  ['重置为真实时间', 'Reset to real time'],
  ['保存设置', 'Save settings'],

  // ---- 区块标题与说明 ----
  ['第一张自动成为封面；可调整顺序或指定封面。',
    'The first photo becomes the cover. Reorder or pick a different cover below.'],
  ['发布前需要先完善：', 'Complete these before publishing:'],
  ['预览与发布后的页面完全同源；发布后页面才会被匿名访问，撤下后立即返回 404。',
    'The preview and the live page share one source. Only published pages are publicly reachable; withdrawing returns 404 immediately.'],
  ['分享链接与二维码', 'Share link & QR code'],
  ['当前公开地址：', 'Current public URL:'],
  ['静态 HTML 导出', 'Static HTML export'],
  ['素材来源 / 授权说明（用于商用前的许可证核对）',
    'Source / licence note (for commercial-use licence checks)'],
  ['原文保存在房源主记录中，译文单独保存，切换语言不会覆盖这里的文字。',
    'The original is stored on the listing itself; translations are stored separately and are never overwritten.'],
  ['尚未添加任何译文。', 'No translations yet.'],
  ['已有译文', 'Existing translations'],
  ['原文', 'Original'],
  ['语言', 'Language'],
  ['更新时间', 'Updated'],
  ['操作', 'Actions'],
  ['译文已保存', 'Translation saved'],
  ['译文已删除', 'Translation deleted'],
  ['原文 · 存于房源主记录', 'Original · stored on the listing'],
  ['译文', 'Translation'],
  ['正在填写', 'Editing in'],
  ['单价约', 'Unit price ≈'],

  // ---- 加载态与空状态 ----
  ['加载中…', 'Loading…'],
  ['上传中…', 'Uploading…'],
  ['导出中…', 'Exporting…'],
  ['投递中…', 'Delivering…'],
  ['处理中…', 'Working…'],
  ['正在查询 DNS…', 'Looking up DNS…'],
  ['尚未上传照片。', 'No photos uploaded yet.'],
  ['暂无视频。', 'No videos yet.'],
  ['当前没有待处理的提醒。', 'No reminders pending.'],
  ['还没有备份。', 'No backups yet.'],
  ['暂无提醒。发布房源后会自动生成。', 'No reminders yet. They are created once you publish a listing.'],
  ['点击刷新以加载最近操作记录。', 'Refresh to load recent activity.'],

  // ---- 操作结果 ----
  ['已保存', 'Saved'],
  ['已归档', 'Archived'],
  ['已恢复为草稿', 'Restored as draft'],
  ['已删除', 'Deleted'],
  ['链接已复制', 'Link copied'],
  ['复制失败，请手动选择链接复制', 'Copy failed — select and copy the link manually'],
  ['已设为封面', 'Set as cover'],
  ['已添加视频链接', 'Video link added'],
  ['已更新来源说明', 'Source note updated'],
  ['发布设置已保存', 'Page settings saved'],
  ['设置已保存', 'Settings saved'],
  ['外部服务配置已保存', 'External service config saved'],
  ['已发布：', 'Published: '],
  ['已撤下，公开访问将返回 404', 'Withdrawn — the public URL now returns 404'],
  ['已撤下，公开访问返回 404', 'Withdrawn — the public URL now returns 404'],
  ['域名已绑定，等待验证', 'Domain connected, awaiting verification'],
  ['时间调整失败', 'Failed to adjust time'],
  ['页面加载失败', 'Failed to load page'],
  ['保存失败', 'Save failed'],
  ['操作失败', 'Action failed'],
  ['校验未通过：', 'Verification failed:'],
  ['恢复演练成功。', 'Restore drill succeeded.'],
  ['无法连接服务器，请确认服务是否仍在运行',
    'Cannot reach the server — check that it is still running.'],
  ['请求失败', 'Request failed'],
  ['确定要彻底删除「', 'Permanently delete "'],
  ['」？\n\n将同时删除该房源的展示页、照片文件与提醒，且不可恢复。',
    '"?\n\nThis also deletes its public page, photo files and reminders. It cannot be undone.'],
  ['确定归档「', 'Archive "'],
  ['」？归档后默认不出现在列表中，数据仍保留。',
    '"? It will be hidden from the list by default; the data is kept.'],
  ['确定删除该素材？文件会一并从磁盘移除。',
    'Delete this asset? The file is removed from disk as well.'],
  ['确定解绑该域名？', 'Disconnect this domain?'],
  ['确定删除', 'Delete the'],
  [' 的译文？原文不会受影响。', ' translation? The original is unaffected.'],
  ['照片与视频', 'Photos & videos'],

  // ---- 设置页 ----
  ['默认语言、币种、面积单位与时区都作用于新建房源与展示页格式。',
    'Default language, currency, area unit and time zone apply to new listings and public page formatting.'],
  ['默认值', 'Defaults'],
  ['提醒收件邮箱', 'Reminder recipient'],
  ['外部服务适配层', 'External service adapters'],
  ['所有外部服务都通过适配器接入，可替换服务商而不改动业务代码。密钥只允许通过环境变量注入，界面上只显示「是否已设置」。',
    'Every external service goes through an adapter, so providers can be swapped without touching business code. Secrets are injected via environment variables only; the UI shows whether one is set.'],
  ['当前适配器', 'Current adapter'],
  ['非敏感配置', 'Non-secret config'],
  ['高级：登记外部服务配置（不会保存密钥）',
    'Advanced: register external service config (secrets are never stored)'],
  ['可登记瓦片地址、CNAME 目标等公开配置；任何疑似密钥的字段会被服务端拒绝。',
    'Public settings such as tile URLs and CNAME targets can be registered; anything resembling a secret is rejected by the server.'],
  ['地图', 'Map'],
  ['时间', 'Clock'],
  ['存储', 'Storage'],
  ['邮件', 'Mail'],
  ['DNS 验证', 'DNS'],
  ['托管', 'Hosting'],
  ['第 1 次提醒', 'First reminder'],
  ['第 2 次提醒', 'Second reminder'],

  // ---- 时间旅行 ----
  ['时间旅行（演示与验收专用）', 'Time travel (demo & acceptance only)'],
  ['当前业务时间：', 'Current business time:'],
  ['下一条待处理提醒：', 'Next pending reminder:'],
  ['跳到该提醒时间并保持当地上午', 'Jump to that reminder time, keeping local morning'],
  ['业务时间已更新为', 'Business time updated to'],

  // ---- 备份页 ----
  ['备份包内含 SQLite 一致性快照（VACUUM INTO）与全部上传素材。',
    'Each backup contains a consistent SQLite snapshot (VACUUM INTO) plus all uploaded assets.'],
  ['恢复演练会解包到独立目录并逐表校验行数，不影响正在运行的数据。',
    'A restore drill unpacks into a separate folder and checks row counts table by table, without touching live data.'],
  ['备份完成：', 'Backup complete: '],
  // ---- 设置页补充 ----
  ['工作区', 'Workspace'],
  ['工作区名称 *', 'Workspace name *'],
  ['默认语言', 'Default language'],
  ['也是房源「原文」的语言', 'Also the language of the original listing text'],
  ['默认币种', 'Default currency'],
  ['例如 CNY / USD / EUR', 'e.g. CNY / USD / EUR'],
  ['默认面积单位', 'Default area unit'],
  ['平方米', 'Square metres'],
  ['平方英尺', 'Square feet'],
  ['默认时区', 'Default time zone'],
  ['时区，例如 Asia/Shanghai；提醒规则按此时区计算', 'Time zone, e.g. Asia/Shanghai. Reminder rules use this zone.'],
  ['管理员口令', 'Admin password'],
  ['保存工作区设置', 'Save workspace settings'],
  ['已设置', 'Set'],
  ['未设置', 'Not set'],
  ['提醒规则', 'Reminder schedule'],
  ['时区', 'Time zone'],
  ['收件人', 'Recipient'],

  // ---- 页面列表页 ----
  ['每个房源最多一个展示页；页面内容始终从房源数据实时生成，不存在缓存副本。',
    'Each listing has at most one public page. Content is generated live from the listing data — there is no cached copy.'],
  ['房源', 'Listing'],
  ['链接标识', 'Slug'],
  ['状态', 'Status'],
  ['公开地址', 'Public URL'],
  ['浏览量', 'Views'],
  ['打开', 'Open'],
  ['撤下', 'Withdraw'],
  ['发布', 'Publish'],
  ['还没有发布页。请在房源详情中点击「发布页面」。',
    'No public pages yet. Open a listing and use "Pages" to publish one.'],
  ['已发布', 'Published'],
  ['未发布', 'Unpublished'],
  ['已撤下', 'Withdrawn'],

  // ---- 提醒页 ----
  ['发布后第 7 天提醒检查房源，第 15 天提醒确认或更新。',
    'A reminder on day 7 to check the listing, and on day 15 to confirm or update it.'],
  ['第 7 / 15 天', 'Day 7 / 15'],
  ['第 7 天', 'Day 7'],
  ['第 15 天', 'Day 15'],
  ['提醒列表', 'Reminders'],
  ['类型', 'Kind'],
  ['计划时间', 'Scheduled'],
  ['尝试', 'Attempts'],
  ['收件邮箱', 'Recipient email'],
  ['待处理', 'Pending'],
  ['已完成', 'Done'],
  ['失败', 'Failed'],
  ['时间旅行', 'Time travel'],

  // ---- 备份页 ----
  ['备份文件', 'Backup file'],
  ['大小', 'Size'],
  ['创建时间', 'Created'],
  ['保留', 'Keep for'],
  ['天', 'days'],
  ['校验', 'Verify'],
  ['恢复', 'Restore'],
  ['通过', 'Passed'],
  ['未通过', 'Failed'],
  ['备份目录', 'Backup folder'],
  ['立即创建', 'Create now'],
  // ---- 设置页长句与剩余标签 ----
  ['工作区名称', 'Workspace name'],
  ['时区，例如 Asia/Shanghai；提醒规则按此时区计算',
    'Time zone, e.g. Asia/Shanghai. Reminder rules use this zone.'],
  ['所有外部服务都通过适配器接入，可替换服务商而不改动业务代码。密钥只允许通过环境变量注入， 界面上只显示「是否已设置」。',
    'Every external service goes through an adapter, so providers can be swapped without touching business code. Secrets are injected via environment variables only; the UI shows whether one is set.'],
  ['能力', 'Capability'],
  ['配置来源', 'Config source'],
  ['上传目录', 'Upload folder'],
  ['提醒配置', 'Reminder config'],
  ['提醒天数与重试上限通过环境变量配置，修改后需重启服务；时区在上方工作区设置中修改。',
    'Reminder days and retry limits come from environment variables and need a restart to change; the time zone is set in the workspace settings above.'],
  ['最大重试', 'Max retries'],
  ['次', ''],
  ['审计日志', 'Audit log'],
  ['刷新', 'Refresh'],
  ['主机：未配置（console 模式仅写日志）', 'Host: not configured (console mode only logs)'],
  ['目标：', 'Target: '],
  ['前缀：', 'Prefix: '],
  ['地图免费额度提示：OSM 公共瓦片服务免费但存在使用量限制，商用前请阅读其使用政策',
    'Free tier note: the public OSM tile service is free but rate-limited — read its usage policy before commercial use.'],
  ['外部服务', 'External services'],
  ['提醒邮件', 'Reminder email'],
  ['域名验证', 'Domain verification'],
  ['静态托管', 'Static hosting'],
  ['时间源', 'Clock'],
  ['对象存储', 'Object storage'],
  // ---- 手机底部标签栏（比侧边栏短） ----
  ['列表', 'Listings'],
  // ---- 页面级文字 ----
  ['返回房源列表', 'Back to listings'],
  ['照片与视频', 'Photos & videos'],
  ['保存后继续上传照片', 'Save, then upload photos'],
  ['保存后展示页立即同步', 'The public page updates as soon as you save'],
  ['发布前需要先完善：', 'Complete these before publishing:'],
  ['页面', 'Pages'],
  ['提醒', 'Alerts'],
  ['备份', 'Backup'],
];

const EN = new Map(PAIRS);
const DICTS = { en: EN, fr: FR, it: IT, de: DE };

let current = 'zh-CN';

export function getLocale() {
  return current;
}

export function setLocale(tag) {
  current = tag;
  try {
    document.documentElement.lang = tag;
  } catch {
    /* 非浏览器环境忽略 */
  }
}

/**
 * 翻译一句界面文字。
 * 找不到译文时**原样返回中文** —— 漏翻只是显示中文，不会让界面出空洞。
 */
export function t(zh) {
  if (current === 'zh-CN') return zh;
  const table = DICTS[current];
  if (!table) return zh;
  const hit = table.get(zh);
  return hit === undefined ? zh : hit;
}

export function isEnglish() {
  return current !== 'zh-CN';
}

/** 是否存在这条词条。用于「自动扫描文本节点」时快速排除用户数据。 */
export function hasKey(zh) {
  return EN.has(zh);
}

/** 供自动扫描用的键集合（不含当前语言判断） */
export function allKeys() {
  return EN.keys();
}