# 轻量化房源管理与一键房源网站生成平台 —— 设计说明书

- 文档类型：工程设计说明书（design spec）
- 版本：1.0
- 日期：2026-10-12
- 状态：与仓库当前代码一致（代码已实现并通过验证，见第 9 节）
- 上游依据：《轻量化房源管理与一键房源网站生成平台_整合实施方案（归档稿 1.0）》（仓库根目录，章节一至十）

**相关文档**

| 文档 | 作用 |
| --- | --- |
| `docs/phase0-decision-record.md` | 第 0 阶段底座决策记录：候选项目核验表、决策理由、偏差登记 |
| `docs/licenses.md` | 许可证与授权证据归档（依赖、模板、外部数据服务） |
| `docs/plans/2026-10-12-implementation-plan.md` | 实施计划（已执行）：按阶段 0-8 的交付物与验证结果 |
| `docs/reports/phase-1..8-report.md` | 各阶段验收报告（按方案第九章模板） |
| `docs/evidence/*.png` | 真实浏览器验证截图 |

> 说明：`docs/reports/phase-4-report.md`、`phase-6-report.md`、`phase-8-report.md` 在本轮开发后期追加了「修订记录」小节（位于各文件顶部），其中**第 4 阶段的验收结论由「否」更正为「是」**。阅读这些报告时请先读修订记录，再看正文。本文档描述的是**代码当前状态**（复核日期 2026-10-12，仓库 4 个提交）；若与旧报告正文冲突，以本文档与代码为准。

---

## 1. 背景与目标

### 1.1 要解决的问题

个人房东、小型中介与短租经营者发布一套房源，通常要重复做四件事：在后台记录一遍房源信息，在另一个工具里做一张展示页，再手工生成一个分享链接或二维码，最后靠自己的记忆在两周后回头检查房源是否还有效。同一套房源的信息被复制到多个地方，改一处就会有一处不同步；发到海外的房源还要再翻译、再换算币种与面积单位。

本项目要把这条链路收敛成一次录入：

1. 在后台录入一次房源（文字、地址、价格、费用、照片/视频、联系方式）；
2. 系统从同一份数据生成一张适配手机与桌面的公开展示页，并给出唯一分享链接与二维码；
3. 页面可随时发布/撤下，可多语言切换，可选静态 HTML 导出带走；
4. 发布后第 7 天与第 15 天自动提醒检查与更新；
5. 所有外部服务（地图、存储、邮件、DNS、托管）都通过适配层接入，可替换、不写死某一国家或某一供应商。

### 1.2 目标用户

- **主用户**：单人或小团队经营的房源持有者/管理者（1 个工作区、1 个管理账号、数条到数十条房源）。
- **间接用户**：拿到分享链接的访客（手机扫码或直接打开），以及收到导出包的第三方（自行托管静态页面）。
- **运维者**：部署与维护本服务的人（配置环境变量、做备份、接反向代理）。

### 1.3 成功标准

按方案第六章第 4 条，成功不由「类型检查通过」或「接口返回 200」定义，而由以下可观察结果定义：

| 编号 | 成功标准 | 当前状态 |
| --- | --- | --- |
| S1 | 用真实浏览器完成「登录 → 录入 → 上传照片 → 发布 → 公开访问 → 撤下」全链路，刷新后数据仍在，错误输入有明确中文提示 | 达成（截图 + 73 项端到端检查） |
| S2 | 修改房源后展示页同步更新；未发布房源不能被公开访问 | 达成（实时渲染，无缓存副本） |
| S3 | 导出包可在本地独立打开，图片路径有效，核心展示不依赖管理后台 | 内容层面达成；`file://` 打开动作未独立截图确认（见第 3 阶段报告） |
| S4 | 地图与周边信息经统一适配层接入，故障时仍能显示地址 | 地图达成；周边信息仅验证了降级路径（见第 10 节） |
| S5 | 切换语言不丢失数据，原文不被译文覆盖 | 达成（表结构 + 接口双重保证） |
| S6 | 未经验证的域名不能直接绑定；发布与撤回可重复操作 | 规则达成；真实 DNS/HTTPS 未验证（见第 10 节） |
| S7 | 用可控测试时间验证 7/15 天提醒，不真实等待；提醒可重试且不重复轰炸 | 达成（时间旅行 + 12 项断言） |
| S8 | 备份能够恢复；无硬编码密钥；上线与回滚流程清楚 | 备份恢复达成；密钥纪律达成；上线流程见实施计划 |

### 1.4 四条基本原则（沿自方案第一章）

1. **单一底座**：只选择一个主系统作为底座，其余项目只补充必要能力或作为设计参考，不拼接多个完整系统（方案第一章第 1、2 条）。
2. **一份数据**：房源信息只维护一份，后台、展示页与导出内容均从统一数据源生成，禁止各模块维护互不一致的副本（方案第一章第 3 条）。
3. **国内外通用**：不把某一国家的地址格式、货币、费用规则、面积单位写死（方案第一章第 4 条）。
4. **按阶段验收**：一次只推进一个阶段，当前阶段通过真实用户路径测试与验收后才进入下一阶段（方案第一章第 5 条、第六章第 1 条）。

这四条不是口号，各自有对应的结构性约束，见第 3.3 节（一份数据）、第 4.12 节（国内外通用）与实施计划（按阶段验收）。

---

## 2. 底座的取舍

### 2.1 第 0 阶段的决策

方案第 0 阶段要求「检查候选项目的官方仓库、许可证、维护状态、技术栈、依赖、部署流程和数据模型；制作能力对照表并进行实际部署验证；最终只确定一个主底座」。

决策结论（记录于 `docs/phase0-decision-record.md`）：

> **不采用 PropertyWebBuilder 作为底座；采用面向本方案闭环自建的轻量 Node.js 24 + TypeScript 底座。**

### 2.2 决策依据

核验日期 2026-10-12，依据为 GitHub 官方 API 元数据 + 本机工具链实测：

1. **运行环境没有 Ruby/Rails 工具链**。`Get-Command ruby` / `rails` / `gem` / `bundle` 全部不存在；本机已有 `node v24.14.0`、`pnpm 10.32.1`、`npm 11.9.0`、`docker`、`git`。要把 PropertyWebBuilder 作为底座，必须先引入整套 Ruby 运行时、Bundler 依赖链与 Rails 部署流程，与方案第一章第 1 条「简单轻量」直接冲突。
2. **数据模型取向不同**。PropertyWebBuilder 是面向多用户、MLS 式房源列表的网站 CMS（含主题系统与内容页层）。把 CMS 型底座套到「单工作区、一次录入、一键出页」的闭环上，必然引入主题层/内容页层与房源层的重复字段，违反方案第六章第 3 条「不创建平行系统、不留下重复模块」。
3. **体积与可审计性**。`property_web_builder` 是约 96 MB 的 Rails 单体；自建底座的实际运行期依赖只有 5 个包（`fastify`、`@fastify/cookie`、`@fastify/multipart`、`@fastify/static`、`qrcode-generator`）。

其余候选的处理（`docs/phase0-decision-record.md` 第 5 节）：

| 项目 | 定位 | 处理 |
| --- | --- | --- |
| `etewiah/property_web_builder`（MIT，Ruby/Rails，647 star） | 主底座优先评估对象 | **不采用为底座**（上述三条） |
| `microrealestate/microrealestate`（许可证字段 `NOASSERTION`） | 暂不作为核心依赖 | **排除**，不引入代码、不复制数据结构；条款澄清后再评估 |
| `clawnify/OpenProperty`（MIT，TypeScript/React） | 后台管理能力参考 | 降级为信息架构参考，**未复制任何代码** |
| real-estate-listing-template 系列（多数无 LICENSE） | 单套房源页面模板参考 | 降级为视觉分区参考，**未复制代码，也未使用任何示例图片** |

### 2.3 已记录的偏差：PropertyWebBuilder 未做实际部署

方案第 0 阶段明确要求「进行**实际部署验证**」。**本项目的实际执行中没有部署 PropertyWebBuilder**，原因是第 2.2 节第 1 条：本机不存在 Ruby/Rails 工具链，无法完成 `bundle install` 与 Rails 启动；而在没有工具链的前提下安装整套 Ruby 运行时，恰恰是本次决策要否定的做法。

这是一条**明确记录、不静默省略**的偏差（`docs/phase0-decision-record.md` 第 4 节），由此产生的核验边界如下：

| 项目 | 状态 |
| --- | --- |
| 许可证、主语言、star/fork、最后推送时间、仓库体积、topics | 已核验（2026-10-12 GitHub API） |
| 本机 Ruby/Rails 工具链缺失 | 已核验（`Get-Command` 实测） |
| PropertyWebBuilder 的实际启动与部署流程 | **未核验** |
| PropertyWebBuilder 后台实际操作体验、地图与多语言模块的真实表现 | **未核验** |
| PropertyWebBuilder 的升级/迁移路径与安全公告历史 | **未核验** |

按方案第六章第 7 条处理：先给出可核实的证据与替代方案，再定案；不把未部署的评估表述为已完成部署验证。后续若要以 PropertyWebBuilder 作为能力对比基准，必须先补齐上述「未核验」三项。

### 2.4 自建底座的实际形态

| 维度 | 选择 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js 24（`engines.node: >=24.0.0`） | 直接运行 `.ts` 源文件（原生类型擦除），**无编译、无打包、无构建产物** |
| HTTP | Fastify 5 | 只做「解析输入 → 调服务 → 输出」，业务逻辑不在路由里 |
| 数据库 | `node:sqlite`（`DatabaseSync`） | 单文件库、同步 API、无网络往返、无 ORM |
| 校验 | 手写校验器 `src/domain/validate.ts` | 不引入校验框架，错误信息为字段级中文 |
| 二维码 | `qrcode-generator`（MIT）生成矩阵 → 项目自行渲染内联 SVG | 离线可用，不依赖在线服务 |
| 地图前端 | `leaflet` 1.9.4（BSD-2-Clause），从 `node_modules` 同源提供 | 见 7.4 节：放自己的域名下，`script-src` 无需放行外部源 |
| 后台界面 | `public/admin/` 原生 ES Module 静态页 | 无 bundler、无框架、无构建步骤 |
| ZIP | 自研最小实现 `src/util/zip.ts` / `unzip.ts` | 避免引入压缩库带来的额外许可证与安全面 |

> 环境约束：本工作区位于 exFAT 卷，不支持硬链接/符号链接，因此 `.npmrc` 强制 `node-linker=hoisted`。
---

## 3. 总体架构

### 3.1 分层与目录职责

| 层 | 目录 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| 领域层 | `src/domain/` | 纯类型、常量、规则与校验：`types.ts`、`errors.ts`、`validate.ts`、`property.ts`、`media.ts`、`listing-page.ts`、`reminder.ts`、`i18n.ts`、`hosting.ts` | 不做任何 IO，不碰数据库、HTTP、文件系统 |
| 数据层 | `src/db/` | `database.ts`（连接与事务辅助）、`migrations.ts`（迁移定义）、`migrate.ts`（CLI）、`sql.ts`、`repositories/*.ts`（9 个仓储） | 不含业务判断；仓储只做行的读写与映射 |
| 适配层 | `src/adapters/` | 6 个可替换接口与其实现：`clock.ts`、`map.ts`、`storage.ts`、`mail.ts`、`dns.ts`、`hosting.ts`，以及组合用的 `registry.ts` | 不做业务编排，不直接读写业务表 |
| 服务层 | `src/services/` | 业务编排：`property`、`media`、`publish`、`export`、`reminder`、`i18n`、`hosting`、`backup`、`audit` | 不解析 HTTP 请求，不拼 HTML |
| 渲染层 | `src/render/` | `page-renderer.ts`（整页渲染）、`templates.ts`（3 个模板与基础 CSS）、`qrcode.ts`（内联 SVG）、`html.ts`（转义与安全 URL） | 不访问数据库，只接收 `PropertyAggregate` |
| 接口层 | `src/http/` | `app.ts`（装配与钩子）、`security.ts`（会话、CSP、限流、安全头）、`routes/*.ts`（10 个路由模块） | 不写业务规则，只做输入解析与输出 |
| 界面层 | `public/admin/` | 无构建后台 SPA：`index.html`、`app.js`、`api.js`、`ui.js`、`styles.css`、`views/*.js`（6 个视图） | 只通过 `/api/admin/*` 与后端通信 |
| 工具层 | `src/util/` | `time.ts`（时区换算）、`slug.ts`、`zip.ts`、`unzip.ts`、`ids.ts`、`logger.ts` | 无业务语义 |
| 组合根 | `src/app-context.ts`、`src/config.ts`、`src/server.ts` | 配置加载与校验、数据库与适配器装配、进程生命周期与定时器 | 不含业务规则 |

### 3.2 模块依赖图

