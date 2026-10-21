# 轻量化房源管理与一键房源网站生成平台 —— 实施计划

- 文档类型：实施计划（本计划**已执行完毕**，记录的是实际做了什么、如何验证、结果如何）
- 版本：1.0
- 日期：2026-10-12
- 上游依据：《轻量化房源管理与一键房源网站生成平台_整合实施方案（归档稿 1.0）》（仓库根目录）第五章「分阶段实施队列」与第六章「每阶段的统一开发规则」
- 配套文档：`docs/superpowers/specs/2026-10-12-property-listing-platform-design.md`（设计说明书）、`docs/phase0-decision-record.md`、`docs/licenses.md`、`docs/reports/phase-1..8-report.md`

**如何阅读本文档**

本计划按方案自身的第 0–8 阶段组织。每个阶段给出四项内容：

1. **目标** —— 方案第五章对该阶段的工作要求；
2. **交付物** —— 实际存在的文件路径（不是计划中的路径）；
3. **验收标准** —— 方案第五章的原文验收条目，逐条给出结论；
4. **验证方式与实测结果** —— 执行的命令与观测到的输出，以及归档的浏览器证据。

状态取值：**达标** / **达标（附带条件）** / **未达标（缺口已登记）** / **已闭环**（早期判定未达标，后续补齐）。

---

## 0. 总览

| 阶段 | 名称 | 方案验收结论 | 本计划状态 |
| --- | --- | --- | --- |
| 0 | 开源项目检查与底座定案 | — | **达标（含一条已记录偏差）**：底座定为自建轻量底座；PropertyWebBuilder **未做实际部署** |
| 1 | 最小可用房源管理 | 4 项 | **达标** |
| 2 | 一键生成房源页面 | 3 项 | **达标**（「预览」缺口后续已补齐） |
| 3 | 展示模板与 HTML 导出 | 3 项 | **达标（附带条件）**：`file://` 打开动作未独立截图确认 |
| 4 | 地图与周边信息 | 4 项 | **已闭环**：首轮判定未达标（地图未加载），Leaflet 本地化后地图实测可用；周边信息仍未经真实数据验证 |
| 5 | 多语言与国际化 | 3 项 | **达标（附带条件）**：12 种语言中仅 4 种有界面文案目录 |
| 6 | 托管发布与子域名 | 4 项 | **部分达标**：绑定与验证规则达标，**HTTPS 与真实 DNS 验证未达成** |
| 7 | 第 7 天与第 15 天提醒 | 2 项 | **达标（附带条件）**：SMTP 真实投递未验证 |
| 8 | 安全、性能与上线准备 | 4 项 | **达标（附带条件）**：8 项条件已登记，其中测试与版本控制两项后续已关闭 |

**收尾复核**（三条命令于本计划定稿时全部通过）：

| 命令 | 观测结果 | 退出码 |
| --- | --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | `共 73 项检查，通过 73 项，失败 0 项` | 0 |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | `tests 251 / pass 251 / fail 0` | 0 |
| `node node_modules/typescript/bin/tsc --noEmit` | 无输出 | 0 |

对应的 npm 脚本为 `pnpm smoke` / `pnpm test` / `pnpm typecheck`。

---

## 1. 执行顺序与阶段依赖

### 1.1 实际执行顺序

阶段严格按方案第五章的顺序推进：**0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**。方案第六章第 1 条要求「一次只实施一个阶段；当前阶段未通过验收，不自动进入下一阶段」，实际执行中遵守了顺序，但对两处**判定未达标**的阶段做了如下处理（这是本计划与方案原文之间需要明确说明的差异）：

- **第 4 阶段判定未达标后仍继续了第 5 阶段。** 原因：第 4 阶段的失败项是「前端地图库未加载」，属于展示页的一个独立前端资源问题；第 5 阶段（多语言）改的是文案与格式化层，与地图库无关。当时把该缺口登记为「第 4 阶段收尾第一件事」，并在后续补齐（Leaflet 本地化 + 重新截图），完成后第 4 阶段判定改为已闭环。
- **第 6 阶段判定未达标后仍继续了第 7 阶段。** 原因：提醒功能不依赖域名。第 6 阶段的失败项是「缺少真实域名与 TLS 环境」，这两项在本机无法通过写代码获得（需要一个受控公网域名与一套反向代理），因此如果坚持「未通过不进入下一阶段」，项目会永久停在原地。第 6 阶段的验收报告本身也给出了这条判断（「第 7 阶段（提醒）不依赖域名，可以先做」），并明确要求第 8 阶段必须把 HTTPS 方案写成可执行文档。

**结论**：顺序原则被遵守，但「未达标即停」被两次有记录的、带原因与后续动作的偏离打断。这两处偏离都必须视为**未关闭的债务**，而不是已接受的现状。

### 1.2 阶段间的实际依赖

```
第 0 阶段（底座定案）
   |  决定技术栈与数据模型，是一切的前提
   v
第 1 阶段（房源 CRUD + 媒体）──────────────┐
   |  properties / media / contacts 表       |
   |  提供 PropertyAggregate 的数据基础        |
   v                                         |
第 2 阶段（一键出页 + 发布/撤下）              |
   |  listing_pages 表、渲染器、slug          |
   |                                         |
   +--> 第 3 阶段（模板 + 静态导出）           |
   |      复用第 2 阶段的渲染器与模板           |
   |                                         |
   +--> 第 4 阶段（地图与周边）                |
   |      往第 2 阶段的页面里插入位置区块        |
   |                                         |
   +--> 第 5 阶段（多语言）                    |
   |      给第 1 阶段的字段加译文表             |
   |      给第 2 阶段的渲染器加词条目录          |
   |                                         |
   +--> 第 6 阶段（托管与域名）                |
   |      改写第 2 阶段的「公开地址」来源        |
   |                                         |
   +--> 第 7 阶段（7/15 天提醒）<──────────────┘
   |      挂在第 2 阶段的发布动作上（publishedAt）
   |      用第 0 阶段的 Clock 适配器实现可控时间
   v
第 8 阶段（安全、备份、上线准备）
   横切全部阶段：审计日志、上传校验、配置校验、
   备份恢复、诊断接口、许可证归档
```

关键依赖关系（写在这里是为了说明为什么不能随意重排）：

- **第 2 阶段依赖第 1 阶段**：没有 `properties` / `media` / `contacts` 就没有可渲染的聚合。
- **第 3、4、5、6 阶段都依赖第 2 阶段**，且彼此**互不依赖**：它们分别往同一份渲染结果里插入模板选择、地图区块、语言词条、公开地址来源。理论上这四者可以并行，实际上按方案顺序串行推进，好处是每次只有一个变量在动。
- **第 7 阶段依赖第 2 阶段的发布动作**：提醒以 `listing_pages.published_at` 为基准排定，没有发布就没有提醒。
- **第 8 阶段横切全部**：它不是「新功能阶段」，而是把前八个阶段的安全、备份、可观测性、许可证与部署要求一次性收口。

### 1.3 全程遵守的统一开发规则（方案第六章）

| 方案条款 | 本项目的落实方式 |
| --- | --- |
| 第 1 条 一次只实施一个阶段 | 按 0→8 顺序推进；两次偏离已记录（见 1.1） |
| 第 2 条 先检查现有代码再修改 | 每阶段报告含「实际修改的文件/模块」清单 |
| 第 3 条 不创建平行 V2/Legacy 系统 | 全仓库无 v2/legacy 目录；单一迁移 `v1 initial_schema`；单一渲染器与单一模板表 |
| 第 4 条 必须通过真实浏览器验证 | 每阶段用浏览器自动化工具实操并归档截图至 `docs/evidence/`（16 个 PNG） |
| 第 5 条 检查迁移、旧数据、删除/归档、失败回滚 | 迁移单事务 + 失败回滚 + 幂等；归档与硬删除语义明确；备份恢复演练可反复执行 |
| 第 6 条 报告须列出实际修改、运行方式、浏览器路径、通过/失败项、遗留问题 | 每阶段报告按方案第九章模板撰写，含全部小节 |
| 第 7 条 底座不满足需求须先提交证据与替代方案 | `docs/phase0-decision-record.md` 第 3、4 节给出三条可核验证据与偏差登记 |
| 第 8 条 外部服务有配置边界、密钥不进前端与仓库 | 六个适配器 + `secretRefs` 只存环境变量名 + `redactedConfig` + 生产启动校验 |

---

## 第 0 阶段：开源项目检查与底座定案

### 目标

检查候选项目的官方仓库、许可证、维护状态、技术栈、依赖、部署流程和数据模型；制作能力对照表并进行实际部署验证；最终只确定一个主底座。

### 交付物（真实路径）

