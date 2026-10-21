# 许可证与授权证据归档

- 项目：轻量化房源管理与一键房源网站生成平台
- **快照日期：2026-10-12**
- 核验方式：读取本机 `node_modules/<包>/package.json` 的 `license` 字段与包内 LICENSE 文件；候选开源项目读取 GitHub API 元数据（2026-10-12）
- **重要声明：本文件是 2026-10-12 的证据快照，不是长期有效的授权结论。商用发布（对外收费、公开托管、商业推广）之前，必须重新核验主项目、全部依赖、外部服务条款与媒体素材授权，并更新本文件的快照日期与结论。** 方案第八章第 1 条要求「保存主项目、依赖、模板和媒体素材的许可证/授权证据；条款不明确时先暂停使用」，本文件即该项交付物。

---

## 1. 候选开源项目：许可证状态与采用决定

| 项目 | 许可证（2026-10-12） | 核验结论 | 采用决定 | 备注 |
| --- | --- | --- | --- | --- |
| `etewiah/property_web_builder` | MIT | 标准许可证，条款清晰 | **不采用为底座** | 未采用原因与许可证无关，而是环境（无 Ruby/Rails 工具链）、数据模型取向（MLS 型网站 CMS）与体积（约 96 MB）三条，详见 `docs/phase0-decision-record.md` |
| `microrealestate/microrealestate` | `NOASSERTION`（非标准/自定义条款） | **条款不明确** | **排除，不引入任何代码** | 依据方案第八章第 1 条「条款不明确时先暂停使用」；仓库存在关于变更许可证条款的开放讨论（issue #264），条款仍在变动 |
| `clawnify/OpenProperty` | MIT | 标准许可证，条款清晰 | 仅作后台界面**设计参考** | 未复制任何代码，故不产生许可证义务 |
| real-estate-listing-template 系列（`radwan503/Faname--RealEstate`、`singdisain/rehomes-colorlib` 等） | **多数仓库没有 LICENSE 文件** | 授权范围不明确 | 仅作展示页**视觉结构参考** | 未复制代码，未复制任何示例图片；「模板代码可见」不等于「其中照片可商用」 |

---

## 2. 实际使用的运行期依赖（进入生产运行）

版本为本机 `node_modules` 中实际安装的版本（2026-10-12 读取 `package.json` 核验）。

| 包名 | 安装版本 | 许可证 | 版权/作者 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `fastify` | 5.12.5 | MIT | The Fastify team | 包内 `LICENSE`（首行 `MIT License`，`Copyright (c) 2016-present The Fastify team`） | 可用；保留版权与许可声明 |
| `@fastify/cookie` | 11.1.3 | MIT | The Fastify team | 包内 `LICENSE` | 可用 |
| `@fastify/multipart` | 9.4.0 | MIT | The Fastify team | 包内 `LICENSE` | 可用 |
| `@fastify/static` | 8.3.0 | MIT | The Fastify team | 包内 `LICENSE` | 可用 |
| `qrcode-generator` | 2.0.4 | MIT | Kazuhiko Arase | **包内没有 LICENSE 文件**；许可证依据 `package.json` 的 `"license": "MIT"` 与作者字段 | 可用，但属**证据弱点**（见第 7 节第 3 项） |

**商标提示**：`qrcode-generator` 的 README 明确记载 —— *The word 'QR Code' is registered trademark of DENSO WAVE INCORPORATED*（<http://www.denso-wave.com/qrcode/faqpatent-e.html>）。因此本项目在界面与文档中把该图形称为「二维码」并以功能性方式呈现，不把「QR Code」作为产品名称或品牌使用。

---

## 3. 实际使用的开发依赖（不进入生产运行）

