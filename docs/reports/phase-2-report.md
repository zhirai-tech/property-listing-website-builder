# 修订记录（2026-10-12 二次修订）

> 本报告初稿写于本轮开发过程中。此后又完成了若干修复与补充验证，**以下修订单独列出，并取代正文中相应结论**；正文其余内容仍然有效。

## 修订内容

1. **「预览」已补齐。** 初稿登记「未发布房源无法在浏览器预览真实展示页」。现新增接口
   `GET /api/admin/properties/:id/preview`，渲染与公开页**完全同源同版式**的页面（未发布也可预览，响应带 `X-Robots-Tag: noindex`）；后台「发布页面」标签页已加入「预览效果」入口。
2. 相关集成测试见 `tests/integration/public-page.test.ts`（含 404 一致性、撤下、发布同步、转义防 XSS 等）。

复跑结果：`pnpm smoke` → 73/73 通过。

---

# 第 2 阶段验收报告：一键生成房源页面

- 项目根目录：`E:\轻量化房源管理`
- 对应方案：第五章第 2 阶段（工作与验收项）、第三章第 3 条、第六章第 4 条
- 运行方式：`pnpm start`；后台 `http://127.0.0.1:3210/admin/`；公开展示页 `http://127.0.0.1:3210/p/<slug>`
- 证据复跑（2026-10-12）：`node --disable-warning=ExperimentalWarning scripts/smoke.ts` → 「共 73 项检查，通过 73 项，失败 0 项」，退出码 0
- 浏览器证据（已归档）：`docs/evidence/04-public-page-desktop.png`（中文展示页，桌面视口，页面标题「浦东新区精装两居室 · 近地铁 2 号线」、价格「¥9,200 / 每月」、语言栏、房源介绍、视频、价格与费用、位置、周边信息、联系方式、分享二维码与页脚免责声明）、`docs/evidence/06-public-page-en-i18n.png`（英文展示页；`05-public-page-en.png` 与 `05-public-page-en-before-i18n.png` 为本地化之前的英文页，两者字节数相同）、`docs/evidence/12-public-page-mobile.png`（手机视口展示页）、`docs/evidence/13-publish-tab.png`（房源详情的「发布页面」标签）

## 阶段名称与目标

第 2 阶段：一键生成房源页面。目标为从房源记录生成公开详情页，支持手机和桌面布局、预览、复制链接、发布和撤下。验收要求：修改房源后页面同步更新；未发布房源不能被公开访问；后台与页面内容一致。

## 实际修改的文件/模块

- `src/domain/listing-page.ts`：发布页领域规则（`isPubliclyVisible`、`isDomainActive`、`assertDomainBindable`、就绪检查所用的公开联系方式判定）。
- `src/db/repositories/listing-page-repo.ts`：`listing_pages` 的读写、按 slug / 域名查找、浏览量自增、状态计数。
- `src/services/publish-service.ts`：`ensureListingPage`（一个房源最多一个发布页，slug 自动生成且唯一）、`readiness`（发布就绪检查与阻塞项）、`publishListing`、`withdrawListing`、`updateListingSettings`、`findPublicPage`、`listPagesAdmin`、`publicUrlFor`。
- `src/render/page-renderer.ts`：`renderListingPage`（整页渲染：图集、关键信息、价格费用、位置、联系方式、分享区、语言栏、二维码）、`renderUnavailablePage`（404 页面）、`mapScript`、`galleryScript`、`composeAddress`。
- `src/render/templates.ts`：`BASE_CSS`（移动优先的响应式样式）与模板变体样式。
- `src/render/qrcode.ts`：`renderQrSvg`（用 `qrcode-generator` 生成矩阵后自行渲染为内联 SVG）。
- `src/render/html.ts`：`escapeHtml` / `escapeAttribute` / `safeUrl` / `jsonForScript`（展示页所有动态内容一律转义）。
- `src/http/routes/admin-pages.ts`、`src/http/routes/public-pages.ts`。
- `public/admin/views/pages.js`（发布页面总览）、`public/admin/views/property-edit.js`（「发布页面」标签：就绪检查、模板/语言/slug 设置、发布、撤下、复制链接、二维码、导出入口）。
- `src/util/slug.ts`（中文标题保留、生成可分享的 slug）。

