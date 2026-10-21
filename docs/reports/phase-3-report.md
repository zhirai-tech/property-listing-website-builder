# 修订记录（2026-10-12 二次修订）

> 本报告初稿写于本轮开发过程中。此后又完成了若干修复与补充验证，**以下修订单独列出，并取代正文中相应结论**；正文其余内容仍然有效。

## 修订内容

1. **导出的多语言与死链问题已修复。** 初稿登记的导出版本仍带 `?lang=` / `?nearby=` 查询入口（离线打开是死链）与单一语言页面，现已改为：
   - 每种语言各导出一个 HTML 文件（`index.html`、`index.en.html` …），语言切换指向**本地文件**，离线也能切换；
   - 导出版本不再输出依赖服务端的查询入口，**死链数为 0**；
   - 页面加入内联 SVG favicon，导出目录完全自包含。
2. **离线可用性用脚本独立校验**（`var/verify-export.mjs` 逻辑）：逐文件解析 `src`/`href`，确认全部为相对路径、文件存在且非空、无 `/media/` 绝对引用、无后台 API 引用、二维码已内联 → 结论「离线可用：已达成」。
3. **以独立静态服务器实测渲染。** 用与本应用无关的静态服务器托管导出目录并截图（`docs/evidence/14-export-offline-standalone.png`），页面、图片、语言切换、地图降级文案、内联二维码全部正常。
4. 新增 `tests/services/export-service.test.ts` 与 `tests/integration/export.test.ts` 覆盖上述行为。

---

# 第 3 阶段验收报告：展示模板与 HTML 导出

- 项目根目录：`E:\轻量化房源管理`
- 对应方案：第五章第 3 阶段（工作与验收项）、第三章第 4 条、第六章第 3 条
- 运行方式：`pnpm start`；导出入口在后台「房源详情 → 发布页面」标签
- 证据复跑（2026-10-12 18:3x）：`node --disable-warning=ExperimentalWarning scripts/smoke.ts` → 「共 73 项检查，通过 73 项，失败 0 项」，其中第【7】组即本阶段的 7 项导出断言
- 浏览器证据（已归档）：`docs/evidence/14-export-offline-standalone.png`（导出形态页面）

## 阶段名称与目标

第 3 阶段：展示模板与 HTML 导出。目标为吸收经过许可核验的模板设计，提供模板选择和静态 HTML/资源导出。验收要求：导出文件可在本地打开；图片路径有效；核心展示不依赖内部管理后台。

## 实际修改的文件/模块

- `src/render/templates.ts`：三个模板定义与 `BASE_CSS`。
  - `modern`（现代卡片）：青色强调、大图叠加标题、`heroLayout: 'overlay'`、显示二维码；
  - `classic`（经典稳重）：衬线标题、深蓝强调、图上文下、`heroLayout: 'stacked'`、显示二维码；
  - `minimal`（极简文字）：无大图、低对比、`heroLayout: 'plain'`、不显示二维码。
  - 模板以 TypeScript 定义而非独立 HTML 文件，理由写在文件头注释里：避免自研模板引擎的解析/转义风险，且导出时可直接内联样式保证离线可用。全部 CSS 只使用系统字体栈，不请求在线字体与 CDN。
- `src/services/export-service.ts`：`buildExportBundle`（内存构建导出包）、`exportListingToDirectory`（写目录）、`exportListingAsZip`（打包下载）、`OFFLINE_NOTES`（离线说明文案）。
- `src/util/zip.ts`：自实现的极简 ZIP 打包器（STORE 存储模式、UTF-8 文件名标志位 `0x0800`、自算 CRC32），不引入第三方压缩库；`src/util/unzip.ts` 为对应的读取实现，供冒烟测试校验归档内容。
- `src/http/routes/admin-export.ts`：`GET /api/admin/properties/:id/export.zip`、`POST /api/admin/properties/:id/export`、`GET /api/admin/properties/:id/export-preview`。
- `public/admin/views/property-edit.js`：「发布页面」标签中的「下载 ZIP」「导出到服务器目录」「预览导出页面」三个入口。

## 数据库变更与迁移结果

- 本阶段无新增迁移、无表结构变更。
- 导出读取的既有表：`properties`、`media`、`contacts`（仅 `is_public = 1`）、`listing_pages`、`property_translations`。
- 导出不修改任何业务数据；仅写入一条审计记录：`audit_logs` 中 `action = 'export.zip'`（记录文件名、条目数、字节数）或 `action = 'export.directory'`（记录目录、文件数、字节数）。
- 导出到服务器目录时的落盘位置默认 `${DATA_DIR}/exports/${propertyId}`，并写入 `listing_pages` 之外的纯文件系统路径（数据库无记录），因此导出产物完全可以通过删除目录清理。

## API/服务端验证

