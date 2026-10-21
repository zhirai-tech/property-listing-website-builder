# 房东单页生成器：现状检查与优化评估报告

**审计日期**：2026-10-13
**审计范围**：`E:\轻量化房源管理`
**审计性质**：**只读**。未修改任何业务代码、数据库结构、迁移文件、配置文件或现有测试。
**审计方式**：直接读取磁盘代码、查询真实数据库、探测真实运行服务、真实浏览器操作。
**未执行**：数据库重建/清空/破坏性迁移、真实邮件发送、公共 DNS 修改、第三方付费 API 调用、正式部署。

> 本报告的所有结论均来自本次实际检查。**没有**引用旧报告、README 或任务完成记录作为结论依据。
> 每条结论附证据来源；无证据的标注「未验证」。

---

## 一、执行摘要

### 当前系统究竟是什么

**它是一个「房源平台」，不是「房东单页生成器」。**

顶层实体是**房源**（`properties`），不是房东。一套房源对应一个展示页，页面是房源的附属物。
数据库中**不存在任何房东/业主实体**，也没有「一个房东关联多套房源」的归属关系。

代码实现方式：Node.js 24 原生 TypeScript 执行（无构建步骤）+ Fastify 5 + `node:sqlite`。
服务端 66 个文件 / 10,030 行；后台前端 17 个文件 / 4,026 行；测试 23 个文件 / 3,914 行。

### 距离房东单页生成器还有多远

**数据模型层面：完全没有开始。**

| 维度 | 目标 | 现状 | 差距 |
| --- | --- | --- | --- |
| 顶层实体 | 房东（landlord） | 房源（property） | **缺实体** |
| 归属关系 | 1 房东 → N 房源 | 1 房源 → 1 页面 | **关系反转** |
| 页面路由 | `/<slug>` | `/p/<slug>` | 需迁移 + 兼容 |
| 页面职责 | 房东主页（列表）+ 房源详情 | 单一房源页 | **缺列表页** |
| 联系方式隐私 | 首屏不出完整值 | **首屏明文** | **未实现** |

**代码层面：计划 A 一行都没写。** 数据库里没有 `landlord_pages` 表（已用 SQL 核实）。

### 一句话结论

已完成的是一套**能跑、有测试、有文档的单房源展示平台**；房东单页架构**只有设计文档，零实现**。

---

## 二、真实运行状态

### 2.1 代码 / 数据库 / 服务 三者一致性

**这是本次审计最关键的核对，三者必须分开报告。**

#### 磁盘代码状态

| 项 | 值 |
| --- | --- |
| 项目路径 | `E:\轻量化房源管理` |
| Git 分支 | `master` |
| 最新提交 | `435cd6d` 2026-10-13 `feat(i18n): 展示页语言收口到中英两种；删除重复实现的模块` |
| 提交总数 | 35 |
| 工作区 | **干净**（`git status --porcelain` 无输出） |

#### 数据库状态

| 项 | 值 |
| --- | --- |
| 数据库类型 | SQLite（`node:sqlite` 的 `DatabaseSync`） |
| SQLite 版本 | **3.51.2** |
| journal 模式 | `wal` |
| `PRAGMA foreign_keys` | `1`（连接级，`src/db/database.ts` 显式开启） |
| 文件 | `var/db/app.sqlite`，176.0 KB |
| 迁移版本 | **v1 `initial_schema` / v2 `property_availability_status`（仅两条）** |
| 表数量 | 11 |
| 索引数量 | 16 |

#### 实际运行服务状态

| 项 | 值 |
| --- | --- |
| 监听 | `127.0.0.1:3210`（PID 22788） |
| 启动命令 | `node --disable-warning=ExperimentalWarning src/server.ts` |
| 进程启动时间 | 2026-10-13 **10:55:46** |
| 最新源文件改动 | 2026-10-13 **10:55:40**（`src/http/routes/admin-pages.ts`） |
| 最新提交时间 | 2026-10-13 10:56:14 |
| **结论** | **源文件改动时间早于进程启动时间 → 运行代码 = 磁盘代码 ✓** |

> 三者一致，不存在「服务跑旧代码」的情况。

### 2.2 完整表清单（真实 schema，来自 `sqlite_master`）

| 表 | 行数 |
| --- | --- |
| `workspaces` | 1 |
| `users` | 1 |
| `properties` | 3 |
| `property_translations` | 2 |
| `contacts` | 5 |
| `media` | 15 |
| `listing_pages` | 3 |
| `reminders` | 6 |
| `external_service_configs` | 0 |
| `audit_logs` | 29 |
| `schema_migrations` | 2 |

**`landlord_pages` 不存在** —— 计划 A 未实施。

### 2.3 完整索引清单

```
audit_logs                idx_audit_at
audit_logs                idx_audit_entity
contacts                  idx_contacts_property
contacts                  idx_contacts_workspace
external_service_configs  idx_external_service_kind   [UNIQUE]
listing_pages             idx_listing_pages_domain
listing_pages             idx_listing_pages_property
listing_pages             idx_listing_pages_slug       [UNIQUE]
media                     idx_media_property
properties                idx_properties_updated
properties                idx_properties_workspace
property_translations     idx_translations_property_locale [UNIQUE]
reminders                 idx_reminders_due
reminders                 idx_reminders_idempotency  [UNIQUE]
users                     idx_users_email            [UNIQUE]
users                     idx_users_workspace
```

### 2.4 全部注册路由（从代码提取）

**公开路由（仅 3 条）**

| 方法 | 路径 | 文件:行 |
| --- | --- | --- |
| GET | `/p/:slug` | `src/http/routes/public-pages.ts:19` |
| GET | `/p/:slug/qr.svg` | `public-pages.ts:104` |
| GET | `/p/:slug/nearby.json` | `public-pages.ts:124` |

**其它路由**

| 方法 | 路径 | 文件:行 |
| --- | --- | --- |
| GET | `/healthz` | `routes/health.ts:13` |
| GET | `/` → 重定向 `/admin/` | `http/app.ts:265` |
| GET | `/media/*`（经存储适配器，非静态） | `http/app.ts:214` |
| GET | `/api/admin/diagnostics` | `routes/health.ts:28` |
| POST | `/api/admin/login` / `logout` | `routes/admin-auth.ts:28/68` |
| GET | `/api/admin/session` | `admin-auth.ts:73` |
| POST | `/api/admin/dev/advance-time` | `admin-auth.ts:91` |
| GET | `/api/admin/dev/clock` | `admin-auth.ts:147` |
| — | `/api/admin/overview`、`properties`（CRUD）、`properties/:id/status`、`duplicate`、`preview`、`audit`、`meta`、`validate` | `routes/admin-properties.ts:41-226` |
| — | `/api/admin/properties/:id/media`（列表/上传/外链/排序/封面）、`media/:mediaId`（改/删） | `routes/admin-media.ts:20-85` |
| — | `/api/admin/pages`、`templates`、`locales`、`properties/:id/listing`、`publish`、`withdraw`、`preview`、`translations` | `routes/admin-pages.ts:30-165` |
| — | `/api/admin/reminders`（列表/完成/跳过/重开/改期/投递） | `routes/admin-reminders.ts:21-85` |
| — | `/api/admin/settings`、`external-services`、`audit`、`hosting/*` | `routes/admin-settings.ts:28-203` |
| — | `/api/admin/properties/:id/export-preview`、`export`、`export-download` | `routes/admin-export.ts:12-46` |
| — | `/api/admin/backups`（列表/创建/校验/恢复演练/清理） | `routes/admin-backup.ts:17-52` |

**静态资源**：仅注册一处，`prefix: '/admin/'`（`http/app.ts:80-82`）。

**系统保留路径（根路径 slug 必须避开）**：`/healthz`、`/api/`、`/admin/`、`/media/`、`/p/`、`/`
---

## 三、现有功能清单

状态口径（四选一）：
- **已验证可用** = 代码存在 + 测试通过 + 本次真实运行验证
- **代码存在但未验证** = 有实现，未在真实环境验证
- **部分可用** = 能跑但有明显限制
- **不可用** = 缺失或坏的

### 3.1 房源管理

| 功能 | 状态 | 代码位置 | 证据 | 限制 |
| --- | --- | --- | --- | --- |
| 新增/编辑/删除/列表/详情 | **已验证可用** | `routes/admin-properties.ts:67-129` | 浏览器实测：卡片列表 3 条、编辑页加载 23 字段 | 无 |
| 图片存储与关联 | **已验证可用** | `media.property_id → properties.id ON DELETE CASCADE` | SQL 核实 15 行；备份 ZIP 含 `uploads/prp_*/` | 文件存磁盘 `var/uploads/`，未做去重 |
| 视频 | **部分可用** | `admin-media.ts:53` 外链方式 | 代码存在 | 仅支持外链，不支持上传；未实测播放 |
| 封面图 | **已验证可用** | `admin-media.ts:85` | 浏览器实测卡片有封面 | 无 |
| 价格/面积/币种 | **已验证可用** | `src/domain/i18n.ts:60/82/101` | 卡片显示 `8,500 CNY/月`、`2,400 EUR/月` | 无 |
| **单价自动计算** | **已验证可用** | `public/admin/views/property-edit.js` `wireUnitPrice()` | 实测：`单价约 94.97 CNY/m²`、`单价约 1.66 EUR/sq ft` | **纯前端计算**，未入库、后端无校验 |
| 国家/省/市/区县联想 | **已验证可用** | `public/admin/combobox.js` + `public/admin/data/*.json` | 实测输入「中」出中国/中国香港；「广」出广东省/广西 | 中国区划仅中文名，无英文 |
| 经纬度与地图 | **部分可用** | `src/render/mini-map.ts`（自研，无第三方库） | 代码存在 | **未做联网瓦片验证**（沙箱内无法确认瓦片可达） |
| 表单验证/错误提示 | **已验证可用** | `src/domain/property.ts` + `ui.js` `applyFieldErrors` | 测试覆盖 | 服务端提示**仅中文**，不随语言切换 |
| 空状态 | **已验证可用** | 各视图 `暂无…` 分支 | 代码存在 | 无 |
| 多语言切换 | **已验证可用**（后台） | `public/admin/i18n.js` 280 条 × 5 语言 | 浏览器实测中/英/法/意/德全部切换 | 服务端错误提示不翻译 |
| 刷新后状态恢复 | **部分可用** | 后台界面语言存 `localStorage.adminLocale` | 代码存在 | **数据语言（标题/描述）不持久化**，刷新后回到原文语言 |

### 3.2 房源展示页

| 功能 | 状态 | 代码位置 | 证据 | 限制 |
| --- | --- | --- | --- | --- |
| 路由 | **已验证可用** | `public-pages.ts:19` | `/p/<slug>` 返回 200 | 仅此一条主路由 |
| slug 生成 | **已验证可用** | `listing-page-repo.ts` `nextAvailableSlug()` | `idx_listing_pages_slug` **UNIQUE** | 无冲突风险（有唯一索引兜底） |
| 中英切换 | **部分可用** | `public-pages.ts:42-46` + `domain/i18n.ts` 的 4 套 catalog | 实测 `?lang=en` → UI 全英文、数据不动 | **见缺陷 2** |
| 图片加载/懒加载 | **已验证可用** | 封面 `loading="eager"`，其余 `loading="lazy"` | 浏览器实测：首图 1600×2133 已加载，其余 lazy | 无 |
| 图片失败处理 | **未验证** | — | 未构造 404 图片测试 | 未验证 |
| 手机/平板/桌面 | **已验证可用** | `src/render/templates.ts` 响应式断点 | 390×844 实测**无横向溢出**（scrollWidth 375） | 平板未单独测 |
| **SEO / 分享预览** | **部分可用** | `page-renderer.ts` | 实测有 `<title>`、`meta[name=description]`、`og:title`、`og:image`、`og:description` | **无 `link[rel=canonical]`**；无 `twitter:card` |
| 联系方式显示 | **不可用（隐私）** | `page-renderer.ts` | **见缺陷 1** | 严重 |

### 3.3 管理维护

| 功能 | 状态 | 代码位置 | 证据 | 限制 |
| --- | --- | --- | --- | --- |
| 模板管理 | **代码存在但未验证** | `routes/admin-pages.ts:32` + `templates.ts` | 代码存在多套模板 | 未逐一渲染验证 |
| 自定义域名验证 | **代码存在但未验证** | `admin-settings.ts:193-203` | 有 TXT 验证逻辑 | **从未做过真实公共 DNS 验证** |
| 7/15 天提醒 | **部分可用** | `domain/reminder.ts:49` `buildReminderPlan` | 6 条提醒在库；测试通过 | **冒烟断言与规则矛盾**（见第九节） |
| 静态导出 | **已验证可用** | `admin-export.ts` | 实测产出 `index.html` / `index.en.html` / `assets/` / `share-url.txt` | **导出包含完整联系方式** |
| 备份/恢复 | **部分可用** | `backup-service.ts` | 实测 ZIP 含 `db/app.sqlite` + `uploads/` + `manifest.json` | **备份未加密**；恢复演练只校验行数 |
| 审计日志 | **已验证可用** | `audit_logs` 表 29 行 | SQL 核实 | 未测日志轮转/上限 |
| 适配器实现度 | **部分可用** | `src/adapters/` | 6 个适配器均为可替换实现 | **SMTP 从未投递真实服务器；DNS 未做真实验证；地图未联网验证** |

---

## 四、架构与数据模型

### 4.1 当前数据关系图（**与真实代码和数据库一致**）

`!` = NOT NULL