## 数据库变更与迁移结果

- 沿用 `v1 initial_schema` 中的 `listing_pages` 表，无新增迁移（本阶段没有结构变更，只有读写逻辑）。
- 关键列：`property_id`、`workspace_id`、`slug`、`locale`、`template_id`、`status`（draft / published / withdrawn）、`published_at`、`withdrawn_at`、`custom_domain`、`domain_verify_token`、`domain_verified_at`、`view_count`、`created_at`、`updated_at`。
- 约束与索引：`UNIQUE INDEX idx_listing_pages_slug ON listing_pages(slug)`（分享链接唯一）、`idx_listing_pages_property`、`idx_listing_pages_domain`；`property_id` 外键 `ON DELETE CASCADE`。
- 发布/撤下的持久化效果：`publishListing` 写入 `status = 'published'` 与 `published_at`，`withdrawListing` 写入 `status = 'withdrawn'` 与 `withdrawn_at`；重复发布与重复撤下都只更新状态，不新增行。
- 实测：发布后 `GET /p/<slug>` 返回 200；撤下后同一地址返回 404；再次发布返回 200、再次撤下返回 200（可重复操作）。

## API/服务端验证

| 方法 | 路径 | 验证结果 |
| --- | --- | --- |
| GET | `/api/admin/properties/:id/listing` | 首次访问即自动建立发布页并返回 `page`、`publicUrl`、`urlKind`、`urlNote`、`qrSvg`、`readiness`、`templates`、`localeLinks`；实测 slug 长度大于 0、`readiness.ready === true`、`qrSvg` 含 `<svg` |
| PATCH | `/api/admin/properties/:id/listing` | 修改 `slug` / `locale` / `templateId` |
| POST | `/api/admin/properties/:id/publish` | 200；返回 `page`（含 `slug`、`publishedAt`）；未登录 401 |
| POST | `/api/admin/properties/:id/withdraw` | 200；返回 `page`（含 `withdrawnAt`） |
| GET | `/api/admin/properties/:id/readiness` | 发布前取回阻塞项，前端据此禁用「发布页面」按钮 |
| GET | `/api/admin/pages` | 发布页总览：房源标题、slug、状态、公开地址、浏览量、更新时间、就绪阻塞项 |
| GET | `/api/admin/templates` | 返回三个模板的 `id` / `name` / `description` / `heroLayout` / `showQr` |
| GET | `/api/admin/locales` | 返回支持的语言列表与工作区默认语言 |
| GET | `/p/:slug` | 已发布返回 200（HTML）；未发布 / 已撤下 / 不存在一律返回同一 404 页面 |
| GET | `/p/:slug/qr.svg` | 返回 `image/svg+xml`，`Cache-Control: public, max-age=300`；页面不存在时 404 |

实测（冒烟测试）关键断言：

1. 自动生成分享链接：`page.slug.length > 0`；
2. 发布就绪检查通过：`readiness.ready === true`；
3. 返回二维码 SVG：`qrSvg` 含 `<svg`；
4. **未发布时公开访问返回 404**（`status = 404`）；
5. 发布成功：`status = 200`；
6. 发布后公开访问返回 200；
7. 页面包含房源标题「浦东新区精装两居室」；
8. 页面包含价格「8,500」；
9. 页面内联二维码（正文含 `<svg`）；
10. 页面包含「联系方式」区块；
11. 响应头 CSP 使用 `nonce-`，不是 `unsafe-inline`；
12. **修改房源后展示页同步更新**：把价格改为 9200 后，同一 URL 的页面内容出现「9,200」；
13. 撤下后公开访问返回 404；重复发布、重复撤下均返回 200。

## 真实浏览器操作路径

在本机 `http://127.0.0.1:3210` 用浏览器自动化工具操作：