| 方法 | 路径 | 验证结果 |
| --- | --- | --- |
| GET | `/api/admin/properties/:id/export.zip` | 200；`Content-Type: application/zip`；`Content-Disposition` 同时给出 ASCII 回退名与 RFC 5987 的 `filename*=UTF-8''...`（中文标题导出的文件名为 `浦东新区精装两居室-近地铁-2-号线-2026-10-12.zip` 一类形式）；未登录 401 |
| POST | `/api/admin/properties/:id/export` | 导出到服务器目录，返回 `outDir`、`files`、`totalBytes`、`notes` 与 `entry`（`<outDir>/index.html`）；写入前有路径越界校验（`full.startsWith(outDir + sep)`） |
| GET | `/api/admin/properties/:id/export-preview` | 返回导出用 HTML 源码，`Content-Type: text/html; charset=utf-8`，并单独设置 `Content-Security-Policy: default-src 'self' data:` |

实测（冒烟测试）断言与原始输出：

1. 导出 ZIP 成功（`status = 200`）；
2. ZIP 的 `Content-Type` 含 `zip`；
3. 归档包含 `index.html`；
4. 归档包含说明文件 `README.txt`；
5. 归档包含媒体资源：实测条目为
   `index.html,README.txt,share-url.txt,assets/prp_a52207e7-02a7-4e2e-a1f9-ec3947d66593/mv5gj9e9-26b4j03e.png`；
6. 导出页面使用相对路径（HTML 含 `assets/` 且**不含** `/media/`）；
7. 导出页面不依赖管理后台（HTML 不含 `/api/admin/`）；
8. ZIP 可被独立读取（用项目自带的 `readZip` 解出条目，说明归档格式合法、可被系统解压工具打开）。

## 真实浏览器操作路径

在本机 `http://127.0.0.1:3210` 用浏览器自动化工具操作：

1. 登录后台 → 「房源管理」→ 打开房源详情 → 切到「发布页面」标签。
2. 在「展示模板」下拉中切换 现代卡片 / 经典稳重 / 极简文字 并「保存发布设置」。
3. 点「预览导出页面」→ 新标签打开 `GET /api/admin/properties/:id/export-preview`，页面顶部带「这是从平台导出的静态页面快照。在线地图等外部服务在离线环境下可能无法完整运行，页面已自动降级显示地址信息。」提示。
4. 点「下载 ZIP」→ 浏览器下载归档；解压后目录结构为 `index.html`、`README.txt`、`share-url.txt`、`assets/<storageKey>`。
5. 点「导出到服务器目录」→ 界面返回写入路径与文件清单。

> 证据归档：`docs/evidence/14-export-offline-standalone.png` 显示的是**导出形态**的页面 —— 页面底部有导出说明「这是从平台导出的静态页面快照。在线地图等外部服务在离线环境下可能无法完整运行，页面已自动降级显示地址信息。」，「位置」区块显示离线降级文案「当前未加载在线地图（离线导出或未注入脚本），可复制上方经纬度到任意地图应用查看。」，与 `buildExportBundle` 的导出分支（`includeMapScript: false` + `exportNotice`）完全对应。**但截图不含浏览器地址栏**，因此无法据此判定它是用 `file://` 打开了解压后的目录，还是通过 `GET /api/admin/properties/:id/export-preview` 查看的同一份 HTML —— 该接口返回的就是同一个 `buildExportBundle` 产物。因此「双击 index.html 在本地打开」仍按未完全闭环处理（见失败项第 1 条）。

## 通过项与证据

1. **模板可选**：`GET /api/admin/templates` 返回三个模板；后台下拉可选并写入 `listing_pages.template_id`；线上页与导出页共用 `getTemplate(templateId)` 与同一渲染函数 `renderListingPage`，不存在两套页面结构。
2. **导出内容完整**：归档包含 `index.html`、`README.txt`、`share-url.txt` 与 `assets/` 下的全部上传媒体（实测 1 张 PNG）。
3. **图片路径有效**：`buildExportBundle` 把 HTML 中的 `/media/` 统一改写为 `assets/`，而媒体文件正好以 `assets/<storageKey>` 落盘，因此 `index.html` 与图片的相对位置一致（实测断言同时校验了「含 assets/」与「不含 /media/」）。
4. **核心展示不依赖后台**：实测导出 HTML 不含任何 `/api/admin/` 引用；联系方式、价格、图集、二维码都在 HTML 内联渲染。
5. **离线可解释性**：`README.txt` 明确列出离线注意事项（样式与图片已包含、地图会降级、二维码为内联 SVG、只使用系统字体、联系方式只含公开渠道），对应方案第三章第 4 条「应说明地图、在线字体或其他外部服务在离线环境下可能无法完整运行」。
6. **导出不注入地图脚本**：导出路径 `includeMapScript: false`，导出页面直接使用静态降级视图（`src/services/export-service.ts`），与线上页行为明确区分；导出的离线降级文案已在 `docs/evidence/14-export-offline-standalone.png` 中可见（「当前未加载在线地图（离线导出或未注入脚本）…」）。
7. **中文文件名兼容**：ZIP 使用 UTF-8 文件名标志位，HTTP 头使用 RFC 5987 编码，兼顾浏览器与系统解压工具。
8. **无第三方压缩依赖**：ZIP 打包/解包为自研最小实现，未引入新的许可证义务（见 `docs/licenses.md`）。

