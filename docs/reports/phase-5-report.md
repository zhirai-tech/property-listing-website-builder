# 修订记录（2026-10-12 二次修订）

> 本报告初稿写于本轮开发过程中。此后又完成了若干修复与补充验证，**以下修订单独列出，并取代正文中相应结论**；正文其余内容仍然有效。

## 修订内容

1. **「多语言」已从「只翻译房源正文」扩展为「翻译整个界面」。** 初稿登记「只有 4 种语言有界面文案目录、后台界面仍为中文」。现已新增界面词条目录（`src/domain/i18n.ts` 中的 `t()` / `uiCatalog()`），覆盖 **zh-CN / zh-TW / en / ja** 四种语言，未知语言回退英文；词条键集合完整性有单测保证。
   展示页的区块标题、关键信息标签、价格/费用、位置、周边、联系方式、分享、页脚等在英文模式下**全部切换为英文**，并已验证截图 `docs/evidence/06-public-page-en-i18n.png`（对比修复前的 `05-public-page-en-before-i18n.png`，可看到 `Type / Bedrooms / Area / Floor / Available from / About this property / Price & fees / Nearby / Contact / Share this listing`）。
2. **房型字典值本地化。** 此前英文页显示原始值 `apartment`，现显示 `Apartment`（中文页显示「公寓」）；未知自定义值仍原样显示，因为房型本身是可配置字典。
3. **配合第 3 阶段修复，导出支持离线多语言**（见 phase-3 修订）。

**仍然存在的限制（未按已完成报告）：**

- 自由文本字段（详细地址、附加费用说明等）**没有翻译通道**，只显示原文 —— 这是有意的：译文表只覆盖标题与描述。若需翻译这些字段，应扩展 `property_translations` 结构，而不是覆盖原文。
- 后台管理界面目前只有中文（展示页已多语言）。
- 12 种可选语言中仅 4 种有完整界面词条，其余回退英文。

---

# 第 5 阶段验收报告：多语言与国际化

- 项目根目录：`E:\轻量化房源管理`
- 对应方案：第五章第 5 阶段（工作与验收项）、第三章第 7 条、第四章第 1 条
- 运行方式：`pnpm start`；切换语言通过公开展示页的 `?lang=<tag>` 与页面底部语言栏
- 证据复跑（2026-10-12 18:2x）：`node --disable-warning=ExperimentalWarning scripts/smoke.ts` → 73/73 通过（含 5 项多语言断言）
- 浏览器证据（已归档）：`docs/evidence/06-public-page-en-i18n.png`（英文页，界面文案已本地化）、`docs/evidence/05-public-page-en.png` 与 `docs/evidence/05-public-page-en-before-i18n.png`（同一张：本地化之前的英文页，两个文件字节数相同，均为 286790 字节）

## 阶段名称与目标

第 5 阶段：多语言与国际化。目标为支持多语言界面、翻译字段、货币/日期/面积单位格式配置。验收要求：切换语言不丢失数据；原始描述不被翻译覆盖；格式按配置正确显示。

## 实际修改的文件/模块

- `src/domain/i18n.ts`：
  - `SUPPORTED_LOCALES`：12 种可选语言（zh-CN、zh-TW、en、ja、ko、es、fr、de、ru、ar、th、vi）与 `isSupportedLocale()`；
  - `COMMON_CURRENCIES`：14 种常用币种仅作下拉建议，数据层不限制任何 ISO 4217 代码；
  - 格式化：`formatMoney`（`Intl.NumberFormat` + `style: 'currency'`，非法币种代码时降级为「金额 + 代码」而不抛错）、`areaUnitLabel` / `formatArea`、`pricePeriodLabel` / `formatPrice`、`formatDateOnly`；
  - 译文选择：`resolveLocalizedText`（精确语言 → 语言族回退 → 回退原文，且**只读不改原文**）、`availableLocales`；
  - 界面文案目录：`UiKey` 类型、`UiCatalog`、四套目录 `ZH_CN` / `ZH_TW` / `EN` / `JA`、`uiCatalog()`（精确 → 语言族 → 英文兜底）、`t(locale, key, vars)`（带 `{var}` 占位替换，缺失键回落中文目录再回落键名）、`propertyTypeLabel` / `contactChannelLabel` / `nearbyCategoryLabel`。
