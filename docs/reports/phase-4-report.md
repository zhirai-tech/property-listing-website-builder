# 修订记录（2026-10-12 二次修订）

> 本报告初稿写于本轮开发过程中。此后又完成了若干修复与补充验证，**以下修订单独列出，并取代正文中相应结论**；正文其余内容仍然有效。

## 修订内容 —— 本阶段结论由「否」更正为「是」

初稿判定为「否」，理由是：**页面依赖 `window.L`，但全仓库没有任何加载地图库的 `<script src>`，因此必然走降级分支**。该判断经复核**完全正确**，属于真实缺陷，现已修复：

1. **地图库改为本地自带并提供。** 新增依赖 `leaflet@1.9.4`（BSD-2-Clause，宽松许可），由应用以 `/vendor/leaflet/` 提供同源静态资源；展示页注入 `leaflet.css` 与 `leaflet.js`。这样既不依赖第三方 CDN，`script-src` 也**无需放行任何外部域名**，保持 `'self' 'nonce-…'` 的严格策略。
2. **CSP 样式策略按需放宽且已说明。** Leaflet 通过 `style` 属性定位瓦片与标记，无法避免内联样式；由于 **`style-src` 一旦带 nonce，浏览器就会忽略 `unsafe-inline`**，两者不能并存。因此：公开展示页 `style-src 'self' 'unsafe-inline'`（仅样式放宽），`script-src` 依旧严格；后台接口**不放宽**内联样式。该权衡已写入设计说明与 `tests/integration/security.test.ts` 断言。
3. **新增瓦片可用性检测。** 若地图库加载失败，或连续 3 次瓦片请求失败且无一成功，则**如实降级**为地址文本，而不是留一张空白地图。
4. **清理了残留占位文本**（初始化 Leaflet 前清空容器）。

**修复后的实测证据**（真实浏览器，`docs/evidence/15-public-page-map-working.png`）：

```
leafletLoaded : true          leafletVersion : 1.9.4
hasLeafletDom : true          tiles          : 10
loadedTiles   : 10            （全部瓦片加载成功）
scriptSrc     : ["/vendor/leaflet/leaflet.js"]
cssHref       : ["/vendor/leaflet/leaflet.css"]
```

页面渲染出房源真实坐标（31.2304, 121.4737，上海世纪大道）的 OpenStreetMap 街区地图，含标记、缩放控件与署名。

**仍然存在的限制（未按已完成报告）：**

- **周边信息（Overpass）未用真实数据验证。** 端点已改为可配置（`MAP_OVERPASS_ENDPOINT`），但本机环境对该公共实例的请求一律返回 **HTTP 406**（经 4 种请求形式逐一验证，均为 406，判断为网络策略拦截而非代码问题；同一环境下 OSM 瓦片可正常访问）。因此**只验证了降级路径**：页面显示「周边服务返回 HTTP 406；展示页仍会正常显示地址文本与地图定位」，符合「地图服务故障时仍可显示地址」的验收要求。
- 商用前需明确瓦片服务与周边信息服务的免费额度及超额费用（界面已展示免费额度提示）。

---

# 第 4 阶段验收报告：地图与周边信息

- 项目根目录：`E:\轻量化房源管理`
- 对应方案：第五章第 4 阶段（工作与验收项）、第三章第 6 条、第八章第 4 条
- 运行配置（本机 `.env`）：`MAP_PROVIDER=osm`、`MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png`、`MAP_ATTRIBUTION=© OpenStreetMap contributors`、`MAP_API_KEY=`（空）
- 浏览器证据（已归档）：`docs/evidence/04-public-page-desktop.png`、`docs/evidence/06-public-page-en-i18n.png`

## 阶段名称与目标

第 4 阶段：地图与周边信息。目标为加入地图定位及周边信息，地图服务通过统一适配层接入，支持后续替换服务商。验收要求：位置准确；密钥安全；地图服务故障时仍可显示地址；说明服务额度和费用风险。

## 实际修改的文件/模块