| 包名 | 安装版本 | 许可证 | 版权/作者 | 证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `typescript` | 5.9.3 | **Apache-2.0** | Microsoft Corp. | 包内 `LICENSE.txt` 为 Apache License 2.0 全文 | 可用。**注意：TypeScript 不是 MIT，而是 Apache-2.0**；本项目按 Apache-2.0 的要求保留许可证与 NOTICE 声明。此前「全部依赖均为 MIT」的初步假设已被实际核验否定，此处以实测结果为准 |
| `@types/node` | 24.19.2 | MIT | Microsoft Corporation | 包内 `LICENSE` | 可用 |

---

## 4. 已在 `package.json` 声明但源码未使用的依赖

| 包名 | 声明版本 | 安装版本 | 许可证 | 核验结果 |
| --- | --- | --- | --- | --- |
| `zod` | `^4.0.5` | 4.6.6 | MIT（Colin McDonnell） | **源码中没有任何引用**：对 `src/`、`scripts/`、`public/`、`tests/` 全量检索 `zod` 无命中；项目的输入校验为手写校验器（`src/domain/validate.ts`）。属未清理的声明依赖，不产生运行时许可证义务，但应在下一阶段清理出依赖清单（见第 7 节第 4 项） |

---

## 5. 外部数据与服务：署名义务与商用限制

| 服务 | 用途 | 代码位置 | 署名/义务 | 商用前必须做的事 |
| --- | --- | --- | --- | --- |
| OpenStreetMap 瓦片服务（`https://tile.openstreetmap.org/{z}/{x}/{y}.png`） | 展示页地图底图 | `src/adapters/map.ts`、`.env` 的 `MAP_TILE_URL` / `MAP_ATTRIBUTION` | 必须显示署名（默认值 `© OpenStreetMap contributors`），该署名随地图容器属性下发（`page-renderer.ts` 的 `data-attribution`） | **复核 OSM 瓦片使用政策**：公共瓦片服务免费且无需密钥，但存在使用量限制，商业部署需要单独评估（可自建瓦片或切换到商业服务商）。该提示已作为 `MAP_FREE_TIER_NOTE` 配置项落在 `.env.example` 中，属于方案第三章第 6 条「上线前明确免费额度及潜在费用」的落地 |
| OpenStreetMap 数据 / Overpass API（`https://overpass-api.de/api/interpreter`） | 周边交通、商店、学校等 | `src/adapters/map.ts`（`OsmMapProvider.nearby`） | 数据版权归 OpenStreetMap 贡献者；查询结果中标注来源 `OpenStreetMap Overpass API` | 复核公共 Overpass 实例的使用政策与配额；商用前评估自建实例或商业 POI 服务。当前实现为**按需加载 + 8 秒超时 + 24 小时内存缓存 + 失败降级**，不会在页面加载时强制打外部接口 |
| 前端地图渲染库（Leaflet 一类，公开展示页 `window.L`） | 交互式地图渲染 | `src/render/page-renderer.ts` 的 `mapScript()`；CSP 在 `src/http/security.ts` 中为公开页放行 `https://unpkg.com` | **当前尚未实际引入**：仓库内没有任何加载该库的 `<script src>` 或样式引用，页面在 `window.L` 缺失时会自动降级为静态地址块 | 若要启用交互地图，**必须先完成该库的许可证核验与署名方案**（含其 CSS/JS 的自托管或白名单 CDN 决策），再写入本表 |
| 在线字体 | 无 | — | 展示页 CSS 只使用系统字体栈（`src/render/templates.ts` 的 `BASE_CSS`），不请求任何在线字体服务 | 无需处理 |

---

## 6. 模板与媒体素材