- `src/services/i18n-service.ts`：`saveTranslation`（拒绝用同语言译文覆盖原文）、`removeTranslation`、`listPropertyTranslations`、`buildLocaleLinks`（生成语言栏链接）。
- `src/db/repositories/translation-repo.ts`：`property_translations` 的读写。
- `src/http/routes/admin-pages.ts`：`GET /api/admin/properties/:id/translations`、`PUT`（保存译文）、`DELETE /api/admin/properties/:id/translations/:locale`、`GET /api/admin/locales`。
- `src/http/routes/public-pages.ts`：解析 `?lang=`（仅接受受支持语言，否则回退发布页语言或工作区默认语言），并把 `localeLinks` 传给渲染器。
- `src/render/page-renderer.ts`：`<html lang>` 与 RTL 支持（`/^(ar|he|fa|ur)/i` 命中时加 `dir="rtl"`）、语言栏、全部区块标题与字段标签改为 `t(locale, key)`、房源类型/联系渠道/周边分类走各自标签映射。
- `src/http/routes/admin-settings.ts`：工作区「默认语言」的读写（`Validator.locale`，即默认语言同时也是「原文语言」）。
- `public/admin/views/property-edit.js`：「多语言」标签（译文列表、新增/编辑/删除译文）。

## 数据库变更与迁移结果

- 本阶段无新增迁移；使用 `v1 initial_schema` 中的 `property_translations` 表：`id`、`property_id`、`locale`、`title`、`description`、`created_at`、`updated_at`。
- 关键约束：`UNIQUE INDEX idx_translations_property_locale(property_id, locale)` —— 同一房源同一语言最多一条译文；`property_id` 外键 `ON DELETE CASCADE`（删除房源时译文一并清理）。
- **原文与译文物理分离**：原文始终存放在 `properties.title` / `properties.description`，译文存放在 `property_translations`；任何翻译操作都不会 UPDATE 原文列（这是「原始描述不被翻译覆盖」的结构性保证，而非仅靠业务代码约束）。
- 工作区默认语言：`workspaces.default_locale`（本机为 `zh-CN`），在「设置」页可修改。
- 实测：保存 en 译文后 `GET /api/admin/properties/:id` 返回 `translations.length = 1`，且 `property.description` 仍为中文原文。

## API/服务端验证

| 方法 | 路径 | 验证结果 |
| --- | --- | --- |
| PUT | `/api/admin/properties/:id/translations` | 保存 `{ locale: 'en', title, description }` 返回 201；用 `locale: 'zh-CN'`（与原文同语言）提交返回 400（拒绝覆盖原文） |
| GET | `/api/admin/properties/:id/translations` | 返回原文（locale/title/description）、译文列表与受支持语言列表 |
| DELETE | `/api/admin/properties/:id/translations/:locale` | 删除译文；该语言没有译文时返回 400「该语言没有译文」 |
| GET | `/api/admin/locales` | 返回 12 种语言与工作区默认语言 |
| GET | `/p/:slug?lang=en` | 返回英文页面；`lang` 不受支持时回退发布页语言 |
| PATCH | `/api/admin/settings` | 修改 `defaultLocale` / `defaultCurrency` / `defaultAreaUnit` / `defaultTimezone`（均带格式校验），同时作为新表单的默认值 |

实测（冒烟测试）断言：

1. 保存英文译文成功（`status = 201`）；
2. 英文页面显示译文：页面含 `Bright 2-Bedroom in Pudong`；
3. **原文未被译文覆盖**：`GET /api/admin/properties/:id` 的 `property.description` 仍包含「近地铁 2 号线」；
4. 译文独立保存：`translations.length === 1`；
5. **拒绝用同语言译文覆盖原文**：`locale = 'zh-CN'` 的保存请求返回 400。