- `src/adapters/map.ts`：地图适配层核心。
  - `MapProvider` 接口：`buildView(input)` + `nearby(input, signal)`，业务代码只依赖该接口；
  - `OsmMapProvider`：默认实现，使用 OSM 公共瓦片（无密钥），`buildView` 产出 `tileUrl`、`attribution`、`zoom: 15`、`fallbackAddress`、`freeTierNote` 与 `degraded` / `degradedReason`；
  - `nearby()`：向公共 Overpass API（`https://overpass-api.de/api/interpreter`）POST 查询，半径默认 1000 米，筛选学校/医院/车站/地铁口/公交站/超市/商场/药店/公园等，`out body 30`、结果取最近 12 条并按距离排序；
  - 稳定性设计：8 秒超时（`AbortController`）、24 小时内存缓存、请求带 `User-Agent`、任何异常都返回 `available: false` + 中文 `reason`，**从不抛出到页面**；
  - `haversineMeters()`：Haversine 距离计算（导出供测试使用）；
  - `DisabledMapProvider`：`MAP_PROVIDER=disabled` 时完全关闭地图，只显示地址文本。
- `src/adapters/registry.ts`：按配置选择地图实现并注入 `AppContext`。
- `src/render/page-renderer.ts`：`renderLocation()`（地址文本 + 经纬度 + 地图容器或静态降级块 + `freeTierNote` 说明）、`renderNearby()`（「查看周边信息」按钮与按需加载区域）、`mapScript()`（浏览器端地图初始化与降级逻辑）。
- `src/http/routes/public-pages.ts`：`GET /p/:slug` 注入 `mapView`；`?nearby=1` 时按需拉取周边；`GET /p/:slug/nearby.json` 提供周边 JSON（`Cache-Control: public, max-age=600`）。
- `src/http/routes/admin-settings.ts`：`GET/PUT /api/admin/external-services`（适配器配置，拒绝保存疑似密钥字段）、`GET /api/admin/settings`（返回适配器名与脱敏配置）。
- `public/admin/views/settings.js`：外部服务适配器配置界面（适配器类型、服务商标识、密钥环境变量名、免费额度说明、`tileUrl` 等非敏感参数）。
- `.env.example`：`MAP_PROVIDER` / `MAP_TILE_URL` / `MAP_ATTRIBUTION` / `MAP_API_KEY` / `MAP_FREE_TIER_NOTE` 五项配置及注释。

## 数据库变更与迁移结果

- 本阶段无新增迁移；使用 `v1 initial_schema` 中的 `external_service_configs` 表：`adapter_kind`、`provider`、`config_json`、`secret_refs_json`、`enabled`、`free_tier_note`、`updated_at`，并有唯一索引 `idx_external_service_kind(workspace_id, adapter_kind)`。
- 设计约束：**数据库只存非敏感配置与密钥的环境变量名**（`secret_refs_json`），密钥本体永不入库、不入前端；`PUT /api/admin/external-services` 对 `config` 中键名匹配 `(password|secret|token|api[_-]?key|access[_-]?key)` 的字段直接拒绝保存并返回字段级中文提示。
- 房源经纬度存储在既有 `properties.latitude` / `properties.longitude`（REAL，可为空），无结构变更。

## API/服务端验证

| 方法 | 路径 | 验证结果 |
| --- | --- | --- |
| GET | `/p/:slug` | 页面「位置」区块渲染地址文本、经纬度与地图容器；`mapView.enabled` 为真且坐标齐全时输出 `#map` 容器（带 `data-lat` / `data-lng` / `data-zoom` / `data-tile` / `data-attribution`）；坐标缺失时输出静态降级块 |
| GET | `/p/:slug?nearby=1` | 仅在显式请求且坐标齐全时拉取 Overpass；否则不发起外部请求 |
| GET | `/p/:slug/nearby.json` | 页面不存在返回 404；未填经纬度返回 `{ available: false, reason: '该房源未填写经纬度', places: [], source: 'none' }`；正常返回 `{ available, reason, places[], source }`，`Cache-Control: public, max-age=600` |
| GET | `/api/admin/settings` | 返回 `adapters.map` 名称、`map.provider` / `tileUrl` / `attribution` / `freeTierNote` 与脱敏后的密钥状态（`已设置` / `(未设置)`） |
| GET | `/api/admin/external-services` | 返回已有适配器配置、可选类型（map / storage / mail / hosting）与「密钥只存环境变量名」的说明 |
| PUT | `/api/admin/external-services` | 正常保存非敏感配置；含 `apiKey` 一类键名时返回 400 与「疑似密钥字段被拒绝保存」提示 |

复跑：`node --disable-warning=ExperimentalWarning scripts/smoke.ts` 73/73 通过（该套件不包含地图与周边断言，见失败项第 2 条）。

## 真实浏览器操作路径