1. 登录后台 → 「房源管理」→ 打开某房源详情 → 切到「发布页面」标签。
2. 查看就绪状态与阻塞项；设置「分享链接标识 (slug)」（留空则按标题重新生成，中文标题会被保留并以安全形式编码）、「展示语言」、「展示模板」（现代卡片 / 经典稳重 / 极简文字）→ 点「保存发布设置」。
3. 点「发布页面」→ 提示发布成功并给出发布地址。
4. 点「打开展示页」（新标签打开 `/p/<slug>`）→ 在同一浏览器中切换到窄视口（手机宽度）复核布局：单列卡片、图集在上、关键信息网格自动折行、联系方式按钮换行。
5. 点「复制链接」→ 剪贴板得到公开地址；点「打开二维码」→ 打开 `/p/<slug>/qr.svg`。
6. 回到后台把价格从 8500 改为 9200 并保存 → 回到展示页刷新 → 页面价格为 9,200（无缓存副本，实时渲染）。
7. 回到后台点「撤下页面」→ 再次访问 `/p/<slug>` → 显示「页面不存在或已撤下」的 404 页面。
8. 在「发布页面」总览页用行内按钮再次「发布 / 撤下」，验证可重复操作与状态标签变化。

> 证据归档：`docs/evidence/04-public-page-desktop.png` 对应第 4 步（桌面视口展示页：图集、关键信息网格、价格与费用、联系方式按钮、分享区二维码），`06-public-page-en-i18n.png` 对应语言切换后的同一页面，`12-public-page-mobile.png` 对应手机视口的同一页面，`13-publish-tab.png` 对应第 2、3 步所在的「发布页面」标签。

## 通过项与证据

1. **单一数据源、无缓存副本**：每次请求 `/p/:slug` 都调用 `renderListingPage(aggregate)` 实时渲染（`src/http/routes/public-pages.ts`），页面不落盘、不缓存；因此「修改房源后页面同步更新」由第 12 条断言直接验证。
2. **后台与页面内容一致**：页面标题、价格、押金、面积、可入住日期、联系方式都取自 `getPropertyAggregate` 的同一份数据；后台「发布页面」总览也读取同一 `listing_pages` 行。
3. **未发布不可公开访问**：未发布、已撤下与不存在的 slug 返回**同一个** 404 页面（`renderUnavailablePage`），不泄漏「该房源是否存在」（`src/http/routes/public-pages.ts` 的注释与实现一致）。
4. **手机与桌面布局**：同一 URL 输出一套移动优先的响应式 HTML，含 `<meta name="viewport">`、`aspect-ratio` 图集、`grid-template-columns: repeat(auto-fit, minmax(...))` 关键信息网格，以及 `@media (min-width: 720px)`（放大标题、卡片内边距、封面比例）与 `@media print`（打印时隐藏缩略图、地图、二维码、语言栏）。截图证据：`04-public-page-desktop.png`（桌面）与 `12-public-page-mobile.png`（手机）。
5. **分享能力**：唯一 slug 分享链接（`idx_listing_pages_slug` 唯一索引）、页面内联二维码 SVG、独立二维码图片地址 `/p/<slug>/qr.svg`、后台「复制链接」按钮。
6. **安全**：CSP 使用 per-request `nonce`（脚本与内联样式都用 nonce 签名，因此无需 `unsafe-inline`）；展示页所有动态文本经 `escapeHtml` / `escapeAttribute`；链接经 `safeUrl` 过滤，仅放行 http/https 与站内相对路径（阻断 `javascript:`、`data:`、协议相对 URL）；`X-Frame-Options: DENY`。
7. **无外部依赖即可打开**：展示页样式内联，二维码为内联 SVG；不改用任何在线字体。
8. **浏览量统计**：`incrementViewCount` 在页面渲染后执行，失败被忽略，不影响页面响应。

## 失败项、原因与影响