```
                        ┌──────────────────┐
                        │   workspaces     │
                        │  id (PK)         │
                        └────────┬─────────┘
                                 │ 1
        ┌────────────┬───────────┼───────────┬──────────────────┐
        │ N          │ N         │ N         │ N                │ N
┌───────▼──────┐ ┌───▼──────┐ ┌──▼──────┐ ┌─▼──────────────────┐ ┌▼──────────────────┐
│    users     │ │properties│ │contacts │ │listing_pages       │ │external_service_  │
│ id (PK)      │ │ id (PK)  │ │ id (PK) │ │ id (PK)            │ │configs            │
│ email [UQ]   │ │ title!   │ │property_│ │ property_id! ──────┼─┐│ id (PK)           │
│ role         │ │ status!  │ │  id(可空)│ │ slug! [UQ]         │ ││                   │
│ 无口令字段   │ │ ...      │ │channel_ │ │ status!            │ ││                   │
└──────────────┘ └────┬─────┘ │ kind!   │ │ locale!            │ ││                   │
      ▲               │       │ value!  │ │ custom_domain      │ ││                   │
      │               │       │is_public!│ │ domain_verify_token│ ││                   │
   【全库无任何表     │       └─────────┘ │ domain_verified_at │ ││                   │
     引用 users】     │   ON DELETE CASCADE└────────────────────┘ ││                   │
                      │                                          ││                   │
      ┌───────────────┼───────────────────┬──────────────────────┘│                   │
      │ N             │ N                 │ N                     │                   │
┌─────▼────────────┐ ┌▼──────────────┐ ┌──▼──────────┐             │                   │
│property_         │ │    media      │ │  reminders  │◄────────────┘                   │
│translations      │ │ id (PK)       │ │ id (PK)     │  listing_page_id (可空)          │
│ id (PK)          │ │ property_id!  │ │ property_id!│  ON DELETE SET NULL              │
│ property_id!     │ │ kind!         │ │ kind!       │                                  │
│ locale! [UQ 组合]│ │ storage_key!  │ │ due_at!     │                                  │
└──────────────────┘ └───────────────┘ │ timezone!   │                                  │
                                       │ idempotency_│                                  │
                                       │  key! [UQ]  │                                  │
                                       └─────────────┘                                  │
                                                                                         │
  ON DELETE CASCADE 汇总：contacts / listing_pages / media /                        ◄────┘
  property_translations / reminders 删父行即级联；仅 reminders.listing_page_id 是 SET NULL
```

**关键事实（全部由 `PRAGMA foreign_key_list` 实测得出）**

| 事实 | 含义 |
| --- | --- |
| `listing_pages.property_id` 是 **NOT NULL** | **一套房源只能有一个页面**。没有「一个房东多套房」的容器 |
| **没有任何表引用 `users`** | 重建 `users` 表安全 —— 计划 A 的主张**核实成立** |
| **5 张表引用 `properties`** | 重建 `properties` 危险（级联删除会波及全部子表） |
| `media.property_id` 是 **NOT NULL** | 计划 A 主张必须重建 `media` —— **核实成立** |
| `contacts.property_id` 是**可空** | 存在「工作区级联系方式」，公开页的回落链需要注意 |
| 无房东实体 | 3 条房源 = 3 个页面，实测 1:1 |

### 4.2 目标数据关系图（计划 A 改造后）

```
                  ┌──────────────────┐
                  │   workspaces     │
                  └────────┬─────────┘
                           │ 1
                  ┌────────▼─────────┐
                  │      users       │  ← 重建（加 password_hash / tier / 配额字段）
                  │  id (PK)         │     role 用于鉴权（当前未实现）
                  └────────┬─────────┘
                           │ 1
                  ┌────────▼─────────┐
                  │ landlord_pages   │  ← 新顶层
                  │  id (PK)         │
                  │  user_id!  ──────┼── 归属账号（计划 B 的挂载点）
                  │  slug! [UQ]      │
                  │  owner_name!     │
                  │  max_properties! │  ← 配额快照（计划 B）
                  │  quota_source!   │
                  │  is_showcase!    │  ← 落地页展示位
                  │  status! / locale! / template_id!
                  │  custom_domain / domain_verify_token / domain_verified_at
                  └────────┬─────────┘
                           │ 1
             ┌─────────────┼────────────────┐
             │ N           │ N              │ N
    ┌────────▼───────┐ ┌───▼──────────┐ ┌──▼─────────────┐
    │  properties    │ │   media      │ │   reminders    │
    │ landlord_page_ │ │ property_id  │ │ landlord_page_ │
    │  id (可空!)    │ │  (可空)      │ │  id!           │
    │                │ │ landlord_    │ │ idempotency_key│
    │                │ │  page_id     │ │  = page:kind   │
    └────────┬───────┘ └──────────────┘ └────────────────┘
             │ 1
    ┌────────▼──────────┐  ┌─────────────────┐
    │property_          │  │    contacts     │
    │translations       │  │ landlord_page_id│  ← 公开联系方式上移
    └───────────────────┘  │ property_id(可空)│     到房东页级
                           └─────────────────┘
```

> **注意图中 `properties.landlord_page_id` 标的是「可空!」** —— 这是有意为之：
> SQLite 无法用 `ALTER TABLE ADD COLUMN` 给已有表加 `NOT NULL` 外键列（见 5.1）。
> 计划 A 用「DDL 可空 + 迁移回填 + 服务层校验 + 自检」四重保证实际非空。

### 4.3 主要差异

| 项 | 当前 | 目标 | 迁移难点 |
| --- | --- | --- | --- |
| 顶层实体 | `properties` | `landlord_pages` | 需建新表 + 回填归属 |
| 归属关系 | 1 房源 : 1 页面 | 1 房东 : N 房源 | `properties.landlord_page_id` 只能建成可空 |
| 联系方式 | 房源级（可回落到工作区级） | 房东页级 | 公开记录需上移；工作区级回落必须切断 |
| 提醒归属 | `reminders.property_id!` | `reminders.landlord_page_id!` | 必须重建表 + 去重（否则撞 UNIQUE 索引） |
| 媒体归属 | `media.property_id!` | 可为空 + `landlord_page_id` | 必须重建表 |
| 路由 | `/p/<slug>` | `/<slug>` | 全链路 URL 构造点 + 旧链接 301 |
---

## 五、计划 A 逐项复核

**复核方法**：直接读当前代码与数据库，**不引用方案文档作为事实依据**。方案文本仅作为「待验证的主张」。

### 5.1 「四张表必须重建」的主张核实

| 主张 | 核实结果 | 证据 |
| --- | --- | --- |
| **重建 `users` 是安全的** | ✅ **成立** | `PRAGMA foreign_key_list` 遍历全部 10 张表 → **没有任何表引用 `users`** |
| **重建 `media` 是必要的** | ✅ **成立** | `media.property_id` 实测为 **NOT NULL**，而要支持「房东级媒体」该列必须可空 |
| **重建 `reminders` 是必要的** | ✅ **成立** | `reminders.property_id` 实测为 **NOT NULL**，且 `reminders` 有 UNIQUE 索引 `idx_reminders_idempotency` |
| **不能重建 `properties`** | ✅ **成立** | **5 张表**引用它（`contacts` / `listing_pages` / `media` / `property_translations` / `reminders`），全部 `ON DELETE CASCADE` —— 重建即级联清空 |
| **`ALTER TABLE ADD COLUMN` 加 NOT NULL 外键列会失败** | **未在本次审计中复核** | 该实验需在内存库执行；本报告标注为**未验证** |

> **诚实声明**：上表最后一条本次审计**未亲自复现**。前四条均已用真实数据库核实。
> 方案中关于该 SQLite 限制的论述**引用自方案文档，非本次实测**。

### 5.2 迁移是否会丢数据

对照计划 A 的 15 步，逐类数据判断（基于**当前真实 schema**）：

| 数据类型 | 当前行数 | 迁移风险 | 判断依据 |
| --- | --- | --- | --- |
| 房源 `properties` | 3 | **低** | 计划 A 只加列不重建（因为 5 张表引用它） |
| 照片/视频 `media` | 15 | **中** | 整表重建。计划要求「既有行的 `property_id` 原样保留」—— 若实施时置 NULL，15 张照片全部从页面消失 |
| 提醒 `reminders` | 6 | **中** | 整表重建 + 幂等键重写。同页多房源同类型提醒会撞 UNIQUE 索引 → **整个迁移事务回滚** |
| 联系方式 `contacts` | 5 | **中** | 公开记录（4 条）需上移到房东页级；**私有记录（1 条 `maria@example.pt`, is_public=0）必须原地保留** |
| 多语言译文 `property_translations` | 2 | **低** | 计划 A 不动此表 |
| 域名配置 | 0（`external_service_configs` 为空；`listing_pages.custom_domain` 实测全为 NULL） | **低** | 当前无真实数据可丢 |
| 用户 `users` | 1 | **低** | 无表引用，重建安全；但计划要求把既有用户标记 `is_system=1`，否则会变成登不上的幽灵账号 |
| 审计日志 `audit_logs` | 29 | **低** | 不涉及 |

**结论**：按方案执行不会丢已有数据，但有**三处静默失败点**（media 的 property_id、reminders 去重、contacts 的私有记录），每一处写错都是「迁移成功但数据语义损坏」。

### 5.3 可运行实现状态（四态区分）

| 状态 | 计划 A | 证据 |
| --- | --- | --- |
| **设计文档** | ✅ **有** | `docs/superpowers/specs/2026-10-12-landlord-single-page-redesign.md`（72 KB） |
| **实施计划** | ✅ **有** | `docs/superpowers/plans/2026-10-12-landlord-single-page-phase-a.md`（78 KB，26 任务 / 103 步） |
| **代码已编写** | ❌ **无** | 全仓库搜索 `landlord_pages`：**仅出现在两份文档里，零处源码** |
| **测试通过** | ❌ **无** | 不存在 `landlord_pages` 相关测试 |
| **真实运行验证** | ❌ **无** | 数据库实测**无 `landlord_pages` 表** |

**数据库迁移仍是 v2**，计划 A 的 v3 未落地。

### 5.4 计划 A 的 26 个任务复核

| 项 | 复核结果 |
| --- | --- |
| 任务是否重复 | **未发现重复**。任务 1–7（数据层）串行；8–12（服务层）、13–18（路由）、19–22（后台）、23–26（收口）职责不重叠 |
| 依赖是否遗漏 | **发现 1 处**：计划未覆盖「迁移前**已有备份**如何处置」——旧备份里的 `listing_pages` 在新代码下无法校验 |
| 破坏性操作 | **发现 1 处需注意**：迁移第 13 步 `DROP TABLE listing_pages` **不可逆**。虽有前置备份，但备份在**事务外**由调用方执行，若接线错误则无备份可回滚 |
| 渐进迁移可能性 | **可行，且方案已部分采用**。`properties` 加列就是渐进做法。但 `media`/`reminders` 因 NOT NULL 限制无法渐进 |

### 5.5 目标架构 13 问逐条回答

| # | 问题 | 回答 |
| --- | --- | --- |
| 1 | 是否存在真正的房东实体？ | **不存在**。数据靠 `workspaces`（1 个工作区）→ `properties` 组织。`users` 表存在但**只有 1 行且无任何表引用它** |
| 2 | 一个房东能否关联多套房源？ | **不能**。`listing_pages.property_id` 是 NOT NULL 且实测 3 条房源 = 3 个页面，严格 1:1 |
| 3 | 主页/详情/列表各承担什么职责？ | 目标上：主页=房东级入口+房源列表+房东级联系方式；详情=单套房完整信息；列表=主页的一部分。**当前只有详情页**，无列表页、无房东主页 |
| 4 | `/p/<slug>` 改造影响面 | **见下方文件清单**。核心是 `src/domain/hosting.ts` 的 `buildDefaultPublicUrl` / `buildCustomDomainUrl`（全链路唯一 URL 构造点） |
| 5 | 根路径 slug 与保留路径冲突？ | **存在冲突风险**。保留路径：`/healthz`、`/api/`、`/admin/`、`/media/`、`/p/`、`/`。计划 A 已识别并列入 slug 保留字 |
| 6 | 同名房东/重复 slug/改 slug/删房东如何保证安全？ | `idx_listing_pages_slug` 是 **UNIQUE** → 重复 slug 有数据库兜底。改 slug 由 `nextAvailableSlug()` 处理。**删房东的安全保证尚不存在**（无房东实体）。孤儿页面风险：当前 `listing_pages.property_id ON DELETE CASCADE`，删房源会连带删页面，不留孤儿 |
| 7 | 一个房东能否管理多个域名？ | **不能**。`listing_pages.custom_domain` 是**单值列**，一个页面一个域名。且当前实测全为 NULL |
| 8 | 联系方式隐藏/反爬实际做到了什么？ | **完全没做**。见第七节缺陷 1。**首屏 HTML 明文包含完整电话与微信号** |
| 9 | 四张表为何重建？ | 见 5.1。`users`（加 NOT NULL 列）、`media`（`property_id` 要去掉 NOT NULL）、`reminders`（同 `media`）必须重建；`properties` **不能**重建（5 张表引用） |
| 10 | v2 数据迁移是否丢失？ | 见 5.2。按方案不会丢，但有三个静默失败点 |
| 11 | 26 任务是否有重复/遗漏/不必要破坏？ | 见 5.4。无重复；1 处遗漏（旧备份处置）；1 处不可逆操作需双保险 |
| 12 | 能否渐进迁移？ | **部分可以**。`properties` 加列已是渐进；`media`/`reminders` 受 SQLite 限制无法渐进 |
| 13 | 计划 A 是否已有可运行实现？ | **没有**。四态中只有「设计文档」与「实施计划」两态成立 |

#### 问题 4 的影响面文件清单（实测）

| 文件 | 原因 |
| --- | --- |
| `src/http/routes/public-pages.ts:19/104/124` | 三条公开路由定义 |
| `src/domain/hosting.ts:26/40` | `buildDefaultPublicUrl` / `buildCustomDomainUrl` —— **全链路唯一 URL 构造点**（分享链接、二维码内容、提醒邮件正文、导出 `share-url.txt` 都经此） |
| `src/http/app.ts:117-118` | CSP 的 `allowInlineStyles` 按 `/p/` 前缀判断，路由一变即失效 → **地图与内联样式会被 CSP 拦掉** |
| `src/http/app.ts:197` | 404 页链接指向 `/admin/` |
| `public/admin/views/property-edit.js` | 硬编码 `/p/${slug}/qr.svg` |
| `scripts/smoke.ts` | 5 处 `/p/` 引用；且 `inject` **不跟随 301** |
| `tests/integration/public-page.test.ts`、`tests/services/hosting-service.test.ts`、`tests/services/reminder-service.test.ts`、`tests/integration/security.test.ts` | 断言旧地址 |

---

## 六、计划 B 的架构准备（只分析，不实现）

### 6.1 依赖关系分析

| 关系 | 计划 A 是否已留基础 | 说明 |
| --- | --- | --- |
| 账号 → 房东主页（1:N） | **是** | `landlord_pages.user_id NOT NULL REFERENCES users(id)` 就是挂载点 |
| 房东 → 房源（1:N） | **是** | `properties.landlord_page_id` |
| 会员等级放哪一层 | **`users` 表** | 等级属于账号，不属于页面。计划 A 已给 `users` 加 `tier` / `member_until` |
| 配额放哪一层 | **两层** | 账号级「还能生成几个页面」放 `users`（`free_quota_consumed` / `oneoff_credits`）；页面级「一页最多几套房」放 `landlord_pages.max_properties`（快照） |
| 免费版与付费版区分 | 计划 A 已留 `tier` + `quota_source` | 本次不实现收费 |
| 房源/图片/域名配额 | 部分已留位 | 房源数有 `max_properties`；**图片容量与域名数量配额尚无字段** |
| 落地页 vs 房东主页 | **已区分** | `landlord_pages.is_showcase` + `idx_landlord_pages_showcase(is_showcase, status)` 就是落地页的取数索引 |