| 路径 | 内容 |
| --- | --- |
| `docs/phase0-decision-record.md` | 决策记录：候选项目对照表（8 列元数据）、决策与理由、偏差登记、核验边界表、被排除候选及原因、架构摘要、12 项许可证核验清单 |
| `docs/licenses.md` | 许可证与授权证据归档：候选项目、运行期依赖（含 `leaflet@1.9.4`，BSD-2-Clause）、开发依赖、外部数据服务署名与商用限制、模板与素材来源、商用前复核清单、核验命令留档。已登记两处证据弱点：`qrcode-generator` 包内无 LICENSE 文件（仅 `package.json` 声明 MIT）、`typescript` 实为 Apache-2.0 而非 MIT |
| `docs/reports/phase-0-report.md` | 第 0 阶段验收报告（按方案第九章模板撰写），含候选项目核查结果、底座决策、决策记录引用、失败项与遗留问题 |

### 验收标准与结论（方案第五章第 0 阶段）

> 交付与验收：项目选择记录、许可证核验清单、部署成功证据、未采用项目及原因。未完成本阶段，不开始业务功能开发。

| 验收项 | 结论 |
| --- | --- |
| 项目选择记录 | 达成 —— `docs/phase0-decision-record.md` 第 1、2、5 节 |
| 许可证核验清单 | 达成 —— `docs/phase0-decision-record.md` 第 7 节（12 项）+ `docs/licenses.md`（8 节） |
| **部署成功证据** | **未达成 —— PropertyWebBuilder 未做实际部署**（见下） |
| 未采用项目及原因 | 达成 —— `property_web_builder` / `microrealestate` / `OpenProperty` / real-estate-listing-template 系列四项各有结论与理由 |

### 验证方式与实测结果

| 核验动作 | 命令或来源 | 结果 |
| --- | --- | --- |
| 候选项目元数据 | GitHub 官方 API（2026-10-12） | `etewiah/property_web_builder` MIT / Ruby / 647 star / 286 fork / 最后推送 2026-09-28 / 约 96 MB / topics: cms、mls、rails、real-estate |
| `microrealestate` 许可证 | GitHub API 许可证字段 | `NOASSERTION`（非标准/自定义条款），仓库存在变更许可证的开放讨论（issue #264）→ 排除 |
| 本机 Ruby 工具链 | `Get-Command ruby` / `rails` / `gem` / `bundle` | 四项**全部不存在** |
| 本机 Node 工具链 | `node --version` / `pnpm --version` / `npm --version` | `v24.14.0` / `10.32.1` / `11.9.0` |
| 本机容器与版本控制 | `Get-Command docker` / `git` | 均已安装 |
| 运行期依赖许可证 | 各包内 LICENSE 文件与 `package.json` | 5 个包全部核验；登记两处证据弱点（`qrcode-generator` 包内无 LICENSE 文件；`typescript` 实为 Apache-2.0 而非 MIT） |

### 偏差登记（必须原样保留，不静默省略）

方案要求「进行**实际部署验证**」，**本项目没有执行**，原因是本机不存在 Ruby/Rails 工具链，无法完成 `bundle install` 与 Rails 启动；而在没有工具链的前提下安装整套 Ruby 运行时，恰恰是本次决策要否定的做法。

由此产生的核验边界（`docs/phase0-decision-record.md` 第 4 节）：

| 项目 | 状态 |
| --- | --- |
| 许可证、主语言、star/fork、最后推送、仓库体积、topics | 已核验 |
| 本机 Ruby/Rails 工具链缺失 | 已核验 |
| PropertyWebBuilder 的实际启动与部署流程 | **未核验** |
| 后台实际操作体验、地图与多语言模块的真实表现 | **未核验** |
| 升级/迁移路径与安全公告历史 | **未核验** |

本次决策的依据是「仓库与 API 元数据 + 本机工具链实测」，**不是实机部署结论**。

### 状态

**达标（含一条已记录偏差）**。底座定为：Node.js 24（原生 TypeScript 类型擦除执行，无构建步骤）+ Fastify 5 + `node:sqlite` + 六个可替换适配器。业务功能开发在本阶段定案后才开始。

---

## 第 1 阶段：最小可用房源管理

### 目标

房源新增、查看、编辑、删除或归档、状态切换、照片上传和封面设置；数据保存到统一数据库。

### 交付物（真实路径）

**领域与校验**

- `src/domain/types.ts` —— 全部实体与枚举常量（房源、媒体、联系方式、发布页、提醒、工作区、用户、外部服务、审计）
- `src/domain/errors.ts` —— `DomainError` 与工厂函数（`notFound` / `validationFailed` / `conflict` / `unprocessable` / `dependencyUnavailable`），每个错误带 `code` / `httpStatus` / 中文 `message` / `issues[]`
- `src/domain/validate.ts` —— 手写校验器 `Validator`（`str` / `text` / `int` / `money` / `currency` / `timezone` / `locale` / `bool` / `enum` / `latLng` 等），累积全部问题后一次抛出
- `src/domain/property.ts` —— 房源字段校验与 PATCH 语义
- `src/domain/media.ts` —— 魔数识别 `sniffMimeType`、扩展名映射、`validateUpload`、封面解析 `resolveCover`、重排 `reorderMedia`、外链校验 `validateExternalVideoUrl`

**数据层**

- `src/db/database.ts`、`src/db/migrations.ts`（`v1 initial_schema`，10 张表）、`src/db/migrate.ts`（`pnpm migrate`）、`src/db/sql.ts`
- `src/db/repositories/`：`property-repo.ts`、`media-repo.ts`、`contact-repo.ts`、`workspace-repo.ts`、`translation-repo.ts`、`audit-repo.ts`（第 1 阶段建立，后续阶段复用）

**服务层**

- `src/services/property-service.ts` —— `createPropertyFromInput` / `updatePropertyFromInput` / `setPropertyStatus` / `archiveProperty` / `restoreProperty` / `deletePropertyCascade` / `duplicateProperty` / `getPropertyAggregate` / `listPropertiesAdmin` / `propertyStats` / `requireProperty`
- `src/services/media-service.ts` —— `addUploadedMedia` / `addVideoLink` / `deleteMediaItem` / `updateMediaSourceNote` / `reorderMediaItems` / `setCoverMedia` / `listPropertyMedia` / `coverOf` / `requireMedia`；`buildStorageKey()` 生成 `<propertyId>/<timestamp>-<random>.<ext>`
- `src/services/audit-service.ts` —— `recordAudit` / `recentAudit` / `entityAudit`

**接口层与界面**

- `src/http/app.ts`、`src/http/security.ts`（本阶段建立，含会话、CSP、安全头、限流）
- `src/http/routes/admin-auth.ts`、`admin-properties.ts`、`admin-media.ts`、`health.ts`
- `public/admin/index.html`、`app.js`、`api.js`、`ui.js`、`styles.css`、`views/properties.js`、`views/property-edit.js`

**其它**

- `src/config.ts`、`src/app-context.ts`、`src/server.ts`、`src/util/ids.ts`、`src/util/logger.ts`、`src/util/slug.ts`
- `scripts/seed.ts`（`pnpm seed`）
- 测试：`tests/domain/property.test.ts`、`tests/domain/media.test.ts`、`tests/services/property-service.test.ts`、`tests/services/media-service.test.ts`、`tests/integration/api-properties.test.ts`、`tests/helpers/test-app.ts`
- 证据：`docs/evidence/01-admin-login.png`、`02-admin-properties.png`、`03-property-edit-basic.png`、`11-validation-errors.png`

### 验收标准与结论（方案第五章第 1 阶段）

> 验收：使用真实浏览器完成完整操作；刷新后数据仍存在；错误输入有明确提示；不存在第二套重复数据模型。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 使用真实浏览器完成完整操作 | 达成 | `01` / `02` / `03` / `11` 四张截图；浏览器路径 9 步（登录 → 列表 → 新建 → 填表 → 空标题报错 → 创建 → 改价保存 → 刷新仍在 → 上传照片/设封面 → 归档） |
| 刷新后数据仍存在 | 达成 | 持久化到 `var/db/app.sqlite`；冒烟断言「列表包含新建房源」`total = 1`；`tests/services/property-service.test.ts`「创建房源后可立即读取（刷新后仍在）」 |
| 错误输入有明确提示 | 达成 | 400 + `error.issues[].field === 'title'`；截图 `11-validation-errors.png` 显示标题框下「标题不能为空」与底部聚合错误框 |
| 不存在第二套重复数据模型 | 达成 | `properties` 是唯一房源数据源；后台列表/详情、展示页、导出均读同一批表；全仓库无 v2/legacy 目录 |

### 验证方式与实测结果