```
依赖方向：上层依赖下层（箭头表示「依赖」，不表示数据流）

  +-----------------------------------------------------------------+
  |  src/server.ts                                                   |
  |  进程入口：配置校验 -> 建目录 -> 打开库并迁移 -> 装配 -> listen      |
  |  另含提醒定时扫描（setInterval + unref）与 SIGINT/SIGTERM 优雅退出   |
  +-----------------------------------------------------------------+
        |                                              |
        | 依赖                                          | 依赖
        v                                              v
  +---------------------------+              +---------------------------+
  |  src/config.ts            |              |  src/app-context.ts        |
  |  环境变量 -> AppConfig      |<-------------|  组合根：openDatabase +    |
  |  validateConfig 启动即拒绝  |  依赖         |  runMigrations +          |
  |  redactedConfig 脱敏快照    |              |  ensureDefaultWorkspace + |
  +---------------------------+              |  createAdapters           |
                                             +---------------------------+
        |                                              |
        | 依赖                                          | 依赖
        v                                              v
  +-----------------------------------------------------------------+
  |  src/http/*        路由、鉴权钩子、CSP/安全头、错误映射、媒体出口    |
  |  src/render/*      HTML 渲染、模板、内联二维码、转义与安全 URL       |
  |  public/admin/*    后台 SPA（仅通过 HTTP 访问后端）                 |
  +-----------------------------------------------------------------+
        | 依赖
        v
  +-----------------------------------------------------------------+
  |  src/services/*    业务编排                                     |
  |  property / media / publish / export / reminder / i18n /         |
  |  hosting / backup / audit                                       |
  +-----------------------------------------------------------------+
        | 依赖                        | 依赖
        v                            v
  +---------------------------+  +---------------------------+
  |  src/db/*                 |  |  src/adapters/*           |
  |  database / migrations /  |  |  clock / map / storage /  |
  |  9 个 repositories         |  |  mail / dns / hosting /   |
  |                           |  |  registry（工厂）          |
  +---------------------------+  +---------------------------+
        | 依赖                        | 依赖
        +-------------+--------------+
                      v
  +-----------------------------------------------------------------+
  |  src/domain/*   纯规则（types / errors / validate / property /    |
  |                 media / listing-page / reminder / i18n / hosting）|
  |  src/util/*     time / slug / zip / unzip / ids / logger          |
  +-----------------------------------------------------------------+
```

### 3.3 依赖方向规则

规则本体：**依赖只能向下，不能向上或跨层回指。**

- `src/domain/` 是唯一的「零依赖内核」。已核验：`src/domain/` 下没有任何文件 `import` 来自 `../db`、`../adapters`、`../services`、`../render`、`../http` 的模块（grep `^import .*from '\.\./(db|services|http|render|adapters)` 无命中）。它只引用同目录文件与 `src/util/`。
- `src/db/` 与 `src/adapters/` 互不依赖：仓储不知道适配器存在，适配器不知道数据库存在。
- `src/render/` 只接收已组装好的 `PropertyAggregate`，自己不去查库（`renderListingPage(input: RenderInput)`）。这是「一份数据」原则在渲染层的落点：页面不可能读到与后台不同的数据副本。
- `src/http/` 不实现业务规则，只做「解析输入 → 调服务 → 输出」，把领域异常交给 `app.setErrorHandler` 统一映射为结构化中文错误。

**一处需要如实说明的非严格之处**：服务层的每个函数第一个参数都是 `ctx: AppContext`，而 `AppContext` 定义在 `src/app-context.ts`；该文件又 `import` 了 `src/db/*` 与 `src/adapters/registry.ts`。因此「services → app-context → db/adapters」这条边使分层不是理想的严格无环层叠。这是一个刻意的取舍：`AppContext` 只承载类型与已构造好的对象，服务层不自己 `new` 数据库或适配器，替换实现只需要改组合根。若将来要改为更严格的依赖倒置，做法是把 `AppContext` 的类型定义下沉到 `src/domain/` 并让 `app-context.ts` 只负责构造。

### 3.4 组合根与依赖注入

`src/app-context.ts` 的 `createAppContext(options)` 是唯一的装配点：

1. `ensureRuntimeDirs(config)` 建好 `DATA_DIR` / `DATABASE_FILE` 父目录 / `UPLOAD_DIR` / `BACKUP_DIR`；
2. `openDatabase()` 打开 SQLite（`options.inMemoryDatabase` 时用 `:memory:`）；
3. `runMigrations(db)` 应用迁移；
4. `ensureDefaultWorkspace()` 保证存在默认工作区（名称、默认语言/币种/面积单位/时区、托管模式、所有者邮箱）；
5. `createAdapters(config, logger, { overrides, inMemoryStorage })` 把配置翻译成具体适配器实例；
6. 当 `DEV_TIME_TRAVEL=true` 且非生产环境时，用 `FakeClock` 覆盖 `clock`，并把实例挂在 `ctx.travelClock` 上供演示接口使用。

`options.adapters` 允许测试注入替代实现。`tests/helpers/test-app.ts` 的 `createHarness()` 即注入 `FakeClock` + `MemoryStorageProvider` + `MemoryMailProvider` + `FakeDnsResolver`，并为每个用例创建独立临时目录与数据库。

### 3.5 运行时 HTTP 面（已核验的完整清单）