1. 打开公开展示页（桌面视口）→ 「位置」区块显示地址 `CN 上海市 上海 浦东新区 世纪大道 100 号 3 号楼 1502 室 200120` 与「经纬度：31.2304, 121.4737」。
2. 截图归档：`docs/evidence/04-public-page-desktop.png`（中文页）、`docs/evidence/06-public-page-en-i18n.png`（英文页）。
3. 同一页面「周边信息」区块显示说明「周边交通、商店、学校等信息按需查询，不在打开页面时自动请求。」与「查看周边信息」按钮；点击后才会请求周边数据。
4. 后台「设置」页 → 外部服务适配器区域：选择适配器类型、填写服务商标识、密钥环境变量名与免费额度说明，保存后回到设置页可见。

## 通过项与证据

1. **适配层可替换**：业务代码（`src/render/page-renderer.ts`、`src/services/export-service.ts`、`src/services/hosting-service.ts`、`src/services/reminder-service.ts`）只通过 `ctx.adapters.map` 使用地图能力；切换服务商只需改 `src/adapters/registry.ts` 的分支与 `.env` 配置，不需要改业务代码。`DisabledMapProvider` 证明适配层可以完全替换为「无地图」实现。
2. **密钥安全**：默认实现不需要密钥（`MAP_API_KEY` 为空即正常工作，瓦片地址是可公开信息）；适配器配置接口拒绝保存疑似密钥字段；`redactedConfig` 只输出「已设置 / (未设置)」；`MAP_API_KEY` 不会出现在任何渲染出的 HTML 中（`buildView` 只输出 `tileUrl` 与 `attribution`）。
3. **故障时仍可显示地址**：`buildView` 无论如何都带 `fallbackAddress`；`nearby()` 的所有失败分支都返回中文原因而不是抛错；页面在地图不可用时保留地址、经纬度与提示文字。**该降级路径在真实浏览器中被实际触发并截图**（见失败项第 1 条：地图确实未渲染，页面显示了降级提示，地址信息完好）。
4. **费用与额度说明**：`.env.example` 的 `MAP_FREE_TIER_NOTE`、页面「地图服务说明」行（截图可见「地图服务说明: OSM 公共瓦片服务免费但存在使用量限制，商用前请阅读其使用政策」）、后台适配器配置中的「免费额度说明」字段，三处共同落地方案第三章第 6 条「上线前明确免费额度及潜在费用」。
5. **按需加载周边信息**：`GET /p/:slug` 默认不发外部请求，只有点击「查看周边信息」（`?nearby=1`）或调用 `/p/:slug/nearby.json` 才访问 Overpass，并带 8 秒超时、24 小时缓存与降级返回。
6. **署名**：`MAP_ATTRIBUTION` 默认 `© OpenStreetMap contributors`，随地图容器 `data-attribution` 下发；周边数据来源标注 `OpenStreetMap Overpass API`（`NearbyResult.source`）。

## 失败项、原因与影响

1. **交互式地图实际上不可用（重要，已由截图证实）**：页面输出的地图容器依赖浏览器全局 `window.L`（`src/render/page-renderer.ts` 的 `mapScript()`），但**仓库中没有任何加载地图库（Leaflet 一类）的 `<script src>` 或样式引用**——把 `src/`、`public/`、`scripts/`、根目录文件全量检索 `leaflet` / `unpkg` 只命中：`mapScript()` 里对 `window.L` 的使用、`src/http/app.ts` 的一句注释「公开展示页需要从 CDN 加载 Leaflet」、以及 `src/http/security.ts` 中为公开页放行的 `https://unpkg.com`。因此该脚本必然走到 `if (!window.L)` 分支。**真实浏览器截图 `docs/evidence/04-public-page-desktop.png` 与 `06-public-page-en-i18n.png` 中，地图区域显示为**「地图组件未能加载（可能处于离线环境或脚本被拦截），上方地址信息不受影响。」（英文页同义文案）。影响：方案第 4 阶段的核心工作项「加入地图定位」在当前构建中**未实际交付**——用户能看到地址与经纬度，但看不到地图；「位置准确」这一验收项无法在地图上得到确认。
2. **周边信息（Overpass）未经真实网络验证**：73 项冒烟检查中没有任何一项覆盖 `nearby()`；也没有周边信息区块的浏览器截图或日志证据。当前只有代码级实现（查询语句、分类映射、距离排序、超时、缓存、降级）。影响：公共 Overpass 实例的可用性、返回结构是否符合解析预期、以及 8 秒超时是否合适，都属未验证。
3. **商用瓦片政策未复核**：直接使用 `tile.openstreetmap.org` 公共瓦片。免费、无需密钥，但有使用量限制，商业部署前必须复核其使用政策（已作为 `MAP_FREE_TIER_NOTE` 提示与 `docs/licenses.md` 第 5 节的待办项）。
4. **CSP 放行了当前未使用的 CDN 源**：公开页 `script-src` / `style-src` 含 `https://unpkg.com`，但没有任何请求会使用它。影响：策略面比实际需要更宽；若将来真的从 CDN 加载地图库，还需要补充版本锁定与 SRI（子资源完整性）决策，或改为自托管。
5. **降级文案的本地化不完整**：英文页 `06-public-page-en-i18n.png` 中，「Map service notice」后面的免费额度说明仍是中文（`MAP_FREE_TIER_NOTE` 是运营配置文本，没有翻译机制）。
6. **隐私：精确坐标默认公开**：房源经纬度原样渲染到公开页与导出页（截图可见「经纬度: 31.2304, 121.4737」）。对于住宅房源，精确坐标等价于公开门牌位置。当前没有「只显示区域中心 / 模糊化坐标」的选项，也没有在后台提示这一点。