### 6.2 是否会因表结构在计划 B 再次大规模重构

**主要风险点**：

1. **图片容量配额无字段** —— 计划 B 需要新增计数字段或独立配额表。`users` 表因无表引用它，**可再次安全重建**，风险低。
2. **域名数量配额无字段** —— `listing_pages.custom_domain` 是单值列。若未来要「一个房东多域名」，需要独立的 `domains` 表。**当前无法预判是否必要**。
3. **`landlord_pages` 新建表时可自由设计**，把配额字段一次留足，可避免二次重构。

**判断**：计划 A 的表结构**对计划 B 是合理的**，`user_id` + `tier` + `max_properties` + `is_showcase` 四个字段覆盖了主要扩展点。
唯一需要提前决策的是**「一个房东多域名」是否要做** —— 如果要做，`custom_domain` 单值列在计划 A 建表时就应该拆出去，否则计划 B 要改表。
---

## 七、安全与隐私问题（按严重程度排序）

> 本节只列**本次实际发现**的问题。通用安全术语不列。

### 🔴 严重：公开页首屏 HTML 明文包含完整联系方式

**问题**：展示页把完整电话、`tel:` 链接、微信号直接渲染进首屏 HTML，**没有任何掩码**。

**证据**（真实抓取 `document.documentElement.outerHTML`）：

```html
<details class="sec" open="">
  <summary>联系方式<span class="hint">+86 138 0000 1234</span></summary>
  <div class="body"><div class="actions">
    <a class="btn" href="tel:+8613800001234">电话 · +86 138 0000 1234</a>
    <span class="btn ghost">微信 · zhang_rent_sh</span>
  </div>
```

**影响**：
- 一条 `curl` 即可批量抓取全部联系方式，无需执行 JS、无需点击
- `<details open>` **默认展开**，连「点一下才显示」这个最弱的屏障都没有
- 房东公开手机号会被爬虫直接采集

**代码位置**：`src/render/page-renderer.ts` 的联系方式渲染段

**性质**：这是**设计缺失**，不是 bug。计划 A 的 Task 15 才实现防抓取（首屏只出掩码 + 点击取回 + IP 限流）。

---

### 🟠 中：`?lang=` 参数产生「英文界面 + 法/德文格式」的混合页面

**问题**：`public-pages.ts:42-46` 用 `isSupportedLocale()` 校验 `?lang=`，该函数接受**全部 12 种**语言；
但界面文案 catalog 只有 zh-CN / zh-TW / en / ja 四套，其余会**回落到英文**。

**实测结果**：

| `?lang=` | 状态 | 区块标题 | 日期格式 | 一致性 |
| --- | --- | --- | --- | --- |
| （无） | 200 | 房源介绍 | 中文 | ✅ |
| `en` | 200 | About | 英文 | ✅ |
| **`fr`** | 200 | **About（英文）** | **法文** | ❌ **混合** |
| **`de`** | 200 | **About（英文）** | **德文** | ❌ **混合** |
| `ja` | 200 | 第 4 套文案 | 中文 | 部分 |
| `xx`（不支持） | 200 | 房源介绍 | 中文 | ✅ 正确回落 |

**影响**：法语用户点开页面看到英文界面但法文日期，观感错乱。

**注**：上一轮只限制了**后台「展示语言」下拉**（`PUBLIC_PAGE_LOCALES`），**未限制公开页的 `?lang=` 参数**。这是收口不彻底的遗留。

---

### 🟠 中：导出包与备份包含完整联系方式，且无警示

**证据**：
```
var/exports/prp_0929714d-*/index.html     电话=含  微信=含
var/exports/prp_0929714d-*/index.en.html  电话=含  微信=含
var/backups/backup-*.zip → db/app.sqlite (176 KB) + uploads/ + manifest.json
```

**影响**：导出包一旦被当作公开页面分发，等于把房东联系方式公开。
备份文件**未加密**，任何拿到文件的人可读取全部数据。

**说明**：导出包含联系方式在功能上是**合理的**（房东要拿走自己的数据），**风险在于分发场景缺乏警示**。

---

### 🟡 低：无 `link[rel=canonical]`

**证据**：浏览器实测 `document.querySelector('link[rel="canonical"]')` → `null`。
有 `og:title` / `og:image` / `og:description` / `meta[name=description]`，缺 canonical 与 `twitter:card`。

---

### 已核查为「无问题」的项

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 路径穿越 | **未发现漏洞** | `GET /p/../../etc/passwd` → **404** |
| 未授权访问后台 API | **正确拦截** | `GET /api/admin/properties` 无 cookie → **401** |
| 不存在的 slug | **正确 404** | `/p/this-slug-does-not-exist` → 404，且不泄露页面是否存在 |
| slug 冲突 | **数据库兜底** | `idx_listing_pages_slug` 是 UNIQUE |
| 备份内含明文口令 | **未发现** | 备份内 `db/app.sqlite` 列名扫描：**无 pass/secret/token/key 字样列**；`users` 表只有 `id/email/role`，**没有口令字段** |

> **重要限制**：本次**未做**完整渗透测试。XSS / SQL 注入 / CSRF / 会话安全的逐行审计由并行调查进行，
> **结果未纳入本报告**。在那些结果出来之前，**不能声称这些方面是安全的**。

---

## 八、测试报告

### 8.1 实际执行结果

| 命令 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | **退出码 0** |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | **tests 272 / pass 272 / fail 0 / cancelled 0 / skipped 0 / todo 0**，耗时 2799.96 ms |
| `pnpm smoke` | **失败**（见第九节） |

### 8.2 浏览器测试路径（390×844 手机视口 + 1600×1080 桌面视口）

| # | 路径 | 结果 |
| --- | --- | --- |
| 1 | `#/properties` 房源列表 | ✅ 3 张卡片，封面、价格、状态标签、slug 均正确 |
| 2 | 卡片右上角编辑按钮 | ✅ 就地展开，显示更新时间与四个操作按钮 |
| 3 | `#/properties/<id>` 编辑页 | ✅ 加载 23 个字段、4 个联想下拉、单价自动计算 |
| 4 | 界面语言切换（中→英→法→意→德→中） | ✅ 侧边栏/标签页/分组/字段标签/按钮/提示全部跟随；**数据不被翻译** |
| 5 | `/p/<slug>` 展示页 | ✅ 200，无横向溢出（scrollWidth 375 < 390） |
| 6 | `?lang=en` | ✅ 界面全英文，用户数据保持原样 |
| 7 | `/p/不存在-slug` | ✅ 404 |
| 8 | `/p/../../etc/passwd` | ✅ 404 |
| 9 | `/api/admin/properties`（无鉴权） | ✅ 401 |

### 8.3 **未能测试**的路径及原因

| 路径 | 原因 |
| --- | --- |
| 新增房源 → 保存 → 刷新 | **用户明令禁止污染现有数据**。未在真实库执行写操作 |
| 删除房源 / 编辑保存 | 同上 |
| 图片加载失败处理 | 未构造 404 图片（会改动数据） |
| 平板视口 | 本次只测了 390 与 1600 两档 |
| **房东账号流程（一个房东只管理自己的房源）** | **不存在此流程** —— 系统无房东实体、无用户登录，无法测试 |
| 自定义域名验证 | 禁止真实公共 DNS 操作 |
| 提醒真实投递 | 禁止真实邮件发送 |

> **诚实声明**：本次**未**用模拟请求代替真实浏览器测试，也**未**声称整个用户流程已通过。
> 凡是会写数据的路径，一律未执行。

---

## 九、已知问题复核：冒烟测试的日期与时间规则

### 9.1 现象

```
冒烟测试中断：断言失败：第 7 天提醒落在发布后第 7 天 delta=6.669天
```

### 9.2 实际失败条件（用项目自身运行时复算，未修改任何文件）

**排期规则**（`src/domain/reminder.ts:49-60`）：

```ts
const shifted = addZonedDays(publishedAt, offsetDays, config.timezone);
const dueAt = zonedHourOfDay(shifted, config.timezone, config.sendWindowStartHour);
```

语义 = **「发布后第 7 天的当地 09:00」**，不是「发布时刻 + 7×24 小时」。

**断言的期望**（`scripts/smoke.ts:272-275`）：

```ts
const d7Delta = (new Date(d7.dueAt).getTime() - publishedAtMs) / 86400000;
assert('第 7 天提醒落在发布后第 7 天', d7Delta >= 7 && d7Delta < 8, ...);
```

**复算结果**（Asia/Shanghai，sendWindowStartHour=9）：

| 发布时刻（当地） | delta | 断言 |
| --- | --- | --- |
| 00:41 | 7.347 天 | ✅ 通过 |
| 03:41 | 7.222 天 | ✅ 通过 |
| 05:41 | 7.138 天 | ✅ 通过 |
| 07:41 | 7.055 天 | ✅ 通过 |
| **09:41** | **6.972 天** | ❌ 失败 |
| **15:41** | **6.722 天** | ❌ 失败 |
| 21:41 | 6.472 天 | ❌ 失败 |
| 23:41 | 6.388 天 | ❌ 失败 |

### 9.3 结论

**该断言只在当地 00:00–09:00 之间运行才会通过。**

它的前提（「提醒落在发布后整 7 天」）与排期规则（「第 7 天的 09:00」）**本身矛盾**。
当前时刻 15:41 落在失败区间，因此必然失败。

**这不是本次审计引入的问题**，也不是近期代码改动的结果 —— `scripts/smoke.ts` 与
`src/services/reminder-service.ts` 自早期提交（`af5e7d4`、`64c3e02`）后未再改动。

**本次未修改该断言**（用户明令不得擅自修复）。正确的修法应是校验「到期时刻是否为当地第 7 天的 09:00」，
而非比较小时数。
---

## 十、性能、维护与代码质量

### 10.1 依赖清单

| 包 | 运行时？ | 用途 |
| --- | --- | --- |
| `fastify` | ✅ | HTTP 框架 |
| `@fastify/cookie` | ✅ | 会话 cookie |
| `@fastify/multipart` | ✅ | 文件上传 |
| `@fastify/static` | ✅ | 后台静态资源（`/admin/`） |
| `qrcode-generator` | ✅ | 二维码生成 |

**5 个运行期依赖，全部为宽松许可**（MIT 类）。详细许可证核对见 `docs/licenses.md`。
未发现重复功能的依赖。

> 各包的**精确 license 字段值**与「是否真被引用」的逐项 grep 验证，由并行调查负责，本报告未纳入。

### 10.2 数据库

| 项 | 发现 |
| --- | --- |
| 索引 | 16 个（见 2.3）。`listing_pages.slug`、`users.email`、`reminders.idempotency_key`、`property_translations(property_id, locale)` 均为 UNIQUE |
| 外键 | 11 条，见 4.1。10 条 `ON DELETE CASCADE`，1 条 `ON DELETE SET NULL`（`reminders.listing_page_id`） |
| `PRAGMA foreign_keys` | **开启**（连接级 = 1，`src/db/database.ts` 显式设置） |
| 孤儿数据风险 | **低**。删房源会级联删除页面、媒体、联系方式、译文、提醒 |
| journal 模式 | `wal` |

### 10.3 废弃文件与测试垃圾

**这是本次审计发现的一项实际问题。**

| 位置 | 内容 | 体积 |
| --- | --- | --- |
| `var/`（根） | **205 个临时文件** —— 累积的补丁文件、探针脚本、拼图 PNG | **6,015 KB** |
| `var/demo-images/` | 42 个原始下载图片（15 张最终照片的候选池） | **23,583 KB** |
| `var/uploads/` | 15 个上传文件（**运行数据，保留**） | 5,790 KB |
| `var/db/` | 数据库（**运行数据，保留**） | 337 KB |
| `var/backups/` | 备份 ZIP | 1,012 KB |
| `var/restore-drill/` | 恢复演练残留 | 1,042 KB |
| `var/exports/` | 导出产物 | 426 KB |

**`var/` 总计约 38 MB**，其中约 **29.6 MB 是可清理的临时产物**。

**git 影响**：`var/` 已被 `.gitignore` 忽略（`git ls-files var/` → **0 个文件**），**仓库未被污染**。
仅为磁盘占用与整洁性问题。

### 10.4 根目录

| 文件 | 判断 |
| --- | --- |
| `轻量化房源管理与一键房源网站生成平台_整合实施方案.txt` | 归档的原始方案，**有意保留** |

---

## 十一、优化建议（按优先级）

### P0 —— 必须优先

| # | 建议 | 为什么 | 依赖 | 影响模块 | 如何验证 |
| --- | --- | --- | --- | --- | --- |
| 1 | **修冒烟断言的时间规则** | 当前任何 09:00 之后跑的运行都必然失败，冒烟测试**已失去信号价值** | 无 | `scripts/smoke.ts:272-275` | 在当地 09:00 前后各跑一次，两次都通过 |
| 2 | **公开页联系方式反爬** | 首屏明文泄露房东手机号与微信号，是**真实的隐私事故风险** | 无 | `src/render/page-renderer.ts`、`routes/public-pages.ts` | `curl` 页面后搜索完整号码，应为 0 命中 |

### P1 —— 建议尽快

| # | 建议 | 为什么 | 依赖 | 影响模块 | 如何验证 |
| --- | --- | --- | --- | --- | --- |
| 3 | **`?lang=` 收口到已翻译语言** | 避免「英文界面 + 法文日期」的混合页 | 无 | `routes/public-pages.ts:42-46` | 遍历 `?lang=fr/de/ja`，断言界面与格式同语言 |
| 4 | **补 `link[rel=canonical]`** | 同页多 `?lang=` 会被判重复内容 | 无 | `page-renderer.ts` | 断言页面含 canonical 且指向无参数地址 |
| 5 | **导出包与备份加敏感数据警示** | 导出含完整联系方式，用户可能误当公开页分发 | 无 | `export-service.ts`、导出 README | `README.txt` 含明确警示 |

### P2 —— 可择机

| # | 建议 | 为什么 | 依赖 | 影响模块 | 如何验证 |
| --- | --- | --- | --- | --- | --- |
| 6 | **清理 `var/` 临时产物** | 约 29.6 MB 无用文件 | 无 | `var/`（非仓库） | `git status` 仍干净；冒烟仍通过 |
| 7 | **备份加密** | 备份含完整数据库与素材，未加密 | 需定密钥管理方案 | `backup-service.ts` | 用错误密钥打开应失败 |
| 8 | **界面语言偏好持久化到账号** | 当前数据语言刷新后丢失 | 依赖计划 B 的账号体系 | `public/admin/` | 刷新后数据语言保持 |