| 命令 | 观测结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | 【1】【2】【3】与【10】分组共 **21 项**断言通过（6 + 6 + 3 + 6）：健康检查 200 且迁移含 1、未登录 401、错误口令 401、登录 200 + `admin_session` Cookie、空标题 400 且 `issues[].field = 'title'`、创建 201、列表 `total = 1`、中文搜索命中、不存在 404、上传 PNG 201 且首张 `isCover = true`、伪装 PNG 被拒 400、归档 200、归档后 `total = 0`、`includeArchived=true` 时 `total = 1`、删除 200、删除后 404、删除后提醒清零 |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | 本阶段相关文件共 **66 条**用例通过：`tests/domain/property.test.ts` 15 + `tests/domain/media.test.ts` 17 + `tests/services/property-service.test.ts` 12 + `tests/services/media-service.test.ts` 11 + `tests/integration/api-properties.test.ts` 11 |
| `node node_modules/typescript/bin/tsc --noEmit` | 无输出，退出码 0 |
| 浏览器实操 | 见 `docs/reports/phase-1-report.md` 第 9 步路径；遗留产物的旁证：`var/uploads/` 下 3 个房源目录、共 7 个真实上传的 PNG |

### 已知缺口（本阶段登记，后续处理情况）

| 缺口 | 后续状态 |
| --- | --- |
| 照片上传/设封面与归档步骤没有对应截图 | 证据仍为冒烟断言 + `var/uploads/` 遗留文件；未补截图 |
| 上传边界未验证（接近上限的大图、视频、超数量） | **已闭环**：`tests/domain/media.test.ts` 现有「超出大小上限」「超出数量上限」「不支持扩展名」等用例；`api-properties.test.ts` 有「超限被拒」用例。仍无真实大文件上传的浏览器证据 |
| 重复录入只有提示、没有拦截 | 保持现状（刻意选择，避免误拦） |
| 删除是硬删除、无回收站 | 保持现状（依赖备份恢复） |
| 上传不做图像后处理 / EXIF 剥离 | 保持现状 |
| 无多用户与细粒度权限 | 保持现状（见设计说明书 10.3 节） |

### 状态

**达标**。

---

## 第 2 阶段：一键生成房源页面

### 目标

从房源记录生成公开详情页，支持手机和桌面布局、预览、复制链接、发布和撤下。

### 交付物（真实路径）

- `src/domain/listing-page.ts` —— `slugSeedFor` / `collectPublishReadiness` / `assertPublishTransition` / `isPubliclyVisible` / `assertTemplateId`（本阶段建立，第 6 阶段在其上追加域名规则）
- `src/util/slug.ts` —— `slugify`（中文标题保留、标点与 emoji 折叠、长度限制不截断代理对）、`nextAvailableSlug`（冲突时依次加序号）
- `src/db/repositories/listing-page-repo.ts` —— 含 `idx_listing_pages_slug` 唯一索引的读写
- `src/services/publish-service.ts` —— `allocateSlug` / `ensureListingPage` / `updateListingSettings` / `aggregateFor` / `readiness` / `publishListing` / `withdrawListing` / `publicUrlFor` / `findPublicPage` / `listPagesAdmin`
- `src/render/page-renderer.ts` —— `renderListingPage` / `renderUnavailablePage` / `composeAddress`；图集、关键信息、价格与费用、位置、联系方式、分享与二维码、语言栏
- `src/render/templates.ts` —— `BASE_CSS` + `modern` / `classic` / `minimal` 三个模板 + `getTemplate` / `listTemplates`
- `src/render/qrcode.ts` —— `renderQrSvg`（内联 SVG，不使用 `<img>` 或在线服务）
- `src/render/html.ts` —— `escapeHtml` / `escapeAttribute` / `safeUrl` / `jsonForScript`
- `src/http/routes/public-pages.ts` —— `GET /p/:slug`、`GET /p/:slug/qr.svg`、`GET /p/:slug/nearby.json`
- `src/http/routes/admin-pages.ts` —— `GET /api/admin/pages`、`GET /api/admin/templates`、`GET/PATCH /api/admin/properties/:id/listing`、`POST …/publish`、`POST …/withdraw`、`GET …/preview`
- `public/admin/views/pages.js` —— 「发布页面」总览视图
- 测试：`tests/domain/listing-page.test.ts`（19）、`tests/services/publish-service.test.ts`（13）、`tests/integration/public-page.test.ts`（11）
- 证据：`docs/evidence/04-public-page-desktop.png`、`12-public-page-mobile.png`、`13-publish-tab.png`

### 验收标准与结论（方案第五章第 2 阶段）

> 验收：修改房源后页面同步更新；未发布房源不能被公开访问；后台与页面内容一致。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 修改房源后页面同步更新 | 达成 | 展示页每次请求实时渲染、不落盘不缓存；冒烟断言「修改房源后展示页同步更新」（8,500 → 9,200）；`public-page.test.ts`「修改房源后展示页立即同步」 |
| 未发布房源不能被公开访问 | 达成 | `findPublicPage()` 强制 `status === 'published'`；未发布/已撤下/不存在返回**同一个** 404 页面；`public-page.test.ts`「未发布页面公开访问返回 404 且不泄露房源是否存在」 |
| 后台与页面内容一致 | 达成 | 两者读同一 `PropertyAggregate`（4.12 节）；`publish-service.test.ts`「发布后展示页内容与后台数据一致（唯一数据源）」 |
| （工作项）预览 | 达成（后续补齐） | 初稿登记为缺口；`GET /api/admin/properties/:id/preview` 现返回与公开页同源同版式的 HTML，第 8 阶段修订时其 CSP 进一步与公开页对齐 |

### 验证方式与实测结果

| 命令 | 观测结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | 【4】分组 **12 项**断言通过：自动生成分享链接、就绪检查通过、返回二维码 SVG、未发布 404、发布 200、发布后 200、页面含标题「浦东新区精装两居室」、含价格 `8,500`、含内联 `<svg>`、含「联系方式」、CSP 含 `nonce-`、改价后页面含 `9,200` |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | 本阶段相关文件共 **43 条**用例通过：`listing-page` 19 + `publish-service` 13 + `public-page` 11 |
| 浏览器实操 | 「发布页面」标签设置 slug / 展示语言 / 模板 → 发布 → 打开 `/p/<slug>`；窄视口复核单列布局；「复制链接」与「打开二维码」；改价后刷新同步；撤下后显示 404 页面；总览页行内重复发布/撤下 |

### 已知缺口

| 缺口 | 后续状态 |
| --- | --- |
| 「预览」未落地（未发布状态无法在浏览器看到真实展示页） | **已闭环**：新增 `GET /api/admin/properties/:id/preview` |
| 多视口只覆盖桌面与手机两档 | 平板、超宽屏与 `@media print` 仍只有代码级实现 |
| `view_count` 不去重、无机器人过滤 | 保持现状 |
| 重新发布会重置提醒计划，界面无提示 | 保持现状（行为本身合理，缺提示） |
| 展示页 404/200 分支当时只由冒烟覆盖 | **已闭环**：`tests/integration/public-page.test.ts` 11 条用例 |

### 状态

**达标**（「预览」缺口后续已补齐）。

---

## 第 3 阶段：展示模板与 HTML 导出

### 目标

吸收经过许可核验的模板设计，提供模板选择和静态 HTML/资源导出。

### 交付物（真实路径）

- `src/render/templates.ts` —— 三个模板（`modern` 现代卡片 / `classic` 经典稳重 / `minimal` 极简文字），模板以 TypeScript 定义而非独立 HTML 文件（避免自研模板引擎的解析与转义风险，且导出时可内联样式）
- `src/services/export-service.ts` —— `buildExportBundle`（内存构建文件列表）、`exportListingToDirectory`（写盘，含路径越界校验）、`exportListingAsZip`（返回 `Uint8Array` 与文件名）；`OFFLINE_NOTES` 七条离线说明
- `src/util/zip.ts` / `src/util/unzip.ts` —— 自研 ZIP 读写（STORE 模式、UTF-8 文件名标志位、crc32、`..` 路径拒绝）
- `src/http/routes/admin-export.ts` —— `GET …/export.zip`（RFC 5987 中文文件名 + ASCII 回退）、`POST …/export`（导出到目录）、`GET …/export-preview`（源码预览，CSP 收紧为 `default-src 'self' data:`）
- `scripts/export-once.ts` —— 命令行直接调用导出服务（`node scripts/export-once.ts <房源ID>`）
- `scripts/serve-static.mjs` —— 独立的只读静态服务器，用于验证导出目录可以脱离主应用独立部署
- 测试：`tests/util/zip.test.ts`（7）、`tests/services/export-service.test.ts`（8）、`tests/integration/export.test.ts`（7）
- 证据：`docs/evidence/14-export-offline-standalone.png`

### 验收标准与结论（方案第五章第 3 阶段）

> 验收：导出文件可在本地打开；图片路径有效；核心展示不依赖内部管理后台。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 导出文件可在本地打开 | **附带条件** | 导出形态页面有截图（`14-export-offline-standalone.png`），相对路径由程序断言保证；但截图**不含地址栏**，无法证明是用 `file://` 打开解压目录（`export-preview` 返回同一份 HTML）。补一张带地址栏的截图即可闭环 |
| 图片路径有效 | 达成 | HTML 中 `/media/` 统一改写为 `assets/`；媒体以 `assets/<storageKey>` 落盘；断言同时校验「含 `assets/`」与「不含 `/media/`」 |
| 核心展示不依赖内部管理后台 | 达成 | 导出 HTML 不含任何 `/api/admin/` 引用；联系方式、价格、图集、二维码全部内联；样式内联；只用系统字体 |

