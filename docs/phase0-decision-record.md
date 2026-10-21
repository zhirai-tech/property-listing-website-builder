# 第 0 阶段决策记录：开源项目检查与底座定案

- 项目：轻量化房源管理与一键房源网站生成平台
- 依据方案：《轻量化房源管理与一键房源网站生成平台_整合实施方案（归档稿 1.0）》第二章、第五章第 0 阶段、第八章第 1、2 条
- 候选项目元数据核验日期：2026-10-12（GitHub API）
- 本机环境复核日期：2026-10-12
- 最终结论：**不采用 PropertyWebBuilder 作为底座；采用面向本方案闭环自建的轻量 Node.js 24 + TypeScript 底座**

---

## 1. 候选项目对照表（2026-10-12 经 GitHub API 核验）

| 项目 | 许可证 | 主语言 | Star | Fork | 最后推送 | 仓库体积 | 关键 topics | 方案中的定位 | 决定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `etewiah/property_web_builder` | MIT | Ruby (Rails) | 647 | 286 | 2026-09-28 | 约 96 MB | cms / mls / rails / real-estate | 第二章第 1 条指定为「主底座优先评估对象」 | **不采用为底座**（详见第 3 节） |
| `microrealestate/microrealestate` | `NOASSERTION`（非标准 / 自定义条款） | JavaScript | 1198 | — | 2026-09-01 | — | — | 第二章第 4 条「暂不作为核心依赖」 | **排除，不引入**（详见第 5 节） |
| `clawnify/OpenProperty` | MIT | TypeScript（React） | 约 24 | — | 2026-09-09 | — | — | 第二章第 2 条「后台管理能力参考」 | 仅作后台界面设计参考，**未复制任何代码** |
| real-estate-listing-template 系列（如 `radwan503/Faname--RealEstate`、`singdisain/rehomes-colorlib`） | **多数仓库没有 LICENSE 文件** | HTML / CSS / JS | — | — | — | — | — | 第二章第 3 条「单套房源页面模板参考」 | 仅作展示页信息分区与响应式布局的视觉参考，**未复制代码，也未复制示例图片** |

元数据来源为 2026-10-12 调用 GitHub 官方 API 取得的仓库字段（许可证、语言、star、fork、最后推送时间、仓库体积、topics）。表中「—」表示该项未参与决策，未做核验。

---

## 2. 决策

1. **不采用 `etewiah/property_web_builder` 作为本项目底座。**
2. **采用自建轻量底座**：Node.js 24（原生 TypeScript 类型擦除执行，无构建步骤）+ Fastify 5 + 内置 `node:sqlite`，配一层可替换的外部服务适配层（时钟 / 地图 / 存储 / 邮件 / DNS / 托管）。
3. 其余候选项目只以「设计参考」形式使用：`clawnify/OpenProperty` 参考后台信息架构，real-estate-listing-template 系列参考展示页视觉结构，二者均未复制代码或素材。
4. `microrealestate/microrealestate` 在条款澄清前不进入依赖链，也不作为能力来源。

---

## 3. 决策理由：PropertyWebBuilder 未采用的三条可核验证据

### 3.1 运行环境没有 Ruby/Rails 工具链（2026-10-12 实测）

复核命令与结果：

| 命令 | 结果 |
| --- | --- |
| `Get-Command ruby` | 未安装（命令不存在） |
| `Get-Command rails` | 未安装（命令不存在） |
| `Get-Command gem` | 未安装（命令不存在） |
| `Get-Command bundle` | 未安装（命令不存在） |
| `node --version` | v24.14.0 |
| `pnpm --version` | 10.32.1 |
| `npm --version` | 11.9.0 |
| `docker` / `git` | 已安装（`C:\Program Files\Docker\...`、`C:\Program Files\Git\...`） |