---

## 十二、推荐实施顺序

### 明确建议：**先做 P0-1（修冒烟断言），再做 P0-2（联系方式反爬），然后才考虑计划 A。**

**理由（三条，按重要性）**：

1. **P0-1 让测试恢复信号价值。** 现在冒烟测试**必然失败**，团队会习惯性忽略它 ——
   这比测试本身坏掉更危险，因为将来真正的回归也会被忽略。修复成本极低（一处断言）。

2. **P0-2 是当前唯一真实的用户风险。** 房东的手机号正在明文公开页上。
   这不依赖任何架构改造，独立可做，且正是计划 A 的 Task 15 —— **提前做等于把计划 A 里最有价值的一块先落地**，
   同时验证了「首屏掩码 + 点击取回」方案是否可行。如果这块不好做，计划 A 需要重新评估。

3. **计划 A 应在此之后启动，且启动前必须先决策一个问题：一个房东是否需要多个自定义域名。**
   如果要，`listing_pages.custom_domain` 这个单值列在**建新表时**就该拆成独立表；
   如果不要，保持现状即可。**这个决策放在建表前做成本是零；放在计划 B 做成本是一次改表。**

**不建议**现在直接开始计划 A 的 26 个任务 —— 在冒烟测试失去信号的情况下做 2000 行的结构翻转，
一旦出问题无法用现有测试兜住。

**本次不自动执行任何建议。**

---

## 十三、尚未验证事项

以下事项**本次审计未能验证**，不得视为已通过。

| 事项 | 实际状态 | 原因 |
| --- | --- | --- |
| **真实部署** | **从未发生** | 未做正式部署；参考项目 PropertyWebBuilder 也从未真实部署 |
| **公共 DNS TXT 验证** | **从未发生** | 禁止真实 DNS 修改；`listing_pages.custom_domain` 实测全为 NULL |
| **真实邮件投递** | **从未发生** | SMTP 未投递到真实服务器；禁止真实发送 |
| **地图联网** | **未验证** | 高德/Google 地图密钥未提供；沙箱内无法确认瓦片服务可达 |
| **周边信息查询（Overpass）** | **未验证** | 该接口在本沙箱返回 HTTP 406 |
| **TLS 终止** | **不存在** | 应用不做 TLS 终止，需前置反向代理 |
| **备份加密** | **不存在** | 备份为明文 ZIP |
| **页面图片加载失败处理** | **未验证** | 未构造 404 图片（会改动数据） |
| **平板视口布局** | **未测试** | 只测了 390 与 1600 两档 |
| **模板逐一渲染** | **未验证** | 代码存在多套模板，未逐个渲染确认 |
| **审计日志轮转/上限** | **未验证** | 未测长期累积行为 |
| **服务重启后任务状态恢复** | **未验证** | 未做重启前后对比 |
| **XSS / SQL 注入 / CSRF / 会话安全** | **本报告未覆盖** | 交由并行调查；**结果未纳入本报告** |
| **计划 A 的 SQLite NOT NULL 限制复现** | **未亲自复核** | 需内存库实验；引用自方案文档，非本次实测 |
| 依赖许可证精确字段 | **未逐项读取** | 见 `docs/licenses.md`；本次只确认了依赖清单 |
| 写操作路径（新增/保存/删除） | **未执行** | 用户明令禁止污染现有数据 |

---

## 附录：本次审计执行的全部命令（可复现）

```powershell
# 1. Git 与工作区
git rev-parse --abbrev-ref HEAD ; git log -1 ; git rev-list --count HEAD ; git status --porcelain

# 2. 服务状态
Get-NetTCPConnection -LocalPort 3210 -State Listen
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"
(Get-Process -Id <pid>).StartTime

# 3. 数据库（只读连接）
new DatabaseSync('var/db/app.sqlite', { readOnly: true })
  -> SELECT sqlite_version(), PRAGMA journal_mode, PRAGMA foreign_keys
  -> SELECT * FROM schema_migrations
  -> SELECT name, sql FROM sqlite_master WHERE type IN ('table','index')
  -> PRAGMA foreign_key_list(<每张表>)
  -> PRAGMA table_info(<每张表>)

# 4. 路由提取
Select-String -Path 'src/http/routes/*.ts' -Pattern "app\.(get|post|put|patch|delete)"

# 5. 测试
node node_modules/typescript/bin/tsc --noEmit
node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"

# 6. 冒烟（会写数据，本次仅执行一次以记录失败现象）
node --disable-warning=ExperimentalWarning scripts/smoke.ts

# 7. HTTP 探测（只读 GET）
Invoke-WebRequest 'http://127.0.0.1:3210/p/<slug>?lang=<xx>'
Invoke-WebRequest 'http://127.0.0.1:3210/p/../../etc/passwd'
Invoke-WebRequest 'http://127.0.0.1:3210/api/admin/properties'   # 期望 401

# 8. 浏览器（Playwright MCP）
#    390x844 与 1600x1080 两个视口，见第八节路径表
```

**本次审计未修改任何业务代码、数据库结构、迁移文件、配置文件或现有测试。**
`git status --porcelain` 在审计前后均为空输出。

> 注：审计过程中为执行只读查询，在 `var/` 下新建了若干 `audit-*.mjs` 探针脚本。
> `var/` 已被 `.gitignore` 忽略，**不属于仓库内容**。这些脚本未修改任何业务代码或数据。
---

# 补充：审计副作用更正 + 第二批次发现

> 本节在首版报告之后追加。首版报告中的一处声明**经复核不成立，在此更正**。

## A. 更正：「未写入数据」的声明不准确

首版报告在「最终确认」处写了：

> 数据库 mtime: 10/12/2026 22:47:36（审计开始前即为该值则未写入）

**这个推断是错的。** 该库运行在 **WAL 模式**（`PRAGMA journal_mode = wal`），
写操作先落 `app.sqlite-wal`，主文件 `.sqlite` 的 mtime **只在 checkpoint 时**才更新。
因此「主文件 mtime 未变」**不能**推出「没有写入」。

**实测的写入痕迹**：

```
app.sqlite        180224 B  mtime=2026/10/12 22:47:36   ← 主文件（未 checkpoint）
app.sqlite-wal    181312 B  mtime=2026/10/13 12:03:08   ← 审计期间被写过
app.sqlite-shm     32768 B  mtime=2026/10/13 10:55:46
```

**实际发生的两处写入**：

| 数据 | 变化 | 原因 | 是否我主动为之 |
| --- | --- | --- | --- |
| `listing_pages.view_count` | 22→**31** / 1→**2** / 2→**4** | `GET /p/:slug` 每次都会调 `incrementViewCount` 写库 | **否，但不可避免** —— 你要求「在浏览器中打开展示页」，而看页面本身就会自增 |
| `audit_logs` | 29→**31**（+2 条 `export.zip`） | 打开后台页时浏览器**预取**了 `/api/admin/properties/:id/export.zip` | **否，且我未察觉** |

**诚实定性**：

- 这两处**都不是内容修改** —— 没有房源、照片、联系方式、译文、域名配置被改动，
  没有行被新增/删除（`audit_logs` 的两行是系统按设计自动记录的审计条目）。
- 但**确实是数据库写入**，首版报告「未写入」的表述**不成立**，特此更正。
- `view_count` 的增长是**应用设计的固有行为**：任何一次页面浏览都会自增。
  你要求做真实浏览器测试，就必然触发它。**若要完全避免，只能不打开公开页**，
  但那样「展示页中英文切换」这条就无法实测。
- `audit_logs` 的 2 行来自浏览器对后台页内链接的预取，**我未曾主动请求该端点**。

**当前值**（供后续核对）：

| 页面 | view_count |
| --- | --- |
| 浦东新区精装两居室-近地铁-2-号线 | 31 |
| 目黒区-静かな住宅街の-1ldk | 2 |
| 里斯本-alfama-老城区三居室联排-带露台 | 4 |

`audit_logs` 现 31 行，动作分布：`media.upload` 15、`reminder.schedule` 3、`property.create` 3、
`listing.publish` 3、`listing.create` 3、`translation.save` 2、`export.zip` 2。

**未修改**：业务代码、数据库结构、迁移文件、配置文件、现有测试 —— 这些仍然成立。
`git status --porcelain` 仍只有新增的报告文件。

---

## B. 第二批次发现（补充首版第七、第十节）

### 🔴 严重（新增）：周边信息功能 100% 失败 —— HTTP 头含中文

**问题**：`src/adapters/map.ts:187` 构造请求时把 User-Agent 设成了中文字符串
`'房源展示页周边信息查询'`。**HTTP 头必须是 ByteString（≤255 的字节）**，
含中文会让 `fetch` 在**发请求之前**就抛错。

**实测证据**（两次）：

```
GET /p/<slug>/nearby.json
→ {"available":false,"reason":"周边信息服务不可用：Cannot convert argument to a
   ByteString because the character at index 56 has a value of 25151 which is
   greater than 255.…"}
```

`GET /p/<slug>?nearby=1` 的页面内也会内联渲染出**同一条英文底层异常**。

**影响**：
- 该功能**完全不可用**（不是偶发，是必然）
- 把英文底层异常**直接暴露给访客**
- 测试没抓到：`tests/adapters/map.test.ts` 全部注入 `fetchImpl` 假实现，**永不走真实头序列化**

### 🔴 严重（新增）：`/media/*` 完全无鉴权

**问题**：`src/http/app.ts:214` 的 `/media/*` 路由**没有任何鉴权钩子**
（全局守卫只拦 `/api/admin/`）。任何知道 `storage_key` 的人都能取到文件。

**影响**：**未发布、已撤下**的房源，其照片/视频只要 key 泄露（例如从历史 HTML、导出包、
日志、备份中拿到）就仍可公开访问。撤下房源**并不会**让它的素材失效。

**补充证据**：`storage` 的路径穿越防护是有效的 —— `/media/..%2f..%2fetc%2fpasswd` → **400**、
`/media/../../package.json` → **404**。所以这不是路径穿越问题，而是**授权**问题。

### 🟠 中（新增）：静态导出的 `og:image` 是坏链接

**问题**：`src/services/export-service.ts:113` 用
`html.replaceAll('/media/', 'assets/')` 改写资源路径。
它会**连绝对 URL 里的 `/media/` 一起改掉**。

**实测证据**（检查 `var/exports/prp_0929714d-*/index.html` 产物）：

```html
<meta property="og:image" content="http://127.0.0.1:3210assets/prp_…/…png">
```

**`3210assets` 少了斜杠，是坏 URL。**

**影响**：导出包在离线打开时 `og:image` 必然失效。
（页面内 `<img>` 的相对路径改写是对的，图片本身能离线显示 —— 这点没问题。）

### 🟠 中（新增）：`?lang=` 可绕到未翻译语言（与首版缺陷 2 同源，补充实证）

首版只测了 `fr`/`de`。补充实测确认 **`?lang=ja` 与 `?lang=zh-TW` 同样可绕**：

```
GET /p/<slug>?lang=ja
→ 200，<html lang="ja">
→ 正文仍是中文标题/描述
→ 界面标签变成英文（Contact / Nearby / Available）
```

**产出的是「语言标记撒谎」的页面**，且可被搜索引擎按 `lang="ja"` 收录。

**根因确认**：`public-pages.ts:44` 用的是 `isSupportedLocale`（放行 **12 种**），
而非 `admin-pages.ts:153-155` 那个 `PUBLIC_PAGE_LOCALES`（只放行 **2 种**）。
同一份代码里两个地方口径不一致。

### 🟡 低（新增）：`minimal` 模板的 `showQr:false` 未被消费

`src/render/templates.ts` 里 `minimal` 模板声明了 `showQr: false`，
但 `page-renderer.ts` 的分享区实际只看 `input.includeQr` 参数 ——
**模板的这个字段从未被读取**，因此 `minimal` 模板仍会渲染二维码。

### 🟡 低（新增）：提醒邮件永不真正投递，且正文含内网地址

- `.env` 的 `MAIL_PROVIDER=console` → `src/adapters/mail.ts:58-83` 只把邮件写 stdout。
  该适配器**自己的日志就写明「邮件不会真正投递」**。
- `.env` 的 `PUBLIC_BASE_URL=http://127.0.0.1:3210` → 一旦真发信，
  **邮件正文会带内网地址**，收件人无法访问。
- SMTP 客户端本身是**真实现**（`mail.ts:284-392`，手写 EHLO/STARTTLS/AUTH LOGIN/DATA，
  含 RFC 2047 中文主题与 CRLF 注入防护），但**该代码路径从未在真实环境验证**。

### 🟡 低（新增）：DNS 适配器把「查询失败」与「无记录」混为一谈

`src/adapters/dns.ts:25-28` 吞掉所有异常返回 `[]`。
DNS 超时会被显示成「未查询到任何 TXT 记录」，**误导排查方向**。

### 🟡 低（新增）：删除房源时先删文件后删库，无事务

`property-service.ts:135-151` + `media-service.ts:159-182`：
先调 `storage.remove` 删磁盘文件，再删数据库行。
若数据库删除失败，**素材文件已经丢了**，无法回滚。
（`adapters/storage.ts:82-89` 的 `remove` 还吞掉所有异常。）

### 🟡 低（新增）：备份校验与恢复是两次独立操作

`verifyBackupFile`（`backup-service.ts:226-286`，做逐表行数比对）与
`restoreBackupToDirectory`（`:304-354`，只解包不比对）是**两个独立函数、两个独立 API**。
用户若只点「恢复演练」不点「校验」，**不会得到任何行数比对**。
且恢复只能解包到独立目录，**没有切回 `var/` 的开关** —— 真要恢复须手工拷文件并重启
（代码注释 `:297-302` 已承认）。