**公开（无需登录）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/p/:slug` | 公开展示页；非 `published` 一律 404，与「不存在」返回同一个页面 |
| GET | `/p/:slug/qr.svg` | 二维码 SVG；非 published 返回 404 |
| GET | `/p/:slug/nearby.json` | 周边信息 JSON；按需加载，带 10 分钟缓存头 |
| GET | `/media/*` | 上传媒体只读出口，**经存储适配器读取**（见 5.4 节） |
| GET | `/vendor/leaflet/*` | 同源 Leaflet 资源（`node_modules/leaflet/dist`） |
| GET | `/admin/*` | 后台静态页面（`public/admin/`） |
| GET | `/healthz` | 存活探测：状态、当前时间、已应用迁移、各适配器名 |
| GET | `/favicon.ico` | 内联 SVG 图标 |
| GET | `/` | 302 跳转 `/admin/` |
| POST | `/api/admin/login` | 唯一无需会话的后台写接口 |

**后台（HMAC 会话 Cookie 保护，`/api/admin/session` 为唯一例外）**

| 分组 | 路径 |
| --- | --- |
| 会话 | `GET /api/admin/session`、`POST /api/admin/logout` |
| 演示时钟 | `POST /api/admin/dev/advance-time`、`GET /api/admin/dev/clock`（仅 `DEV_TIME_TRAVEL=true` 可用） |
| 房源 | `GET /api/admin/overview`、`GET/POST /api/admin/properties`、`GET/PATCH/DELETE /api/admin/properties/:id`、`POST /api/admin/properties/:id/status`、`POST /api/admin/properties/:id/duplicate`、`GET /api/admin/properties/:id/audit`、`POST /api/admin/properties/validate`、`GET /api/admin/meta`、`GET /api/admin/upload-policy` |
| 媒体 | `GET/POST /api/admin/properties/:id/media`、`POST /api/admin/properties/:id/media/link`、`PATCH/DELETE /api/admin/media/:mediaId`、`POST /api/admin/properties/:id/media/reorder`、`POST /api/admin/properties/:id/media/cover` |
| 发布 | `GET /api/admin/pages`、`GET /api/admin/templates`、`GET /api/admin/locales`、`GET/PATCH /api/admin/properties/:id/listing`、`POST /api/admin/properties/:id/publish`、`POST /api/admin/properties/:id/withdraw`、`GET /api/admin/properties/:id/preview` |
| 多语言 | `GET/PUT /api/admin/properties/:id/translations`、`DELETE /api/admin/properties/:id/translations/:locale` |
| 导出 | `GET /api/admin/properties/:id/export.zip`、`POST /api/admin/properties/:id/export`、`GET /api/admin/properties/:id/export-preview` |
| 提醒 | `GET /api/admin/reminders`、`POST /api/admin/reminders/dispatch`、`POST /api/admin/reminders/:id/complete`、`POST /api/admin/reminders/:id/skip`、`POST /api/admin/reminders/:id/reopen`、`PATCH /api/admin/reminders/:id` |
| 托管与设置 | `GET/PATCH /api/admin/settings`、`GET/PUT /api/admin/external-services`、`GET /api/admin/audit`、`GET /api/admin/properties/:id/hosting`、`POST/DELETE /api/admin/properties/:id/hosting/domain`、`POST /api/admin/properties/:id/hosting/verify` |
| 备份 | `GET/POST /api/admin/backups`、`POST /api/admin/backups/verify`、`POST /api/admin/backups/restore-drill`、`POST /api/admin/backups/prune` |
| 自检 | `GET /api/admin/diagnostics` |

`GET /api/admin/properties/:id/preview` 值得单独说明：它是「未发布也能看到与公开页同源同版式渲染结果」的接口（`src/http/routes/admin-pages.ts`）。它调用同一个 `renderListingPage()`、注入同一个 per-request nonce，并走与公开展示页完全一致的 CSP（见 7.4 节），只额外声明 `X-Robots-Tag: noindex`。方案第 2 阶段要求展示能力包含「预览」，早期验收报告里这一项曾登记为缺口，现已补齐。
---

## 4. 领域模型

### 4.1 迁移机制

数据库结构由**单一迁移** `v1 initial_schema` 定义（`src/db/migrations.ts`），共 **10 张业务表**，另有迁移记录表 `schema_migrations(version, name, applied_at)`。

迁移的三条硬性规则（对应方案第六章第 5 条「检查迁移、旧数据兼容、保存后读取、删除/归档和失败回滚」）：

1. **每个迁移在独立事务中执行**：`runMigrations()` 对每个未应用的版本执行 `BEGIN` → `up(db)` → 写 `schema_migrations` → `COMMIT`；任何异常都 `ROLLBACK` 并抛出带版本号与原因的 `Error`（附 `cause`），不会留下半套结构。
2. **只增不改**：已发布的迁移不可修改，只能追加新版本；`MIGRATIONS` 按 `version` 升序执行，已应用的版本记入 `skipped`。
3. **幂等**：重复运行 `pnpm migrate` 不产生副作用。

命名约定：表名复数、列名 `snake_case`、所有时间统一存为 **UTC ISO 8601 字符串**（`TEXT`），不使用数据库本地时间类型。

主键统一为 `<前缀>_<uuid>` 形式的 `TEXT`（`src/util/ids.ts`）：`usr` / `wsp` / `prp` / `trn` / `cnt` / `med` / `lpg` / `rmd` / `ext` / `aud`。好处是日志、审计与 URL 里一眼能看出实体类型，且 `isIdOf(kind, value)` 可以在路由参数层做快速失败。

### 4.2 `workspaces` —— 工作区与全部默认值

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 工作区标识 |
| `name` | TEXT | 工作区名称 |
| `owner_user_id` | TEXT | 所有者（指向 `users.id`，项目未加外键约束） |
| `default_locale` | TEXT | 默认语言，如 `zh-CN` |
| `default_currency` | TEXT | 默认币种（ISO 4217），由 `DEFAULT_CURRENCY` 注入并 `.toUpperCase()` |
| `default_area_unit` | TEXT | 默认面积单位（`square_meter` / `square_foot`） |
| `default_timezone` | TEXT | 默认 IANA 时区，提醒规则据此计算 |
| `hosting_provider` | TEXT | 托管模式快照 |
| `created_at` / `updated_at` | TEXT | UTC ISO 8601 |

**设计要点**：语言、币种、面积单位、时区**存在数据里而不是只存在代码里**。这是「国内外通用」原则的落点之一 —— 换一个国家的房东使用，改工作区默认值即可，不需要改代码或迁移。`ensureDefaultWorkspace()` 在每次启动时保证存在一个默认工作区。

### 4.3 `users` —— 用户

`id`、`workspace_id`（FK → `workspaces.id` ON DELETE CASCADE）、`email`、`display_name`、`role`、`created_at`、`updated_at`；索引 `idx_users_workspace(workspace_id)`，唯一索引 `idx_users_email(email)`。

`role` 取值来自 `USER_ROLES = ['owner','manager','viewer']`。**当前实现只使用 `owner` 一条记录**：后台是单口令 + 单一 `admin` 角色会话，`users` 表的多用户能力是为后续扩展预留的结构（见第 10 节）。它当前的实际用途是提供提醒收件人回退邮箱（见 6.3 节）。

### 4.4 `properties` —— 房源主记录（唯一数据源）

| 分组 | 列 |
| --- | --- |
| 标识 | `id`、`workspace_id`（FK CASCADE） |
| 文案 | `title`、`description`（默认 `''`） |
| 地址 | `address_line`、`district`、`city`、`region`、`country_code`、`postal_code` |
| 坐标 | `latitude`、`longitude`（REAL，可为 NULL） |
| 房型与面积 | `property_type`、`bedrooms`、`bathrooms`、`area_value`、`area_unit`、`floor_note` |
| 价格与费用 | `price_amount`、`price_currency`、`price_period`、`deposit_amount`、`deposit_currency`、`extra_fees_note` |
| 时间 | `available_from`（仅日期）、`created_at`、`updated_at` |
| 状态 | `status` |

索引：`idx_properties_workspace(workspace_id, status)`（列表与状态筛选）、`idx_properties_updated(updated_at DESC)`（默认排序）。

**带单位的字段（本模型最重要的设计决策）**：

- **金额一定与币种成对出现**：`price_amount` 与 `price_currency`、`deposit_amount` 与 `deposit_currency`。不存在「一个金额但不知道币种」的行。`price_period` 为 `total` / `per_month` / `per_week` / `per_night` / `per_year`，因此「一次性总价」与「按月收租」都不是默认假设。
- **面积一定与单位成对出现**：`area_value` 与 `area_unit`（`square_meter` / `square_foot`），不默认公制。
- **附加费用是自由文本**（`extra_fees_note`），不建模成结构化的费用科目表。这是刻意的：不同国家的费用规则差异极大（物业费、中介费、押金利息、清洁费、税费），把它写死成字段就等于把某一国的规则写进 schema。
- **地址按通用行政层级建模**（`address_line` / `district` / `city` / `region` / `country_code` / `postal_code`），不假设任何国家的地址格式，也不假设「省—市—区」一定齐全。渲染时由 `composeAddress()` 按层级拼接并过滤空值。
- **`available_from` 只存日期部分**，不存时刻 —— 「可入住日期」是一个日历概念，不是一个瞬间，因此它不需要时区（见 8.4 节的已知不一致）。
- `property_type` 是**自由字典值**（`apartment` / `house` / `room` / `office` …），未知值原样显示而不是拒绝（`propertyTypeLabel()` 只在命中已知字典时翻译）。

状态机 `PROPERTY_STATUSES = ['draft','active','reserved','closed','archived']`：`archived` 的房源默认不出现在列表里，需要 `?includeArchived=true` 显式查询。

### 4.5 `property_translations` —— 译文独立表

`id`、`property_id`（FK → `properties.id` ON DELETE CASCADE）、`locale`、`title`、`description`、`created_at`、`updated_at`；**唯一索引 `idx_translations_property_locale(property_id, locale)`**。

**为什么必须独立成表**：方案第三章第 7 条要求「原始描述与翻译文本应分开保存，切换语言不能覆盖原文」。如果把译文写成 `properties` 上的一列（例如 `title_en`），那么「切换语言」就会变成「改写房源记录」，原文迟早会被覆盖，而且每加一种语言就要改一次 schema。独立成表后：

- 原文只存在于 `properties.title` / `properties.description`，**任何翻译写入路径都不触碰这两列**；
- 增加语言不需要迁移；
- 唯一索引保证「一个房源一种语言一条译文」，重复保存是更新而不是新增；
- 接口层再加一道约束：`saveTranslation()` 拒绝 `locale === 工作区默认语言` 的保存请求，并给出中文提示「请通过编辑房源修改原文，而不是添加同语言译文」（`src/services/i18n-service.ts`）。

选择译文的回退链由 `resolveLocalizedText()` 实现：精确语言 → 语言族（请求 `zh-CN` 可命中 `zh` 译文）→ 原文。返回结构里带 `translated: boolean` 与 `usedLocale`，页面据此显示「当前显示 xx 译文；原始描述始终保留在后台，未被覆盖」的提示。

### 4.6 `contacts` —— 联系方式与公开策略

`id`、`workspace_id`（FK CASCADE）、`property_id`（FK CASCADE，**可为 NULL**）、`display_name`、`channel_kind`、`channel_value`、`is_public`（默认 0）、`sort_order`、`created_at`、`updated_at`；索引 `idx_contacts_property(property_id, sort_order)`、`idx_contacts_workspace(workspace_id, property_id)`。

**`property_id` 可空**是刻意的：`NULL` 表示工作区级默认联系方式，非空表示房源级。读取时由 `listEffectivePublicContacts(workspaceId, propertyId)` 合并，房源级优先。

**`is_public` 默认 0**，页面只渲染 `isPublic === true` 且值非空的渠道（`renderContacts()` 再做一次过滤）。方案第三章第 10 条「联系方式应允许用户决定是否公开」由此落地 —— 默认不公开是安全默认值。

`channel_kind` 取值 `CONTACT_CHANNELS = ['phone','email','chat','wechat','whatsapp','telegram','other']`，覆盖国内外常见渠道。

### 4.7 `media` —— 照片与视频

`id`、`property_id`（FK CASCADE）、`kind`、`storage_key`、`external_url`、`original_name`、`mime_type`、`byte_size`、`sort_order`、`is_cover`、`source_note`、`created_at`、`updated_at`；索引 `idx_media_property(property_id, sort_order)`。

- `kind` 取值 `MEDIA_KINDS = ['photo','video_file','video_link']`。`video_link` 是外部视频链接（存 `external_url`，只允许 http/https），`video_file` 是上传的视频（存 `storage_key`）。
- `storage_key` 由服务端生成，格式 `<propertyId>/<timestamp>-<random>.<ext>`（`buildStorageKey()`），**不使用用户提供的文件名**。`original_name` 只作为展示信息保存。
- `is_cover` 的「每个房源至多一张封面」由服务层保证，不由数据库约束：`resolveCover()` 在每次读改时重算映射，没有封面时回退到排序最靠前的照片，`setCoverMedia()` 拒绝把视频设为封面。用约束表达「至多一个真值」需要部分唯一索引，而用纯函数表达更容易测试，也更容易在不同存储后端间保持一致。
- `source_note` 记录素材来源或授权说明 —— 直接对应方案第三章第 2 条「记录素材来源或授权说明」与第八章第 1 条的许可证风险控制。

### 4.8 `listing_pages` —— 发布页

`id`、`property_id`（FK CASCADE）、`workspace_id`（FK CASCADE）、`slug`、`locale`、`template_id`、`status`、`published_at`、`withdrawn_at`、`custom_domain`、`domain_verify_token`、`domain_verified_at`、`view_count`、`created_at`、`updated_at`。

索引：**唯一索引 `idx_listing_pages_slug(slug)`**、`idx_listing_pages_property(property_id)`、`idx_listing_pages_domain(custom_domain)`。

- `slug` 全局唯一是分享链接可用性的基础；生成策略为「标题 → slug 化，冲突时依次加序号」，中文标题会被保留并以安全形式编码（`src/util/slug.ts`）。
- `status` 取值 `LISTING_STATUSES = ['unpublished','published','withdrawn']`（状态机见 6.2 节）。
- `custom_domain` / `domain_verify_token` / `domain_verified_at` **三列共同**表达「域名是否生效」：只有当 `custom_domain` 非空**且** `domain_verified_at` 非空时才使用自定义域名，否则回退平台默认地址（`isDomainActive()`）。重新绑定必须把 `domain_verified_at` 置为 NULL，避免「换域名后沿用旧验证」。
- `view_count` 每次访问自增，**不去重、不过滤机器人**，只能作粗略参考（已知限制，见第 10 节）。

### 4.9 `reminders` —— 提醒

`id`、`property_id`（FK CASCADE）、`listing_page_id`（FK → `listing_pages.id` **ON DELETE SET NULL**）、`kind`、`due_at`、`timezone`、`status`、`attempts`、`last_attempt_at`、`last_error`、`completed_at`、`idempotency_key`、`created_at`、`updated_at`。

索引：**唯一索引 `idx_reminders_idempotency(idempotency_key)`**、`idx_reminders_due(status, due_at)`。

- `kind` 取值 `REMINDER_KINDS = ['check_day_7','confirm_day_15']`；`status` 取值 `REMINDER_STATUSES = ['pending','completed','skipped','failed']`。
- **`timezone` 是行上的列而不是全局配置**：提醒一旦排定，其触发时刻就按当时的时区固定下来；后续修改工作区时区不会让已排定的提醒漂移。
- **`idempotency_key` = `${propertyId}:${kind}`**，配合唯一索引，保证「同一房源同一类型最多一条提醒」。重新发布时 `upsertReminder()` 是**重置既有记录**而不是新增，因此反复上下架不会累积提醒、也不会重复通知。
- `listing_page_id` 用 `ON DELETE SET NULL` 而不是 CASCADE：发布页被删掉不应该连带删掉提醒记录（提醒是「人对房源的承诺」，其生命周期挂在房源上，由 `property_id` 的 CASCADE 决定）。
- `attempts` / `last_attempt_at` / `last_error` 三列是「可安全重试并记录失败原因」的载体（方案第八章第 6 条）。

### 4.10 `external_service_configs` —— 外部服务配置

`id`、`workspace_id`（FK CASCADE）、`adapter_kind`、`provider`、`config_json`、`secret_refs_json`、`enabled`、`free_tier_note`、`updated_at`；**唯一索引 `idx_external_service_kind(workspace_id, adapter_kind)`**（一个工作区每种适配器一份配置）。

`adapter_kind` 取值 `ADAPTER_KINDS = ['map','storage','mail','hosting']`。

**本表最重要的一条纪律：数据库里只存非敏感配置与密钥的「环境变量名」。** `secret_refs_json` 存的是 `["MAP_API_KEY"]` 这样的名字数组，不是密钥本体。配套的两道防线：

- `PUT /api/admin/external-services` 对 `config` 中键名匹配 `(password|secret|token|api[_-]?key|access[_-]?key)` 的字段**直接拒绝保存**并返回字段级中文提示；
- `GET /api/admin/settings` 与 `/api/admin/diagnostics` 只返回 `redactedConfig()` 的脱敏快照（密钥位置显示「已设置 / (未设置)」）。

`free_tier_note` 字段对应方案第三章第 6 条「上线前明确免费额度及潜在费用」—— 它让费用风险成为一条可查询、可在界面展示的数据，而不是一句文档里的口头承诺。

### 4.11 `audit_logs` —— 审计

`id`、`at`、`actor`、`action`、`entity_type`、`entity_id`、`detail`；索引 `idx_audit_at(at DESC)`、`idx_audit_entity(entity_type, entity_id)`。

写入点覆盖房源创建/更新/状态切换/归档/恢复/删除、媒体上传/删除/排序/封面/来源说明、发布设置/发布/撤下、译文保存/删除、托管绑定/验证/解绑、提醒排定/投递/完成/关闭/重开/改期/放弃、导出、备份创建/校验/恢复演练/清理、设置变更。查询入口为 `GET /api/admin/audit`（最近 100 条）与 `GET /api/admin/properties/:id/audit`。

**已知语义弱点**：`actor` 当前无法对应到具体自然人 —— 后台只有一个管理口令与一个 `admin` 角色，没有多用户身份（见第 10 节）。审计能回答「发生了什么」，暂时不能可靠回答「是谁做的」。

### 4.12 唯一数据源：`PropertyAggregate`

所有展示与导出都从一个聚合出发（`src/domain/types.ts`）：

```
PropertyAggregate {
  property:     Property              // properties 行
  media:        Media[]               // 按 sort_order
  contacts:     Contact[]             // 已合并工作区级默认、且仅公开渠道
  listingPage:  ListingPage | null    // listing_pages 行
  translations: PropertyTranslation[] // property_translations 行
}
```

`publish-service.aggregateFor(ctx, propertyId)` 与 `findPublicPage(ctx, slug)` 是构造它的两个入口；`property-service.getPropertyAggregate()` 提供第三个（供后台详情使用）。**渲染层与导出层只接收这个聚合，自己不去查库**，因此「后台与页面内容一致」不是靠约定维持，而是结构上无法不一致：

- `GET /p/:slug` 每次请求实时渲染，**不落盘、不缓存**，所以「修改房源后页面同步更新」是必然结果；
- `buildExportBundle()` 复用同一个 `renderListingPage()` 与同一个 `getTemplate()`，导出页与线上页不是两套模板；
- `GET /api/admin/properties/:id/preview` 同样调用 `renderListingPage()`，预览与发布后是同一份 HTML 结构。

### 4.13 删除与归档的语义

- **归档**（`status = 'archived'`）：软性隐藏，数据保留，默认列表不显示，可显式查询与恢复。
- **删除**（`DELETE /api/admin/properties/:id`）：**硬删除**，级联清除媒体（含存储文件）、译文、发布页与提醒，没有回收站；误删只能依赖备份恢复。这是一条明确的取舍（避免留下「删除了一半」的隐形状态），但也意味着删除操作不可逆。
---

## 5. 适配层契约

### 5.1 六个接口

适配层的全部契约集中在 `src/adapters/` 六个文件里。`src/adapters/registry.ts` 是唯一的「配置 → 实例」翻译点。

#### 5.1.1 `Clock`（`src/adapters/clock.ts`）

```ts
interface Clock {
  now(): Date;
  advanceDays(days: number): void;
  advanceMs(ms: number): void;
  set(instant: Date | string): void;
}
```

实现：`SystemClock`（生产，`now()` 返回真实时间；三个推进方法直接抛错「不支持推进时间」）、`FakeClock`（测试与演示，可 `set` / `advance`）。

**为什么存在**：方案第 7 阶段验收要求「用可控测试时间验证规则，不需要真实等待 7/15 天」。要让这句话成立，唯一的前提是**业务代码里不存在直接 `new Date()`** —— 所有与「现在」相关的判断都必须走 `ctx.adapters.clock.now()`。这条纪律换来了：提醒规则可以在几秒内验证完第 0/6/7/15 天，导出时间戳可控，发布时刻可控。

`FakeClock` 由 `createAppContext()` 在 `DEV_TIME_TRAVEL=true` 且非生产环境时自动注入，并通过 `POST /api/admin/dev/advance-time` 暴露给浏览器演示面板。

#### 5.1.2 `MapProvider`（`src/adapters/map.ts`）

```ts
interface MapProvider {
  readonly name: string;
  buildView(input: MapViewInput): MapView;                       // 纯函数，不发起请求
  nearby(input, signal?): Promise<NearbyResult>;                 // 可能失败，但不抛错
}
```

实现：`OsmMapProvider`（OpenStreetMap 瓦片 + Overpass 兼容端点）、`DisabledMapProvider`（完全关闭地图）。

**为什么存在**：方案第三章第 6 条要求「地图接入采用可替换的适配层，按国家/地区配置服务和密钥」，第 4 阶段验收要求「位置准确；密钥安全；地图服务故障时仍可显示地址」。三条要求分别对应三个设计决定：

- `buildView()` 是**纯函数**，无论地图是否可用都返回 `fallbackAddress`（地址文本），因此「地图服务故障时仍可显示地址」不依赖任何运行时容错代码 —— 地址从来不经过地图服务。
- `buildView()` 输出的字段里**没有密钥位**，只输出可公开的 `tileUrl` 与 `attribution`。密钥只可能存在于服务端请求（`nearby`）中。
- `nearby()` **永不抛错**：所有失败分支（非 2xx、限流、超时、网络不可达）都返回 `{ available: false, reason: '<中文原因>', places: [], source: 'unavailable' }`。调用方不需要 try/catch，页面永远能渲染出「为什么没有周边信息」。
- `DisabledMapProvider` 的存在证明适配层可以整体替换为「无地图」实现而业务代码不变。

#### 5.1.3 `StorageProvider`（`src/adapters/storage.ts`）

```ts
interface StorageProvider {
  readonly name: string;
  put(key, data): Promise<StoredObject>;
  read(key): Promise<Uint8Array | null>;
  remove(key): Promise<void>;
  exists(key): Promise<boolean>;
  size(key): Promise<number | null>;
  publicUrl(key): string;
}
```

实现：`LocalStorageProvider`（本地磁盘，`publicUrl` 返回 `/media/<key>`）、`MemoryStorageProvider`（测试用）。

**为什么存在**：方案第四章第 7 条列出「存储」为可替换适配器；同时媒体是本项目唯一的大体积外部副作用，需要一处集中做路径安全。两个配套的纯函数承担安全职责：

- `assertSafeKey(key)`：把反斜杠归一为 `/`、去掉前导 `/`、拒绝空串、拒绝盘符（`^[a-zA-Z]:`）、拒绝空段 `.` / `..`、拒绝 `\0`；
- `resolveKeyPath(rootDir, key)`：拼接后**复核结果确实位于根目录内**（`full === root || full.startsWith(root + sep)`），越界即抛错。

#### 5.1.4 `MailProvider`（`src/adapters/mail.ts`）

```ts
interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<MailSendResult>;
}
```

实现：`ConsoleMailProvider`（默认，只写服务端日志）、`SmtpMailProvider`（真实投递，仅用 `node:net` / `node:tls` 实现，支持隐式 TLS 465 与 STARTTLS 587、AUTH LOGIN、RFC 2047 中文主题、base64 正文）、`MemoryMailProvider`（测试收集器）。

**为什么存在**：方案第 7 阶段要求「通知方式应可配置」，第 8 阶段要求「无硬编码密钥」。三个实现覆盖三种场景：开发演示零配置、测试可断言、生产真实投递。安全上有两处硬约束：`assertSafeRecipient()` 用正则校验收件人并拒绝含 CR/LF 的值；`assertSafeHeader()` 对主题过滤换行符 —— 两者共同阻断 SMTP 头注入。

> 实现边界（如实说明）：`SmtpMailProvider` 已实现完整协议流程，但**从未对真实邮件服务器投递过**（运行使用 `console`，测试使用 `memory`）。见第 10 节。

#### 5.1.5 `DnsResolver`（`src/adapters/dns.ts`）

```ts
interface DnsResolver {
  readonly name: string;
  resolveTxt(domain: string): Promise<string[][]>;
}
```

实现：`SystemDnsResolver`（`node:dns/promises` 的 `resolveTxt`；查询失败与「没有记录」在业务上等价，一律返回 `[]`）、`FakeDnsResolver`（可 `setTxt()` 注入记录）。

**为什么存在**：方案第 6 阶段验收要求「完成域名所有权验证；未经验证的域名不能直接绑定」。验证手段是 DNS TXT 记录比对，因此 DNS 查询必须是可注入的 —— 否则整条验证流程在没有真实域名的环境里根本无法测试。配套的 `flattenTxtRecords()` 把 DNS 返回的分片记录拼回完整字符串（TXT 记录超过 255 字节时会被拆成多段）。

#### 5.1.6 `HostingProvider`（`src/adapters/hosting.ts`）

```ts
interface HostingProvider {
  readonly name: string;
  readonly allowsCustomDomain: boolean;
  resolvePublicUrl(slug, state: DomainBindingState): PublicUrlResult;
  verifyDomain(domain, token, state): Promise<DomainVerificationResult>;
}
```

实现：`DefaultHostingProvider`（`allowsCustomDomain = false`，始终返回平台默认地址）、`CustomDomainHostingProvider`（支持自定义域名，依赖注入的 `DnsResolver` 做验证）。

**为什么存在**：方案第 6 阶段要求「先支持平台默认发布地址，再逐步支持自定义子域名、域名绑定」。核心规则「未经验证的域名不能直接绑定」由 `resolvePublicUrl()` 的一处判断强制执行：

```
if (state.customDomain && state.domainVerifiedAt)  ->  https://<domain>/p/<slug>
else                                              ->  <PUBLIC_BASE_URL>/p/<slug>
```

配合 `bindDomain()` 在重新绑定时强制 `domainVerifiedAt = null`，以及域名唯一性检查（同一域名不能被绑到两个房源），这条规则在「忘记验证」「换域名」「抢域名」三种路径下都成立。`resolvePublicUrl()` 的返回值带 `kind` 与 `note`，`note` 是给用户看的中文解释（例如「自定义域名 X 尚未通过所有权验证，暂时使用平台默认地址。验证方式：在 … 添加 TXT 记录 …」）。

### 5.2 替换一个服务商，不得要求改动业务代码

这是适配层存在的意义所在，因此值得写成一条可检验的规则：

> **业务代码只允许通过 `ctx.adapters.<kind>` 使用外部能力，不允许出现具体实现的类型名、构造函数或服务商专有字段。**

**变更面**：切换服务商时**只应改两处** ——

1. `src/adapters/registry.ts` 中该 kind 的分支判断；
2. `.env` / `.env.example` 中对应的环境变量。

**不应改动的部分**（已核验，业务代码只引用接口类型）：`src/services/property-service.ts`、`media-service.ts`、`publish-service.ts`、`export-service.ts`、`reminder-service.ts`、`hosting-service.ts`、`backup-service.ts`、`src/render/page-renderer.ts`、`src/http/routes/*.ts`。

可验证的证据：

- `registry.ts` 是**唯一**出现 `new OsmMapProvider` / `new LocalStorageProvider` / `new SmtpMailProvider` / `new SystemDnsResolver` 的地方；
- `DisabledMapProvider` 与 `DefaultHostingProvider` 分别证明「地图可以整体关掉」与「托管可以退回默认地址」而不影响业务代码；
- `createAdapters()` 的 `overrides` 参数让测试直接替换实例（`tests/helpers/test-app.ts` 注入四个替身），无需改任何业务代码。

### 5.3 存储适配器必须同时承担媒体出口与备份读取

这是本项目最容易踩、也最值得写进说明书的一条约束。

**媒体出口**：`GET /media/*` **不**由 `@fastify/static` 直接指向磁盘目录，而是路由到 `ctx.adapters.storage.read(key)`（`src/http/app.ts`）。原因写在代码注释里：如果直接把 `UPLOAD_DIR` 挂成静态目录，那么一旦把 `STORAGE_PROVIDER` 换成对象存储，展示页上的所有图片会**静默 404** —— 页面能打开，只是图全没了，排查成本极高。走适配器后，换存储后端时媒体出口自动跟随。

路由上另有两道防线：拒绝空 key、含 `..`、含 `\0`、以 `/` 开头的 key；MIME 由扩展名白名单映射，未知类型降级为 `application/octet-stream`。

**备份读取**：`createBackup()` 通过 `listAllStorageKeys(db)` 取得数据库中引用到的全部存储键，再**逐个经 `ctx.adapters.storage.read(key)`** 读取并打包。两个后果：

1. 备份内容与媒体出口读的是同一份事实来源，不会出现「页面上有图、备份里没有」；
2. `read()` 返回 `null` 的键会被记入 manifest 的 `note`（「注意：有 N 个素材在存储中读取失败，未包含在备份内（…）」），**不静默丢弃**。

`LocalStorageProvider` 额外暴露一个 `get baseDir()`，仅供备份/恢复演练定位上传根目录使用；它不是 `StorageProvider` 接口的一部分，因此换成非本地实现时不会误用。

**这不是一条假设出来的约束，而是一个真实缺陷的教训。** 第 8 阶段的实现中，`/media/*` 曾经由 `@fastify/static` 直接挂载 `UPLOAD_DIR`，备份也曾经直接扫描上传目录。后果是：只要把 `STORAGE_PROVIDER` 换成对象存储（这正是适配层存在的目的），**展示页的图片会全部 404、备份会静默丢失全部素材**，而两条路径都不会报错。问题已修复（`docs/reports/phase-8-report.md` 的修订记录第 2 条），本节即修复后的约束。判断一个「可替换适配层」是否真的可替换，标准就是这类**旁路读取**是否已被消除。

---

## 6. 关键机制

### 6.1 唯一数据源（single source of truth）

**规则**：后台列表/详情、公开展示页、`/p/:slug/qr.svg`、静态导出、发布预览 —— 全部从同一份 `PropertyAggregate` 与同一套渲染函数生成（详见 4.12 节）。

**反例防线**（这些做法在本项目中被明确排除）：

- 展示页不落盘、不缓存 HTML（每次请求实时渲染），所以不存在「后台改了、页面还是旧的」；
- 导出不复用线上 URL 的抓取结果，而是直接调用同一个 `buildExportBundle()` → `renderListingPage()`；
- 模板只有一套（`src/render/templates.ts` 的 `getTemplate(id)`），线上与导出共用；
- 没有 `v2` / `legacy` 目录，没有第二套房源结构。

### 6.2 发布状态机

```
                    publish                withdraw
   unpublished ─────────────────> published ────────────────> withdrawn
                                     │  ▲                         │
                                     │  └─────────────────────────┘
                                     │        publish（重复发布）
                                     └── publish（幂等，允许 no-op）
```

`assertPublishTransition(current, next)`（`src/domain/listing-page.ts`）的允许表：

| 当前 | 允许迁往 |
| --- | --- |
| `unpublished` | `published` |
| `published` | `withdrawn`、`published`（自身，视为幂等 no-op） |
| `withdrawn` | `published` |

**重复操作是被允许的**：`published → published` 与 `withdrawn → published` 都合法，因此用户可以反复上下架（方案第 2、6 阶段验收均要求「发布和撤回可以重复操作」）。被禁止的是 `unpublished → withdrawn` —— 没发布过的东西谈不上撤下，报错文案为「发布状态不能从「未发布」直接变为「已撤下」」。

**发布前置检查**（`collectPublishReadiness()`）：

- **阻塞项（blockers）**：标题为空；地址信息（`addressLine` / `city` / `region`）全为空。任一存在即 `ready = false`，`publishListing()` 抛 422 并列出全部阻塞项。
- **提示项（warnings）**：没有照片；没有公开联系方式；展示语言尚无译文（会回退原文）。

把检查前移到「读取发布设置」接口，是为了让用户在点发布**之前**就看到缺什么，而不是失败后才猜。

**重新发布的副作用（需要向用户说明）**：`publishListing()` 用新的 `publishedAt` 重算提醒计划，`upsertReminder()` 会**重置**既有提醒的 `dueAt`。对「重新上架重新计时」这是合理行为，但后台界面目前没有提示用户（已知体验缺口）。

**公开访问判定**：`findPublicPage(ctx, slug)` 强制要求 `page.status === 'published'`，否则返回 `null`，路由层转 404 且使用与「不存在」**完全相同**的页面（`renderUnavailablePage`），不泄漏「该房源是否存在」。`/p/:slug/qr.svg` 与 `/p/:slug/nearby.json` 走同一判定。

### 6.3 提醒调度

**规则**：发布后第 7 天提醒检查房源，第 15 天提醒确认或更新（`REMINDER_DAY_1` / `REMINDER_DAY_2` 可配置）。

**生成**（`buildReminderPlan()` → `scheduleRemindersForPage()`）：

1. 以 `publishedAt` 为基准，在**工作区时区**的日历上分别加 7 天与 15 天（`addZonedDays`，跨夏令时保持当地时刻不变）；
2. 把时刻固定到当地 **09:00**（`zonedHourOfDay(instant, tz, 9)`），避免凌晨打扰；
3. 以 `idempotency_key = ${propertyId}:${kind}` upsert 两条记录，`timezone` 列写入当时的时区。

**投递判定**（`decideDispatch()` 纯函数，返回 `'send' | 'retry-later' | 'give-up' | 'skip'`）：

| 条件 | 结果 |
| --- | --- |
| 状态为 `completed` 或 `skipped` | `skip` |
| 未到期（`dueAt > now`） | `skip` |
| 当前不在允许发送的**当地时段**（默认 09:00–20:00，含跨午夜处理） | `retry-later` |
| `attempts >= maxAttempts`（默认 3） | `give-up` |
| 上次失败且仍处于指数退避窗口内 | `retry-later` |
| 以上都不满足 | `send` |

**不重复轰炸用户的四重保证**：

1. **结构层**：`idempotency_key` 唯一索引 + 发布时 upsert → 同一房源同一类型只有一条记录；
2. **状态层**：投递成功后提醒离开 `pending`，重复扫描时 `listDueReminders()` 不再返回它；
3. **策略层**：指数退避（1 分钟 → 2 → 4 → … 上限 6 小时，`retryDelayMs()`）、最大尝试次数、发送时段限制；
4. **业务层**：**展示页已撤下或未发布时自动 `skip`**（`markSkipped()`），房源已删除时同样关闭 —— 用户撤下页面后不会再收到「请检查房源」的邮件。

**收件人解析**（`resolveRecipient()`）：`REMINDER_RECIPIENT` 优先 → 其次工作区 `users` 表中 `role = 'owner'` 的邮箱 → 两者都为空时返回空串，投递报告写入 `recipientWarning` 并把该次投递记为失败。**不会静默成功**。

**投递入口**：

- 进程内定时器：`src/server.ts` 中 `setInterval(dispatchDueReminders, REMINDER_DISPATCH_INTERVAL_MINUTES * 60s)`，`timer.unref()` 不阻塞退出，`SIGINT`/`SIGTERM` 时清理；
- 手工触发：`POST /api/admin/reminders/dispatch`（后台「立即投递」按钮）；
- 返回 `DispatchReport`：`{ at, considered, sent, failed, gaveUp, skipped, retryLater, details[], recipientWarning }`。

**时间颗粒度风险（如实说明）**：`REMINDER_DISPATCH_INTERVAL_MINUTES` 默认 60 分钟，即提醒的实际送达时间可能在计划时刻后 0–60 分钟。这不影响「第 7/15 天」的语义（当天送达），但不是精确定时。

> 补充说明：提醒投递共有三个入口 —— 上面的进程内定时器、`POST /api/admin/reminders/dispatch`（后台「立即投递」按钮），以及 `pnpm reminders`（`scripts/run-reminders.ts`：加载配置后打印业务时间、时区、收件人与邮件适配器名，再调用 `dispatchDueReminders()` 并输出「扫描 N 条：发送/失败/停止重试/跳过/稍后重试」与逐条明细）。三者共享数据库状态，投递成功后提醒离开 `pending`，因此并行触发不会重复发送；但它们之间**没有锁或租约**，多实例并发扫描依赖 SQLite 的单写者特性兜底。

### 6.4 静态导出

`buildExportBundle()` 在内存中构建一个文件列表，用于「目录导出」与「ZIP 下载」两种交付形式。

**产物结构**

```
index.html                  默认语言页面
index.<tag>.html            其它语言页面（每种语言一个文件）
README.txt                  离线说明 + 默认语言 + 语言文件清单 + 分享链接 + 导出时间
share-url.txt               纯分享链接
assets/<storageKey>         全部上传媒体（原样字节）
导出包**不含**独立清单文件（`manifest.json` 只属于备份归档，见实施计划第 8 阶段）。
```

**六条与验收项直接对应的设计决定**：

1. **相对资产路径**：渲染后的 HTML 统一做 `replaceAll('/media/', 'assets/')`。因为媒体文件正好以 `assets/<storageKey>` 落盘，所以 `index.html` 与图片的相对位置天然一致。导出目录里不存在任何 `/media/` 字符串。
2. **每种语言一个 HTML 文件**：`index.html` 为默认语言，其余为 `index.<语言>.html`；语言栏链接由 `LocaleLink.href` 显式指到对应本地文件（在线页面则用 `?lang=<tag>`）。因此**离线状态下语言切换仍然可用**。
3. **不出现死链**：导出时 `interactive: false`，渲染器据此**不输出**「查看周边信息」的 `?nearby=1` 链接 —— 该查询需要服务端在线，离线导出里保留它就是一个点不开的按钮。`README.txt` 明确写出这条原因。
4. **二维码内联为 SVG**：`includeQr: true`，二维码由 `qrcode-generator` 生成矩阵后自行渲染成内联 `<svg>`，不引用任何图片文件，离线可显示、可扫描。
5. **地图降级有文档**：`includeMapScript: false`，渲染器走到 `mapOffline` 分支，输出「当前未加载在线地图（离线导出或未注入脚本），可复制上方经纬度到任意地图应用查看。」`README.txt` 首条即「离线打开说明」，并另有「地图：离线环境下在线地图瓦片无法加载，页面会自动降级为显示地址文本与经纬度。」
6. **无外部依赖**：只使用系统内置字体（CSS 中 `font-family` 全为 `-apple-system` / `Segoe UI` / `PingFang SC` / `Microsoft YaHei` 等系统字体），不引用在线字体；样式内联在 `<style>` 中。

**其他实现细节**：ZIP 为自研最小实现（`src/util/zip.ts`），使用 **STORE 方法（不压缩）**，因此导出包体积接近素材原始体积之和；中文文件名使用 UTF-8 标志位，HTTP 下载头使用 RFC 5987 编码（`filename*=UTF-8''…`）并附 ASCII 回退名。导出到服务器目录时有路径越界校验（写出目标必须位于 `outDir` 之内）。
---

## 7. 安全设计

### 7.1 鉴权与会话

**单口令 + HMAC 签名会话 Cookie**（`src/http/security.ts`、`src/http/routes/admin-auth.ts`）：

- 会话令牌结构为 `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`，payload 含 `iat` / `exp` / `role`；
- 口令比较使用**恒定时间比较** `timingSafeEqual()`。实现细节值得记录：先把两个缓冲区补齐到相同长度再调用 `node:crypto` 的 `timingSafeEqual`，最后再比较原始长度。这样即使长度不同也不会因提前返回而泄漏长度信息。
- 会话校验同样用恒定时间比较签名，`exp <= now` 即失效；
- Cookie 属性：名 `admin_session`、`path=/`、`httpOnly: true`、`sameSite: 'lax'`、`maxAge` = 12 小时（`SESSION_TTL_MS`）、`secure` 取值取决于 `PUBLIC_BASE_URL` 是否以 `https://` 开头（这是「生产环境必须用 https」这条配置校验的第二个作用）。

**统一鉴权钩子**：`app.ts` 的 `onRequest` 钩子对所有 `/api/admin/*` 路径做会话校验，例外只有白名单里的两个路径 `POST /api/admin/login` 与 `GET /api/admin/session`。**默认拒绝**（default deny）：新增后台接口不需要记得加保护。

**工作区归属校验**：会话本身不区分用户，但业务层仍然检查实体归属 —— `requireProperty()` / `requireMedia()` / `requireReminder()` 会验证实体属于 `ctx.workspace.id`，跨工作区访问返回 404（不是 403，避免泄漏实体存在性）。这条在多工作区场景下有实际意义，也为将来的多租户预留了正确的默认行为。

### 7.2 登录限流

`LoginRateLimiter`（进程内存态）：默认 **5 次失败 / 15 分钟窗口 / 触发后封禁 15 分钟**，按 `request.ip` 计数（`buildApp` 启用 `trustProxy: true`，反向代理后仍能拿到真实 IP）。返回 429 并给出中文剩余时间提示「登录尝试过于频繁，请 N 分钟后再试」。

- 仅**失败**计数，成功登录 `recordSuccess()` 清零；
- `prune(now)` 定期清理过期条目，避免内存无限增长；
- `size` getter 供测试观测条目数。

**已知局限**（如实说明）：状态在进程内存中，**重启即清空**，多实例之间不共享；公开页没有任何速率限制或防抓取措施。

### 7.3 真实时间与业务时钟的分离

这是本项目一条容易写错、因此在两处代码注释里都写明的纪律：

| 用途 | 时间来源 | 代码位置 |
| --- | --- | --- |
| 会话签发与过期 | **真实时间** `new Date()` | `src/http/routes/admin-auth.ts`、`src/http/app.ts` |
| 登录限流窗口 | **真实时间** `new Date()` | `src/http/routes/admin-auth.ts` |
| 发布时刻、提醒计划与投递、导出时间戳、备份文件名 | **业务时钟** `ctx.adapters.clock.now()` | `src/services/*`、`src/render/*` |

**原因**：演示与验收用的「时间旅行」（`DEV_TIME_TRAVEL=true`）会把业务时钟直接推到第 7/15 天。如果会话有效期也读业务时钟，那么一点「+15 天」按钮，管理员就会被立刻登出，演示无法继续。反之，如果提醒计划读真实时间，就永远无法在不等待 7 天的情况下验证规则。

**边界**：`devTimeTravel` 在 `src/config.ts` 中被硬性限制为 `env !== 'production' && DEV_TIME_TRAVEL === 'true'`，因此在生产配置下该能力**不可能**开启；`POST /api/admin/dev/advance-time` 在 `ctx.travelClock === null` 时返回 403 并提示如何启用。

### 7.4 CSP nonce 策略与地图页的 style-src 放宽

CSP 由 `contentSecurityPolicy({ nonce, allowExternalScripts, allowInlineStyles })` 生成，每次请求创建新的 nonce（`createNonce()` = 16 字节随机数的 base64）：

```
default-src 'self';
script-src 'self' 'nonce-<nonce>';
style-src 'self' 'nonce-<nonce>';          # 后台与其它页面
img-src 'self' data: https:;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none'
```

配套响应头（`securityHeaders()`）：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy: geolocation=(), microphone=(), camera=()`、`Cross-Origin-Opener-Policy: same-origin`。所有 `/api/*` 响应额外加 `Cache-Control: no-store`。

**`script-src` 始终严格**：没有 `unsafe-inline`，没有外部脚本源。页面里的两段脚本（地图初始化、图集切换）都带 `nonce` 属性；Leaflet 从同源 `/vendor/leaflet/leaflet.js` 加载，因此 `'self'` 就够，不需要放行任何 CDN。

**`style-src` 在公开展示页被刻意放宽为 `'self' 'unsafe-inline'`**，原因必须在说明书里写清楚，否则后来者会以为是疏漏：

> **Leaflet 通过 `style` 属性定位每一个瓦片与标记**（`transform: translate3d(...)` 等），这些是运行时写入的行内样式，无法加 nonce，也无法预先声明。要让地图能显示，`style-src` 必须允许 `unsafe-inline`。

而且**nonce 与 `unsafe-inline` 不能共存于同一个指令**：按 CSP 规范，一旦某指令中出现 nonce（或 hash），浏览器会**忽略**同一指令里的 `unsafe-inline`。因此实现里两者是**互斥**的：

```
styleSrc = allowInlineStyles
  ? "'self' 'unsafe-inline'"          # 公开页：去掉 nonce，保留 unsafe-inline
  : nonce
    ? `'self' 'nonce-${nonce}'`       # 其它页面：严格 nonce
    : "'self'";
```

`allowInlineStyles` 的取值条件是 `request.url.startsWith('/p/')`（`app.ts` 的 `onSend` 钩子），即**只有公开展示页**放宽。这带来一个必须遵守的约束：

> **展示页渲染器不得输出任何内联 `style` 属性。** `page-renderer.ts` 头部的注释明确写出这一点（「不输出任何内联 style 属性（CSP 只放行带 nonce 的 `<style>`/`<script>`）」）。放宽 `style-src` 是为了第三方地图库，不是为了让自己的模板偷懒；模板样式全部写在带 nonce 的 `<style>` 块里。

**后台预览页使用与公开展示页完全一致的 CSP。** 预览页（`GET /api/admin/properties/:id/preview`）渲染的是同一个 `renderListingPage()`，也注入内联脚本与地图，因此必须走同一套 nonce 策略，否则 CSP 会把预览页的交互与地图全部拦掉。实现方式是把「含地图的页面」判定从一个路径前缀扩展为一个正则：

```
const isMapPage =
  request.url.startsWith('/p/') || /\/api\/admin\/properties\/[^/]+\/preview(\?|$)/.test(request.url);
```

预览页额外声明 `X-Robots-Tag: noindex`，但**不再单独设置 CSP**（由全局 `onSend` 钩子统一设置）。

**`GET /api/admin/properties/:id/export-preview` 仍单独收紧 CSP 为 `default-src 'self' data:`**，因为它返回的是**静态导出形态**的 HTML（`includeMapScript: false`，不含地图脚本与交互脚本），既不需要 nonce，也不应允许脚本执行。

**降级行为**：地图脚本在 `!window.L` 时把地图容器替换为降级提示（`mapFailed` 文案），瓦片层连续 `tileerror` 且零成功时也会 `map.remove()` 并降级 —— 宁可显示地址文本，也不留一张空白地图。降级文案不依赖任何外部资源。

### 7.5 上传校验（魔数 + 扩展名交叉核对）

`validateUpload()`（`src/domain/media.ts`）把上传校验收敛成一个纯函数，输入为文件名、声明 MIME、**真实** MIME、字节数、已有照片数与策略上限。五个判据：

1. **文件名非空**，且扩展名在白名单内（`.jpg` / `.jpeg` / `.png` / `.webp` / `.gif` / `.mp4` / `.webm` / `.mov`）；
2. **按文件头（魔数）判定真实类型**（`sniffMimeType()`），识别不了就拒绝。识别规则：JPEG `FF D8 FF`；PNG `89 50 4E 47 0D 0A 1A 0A`；GIF `47 49 46 38`；WebP `RIFF????WEBP`；MP4/MOV 第 4–7 字节 `ftyp`（brand 以 `qt` 开头判为 MOV）；WebM/Matroska `1A 45 DF A3`；
3. **扩展名与实际内容交叉核对**：不一致即拒绝，文案为「文件扩展名与实际内容不一致（扩展名暗示 X，实际为 Y）」；
4. **浏览器声明的 MIME 与真实类型交叉核对**：不一致即拒绝（不信任客户端）；
5. **大小与数量上限**：照片受 `MAX_UPLOAD_BYTES`（默认 15 MB）与 `MAX_PHOTOS_PER_PROPERTY`（默认 30）约束，视频受 `MAX_VIDEO_BYTES`（默认 200 MB）约束，空文件拒绝。

全部问题**一次性返回**（`FieldIssue[]`），而不是逐条报错。存储键由服务端生成（4.7 节），因此用户文件名不参与路径构造。

**多部分请求上限**（`@fastify/multipart`）：`fileSize = max(maxUploadBytes, maxVideoBytes)`、`files: 1`、`fields: 20`；Fastify 层 `bodyLimit: 2 MB`。超限由 `app.setErrorHandler` 转成 413「上传文件超过大小限制」+ 字段级提示「文件过大，请压缩后重试」。

**外部视频链接**只允许 `http:` / `https:`（`validateExternalVideoUrl()`），阻断 `javascript:` / `data:`。渲染时外部视频**只以普通链接呈现**（`target="_blank" rel="noopener noreferrer nofollow"`），**不用 iframe** —— 避免把不可控的第三方内容嵌入自己的页面。

**已知缺口**：上传字节原样保存，**不做图像压缩、缩略图或 EXIF 剥离**。手机照片可能携带 GPS 定位信息，公开后可能泄漏拍摄位置；列表与展示页也直接加载原图。

### 7.6 密钥处理（数据库只存环境变量名）

三层纪律：

1. **密钥只从环境变量读取**（`src/config.ts` 的 `str()` / `int()`）。`.env` 由极简解析器 `loadDotEnv()` 读取，且**只在变量尚不存在时写入**，因此真实环境变量优先级更高，便于容器/CI 覆盖。
2. **数据库只存密钥的「环境变量名」**（`external_service_configs.secret_refs_json`），不存密钥本体；`PUT /api/admin/external-services` 主动拒绝键名疑似密钥的字段（见 4.10 节）。
3. **对外输出一律脱敏**：`redactedConfig()` 把密钥位映射为「已设置 / (未设置)」；`/healthz` 与 `/api/admin/diagnostics` 只返回该快照；`src/util/logger.ts` 对敏感键名自动脱敏；未处理异常只写服务端日志（含 URL、方法、消息、堆栈前 6 行），给客户端只回一句「服务器内部错误，请稍后重试或联系管理员」。

**启动即拒绝的危险配置**（`validateConfig()`，仅 `NODE_ENV=production`）：`ADMIN_PASSWORD` 仍为示例默认值 `change-me-in-production`；`ADMIN_PASSWORD` 长度 < 12；`SESSION_SECRET` 仍以 `please-generate` 开头；`SESSION_SECRET` 长度 < 32；`PUBLIC_BASE_URL` 以 `http://` 开头。此外无论环境如何都校验：`PORT` 范围、`REMINDER_DAY_1 < REMINDER_DAY_2`、`MAX_UPLOAD_BYTES > 0`、`DEFAULT_TIMEZONE` 是有效 IANA 时区。**任一项不满足直接抛错并退出**，不进入半启动状态。

`.env`、`var/`（数据库、上传、备份、日志）均在 `.gitignore` 中排除。

### 7.7 输出转义

三个工具函数（`src/render/html.ts`）覆盖全部动态内容输出：

- `escapeHtml(value)`：转义 `& < > " '` 五个字符；
- `escapeAttribute(value)`：在 `escapeHtml` 基础上再把 `\r\n` 替换为空格，防属性换行注入；
- `safeUrl(value)`：`http:` / `https:` 放行；其它带协议的 URL（`javascript:`、`data:` 等）一律返回空串；相对路径放行但拒绝以 `//` 开头的协议相对 URL。

`safeUrl` 是**白名单**（先判协议是否在允许集合内），不是黑名单，因此不会因为遗漏某个危险协议而失效。

**渲染层对管理员录入的内容同样转义**。理由写在 `html.ts` 的注释里：管理员账号一旦被接管，未转义的字段就是**存储型 XSS**。所有字段（标题、描述、地址、附加费用、联系方式、周边地名）一律经 `escapeHtml`；所有 URL（图片、视频、外部链接、语言栏 href）经 `safeUrl` + `escapeAttribute`。页面中传给脚本的数据用 `jsonForScript()`（转义 `<` `>` `&` 与 U+2028/U+2029），阻断 `</script>` 逃逸。

`tests/integration/public-page.test.ts` 中有一条用例专门验证「页面内容对 HTML 特殊字符做转义（防存储型 XSS）」。

### 7.8 错误处理与信息泄漏

`app.setErrorHandler` 把错误分成三类：

| 类别 | 处理 |
| --- | --- |
| `DomainError`（`isDomainError` 判定） | 按其 `httpStatus` 返回 `{ error: { code, message, issues[] } }`，`message` 与 `issues[].message` 均为面向用户的中文 |
| `FST_REQ_FILE_TOO_LARGE` | 413 + 「上传文件超过大小限制」 |
| 带 `validation` 字段的框架错误 | 400 + 「请求参数格式不正确」 |
| 其它 | 记服务端日志（含堆栈前 6 行），客户端只收 500 + 「服务器内部错误，请稍后重试或联系管理员」 |

`setNotFoundHandler` 区分 `/api/*`（结构化 404 JSON）与页面请求（中文 404 HTML，附「返回管理后台」链接）。公开页的 404 与「已撤下」共用同一个 `renderUnavailablePage()` 输出，**不区分「不存在」与「未发布」**，避免通过响应差异枚举出未发布的房源。

---

## 8. 时区与国际化

### 8.1 无依赖的 IANA 时区换算（两遍法修正夏令时）

`src/util/time.ts` 用 `Intl.DateTimeFormat` 的 `formatToParts` 自行实现时区换算，**不引入 `luxon` / `date-fns-tz` / `moment-timezone` 等库**。理由有三：避免额外依赖与许可证义务；避免时区数据库版本与应用版本脱钩（直接用 Node 自带的 ICU 数据）；提醒规则的边界行为需要被单元测试直接覆盖。

提供的函数：

| 函数 | 作用 |
| --- | --- |
| `assertTimeZone(tz)` | 非法时区抛可读错误（`无效的 IANA 时区：X`） |
| `toZonedParts(instant, tz)` | 瞬间 → 目标时区日历字段；**把 Intl 在 `hour12: false` 下可能返回的 `24` 归零为 `0`**（午夜） |
| `fromZonedParts(parts, tz)` | 墙上时间 → 瞬间（含夏令时二次修正） |
| `addZonedDays(instant, days, tz)` | 在目标时区日历上加天数，**保持当地时刻不变** |
| `startOfZonedDay(instant, tz)` | 目标时区当天 00:00 对应的瞬间 |
| `zonedHourOfDay(instant, tz, hour)` | 目标时区当天某整点对应的瞬间（提醒固定在 09:00 用它） |
| `formatZoned(instant, tz, locale, opts)` | 按目标时区格式化，用于日志与后台展示 |

**两遍法（two-pass）的原理**：墙上时间到瞬间的映射不是单值函数 —— 夏令时切换当天，某些墙上时间不存在（春季跳表）或出现两次（秋季回拨）。

```
fromZonedParts(parts, tz):
  asUtc        = Date.UTC(parts...)            # 先把墙上时间当成 UTC
  firstOffset  = offsetMsAt(asUtc, tz)         # 用估算点求偏移
  refined      = asUtc - firstOffset
  secondOffset = offsetMsAt(refined, tz)       # 用修正后的点再求一次偏移
  return secondOffset === firstOffset ? refined : asUtc - secondOffset
```

第一遍给出一个近似解，第二遍在正确的日期上重新取偏移；若两次偏移不同（说明第一遍落在了切换的另一侧），则用第二次的偏移重算。`offsetMsAt()` 内部还会把瞬间截断到秒，避免 Intl 的秒级精度造成抖动。

配套的领域规则：`buildReminderPlan()` 先 `addZonedDays(publishedAt, 7, tz)` 再 `zonedHourOfDay(shifted, tz, 9)` —— 因此「第 7 天当地上午 9 点」在跨夏令时的发布周期里仍然成立。`tests/util/time.test.ts` 有 11 条用例专门覆盖这些边界（午夜 0 vs 24、往返一致、跨夏令时两个方向、跨月跨年、非法时区）。

### 8.2 UI 词条目录与回退链

界面文案不是硬编码在渲染函数里的字符串，而是集中在 `src/domain/i18n.ts` 的 `UI_CATALOGS`。`UiKey` 是一个字符串联合类型（约 60 个键），`UiCatalog = Record<UiKey, string>`，因此**漏翻译一个键会在类型检查阶段暴露**；另有一条单元测试「各语言词条键集合完整，不存在遗漏」。

**两条独立的回退链**：

| 对象 | 回退链 | 实现 |
| --- | --- | --- |
| 房源正文（标题/描述） | 精确语言 → 语言族（`zh-CN` 命中 `zh`）→ 原文 | `resolveLocalizedText()` |
| 界面文案 | 精确语言 → 语言族 → 英文 → 中文 → 键名本身 | `uiCatalog()` / `t()` |

「不会出现空白文案」是这条设计的目标：最坏情况显示键名，而不是空白。

`t(locale, key, vars)` 支持 `{var}` 占位替换，未提供的变量保留原样 `{name}` 而不是变成 `undefined`。

**刻意做成「字典 + 原样回退」的字段**（因为它们的取值集合是用户可配置的，不能被平台写死）：

- `propertyTypeLabel(value, locale)`：`apartment` / `house` / … 命中字典时翻译，**未知值原样显示**；
- `contactChannelLabel(kind, locale)`：`phone` / `wechat` / `whatsapp` / … 翻译，未知渠道回退到「联系方式 / Contact」；
- `nearbyCategoryLabel(category, locale)`：周边分类同理。

**RTL**：`/^(ar|he|fa|ur)/i` 命中时在 `<html>` 上加 `dir="rtl"`（代码级实现，无视觉验证）。

### 8.3 格式化：货币、面积、日期

| 函数 | 行为 |
| --- | --- |
| `formatMoney(amount, currency, locale)` | `Intl.NumberFormat` 的 `style: 'currency'`；整数金额不显示小数位；**非法币种代码不抛错**，降级为「数字 + 代码」 |
| `formatArea(value, unit, locale)` | 数字 + 单位标签（`平方米` / `平方公尺` / `m²` / `㎡` / `sq ft` / `平方英尺`） |
| `formatPrice(amount, currency, period, locale)` | 金额 + 周期词（`total` 不拼周期，其余拼「/ 每月」「per month」等） |
| `formatDateOnly(iso, locale, timeZone)` | 只渲染日期（见 8.4 节） |

单位标签表 `AREA_LABELS` / `PERIOD_LABELS` 覆盖 `zh-CN` / `zh-TW` / `en` / `ja` / `ko`，并按「精确语言 → 语言族 → 英文 → 原值」回退。

### 8.4 已知不一致：`formatDateOnly` 会忽略时区参数

```ts
export function formatDateOnly(iso: string, locale: string, timeZone: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',      // <-- 硬编码，第三个参数 timeZone 未被使用
    dateStyle: 'long',
  }).format(date);
}
```

签名与注释声称「按目标时区渲染」，实现却硬编码 `timeZone: 'UTC'`，第三个参数**未被使用**（`src/render/page-renderer.ts` 调用时仍传入了 `input.workspace.defaultTimezone`，因此调用方看不出异常）。

**为什么不影响当前功能**：唯一调用点是「可入住日期」，而 `available_from` 在数据库里只存日期部分（4.4 节）。把 00:00Z 按 UTC 格式化，得到的正是输入的那一天，这在语义上是正确的选择。

**为什么仍要登记为问题**：签名与实现不一致会误导后来者。若将来把含时刻的值传给这个函数（例如「发布于」），结果会与实际时区差一天或几小时。修复方向是二选一：删除第三个参数并把函数改名为 `formatCalendarDate(iso, locale)`，或者真正实现 `timeZone` 支持。`tests/domain/i18n.test.ts` 中已有一条用例「日期按目标时区渲染且不受本地时区影响」锁定了当前行为，因此修复时会立刻被发现。
---

## 9. 测试策略

测试分三层，外加真实浏览器验证。三层的目的不同：领域层锁住规则，服务层锁住编排与失败路径，端到端层锁住真实用户路径不被前两层遗漏。

### 9.1 三层结构

**第一层：领域单元测试**（`tests/domain/`、`tests/util/`）—— 纯函数，无 IO，无数据库

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/domain/property.test.ts` | 15 | 字段级校验：空标题、超长截断、非数字/负价格、币种大小写与 3 位约束、国家代码 2 位、经纬度成对与范围、日期合法性、面积单位与状态白名单、描述保留换行、PATCH 语义、多字段错误一次性返回 |
| `tests/domain/media.test.ts` | 17 | 魔数识别、无法识别返回 null、照片/视频区分、伪装 PNG 被拒、扩展名不一致被拒、声明类型不一致被拒、大小与数量上限、不支持扩展名、危险视频协议、重排不丢条目、封面唯一性 |
| `tests/domain/listing-page.test.ts` | 19 | 中文 slug 生成、英文可读 slug、标点与 emoji 折叠、长度限制不截断代理对、slug 冲突候选、发布状态迁移规则（未发布不能直接撤下）、就绪检查的阻塞项与提示项、域名格式与子域名保留字、未验证域名不生效 |
| `tests/domain/reminder.test.ts` | 14 | 计划生成、当地 09:00、按当地日历相隔 7/15 天、时区影响时刻、天数可配置、未到点不发送、深夜推迟、已完成/已关闭不再发送、达到上限放弃、指数退避封顶 6 小时、幂等键稳定 |
| `tests/domain/i18n.test.ts` | 15 | 译文命中与回退（含语言族）、译文标题为空视为未翻译、金额格式化与非法币种降级、价格周期拼接、面积单位不写死公制、日期渲染、房型字典翻译与未知值保留、文案占位替换、各语言词条键集合完整 |
| `tests/util/time.test.ts` | 11 | 瞬间↔日历字段双向往返、午夜 0 而非 24、跨夏令时两个方向保持当地时刻、跨月跨年、`zonedHourOfDay`、`startOfZonedDay`、非法时区、`formatZoned` |
| `tests/util/zip.test.ts` | 7 | crc32 标准向量、打包解包往返、中文文件名 UTF-8 标志位、空归档、非 ZIP 数据被拒、损坏归档被拒、大二进制完整性 |

**第二层：适配器契约与服务/集成测试**（带注入替身）—— 真实数据库（临时目录）、真实 Fastify 实例、替身适配器；`tests/adapters/map.test.ts` 是唯一直接测适配器实现的文件（用注入的 `fetchImpl` 与 `MemoryStorageProvider`），其余适配器通过服务层与集成层间接覆盖。

`tests/helpers/test-app.ts` 的 `createHarness()` 为每个用例创建独立临时目录与 SQLite 文件，注入 `FakeClock`（可任意拨动）、`MemoryStorageProvider`、`MemoryMailProvider`、`FakeDnsResolver`，并把域名托管设为 `custom_domain`、提醒收件人设为 `owner@example.com`，从而让**没有真实文件系统、没有真实网络、没有真实域名**也能驱动完整流程。`devTimeTravel` 在此为 `false`，时间完全由 `clock.set()` 控制。

| 文件 | 用例数 | 覆盖内容 |
| --- | --- | --- |
| `tests/services/property-service.test.ts` | 12 | 读后即存、重复录入提示、PATCH 只改变化字段、审计、跨工作区 404、归档过滤、中文搜索与 `%`/`_` 转义、复制房源、级联删除、聚合读取 |
| `tests/services/media-service.test.ts` | 11 | 上传写存储并入库、首张自动封面、伪装文件不落盘、封面唯一、视频不能当封面、删除素材同时删文件并补选封面、重排不丢条目、外链规范化、危险协议、来源说明、跨工作区拒绝 |
| `tests/services/publish-service.test.ts` | 13 | 自动建页与中文 slug、重复调用幂等、slug 冲突加序号、占用 slug 被拒、缺标题/地址不可发布、发布后可见与撤下不可见、页面与后台一致、只渲染公开联系方式、发布生成提醒且重复发布不新增、发布撤下反复执行、改 slug 更新地址、发布总览、就绪提示 |
| `tests/services/reminder-service.test.ts` | 12 | 计划时刻、当天不发、第 7 天发一次、第 15 天发第二次、深夜推迟、撤下后自动关闭、标记完成/关闭、重新启用、失败重试到上限、未配置收件人不静默成功、跨工作区拒绝、配置来自环境变量 |
| `tests/services/export-service.test.ts` | 8 | 包含页面/说明/素材、相对路径且不引用后台、二维码内联 SVG、导出不注入地图脚本、多语言多文件互链、ZIP 可解包且文件名带日期、导出到目录真实写盘、未发布也可导出、导出内容随房源修改同步更新 |
| `tests/services/hosting-service.test.ts` | 13 | 默认地址、绑定后仍用默认地址、无 TXT 失败、值不匹配失败、匹配通过并切换域名、多段 TXT 拼接、重新绑定需重新验证、解绑回默认、域名被占用、非法域名、未绑定不能验证、子域名建议、中文 slug 回退标签 |
| `tests/services/backup-service.test.ts` | 9 | 归档含快照+素材+manifest、逐表行数一致、恢复演练还原且不影响运行库、素材内容一致、篡改被发现、不存在文件可读报错、越界路径被拒、列表倒序、按保留天数清理 |
| `tests/services/i18n-service.test.ts` | 10 | 保存译文原文不变、重复保存为更新、多语言共存、拒绝同语言覆盖原文、空译文被拒、非法语言标签、删除不影响原文、删除不存在返回 false、语言链接集合、跨工作区拒绝 |
| `tests/integration/api-properties.test.ts` | 11 | 未登录 401、登录后增删改查、非法输入 400 与字段级中文、PATCH 局部更新、中文搜索与状态筛选、不存在返回 404、归档与删除链路、概览统计、`/healthz` 无需鉴权、未知接口结构化 404、上传合法/伪装/超限 |
| `tests/integration/public-page.test.ts` | 11 | 未发布 404 不泄漏存在性、发布后含标题/价格/地址/二维码、修改后立即同步、撤下即不可访问再发布又可见、`?lang=en` 显示译文且原文仍在、语言链接只列可用语言、只出现公开联系方式、二维码接口、未发布二维码 404、HTML 特殊字符转义（防存储型 XSS）、照片出现在 `/media` 路径 |
| `tests/integration/export.test.ts` | 7 | 未登录不能下载、ZIP 可解包含页面与素材、导出到目录返回真实路径、导出预览可渲染、未发布也可导出、不存在 404、多语言导出多文件 |
| `tests/integration/security.test.ts` | 16 | 公开页 CSP 用 nonce 且脚本无 `unsafe-inline`、含地图页面允许内联样式但不放宽脚本、预览页 CSP 与公开页一致、后台不放宽内联样式、统一安全响应头、后台不缓存、登录限流、退出登录后会话失效、伪造 Cookie 被拒、过期会话被拒、诊断接口不泄露密钥、媒体路径穿越被拒、`nosniff` + 正确 `Content-Type`、错误响应不含堆栈、超长请求体被拒、外部服务配置拒绝疑似密钥字段 |
| `tests/adapters/map.test.ts` | 20 | 地图视图含坐标且不含密钥、无坐标降级、关闭地图保留地址、周边服务失败/限流/网络异常均降级不抛错、按距离排序并解析分类、命中缓存不重复请求、超时降级、haversine 量级、存储键拒绝穿越与非法段、路径必须落在存储根内、内存存储读写删一致、收件人非法或含换行被拒、RFC 2047 中文主题与 base64 正文、内存邮件记录、可控时钟语义、系统时钟不支持时间旅行、假 DNS 分片拼接 |

**第三层：端到端冒烟**（`scripts/smoke.ts`，`pnpm smoke`）

用 Fastify 的 `app.inject()` 在进程内跑真实 HTTP 链路，覆盖 10 个分组共 **73 项断言**：

| 分组 | 内容 |
| --- | --- |
| 【1】健康检查与鉴权 | `/healthz` 200 且含迁移 1；未登录 401；错误口令 401；正确口令 200 且下发 `admin_session` 前缀 Cookie |
| 【2】房源录入与校验 | 空标题 400 且 `issues[].field === 'title'`；创建 201；列表 `total = 1`；中文搜索命中；不存在 404 |
| 【3】照片上传与安全校验 | 真实 1×1 PNG（含真实文件头）201 且首张 `isCover = true`；文本伪装 PNG 被拒 400 |
| 【4】一键生成展示页 | 自动生成 slug；就绪检查通过；返回二维码 SVG；未发布 404；发布 200；页面含标题/价格/内联 SVG/联系方式；CSP 含 `nonce-`；改价后页面同步为 9,200 |
| 【5】多语言与原文保护 | 保存英文译文 201；英文页显示译文；原文含「近地铁 2 号线」未被覆盖；译文独立保存 `length = 1`；同语言覆盖被拒 400 |
| 【6】第 7/15 天提醒（可控时间） | 生成 2 条（`delta = 7.349 天` / `15.349 天`）；时区为 `Asia/Shanghai`；D7 时刻 `2026-10-20T01:00:00.000Z`（当地 09:00）；第 0/6 天不发；到期前不发；第 7 天发 1 次且为 `check_day_7`；重复扫描发 0；第 15 天发 1 次且为 `confirm_day_15`；D15 已记录完成 |
| 【7】静态 HTML 导出 | ZIP 200 且 `application/zip`；含 `index.html`、`README.txt`、`assets/…`；用自带 `readZip` 可解出条目；页面含 `assets/` 且**不含** `/media/`；不含 `/api/admin/` |
| 【8】备份与恢复演练 | 创建 201（实测 168,891 字节，manifest 为 `workspaces 1 / users 1 / properties 1 / property_translations 1 / contacts 0 / media 1 / listing_pages 1 / reminders 2 / external_service_configs 0 / audit_logs 16`，`mediaFiles = 1`）；校验 `ok = true`；恢复演练 200；恢复后 `properties = 1`、媒体文件 ≥ 1、`reminders = 2` |
| 【9】撤下与重复操作 | 撤下 200；撤下后 404；可重复发布 200；可重复撤下 200 |
| 【10】归档与级联删除 | 归档 200 且 `status = archived`；默认列表 `total = 0`；`includeArchived=true` 时 `total = 1`；删除 200；删除后 404；删除后提醒列表为 0 |

冒烟脚本使用独立临时目录（`mkdtempSync(tmpdir(), 'pl-smoke-')`）与覆盖后的配置（`env: 'test'`、独立数据库/上传/备份目录、显式口令与会话密钥、`devTimeTravel: true`），**不污染 `var/` 下的真实数据**。任何一项断言失败会抛出并写入 `failed` 列表，最终以退出码 1 结束。

**安全测试的覆盖情况**：`tests/integration/security.test.ts` 现有 **16 条用例**，覆盖公开页 CSP 使用 nonce 且脚本不允许 `unsafe-inline`、含地图的公开页允许内联样式但不放宽脚本、后台预览页与公开页 CSP 一致、后台接口不放宽内联样式、统一安全响应头、后台接口不缓存、登录失败限流、退出登录后会话失效、伪造会话 Cookie 被拒、过期会话被拒、诊断接口不泄露密钥明文、媒体路径穿越被拒、媒体内容不能被当作 HTML 执行（`nosniff` + 正确 `Content-Type`）、错误响应不含堆栈、超长请求体被拒、带疑似密钥字段的外部服务配置被拒。

**仍然没有专门用例的边界**：公开展示页的速率限制与防抓取（功能本身不存在）、多实例下共享限流状态（当前为进程内存态）、以及真实 TLS 环境下的 Cookie `secure` 行为。

### 9.2 真实浏览器验证与截图归档

方案第六章第 4 条要求「必须通过真实浏览器操作验证用户路径，包括点击、输入、提交、刷新和查看结果；不能只凭类型检查、单元测试或接口返回宣布完成」。因此每个阶段都在本机 `http://127.0.0.1:3210`（或 3000）用浏览器自动化工具实际操作，并把截图归档到 `docs/evidence/`（共 16 个 PNG）：

| 截图 | 对应的用户路径 |
| --- | --- |
| `01-admin-login.png` | 登录页（口令输入 + 「口令由环境变量 ADMIN_PASSWORD 配置」提示） |
| `02-admin-properties.png` | 房源列表：搜索、状态筛选、显示归档开关、状态统计 |
| `03-property-edit-basic.png` | 房源编辑「基本信息」：标题/房型/状态、地址与位置、面积与细节、价格与费用 |
| `04-public-page-desktop.png` | 桌面视口展示页：图集、关键信息网格、价格与费用、位置、联系方式、二维码 |
| `05-public-page-en.png`、`06-public-page-en-i18n.png` | 英文页；`05-…-before-i18n` 与 `06` 对照可见「英文页仍是中文标签」的问题被修复 |
| `07-admin-reminders.png`、`08-reminder-dispatched.png` | 发布提醒页（规则卡片、时间旅行面板、2 条提醒、立即投递）与投递后的结果 |
| `09-backup-restore-drill.png` | 备份与恢复页执行「恢复演练」后的逐表行数与素材文件数 |
| `10-admin-settings.png` | 设置页：工作区默认语言/币种/面积单位/时区 + 外部服务适配器配置 |
| `11-validation-errors.png` | 空标题提交后的字段级中文报错（标题框下「标题不能为空」+ 底部聚合错误框） |
| `12-public-page-mobile.png` | 手机视口展示页 |
| `13-publish-tab.png` | 房源详情「发布页面」标签（slug、展示语言、模板下拉、发布/撤下） |
| `14-export-offline-standalone.png` | 导出形态页面（底部导出说明 + 位置区块离线降级文案） |
| `15-public-page-map-working.png` | **地图实际渲染成功**：真实 OSM 瓦片、位置标记、`Leaflet \| © OpenStreetMap contributors` 署名、地图服务说明行 |

`15-public-page-map-working.png` 值得单独说明：第 4 阶段报告的初稿判定「交互式地图实际上不可用」，因为当时仓库里没有任何加载地图库的脚本，页面必然走到 `if (!window.L)` 降级分支，该阶段因此判定为**未达到验收标准（否）**。此后 Leaflet 被本地化引入（`node_modules/leaflet/dist` 经 `/vendor/leaflet/` 同源提供，`script-src` 保持 `'self'`，不再放行 `https://unpkg.com`），并重新做浏览器实测与截图归档；该阶段报告已追加「修订记录」小节，**结论由「否」更正为「是」**（实测输出：`leafletLoaded: true`、`leafletVersion: 1.9.4`、`hasLeafletDom: true`、`tiles: 10`、`loadedTiles: 10`、`scriptSrc: ["/vendor/leaflet/leaflet.js"]`、`cssHref: ["/vendor/leaflet/leaflet.css"]`）。

**仍未闭环的一处**：`14-export-offline-standalone.png` **不含浏览器地址栏**，因此无法据此判定它是用 `file://` 打开了解压后的目录，还是通过 `GET /api/admin/properties/:id/export-preview` 查看了同一份 HTML（两者产物相同）。「双击 index.html 在本地打开」应继续按未完全闭环处理。

### 9.3 当前实测结果

三条命令于本项目收尾时全部通过（命令与观测结果逐字记录在实施计划中）：

| 命令 | 结果 |
| --- | --- |
| `node --disable-warning=ExperimentalWarning scripts/smoke.ts` | `共 73 项检查，通过 73 项，失败 0 项`，退出码 0 |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | `tests 251 / pass 251 / fail 0`，退出码 0 |
| `node node_modules/typescript/bin/tsc --noEmit` | 无输出，退出码 0 |

**一条环境相关的注意事项**：`node --test <目录>` 在本 Node 构建上**不可用**（Node 会把目录当作入口模块执行，报 `MODULE_NOT_FOUND`）。因此 `package.json` 中的测试脚本必须使用 glob：`node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"`。这解释了为什么 `pnpm test` 写的是 glob 而不是 `tests/`。

**测试的边界**：251 条用例覆盖了领域规则、适配器契约、服务编排与主要 HTTP/安全分支，但**不覆盖**：真实 SMTP 投递、真实 DNS TXT 解析、真实网络下的 Overpass 查询（用注入的 `fetchImpl` 替代）、TLS/HTTPS、并发写入、性能与容量。这些都需要外部环境，属于第 10 节的后续工作。

---

## 10. 已知限制与后续工作

以下每一条都是当前代码的真实状态，写在这里是为了避免「看起来能用但实际没验证」被当成已完成。

### 10.1 外部集成：已实现但未在真实环境验证

1. **SMTP 适配器已实现，但只对 console 提供者做过验证。** `SmtpMailProvider` 实现了隐式 TLS(465)、STARTTLS(587)、AUTH LOGIN、RFC 2047 中文主题与 base64 正文，且仅使用 `node:net` / `node:tls`（不引入邮件库）。但本机运行使用 `MAIL_PROVIDER=console`（邮件只写服务端日志），自动化测试使用 `MemoryMailProvider`，**从未对真实邮件服务器投递过**。因此「主流服务商的 TLS 握手与认证是否兼容」「中文主题在各客户端显示是否正确」「是否会被判为垃圾邮件」都属未验证。这是提醒功能最后一公里的缺口。

2. **Overpass 周边信息端点可配置，但公共默认端点在本机环境中被拦截（HTTP 406），因此从未用真实数据验证。** `MAP_OVERPASS_ENDPOINT` 默认 `https://overpass-api.de/api/interpreter`；代码实现了完整的查询构造（按 `amenity` / `shop` / `highway` / `railway` / `leisure` 过滤）、Haversine 距离计算、分类映射、距离排序取前 12、8 秒超时与 24 小时缓存，`tests/adapters/map.test.ts` 用注入的 `fetchImpl` 覆盖了「失败不抛错」「限流提示」「按距离排序并解析分类」「命中缓存不重复请求」「超时降级」「haversine 量级」六个分支。但对公共实例的真实请求经 4 种请求形式逐一验证**一律返回 HTTP 406**（判断为网络策略拦截而非代码问题 —— 同一环境下 OSM 瓦片可正常访问），因此只验证了**降级路径**：`nearby()` 返回 `{ available: false, reason: '周边信息服务返回 HTTP 406…；展示页仍会正常显示地址文本与地图定位', places: [], source: 'unavailable' }`，页面渲染出中文原因而不是报错或空白。**返回结构是否与真实响应一致、免费公共实例的限流阈值、8 秒超时是否合适，均未验证。** 73 项冒烟检查中没有任何一项覆盖 `nearby()` 的正常路径。

3. **OSM 公共瓦片的使用政策未复核。** 默认 `MAP_TILE_URL` 指向 `tile.openstreetmap.org`，免费且无需密钥，但有使用量限制。`MAP_FREE_TIER_NOTE` 与页面「地图服务说明」行已提示这一点，商业部署前必须复核其使用政策（`docs/licenses.md` 第 5 节已登记为待办）。

### 10.2 部署与运维

4. **应用内不做 TLS 终结。** `src/server.ts` 只调用 `app.listen()`，没有证书加载、没有 HTTP→HTTPS 跳转、响应头里**没有 `Strict-Transport-Security`**。当前只有配置层约束：生产环境 `PUBLIC_BASE_URL` 必须以 `https://` 开头，且会话 Cookie 的 `secure` 标志取决于该前缀。证书签发与续期必须由外部反向代理承担。`README.md` 第 7 节「生产部署与回滚」已给出前置条件、发布与回滚步骤，但**反向代理配置样例**仍需补齐。

5. **备份未加密，且只落本地。** 备份 ZIP 使用 STORE 模式打包，内容包含 `db/app.sqlite` 快照与全部上传素材，其中含房源地址、联系方式等个人信息；归档落在本机 `BACKUP_DIR`（默认 `var/backups`），**没有异地或离线副本**。过期清理需要手工调用 `POST /api/admin/backups/prune`，没有定时任务；恢复演练只验证到独立目录，**没有验证「用恢复数据真正启动服务」这一步**。

6. **域名所有权验证从未在真实 DNS 上跑通。** 机制完整（TXT 记录比对、`DOMAIN_VERIFY_PREFIX` 可配置、回显查询到的全部 TXT 记录便于排查、域名唯一性检查、重新绑定清空验证状态），`tests/services/hosting-service.test.ts` 有 13 条用例用 `FakeDnsResolver` 驱动了全部成功/失败/多段记录分支。但 `SystemDnsResolver` 的真实解析路径与 DNS 传播延迟场景**没有实测**。另外验证令牌**没有有效期与轮换机制**。

7. **自定义域名缺少服务端承接说明。** 服务端没有按 `Host` 头判断的逻辑；自定义域名要真正可访问，必须由外部反向代理把该域名指向本服务并配置证书，而仓库里没有这份指引。用户按界面完成域名验证后，域名仍然打不开。

8. **`pnpm reminders` 已可用，但三个投递入口之间没有分布式协调。** `scripts/run-reminders.ts` 已实现（加载配置 → 打印业务时间/时区/收件人/邮件适配器 → 调用 `dispatchDueReminders()` → 输出「扫描 N 条：发送/失败/停止重试/跳过/稍后重试」与逐条明细），因此提醒投递有三个入口：进程内 `setInterval`、`POST /api/admin/reminders/dispatch`、`pnpm reminders`。三者共享同一数据库状态，投递成功后提醒离开 `pending`，因此并行触发不会重复发送；但它们之间**没有锁或租约**，多实例部署时依赖 SQLite 的单写者特性兜底。若换成多主数据库需要重新设计。

### 10.3 安全与权限

9. **权限模型仍是单账号。** 只有一组管理口令与一个 `admin` 角色，没有多用户、角色区分、二次验证与操作者身份区分。`users` 表已建好 `role` 列（`owner` / `manager` / `viewer`）并有工作区归属校验，但只使用一条 `owner` 记录。直接后果是**审计日志的 `actor` 无法对应到具体自然人** —— 审计能回答「发生了什么」，不能可靠回答「是谁做的」。

10. **登录限流是单进程内存态。** `LoginRateLimiter` 的状态存在进程内存中，重启即清空，多实例之间不共享。公开页没有任何速率限制或防抓取措施。

11. **未做依赖漏洞审计。** 没有运行 `pnpm audit` 或等价工具，也没有核对传递依赖的已知漏洞。`docs/licenses.md` 只逐项核验了直接依赖的许可证（并登记了两个证据弱点：`qrcode-generator` 包内无 LICENSE 文件、`typescript` 实为 Apache-2.0 而非 MIT）。

12. **上传文件不做后处理。** 上传字节原样保存，不做图像压缩、缩略图或 **EXIF 剥离**。隐私影响：手机拍摄的照片可能携带 GPS 定位信息，公开到展示页后可能泄漏拍摄位置。性能影响：列表与展示页直接加载原图。

13. **精确坐标默认公开。** 房源经纬度原样渲染到公开页与导出页（截图中可见「经纬度：31.2304, 121.4737」）。对住宅房源而言，精确坐标近似等于公开门牌位置。当前**没有**「只显示区域中心 / 模糊化坐标」的选项，也没有在后台提示这一点。

14. **导出包暴露内部存储键。** 导出目录的 `assets/<storageKey>` 中，存储键形如 `prp_<uuid>/<timestamp>-<random>.png`。这些 ID 不是凭据，但属于内部命名，会随用户分享的离线包扩散。若需要「对外干净的导出包」，应改为 `assets/photo-1.png` 一类顺序命名。

### 10.4 国际化与本地化

15. **12 种可选语言中只有 4 种有界面文案目录。** `SUPPORTED_LOCALES` 列出 12 种（`zh-CN`、`zh-TW`、`en`、`ja`、`ko`、`es`、`fr`、`de`、`ru`、`ar`、`th`、`vi`），而 `UI_CATALOGS` 只有 `zh-CN`、`zh-TW`、`en`、`ja`。选择其余 8 种时，**日期与数字按该语言格式化，界面标签会回退为英文**，出现「英文标签 + 韩文/阿拉伯文数字格式」的混排页面。语言栏列出这些语言会造成「已支持」的预期，实际是部分支持。

16. **自由文本字段没有翻译通道。** `property_translations` 只有 `title` 与 `description` 两列。因此英文页上的**地址**（`CN 上海市 上海 浦东新区 世纪大道 100 号 3 号楼 1502 室 200120`）与**附加费用**（`物业费 380 元/月由租客承担…`）仍是中文；`floor_note`（楼层说明）与 `media.source_note`（素材来源说明）同样没有翻译通道。运营配置文本（如 `MAP_FREE_TIER_NOTE`）也不参与翻译，英文页上的地图说明仍是中文。

17. **`formatDateOnly` 虽然接收 `timeZone` 参数，但渲染时硬编码使用 UTC。** 详见 8.4 节。对「可入住日期」这一唯一调用点而言结果是正确的（该字段只存日期），但签名与实现不一致，会误导后来者。

18. **管理后台界面本身没有多语言。** `public/admin/index.html` 为 `lang="zh-CN"`，侧栏与表单标签全部硬编码中文。方案第三章第 7 条要求「支持多语言界面」，目前只有公开展示页做到了国际化。

19. **分享链接不随语言变化。** slug 只有一个（由中文标题生成，形如 `/p/%E6%B5%A6%E4%B8%9C…`），英文页分享出去的仍是百分号编码的中文 URL；也没有 `hreflang` 之类的搜索引擎提示。

20. **RTL 只有代码级实现。** `dir="rtl"` 会在阿拉伯语等语言下加到 `<html>`，但没有视觉验证。

### 10.5 数据、性能与可观测性

21. **性能只有定性结论，没有量化数据。** 没有做任何压测，没有首屏耗时/接口耗时统计，没有内存与连接数观察。曾经存在的列表接口 N+1 问题**已消除**（`listProperties()` 改为单条 SQL，含 `LEFT JOIN listing_pages` 与 `photo_count` 子查询）；仍然存在的结构性约束是 SQLite 的**单写者**模型，并发写会串行化。因此仍无法给出容量结论。

22. **删除是不可逆的硬删除。** `DELETE /api/admin/properties/:id` 级联清除媒体（含存储文件）、译文、发布页与提醒，**没有回收站**；误删只能依赖备份恢复。

23. **浏览量不去重。** `view_count` 每次访问自增，同一访客刷新会重复计数，也没有机器人过滤，只能作粗略参考。

24. **ZIP 不压缩。** `src/util/zip.ts` 使用 STORE 方法，导出包与备份包的体积接近内容原始体积之和；没有分卷，也没有体积提示。

25. **`docs/reports/phase-*.md` 的正文结论与「修订记录」存在层次**：第 4、6、8 阶段的报告在本轮开发后期追加了「修订记录」小节（位于文件顶部），其中第 4 阶段的结论由「否」更正为「是」，第 8 阶段补充了测试、Git、存储适配器与 N+1 的关闭情况。阅读时必须先看修订记录再看正文，否则会读到已经过时的结论。

26. **「导出文件可在本地打开」仍按未完全闭环处理。** 导出产物的内容正确性由程序断言保证（相对路径 + `assets/` 条目存在 + 不含 `/media/`），但 `docs/evidence/14-export-offline-standalone.png` **不含浏览器地址栏**，无法据其判定页面是用 `file://` 打开了解压后的目录，还是通过 `GET /api/admin/properties/:id/export-preview` 查看的同一份 HTML（两者是同一个 `buildExportBundle()` 产物）。补一张带地址栏的 `file://` 截图即可闭环。

27. **多实例部署无分布式协调。** 提醒定时扫描是进程内的，多实例会各自扫描（共享同一 SQLite 时幂等键与状态推进可避免重复发送，但依赖单写者数据库）。若换成多主数据库需要重新评估。

28. **后台窄屏体验未验证。** 公开展示页有手机视口截图（`12-public-page-mobile.png`），但管理后台的截图均为 1360×900 桌面视口，侧栏与表格在手机宽度下的可用性未知。

29. **重复录入只有提示、没有拦截。** 标题与城市相同时 `createPropertyFromInput()` 返回 `duplicateOf`，前端以提示告知「可能是重复录入」，用户仍可继续创建。这是刻意选择（避免误拦真实的两套相似房源），但方案第三章第 5 条「避免重复录入相同房源」只做到了提示级别。

30. **`?lang=` 之外没有语言协商。** 展示页语言取自 `?lang=` 白名单或发布页配置，没有读取 `Accept-Language`，也没有语言偏好的持久化。

### 10.6 后续工作建议的优先级

若目标是商用上线，建议按此顺序关闭缺口（前四项为**阻塞项**）：

1. HTTPS 终结方案落地并实测（反向代理样例 + 证书续期 + HSTS 与 HTTP→HTTPS 跳转）；
2. 一次真实 SMTP 投递验证；
3. 一次真实 Overpass 查询验证（正常返回与超时两种情形，记录 `source`、条数与耗时），或明确把周边信息降级为可关闭的实验特性；
4. 备份加密 + 异地副本 + 用备份数据真正启动服务的一次完整切换演练；
5. 运行依赖漏洞审计并把结论记入 `docs/licenses.md`；
6. 清理许可证证据弱点（`qrcode-generator` 包内无 LICENSE 文件、`typescript` 为 Apache-2.0）并完成商用前复核（`docs/licenses.md` 第 7 节）；
7. 性能基线（列表接口在 N 条房源下的耗时、展示页 TTFB、备份/导出耗时）；
8. 补齐剩余 8 种语言的界面文案目录，或把语言栏收窄到真正支持的语言，避免「已支持」的误导；
9. 处理隐私三项：精确坐标模糊化选项、EXIF 剥离、导出副本不可撤回的界面提示；
10. 把部署与回滚步骤从阶段报告移入 `README.md` / `docs/deploy.md`；
11. 为后台补窄屏验证；修正 `scripts/run-reminders.ts` 空文件或从 `package.json` 移除该脚本；
12. 评估是否需要多用户与角色（涉及 `users` 表的使用方式与审计 `actor` 的语义）。

---

## 附：本说明书的核验方式

本说明书中所有关于代码的事实均来自对仓库当前内容的直接读取与命令实测，而不是设计意图的复述。关键核验动作：

- 表结构与索引：读取 `src/db/migrations.ts` 全文；
- 路由清单：对 `src/http/routes/*.ts` 检索 `app.(get|post|put|patch|delete)(` 的全部命中；
- 分层依赖规则：对 `src/domain/` 检索 `^import .*from '\.\./(db|services|http|render|adapters)`（无命中）；
- 服务导出函数：对 `src/services/` 检索 `^export (async )?function |^export const |^export class `；
- 适配器接口：逐个读取 `src/adapters/` 下六个文件；
- CSP 与安全头：读取 `src/http/security.ts` 的 `contentSecurityPolicy()` / `securityHeaders()`；
- 地图是否真的能用：读取 `docs/evidence/15-public-page-map-working.png`（可见真实瓦片、标记与 Leaflet 署名）；
- 三条验证命令的执行结果：见实施计划中逐阶段的「验证方式」与文末的收尾复核。
