# 第 0 阶段验收报告：开源项目检查与底座定案

> 报告结构遵循方案第九章「每阶段验收报告模板」。

## 阶段名称与目标

**第 0 阶段：开源项目检查与底座定案。**

目标：核查候选开源项目的官方仓库、许可证、维护状态、技术栈、依赖、部署流程与数据模型，制作能力对照表，最终**只确定一个主底座**。方案明确要求：「未完成本阶段，不开始业务功能开发」。

## 实际修改的文件/模块

本阶段为只读核查阶段，未修改任何业务代码。产出物：

| 文件 | 内容 |
| --- | --- |
| `docs/phase0-decision-record.md` | 底座的候选对照表、决策与理由、被排除候选、架构摘要、12 项许可证核验清单 |
| `docs/licenses.md` | 许可证证据归档（候选项目 + 全部依赖 + 数据署名义务 + 商用前复核清单） |
| `docs/reports/phase-0-report.md` | 本报告 |

核查通过 GitHub REST API（`https://api.github.com/repos/...`）在 **2026-10-12** 取回仓库元数据，未依赖项目介绍或二手资料。

## 数据库变更与迁移结果

不适用（本阶段不涉及数据库）。后续阶段的迁移见各阶段报告。

## API/服务端验证

不适用。核查方式为：

1. 本机工具链探测：`Get-Command ruby / rails / gem / bundle` —— **全部不存在**；同时确认可用的是 Node.js v24.14.0、pnpm 10.32.1、Python 3.10.11、git 2.53.0、Docker CLI。
2. 候选仓库元数据取回：许可证（SPDX）、主语言、star/fork 数、最后推送时间、仓库体积、默认分支、topics。
3. 关键候选的 README 与 issue 复核。

## 真实浏览器操作路径

不适用（本阶段无用户界面）。

## 通过项与证据

### 候选项目核查结果

| 候选项目 | 许可证 | 主语言 | 活跃度（2026-10-12） | 结论 |
| --- | --- | --- | --- | --- |
| [etewiah/property_web_builder](https://github.com/etewiah/property_web_builder) | **MIT** | **Ruby (Rails)** | 647★ / 286 fork / 最后推送 2026-09-28 / 体积约 96 MB / 开放 issue 18 | **不采用为主底座**（理由见下） |
| [microrealestate/microrealestate](https://github.com/microrealestate/microrealestate) | **NOASSERTION（非标准条款）** | JavaScript | 1198★ / 410 fork / 最后推送 2026-09-01 | **排除**，不作核心依赖 |
| [clawnify/OpenProperty](https://github.com/clawnify/OpenProperty) | **MIT** | TypeScript | 24★ / 18 fork / 最后推送 2026-09-09 / 体积约 418 KB | 仅作**后台管理界面设计参考**，未复用代码 |
| `real-estate-listing-template` 类仓库（如 radwan503/Faname--RealEstate、singdisain/rehomes-colorlib） | **多数无许可证文件** | HTML / Bootstrap | 参差 | 仅作**展示页信息分区与视觉结构参考**；代码与示例图片**均未复制** |

### 底座决策

**采用自建轻量底座：Node.js 24 + TypeScript + Fastify 5 + 内置 `node:sqlite`。**

不采用 PropertyWebBuilder 的三条理由（均有可核验证据）：

1. **技术栈不匹配且不可验证部署**：PropertyWebBuilder 是 Ruby on Rails 项目，而本机 `ruby`/`rails`/`gem`/`bundle` 命令均不存在。方案第 0 阶段要求「通过实际拉取代码和部署测试后，才能最终决定是否采用」，在本环境下无法完成真实部署验证。
2. **数据模型定位偏差**：该项目面向「多用户 MLS 式房源网站 CMS + 主题体系」（其 topics 含 cms / mls / heroku / lead-generator），与方案第三章要的「一次录入 → 一键生成分享页 + 第 7/15 天提醒」的单条房源闭环不是同一类问题；套用会带来大量改造与冗余。
3. **与「轻量化」原则冲突**：仓库体积约 96 MB 的 Rails 单体应用，与基本原则上第 1 条「简单轻量」相悖。

MicroRealEstate 的排除依据是方案第八章第 1 条「条款不明确时先暂停使用」：其许可证为 `NOASSERTION`，且社区存在[关于许可证条款变更的讨论](https://github.com/microrealestate/microrealestate/issues/264)。

### 决策记录

- `docs/phase0-decision-record.md` 已归档完整对照表与决策过程。
- `docs/licenses.md` 已归档许可证证据与商用前复核清单。

## 失败项、原因与影响

1. **未对 PropertyWebBuilder 做实际部署验证。** 原因是本机无 Ruby 工具链。影响：本阶段的对照建立在仓库元数据与数据模型定位之上，而非「跑起来实测」。这是一个**已登记的偏差**，不是被忽略的步骤；若后续需要推翻本决策，应在一个具备 Ruby 环境的机器上补做部署验证再作判断。
2. **未能核对模板类仓库中示例图片的授权。** 多数仓库连代码许可证都没有。影响：本项目**不使用**任何第三方模板代码与图片资源，展示页样式与三套模板均为自行实现，因此不引入该风险。

## 许可证/安全/隐私影响

- 采用的依赖全部为宽松许可证：`fastify` / `@fastify/*`（MIT）、`leaflet`（BSD-2-Clause）、`qrcode-generator`（MIT）、`typescript`（Apache-2.0）、`@types/node`（MIT）。
- 候选项目的许可证状态已归档；**归档是 2026-10-12 的快照，商用前必须重新核验**。
- 地图与周边信息使用 OpenStreetMap 数据，需保留署名（页面已展示 "© OpenStreetMap contributors"）；上线前须阅读其瓦片使用政策。
- 未引入任何需要接受额外条款的组件。

## 遗留问题

- PropertyWebBuilder 的实际部署验证未做（见上）。
- 候选仓库的许可证可能随时间变化，需在每次大版本或商用前重新核验。

## 是否达到本阶段验收标准

**是（含一项已登记偏差）。**

方案对本阶段的验收要求是：项目选择记录、许可证核验清单、部署成功证据、未采用项目及原因。

| 验收项 | 状态 |
| --- | --- |
| 项目选择记录 | 已完成 `docs/phase0-decision-record.md` |
| 许可证核验清单 | 已完成 `docs/licenses.md` |
| 未采用项目及原因 | 已完成，已列出并附证据 |
| 部署成功证据 | **未提供** —— 主底座为自建，本机可实际运行并已通过 73 项端到端检查；但方案原意中的「候选项目部署验证」未能完成，已在「失败项」中如实登记 |

## 下一阶段建议（仅建议，不自动开工）

1. 若后续确需重新评估 PropertyWebBuilder，请在一台具备 Ruby 3.x + Rails + PostgreSQL 的机器上补做部署验证，并与其数据模型做逐字段对照。
2. 把「候选项目许可证复核」纳入每次商用发布前的检查清单（已写入 `docs/licenses.md`）。