### 已核查为「无问题」的补充项

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| HTML 转义 | **实现完整** | `src/render/html.ts` 转义 `& < > " '` 五字符；另有 `safeUrl`（只放行 http/https，阻断 `javascript:` / `data:`）与 `escapeAttribute`、`jsonForScript` |
| 存储路径穿越 | **防护有效** | `/media/..%2f..%2fetc%2fpasswd` → **400**；`/media/../../package.json` → **404** |
| 数据库完整性 | **完好** | `PRAGMA integrity_check` → **ok**；`PRAGMA foreign_keys` → **1** |
| 时区处理 | **实现正确** | `src/util/time.ts` 用 `Intl.DateTimeFormat` 而非硬编码偏移；跨夏令时测试全部通过 |
| 提醒幂等 | **有效** | 实测 6 行，每个 `(property, kind)` 恰好 1 条，key 形如 `prp_851de…:check_day_7` |
| 提醒时区落点 | **正确** | `due_at` 实测为 `2026-10-20T01:00:00.000Z`（= 当地 **09:00**）与 `2026-10-28T01:00:00.000Z` |
| 未发布页 SEO | **做对了** | 未发布页有 `noindex`；预览接口有 `X-Robots-Tag: noindex` |
| 私有联系方式 | **未泄露** | `isPublic=false` 的 `maria@example.pt` **未出现在**公开页 HTML |
| 日志脱敏 | **有机制** | `util/logger.ts` 按键名递归脱敏（`password`/`secret`/`token`/`cookie`/`session` 等 → `REDACTED`） |

### 第二批次新增的「未验证」项

| 事项 | 原因 |
| --- | --- |
| OSM 瓦片真实加载与降级触发 | 本机无外网；降级判定条件是「已加载 0 张且错误≥4」，沙箱内错误事件未达阈值 |
| 并发发布时 slug 唯一约束的竞态 | 需并发写，会改数据，未执行 |
| 守护进程/断电后的恢复 | 未做杀进程演练 |
| 备份 verify / restore-drill 真实执行 | 两者都是 POST 且会写 `var/tmp`，未执行（仅有测试覆盖） |
| `sitemap.xml` / `robots.txt` | 均返回 404，**功能不存在**（不是未验证） |
---

# 补充：性能 / 数据库 / 代码质量 / 依赖 / 日志（第三批次）

> 本节补充首版第十节。**全部结论来自实测**（语句计数探针、`EXPLAIN QUERY PLAN`、`PRAGMA`、符号扫描）。

## C. 性能：实测 SQL 条数（不是估算）

用「在 `ctx.db.prepare` 上打点」的方式实测真实路由的语句数：

| 端点 | SQL 条数 | 判断 |
| --- | --- | --- |
| `GET /p/:slug` 展示页 | **8**（含 **2 组重复查询** + 1 次写） | ❌ 有重复 |
| `GET /api/admin/pages` | 2 页时 **15**，每多 1 页 **+7** | ❌ N+1 |
| `GET /api/admin/properties/:id/listing` | **15** | ❌ aggregate 被算 2 次 |
| `GET /api/admin/properties/:id`（详情） | **11** | ❌ aggregate 被算 2 次 |
| `GET /api/admin/reminders` | **1+N**（2 条时 6） | ❌ 逐条 `getProperty` |
| `GET /api/admin/properties`（列表） | 3 | ✅ 已规避 N+1 |
| `GET /api/admin/properties/:id/media` | 2 | ✅ |
| `GET /media/*.jpg` | 0（纯文件系统） | ✅ |

**`GET /p/:slug` 的完整语句序列（打点原文）**：

```
1 listing_pages WHERE slug=?
2 properties WHERE id=?
3 media WHERE property_id=?
4 contacts WHERE property_id=?
5 contacts WHERE workspace_id=? AND property_id IS NULL
6 property_translations WHERE property_id=?
7 property_translations ...          ← 与 6 完全相同，重复执行
8 UPDATE listing_pages SET view_count=view_count+1
```

- **重复点 A**：`publish-service.ts:248` 已按 slug 拿到 page，`:252` 又用 `page.propertyId` 重查房源。
- **重复点 B**：`public-pages.ts:80` 的 `buildLocaleLinks` → `i18n-service.ts:86` 再查一次 `listTranslations`，而 `findPublicPage`（`publish-service.ts:262`）刚查过。

**每次访问都有一次 UPDATE**（`public-pages.ts:94` → `listing-pages-repo.ts:131`）。
WAL 下**每请求一个写事务**，且 `/p/:slug` 响应**无 `Cache-Control`**（实测无该头）——
**爬虫每爬一次就写一次库**。这是 `view_count` 在本轮审计中被推高的机制。

**图片体积（实测 HEAD）**：

```
/media/prp_.../mv5ihyom-tey3r8lk.jpg
→ 200  Content-Length: 755039  Content-Type: image/jpeg
   Cache-Control: public, max-age=3600
   无 ETag / 无 Last-Modified / 无 Accept-Ranges / 无压缩
```

上传**不做任何缩放或转码**（`media-service.ts:73-107`），`var/uploads` 单图 142 KB–841 KB。
`og:image`（`page-renderer.ts:750-760`）引用的就是同一张全尺寸原图。

**懒加载做对了**：展示页 `page-renderer.ts:125` `index===0 ? "eager" : "lazy"`，
地图瓦片 `mini-map.ts:139`、后台卡片 `properties.js:81`、相册 `property-edit.js:731` 均 lazy。

**媒体 404 无兜底**：全仓 grep 只有 `mini-map.ts:155` 的地图瓦片有 error 监听。
`/media/*` 出错返回 **`application/json` 的 404**（`app.ts:227/231`），浏览器把 JSON 当图片 → 破图。

## D. 后台分页缺失 —— 第 51 条起静默丢失

**这是本轮最实际的功能缺陷之一。**

- API **有**分页：`limit` 上限 200、默认 50（`property-repo.ts:327/213`），`offset`、`sort` 三选一
- **后台 UI 完全没有分页控件**：`public/admin/views/properties.js:137-144` 不传 `limit`/`offset`
- 而 `:158` 用 `state.total` 显示**真实总数**

**后果**：房源超过 50 套时，界面显示「共 120 套」但**只能看到前 50 套，第 51 条起无法访问**，且没有任何提示。

## E. 数据库：缺索引与失效索引（实测 `EXPLAIN QUERY PLAN`）

**该建而没建**：

| 缺的索引 | 影响的查询 | 实测计划 |
| --- | --- | --- |
| `reminders(property_id)` | `listRemindersByProperty`（`reminder-repo.ts:50-55`）、`listRemindersByWorkspace` 的 join | **`SCAN reminders`** |
| `properties(workspace_id, updated_at)` 复合 | 列表默认按 `updated_at DESC` 排序 | **`USE TEMP B-TREE FOR ORDER BY`** |
| `media(property_id, kind, is_cover, sort_order)` | `listPropertiesWithMeta` 的封面子查询 | 现有 `idx_media_property(property_id, sort_order)` 覆盖不到 `ORDER BY is_cover DESC, sort_order` |

**建了但用不上**：

`idx_listing_pages_domain` 存在，但 `listing-page-repo.ts:64` 写的是
`LOWER(custom_domain) = LOWER(?)` —— **函数包裹导致索引失效**，实测 `SCAN listing_pages`
（`hosting-service.ts:82`）。要么改建表达式索引 `ON listing_pages(LOWER(custom_domain))`，要么去掉 `LOWER`。

**设计隐患**：`listing_pages.property_id` 是**非唯一**索引（`migrations.ts:145`），
**没有任何约束保证「一个房源一个发布页」**。而 `listPropertiesWithMeta` 用的是
`LEFT JOIN listing_pages lp ON lp.property_id = p.id`（`property-repo.ts:344`）**没有去重** ——
一旦出现第二行发布页，列表会出现**重复卡片**且 `total` 与实际行数不一致。
当前 3 房源 / 3 发布页，**未触发**。

## F. `var/` 清理会破坏语言包 —— 我造成的一个隐患

第三批次审计发现一条**与我自己本轮工作直接相关**的问题：

`public/admin/i18n-{fr,it,de}.js` 的文件头注释写着「由 `var/i18n-fr.json` 生成」——
也就是说，**`var/` 下的 JSON 是这三个语言包的再生成输入**。

**因此：如果按 P2-6 建议直接删 `var/`，会丢掉法/意/德三个语言包的生成源。**
正确做法是**先把生成脚本与源 JSON 移入 `scripts/` 或 `public/admin/data/`，再清理 `var/`**。

`var/` 下现有约 **150 个**一次性脚本（`patch-*.mjs`、`rev*.patch`、`fix*.mjs`、`verify*.mjs`、
`*.py`、`sheet*.png`、`i18n-*.json`、`_keys.json`、`contact-sheet.png` 等）。

**不是废弃物的**：`demo/photos/`（15 张 CC0 图 + `ATTRIBUTION.json`）——
`scripts/seed.ts:31` 的 `PHOTO_DIR='demo/photos'` **真正在用**，且 README 与 `docs/licenses.md` 有署名义务，**不可删**。

## G. 重复实现与死代码

**HTML 转义有 4 份**：
`src/render/html.ts:17`、`html.ts:44`、`src/render/icons.ts:106`、
`src/render/mini-map.ts:234/240`、`src/render/qrcode.ts:81`、前端 `public/admin/ui.js:8`。
其中 icons / mini-map / qrcode 三份**都不做 `escapeAttribute` 的换行折叠**。

**日期格式化 4 份**：`util/time.ts:133`、`domain/i18n.ts:127`、`page-renderer.ts:762`、
前端 `ui.js:64/76/93`（**写死 `'zh-CN'`，忽略工作区默认语言**）。

**拼 URL 4 份**：`page-renderer.ts:86`、`public-pages.ts:231`、
`admin-properties.ts:98` 手拼 `/media/${coverStorageKey}`、前端 `property-edit.js:726` 再拼一次。

**模板层是「假分化」**：`templates.ts:25-26` 声明了 `heroLayout` 与 `showQr`，
但渲染器里 **`heroLayout` 只比较过 `'overlay'` 一次**（`page-renderer.ts:648`），
**`showQr` 从未被读取**。3 个模板实际只差 CSS 变量与一张 `aspect-ratio`。
另 `page-renderer.ts:743` 那行 `includeQr ? '' : ''` 是**空三元，纯噪声**。

**超长函数**：`renderListingPage` 113 行、`dispatchDueReminders` **186 行**（6 路分支）、
`galleryScript` 82 行、`SmtpMailProvider.send` 96 行。

**未被引用的导出（18 处）**：
`db/database.ts:46 transaction`、`listing-page-repo.ts:144 deleteListingPage`、
`reminder-repo.ts:201 deleteReminder`、`contact-repo.ts:86 updateContact`、`:93 deleteContact`、
`:130 listContactsWithSource`、`reminder-service.ts:403 listRemindersForProperty`、
`domain/listing-page.ts:154 assertRenderable`、`domain/property.ts:210 hasCoordinates`、
`:215 propertyStatusLabel`、`:233 isArchived`、`domain/i18n.ts:52 COMMON_CURRENCIES`、
`:193 availableLocales`、`util/ids.ts:36 isIdOf`、`render/html.ts:49 jsonForScript`、
`render/mini-map.ts:40 tileUrlFor`、`http/security.ts:30 signPayload`、`domain/errors.ts:94 forbidden`。

前端死代码：`ui.js:93 fmtDate`、`combobox.js:105 fillDatalist`、`i18n.js:432 allKeys`。

## H. 依赖（**区分清楚 ✅**，但文档过期）

5 个 `dependencies` + 2 个 `devDependencies`，`pnpm-lock` 与 `package.json` 一致，无残留包。

| 包 | 安装版本 | 许可证 | 真被使用 | 引用位置 |
| --- | --- | --- | --- | --- |
| `fastify` | 5.12.5 | **MIT** | 是 | `http/app.ts:10` |
| `@fastify/cookie` | 11.1.3 | **MIT** | 是 | `http/app.ts:11/61` |
| `@fastify/multipart` | 9.4.0 | **MIT** | 是 | `http/app.ts:12/62` |
| `@fastify/static` | 8.3.0 | **MIT** | 是 | `http/app.ts:13/80` |
| `qrcode-generator` | 2.0.4 | **MIT** | 是 | `render/qrcode.ts:9/40` |
| `typescript` (dev) | 5.9.3 | **Apache-2.0** | 是 | `pnpm typecheck` |
| `@types/node` (dev) | 24.19.2 | **MIT** | 是 | `tsconfig.json` |

无重复功能依赖（HTTP 只用 fastify；ZIP/时区/校验/SMTP/PNG **全部自研**）。

**`docs/licenses.md` 已过期**：
- 第 48-50 行仍把 **`zod`** 记为「声明依赖但无引用」—— **当前 `package.json` 里已经没有 zod**
- 第 60 行仍在描述**已删除的 Leaflet / `unpkg.com` 方案**（`http/app.ts:74` 与 `security.ts:124` 均已移除）

## I. 日志与重启恢复

**日志内容**：自研 JSON logger（`util/logger.ts:49-75`），仅 6 处 emit。
Fastify 自身 `logger:false`（`http/app.ts:55`），**不记录请求体** → 口令正文不会进日志 ✅。
`redact()` **按键名**递归脱敏（password/secret/token/apikey/cookie/session）✅。
`admin-auth.ts:46/64` 只记 IP，登录成功/失败都不含口令 ✅。

**但「按键名」脱敏的盲区**：
- `http/app.ts:173-178` 记录 `request.url` —— **query string 原样进日志**，将来若把 token 放 URL 就会泄漏
- `mail.ts:70-75` 的 `ConsoleMailProvider` 会写 `to` 邮箱 +**正文前 500 字**（当前 `MAIL_PROVIDER=console` 是默认值）

**重启后可以恢复**：房源 / 发布状态 / `publishedAt` / `withdrawnAt` / `view_count` / 译文 /
联系方式 / 媒体记录 / `reminders`（`status`/`attempts`/`due_at`/`last_error`/`idempotency_key` **全部落库**）/
`audit_logs`。**提醒投递状态在库里，不在内存** ✅。

**重启后不能恢复**：
- **时间旅行状态** —— `FakeClock` 只在内存（`app-context.ts:69`）
- 登录限流封禁窗口（内存 `Map`）
- 地图周边信息 24h 缓存（`adapters/map.ts:131`）

**恢复期缺口**：提醒投递循环是 `setInterval(...).unref()`（`server.ts:50-70`），
**没有「启动即扫一次」** —— 停机跨越 `due_at` 的提醒要等最多 **60 分钟**才补发。

**内存无上限增长（长时间运行的真实风险）**：
- `LoginRateLimiter.state` 的 **`prune()` 从不被调用**（`security.ts:205`）
- `OsmMapProvider.cache` **从不淘汰**（`map.ts:131/235`）

## J. 高价值补充发现

### 🔴 严重（新增）：三个后台接口接受**任意路径**，其中两个会**写文件**

| 接口 | 问题 |
| --- | --- |
| `admin-backup.ts:28-35` `POST /backups/verify` | 接受任意 `file` 路径并**读取** |
| `admin-backup.ts:38-50` `POST /backups/restore-drill` | 接受任意 `targetDir` 并**写入文件到该目录** |
| `admin-export.ts:39` `POST /properties/:id/export` | `outDir` **同样未做目录白名单** |