浏览器证据（`docs/evidence/06-public-page-en-i18n.png`，英文展示页）可观察到：

- 语言栏 `简体中文 / English`，`English` 高亮为当前语言；
- 标题为译文 `Bright 2-Bedroom near Metro Line 2, Pudong`；
- 金额 `CN¥9,200 / per month`、面积 `89.5 m²`、可入住日期 `November 1, 2026` —— 货币、面积单位与日期格式均随语言变化；
- 区块标题与字段标签为英文：`About this property`、`Video`、`Price & fees`（`Price` / `Deposit` / `Billing period` / `Additional fees`）、`Location`、`Nearby`、`Contact`、`Share this listing`，关键信息标签为 `Type` / `Bedrooms` / `Bathrooms` / `Area` / `Floor` / `Available from`；
- 页面显式提示「Showing the en translation. The original description is always preserved in the back office and never overwritten.」；
- 对照 `05-public-page-en-before-i18n.png`（本地化之前）可看出这次改动解决的是「英文页仍是中文标签」的问题。

## 真实浏览器操作路径

1. 后台 → 房源详情 → 「多语言」标签 → 选择语言（下拉为 `简体中文 (zh-CN)`、`English (en)` 等）→ 填写「译文标题」「译文描述」→ 「保存译文」。
2. 译文列表出现该语言行，提供「编辑」「删除」。
3. 在语言栏点击 `English`（或直接访问 `/p/<slug>?lang=en`）→ 页面切换为英文：标题/描述用译文，金额、面积、日期按英文格式渲染，区块标签为英文。
4. 切回 `简体中文` → 内容恢复为原文，数据未丢失。
5. 回到后台「设置」→ 修改「默认语言」「默认币种」「默认面积单位」「默认时区」→ 保存；新表单与提醒规则使用新的默认值。

## 通过项与证据

1. **切换语言不丢失数据**：语言只是渲染参数（`?lang=` + 语言栏链接），不修改任何实体；原文与译文分表存放，切换只是读取选择。
2. **原始描述不被翻译覆盖**：由表结构（`properties` 与 `property_translations` 分离）与接口约束（同语言译文被拒绝）双重保证，并有 2 条冒烟断言直接验证。
3. **格式按配置正确显示**：`formatPrice` / `formatMoney` / `formatArea` / `formatDateOnly` 全部基于 `Intl`；工作区默认币种、面积单位、语言可在「设置」中修改；非法币种代码会降级显示而不是抛错（`try/catch` 兜底）。
4. **界面文案本地化（公开展示页）**：`t(locale, key)` 覆盖区块标题、字段标签、页脚免责声明、按钮文案、房源类型、联系渠道与周边分类；英文页截图证实标签已全部为英文。
5. **回退链明确**：译文缺失 → 精确语言 → 语言族（`zh` 命中 `zh-CN`）→ 原文；界面文案缺失 → 目标语言 → 英文 → 中文 → 键名。因此不会出现空白文案。
6. **RTL 支持**：阿拉伯语等 RTL 语言会在 `<html>` 上加 `dir="rtl"`（代码级实现，未做视觉验证）。
7. **多语言链接可分享**：`buildLocaleLinks` 生成带 `?lang=` 的语言栏链接，中文页与英文页指向同一 slug，不存在两份页面数据。

## 失败项、原因与影响