### 验证方式与实测结果

| 命令 | 观测结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | 【7】分组 **7 项**断言通过：ZIP 200、`application/zip`、含 `index.html`、含 `README.txt`、含 `assets/`（实测条目 `index.html,index.en.html,README.txt,share-url.txt,assets/prp_…/mv5h6bbn-usr6ozcb.png`）、页面含 `assets/` 且不含 `/media/`、不含 `/api/admin/` |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | 本阶段相关文件共 **22 条**用例通过：`zip` 7 + `export-service` 8 + `export` 7 |
| 浏览器实操 | 切换三个模板 → 保存 → 「预览导出页面」（顶部带静态快照提示）→ 「下载 ZIP」→ 解压得到 `index.html` / `README.txt` / `share-url.txt` / `assets/` → 「导出到服务器目录」返回写入路径与文件清单 |
| 独立部署验证 | `node scripts/serve-static.mjs <导出目录> <端口>` 可在不启动主应用的情况下提供导出页面 |

### 已知缺口

| 缺口 | 后续状态 |
| --- | --- |
| 三个模板中只有默认模板 `modern` 在冒烟与导出预览中被实际渲染 | 保持现状（`minimal` 的「不显示二维码」分支仍无运行时证据） |
| 导出包不含外部视频链接指向的媒体 | 保持现状（README 未逐条说明） |
| ZIP 为 STORE 模式，无压缩、无分卷、无体积提示 | 保持现状 |
| 导出到服务器目录无配额与清理策略 | 保持现状 |
| 导出目录结构暴露内部存储键（`assets/prp_<uuid>/…`） | 保持现状 |
| 导出副本不可撤回，界面未提示 | 保持现状（README.txt 中间接体现） |

### 状态

**达标（附带条件）**。

---

## 第 4 阶段：地图与周边信息

### 目标

加入地图定位及周边信息；地图服务通过统一适配层接入，支持后续替换服务商。

### 交付物（真实路径）

- `src/adapters/map.ts` —— `MapProvider` 接口（`buildView` 纯函数 + `nearby` 永不抛错）、`OsmMapProvider`（OSM 瓦片 + Overpass 查询、Haversine 距离、分类映射、8 秒超时、24 小时缓存）、`DisabledMapProvider`；`haversineMeters()` 导出供测试
- `src/adapters/registry.ts` —— `MAP_PROVIDER=osm|disabled` 的分支
- `src/db/repositories/external-service-repo.ts` —— `external_service_configs` 读写（`secretRefs` 只存环境变量名）
- `src/http/routes/admin-settings.ts` —— `GET /api/admin/settings`（脱敏快照）、`GET/PUT /api/admin/external-services`（拒绝疑似密钥字段）
- `public/admin/views/settings.js` —— 设置页的适配器配置区与免费额度说明字段
- `src/render/page-renderer.ts` —— `renderLocation()`（含坐标时输出 `#map` 容器并附 `data-lat` / `data-lng` / `data-zoom` / `data-tile` / `data-attribution`；缺坐标时输出静态降级块）、`renderNearby()`（按需加载，导出时不渲染查询入口）、`mapLibraryTags()` / `mapScript()`（第 8 阶段修订时补入）
- `src/http/app.ts` —— 同源提供 `/vendor/leaflet/`；`/media/*` 经存储适配器
- `src/http/security.ts` —— 含地图页面 `style-src` 放宽（第 8 阶段修订为按页面模式判定）
- `leaflet@1.9.4`（BSD-2-Clause）加入 `package.json` 的 `dependencies`
- 测试：`tests/adapters/map.test.ts`（20）
- 证据：`docs/evidence/15-public-page-map-working.png`

### 验收标准与结论（方案第五章第 4 阶段）

> 验收：位置准确；密钥安全；地图服务故障时仍可显示地址；说明服务额度和费用风险。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 位置准确 | **已闭环（初判未达成）** | 初稿判定「未达成」：仓库当时没有任何加载地图库的脚本，页面必然走 `!window.L` 降级分支（`04-public-page-desktop.png` 与 `06-public-page-en-i18n.png` 中地图区域显示「地图组件未能加载…」）。**该判断经复核完全正确，属真实缺陷**；Leaflet 本地化引入后实测 `leafletLoaded: true`、`leafletVersion: 1.9.4`、`hasLeafletDom: true`、`tiles: 10`、`loadedTiles: 10`，截图 `15-public-page-map-working.png` 显示真实 OSM 街区、标记、缩放控件与署名。报告已追加修订记录，结论**由「否」更正为「是」** |
| 密钥安全 | 达成 | 默认实现无需密钥；`buildView()` 只输出 `tileUrl` 与 `attribution`，**不输出 `apiKey`**；`PUT /api/admin/external-services` 拒绝键名匹配 `(password\|secret\|token\|api[_-]?key\|access[_-]?key)` 的字段；`redactedConfig` 只输出「已设置 / (未设置)」；`tests/adapters/map.test.ts`「有经纬度时地图视图可用，且不包含任何密钥」 |
| 地图服务故障时仍可显示地址 | 达成 | `buildView()` 无论地图是否可用都带 `fallbackAddress`；`nearby()` 所有失败分支返回中文原因而不抛错；瓦片层连续 3 次 `tileerror` 且零成功时 `map.remove()` 并降级。**该降级路径在真实浏览器中被实际触发并截图** |
| 说明服务额度和费用风险 | 达成 | 三处落地：`.env.example` 的 `MAP_FREE_TIER_NOTE`、页面「地图服务说明」行（截图中可见）、后台适配器配置的「免费额度说明」字段 |

### 验证方式与实测结果

| 命令或动作 | 观测结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | `tests/adapters/map.test.ts` **20 条**用例通过：地图视图含坐标且不含密钥、无坐标降级、关闭地图保留地址、周边服务失败/限流/网络异常三种降级、按距离排序并解析分类、命中缓存不重复请求、超时降级、haversine 量级、存储键拒绝穿越与非法段、路径必须落在存储根内、内存存储读写删一致、收件人非法或含换行被拒、RFC 2047 中文主题与 base64 正文、内存邮件记录、可控时钟语义、系统时钟不支持时间旅行、假 DNS 分片拼接 |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | **本阶段的断言数为 0** —— 73 项冒烟检查不包含任何地图或周边信息断言。这是本阶段验证方式的结构性缺口：地图与周边的验证完全依赖浏览器实测与适配器单元测试 |
| 浏览器实测（地图） | `leafletLoaded: true`、`leafletVersion: 1.9.4`、`hasLeafletDom: true`、`tiles: 10`、`loadedTiles: 10`、`scriptSrc: ["/vendor/leaflet/leaflet.js"]`、`cssHref: ["/vendor/leaflet/leaflet.css"]`；截图 `15-public-page-map-working.png` |
| 浏览器实测（周边） | 点击「查看周边信息」（`?nearby=1`）后页面显示「周边服务返回 HTTP 406；展示页仍会正常显示地址文本与地图定位」——**只验证了降级路径** |
| 外部网络探测 | 对公共 Overpass 实例用 4 种请求形式逐一验证，**一律返回 HTTP 406**（判断为网络策略拦截而非代码问题；同一环境下 OSM 瓦片可正常访问） |

### 已知缺口（本阶段最重要的登记）

| 缺口 | 后续状态 |
| --- | --- |
| 周边信息（Overpass）从未用真实数据验证 | **未闭环**。端点已可配置（`MAP_OVERPASS_ENDPOINT`），适配器分支有 20 条单测覆盖，但真实响应结构、公共实例限流阈值与 8 秒超时是否合适均未验证 |
| 商用瓦片政策未复核 | **未闭环**（`MAP_FREE_TIER_NOTE` 与 `docs/licenses.md` 第 5 节已登记待办） |
| 降级文案的本地化不完整（`MAP_FREE_TIER_NOTE` 是运营配置文本，无翻译机制） | 保持现状 |
| 精确坐标默认公开，无模糊化选项 | 保持现状（住宅房源等同于公开门牌位置） |
| 早期 CSP 放行了未使用的 `https://unpkg.com` | **已闭环**：Leaflet 改为同源提供后，`security.ts` 中已无任何外部脚本源 |

### 状态

**已闭环**（初判未达标 → 补齐 Leaflet 本地化 + 重新实测后由报告修订记录更正为「是」）。周边信息部分仍属「已实现、未用真实数据验证」。

---
## 第 5 阶段：多语言与国际化

### 目标

支持多语言界面、翻译字段、货币/日期/面积单位格式配置。

### 交付物（真实路径）