**性质**：这是**已登录管理员权限内**的路径未受限（不是未授权访问），
但配合「固定后台口令 + 无限流」的现状，风险被放大。
**本次只做静态阅读，未实际调用这三个写接口。**

### 🟡 低（新增）：`scripts/seed.ts` 可能误判并重复写入

`scripts/seed.ts:181` 用 `listProperties({ limit: 1 })` 判空，
而该查询**默认排除 archived**（`property-repo.ts:182-184`）——
若卡片全部归档，seed 会**误判为空**并可能重复写入 demo 数据。

### 🟡 低（新增）：`?lang=` 与 `PUBLIC_PAGE_LOCALES` 口径不一致（已在 B 节记录）

## 本批次新增的「未验证」项

| 事项 | 原因 |
| --- | --- |
| 大数量级性能 | 库里只有 3 房源；N+1 的**增长斜率**由代码结构推出，未在 1000 房源上实测 |
| 圈复杂度量化指标 | 环境无 eslint/complexity 工具，按函数行数与分支数人工判定 |
| 传递依赖许可证 | 只核了 7 个直接依赖，`pnpm-lock` 里的传递依赖未逐一核 |
| 备份内存峰值 | `createBackup` 把快照 + 全部素材读进内存再拼 STORE 模式 ZIP，未在 GB 级 uploads 上压测 |
| 图片 404 的像素级表现 | 结论来自「无 onerror + `/media/*` 返回 application/json 404」，未见实际截图 |
| `/p/:slug` 无 `Cache-Control` 是否有意 | 代码注释强调「永远实时渲染」，无法判断是设计还是遗漏 |
---

# 补充：安全与隐私实测（第四批次）

> 首版第七节中标注「由并行调查进行、未纳入本报告」的 XSS / SQL 注入 / CSRF / 会话安全，
> **本节给出实测结果**。逐项附代码位置与实测输出。

## K. 会话与 Cookie（**实现正确**）

`src/http/routes/admin-auth.ts:56-61`：

```ts
reply.setCookie(cookieName, token, {
  path: '/',
  httpOnly: true,                                              // ✅ 阻断 JS 读取
  sameSite: 'lax',                                             // ✅ 阻断跨站 POST 携带
  secure: ctx.config.publicBaseUrl.startsWith('https://'),     // ✅ HTTPS 下自动开启
  maxAge: Math.floor(sessionTtlMs / 1000),
});
```

会话为 **HMAC 签名的 HttpOnly Cookie**（`admin-auth.ts:7` 注释即写明）。

## L. 会话密钥（**有默认值，但生产被强制校验**）

`src/config.ts:188` 的默认值是 `'please-generate-a-long-random-session-secret-32chars'`，
但 `config.ts:284-288` 在启动检查里拦截：

```ts
if (config.sessionSecret.startsWith('please-generate')) {
  problems.push('生产环境必须设置真实的 SESSION_SECRET');
}
if (config.sessionSecret.length < 32) {
  problems.push('SESSION_SECRET 长度至少 32 字符');
}
```

**判定**：默认值存在但**生产环境会被启动检查拒绝**，设计合理。
（当前 `.env` 是否已设为强随机值 —— **未验证**，我未读取 `.env` 中的实际密钥内容。）

## M. 登录限流（**存在，但有内存泄漏**）

`src/http/security.ts:151-193` 的 `LoginRateLimiter`：

```
maxAttempts = 5          默认 5 次
windowMs    = 15 分钟
blockMs     = 15 分钟
```

超限后 `blockedUntil` 封禁 15 分钟。**限流是存在的**，不是裸奔。

**但**：`security.ts:205` 的 `prune()` **从未被任何地方调用** ——
`state` 这个 `Map` 只增不减，**长时间运行会无限增长**。
另外状态在**内存**里，**重启即可绕过封禁**。

## N. CSRF（**无显式防护，靠 SameSite 兜底 —— 但有一处 GET 写操作**）

**实测**：全仓库 grep `csrf|CSRF|origin|Origin|referer|Referer` → **零命中**。
**没有任何 Origin / Referer 校验**，也没有 CSRF token。

**主要防线是 `SameSite=lax`**：跨站的子资源请求（`<img>`、`<script>`、`fetch`）不携带 cookie，
因此所有 **POST / PUT / PATCH / DELETE** 写接口实际上是安全的。

**但发现一处「用 GET 做写操作」**（`src/http/routes/admin-export.ts:12-31`）：

```ts
app.get('/api/admin/properties/:id/export.zip', async (request, reply) => {
  const result = await exportListingAsZip(ctx, request.params.id, {...});
  return reply.type('application/zip')...;
});
```

**这是一个会写库的 GET** —— 它会产生导出压缩包并写入 `audit_logs`。
本轮审计中观察到的 2 条 `export.zip` 审计记录（10:00:44 / 10:00:56）
就是浏览器**预取该链接**时产生的（见 A 节）。

**风险等级：低**。`SameSite=lax` 下，跨站的 `<img>`/`<script>` 引用**不会**携带 cookie，
只有**顶层导航**会 —— 攻击者需要诱导用户点击链接，且后果仅限于「生成一个导出包 + 一条审计记录」。
但这**违反 HTTP 语义**（GET 应当是安全方法），建议改为 POST。

## O. SQL 注入（**未发现漏洞**）

`src/db/repositories/` 下全部查询使用**参数绑定**（`db.prepare(sql).run(...params)` / `.get(...params)`）。
搜索时用 `likePattern()`（`src/db/sql.ts:60`）配合 `ESCAPE '\'` 转义 `%` 与 `_`，
**没有发现把用户输入直接拼进 SQL 文本**的地方。

## P. XSS（**转义实现完整**）

`src/render/html.ts`：

```ts
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] ?? ch); }
export function safeUrl(value) { /* 只放行 http/https；阻断 javascript: 与 data:；// 开头一律拒绝 */ }
export function escapeAttribute(value) { return escapeHtml(value).replace(/[\r\n]/g, ' '); }
export function jsonForScript(value) { /* 内联 JSON 安全化 */ }
```

五字符全转义 + **危险协议白名单** + 属性换行折叠 + 内联 JSON 处理，覆盖完整。

**但转义实现有 4 份**（见 G 节），其中 `icons.ts:106`、`mini-map.ts:234/240`、`qrcode.ts:81`
三份**不做换行折叠**，语义与 `html.ts:45` 的 `escapeAttribute` **并不等价**。
当前调用点未触发问题，但这是**未来改动的隐患**。

## Q. 路径穿越（**防护有效**）

实测：

```
GET /media/..%2f..%2fetc%2fpasswd   → 400
GET /media/../../package.json       → 404
GET /p/../../etc/passwd             → 404
```

`src/adapters/storage.ts` 的 `assertSafeKey` + `resolveKeyPath` 双重校验有效。

## R. 🔴 严重（新增）：三个后台接口接受**任意路径**，其中两个会**写文件**

| 接口 | 代码位置 | 问题 |
| --- | --- | --- |
| `POST /api/admin/backups/verify` | `admin-backup.ts:28-35` | 接受任意 `file` 路径并**读取该文件** |
| `POST /api/admin/backups/restore-drill` | `admin-backup.ts:38-50` | 接受任意 `targetDir` 并**向该目录写文件** |
| `POST /api/admin/properties/:id/export` | `admin-export.ts:39` | `outDir` **同样没有目录白名单** |

**性质**：需要**已登录的后台会话**，因此不是未授权访问。
但配合以下现状，风险被放大：
- 后台是**固定口令**（`ADMIN_PASSWORD` 环境变量），无多用户、无二次验证
- 限流只在内存且**重启可绕过**

**影响**：拿到后台会话后可读 `.env`（含 `SESSION_SECRET`、`ADMIN_PASSWORD`）等任意文件，
可向任意目录写文件。

**建议**：把路径限制在 `dataDir` / `backupDir` / `uploadDir` 之内 ——
可直接复用 `src/adapters/storage.ts` 里已有的越界校验思路。

**本次未实际调用这三个写接口**，以上为静态阅读结论。

## S. 🟠 中（新增）：`ensureListingPage` 是「先查再插」且**没有事务**

- `listing_pages.property_id` 是**非唯一**索引（`migrations.ts:145`）
- 「一个房源至多一个发布页」**只由应用层保证**：`publish-service.ts:45-60` 的「先查再插」
- `src/db/database.ts:46` 有现成的 `transaction()`，但**全仓库零调用**

**影响**：并发发布（两个请求同时进入）可能插入两条发布页。
届时 `listPropertiesWithMeta` 的 `LEFT JOIN listing_pages`（`property-repo.ts:344`）**不去重**，
列表会出现**重复卡片**且 `total` 与实际行数不一致。

**当前 3 房源 / 3 发布页，未触发。** 且数据库唯一索引不覆盖此列，**没有最终防线**。

## T. 🟡 低（新增）：地图降级文案读取一个从不存在的属性

`src/render/mini-map.ts:158` 读 `el.dataset.failMessage`，
但 `renderMiniMap()`（`:55-75`）**从未输出 `data-fail-message`**。
因此该自定义文案**永远失效**，只会走默认值「地图瓦片不可用」。

## U. 🟡 低（新增）：`getListingPageBySlug` 不校验 `workspace_id`

`listing-page-repo.ts:50-55`，而 `findPublicPage`（`publish-service.ts:248`）
靠 `status='published'` 而非租户做隔离。

**当前单工作区，不构成实际漏洞**；但将来做多工作区（计划 B）时会变成**越权读取**。

## V. 🟡 低（新增）：日志脱敏的盲区

- `logger.ts` 的 `redact()` 是**按键名**匹配（`password`/`secret`/`token`/`cookie`/`session` 等）
- 因此 `http/app.ts:173-178` 记录的 `request.url`（含 query string）**会原样入日志** ——
  将来若把 token 放进 URL 就会明文泄漏
- `mail.ts:70-75` 的 `ConsoleMailProvider`（当前默认 `MAIL_PROVIDER=console`）
  会记录收件邮箱 + **邮件正文前 500 字**
- 日志**只写 stdout，无文件、无轮转、无持久化** —— 非守护方式启动则随进程消失

**已做对**：`admin-auth.ts:46/64` 登录成功/失败**只记 IP，不含口令**；
Fastify 自身 `logger: false`（`app.ts:55`），**不记录请求体**，口令不会进日志。

## 安全结论汇总（按严重度）

| 级别 | 问题 | 位置 |
| --- | --- | --- |
| 🔴 严重 | 公开页首屏明文泄露完整电话与微信号 | 首版第七节缺陷 1 |
| 🔴 严重 | 周边信息功能 100% 失败（HTTP 头含中文），且暴露英文底层异常 | B 节 |
| 🔴 严重 | 三个后台接口接受任意路径读写（需已登录） | R 节 |
| 🔴 严重 | `/media/*` 完全无鉴权 | B 节 |
| 🟠 中 | `?lang=` 可绕到未翻译语言，产出「语言标记撒谎」的页面 | B 节 |
| 🟠 中 | `ensureListingPage` 先查再插且无事务，无唯一约束兜底 | S 节 |
| 🟠 中 | 导出包 `og:image` 是坏 URL（`3210assets`） | B 节 |
| 🟠 中 | 导出包 / 备份含完整联系方式且无警示 | 首版第七节缺陷 3 |
| 🟡 低 | CSRF 无显式防护；一处 GET 写操作（`export.zip`） | N 节 |
| 🟡 低 | 登录限流 `prune()` 从不调用，内存无上限增长 | M 节 |
| 🟡 低 | 日志按 key 脱敏，值内秘密抓不到；不落盘 | V 节 |
| 🟡 低 | 地图降级文案失效；`getListingPageBySlug` 不校验 workspace | T / U 节 |
| 🟡 低 | 无 canonical / hreflang / robots.txt / sitemap.xml | 首版第七节缺陷 4 |

**已核查无问题的**：Cookie 标志、会话密钥生产校验、路径穿越防护、
SQL 注入（全部参数绑定）、XSS 转义（五字符 + 协议白名单）、
数据库完整性（`integrity_check`=ok、`foreign_key_check` 空）、
孤儿数据（磁盘 15 文件 ↔ DB 15 记录双向一致）、私有联系方式不外泄。

## 第四批次新增的「未验证」项

| 事项 | 原因 |
| --- | --- |
| `.env` 中 `SESSION_SECRET` 的实际强度 | 未读取密钥内容（属敏感数据） |
| 三个任意路径接口的**实际可利用性** | 未调用这些写接口（会写文件） |
| 并发发布触发重复发布页 | 需并发写操作，会改数据，未执行 |
| `ADMIN_PASSWORD` 的强度与轮换 | 属部署配置，未评估 |
---

# 目标功能差距表（合并视图）

> 本节把散落在第三、七、十节与各补充节的内容合并成一张表，
> 按用户要求给出 **当前状态 / 证据 / 风险 / 优先级 / 建议** 五列。
> 优先级：**P0** = 必须优先；**P1** = 尽快；**P2** = 可择机。

## 与「房东单页生成器」目标的差距

| 功能 | 当前状态 | 证据 | 风险 | 优先级 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **房东实体** | ❌ **不存在** | `sqlite_master` 无 `landlord_pages`；全库无任何表可代表房东 | 目标架构无法落地 | P1（计划 A 前置） | 按计划 A 建表 |
| **一房东多房源** | ❌ **不可能** | `listing_pages.property_id` 实测 NOT NULL；3 房源 = 3 页面 | 同上 | P1 | `properties.landlord_page_id` |
| **房东主页 / 房源列表页** | ❌ **不存在** | 公开路由仅 3 条，无列表路由 | 目标形态缺失 | P1 | 计划 A Task 16 |
| **`/<slug>` 根路径路由** | ❌ **未实现** | `public-pages.ts:19/104/124` 均为 `/p/` 前缀 | 目标地址不可用 | P1 | 计划 A Task 13-14（含 301 兼容） |
| **联系方式防抓取** | ❌ **未实现** | 首屏 HTML 明文含 `+86 138 0000 1234` 与微信号，`<details open>` 默认展开 | **真实的隐私事故风险** | **P0** | 首屏只出掩码 + 点击取回 + IP 限流 |
| **多语言（展示页）** | ✅ **中英已可用** | `?lang=en` 实测界面全英文、数据不动；catalog 有 4 套 | 其余语言回落英文 | P2 | 已收口为 2 种，按需扩展 |
| **多语言（后台界面）** | ✅ **五语言可用** | 中/英/法/意/德 × 280 条，实测切换正常 | 服务端提示仅中文 | P2 | 按需 |
| **账号 / 登录 / 会员 / 配额** | ❌ **完全不存在** | `users` 表仅 1 行，且**无任何表引用它**；无 `password_hash` 列 | 计划 B 全部未开始 | P2（计划 B） | 见第六节，`user_id` 挂载点已留 |
| **落地页（展示位）** | ❌ **不存在** | 无 `is_showcase` 字段 | 计划 B 依赖 | P2 | 计划 A 建表时留字段 |