要把它作为底座，必须先在本机引入整套 Ruby 运行时、Bundler 依赖链与 Rails 部署流程；这与方案第一章第 1 条「简单轻量」原则直接冲突，且会引入一条与本项目技术栈完全无关的长期维护链。

### 3.2 数据模型取向与本方案的闭环不是同一类系统

PropertyWebBuilder 的定位是**面向多用户、MLS 式房源列表的网站 CMS（含主题系统）**：核心是「多机构/多用户的房源库 + 站点主题 + 内容页」。本方案要求的闭环是（方案第一章第 3 条、第三章第 3、9 条）：

- 一条房源录入 → 一张可分享的展示页 → 二维码/链接分享 → 第 7 天检查、第 15 天确认的提醒 → 可随时撤下；
- 「房源信息只维护一份，后台、展示页和导出内容均从统一数据源生成」。

把 CMS 型底座套用到「单工作区、一次录入、一键出页」的闭环上，必然产生第二套数据模型（例如主题层、内容页层与房源层的重复字段），违反方案第六章第 3 条「不创建平行系统、不留下重复模块」。

### 3.3 体积与轻量化原则冲突

`property_web_builder` 是约 96 MB 的 Rails 单体（含主题、资产管线与其自带后台体系）。本方案首期只需要：房源 CRUD 与媒体管理、展示页生成、静态导出、地图适配层、多语言、托管与域名验证、7/15 天提醒、备份恢复。自建底座的实际运行期依赖只有 5 个包（见 `docs/licenses.md`），体量与可审计性都远优于引入 96 MB 单体。

---

## 4. 与方案的偏差（明确记录，不静默省略）

方案第五章第 0 阶段要求：

> 检查候选项目的官方仓库、许可证、维护状态、技术栈、依赖、部署流程和数据模型；制作能力对照表并进行**实际部署验证**；最终只确定一个主底座。

**实际执行中的偏差：没有实际部署 PropertyWebBuilder。** 原因即第 3.1 节：本机不存在 Ruby/Rails 工具链，无法完成 `bundle install` 与 Rails 启动；而在没有工具链的前提下安装整套 Ruby 运行时，恰恰是本次决策要否定的做法。因此本阶段的对比依据是**仓库与 API 元数据 + 本机工具链实测**，而非实机部署结论。方案第八章第 2 条也要求「实施前重新检查官方仓库、版本、维护情况和安全公告」，本记录中的元数据即该检查的产出。

由此产生的核验边界：

| 项目 | 状态 |
| --- | --- |
| 许可证、主语言、star/fork、最后推送时间、仓库体积、topics | 已核验（2026-10-12 GitHub API） |
| 本机 Ruby/Rails 工具链缺失 | 已核验（`Get-Command` 实测） |
| PropertyWebBuilder 的实际启动与部署流程 | **未核验** |
| PropertyWebBuilder 后台实际操作体验、地图与多语言模块的真实表现 | **未核验** |
| PropertyWebBuilder 的升级/迁移路径与安全公告历史 | **未核验** |

结论按方案第六章第 7 条处理：先给出可核实的证据（本节与环境实测表）与替代方案（自建轻量底座），再定案；不把未部署的评估表述为已完成部署验证。

---

## 5. 被排除的候选与原因

1. **`microrealestate/microrealestate` —— 排除**
   - 许可证字段为 `NOASSERTION`，即 GitHub 无法识别为标准许可证，属于非标准/自定义条款；
   - 仓库存在关于变更许可证条款的开放讨论（issue #264），说明条款本身仍在变动中；
   - 方案第八章第 1 条明确「保存主项目、依赖、模板和媒体素材的许可证/授权证据；条款不明确时先暂停使用」，第二章第 4 条也要求「在确认当前许可证、托管条款和目标商业模式兼容之前，不把它作为平台核心」。
   - 处理方式：不引入其代码、不复制其数据结构、不作为能力来源；仅登记为「条款澄清后再评估」。