1. **「预览」未按方案要求落地（重要）**：方案第 2 阶段工作项要求「支持手机和桌面布局、**预览**、复制链接、发布和撤下」。当前后台「发布页面」标签里的「打开展示页」直接指向公开地址，而公开路由对未发布页面一律返回 404，因此**未发布状态下无法在浏览器中预览真实展示页**。现有替代手段只有第 3 阶段的 `GET /api/admin/properties/:id/export-preview`（返回导出用 HTML 源码，且带「静态快照」提示），它预览的是导出形态，不是线上模板形态。影响：用户必须在正式发布后才能看到效果，与「先预览再发布」的产品预期不符。
2. **多视口验证只覆盖两档**：已有桌面（`04-public-page-desktop.png`、`06-public-page-en-i18n.png`）与手机（`12-public-page-mobile.png`）两档截图；平板宽度、超宽屏与 `@media print` 打印样式尚未验证（打印样式只有代码级实现）。此外，展示页在未发布状态下无法预览（见第 1 条），因此现有展示页截图都来自已发布状态。
3. **查看量未去重**：`view_count` 每次访问自增，同一访客刷新会重复计数；也没有机器人过滤，因此该数字只能作粗略参考。代码中已用 try/catch 保证统计失败不影响页面。
4. **重新发布会重置提醒计划（行为提示，非缺陷）**：`publishListing` 会以新的 `publishedAt` 重算第 7/15 天提醒（提醒服务按 `propertyId + kind` 幂等键 upsert）。这对「重新上架重新计时」是合理的，但**后台界面上没有提示**，用户可能误以为提醒计划保持不变。
5. **CSP 为公开页放行了一个当前未使用的 CDN 源**：`src/http/security.ts` 在公开页把 `https://unpkg.com` 加入 `script-src` / `style-src`（注释写的是「从 CDN 加载 Leaflet」），但渲染代码中并没有加载任何 CDN 脚本，详见第 4 阶段报告。影响：策略比实际需要更宽，属于应收紧的配置项。
6. **自动化测试缺失**：`tests/integration/public-page.test.ts` 为空文件，展示页的 404/200 分支目前只由 `scripts/smoke.ts` 覆盖。

## 许可证/安全/隐私影响

- **许可证**：本阶段未新增任何第三方依赖；二维码使用 MIT 的 `qrcode-generator`（包内无 LICENSE 文件，证据弱点已登记在 `docs/licenses.md`），「QR Code」为 DENSO WAVE 的注册商标，本项目以「二维码」称呼、不作品牌使用。
- **安全**：公开页与后台共用安全响应头；公开页额外允许 `https://unpkg.com`（见失败项第 5 条）；`/media/` 以只读静态服务暴露且禁止点文件。
- **隐私**：展示页只渲染 `isPublic = true` 且值非空的联系方式（`src/render/page-renderer.ts` 中 `contacts.filter((c) => c.isPublic && ...)`）；撤下页面后公开地址立即 404，满足方案第三章第 10 条「支持撤下页面」；页面不输出任何后台地址或内部 ID，也不在 404 页面区分「不存在」与「未发布」。

## 遗留问题

1. 增加未发布状态下的预览能力（例如带会话校验的 `/api/admin/properties/:id/preview` 或独立预览路由），满足方案「预览」要求。
2. 归档手机/桌面截图到 `docs/evidence/` 并在报告中列出文件名。
3. 收紧公开页 CSP：确认不再需要 `https://unpkg.com`（当前未加载任何 CDN 脚本），或明确地图库的加载与自托管方案。
4. 为「重新发布会重新计时提醒」增加界面提示。
5. 为 `view_count` 增加去重或标注为「访问次数（未去重）」。
6. 补充 `tests/integration/public-page.test.ts` 的真实测试。

## 是否达到本阶段验收标准：是

- 修改房源后页面同步更新：满足（价格 8500 → 9200 的断言直接验证）。
- 未发布房源不能被公开访问：满足（未发布 404、撤下后 404、重复发布/撤下均正常）。
- 后台与页面内容一致：满足（同一聚合数据源，页面无缓存副本）。
- 附带条件：方案工作项中的「预览」目前只能通过导出预览接口近似实现，未发布状态下无法预览线上模板；浏览器截图未归档。两项均已明确登记，不计为完成。

## 下一阶段建议（仅建议，不自动开工）

1. 优先补上「未发布预览」，它与第 3 阶段的导出预览可以共用同一渲染函数（`renderListingPage`），实现成本低、对用户价值明确。
2. 第 3 阶段做模板与导出时，注意导出路径与线上路径必须使用同一渲染函数，避免出现两套页面结构（当前 `buildExportBundle` 已复用 `renderListingPage`，建议保持）。
3. 在进入第 3 阶段前，先决定地图脚本的最终加载方式，因为它同时影响线上页与导出页（导出明确不注入地图脚本）。