1. **12 种可选语言中只有 4 种有界面文案目录**：`SUPPORTED_LOCALES` 含 12 种语言，而 `UI_CATALOGS` 只有 `zh-CN`、`zh-TW`、`en`、`ja`。选择 ko / es / fr / de / ru / ar / th / vi 时，**日期与数字按该语言格式化，但界面标签会回退为英文**，出现「英文标签 + 韩文/阿拉伯文数字格式」的混排页面。影响：语言栏列出这些语言会造成「已支持」的预期，实际是部分支持，属未完成项。
2. **管理后台界面本身没有多语言**：`public/admin/index.html` 为 `lang="zh-CN"`，侧栏与表单标签全部硬编码中文。方案第三章第 7 条要求「支持多语言界面」，当前只有公开展示页做到了国际化，后台仍是单语。
3. **可翻译字段只有标题与描述**：`property_translations` 仅含 `title`、`description`。因此英文页上地址（`CN 上海市 上海 浦东新区 世纪大道 100 号 3 号楼 1502 室 200120`）与「附加费用」（`物业费 380 元/月由租客承担…`）仍是中文（截图 `06-public-page-en-i18n.png` 可见）。楼层说明、素材来源说明等自由文本同样没有翻译通道。
4. **运营配置文案不参与翻译**：地图免费额度说明（`MAP_FREE_TIER_NOTE`）在英文页仍显示中文（截图可见），因为它是环境变量里的纯文本。
5. **`formatDateOnly` 的时区参数被忽略**：函数签名为 `formatDateOnly(iso, locale, timeZone)`，注释写「按目标时区渲染」，但实现中硬编码 `timeZone: 'UTC'`，第三个参数未被使用。对于「可入住日期」这种纯日期，用 UTC 是正确选择，但签名与实现不一致，后续若传入含时间的值会得到错误结果。
6. **分享链接不随语言变化**：slug 只有一个（中文标题生成，链接形如 `/p/%E6%B5%A6%E4%B8%9C...`）。英文页分享出去的仍是百分号编码的中文 URL，对英文用户不友好；也没有 `hreflang` 之类的搜索引擎提示。
7. **自动化测试缺失**：`tests/domain/i18n.test.ts`、`tests/services/i18n-service.test.ts` 为空文件，多语言逻辑目前只由冒烟测试的 5 条断言覆盖。

## 许可证/安全/隐私影响

- **许可证**：本阶段无新增依赖；语言标签、格式化全部使用 Node 内置 `Intl`，不引入翻译服务或词库包。
- **安全**：译文本质是用户可控内容，渲染时统一经 `escapeHtml` / `escapeAttribute`；语言参数 `?lang=` 只接受白名单内的语言标签，未知值回退默认语言（不会反射到页面）。
- **隐私**：**不使用任何外部机器翻译服务**，房源文案不离开本平台，这一点对房源描述可能含联系方式/门牌的场景是有利的；代价是需要人工录入译文。

## 遗留问题

1. 补齐其余 8 种语言的界面文案目录，或把语言栏收敛为「已完整支持」的 4 种语言，避免「列出来但只能半用」的预期偏差。
2. 决定管理后台是否要做多语言（若不做，需要在文档与界面中明确「后台为中文界面」）。
3. 评估是否扩展可翻译字段（地址、附加费用、楼层说明），或明确这些字段保持原文。
4. 修正 `formatDateOnly` 的签名与实现不一致（要么使用传入时区，要么去掉参数并改注释）。
5. 考虑为多语言提供独立 slug（如 `/en/p/<slug>`）或至少输出 `hreflang`。
6. 补 `tests/domain/i18n.test.ts` 与 `tests/services/i18n-service.test.ts` 的真实测试。

## 是否达到本阶段验收标准：是

- 切换语言不丢失数据：满足（语言为渲染参数；原文/译文分表，实测切换后数据完整）。
- 原始描述不被翻译覆盖：满足（结构性分离 + 同语言译文被拒绝，2 条冒烟断言直接验证，截图亦有提示文案）。
- 格式按配置正确显示：满足（金额、面积、日期随语言变化，工作区默认可配置）。
- 附带条件：12 种语言中 4 种有完整界面文案；后台界面仍为中文；地址与附加费用等自由文本不可翻译。这些都已在上文「失败项」明确登记。

## 下一阶段建议（仅建议，不自动开工）

1. 在托管/子域名阶段之前先确定「多语言 × 多域名」的关系（例如英文站是否绑定英文域名），否则第 6 阶段的域名模型可能只考虑了单语言场景。
2. 语言栏建议改为只列出真正完整支持的语言，或标注「部分支持」。
3. 若后续要做后台多语言，建议复用同一 `UiCatalog` 机制（前端用同一份键名），避免出现两套文案键。