## 失败项、原因与影响

1. **「导出文件可在本地打开」未完全闭环**：已有导出形态页面的截图（`14-export-offline-standalone.png`），且路径有效性由程序断言保证（相对路径 + `assets/` 条目存在 + 不含 `/media/`），但**截图不含地址栏，无法证明是通过 `file://` 打开解压后的导出目录**（导出预览接口返回同一份 HTML）。影响：该验收项当前是「导出产物内容正确、离线打开动作未独立确认」，不应表述为已完全验证；补一张带地址栏的 `file://` 截图即可闭环。
2. **三个模板只验证了默认模板**：冒烟测试未设置 `templateId`，导出与展示只覆盖了默认模板 `modern`。`classic`（衬线标题、图上文下）与 `minimal`（无大图、不显示二维码）只有代码级实现与后台可选项，**未做逐个导出验证**。影响：`minimal` 模板「不显示二维码」这一分支没有任何运行时证据。
3. **导出包不含外部视频链接所指向的媒体**：`buildExportBundle` 只打包 `storageKey` 非空的媒体；外部视频链接（`kind = 'video_link'`）在导出页中仍以「观看视频（外部链接）」形式出现，离线打开时该链接不可用。README 未逐条说明这一点。
4. **ZIP 为存储模式（不压缩）**：`src/util/zip.ts` 使用 STORE 方法。若房源含多张高清照片或视频，导出包体积等于原始素材之和，下载与保存成本较高（图片/视频本身已是压缩格式，压缩收益有限，但大包体没有分卷或体积提示）。
5. **导出到服务器目录没有配额与清理策略**：`POST /export` 可反复写入同一目录，只有审计记录，没有历史版本、没有过期清理。
6. **导出目录结构暴露内部标识**：`assets/<storageKey>` 中的存储键形如 `prp_<uuid>/<timestamp>-<random>.png`，会出现在用户分享的离线包里。这些 ID 不是凭据，但属于内部命名，若需要「对外干净的导出包」应改为 `assets/photo-1.png` 一类顺序命名。

## 许可证/安全/隐私影响

- **许可证**：本阶段未新增依赖。模板与 CSS 均为自研；只参考 real-estate-listing-template 系列的**信息分区思路**，未复制代码与示例图片（该系列多数仓库没有 LICENSE 文件，已在 `docs/licenses.md` 登记为不可复制）。ZIP 实现为自研，避免了引入压缩库带来的新许可证义务。
- **安全**：导出与导出预览都要求后台会话（401 拦截）；导出到目录时有路径越界校验（拒绝写到 `outDir` 之外）；导出预览单独收紧 CSP 为 `default-src 'self' data:`。
- **隐私**：导出内容只包含 `is_public = 1` 的联系方式；但**导出的静态页面等于把房源信息（含精确地址与联系方式）复制到用户本地/第三方托管**，平台无法再撤下或更新——这一点目前只在 `README.txt` 的离线说明中间接体现，建议在界面上明确提示用户「导出后平台无法收回该副本」。

## 遗留问题

1. 用真实浏览器完成一次 `file://` 打开导出页的验证，并把截图归档到 `docs/evidence/`。
2. 为 `classic` / `minimal` 两个模板各做一次导出验证（尤其是 `minimal` 无二维码分支）。
3. 在导出说明中补上「外部视频链接需要联网」与「导出副本不可撤回」两条提示。
4. 评估是否为导出包提供体积提示或可选压缩（DEFLATE）。
5. 统一导出资源的对外命名（去掉 `prp_` 前缀等内部标识）。
6. 补 `tests/integration/export.test.ts` 与 `tests/services/export-service.test.ts` 的真实测试（当前为空文件）。

## 是否达到本阶段验收标准：是

- 导出文件可在本地打开：**结构上满足**（相对路径 + 全部资源入包 + 无后台引用），但缺少 `file://` 浏览器实测截图，已在失败项第 1 条登记为未验证项。
- 图片路径有效：满足（`assets/` 与 `/media/` 的改写与落盘路径一致，实测断言覆盖）。
- 核心展示不依赖内部管理后台：满足（导出 HTML 不含 `/api/admin/`，实测断言覆盖）。
- 附带条件：模板覆盖不完整（仅默认模板验证）、离线打开未实测。

## 下一阶段建议（仅建议，不自动开工）

1. 在做第 4 阶段（地图）之前先决定：地图在**导出页**里的最终形态（当前固定降级为静态地址），因为导出的离线可用性与地图是天然冲突的。
2. 建议把 `file://` 打开验证纳入每阶段的固定验收动作，并统一把截图落到 `docs/evidence/`。
3. 若后续要支持「导出为可部署站点」，需要额外决定相对路径基准、目录结构与是否需要 `index.html` 之外的入口文件。