## 已实现但存在缺陷的功能

| 功能 | 当前状态 | 证据 | 风险 | 优先级 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **周边信息查询** | ❌ **100% 失败** | `adapters/map.ts:187` UA 含中文 → `ByteString` 抛错（实测两次）；页面暴露英文异常 | 功能完全不可用 + 信息泄露观感 | **P0** | UA 改 ASCII |
| **冒烟测试** | ❌ **必然失败** | 断言 `delta>=7`，规则是「第 7 天 09:00」；实测 09:41 后发布全部失败 | **测试失去信号价值**，真回归会被忽略 | **P0** | 改为校验「当地第 7 天 09:00」 |
| **`/media/*` 鉴权** | ❌ **无鉴权** | `app.ts:214` 无守卫；未发布房源媒体仍可取 | 撤下房源不失效 | P1 | 加鉴权或签名 URL |
| **后台任意路径读写** | ❌ **未受限** | `admin-backup.ts:28-35`（读任意 file）、`:38-50`（写任意 targetDir）、`admin-export.ts:39`（outDir） | 拿到会话可读 `.env`、写任意目录 | P1 | 限制在 dataDir 内 |
| **导出包 `og:image`** | ⚠️ **坏链接** | `export-service.ts:113` `replaceAll('/media/','assets/')` → `3210assets/...`（产物实证） | 分享预览失效 | P1 | 只改写相对路径 |
| **后台分页** | ❌ **缺失** | API 有 `limit/offset`（上限 200），但 `properties.js:137-144` 不传；`:158` 显示真实总数 | **第 51 条起静默丢失** | P1 | 前端补翻页 |
| **图片优化** | ⚠️ **零优化** | 上传不缩放（`media-service.ts:73-107`）；实测单图 755 KB；无 ETag/Last-Modified | 移动端首屏重；反复下载 | P1 | 生成多尺寸 WebP + ETag |
| **媒体 404 兜底** | ❌ **无** | 全仓无 `onerror`；`/media/*` 404 返回 `application/json` | 访客看到破图 | P1 | `<img onerror>` 降级 |
| **`?lang=` 白名单** | ⚠️ **口径不一致** | `public-pages.ts:44` 用 `isSupportedLocale`（12 种）而非 `PUBLIC_PAGE_LOCALES`（2 种）；`?lang=ja` 实测产出 `<html lang="ja">` 的混杂页 | 搜索引擎错误收录 | P1 | 统一用 2 种白名单 |
| **canonical / hreflang / robots / sitemap** | ❌ **缺失** | 实测均为 404 或无该标签；OG 标签已有 4 条 | 重复内容判定 | P2 | 补 canonical + sitemap |
| **展示页缓存** | ⚠️ **无 Cache-Control** | 实测响应无该头，且每次访问 `UPDATE view_count` | 爬虫每爬一次写一次库 | P2 | 采样计数或加短缓存 |
| **`ensureListingPage` 事务** | ⚠️ **先查再插无事务** | `publish-service.ts:45-60`；`database.ts:46` 有 `transaction()` 但**零调用**；`listing_pages.property_id` 非唯一 | 并发可能插重复页，无唯一约束兜底 | P2 | 补唯一索引或事务 |
| **N+1 查询** | ⚠️ **多处** | `/p/:slug` 8 条（2 组重复）；`listPagesAdmin` 每行 7 条；`listRemindersAdmin` 1+N | 数据量大后线性变慢 | P2 | 见 C 节逐条建议 |
| **缺索引** | ⚠️ **4 处** | `reminders(property_id)` → `SCAN reminders`；`LOWER(custom_domain)` 使索引失效；排序走 `TEMP B-TREE` | 查询退化 | P2 | 见 E 节 |
| **图表/模板分化** | ⚠️ **假的** | `templates.ts:26` 的 `showQr` **从未被渲染逻辑读取**；`heroLayout` 只比较过 `'overlay'` | 3 个模板实际只差 CSS | P2 | 要么实现，要么删字段 |
| **地图降级文案** | ⚠️ **永远失效** | `mini-map.ts:158` 读 `dataset.failMessage`，但 `renderMiniMap()` 从不输出该属性 | 自定义文案无效 | P2 | 输出该属性 |
| **CSRF** | ⚠️ **靠 SameSite 兜底** | 全仓无 Origin/Referer 校验；`export.zip` 是**会写库的 GET** | 低（Lax 下 `img` 不携带 cookie） | P2 | 改 POST + 加 Origin 校验 |
| **登录限流内存** | ⚠️ **无上限增长** | `security.ts:205` `prune()` 从不调用；状态在内存，重启可绕过 | 长时间运行内存增长 | P2 | 调用 `prune()` 或改 LRU |
| **备份加密** | ❌ **不存在** | 备份为明文 ZIP，含完整 DB + 全部素材 | 文件泄露即全量泄露 | P2 | 需先定密钥管理 |
| **备份/导出内存** | ⚠️ **全量驻留** | `backup-service.ts:122-175` 快照+素材读入内存再拼 STORE ZIP | GB 级素材可能 OOM | P2 | 改流式 |
| **`docs/licenses.md`** | ⚠️ **已过期** | 仍记 `zod`（已删）与 Leaflet/`unpkg`（已删） | 许可证核对失真 | P2 | 同步文档 |
| **`var/` 清理** | ⚠️ **约 150 个临时脚本** | 全部 gitignore，未污染仓库；**但 `i18n-{fr,it,de}.js` 的生成源在此** | 先删会丢语言包再生成输入 | P2 | **先迁生成脚本再清理** |
| **死代码** | ⚠️ **18 处未引用导出** | `transaction`、`deleteListingPage`、`loginRateLimiter.prune` 等 | 维护负担 | P2 | 按 G 节清单清理 |

## 已实现且经本次实测确认可用的功能

| 功能 | 证据 |
| --- | --- |
| 房源 CRUD + 卡片列表 + 编辑表单 | 浏览器实测 3 卡片、23 字段、封面/价格/状态标签正确 |
| 图片存储与级联删除 | 磁盘 15 文件 ↔ DB 15 记录**双向一致**，无孤儿 |
| 封面图 | 列表返回 `coverUrl`，无照片时渲染占位 |
| 单价自动计算 | 实测 `单价约 94.97 CNY/m²`（**仅前端**，后端不存） |
| 地址联想（249 国 + 31 省/342 市/2978 区县） | 实测输入「中」「广」正确筛选，级联有效 |
| 表单验证 / 错误提示 | `POST .../validate` 实测返回字段级错误 |
| 价格/面积/币种格式化 | 卡片实测 `8,500 CNY/月`、`2,400 EUR/月` |
| slug 生成与唯一性 | 唯一索引实测存在；中文保留、emoji-only 兜底 `listing` |
| 展示页中英切换 | 实测界面全英文、**用户数据原样保留** |
| 响应式布局 | 390×844 实测**无横向溢出**（scrollWidth 375） |
| 图片懒加载 | 首图 `eager`、其余 `lazy`，实测生效 |
| OG 分享标签 | 实测 4 条（`og:title`/`og:image`/`og:description`/`og:type`） |
| 未发布页 SEO | 有 `noindex`；预览有 `X-Robots-Tag: noindex` |
| 私有联系方式不外泄 | `isPublic=false` 的记录实测未出现在公开页 |
| 路径穿越防护 | `..%2f..%2fetc%2fpasswd` → 400；`../../package.json` → 404 |
| SQL 注入防护 | 全部参数绑定，无字符串拼接 |
| XSS 转义 | 五字符 + 协议白名单 + 属性换行折叠 |
| Cookie 安全标志 | `httpOnly` ✅ `sameSite=lax` ✅ `secure` 随 HTTPS ✅ |
| 会话密钥生产校验 | `config.ts:284-288` 拦截默认值与短密钥 |
| 登录限流**存在** | 5 次 / 15 分钟窗口 / 15 分钟封禁 |
| 数据库完整性 | `integrity_check`=ok；`foreign_key_check` **空**；`foreign_keys`=1 |
| 提醒规则/时区/幂等/重试 | 测试覆盖；实测 `due_at` = 当地 09:00，每 `(property,kind)` 恰好 1 条 |
| 跨夏令时时区换算 | 测试全部通过（`Intl.DateTimeFormat`，非硬编码偏移） |
| 备份行数校验 | 测试验证逐表 `COUNT` 与 manifest 比对 |
| 审计日志 | 31 行 / 7 种动作 |
| 存储/时钟/托管适配器 | 实测 `/healthz` → `storage=local`、`clock=FakeClock`、`hosting=custom_domain` |
| 测试套件 | **272/272 通过，0 失败 0 跳过** |
| 类型检查 | `tsc --noEmit` **退出码 0** |
---

# 🔴🔴 最高优先级：认证可被完全绕过（已亲自复现）

> **本节推翻首版第七节「未授权访问后台 API —— 正确拦截 ✅」的结论。**
> 该结论是我用**字面量路径**测试得出的，**未覆盖编码变体**。特此更正。

## 缺陷

`src/http/app.ts:94-97` 的鉴权守卫用**原始 URL** 判断前缀：

```ts
const path = request.url.split('?')[0] ?? '';
if (path.startsWith('/api/admin/') && !PUBLIC_ADMIN_PATHS.has(path)) {
  // ...401...
}
```

但 **Fastify 的路由匹配用的是解码后的路径**。两者口径不一致：
`/%61pi/admin/overview` 在守卫眼里**不以 `/api/admin/` 开头** → 跳过鉴权；
在路由眼里解码为 `/api/admin/overview` → **正常匹配到 handler**。

## 实测证据（本报告作者亲自复现，全部请求**不带任何 cookie**）

| 请求 | 状态 | 响应 |
| --- | --- | --- |
| `GET /api/admin/overview` | **401** | ✅ 正常拦截 |
| `GET /%61pi/admin/overview` | **200** | ❌ `{"workspace":{"id":"wsp_211413bc-…","name":"我的…` |
| `GET /ap%69/admin/overview` | **200** | ❌ 同上 |
| `GET /%61%70%69/admin/overview` | **200** | ❌ 同上 |
| `GET /api/%61dmin/overview` | **200** | ❌ 同上 |
| `GET /%61pi/%61dmin/overview` | **200** | ❌ 同上 |
| `GET /%61pi/admin/settings` | **200** | ❌（对照 `/api/admin/settings` = 401） |
| `GET /%61pi/admin/backups` | **200** | ❌（对照 `/api/admin/backups` = 401） |

## 私有数据实证（本报告作者复现）

```
GET /%61pi/admin/properties/prp_b3ad74a5-254d-4e6d-b278-23c6423ae251   （无 cookie）
→ 200
→ contacts:
     whatsapp  isPublic=True   +351 910 000 000
     email     isPublic=False  maria@example.pt      ← 私有渠道，公开页面上从不出现
```

`maria@example.pt` 是 `is_public = 0` 的记录 —— 首版报告中我专门验证过它**不会**出现在公开页面上。
现在**匿名即可读取**。

## 写端点同样绕过（本报告作者复现）

```
POST /%61pi/admin/properties/validate   （无 cookie，body {"title":""}）
→ 200  {"valid":false,...}
```

守卫对 POST **完全同样失效**。这意味着匿名者握有**全部写权限**：
增删改房源、发布/撤下、导出到任意目录、恢复备份到任意目录、
推进可控时钟（`DEV_TIME_TRAVEL=true`）、触发提醒投递、绑定域名。

## 为什么测试没抓到

`tests/integration/*.ts` 全部使用**字面量** `/api/admin/...`，
**从未覆盖编码路径**。272 个测试全绿，但这个洞一直在。

## 为什么我之前判错了

我在首版第七节只测了 `/api/admin/properties`（字面量）→ 401，就记为「正确拦截」。
**这是抽样不足导致的误判** —— 我只验证了「守卫拦得住它认识的东西」，
没有验证「守卫是否认识所有到达路由的路径形态」。

## 影响评估

| 维度 | 评估 |
| --- | --- |
| **可利用性** | **完全可利用**。一条 `curl` 即可，无需任何凭据 |
| **暴露面** | 当前服务仅监听 `127.0.0.1:3210`，**未暴露公网** —— 这是唯一的缓解因素 |
| **一旦部署** | **立即成为最高危漏洞**。任何 HTTP 客户端可读写全部数据 |
| **浏览器场景** | 未注册 CORS，浏览器跨站 JS 读不到响应；但 curl / 脚本不受影响 |
| **数据泄露** | 工作区信息、全部房源、**私有联系方式**、审计日志、备份绝对路径、诊断信息 |

## 建议修法（**本次未实施，仅建议**）

在守卫里用**与路由一致的口径**判断。可选方案：

1. **首选**：用 Fastify 已解析的路由信息 —— 在 `onRequest` 钩子里改用
   `request.routeOptions?.url` 或 `request.raw.url` 解码后比较；
2. 或对 `request.url` 先做一次 `decodeURIComponent` 再比较前缀
   （注意需处理解码失败与二次编码）；
3. **更稳妥的架构改法**：不要靠「路径前缀」做守卫，
   改为在**需要鉴权的路由注册处**挂 `onRequest` 钩子（`app.register(..., { onRequest: guard })`），
   让守卫与路由共用同一套匹配 —— 从根上消除口径不一致。

**无论选哪种，都必须补一条测试**：对每个受保护路由，断言其**编码变体**同样返回 401。

## 同类问题：登录限流可被 `X-Forwarded-For` 绕过（高）

`src/http/app.ts:57` `trustProxy: true` + `src/http/routes/admin-auth.ts:31` `const ip = request.ip`
→ 限流键完全由客户端控制。

实测：

```
同一伪造 IP 203.0.113.7 连打 6 次： 401 401 401 401 401 429   ← 限流生效
轮换 198.51.100.1..6 各一次：       401 401 401 401 401 401   ← 永不限流
```

**对本产品尤其严重**：后台是**单一共享口令**，一旦编码绕过被修好，
口令爆破就成为唯一入口，而它现在可以无限次尝试。

## 更新后的安全等级排序