- `src/domain/i18n.ts` —— `SUPPORTED_LOCALES`（12 种）、`COMMON_CURRENCIES`（14 种）、`formatMoney` / `formatArea` / `formatPrice` / `formatDateOnly`、`resolveLocalizedText`（精确 → 语言族 → 原文）、`availableLocales`、`UiKey` / `UiCatalog` / `UI_CATALOGS` / `uiCatalog` / `t`、`propertyTypeLabel` / `contactChannelLabel` / `nearbyCategoryLabel`
- `src/db/repositories/translation-repo.ts` —— `property_translations` 读写，`idx_translations_property_locale` 唯一索引保证「一房源一语言一条」
- `src/services/i18n-service.ts` —— `listPropertyTranslations` / `saveTranslation`（**拒绝同语言译文覆盖原文**）/ `removeTranslation` / `buildLocaleLinks`
- `src/http/routes/admin-pages.ts` —— `GET /api/admin/locales`、`GET/PUT /api/admin/properties/:id/translations`、`DELETE …/translations/:locale`
- `src/render/page-renderer.ts` —— `renderLocaleBar()`（在线用 `?lang=`，导出用本地文件）、译文提示行
- `public/admin/views/property-edit.js` —— 「多语言」标签
- 测试：`tests/domain/i18n.test.ts`（15）、`tests/services/i18n-service.test.ts`（10）
- 证据：`docs/evidence/05-public-page-en.png`、`05-public-page-en-before-i18n.png`、`06-public-page-en-i18n.png`

### 验收标准与结论（方案第五章第 5 阶段）

> 验收：切换语言不丢失数据；原始描述不被翻译覆盖；格式按配置正确显示。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 切换语言不丢失数据 | 达成 | 语言只是渲染参数（`?lang=` 白名单 + 语言栏链接），不修改任何实体；原文与译文分表存放；`i18n-service.test.ts`「删除译文不影响原文与其它语言」 |
| 原始描述不被翻译覆盖 | 达成 | **表结构 + 接口双重保证**：译文在独立表（4.5 节）；`saveTranslation()` 拒绝 `locale === 工作区默认语言`；`i18n-service.test.ts`「保存译文后原文完全不变」「拒绝用同语言译文覆盖原文」 |
| 格式按配置正确显示 | 达成 | `formatMoney` / `formatArea` / `formatPrice` / `formatDateOnly` 全部基于 `Intl`；货币、面积单位、语言可在「设置」中修改；非法币种代码降级显示而不抛错；英文页截图可见 `CN¥9,200 / per month`、`89.5 m²`、`November 1, 2026` |

### 验证方式与实测结果

| 命令 | 观测结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | 【5】分组 **5 项**断言通过：保存英文译文 201、英文页显示 `Bright 2-Bedroom in Pudong`、原文仍含「近地铁 2 号线」、译文独立保存 `length = 1`、同语言覆盖被拒 400 |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | 本阶段相关文件共 **25 条**用例通过：`i18n` 15 + `i18n-service` 10 |
| 浏览器实操 | 「多语言」标签选择语言 → 填译文标题/描述 → 保存 → 语言栏点 `English` → 页面标题/描述用译文、金额/面积/日期按英文格式、区块标签为英文、显示「Showing the en translation. The original description is always preserved…」；切回简体中文内容恢复 |
| 对照证据 | `05-public-page-en-before-i18n.png`（本地化之前：英文页仍是中文标签）与 `06-public-page-en-i18n.png`（本地化之后）对照，可见本次改动解决的问题 |

### 已知缺口

| 缺口 | 后续状态 |
| --- | --- |
| 12 种可选语言中只有 4 种（`zh-CN` / `zh-TW` / `en` / `ja`）有界面文案目录 | **未闭环**。其余 8 种会退化为「英文标签 + 该语言数字格式」的混排页面 |
| 管理后台界面本身没有多语言（`public/admin/index.html` 为 `lang="zh-CN"`，标签硬编码中文） | 保持现状 |
| 可翻译字段只有 `title` 与 `description` | 保持现状。地址、附加费用、楼层说明、素材来源说明均无翻译通道 |
| 运营配置文案（`MAP_FREE_TIER_NOTE`）不参与翻译 | 保持现状 |
| `formatDateOnly` 的第三个参数 `timeZone` 未被使用（硬编码 UTC） | 保持现状（对「可入住日期」这一唯一调用点结果正确，但签名与实现不一致） |
| 分享链接不随语言变化，无 `hreflang` | 保持现状 |
| 当时 `tests/domain/i18n.test.ts` 与 `tests/services/i18n-service.test.ts` 为空文件 | **已闭环**：现共 25 条用例 |

### 状态

**达标（附带条件）**。

---

## 第 6 阶段：托管发布与子域名

### 目标

先实现默认托管地址，再支持自定义子域名或域名绑定、HTTPS、发布撤回和错误处理。

### 交付物（真实路径）

- `src/domain/hosting.ts` —— `buildDefaultPublicUrl` / `buildCustomDomainUrl` / `domainVerificationInstructions` / `normalizeDomainLabel` / `buildSubdomain` / `validateSubdomainLabel`（拒绝 18 个系统保留标签）
- `src/domain/listing-page.ts` —— `assertDomainBindable` / `isDomainActive` / `verifyDomainOwnership`（本阶段追加的域名规则）
- `src/util/slug.ts` —— `isValidDomain`（ASCII 标签 `[a-z0-9-]`）
- `src/adapters/dns.ts` —— `DnsResolver` 接口、`SystemDnsResolver`（`node:dns/promises`）、`FakeDnsResolver`、`flattenTxtRecords`（TXT 分片拼接）
- `src/adapters/hosting.ts` —— `HostingProvider` 接口、`DefaultHostingProvider`（`allowsCustomDomain = false`）、`CustomDomainHostingProvider`（依赖注入的 DNS 做 TXT 验证）
- `src/services/hosting-service.ts` —— `hostingState` / `bindDomain`（域名唯一性 + 重新绑定清空验证状态）/ `verifyBoundDomain` / `unbindDomain` / `suggestSubdomain`
- `src/services/publish-service.ts` —— `publicUrlFor()` 改为经 `ctx.adapters.hosting.resolvePublicUrl()`
- `src/http/routes/admin-settings.ts` —— `GET /api/admin/properties/:id/hosting`、`POST …/hosting/domain`、`POST …/hosting/verify`、`DELETE …/hosting/domain`
- `db` 复用 `v1` 中的 `listing_pages.custom_domain` / `domain_verify_token` / `domain_verified_at` 与 `idx_listing_pages_domain`
- 测试：`tests/services/hosting-service.test.ts`（13）
- 证据：**无截图**（本机没有可用于签发的自有公网域名）

### 验收标准与结论（方案第五章第 6 阶段）

> 验收：完成域名所有权验证；HTTPS 有效；发布和撤回可以重复操作；未经验证的域名不能直接绑定。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 完成域名所有权验证 | **未达成（机制已实现、未在真实 DNS 上跑通）** | 机制完整：TXT 记录比对、前缀可配置、回显查询到的全部 TXT 记录便于排查、域名唯一性、重新绑定清空验证状态；`hosting-service.test.ts` 13 条用例用 `FakeDnsResolver` 覆盖成功/失败/多段记录/占用/未绑定等全部分支。但真实解析路径与 DNS 传播延迟**从未实测** |
| HTTPS 有效 | **未达成** | 应用不做 TLS 终结（`src/server.ts` 只 `app.listen()`），无证书、无 HTTP→HTTPS 跳转、无 HSTS。仅有配置层约束：生产环境 `PUBLIC_BASE_URL` 必须以 `https://` 开头，会话 Cookie 的 `secure` 标志取决于该前缀 |
| 发布和撤回可以重复操作 | 达成 | 冒烟【9】分组 4 项断言：撤下 200、撤下后 404、重复发布 200、重复撤下 200；`publish-service.test.ts`「发布与撤下可以反复执行」 |
| 未经验证的域名不能直接绑定 | 达成 | `resolvePublicUrl()` 只在 `customDomain && domainVerifiedAt` 同时成立时使用自定义域名，否则回退默认地址；`bindDomain()` 重新绑定即清空 `domainVerifiedAt`；`hosting-service.test.ts`「绑定域名后生成 TXT 验证指引，但地址仍是默认地址」「重新绑定域名会要求重新验证」「关闭自定义域名时始终使用默认地址」 |

### 验证方式与实测结果