2. **`clawnify/OpenProperty` —— 降级为设计参考**
   - MIT 许可证，本可合法使用；但它是 TypeScript + React 的前端项目，而本项目后台刻意采用「无构建步骤的纯 ES Module 静态页面」（`public/admin/`），引入 React 工具链会带来与本阶段目标无关的构建与维护成本；
   - 方案第二章第 2 条也要求「不默认把整套后台与主底座合并，避免重复登录、重复数据模型和额外维护负担」。
   - 处理方式：只参考其后台的信息分区与字段组织思路；**未复制任何代码**，故不产生许可证义务。

3. **real-estate-listing-template 系列 —— 降级为视觉参考**
   - 该系列多数仓库**没有 LICENSE 文件**，代码的可用范围不明确；模板代码可见并不等于其中的示例照片可用于商业用途（方案第二章第 3 条已就此明确提示）；
   - 处理方式：只参考单套房源详情页的信息分区与响应式布局思路，**未复制代码、未使用其任何示例图片**；本项目展示页模板（`src/render/templates.ts`）为自行编写的 CSS 与结构，不包含外部素材与在线字体。

---

## 6. 由此形成的架构摘要（实际实现，可对照代码目录核验）

**技术栈（实际运行）**

- Node.js 24（`engines.node: >=24.0.0`），直接运行 `.ts` 源文件（原生类型擦除），**无编译/打包步骤**；
- HTTP 框架 Fastify 5；数据库为 Node 内置 `node:sqlite`（同步 API，单文件库）；
- 校验为手写校验器（`src/domain/validate.ts`），不引入校验框架；
- 二维码使用 `qrcode-generator`（MIT，Kazuhiko Arase）生成矩阵，再由项目自行渲染为内联 SVG（离线可用）；
- 后台界面为不依赖 bundler 的原生 ES Module 静态页面（`public/admin/`）；
- 运行期依赖 5 个：`fastify`、`@fastify/cookie`、`@fastify/multipart`、`@fastify/static`、`qrcode-generator`；开发依赖 2 个：`typescript`、`@types/node`（清单与许可证见 `docs/licenses.md`）。

**目录结构（真实）**

| 目录 | 职责 |
| --- | --- |
| `src/domain/` | 纯领域类型与规则：`types.ts`、`errors.ts`、`validate.ts`、`property.ts`、`media.ts`、`listing-page.ts`、`reminder.ts`、`i18n.ts`、`hosting.ts` |
| `src/db/` | `database.ts`、`migrations.ts`、`migrate.ts`、`sql.ts` 与 `repositories/*.ts`（property / media / contact / listing-page / reminder / workspace / external-service / audit / translation） |
| `src/adapters/` | 可替换适配器：`clock.ts`、`map.ts`、`storage.ts`、`mail.ts`、`dns.ts`、`hosting.ts`、`registry.ts` |
| `src/services/` | 业务编排：property / media / publish / export / reminder / i18n / hosting / backup / audit |
| `src/render/` | `page-renderer.ts`、`templates.ts`、`qrcode.ts`、`html.ts` |
| `src/http/` | `app.ts`、`security.ts`、`routes/*.ts` |
| `public/admin/` | 后台 SPA：`index.html`、`app.js`、`api.js`、`ui.js`、`styles.css`、`views/*.js` |
| `scripts/` | `seed.ts`、`smoke.ts`、`run-reminders.ts` |
| `docs/`、`tests/`、`var/` | 文档、测试目录、运行期数据（`var/` 已在 `.gitignore` 中排除） |

**数据层**

- 单一迁移 `v1 initial_schema`，共 10 张业务表：`workspaces`、`users`、`properties`、`property_translations`、`contacts`、`media`、`listing_pages`、`reminders`、`external_service_configs`、`audit_logs`；
- 迁移在独立事务中执行，失败自动回滚；已发布迁移只增不改，重复运行幂等（`src/db/migrations.ts`）。

**外部服务边界与密钥纪律**