1. **模板**：展示页的三个模板（`modern`、`classic`、`minimal`）与全部 CSS 均为本项目自行编写，位于 `src/render/templates.ts`；只参考了 real-estate-listing-template 系列的**信息分区与布局思路**，未复制其代码、未使用其类名体系、未引入其图片。
2. **图片素材**：仓库内**不含任何示例照片或占位图片**。展示页上的照片全部来自用户在后台上传的文件（`var/uploads/`，已在 `.gitignore` 中排除）；`.env` 与配置中也没有指向任何第三方图库的地址。
3. **素材来源登记**：媒体表 `media` 设有 `source_note` 字段，后台「照片与视频」页可填写「素材来源/授权说明」，用于记录每张照片的来源（`src/domain/media.ts`、`src/services/media-service.ts`）。这是方案第三章第 2 条「记录素材来源或授权说明」的落地；**该字段是记录手段，不构成授权证明**，商用前仍需人工核对实际素材授权。
4. **用户上传内容的合规**：平台只对上传文件做类型/大小/数量校验（文件头魔数复核，`src/domain/media.ts` 的 `sniffMimeType`），不判断内容是否侵权；商用上线前需在用户协议中明确上传者的授权责任。

---

## 7. 商用发布前必须完成的重新核验清单

| # | 事项 | 为什么必须做 |
| --- | --- | --- |
| 1 | 重新核验全部直接依赖与其传递依赖的许可证（`pnpm-lock.yaml` 全量） | 本文件只核验了 5 个运行期依赖与 2 个开发依赖；传递依赖未逐一登记 |
| 2 | 复核 `microrealestate/microrealestate` 与 `property_web_builder` 的当前许可证与条款 | 开源项目状态会变化（方案第八章第 2 条） |
| 3 | 解决 `qrcode-generator` 的证据弱点：向上游确认 MIT 授权，或替换为带 LICENSE 文件的等价库 | 包内没有 LICENSE 文件，仅 `package.json` 声明；商用需要可归档的证据 |
| 4 | 清理 `package.json` 中未使用的 `zod` 声明，并重新生成依赖清单 | 依赖清单应与实际使用一致，否则许可证审计范围被虚增 |
| 5 | 复核 OpenStreetMap 瓦片与 Overpass 的使用政策、配额与费用风险 | 免费服务有使用量限制；商业部署可能需要自建或付费服务 |
| 6 | 若启用交互地图，先完成前端地图库的许可证核验与署名 | 当前页面没有加载任何地图库脚本 |
| 7 | 补齐 `LICENSE` / `NOTICE` / 第三方许可清单的对外分发形式 | Apache-2.0（`typescript`）等许可证要求随分发保留声明 |
| 8 | 更新本文件快照日期并留存核验命令输出 | 让结论可被复查，而不是一次性口头结论 |

---

## 8. 核验命令留档

本文件中的依赖许可证结论由以下方式取得（可在任意机器复跑）：

1. 读取 `node_modules/<包名>/package.json` 的 `version`、`license`、`author` 字段；
2. 列出 `node_modules/<包名>/LICENSE*` 并读取首行确认许可证类型；
3. 候选开源项目通过 GitHub API 读取 `license`、`language`、`stargazers_count`、`forks_count`、`pushed_at`、`size`、`topics` 字段（核验日期 2026-10-12）。
---

# 修订（2026-10-12 第二次修订）：依赖收敛与演示素材授权

## 一、按「只直接引入 MIT 许可组件」的约定收敛依赖

本次修订将许可策略收紧为：**运行期只直接引入 MIT 许可的组件；其它许可的组件一律只作参考，不直接植入。**

| 变更 | 组件 | 原许可 | 处理 | 结果 |
| --- | --- | --- | --- | --- |
| **移除** | `leaflet` | BSD-2-Clause | 地图改为项目自研实现（`src/render/mini-map.ts`，约 120 行），仅使用浏览器原生 API 与 OSM 标准瓦片 | 已移除，不再是第三方依赖 |
| **移除** | `zod` | MIT | 源码零引用，属无效依赖 | 已删除 |

修订后的运行期依赖清单（**全部 MIT**）：