| 命令 | 观测结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | 【9】分组 **4 项**断言通过（见上表）。该套件**不包含**域名相关断言 |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | 本阶段相关文件共 **13 条**用例通过（`tests/services/hosting-service.test.ts`）：默认地址、绑定后仍用默认地址、无 TXT 失败、值不匹配失败、匹配通过并切换域名、多段 TXT 拼接、重新绑定需重新验证、解绑回默认、域名被占用、非法域名、未绑定不能验证、子域名建议、中文 slug 回退标签 |
| 浏览器实操 | 界面路径存在（绑定 → 显示 TXT 指引 → 验证 → 解绑），但**该路径没有截图、没有自动化断言，也从未执行到第 3 步（真实 DNS TXT 生效）与第 4 步（HTTPS 实际可访问）** |
| 独立部署验证 | `node scripts/serve-static.mjs <导出目录> <端口>` 可提供导出页面（与本阶段的自定义域名承接无关，仅说明导出产物可独立部署） |

### 已知缺口

| 缺口 | 后续状态 |
| --- | --- |
| 域名所有权验证没有端到端证据 | **未闭环**。需要一个可用的受控公网测试域名 + 一次真实 TXT 验证（含传播延迟与记录分段两种情况） |
| HTTPS 未验证 | **未闭环**。需要一套反向代理 + 证书签发与续期方案，并补 HSTS 与 HTTP→HTTPS 跳转 |
| 自定义域名缺少服务端承接说明 | **部分闭环**：`README.md` 第 7 节已给出生产部署与回滚步骤；反向代理配置样例仍需补齐 |
| 服务端没有按 `Host` 头判断的逻辑 | 保持现状（由外部反向代理承接） |
| 验证是手动触发、无自动复核 | 保持现状 |
| 子域名只是建议值（平台不创建 DNS 记录） | 保持现状 |
| 验证令牌长期有效且不过期 | 保持现状 |
| 无 IDN（国际化域名）处理 | 保持现状（需用户自行转 punycode，界面无提示） |
| 当时 `tests/services/hosting-service.test.ts` 为空文件 | **已闭环**：现 13 条用例 |

### 状态

**部分达标**。四项验收中两项达成、两项因缺少真实域名与 TLS 环境未达成。这是本项目**最重要的未关闭债务**，必须在商用上线前解决。

---

## 第 7 阶段：第 7 天与第 15 天提醒

### 目标

加入可配置的定时提醒：发布后第 7 天提醒检查，第 15 天提醒确认或更新；支持时区、完成状态和关闭提醒。

### 交付物（真实路径）

- `src/util/time.ts` —— 无依赖 IANA 时区换算：`assertTimeZone` / `toZonedParts` / `fromZonedParts`（两遍法修正夏令时）/ `addZonedDays` / `startOfZonedDay` / `zonedHourOfDay` / `formatZoned`
- `src/domain/reminder.ts` —— `ReminderRuleConfig` / `DEFAULT_REMINDER_CONFIG`（`sendWindowStartHour = 9`，`sendWindowEndHour = 20`）/ `REMINDER_LABELS` / `buildReminderPlan` / `reminderIdempotencyKey` / `isReminderDue` / `canRetry` / `retryDelayMs` / `nextRetryAt` / `withinSendWindow` / `decideDispatch` / `describeReminder` / `reminderStatusLabel`
- `src/db/repositories/reminder-repo.ts` —— `upsertReminder`（幂等键）、`listDueReminders`、`recordAttempt`、`markCompleted` / `markSkipped` / `reopenReminder`、`updateReminder`
- `src/services/reminder-service.ts` —— `reminderConfig` / `scheduleRemindersForPage` / `resolveRecipient` / `dispatchDueReminders`（返回 `DispatchReport`）/ `completeReminder` / `skipReminder` / `reopenReminderById` / `rescheduleReminder` / `listRemindersAdmin`
- `src/http/routes/admin-reminders.ts` —— `GET /api/admin/reminders`、`POST …/dispatch`、`POST …/:id/complete`、`POST …/:id/skip`、`POST …/:id/reopen`、`PATCH …/:id`
- `src/http/routes/admin-auth.ts` —— `POST /api/admin/dev/advance-time`（时间旅行）、`GET /api/admin/dev/clock`
- `src/config.ts` —— `reminders` 配置块（`REMINDER_DAY_1` / `REMINDER_DAY_2` / `REMINDER_MAX_ATTEMPTS` / `REMINDER_DISPATCH_INTERVAL_MINUTES` / `REMINDER_RECIPIENT`）+ `devTimeTravel`（生产环境硬性关闭）
- `src/app-context.ts` —— 条件注入 `FakeClock` 并暴露 `ctx.travelClock`
- `src/server.ts` —— 进程内 `setInterval` 定时扫描（`unref()`，退出时 `clearInterval`）
- `scripts/run-reminders.ts` —— `pnpm reminders` 手工投递一次（第 8 阶段修订时补齐实现）
- `public/admin/views/reminders.js` —— 「发布提醒」视图（规则卡片、时间旅行面板、提醒列表、立即投递）
- 测试：`tests/domain/reminder.test.ts`（14）、`tests/services/reminder-service.test.ts`（12）、`tests/util/time.test.ts`（11）
- 证据：`docs/evidence/07-admin-reminders.png`、`08-reminder-dispatched.png`

### 验收标准与结论（方案第五章第 7 阶段）

> 验收：用可控测试时间验证规则，不需要真实等待 7/15 天；提醒可重试且不会重复轰炸用户。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 用可控测试时间验证规则 | 达成 | 所有业务时间取自注入的 `Clock`；`FakeClock` 在 `DEV_TIME_TRAVEL=true` 且非生产环境时自动启用；冒烟【6】分组 18 项断言覆盖第 0 / 6 / 到期前 / 7 / 15 天；`tests/util/time.test.ts` 11 条覆盖夏令时等边界 |
| 提醒可重试且不会重复轰炸用户 | 达成 | **四重保证**：① 结构层 `idempotency_key` 唯一索引 + 发布时 upsert；② 状态层投递成功后离开 `pending`（重复扫描 `considered = 0`）；③ 策略层指数退避（1 分钟 → 上限 6 小时）、最大尝试次数（默认 3）、发送时段限制（当地 09:00–20:00，含跨午夜）；④ 业务层展示页撤下或未发布时自动 `skip` |

### 验证方式与实测结果

| 命令 | 观测结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | 【6】分组 **18 项**断言通过：生成 2 条提醒（`delta = 7.349 天` / `15.349 天`）、含 D7 与 D15、时区 `Asia/Shanghai`、D7 时刻 `2026-10-20T01:00:00.000Z`（当地 09:00）、发布当天不发、时间推进 6 天成功、第 6 天不发、时钟拨到到期前 1 小时、到期前不发、第 7 天发 1 次且为 `check_day_7`、重复扫描发 0、第 15 天发 1 次且为 `confirm_day_15`、D15 已记录完成 |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | 本阶段相关文件共 **37 条**用例通过：`reminder`（领域）14 + `reminder-service` 12 + `time` 11 |
| 浏览器实操 | 「发布提醒」→ 规则卡片与 2 条待处理提醒 → 时间旅行 `+7 天` → 「立即投递」→ 统计与逐条明细 → 再点一次发送数为 0 → 「标记完成」/「关闭提醒」→「重新启用」→「重置为真实时间」 |
| 证据 | `07-admin-reminders.png`（规则卡片、时间旅行面板、2 条提醒、立即投递）与 `08-reminder-dispatched.png`（投递后）；`MAIL_PROVIDER=console` 时的模拟邮件正文未单独归档 |

### 已知缺口

| 缺口 | 后续状态 |
| --- | --- |
| **SMTP 真实投递未验证** | **未闭环**。`SmtpMailProvider` 实现了隐式 TLS(465)、STARTTLS(587)、AUTH LOGIN、RFC 2047 中文主题与 base64 正文，但运行使用 `console`、测试使用 `memory`，从未对真实邮件服务器投递 |
| 后台「计划时间」按浏览器本地时区渲染，与下一行标注的时区不一致 | 保持现状（`public/admin/ui.js` 的 `fmtDateTime` 未指定 `timeZone`） |
| 提醒天数与重试上限不能在界面修改 | 保持现状（只能改环境变量并重启） |
| 缺少投递的可观测性（无上次/下次扫描时间、无历史投递记录界面） | 保持现状（只能从 `audit_logs` 与 `reminders.last_error` 间接看） |
| 多实例部署无分布式协调 | 保持现状（依赖 SQLite 单写者 + 状态推进；三个投递入口之间无锁） |
| 提醒邮件正文为纯文本中文，不跟随房源语言；无退订链接 | 保持现状（由「关闭提醒」承担退订语义） |
| 当时 `tests/domain/reminder.test.ts` 与 `tests/services/reminder-service.test.ts` 为空文件 | **已闭环**：现共 26 条用例 |

### 状态

**达标（附带条件）**。
---

## 第 8 阶段：安全、性能与上线准备

### 目标

检查权限隔离、上传文件校验、备份恢复、日志、错误提示、移动端体验、基础性能、许可证归档和部署/回滚步骤。

### 交付物（真实路径）