## 许可证/安全/隐私影响

- **许可证**：地图瓦片与周边数据来自 OpenStreetMap（数据版权归 OSM 贡献者），署名要求已通过 `MAP_ATTRIBUTION` 与 `nearby.source` 落地；未引入任何新的 npm 依赖。**当前未引入前端地图库**，因此不存在该库的许可证义务；一旦引入，必须先核验其许可证与署名方式（列在 `docs/licenses.md` 第 7 节）。
- **安全**：地图与周边能力全部在服务端编排，密钥不进入前端；适配器配置接口主动拒绝疑似密钥字段；`nearby` 请求设置了超时与缓存，避免页面被外部服务拖死；页面在 `img-src` 中允许 `https:`（用于瓦片图片）。
- **隐私**：精确经纬度公开问题见失败项第 6 条；周边信息不预加载（不在打开页面时暴露访客 IP 给第三方服务），这是对隐私有利的默认值。

## 遗留问题

1. 决定地图库的最终形态并落地：自托管 Leaflet（含 CSS）或从白名单 CDN 加载 + SRI；完成后重新截图归档，才能把「地图定位」计为已交付。
2. 用真实网络验证一次 Overpass 查询（正常返回与超时两种情形），并把结果（含 `source`、条数、耗时）记录到报告中。
3. 复核 OSM 瓦片使用政策，并给出商用方案（自建瓦片 / 商业服务商 / 保持现状的风险说明）。
4. 为精确坐标提供隐私选项（模糊到区域/街道级别），并在后台给出提示。
5. 收紧公开页 CSP，移除当前未使用的 `https://unpkg.com`。
6. 让免费额度说明支持多语言（或明确标注为运营配置、不参与翻译）。

## 是否达到本阶段验收标准：否

- 位置准确：**未达成**——地址与经纬度文本正确，但页面上没有可用的地图（浏览器截图显示地图区域处于「组件未能加载」降级状态），无法验证「地图上的位置准确」。
- 密钥安全：达成（默认无需密钥；配置接口拒绝保存密钥；前端与数据库均不含密钥）。
- 地图服务故障时仍可显示地址：达成（降级逻辑真实触发，地址与经纬度完好）。
- 说明服务额度和费用风险：达成（配置项 + 页面说明行 + 后台免费额度字段）。
- 结论：四项验收项中三项达成，核心的「地图定位」因前端地图库未加载而未实际交付，故本阶段判定为**未达到验收标准**；补齐第 1 条遗留问题后需重新验收。

## 下一阶段建议（仅建议，不自动开工）

1. 把「加载地图库并截图验证」作为第 4 阶段收尾的第一件事，否则后续阶段（托管、上线准备）都会带着一个已知不可用的地图对外演示。
2. 如果决定暂时不做交互地图，则应修改产品口径与文档：把地图定位改为「地址 + 经纬度 + 一键跳转第三方地图」的降级形态，并同步更新 `.env.example`、CSP 与模板样式，避免留下「看起来能用但实际不能用」的界面。
3. 周边信息建议先做成可关闭的实验特性，待真实网络验证通过后再默认启用。