| 依赖 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `fastify` | ^5.4.0 | MIT | HTTP 服务 |
| `@fastify/cookie` | ^11.0.2 | MIT | 会话 Cookie |
| `@fastify/multipart` | ^9.2.1 | MIT | 表单文件上传 |
| `@fastify/static` | ^8.2.0 | MIT | 后台静态资源 |
| `qrcode-generator` | ^2.0.4 | MIT（package.json 声明） | 二维码矩阵生成 |

开发期依赖（不随运行期产物分发，仅用于类型检查）：`typescript`（**Apache-2.0**）、`@types/node`（MIT）。
按约定，**Apache-2.0 的 `typescript` 不作为运行期组件植入**，只在开发阶段做静态类型检查使用；`pnpm typecheck` 是唯一使用途径，运行服务时不需要它。

## 二、地图实现说明（自研，无第三方许可约束）

`src/render/mini-map.ts` 为本项目自行实现的最小滑移地图：

- Web Mercator 瓦片坐标换算、瓦片拼接、拖拽平移、± 缩放、双指缩放；
- 瓦片来源为 OpenStreetMap 公共瓦片服务，**仅作数据引用**，不引入其任何代码；
- 必须保留署名：页面已固定显示 `© OpenStreetMap contributors`；商用前须阅读并遵守 OSM 瓦片使用政策（高流量场景应改用商业瓦片服务或自建）；
- 瓦片不可用时如实降级为地址文本 + 经纬度，不留空白地图。

## 三、演示照片的授权（`demo/photos/`）

本次修订把演示数据里的**自动生成占位图全部替换为真实照片**，并严格限定授权来源：

| 项目 | 说明 |
| --- | --- |
| 授权类型 | **CC0 1.0（公共领域贡献）** —— 无任何使用限制，可商用、可修改、无需署名 |
| 来源 | Wikimedia Commons 的 Unsplash 导入集合（该批图片由 Unsplash 以 CC0 释出后再导入 Commons） |
| 数量 | 15 张，覆盖客厅 / 餐厨 / 卧室 / 卫浴 / 外观 / 街景 |
| 署名归档 | `demo/photos/ATTRIBUTION.json` 记录每张图的文件名、类别、原始标题、许可、作者、Commons 页面地址、原始与输出尺寸 |
| 运行时记录 | 每张照片上传时都会把完整来源写入数据库 `media.source_note` 字段（后台「照片与视频」中可见并可编辑），满足方案第三章第 2 条「记录素材来源或授权说明」 |
| 二次处理 | 仅做等比缩放（最长边 1600px）与 JPEG 质量压缩，未做内容修改 |

**重要**：这 15 张图片**仅用于本地演示与界面效果评估**。若要用于真实房源发布，应当替换为房源权利人自己拍摄或已获授权的照片；本项目不对演示照片在任何具体房源上的适用性作担保。

## 四、仍然成立的许可事实（未变更）

- 第 0 阶段候选开源项目（PropertyWebBuilder / MicroRealEstate / OpenProperty / 单房源模板类仓库）**均未被植入代码**，仅作设计参考；详见 `docs/phase0-decision-record.md`。
- `qrcode-generator` 包内**没有 LICENSE 文件**，仅有 package.json 声明 MIT —— 这仍是证据强度上的一处弱点，商用前应另行核实或替换。
- 本归档是 **2026-10-12 的快照**，商用前必须重新核验全部许可证与素材授权。
---

# 修订（2026-10-12 第三次修订）：界面图标改为自研 SVG

## 背景

界面此前使用房子、电话、链接、地图等**表情符号**充当图标。表情符号存在三个问题：

1. **字形不可控** —— 同一字符在 Windows / macOS / Android / iOS 上字形差异很大，外观无法保证一致；
2. **不可着色** —— 无法跟随主题色（例如「电话」按钮需要显示为强调色）；
3. **授权与一致性风险** —— 表情符号字形由各平台字体提供，商用界面中作为图标使用并不合适。

## 处理方式：自行绘制，不引入任何图标库