| 新序 | 级别 | 问题 | 位置 |
| --- | --- | --- | --- |
| **1** | 🔴🔴 **严重** | **百分号编码绕过全部后台鉴权（读写全通，含私有联系方式）** | `src/http/app.ts:94-97` |
| 2 | 🔴 严重 | 公开页首屏明文泄露完整电话与微信号 | `page-renderer.ts:450-490/514-538` |
| 3 | 🔴 严重 | 周边信息功能 100% 失败（HTTP 头含中文）+ 暴露英文底层异常 | `adapters/map.ts:185-187/237-253` |
| 4 | 🔴 严重 | 三个后台接口接受任意路径读写 | `admin-backup.ts:44-49`、`admin-export.ts:39` |
| 5 | 🔴 严重 | `/media/*` 完全无鉴权 | `app.ts:214-241` |
| 6 | 🟠 高 | 登录限流可被 `X-Forwarded-For` 绕过 | `app.ts:57`、`admin-auth.ts:31` |
| 7 | 🟠 高 | 无真实认证：role 硬编码、`verifySessionToken` 不读 role | `security.ts:51-78`、`app.ts:97-110` |
| 8 | 🟠 中 | `?lang=` 可绕到未翻译语言 | `public-pages.ts:44` |
| 9 | 🟠 中 | `ensureListingPage` 先查再插且无事务 | `publish-service.ts:45-60` |
| 10 | 🟠 中 | 导出包 `og:image` 坏 URL | `export-service.ts:113` |
| 11 | 🟠 中 | Cookie 无 `Secure`、无服务端吊销、12h TTL | `admin-auth.ts:56-62` |
| 12 | 🟡 低 | 无 CSRF token（仅 SameSite=Lax）+ 状态变更 GET | `app.ts:61` |
| 13 | 🟡 低 | 登录限流 `prune()` 从不调用 | `security.ts:205` |
| 14 | 🟡 低 | 日志按 key 脱敏、不落盘；穿越尝试返回 500 而非 403 | `app.ts:173-178` |
| 15 | 🟡 低 | `app.js:99` 未转义 innerHTML（**可达性未证实**，CSP 亦拦内联脚本） | `public/admin/app.js:99` |

## 本次仍未验证

| 事项 | 原因 |
| --- | --- |
| **全部写操作的端到端效果** | 已证明**匿名可达**（`POST /validate` 200），但**未真正执行任何变更调用** |
| 浏览器真实 CSRF 测试 | 未做 |
| `/admin/..%2f…` 返回 500 的确切原因 | 只观察到「无内容返回」，未泄露文件 |
| `app.js:99` 的 XSS 可达性 | 未能构造可达路径，**未证实可利用** |
| 跨工作区 IDOR | 库里只有 1 个 workspace / 1 个 user，无法实证 |
| 未发布页的真实状态码 | 3 个 `listing_pages` 全部 published，构造需写操作 |
---

# 🔴 计划 A 复核：迁移 SQL 照抄即失败（已亲自核实）

> 本节由「计划 A 逐项复核」调查完成，**关键结论已由本报告作者独立核实**。
> **这一节改变了第十二节的推荐** —— 计划 A **不能**按现有文本直接执行。

## 复现方法

把**真实库的 schema 与全量数据克隆到内存库**（真实文件只读），然后逐步重放计划 A 的 15 步迁移。

## 重放结果（逐字）

```
OK   step1  重建 users              OK   step7  CREATE INDEX idx_properties_landlord
OK   step2  历史数据用户             FAIL step8  回填 properties -> no such column: lp.landlord_page_id
OK   step3  建 landlord_pages        OK   step9  contacts ADD COLUMN + index
OK   step4  从 listing_pages 拷贝     OK   step10 公开联系方式上移
OK   step5  孤儿页 + 临时表           FAIL step11 重建 media -> no such column: bytes
OK   step6  ADD COLUMN 归属列         OK   step12 重建 reminders（静默写入 0 行）
                                    OK   step13 DROP TABLE listing_pages
                                    FAIL step14 自检（nullProps=3）

AFTER: reminders=0（原 6）、listing_pages 表消失、properties 3 条归属全 NULL
```

## 缺陷 1：第 8 步引用了一个不存在的列（**已亲自核实**）

计划 `L718`：

```sql
UPDATE properties SET landlord_page_id = (
  SELECT lp.landlord_page_id FROM listing_pages lp     -- ← listing_pages 没有这一列
  WHERE lp.property_id = properties.id ORDER BY lp.id LIMIT 1
) WHERE EXISTS (...);
```

**核实**：真实 `listing_pages` 的列为
`id, property_id, workspace_id, slug, locale, template_id, status, published_at, withdrawn_at, custom_domain, domain_verify_token, domain_verified_at, view_count, created_at, updated_at`
—— **没有 `landlord_page_id`**。

**必须报错**：`no such column: lp.landlord_page_id`。

**正确写法**应经 `landlord_pages` 关联（第 4 步是按 `id` 1:1 复制的）：

```sql
UPDATE properties SET landlord_page_id = (
  SELECT lpl.id FROM landlord_pages lpl
  WHERE lpl.id = (SELECT MIN(l2.id) FROM listing_pages l2 WHERE l2.property_id = properties.id)
) WHERE EXISTS (SELECT 1 FROM listing_pages l2 WHERE l2.property_id = properties.id);
```

## 缺陷 2：第 11 步的 `media` DDL 与真实表结构不符（**已亲自核实**）

计划 `L909-911` 建的列：`bytes INTEGER NOT NULL`、`width INTEGER`、`height INTEGER`

**真实 `media` 列**：
`id, property_id, kind, storage_key, external_url, `**`original_name`**`, mime_type, `**`byte_size`**`, sort_order, is_cover, source_note, created_at, `**`updated_at`**

| 问题 | 后果 |
| --- | --- |
| 写了 `bytes`，真实列名是 **`byte_size`** | `INSERT ... SELECT bytes FROM media` → **`no such column: bytes`，迁移直接失败** |
| 写了 `width` / `height`，真实**没有**这两列 | 同上失败 |
| **漏写 `original_name`** | 若列名恰好对齐，**原文件名静默丢失** |
| **漏写 `updated_at`** | 若列名恰好对齐，**更新时间静默丢失** |

**这是本计划最危险的一处** —— 因为它有两种失败模式：
一种是**响亮地失败**（当前列名不符，直接报错），
另一种是**安静地损坏数据**（有人"顺手"把列名改对但没注意少了三列）。

## 缺陷 3：第 12 步的去重对 NULL 不安全 → **6 条提醒静默消失**

计划 `L1035` 左右的去重子查询用：

```sql
WHERE p2.landlord_page_id = p.landlord_page_id
```

若 `landlord_page_id` 为 NULL（第 8 步失败后必然全为 NULL），
**`NULL = NULL` 永远不成立** → 子查询命中 0 行 → `INSERT ... SELECT` **写入 0 行**。

**实测结果**：`reminders 6 → 0`。

**三重静默**：
1. `INSERT ... SELECT` 命中 0 行**不报错**
2. 唯一索引 `idx_reminders_idempotency` **不报错**（没有冲突）
3. 计划第 14 步的自检**只查 `properties.landlord_page_id` 与 `landlord_pages.user_id`，不查 reminders 行数**

**即：6 条提醒会无声无息地消失，且没有任何检查会拦住它。**

## 缺陷 4：第 13 步 `DROP TABLE listing_pages` 不可逆

在提醒已丢、归属全 NULL 的状态下，这一步仍会执行。
一旦 COMMIT，`listing_pages` 表与其中的 slug、模板、状态、浏览量、域名配置**全部不可恢复**。

## 修正后可以成功（复核员验证）

把第 8 步按 1:1 关系改写、第 11 步的 DDL 对齐真实列名后重放：

```
nullProps = 0            ✅
contacts 5 → 5           ✅（4 条上移到页级，1 条非公开留在房源级）
media 15 张照片全在        ✅（byte_size 合计 5,928,862 不变，3 张封面）
reminders 6 → 6          ✅
PRAGMA foreign_key_check = 空  ✅
COMMIT 成功               ✅
```

**结论：改造意图是可达成的，但计划里的 SQL 不能直接跑。**

## 计划设计层面的缺陷（复核员发现，本报告作者认可）

| # | 缺陷 | 后果 |
| --- | --- | --- |
| **D1** | **T1 先落「空壳 v3」，T2–T7 再回填它的 `up`** | `runMigrations` 对 `schema_migrations` 里已记录的版本**直接 skip**（`migrations.ts:246-250`），且仓库自己的规则是「已发布的迁移不可修改，只能新增」（`migrations.ts:6-8`）。**只要 T1 落地后有进程打开过数据库，v3 就被记为已应用，T2–T7 的迁移体永久静默不执行，而 `pnpm migrate` 仍报成功。** |
| **D2** | **T7 的备份时机倒置** | T7 Step 6 先 `pnpm start`（`app-context.ts:55-56` 启动即 `runMigrations`），Step 8 才 `cp app.sqlite app.sqlite.before-v3` —— **所谓 before-v3 其实是 after-v3**，T26 的「迁移演练」因此给不出有效证据 |
| **D3** | **R4「备份前置」只接了一半** | `beforeMigrate` 只接到 `migrateToLatest`（`migrate.ts:12`，仅 `pnpm migrate` 用）；**真实启动路径 `createAppContext → runMigrations` 不经过它** → 服务启动时的自动迁移**没有备份** |
| **D4** | **`nextAvailableSlug` 签名错** | 计划写 `nextAvailableSlug(db, base)`，真实是 `src/util/slug.ts:42` 的 `(base, isTaken)`。File Structure 也未列该文件 |
| **D5** | **`buildReminderPlan` 签名错** | 计划写 `buildReminderPlan(page.id, new Date())` 且期望返回项含 `idempotencyKey`；真实是 `(publishedAt, config)`，返回项只有 `{kind, dueAt}`，键在 `reminder-service.ts:71` 生成。**该测试写不出来** |
| **D6** | **漏了 `page-renderer.ts:755`** | 该行用 `input.publicUrl.replace(/\/p\/.*$/,'')` 推导 og:image 的 origin。改成 `/<slug>` 后正则不再命中 → **`og:image` 会指向 `https://host/<slug>/media/…`（404）** |
| **D7** | **行号错**：计划写 `property-edit.js:479` | 真实在 **`:827`**；`:479` 是 `saveTranslations()` |
| **D8** | **保留字校验没有对应任务** | spec §4.2/§4.3 要求集中保留字表 + 命中处理，**26 个任务无一实现** |
| **D9** | **`/assets` 不存在** | spec 的保留前缀含 `/assets`，但本仓库 `public/` 只有 `admin/`，`app.ts` 未注册该前缀 |
| **D10** | **「工作区级联系方式编辑器」不存在** | spec §3.2.1 称其存在；实际 `public/admin/**` 无 `contact` 字样、`src/http` 无 contacts 路由、`insertContact` 唯一调用者是 `scripts/seed.ts:222`。**D21 修的是一条真实存在但当前不可达的路径** |
| **D11** | **`pnpm typecheck` 会因漏改文件而失败** | File Structure 未列：`domain/types.ts`、`adapters/hosting.ts:8`、`scripts/seed.ts`、`admin-properties.ts:25`、`property-repo.ts:344`、`property-service.ts:36/182`、`admin-settings.ts:187-203`、`admin-reminders.ts:38`，以及前端 `pages.js`/`settings.js`/`reminders.js`/`app.js`/`api.js` |

## ⚠️ 更正一条复核员结论（**本报告作者核实后否定**）

复核员称：「spec 说的两处 `max-width:1100px` 在 `styles.css` 里根本不存在，T21 很可能是空操作，『1920px 半屏空白』的论据不成立。」

**该结论是错的，属于读到了「已修复之后」的文件。**

```
$ git log --oneline -S 'max-width:1100px' -- public/admin/styles.css
  79351d7  feat(admin): 房源列表改卡片网格 + 表单改单容器紧凑布局     ← 删除
  d72b99a  feat(ui): 移动端优先的紧凑界面 + 真实演示照片 + 许可收敛   ← 引入
```

该规则**确实存在过**，并且**正是本报告作者在本轮会话的提交 `79351d7` 里删掉的**（两处：`:81` 基础规则与 `:228` 桌面媒体查询）。
当前 `styles.css` 中 `max-width:1100px` 出现 **0 次**，是**修复的结果**，不是「从未存在」。

**T21 已完成，不是空操作。**

## 渐进迁移可行（复核员实测，本报告作者认可）

**不可绕过的物理限制**（`node:sqlite` 实测）：
- `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` → **不存在此能力**
- `ADD COLUMN` 加不了「NOT NULL + REFERENCES」组合
- `PRAGMA foreign_keys = OFF` 在**事务内是 no-op**（实测复现）

**除此外全部可纯追加完成**：
- `ADD COLUMN note TEXT NOT NULL DEFAULT ''` ✅
- `ADD COLUMN parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE`（可空）✅
- `DROP COLUMN`（非主键列）✅
- `foreign_keys` 只在事务外可切 ✅

**四步渐进路径**（每步可独立发布/回滚）：

1. **v3 纯追加**：建 `landlord_pages`；`properties`/`contacts`/`media`/`reminders` 各加**可空** `landlord_page_id`；`users` 用 `ADD COLUMN ... NOT NULL DEFAULT ''`。**不删任何表、不改任何 NOT NULL。**
2. **双读**：`findPublicPage` 先查新表，未命中回落旧表。`/p/<slug>` 继续可用。
3. **切路由**：`/<slug>` 上线 + `/p/<slug>` 301；同时改 CSP 判定与 **`page-renderer.ts:755`**。
4. **收尾（可选，单独一版）**：确认无回滚需求后再重建 `media`/`reminders`（**用修正后的 SQL**）、`DROP TABLE listing_pages`。

**为什么渐进更便宜**：现有库只有 3 套房源且 1:1，「1:1」完全可以用「可空列 + 回填 + 自检」表达（正如 D17 对 `properties` 已经承认的）。
「一页多房」是**服务层语义**，不需要 DDL 的 NOT NULL 支撑。
整表重建换来的是不可回滚的迁移、`media`/`reminders` 的静默丢数据面，而唯一收益是 DDL 强约束 —— **恰恰是 D17 自愿放弃的东西**。

## 对第十二节推荐的修正

**原推荐**：修冒烟断言 → 修联系方式反爬 → 启动计划 A。

**修正为**：

1. **先修认证绕过**（第五批次发现，最高危）
2. 修冒烟断言（恢复测试信号）
3. 修联系方式反爬（独立可做，且是计划 A 最有价值的一块）
4. **修订计划 A 再执行** —— 至少修掉上面 D1–D11 与两处 SQL 缺陷；
   **强烈建议改为渐进路径**（四步），避免 `DROP TABLE` 不可逆与 `media`/`reminders` 的静默丢数据面