- `src/services/backup-service.ts` —— `BACKUP_TABLES`（10 张表）、`createBackup`（`VACUUM INTO` 一致性快照 + 经**存储适配器**读取全部素材 + `manifest.json`）、`backupFileName` / `parseBackupTime`、`listAllStorageKeys`、`tableCounts`、`listBackups`、`verifyBackupFile`（逐表与 manifest 比对）、`restoreBackupToDirectory`（解包到独立目录，拒绝越界路径）、`pruneBackups`（按 `BACKUP_RETENTION_DAYS`）
- `src/http/routes/admin-backup.ts` —— `GET/POST /api/admin/backups`、`POST …/verify`、`POST …/restore-drill`、`POST …/prune`
- `src/http/routes/health.ts` —— `GET /healthz`（状态 + 当前时间 + 已应用迁移 + 各适配器名）、`GET /api/admin/diagnostics`（环境、迁移、房源统计、适配器名、`storageWritable` 写-读-删探针、`timeTravelEnabled`、**脱敏**配置）
- `src/http/security.ts` —— HMAC 会话 + 恒定时间比较、`LoginRateLimiter`、`contentSecurityPolicy`、`securityHeaders`
- `src/http/app.ts` —— 统一鉴权钩子、`onSend` 安全头钩子、统一错误处理、`setNotFoundHandler`、`/media/*` 经存储适配器（**修复了原先绕过适配器的隐患**）、同源 `/vendor/leaflet/`
- `src/config.ts` —— `validateConfig`（生产环境拒绝默认口令 / 过短口令 / 示例会话密钥 / 过短会话密钥 / 非 https 的 `PUBLIC_BASE_URL`）、`redactedConfig`、`ensureRuntimeDirs`
- `src/util/logger.ts` —— 结构化日志 + 敏感键名自动脱敏
- `src/domain/media.ts` —— 魔数上传校验（见 7.5 节）
- `src/util/zip.ts` / `src/util/unzip.ts` —— 备份归档读写（含 `..` 路径拒绝）
- `public/admin/views/backup.js` —— 「备份与恢复」视图
- `.env.example` —— 全部环境变量与安全说明（89 行）
- `docs/licenses.md` —— 许可证与授权证据归档（8 节 + 商用前复核清单）
- `docs/reports/phase-8-report.md` —— 含可执行的部署与回滚步骤（15 步）
- `README.md` —— 10 节：快速开始、功能概览、项目结构、数据模型、配置、验证方式、生产部署与回滚、已知限制、已知环境适配、第三方组件与许可
- 测试：`tests/services/backup-service.test.ts`（9）、`tests/integration/security.test.ts`（16）
- 证据：`docs/evidence/09-backup-restore-drill.png`、`10-admin-settings.png`

### 验收标准与结论（方案第五章第 8 阶段）

> 验收：关键用户路径通过真实浏览器测试；备份能够恢复；无硬编码密钥；上线与回滚流程清楚。

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| 关键用户路径通过真实浏览器测试 | 达成 | 16 张截图覆盖登录、房源列表、房源编辑与校验报错、「发布页面」标签、展示页（桌面/手机、中/英）、**地图实际渲染**、发布提醒与投递结果、备份恢复演练、设置页、导出形态页面；完整闭环由 73 项端到端检查复跑通过（73/73，退出码 0） |
| 备份能够恢复 | 达成 | 冒烟【8】分组 6 项断言；`backup-service.test.ts` 9 条。采用「恢复到独立目录 + 逐表校验」而非直接覆盖线上数据，可反复演练 |
| 无硬编码密钥 | 达成 | 密钥只从环境变量读取；默认值全为明显占位符且生产环境启动即拒绝；`.env` 与 `var/` 已排除；后台与日志均脱敏；外部服务配置拒绝保存疑似密钥字段 |
| 上线与回滚流程清楚 | 达成（文档层面） | `docs/reports/phase-8-report.md` 给出 15 步可执行流程（部署前置 4 步 / 发布 6 步 / 回滚 5 步）+ 回滚触发条件与复核清单；`README.md` 第 7 节已把该流程提升为独立章节。回滚链条仍有外部依赖：TLS 方案未定，且迁移设计为「只增不改、无 down 脚本」，数据层回滚等价于整库恢复到备份 |

### 验证方式与实测结果

| 命令 | 观测结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | 【8】分组 **6 项**断言通过：创建备份 201（实测 168,891 字节，manifest `workspaces 1 / users 1 / properties 1 / property_translations 1 / contacts 0 / media 1 / listing_pages 1 / reminders 2 / external_service_configs 0 / audit_logs 16`，`mediaFiles = 1`）、校验 `ok = true`、恢复演练 200、恢复后 `properties = 1`、媒体文件 ≥ 1、`reminders = 2`。另有分散在其他分组的 4 项安全断言（未登录 401、错误口令 401、伪装 PNG 被拒 400、CSP 含 `nonce-`） |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | 本阶段直接相关文件 **25 条**用例通过：`backup-service` 9 + `security` 16 |
| `node node_modules/typescript/bin/tsc --noEmit` | 无输出，退出码 0 |
| 浏览器实操 | 后台「备份与恢复」→「立即备份」→ 列表出现 `backup-…zip`（1012.0 KB）→「校验」显示逐表行数 →「恢复演练」显示恢复目录 `var\restore-drill`、数据文件、素材文件 7 个、表行数 `{workspaces:1, users:1, properties:3, property_translations:2, contacts:5, media:10, listing_pages:3, reminders:2, external_service_configs:0, audit_logs:24}` →「清理过期备份」 |
| 许可证归档 | `docs/licenses.md` + `docs/phase0-decision-record.md` 第 7 节的 12 项核验清单，含两处证据弱点 |

### 报告原列的 11 项失败项与当前关闭状态

第 8 阶段报告初稿登记了 11 项失败项。下表是它们在**本计划定稿时**的真实状态（报告已在文件顶部追加修订记录，正文中的原始描述保留）：

| # | 初稿登记的失败项 | 当前状态 |
| --- | --- | --- |
| 1 | 自动化测试目录为空（19 个文件全为 0 字节，`pnpm test` 不可用） | **已关闭**。现有 20 个 `*.test.ts` + 1 个 helper，`pnpm test` 通过 251/251 |
| 2 | 尚未初始化版本控制（无 `.git`） | **已关闭**。仓库有 4 个提交；回滚可用 Git，不必依赖人工留副本 |
| 3 | HTTPS / TLS 未验证 | **未关闭**。应用不做 TLS 终结、无 HSTS；只有配置层要求生产 `PUBLIC_BASE_URL` 为 https |
| 4 | SMTP 真实投递未验证 | **未关闭** |
| 5 | 性能只有定性结论；列表接口 N+1 | **部分关闭**。N+1 已消除（`listProperties()` 单条 SQL，含 `LEFT JOIN listing_pages` 与 `photo_count` 子查询）；**仍无任何量化数据**（无压测、无 TTFB、无内存/连接数观察） |
| 6 | 依赖安全审计未做（无 `pnpm audit`） | **未关闭** |
| 7 | 后台窄屏体验未验证 | **未关闭**（后台截图均为 1360×900） |
| 8 | 备份的安全与运维缺口（未加密、只在本机、清理需手工、未验证「用恢复数据启动服务」） | **未关闭** |
| 9 | 登录限流是单进程内存态；公开页无限流 | **未关闭** |
| 10 | 权限模型仍是单账号（审计 `actor` 无法对应自然人） | **未关闭** |
| 11 | `README.md` 为空 | **已关闭**。`README.md` 现有 10 节，含快速开始、配置、验证方式、生产部署与回滚、已知限制、第三方组件与许可 |

另有报告修订记录中记录的两项修复（均属**比原失败项更严重的隐患**）：

- **备份与媒体曾绕过存储适配器**：`/media/*` 原由 `@fastify/static` 直接从磁盘提供，备份原直接扫描 `UPLOAD_DIR`。一旦把 `STORAGE_PROVIDER` 换成对象存储，**展示页图片会全部 404、备份会静默丢失全部素材**。现已改为两者都经适配器读写，且读取失败的素材会在 manifest 中明确记录。该修复正是本计划第 5 阶段之后、设计说明书 5.3 节所固化的约束。
- **预览页 CSP 与公开页不一致**：预览页曾单独使用 `default-src 'self' data: 'unsafe-inline'`，无法执行带 nonce 的内联脚本，导致预览页的交互与地图被 CSP 拦掉。现已与公开页共用同一套 CSP（含 nonce 与地图所需的内联样式放宽），仅额外声明 `X-Robots-Tag: noindex`。

### 状态

**达标（附带条件）**。四项验收全部达成；11 项附带条件中 3 项（测试、Git、README）已关闭，8 项仍未关闭，其中 TLS/HTTPS、SMTP 真实投递、备份加密与异地副本属于**商用上线的阻塞项**。

---

## 交付物清单（按目录汇总）

### `src/domain/`（9 个文件，零 IO）

`types.ts`、`errors.ts`、`validate.ts`、`property.ts`、`media.ts`、`listing-page.ts`、`reminder.ts`、`i18n.ts`、`hosting.ts`