新增 `src/render/icons.ts`（服务端渲染用）与 `public/admin/icons.js`（后台 SPA 用），
**全部图形由直线、圆、圆弧等基础几何构成，为本项目自行绘制**，因此：

- **不存在任何第三方授权问题**，不需要随包分发图标库的 LICENSE 或署名；
- 无需引入整套图标库（全站仅用 9 个图标，引入后体积不成比例）；
- 统一 24×24 视图框、`stroke="currentColor"` 纯描边，颜色自动跟随文字，无需额外 CSS。

图标清单：`home` 房源、`page` 页面、`bell` 提醒、`settings` 设置、`backup` 备份、
`phone` 电话、`share` 分享、`map` 地图、`back` 返回。

## 一致性保障

两份实现（服务端 TS 与后台 JS）必须保持完全相同的路径数据，否则同一图标在展示页与后台会长得不一样。
这一点由 `tests/domain/icons.test.ts` 断言，避免两边各改一半。

`tests/domain/icons.test.ts` 同时承担**回归防线**：扫描全部界面源码文件，
一旦再次出现表情符号（U+1F000–U+1FAFF、U+2600–U+27BF、U+2B00–U+2BFF、变体选择符等）即测试失败。
箭头（U+2190–U+21FF）属于正常排版字符，不在拦截范围内。

## 其它同步调整

- 命令行脚本（`scripts/seed.ts`、`scripts/smoke.ts`）的输出标记由表情符号改为
  `[完成]` / `[OK]` / `[FAIL]` / `[警告]`，终端不再出现表情符号；
- 验收报告与测试夹具中原有的状态表情符号一并改为文字（测试夹具改用纯标点，
  验证「连续标点折叠为单个连字符」的能力不变）。
---

# 修订（2026-10-13）：地址预设数据来源

后台的地址字段接入了联想搜索（国家 / 省 / 州 / 城市 / 区县）。数据来源如下，
**两份原始数据均已转换为项目自有结构后再内置**，不直接分发原始文件。

| 用途 | 来源 | 授权 | 体量 | 落地文件 |
| --- | --- | --- | --- | --- |
| 国家（249 条，中英双语 + ISO 代码） | [`umpirsky/country-list`](https://github.com/umpirsky/country-list) | **MIT** | 12.5 KB | `public/admin/data/countries.json` |
| 中国省 / 市 / 区县（31 / 342 / 2978 条） | [`modood/Administrative-divisions-of-China`](https://github.com/modood/Administrative-divisions-of-China) | **WTFPL** | 49.4 KB | `public/admin/data/divisions-cn.json` |

## 关于 WTFPL 的说明

用户约定为「只直接引入 MIT 许可的组件」。**WTFPL 不在 MIT 之列，但比 MIT 更宽松** ——
MIT 要求保留版权与许可声明，WTFPL 不做任何要求。

这一点**已向用户单独说明并取得同意**，理由是：

1. 行政区划名称本身是**国家统计局发布的公开事实数据**，地名不受著作权保护；
2. 汇编文件的授权（WTFPL）比项目约定的 MIT 更宽松，不存在额外的合规负担；
3. 该数据**不是代码**，不参与运行期依赖，只作为查表用的静态名单。

授权全文已随原始仓库提供：<https://github.com/modood/Administrative-divisions-of-China/blob/master/LICENSE>

## 转换说明

两份数据都做了**结构转换**（提取需要的字段、改为紧凑键名、去掉冗余列），
因此 `public/admin/data/` 下的文件是**本项目自有的衍生数据**，不是原始文件副本。

## 覆盖范围与限制

- **只有中国**有省 / 市 / 区县三级预设。其它国家的行政区划数据量过大且各国格式不一，**不做内置**。
- 所有地址字段**都允许自由输入**，预设只是加速录入，不构成强制校验。
- 预设数据按需加载（打开「基本信息」标签时才拉取），不影响后台首页速度。