- 所有外部服务都经适配层注入（`src/adapters/registry.ts`），业务代码不直接依赖具体服务商；
- 密钥只从环境变量读取（`src/config.ts`），设置接口只返回脱敏快照（`redactedConfig`），外部服务配置接口拒绝保存任何键名疑似密钥的字段（`src/http/routes/admin-settings.ts`）；
- 生产环境启动校验会拒绝默认口令与过短的会话密钥（`validateConfig`）。

**偏差登记（相对方案原文）**

- 方案第四章的逻辑模型建议「正式开发前应先检查选定底座已有的数据模型，尽可能扩展和复用」；由于底座改为自建，本项目直接按该章的逻辑模型落地为上述 10 张表，不存在「检查底座既有模型」这一步。
- 工作区为 exFAT 卷，不支持硬链接/符号链接，因此 pnpm 强制 `node-linker=hoisted`（见 `.npmrc`）。

---

## 7. 许可证核验清单（第 0 阶段交付物）

| # | 核验对象 | 核验内容 | 状态 | 证据位置 |
| --- | --- | --- | --- | --- |
| 1 | `etewiah/property_web_builder` | 许可证类型（MIT）、主语言、活跃度、体积 | 已核验（2026-10-12） | 本文件第 1 节表格 |
| 2 | 同上 | 实机部署可行性 | **未核验**（无 Ruby 工具链） | 本文件第 4 节偏差说明 |
| 3 | `microrealestate/microrealestate` | 许可证是否标准、条款是否稳定 | 已核验为 `NOASSERTION`，判定不可用 | 本文件第 1、5 节 |
| 4 | `clawnify/OpenProperty` | 许可证（MIT）与是否复制代码 | 已核验；未复制代码 | 本文件第 5 节 |
| 5 | real-estate-listing-template 系列 | 是否有 LICENSE、示例图片能否商用 | 已核验：多数无 LICENSE，判定不可复制 | 本文件第 5 节 |
| 6 | 运行期依赖（5 个） | 许可证与版本 | 已核验（包内 LICENSE 文件 / `package.json`） | `docs/licenses.md` 第 2 节 |
| 7 | 开发依赖（`typescript`、`@types/node`） | 许可证与版本 | 已核验（注意 `typescript` 为 Apache-2.0，非 MIT） | `docs/licenses.md` 第 3 节 |
| 8 | `qrcode-generator` | 许可证文件是否随包分发 | 已核验：包内无 LICENSE 文件，仅 `package.json` 声明 MIT，属证据弱点 | `docs/licenses.md` 第 2 节 |
| 9 | OpenStreetMap 瓦片与 Overpass 数据 | 署名义务与商用使用政策 | 已记录署名要求；**商用政策需在上线前复核** | `docs/licenses.md` 第 5 节 |
| 10 | 展示页地图组件（Leaflet 一类前端地图库） | 是否已引入、许可证与署名 | **当前未引入**（页面未加载任何地图库脚本），引入前必须单独核验 | `docs/licenses.md` 第 5 节 |
| 11 | 字体与图片素材 | 是否使用第三方字体/图片 | 已核验：仅使用系统字体；仓库内不含任何示例照片 | `src/render/templates.ts`、`docs/licenses.md` 第 6 节 |
| 12 | 全部核验结果 | 快照有效期 | **快照日期 2026-10-12，商用发布前必须重新核验** | `docs/licenses.md` 开头声明 |

---

## 8. 后续动作（仅记录，不自动开工）

1. 若后续要以 PropertyWebBuilder 作为参照做能力对比，需先补齐「实机部署 + 后台操作 + 地图/多语言模块表现」的证据，并明确部署在哪个隔离环境。
2. `microrealestate` 的条款澄清（issue #264 的结论）需在每次评估前重新确认。
3. `docs/licenses.md` 中的全部结论在商用发布前重新核验一次，并更新快照日期。