### `src/db/`（4 + 9 个文件）

`database.ts`、`migrations.ts`、`migrate.ts`、`sql.ts`；`repositories/`：`property-repo.ts`、`media-repo.ts`、`contact-repo.ts`、`translation-repo.ts`、`listing-page-repo.ts`、`reminder-repo.ts`、`workspace-repo.ts`、`external-service-repo.ts`、`audit-repo.ts`

### `src/adapters/`（7 个文件）

`clock.ts`、`map.ts`、`storage.ts`、`mail.ts`、`dns.ts`、`hosting.ts`、`registry.ts`

### `src/services/`（9 个文件）

`property-service.ts`、`media-service.ts`、`publish-service.ts`、`export-service.ts`、`reminder-service.ts`、`i18n-service.ts`、`hosting-service.ts`、`backup-service.ts`、`audit-service.ts`

### `src/render/`（4 个文件）

`page-renderer.ts`、`templates.ts`、`qrcode.ts`、`html.ts`

### `src/http/`（3 + 10 个文件）

`app.ts`、`security.ts`；`routes/`：`health.ts`、`public-pages.ts`、`admin-auth.ts`、`admin-properties.ts`、`admin-media.ts`、`admin-pages.ts`、`admin-reminders.ts`、`admin-settings.ts`、`admin-export.ts`、`admin-backup.ts`

### `src/` 根与 `src/util/`（3 + 6 个文件）

`config.ts`、`app-context.ts`、`server.ts`；`util/`：`time.ts`、`slug.ts`、`ids.ts`、`logger.ts`、`zip.ts`、`unzip.ts`

### `public/admin/`（6 + 6 个文件）

`index.html`、`app.js`、`api.js`、`ui.js`、`styles.css`；`views/`：`properties.js`、`property-edit.js`、`pages.js`、`reminders.js`、`settings.js`、`backup.js`

### `scripts/`（5 个文件）

`seed.ts`、`smoke.ts`、`run-reminders.ts`、`export-once.ts`、`serve-static.mjs`

### `tests/`（20 个 `*.test.ts` + 1 个 helper）

`adapters/map.test.ts`（20）；`domain/`：`property`（15）、`media`（17）、`listing-page`（19）、`reminder`（14）、`i18n`（15）；`services/`：`property-service`（12）、`media-service`（11）、`publish-service`（13）、`reminder-service`（12）、`export-service`（8）、`hosting-service`（13）、`backup-service`（9）、`i18n-service`（10）；`integration/`：`api-properties`（11）、`public-page`（11）、`export`（7）、`security`（16）；`util/`：`time`（11）、`zip`（7）；`helpers/test-app.ts`。**合计 251 条用例。**

### `docs/`

`phase0-decision-record.md`、`licenses.md`、`plans/2026-10-12-implementation-plan.md`（本文档）、`superpowers/specs/2026-10-12-property-listing-platform-design.md`、`reports/phase-0-report.md` ~ `phase-8-report.md`、`reports/final-report.md`、`evidence/`（16 个 PNG）

### 根目录

`package.json`、`tsconfig.json`、`.npmrc`（`node-linker=hoisted`，适配 exFAT 卷）、`.env.example`、`.gitignore`、`README.md`、`轻量化房源管理与一键房源网站生成平台_整合实施方案.txt`（归档方案）

---

## 商用上线前剩余工作

按「是否阻塞上线」分成两组。**阻塞项必须在对外开放之前关闭**。

### 阻塞项（必须关闭）

| # | 事项 | 为什么阻塞 | 最小完成标准 |
| --- | --- | --- | --- |
| B1 | **HTTPS 终结** | 应用不做 TLS 终结、无 HSTS；当前只有配置层要求 `PUBLIC_BASE_URL` 为 https。没有 HTTPS 就不能对外收发口令与联系方式 | 反向代理（nginx / Caddy / 云 LB）承接域名与证书；实测 HTTP→HTTPS 跳转与证书续期；补 `Strict-Transport-Security`；把配置样例写入 `README.md` 或 `docs/deploy.md`；重新截图归档 |
| B2 | **域名所有权验证端到端实测** | 机制已实现但从未在真实 DNS 上跑通；用户按界面完成验证后域名仍可能打不开 | 用一个受控公网测试域名完成「添加 TXT → 服务端查询到 → 验证通过 → 公开地址切换」，并覆盖 DNS 传播延迟与 TXT 记录分段两种情况 |
| B3 | **一次真实 SMTP 投递验证** | 提醒功能的最后一公里未验证；`console` 提供者只写日志 | 对真实邮件服务器投递成功，记录 TLS 握手方式（465 隐式 / 587 STARTTLS）、认证结果、中文主题在各客户端的显示情况 |
| B4 | **备份加密 + 异地副本 + 完整切换演练** | 备份含房源地址与联系方式等个人信息，未加密且只在本机；恢复演练只到独立目录 | 归档加密；副本落到异机或对象存储；过期清理改为定时任务；完成一次「停服 → 用备份恢复 → 启动 → 复核关键路径」的完整演练 |
| B5 | **依赖漏洞审计** | 未运行过 `pnpm audit` 或等价工具，传递依赖的已知漏洞未知 | 运行审计并记录结论；把 `docs/licenses.md` 第 7 节的商用前复核清单纳入发布检查表 |
| B6 | **精确坐标隐私处理** | 住宅房源的精确经纬度等同公开门牌位置，当前无任何选项或提示 | 至少给出「模糊到区域/街道级别」的选项，或在后台明确提示风险 |

### 非阻塞项（建议但可延后）

| # | 事项 | 说明 |
| --- | --- | --- |
| N1 | 补齐界面文案目录 | 12 种语言中只有 4 种有词条；也可选择把语言栏收窄到真正支持的语言，避免「已支持」的误导 |
| N2 | 为自由文本字段增加翻译通道 | 地址、附加费用、楼层说明、素材来源说明目前无法翻译 |
| N3 | 处理 `formatDateOnly` 的签名与实现不一致 | 二选一：删掉未使用的参数并改名，或真正实现时区支持 |
| N4 | 性能基线 | 列表接口在 N 条房源下的耗时、展示页 TTFB、备份/导出耗时；N+1 已消除，但仍无容量结论 |
| N5 | 上传后处理 | 图像压缩、缩略图、**EXIF 剥离**（隐私） |
| N6 | 后台窄屏验证与截图 | 后台截图均为桌面视口 |
| N7 | 补齐三个模板的运行时验证 | `classic` 与 `minimal`（尤其「不显示二维码」分支）只有代码级实现 |
| N8 | 导出体验 | `file://` 打开的地址栏截图；导出包体积提示或分卷；导出目录改用对外干净的文件名 |
| N9 | 多用户与角色 | 涉及 `users` 表的使用方式与审计 `actor` 语义；单账号下审计无法定位到人 |
| N10 | 公开页限流与防抓取 | 当前完全开放 |
| N11 | 多实例协调 | 三个提醒投递入口与登录限流均无跨进程协调 |
| N12 | 可观测性 | 提醒的上次/下次扫描时间、历史投递记录界面 |
| N13 | 备份保留策略自动化 | 过期清理目前需手工触发 `POST /api/admin/backups/prune` |
| N14 | 迁移回滚能力 | 迁移「只增不改、无 down 脚本」，数据层回滚等价于整库恢复到备份 —— 因此上线前必须先做基线备份 |
| N15 | 许可证证据补强 | `qrcode-generator` 包内无 LICENSE 文件；OSM 瓦片与 Overpass 的商用政策需复核 |

---

## 附录 A：本次修订的时间背景（阅读时请注意）

本计划所依据的仓库状态为 **2026-10-12 的 4 个提交**：

```
0e001f8 fix: 预览页 CSP 与公开页对齐；补齐安全集成测试与提醒脚本
0a4643b test: 补充适配器层测试（地图降级、存储路径安全、邮件头注入、时钟、DNS）
64cacd6 docs: 交付文档（README、第 0 阶段与最终报告、各阶段修订记录）
64c3e02 feat: 轻量化房源管理与一键房源网站生成平台（第 0-8 阶段）
```

后 3 个提交关闭了第 8 阶段报告「附带条件」中的若干项（补齐测试、初始化 Git、预览页 CSP 对齐、实现 `scripts/run-reminders.ts`），并使 `docs/reports/phase-4-report.md` 的结论由「否」更正为「是」。各阶段报告的**正文**保留了撰写当时的判断（例如「`tests/` 下 19 个文件全部为 0 字节」「地图实际上不可用」），这些描述在阅读时已经过时 —— 请以各报告顶部的「修订记录」小节、本计划与设计说明书为准。

本计划中所有涉及代码的事实均来自对仓库当前内容的直接读取与命令实测；命令与观测结果逐条记录在各阶段的「验证方式与实测结果」表中，收尾复核见第 0 节。
