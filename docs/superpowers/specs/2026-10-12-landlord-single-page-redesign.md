# 房东单页生成器改版设计

> 本文是**改版设计说明书**，描述如何把现有实现从「房源平台」形态翻转为
> 「房东单页生成器」形态。它是实施计划的依据，不含代码。
>
> 上一版设计见 [`2026-10-12-property-listing-platform-design.md`](2026-10-12-property-listing-platform-design.md)。
>
> **修订记录**
> - **二次修订**：评审查出 9 处缺陷（漏 `reminders` 表、漏保留列、错判可空性、房东端接口缺失、
>   公开端点无位置、§7.4 自相矛盾、坐标系作用范围未定、导出与防护无交汇、风险表重开已决事项）。
> - **三次修订**：二次复审确认 9 项真修复，但查出三次修订**新引入**两处严重缺口
>   （`properties` 加 `NOT NULL` 外键列在 SQLite 下不可执行；状态取值域写错）。
> - **四次修订**：三轮复审确认前两轮真修复，又查出 6 项（含 3 项阻塞）。本轮修正并**做减法** ——
>   **取消新增 `archived` 状态**（见 §3.1.1），彻底消除编译级连锁改动。
> - **五次修订**：四轮复审确认 6 项中 5 项真修复，但查出 8 项新问题（含 2 项自身矛盾）。
>   本轮修正：D20 与 D21 的冲突（列表页底栏不下探工作区级）、向导建房 `status` 固定 `active`
>   （否则新建房源全被公开列表过滤掉）、`/p/` 收口清单补上 `hosting.ts:26/40` 与冒烟脚本、
>   预览与就绪校验改走房东级链路、`wechat_qr` 存储键带扩展名、**两处** `max-width:1100px`、
>   迁移步骤交叉引用、令牌进日志。另采纳米码兜底、导出语言维度、提醒侧收口清单等 8 条建议。
> - **六次修订（用户新增需求）**：产品定位补充 —— 这是一台**平台**，需要**账号体系、会员配额、平台首页**。
>   **推翻原 D3/D4**：不再有「免登录管理链接」，改为统一登录。新增 D23–D30 与第四之四章。
> - **七次修订**：账号章节评审查出 2 项阻塞 —— ①`users` 加 `NOT NULL` 列在 SQLite 下不可执行
>   （与 D17 同类错误，已实测复现），改为重建表；②**用户令牌可冒充运营者**（`verifySessionToken`
>   不校验 role，admin 守卫只看签名），改为独立派生密钥 + 补 role 校验。另修正 4 处迁移步号、
>   保留前缀漏项、配额单一真相源、注册必填字段等 10 余处一致性问题。

---

## 一、背景与目标

### 1.1 问题

现有实现是按「房源平台」建的：`properties` 是顶层实体，每套房各自拥有一个 slug 和一个
展示页，后台首页是一张**房源表格**，统计口径是「房源总数 / 草稿 / 已预订 / 已成交 / 已归档」。

但产品实际要交付的不是平台，而是**给单个房东生成一个可分享的单页**。房东在大平台上
录入信息，那些信息属于平台、不属于他；本产品要解决的是：房东把自己的房源信息录一次，
拿到**一个属于他自己的网页地址**，可以发到任意社交平台。

用平台形态做这件事的直接后果（已由实际界面确认）：

1. 后台首页指标是平台口径，不是房东口径；
2. 一个房东有多套房时会散成多个互不相关的页面，分享时要发多个链接；
3. 状态字段把「内部状态」与「对外可租状态」混在一列，出现「在售/在租 + 已租」叠在一起；
4. 内容区被 `max-width:1100px` 卡死（`public/admin/styles.css:81`），1920px 屏上右侧约
   628px 完全空置，表格却挤到换行。

### 1.2 目标

| | 改版前 | 改版后 |
| --- | --- | --- |
| 顶层实体 | 房源 | **房东页** |
| 一个房东 | N 个页面 | **1 个页面 + 1 个后缀** |
| 页面内容 | 单套房 | **该房东的全部房源（列表 + 详情）** |
| 房东入口 | 无 | **注册登录后的用户工作台** |
| 后台首页 | 房源表格 | **房东表格 + 房东口径指标** |

### 1.3 非目标

- **不做真实支付通道**（微信/支付宝）。本期做**会员等级与配额限制**，并留出「开通会员」入口由运营者手动授予；真实支付是后期独立阶段（D28）。
- **不做多租户隔离**（`workspaces` 保留，本期单工作区）
- **不做高德/谷歌的联网端到端验证**（无 Key，见 §8）
- **不做邮箱验证与找回密码**（本期注册即用；找回密码依赖真实邮件通道，与 SMTP 未实测同属后期）

---

## 二、已确认的决策

| # | 决策点 | 结论 |
| --- | --- | --- |
| D1 | 页面单位 | **一个房东 = 一个页面**，内含多套房 |
| D2 | 访客路径 | **列表 + 点开看详情** |
| ~~D3~~ | ~~房东身份~~ | **【六次修订推翻】** 原「拿链接直接填，不注册」作废，改为 D23 |
| ~~D4~~ | ~~登录范围~~ | **【六次修订推翻】** 原「只有运营者登录」作废，改为 D23 |
| D5 | 记录范围 | 生成流水 + 房东改动历史（都扩展 `audit_logs`） |
| D6 | 后缀 | **系统自动生成，运营者也能改** |
| D7 | 支付 | **后期再做** |
| D8 | 联系方式防护 | **真防护**：首屏不含号码与二维码，点击后才取，IP 限流 |
| D9 | 地图 | **可切换适配器**，默认 OSM |
| D10 | 计价方式 | 表单只保留**月 / 年 / 总价** |
| D11 | 品牌默认 | ZHIRAI / 智睿；新项目 private / UNLICENSED |
| D12 | 提醒归属 | 提醒挂**房东页**，不挂房源 |
| D13 | 联系方式回退链 | **房源级 → 房东级（公开页不下探到工作区级，见 D21）** |
| D14 | 发布时机 | 向导第 ③ 步**通过就绪校验后**自动发布（§6.2） |
| D15 | 导出与防护 | 导出包**含完整联系方式**，作为房东自己的副本（§9.2） |
| D16 | 地图本期范围 | 提供方预设 + 坐标转换 + 缺 Key 回落；不做需 Key 的联网验证 |
| D17 | `properties.landlord_page_id` | **DDL 可空**（SQLite 限制），迁移回填 + 服务层 + 自检三重保证非空（§3.6.1） |
| D18 | 状态取值域 | **完全沿用现有三值，不新增**（§3.1.1） |
| D19 | 访客首屏联系渠道 | **服务端直出** `{kind, masked, contactId}`；不设列表端点 |
| D20 | 列表页底栏渠道来源 | **仅房东级；无则不渲染底栏**（受 D21 约束，不下探工作区级） |
| D21 | 公开页不下探工作区级 | **公开页联系方式只取「房源级 → 房东级」，绝不回落到工作区级**（§3.2.1） |
| D22 | 提醒幂等键去重 | 迁移按 `(landlord_page_id, kind)` 去重，保留最早 `due_at`（§3.6.2 **第 12 步**） |
| D23 | 用户必须登录 | **取消免登录管理链接**；用户注册/登录后在自己的工作台管理页面 |
| D24 | 身份锚点 | **用户 ID 是唯一身份**；页面 slug 只是可读地址，**不承载身份**，唯一性由唯一索引保证 |
| D25 | 配额单位 | **配额 = 单个页面内的房源数上限**；页面数量不设上限，但**每新建一个页面消耗一次生成额度** |
| D26 | 四档配额 | 试用 1 套/页 · 按次 3 套/页 · 月卡 10 套/页 · 专业 20 套/页（§3.7.3） |
| D27 | 配额快照 | `max_properties` 在**页面创建时快照**；会员到期不缩减已有页面，只禁止新建 |
| D28 | 支付范围 | 本期**不做真实支付通道**；会员由运营者在后台手动授予，留出「开通会员」入口 |
| D29 | 平台首页 | `/` 改为**平台首页**，展示被标记为示例的业主页 + 注册/登录入口 |
| D30 | 运营者与用户分离 | 运营者沿用 `/admin/` + `ADMIN_PASSWORD`（独立会话 cookie）；用户走 `/login` + 邮箱密码。**两套互不影响**，避免改动既有鉴权 |

---

### 2.2 实施分期（七次修订定案）

本设计已超出单份实施计划的合适体量。经评估，**拆成两份独立计划**，
两者只有两处硬耦合，且都落在迁移前两步，因此拆分干净。

#### 计划 A：结构翻转（**先做**）

把「房源平台」翻转为「业主单页生成器」，跑通后再做账号商业化。

| 范围 | 内容 |
| --- | --- |
| 数据模型 | 4 张表重建（`landlord_pages` / `media` / `reminders` / `users`）+ 迁移 v3 全 15 步 |
| 迁移前置 | **含第 1–2 步**（`users` 重建 + 历史数据用户）—— 因为 `landlord_pages.user_id` 是 `NOT NULL`，必须先有用户行 |
| 路由 | `/<slug>` 系列、`/p/` 301 兼容、`/admin/*` 改为以业主页为中心 |
| 公开页 | 列表页、详情页、联系方式防抓取、费用区、介绍折叠 |
| 后台 | 业主表格、业主页详情、记录 |
| 收口 | CSP 判定、`BACKUP_TABLES`、提醒侧、`/p/` 全部引用点 |
| 品牌 | ZHIRAI 图标与页脚（已完成） |

**计划 A 不含**：注册/登录、配额、会员、用户工作台、平台首页。
因此 A 阶段**业主页由运营者在后台代建**，`user_id` 全部指向历史数据用户。

#### 计划 B：账号商业化（**后做**）

| 范围 | 内容 |
| --- | --- |
| 账号 | 注册、登录、登出、会话探测、停用 |
| 会话 | 用户会话独立派生密钥 + admin 守卫补 role 校验（§4.4 的提权修复） |
| 配额 | 四档配额、快照、余额与计数、强制点与事务（§3.7.3） |
| 用户端 | 用户工作台、三步向导、发布 |
| 运营端 | 用户管理、授予会员、标记示例、改派归属（§5.5） |
| 门面 | 平台首页 `/`（§7.6） |
| 支付 | 仍为后期，B 阶段只留入口（D28） |

#### 两处硬耦合（都在 A 的第 1–2 步做完）

1. `landlord_pages.user_id NOT NULL` → A 阶段必须建出用户表与历史用户行；
2. 取消免登录管理链接 → A 阶段**不提供任何业主自助入口**，全部由运营者代建；
   B 阶段再把入口交给业主。

#### 为什么不合并

不合风险在于**「迁移改坏数据」与「配额算错」两类问题会同时爆发**，排查互相干扰。
分开后 A 的验收是纯数据与页面问题，B 的验收是纯账号与计费问题，各自可独立定位。

---

## 三、数据模型

### 3.1 顶层实体翻转

```
landlord_pages                         ← 新顶层（结构源自 listing_pages + 调整）
  id                   TEXT PRIMARY KEY
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE   【新增·归属账号】
  slug                 TEXT NOT NULL              页面地址 → /<slug>
  owner_name           TEXT NOT NULL              房东称呼                        【新增】
  max_properties       INTEGER NOT NULL           创建时快照的配额上限            【新增 D27】
  quota_source         TEXT NOT NULL              快照来源 free|oneoff|monthly|pro 【新增】
  is_showcase          INTEGER NOT NULL DEFAULT 0 是否在平台首页作示例展示        【新增 D29】
  locale               TEXT NOT NULL              ← 沿用原名
  template_id          TEXT NOT NULL
  status               TEXT NOT NULL              **沿用 unpublished | published | withdrawn**
  published_at         TEXT                       ← 保留（提醒基准）
  withdrawn_at         TEXT                       ← 保留
  custom_domain        TEXT                       ← 保留
  domain_verify_token  TEXT                       ← 保留
  domain_verified_at   TEXT                       ← 保留
  view_count           INTEGER NOT NULL DEFAULT 0
  created_at           TEXT NOT NULL
  updated_at           TEXT NOT NULL
```

**索引（显式重建，否则唯一约束与查询性能一起丢）**

```sql
CREATE UNIQUE INDEX idx_landlord_pages_slug    ON landlord_pages(slug);
CREATE        INDEX idx_landlord_pages_user    ON landlord_pages(user_id);
CREATE        INDEX idx_landlord_pages_domain  ON landlord_pages(custom_domain);
CREATE        INDEX idx_landlord_pages_showcase ON landlord_pages(is_showcase, status);

> **`manage_token` 已随 D23 一并取消** —— 不再有免登录管理链接，也就不需要该列与它的唯一索引。
```

**列映射**

| 新表列 | 来源 |
| --- | --- |
| `id` / `workspace_id` / `slug` / `locale` / `template_id` / `status` | 原样拷贝 |
| `published_at` / `withdrawn_at` / `custom_domain` / `domain_verify_token` / `domain_verified_at` / `view_count` / `created_at` / `updated_at` | 原样拷贝 |
| `owner_name` | 该页对应房源的 `title`；为空时兜底为 `未命名房东` |
| `user_id` | **迁移期归给一个内置的「历史数据」用户**（见 §3.7.4），运营者随后可改派 |
| `max_properties` / `quota_source` | `quota_source = 'admin'`；`max_properties = max(20, 该页现有房源数)` —— 直接写 20 会让**已有超过 20 套房的页面被配额卡死**，无法再新增房源 |
| `is_showcase` | `0` |
| — | 原 `property_id` **不拷贝** |

**`owner_name` 兜底与长度上限**：`title` 最长 200 字符，`owner_name` 沿用该上限；为空时回退为 `未命名房东`。

**`slug` 兜底**：`owner_name` 经 `slugify` 后可能为空串（例如标题全是符号）。
**为空时回退为 `landlord-<序号>`，并走既有 `nextAvailableSlug` 保证唯一**，
否则 `slug NOT NULL` 或唯一索引（`idx_landlord_pages_slug`）会让迁移直接失败。

#### 3.1.1 状态取值域：不新增（四次修订做减法）

**真实取值域是 `LISTING_STATUSES = ['unpublished','published','withdrawn']`**
（`src/domain/types.ts:22`）。

三次修订曾计划新增 `archived`。**四次修订取消该计划**，原因是一条实测的连锁改动：

```ts
// src/domain/listing-page.ts:71 —— Record 的键必须穷举 ListingStatus
const allowed: Record<ListingStatus, readonly ListingStatus[]> = {
  unpublished: ['published'],
  published: ['withdrawn', 'published'],
  withdrawn: ['published'],
};
```

给 `LISTING_STATUSES` 加 `'archived'` 会让这个 `Record` **缺少 `archived` 键 → TypeScript 编译失败**；
`statusLabel`（`:84-95`）也会把 `archived` 原样输出成英文；另需新增归档/恢复两条 admin 路由
（现仅 `publish`/`withdraw`，`admin-pages.ts:81-86`）。

**而这些改动换来的能力，现有 `withdrawn` 已经具备** —— 运营者要「把页面收起来」用撤下即可。
因此按 YAGNI 取消：

- `LISTING_STATUSES` **一个字符都不改**；
- `assertPublishTransition`、`statusLabel` **完全不动**；
- 运营者后台的「归档」动作改称**「撤下」**，复用现有 `withdraw` 路由；
- 若将来确实需要区分「临时下架」与「长期收起」，那是**加法改动**，可单独评估。

**现有状态机（不改动，供实施核对）**

```
unpublished ──publish──→ published ──withdraw──→ withdrawn
                              ↑                       │
                              └───────publish─────────┘
```

`published → published` 与 `withdrawn → published` 都是合法重复操作
（方案第 2 阶段验收明确要求「发布和撤回可以重复操作」）。

```
properties                             ← 降为子级（不重建）
  + landlord_page_id  TEXT REFERENCES landlord_pages(id) ON DELETE CASCADE
  + CREATE INDEX idx_properties_landlord ON properties(landlord_page_id)
```

> **索引不可省**：翻转后「按房东页查房源」是列表页与后台的主查询路径，
> 而原 `idx_listing_pages_property` 随旧表消失。缺索引等于用全表扫描替代索引。

**公开列表的房源筛选**：列表页只展示 `properties.status NOT IN ('draft','archived')` 的房源；
房东把某套房归档后，访客不应再看到它。

> ⚠️ **本设计中存在两个互不相干的 `status` 字段，实施时勿混淆**：
>
> | 字段 | 取值域 | 含义 |
> | --- | --- | --- |
> | `landlord_pages.status` | `unpublished` / `published` / `withdrawn` | **页面**是否公开可访问（§3.1.1） |
> | `properties.status` | `draft` / `active` / `reserved` / `closed` / `archived` | **单套房源**的出租进度 |
>
> 公开列表的筛选用的是**后者**（`PROPERTY_STATUSES`，`src/domain/types.ts:17-18`）；
> 页面能否公开访问取决于**前者**。

### 3.2 联系方式

现有 `contacts.property_id` **本来就可空**（`migrations.ts:98`），NULL 表示工作区级默认联系方式。

```
contacts
  property_id        TEXT REFERENCES properties(id) ON DELETE CASCADE      （已可空，不动）
  + landlord_page_id TEXT REFERENCES landlord_pages(id) ON DELETE CASCADE  （新增，可空）
  workspace_id       TEXT NOT NULL（不变）
```

- **直接 `ALTER TABLE contacts ADD COLUMN`**，**不重建表**（少一次重建就少一次索引丢失风险）。
- 索引补一条：`CREATE INDEX idx_contacts_landlord ON contacts(landlord_page_id, sort_order);`

#### 3.2.1 公开页的联系方式链（D21 —— 修正真实数据暴露）

**问题**：`listEffectivePublicContacts(db, workspaceId, propertyId)` 的现有实现是
「房源级 → **工作区级**」（`contact-repo.ts:119-127`）。在「一个部署服务多个房东」的新模型下，
工作区级联系方式就是**运营者自己的号码**；一旦成为兜底，**每个房东的公开页都会显示运营者的电话**。
这是真实数据暴露，必须在设计层堵死。

**决策 D21**：**公开页的联系方式链只取「房源级 → 房东级」，绝不下探到工作区级。**

| 页面 | 取值链 |
| --- | --- |
| 房东页列表（`/<slug>`） | **仅房东级**；无则整条底栏不渲染（列表页无房源上下文，不取房源级） |
| 房源详情（`/<slug>/<id>`） | **房源级 → 房东级**；无则「暂无公开联系方式」 |
| 运营者后台 | 仍可用「房源级 + 工作区默认」三级（内部使用，不对外） |

工作区级联系方式**仅用于后台内部的联系方式编辑器**，不再参与任何公开渲染。

**预览页与就绪校验也必须改链路（否则迁移后必然出问题）**：
`aggregateFor`（`publish-service.ts:145`）同时喂给后台预览接口与 `readiness()`，
而它走的是「房源级 → 工作区级」。迁移第 8 步把房源级公开联系方式上移并删除原件后：

- 后台预览页（被要求「与公开页完全一致」）会显示出**运营者自己的号码**；
- `collectPublishReadiness` 会对**每一套**房源报「没有公开的联系方式」的**虚假告警**，
  而公开页其实拿得到房东级联系方式。

**因此 `aggregateFor` 的联系方式链一并改为「房源级 → 房东级」**，与公开页保持一致。

### 3.3 微信二维码的存储

复用 `media` 上传管道，新增 `kind` 取值 `wechat_qr`，归属房东页。

**`media.property_id` 目前是 `NOT NULL`**（`migrations.ts:112`），SQLite 无法用 `ALTER TABLE`
去掉 NOT NULL，因此 `media` **必须重建**：

```
media                                  ← 重建
  property_id        TEXT REFERENCES properties(id) ON DELETE CASCADE      改为可空
  + landlord_page_id TEXT REFERENCES landlord_pages(id) ON DELETE CASCADE  新增，可空
  kind               TEXT NOT NULL    取值新增 'wechat_qr'
  （其余列不变）
```

**索引（必须重建）**

```sql
CREATE INDEX idx_media_property ON media(property_id, sort_order);
CREATE INDEX idx_media_landlord ON media(landlord_page_id, sort_order);
```

**`wechat_qr` 的写入路径**：现有管道多处隐含「媒体必属于房源」的假设，房东级上传须显式绕开：

| 既有位置 | 现状 | 处理 |
| --- | --- | --- |
| `validateUpload` / `kindForMime`（`domain/media.ts:78-93`） | 图片一律返回 `'photo'` | 房东级端点**显式指定 `kind='wechat_qr'`**，不依赖推断 |
| `addUploadedMedia`（`media-service.ts:73-107`） | 要求非空 `propertyId` | 新增房东级入口，改为要求非空 `landlordPageId` |
| `insertMedia`（`media-repo.ts:51`） | 要求非空 `propertyId` | 允许 NULL |
| `requireMedia`（`media-repo.ts:151-157`） | 走 `requireProperty` 校验归属 | 房东级走页面归属校验 |
| `Media.propertyId`（`types.ts:202`；`media-repo.ts:24` 把 NULL 读成 `''`） | 类型 `string` | **改为可空**并调整读取 |
| `countPhotos`（`media-repo.ts:127`） | 本就只统计 `kind='photo'` | 无需改动 |
| 封面 / 排序 | — | `wechat_qr` 恒 `is_cover=0`、`sort_order=0` |
| 存储键 | `${propertyId}/${unique}.${ext}`（`media-service.ts:51-71`） | 房东级用 **`${landlordPageId}/${unique}.${ext}`** |

> ⚠️ **存储键必须带扩展名**：`/media/*` 按 key 的扩展名决定 `Content-Type`（`app.ts:234-238`），
> 且所有响应带 `X-Content-Type-Options: nosniff`（`security.ts:132`）。
> 若写成不带扩展名的 `${landlordPageId}/wechat-qr`，二维码会以 `application/octet-stream` 下发，
> 浏览器可能无法直接显示。

### 3.4 提醒（`reminders`）

`reminders.listing_page_id` 外键指向 `listing_pages`（`migrations.ts:151`），
且 `database.ts:29` 开启了 `PRAGMA foreign_keys=ON`。

**决策 D12**：提醒挂**房东页**。

```
reminders                              ← 重建
  - property_id      （移除）
  - listing_page_id  （移除）
  + landlord_page_id TEXT NOT NULL REFERENCES landlord_pages(id) ON DELETE CASCADE
  （其余列不变）
```

**索引（必须重建 —— 幂等保证建立在此唯一索引上）**

```sql
CREATE UNIQUE INDEX idx_reminders_idempotency ON reminders(idempotency_key);
CREATE        INDEX idx_reminders_due         ON reminders(status, due_at);
```

- **幂等键**改为 `${landlordPageId}:${kind}`（去重规则见 §3.6.2 **第 12 步**）
- **邮件正文**改为写房东称呼与该页房源数量
- **撤下时跳过**改为按 `landlord_page_id` 查询
- 一对提醒 = 一个房东页的第 7 天 / 第 15 天两条

### 3.5 保持不变的表

`property_translations`、`audit_logs`、`external_service_configs`、`users`、`workspaces`。

`properties` 除新增一列 + 一个索引外**不重建**（它是 4 张 CASCADE 子表的父表，重建风险远大于收益）。

### 3.6 迁移策略（版本号 `v3 landlord_single_page`）

#### 3.6.1 `properties.landlord_page_id` 的处理（D17）

**问题**：`TEXT NOT NULL REFERENCES landlord_pages(id)` + `ALTER TABLE ADD COLUMN` 在 SQLite 下
**无法执行** —— `NOT NULL` 要求默认值非空，而 `foreign_keys=ON` 时 `REFERENCES` 列要求默认值为 NULL，
两者互斥。

重建 `properties` 不可行：它是 `property_translations`/`contacts`/`media`/`reminders` 的父表
（全 `ON DELETE CASCADE`），`DROP TABLE` 的隐式删除会**级联删掉子表数据**；而规避手段
`PRAGMA foreign_keys=OFF` **在事务内是 no-op**，与单事务要求冲突。

**决策 D17：DDL 上建成可空，回填后三重保证非空**

1. **迁移回填**（§3.6.2 **第 8 步**；第 6 步只是 `ADD COLUMN`）：迁移结束后不存在 NULL；
2. **服务层**：创建房源必须提供 `landlordPageId`，否则领域错误；
3. **自检**：`pnpm migrate` 结束时执行
   `SELECT COUNT(*) FROM properties WHERE landlord_page_id IS NULL`，**非 0 即报错退出**。

**孤儿房源**：从未创建过 `listing_pages` 的房源（存在删除路径，`listing-page-repo.ts:145`）
没有归属页 —— **迁移为每条孤儿房源新建一个房东页**，确保 1:1 覆盖、无 NULL 残留。

#### 3.6.2 迁移步骤

**顺序要求：备份必须由调用方在 `runMigrations` 之前执行**（`VACUUM INTO` 不能在事务内运行，
见 `backup-service.ts:122`）。注意 `createBackup(ctx)` 需要 `AppContext` 而 `src/db/migrate.ts`
目前只持有 `db` —— **实施计划须交代该入口改造**。

| # | 步骤 | 方式 |
| --- | --- | --- |
| 0 | 生成备份快照 | 调用方在事务前执行；失败即中止迁移 |
| 1 | **重建 `users` 表** + 3 索引 | 建新表 → 拷贝 → 删旧表 → 改名（§3.7.1）。**不能用 `ALTER TABLE ADD COLUMN`**：`password_hash` / `status` 为 `NOT NULL`，SQLite 会拒绝。既有行给 `status='active'`、`tier='pro'`、`password_hash` 哨兵值、`is_system=1` |
| 2 | **创建「历史数据」用户** | §3.7.4；`tier='pro'`、`password_hash` 为不可登录哨兵值 |
| 3 | 建 `landlord_pages` + **4 索引** | `CREATE TABLE` / `CREATE INDEX`（含 `idx_landlord_pages_user`、`idx_landlord_pages_showcase`） |
| 4 | 从 `listing_pages` 拷贝 | `INSERT INTO … SELECT …`；**若一套房源存在多条 `listing_pages`，取 `MIN(id)` 那条**（避免子查询静默多行）；`user_id` 统一指向第 2 步的历史数据用户 |
| 5 | 为**孤儿房源**补建业主页 | §3.6.1；`owner_name` 兜底「未命名房东」，`slug` 兜底 `landlord-<n>` |
| 6 | `properties` **ADD COLUMN** `landlord_page_id`（可空） | `ALTER TABLE` |
| 7 | 建 `idx_properties_landlord` | `CREATE INDEX` |
| 8 | 回填 `properties.landlord_page_id` | 按原 `listing_pages.property_id` 映射；孤儿按第 5 步新建的页 |
| 9 | `contacts` **ADD COLUMN** `landlord_page_id` + 索引 | `ALTER TABLE`（**不重建**） |
| 10 | **把房源级公开联系方式上移到业主页级** | 见下方说明 |
| 11 | **重建 `media`** + 2 索引 | 建新表 → 拷贝 → 删旧表 → 改名 |
| 12 | **重建 `reminders`** + 2 索引（含去重） | 见下方说明 |
| 13 | 删除 `listing_pages` | `DROP TABLE` |
| 14 | **自检** | 无 NULL 归属；`PRAGMA foreign_key_check` 无输出；`properties` 均有归属页；`landlord_pages.user_id` 均有对应用户 |

> **步骤编号变更提示（六次修订）**：因新增账号体系，原第 1–12 步顺延为第 3–14 步。
> 下文中若出现「第 N 步」的交叉引用，**一律以本表为准**。

**第 10 步：联系方式上移（配合 D21）**

迁移时每个房东页恰好对应一套房源，因此把该房源的**公开**联系方式上移到房东级是**语义等价**的：

- 为每个房东页建立其对应房源的**公开**联系方式副本（`landlord_page_id` 指向该页，`property_id = NULL`）；
  **连同 `channel_kind` / `channel_value` / `display_name` / `sort_order` 一起拷贝**，保持展示顺序不变；
- **非公开的房源级记录原地保留**，不参与上移 —— 因此 `contacts` 总行数在迁移前后不变，
  计数型断言仍成立（见验收 12 的例外说明）；
- **删除原有的房源级公开记录**（避免重复展示）；
- **工作区级记录保持不动**，但按 D21 不再参与公开渲染；
- 结果：列表页有内容可显示，详情页经「房源级（无）→ 房东级」仍能显示。

> 该步在 §3.6.2 的 15 步表中为**第 10 步**。

**第 12 步：提醒重建与去重（D22 —— 关键，否则迁移必然失败）**

幂等键由 `${propertyId}:${kind}` 改为 `${landlordPageId}:${kind}` 后，
**同一房东页下多套房源的同类型提醒会被重写成同一个键**，而 `idx_reminders_idempotency`
是 UNIQUE（`migrations.ts:164`）—— 不去重则 **UNIQUE 冲突导致整个迁移事务回滚**。

去重规则：

1. 按 `(landlord_page_id, kind)` 分组；
2. 每组**保留 `due_at` 最早的一条**（`due_at` 相同则取 `id` 最小者）；
3. 其余同组记录**删除**（它们只是重复的催办，无保留价值）；
4. 写入前先跑一次冲突检测：改写后的键若出现重复，**报错并中止迁移**，不静默丢弃。

**为什么第 11、12 步必须重建**：SQLite 无法用 `ALTER TABLE` 去掉 `NOT NULL`（`media`）
或更改外键目标（`reminders`）。这两张表都是**叶子表**（无子表），重建不会触发级联。

**重建会丢索引，因此每一步都必须显式重建索引** —— 尤其是 `idx_reminders_idempotency`，
「不重复轰炸用户」的保证正建立在它上面。

#### 3.6.3 迁移清单中容易漏掉的四项

| 项 | 位置 | 不做会怎样 |
| --- | --- | --- |
| **`BACKUP_TABLES` 更新** | `backup-service.ts:22-33` 硬编码 `listing_pages` | `verifyBackupFile()`（`:265-267`）对计数为 -1 的表报「快照中缺少表」→ **迁移后每份备份都 `ok=false`** |
| **CSP 判定更新** | `app.ts:117-118` 按 `startsWith('/p/')` 决定 `allowInlineStyles` | 路由搬到 `/<slug>` 后，**地图瓦片与内联 style 被 CSP 拦掉**（`mini-map.ts:140`、`page-renderer.ts:250/380`） |
| **`/p/` 收口点逐个处理** | 见下方清单 | 漏改即死链或功能失效 |
| **迁移后复验备份** | — | 更新 `BACKUP_TABLES` 后必须**实跑一次备份 + 校验**确认 `ok=true` |

**`/p/` 收口点清单（必须逐项处理，不可只写「加一条重定向」）**

| 位置 | 内容 | 处理 |
| --- | --- | --- |
| `public-pages.ts:20` | `/p/:slug` 主路由 | 迁移为 `/<slug>`，另加 301 兼容 |
| `public-pages.ts:104` | `/p/:slug/qr.svg` | 同上 |
| `public-pages.ts:124` | `/p/:slug/nearby.json` | 同上 |
| `public/admin/views/property-edit.js:479` | 硬编码 `/p/${slug}/qr.svg` | 改为新地址（该页改为房东页详情） |
| `tests/integration/public-page.test.ts`（多处：53/202/307/330/353 等） | 断言 `/p/` 路径 | 改写为新路由 |
| `tests/services/reminder-service.test.ts:73` | 断言邮件正文含 `/p/` | 改写为新地址 |
| **`src/domain/hosting.ts:26`** | `buildDefaultPublicUrl` 硬编码 `/p/${slug}` | **改为 `/<slug>`；这是分享链接、二维码、提醒邮件、导出包 `share-url.txt` 的唯一构造点，漏改则全链路输出旧地址** |
| **`src/domain/hosting.ts:40`** | `buildCustomDomainUrl` 同上 | 同上 |
| `tests/services/hosting-service.test.ts:105` | 直接断言该 URL 形状 | 随 `hosting.ts` 一起改写 |
| `scripts/smoke.ts:200/210/225/238/402` | 用 `/p/` 路径做注入断言 | 改用新路径；**注意 `inject` 默认不跟随 301**，「未发布 404 / 发布后 200 / 正文含标题」这几条断言若只靠兼容跳转会直接失败 |
| `tests/integration/security.test.ts:39/63` | 安全用例引用 `/p/` | 改写为新路径 |

#### 3.6.3.1 提醒侧的收口点清单

`reminders` 由「挂房源」改为「挂房东页」后，以下位置引用了 `property_id`，**必须逐项处理**
（这些是编译可见的，列出以避免漏改）：

| 位置 | 内容 | 处理 |
| --- | --- | --- |
| `listRemindersByWorkspace` / `countByStatus` | `JOIN properties` 取房源信息 | 改为 `JOIN landlord_pages`，或改取房东称呼 |
| `listRemindersAdmin` | 返回 `propertyTitle` | 改为 `landlordOwnerName`（后台列表列名同步改） |
| `requireReminder` | 以 `propertyId` 校验归属 | 改为以 `landlordPageId` 校验 |
| `src/http/routes/admin-reminders.ts` | 接口字段与筛选 | 字段名与语义同步调整 |
| `tests/services/reminder-service.test.ts:45` | 断言 `day7.propertyId` | 改写为 `landlordPageId` |

#### 3.6.3.2 404 页的返回入口

现有 404 页（`app.ts:197`）写着「返回管理后台」，指向 `/admin/`。
平台首页落地后（D29），**应改指 `/`** —— 访客看到 404 时不该被推到运营者后台。

#### 3.6.4 旧链接兼容

保留 `/p/` 前缀的**重定向路由**，把 `/p/<slug>` 301 到 `/<slug>`，覆盖其子路径
（`/p/<slug>/qr.svg`、`/p/<slug>/nearby.json`）。

#### 3.6.5 演示数据与 seed 行为

`scripts/seed.ts:182-188` 的实际行为是**「已有数据即跳过，`SEED_FORCE=true` 则追加」，从不删除**。

| 场景 | 结果 |
| --- | --- |
| 已有数据库执行迁移 | **3 条既有演示数据全部保留**（迁移只做结构变更、归属回填、联系方式上移） |
| 全新数据库执行 `pnpm seed` | 建立新形态演示：1 个房东带 3 套房 + 1 个房东带 1 套房 |
| 已有数据库 `SEED_FORCE=true` | **追加**，不重置（现状行为，本期不改） |

**回归基线**：迁移完成后断言「主页房东数 = 3」「公开可访问页面数与迁移前一致」
「每套既有房源的照片数量不变」，作为「数据未丢失」的可执行证据。

---

### 3.7 账号与会员（六次修订新增）

> **跨 A/B 两期**（§2.2）：**表结构与迁移（§3.7.1、§3.7.4）属于计划 A** ——
> `landlord_pages.user_id` 是 `NOT NULL`，A 阶段就必须建出 `users` 表与历史用户行。
> **功能（§3.7.2 注册登录、§3.7.3 配额强制、会员授予）属于计划 B**。

#### 3.7.1 `users` 表扩展

现有 `users` 表（`migrations.ts:39-47`）已有 `id` / `workspace_id` / `email` / `display_name` /
`role`，但**没有密码字段**。

> ⚠️ **必须重建表，不能 `ALTER TABLE ADD COLUMN`**（与 §3.6.1 的 D17 属同一类 SQLite 限制）：
> `password_hash TEXT NOT NULL` 与 `status TEXT NOT NULL` 都无法通过 `ADD COLUMN` 加上 ——
> SQLite 会报 `Cannot add a NOT NULL column with default value NULL`。
> **已用项目自身运行时（`node:sqlite`）实测复现，迁移第一步即报错回滚。**
>
> **选择重建而非加 DEFAULT**：加了 DEFAULT 之后默认值会永久留在表定义里，
> 今后任何漏填 `tier` 的插入都会**静默变成 `pro`（最大配额）**，是个隐性漏洞。
>
> **重建是安全的**：迁移第 1 步时 `landlord_pages` 尚未创建，
> 且**全库没有任何表 `REFERENCES users`**（已核实），不存在级联风险。

```
users                                  ← 重建（建新表 → 拷贝 → 删旧表 → 改名）
  id / workspace_id / email / display_name / role / created_at / updated_at   原样拷贝
  + password_hash   TEXT NOT NULL              哨兵值（不可登录，§3.7.4）
  + status          TEXT NOT NULL              'active'
  + tier            TEXT NOT NULL              'pro'（既有账号不受配额限制）
  + member_until    TEXT                       NULL
  + free_quota_consumed INTEGER NOT NULL DEFAULT 1  既有账号视为已用掉免费额度
  + oneoff_credits  INTEGER NOT NULL DEFAULT 0      按次生成余额（§3.7.3）
  + is_system       INTEGER NOT NULL DEFAULT 1      系统账号标记（§3.7.4）
```

**索引（必须一并重建）**

```sql
CREATE        INDEX idx_users_workspace ON users(workspace_id);
CREATE UNIQUE INDEX idx_users_email     ON users(email);
CREATE        INDEX idx_users_system    ON users(is_system);   -- 新增：用户列表默认过滤
```

`role` 沿用现有取值（`owner` / `manager` / `viewer`）；**本期所有注册用户一律 `viewer`**。
**真正区分权限的是 `tier` 与 `is_system`，不是 `role`** —— 因此 §3.7.4 的历史用户
统一用 `role = 'viewer'` + `is_system = 1`，不再用 `owner`。

#### 3.7.2 密码哈希：用 Node 内置，不引依赖

`node:crypto` 自带 `scryptSync` 与 `timingSafeEqual`（已实测可用），因此**不需要任何第三方密码库**，
与「只直接引入 MIT 组件」的约定一致。

- 存储格式：`scrypt$N$r$p$<salt-base64>$<hash-base64>`
- 参数：`N=16384, r=8, p=1`，`keylen=64`，随机 salt 16 字节（`randomBytes`）
  - 已实测可用：该参数需要约 **16 MB**，低于 Node 默认 `maxmem` 32 MB；**若调大 `N` 必须同时调大 `maxmem`**，否则 `scryptSync` 直接抛错
- 校验用 `timingSafeEqual` 做**常数时间比较**，避免时序侧信道
  - ⚠️ 必须用**项目自己的**实现（`src/http/security.ts:37`），它自带长度对齐；
    `node:crypto` 的同名函数在长度不等时会**抛异常**。见 §3.7.4 的哨兵哈希说明
- 登录失败一律返回同一句文案，**不区分「邮箱不存在」与「密码错误」**

#### 3.7.3 配额模型

| 档位 `tier` | 名称 | 每页房源上限 | 页面数限制 | 说明 |
| --- | --- | --- | --- | --- |
| `free` | 试用 | **1** | **1 个页面** | 注册即送，用于看效果 |
| `oneoff` | 按次 | **3** | 每次生成消耗一次，不限总数 | 建议 ¥9.9/次 |
| `monthly` | 月卡 | **10** | 会员期内不限 | 建议 ¥29/月 |
| `pro` | 专业 | **20** | 会员期内不限 | 建议 ¥99（月/年待定） |

> 价格是**建议值**，全部从配置读取（`TIER_*_MAX_PROPERTIES`、`TIER_*_PRICE_NOTE`），
> 本期不实现收款，因此价格仅用于界面展示文案。

**配额快照（D27）**：页面创建时把当时档位的上限写入 `landlord_pages.max_properties`。
此后**会员到期或降级都不会缩减已有页面**，只是**不能再新建页面**。
这样既保护了已付费用户，也避免了「到期后页面突然少了几套房」的争议。

**余额与计数（单一真相源，避免两处记账对不上）**：

| 概念 | 唯一来源 | 说明 |
| --- | --- | --- |
| 免费额度是否已用 | `users.free_quota_consumed`（0/1 布尔） | **不按页面数回算**。创建第一个页面时置 1 |
| 按次生成余额 | `users.oneoff_credits`（整数） | 由运营者授予；每次用 `oneoff` 建页减 1 |
| 会员是否有效 | `users.member_until` > now | `monthly` / `pro` 用 |
| 某页房源上限 | `landlord_pages.max_properties` | 建页时快照（D27） |

**删除页面是否返还额度**：

| 档位 | 删除页面后 |
| --- | --- |
| `free` | **不返还** —— `free_quota_consumed` 保持 1（防止「建了删、删了建」无限刷） |
| `oneoff` | **不返还** —— 已消耗的生成次数不退 |
| `monthly` / `pro` | 无影响（会员期内页面数不限） |

**强制点**：

| 动作 | 校验 |
| --- | --- |
| 新建页面 | `free`：`free_quota_consumed = 0`，成功则置 1；`oneoff`：`oneoff_credits ≥ 1`，成功则减 1；`monthly`/`pro`：`member_until > now`。任一不满足 → 拒绝并**给出具体的升级提示** |
| 新增房源 | 该页当前房源数 `< max_properties`，否则拒绝并提示「本页上限 N 套，升级会员可提高」 |
| 会员到期 | 已有页面照常访问与编辑（受各自快照上限约束）；**不能新建页面** |
| **运营者代建页面** | **不受用户配额限制**（运营者用 `/api/admin/*` 建房不消耗用户额度、不校验 `member_until`）。代建的页面 `quota_source = 'admin'`、`max_properties = 20` |

**竞态**：`check + insert` 必须放在**同一个事务**内（`transaction()`，且不 `await` 中间步骤）；
多进程部署时应改用 `BEGIN IMMEDIATE`。见 §11 R7。

#### 3.7.4 迁移期的「历史数据」用户

`landlord_pages.user_id` 是 `NOT NULL`，而迁移前不存在任何用户账号。因此迁移时：

1. 创建一个内置用户：`email = legacy@local`、`display_name = 历史数据`、
   `role = 'viewer'`、`tier = 'pro'`、`is_system = 1`、
   `password_hash` 为**不可登录的哨兵值**（登录时永远失败）；
2. 所有迁移过来的业主页 `user_id` 指向它；
3. 运营者可在后台把这些页面**改派**给真实用户。

**为什么 `role = 'viewer'` 而不是 `owner`**：§3.7.1 已明确「权限由 `tier` 与 `is_system` 承载，
不由 `role` 承载」，历史用户给 `owner` 会与该约定矛盾。

**`is_system` 的语义**：`1` = 系统账号 —— **不出现在用户列表、不能登录、不受配额限制**。

> **⚠️ 第二个系统账号**：`ensureDefaultWorkspace`（`workspace-repo.ts:154-159`）
> 会在**每个**数据库里创建一个 owner 用户。迁移第 1 步重建 `users` 时它也会被赋
> `status='active'` / `tier='pro'` / 哨兵密码 —— 若不标记，运营者的用户列表里会出现
> **第二个登不上的「活跃·专业档」账号**。因此重建时**把所有既有行一律置 `is_system = 1`**，
> 只有通过注册新建的用户才是 `is_system = 0`。

**哨兵哈希的两个坑**：

- 必须用**项目自己的** `timingSafeEqual`（`src/http/security.ts:37`，自带长度对齐），
  **不能用 `node:crypto` 的同名函数** —— 后者在长度不等时会**抛异常**，
  哨兵哈希一登录就变成 500；
- 哨兵串应是一个**结构合法但永不匹配**的哈希（如固定的全零 hash），
  而不是空串或 `null`，避免走异常分支。

## 四、路由

### 4.1 完整路由表

| 路径 | 使用者 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET /admin/` | 运营者 | 会话 | 后台外壳 |
| `/api/admin/*` | 运营者 | 会话（default-deny） | 现有管理接口（改为以房东页为中心） |
| `GET /` | 访客 | 无 | **平台首页**：示例页展示 + 注册/登录入口（D29） |
| `GET /login` · `GET /register` | 用户 | 无 | 用户登录 / 注册页 |
| `POST /api/auth/register` | 用户 | 无 + 限流 | 注册，注册即送试用额度（必填字段见 §4.5） |
| `POST /api/auth/login` | 用户 | 无 + 限流 | 登录，签发用户会话 |
| `POST /api/auth/logout` | 用户 | 会话 | 登出 |
| `GET /api/auth/session` | 用户 | 无 | 会话探测（未登录返回已登录=false） |
| `GET /app` | 用户 | 会话 | **用户工作台**（自己的全部页面） |
| `GET /api/app/pages` | 用户 | 会话 | 列出自己的页面（含用量与配额） |
| `POST /api/app/pages` | 用户 | 会话 + 配额 | **新建页面**，消耗一次生成额度（§3.7.3） |
| `PATCH /api/app/pages/:id` | 用户 | 会话 + 归属 | 改称呼 / 地址后缀 / 模板 / 语言 |
| `DELETE /api/app/pages/:id` | 用户 | 会话 + 归属 | 删除页面 |
| `POST /api/app/pages/:id/properties` | 用户 | 会话 + 归属 + **配额** | 新增房源（**`status` 固定 `active`**，见 §6.2） |
| `PATCH` / `DELETE /api/app/pages/:id/properties/:pid` | 用户 | 会话 + 归属 | 修改 / 删除房源 |
| `POST /api/app/pages/:id/properties/:pid/media` | 用户 | 会话 + 归属 | 上传房源照片 |
| `POST` / `DELETE /api/app/pages/:id/wechat-qr` | 用户 | 会话 + 归属 | 上传（覆盖语义）/ 删除微信二维码 |
| `POST /api/app/pages/:id/publish` | 用户 | 会话 + 归属 | 发布（就绪校验见 §6.3） |
| `GET /<slug>` | 访客 | 无 | 房东页：房源**列表** |
| `GET /<slug>/<propertyId>` | 访客 | 无 | 单套**详情** |
| `GET /<slug>/qr.svg` | 访客 | 无 | 该房东页的分享二维码（内联 SVG） |
| `GET /<slug>/nearby.json` | 访客 | 无 | 周边信息 |
| `GET /<slug>/contact/<contactId>` | 访客 | 无 + 限流 | 单渠道的**完整值 + 掩码值** |
| `GET /<slug>/contact/<contactId>/qr` | 访客 | 无 + 限流 | 微信二维码图片（语义见 §7.3.1） |
| `GET /p/<旧slug>[/…]` | 访客 | 无 | **301 到 `/<slug>[/…]`** |

> **不设 `GET /<slug>/contact` 列表端点**（D19）：渠道列表由服务端直出首屏 HTML，
> 只含 `{kind, masked, contactId}`。

### 4.2 路由匹配优先级

1. 第二段为保留字 `qr.svg` / `nearby.json` / `contact` → 固定处理器；
2. 否则按 `propertyId` 查该房东页下的房源；
3. 查不到 → 404（不泄露房源是否存在）。

保留字列表集中在 `src/http/routes/` 的一处常量中。

### 4.3 后缀生成与保留字冲突

保留前缀：`/admin`、`/api`、`/media`、`/healthz`、`/assets`、`/favicon.ico`、`/p`、
**`/login`、`/register`、`/app`**（后三者随账号体系新增）。

> **`/manage` 已随 D23 移除**（不再有免登录管理链接）。
> 若漏掉新增的 `/login` / `/register` / `/app`，房东把地址后缀取成 `login` 或 `app` 时，
> **分享链接会被这两个固定路由抢走**，渲染出登录页或工作台 —— 必须一并加入保留字。

**后缀生成**：由 `owner_name` 经 `slugify`；命中保留字、与既有后缀冲突、或 slugify 结果为空时，
追加/回退为 `landlord-<n>`；运营者可在后台手动改写。

### 4.5 注册规则（六次修订补充）

> **属于计划 B**（§2.2）。

§4.1 那行「邮箱 + 密码」低估了实际必填字段。`users` 表有多列是 `NOT NULL`：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `id` | 服务端生成 | `randomUUID()` |
| `workspace_id` | **服务端填入** `ctx.workspace.id` | `NOT NULL` 外键；本期单工作区，注册者一律入默认工作区 |
| `email` | 用户输入 | **必须归一化**：`trim().toLowerCase()` |
| `display_name` | 用户输入 | 可留空，兜底为邮箱 `@` 前的部分 |
| `role` | 固定 `'viewer'` | 服务端写死，不接受客户端传入 |
| `password_hash` | 服务端派生 | §3.7.2 |
| `status` | 固定 `'active'` | |
| `tier` | 固定 `'free'` | 注册即试用档 |
| `is_system` | 固定 `0` | |

**邮箱唯一性**：`idx_users_email` 已存在（`migrations.ts:49`），但 SQLite 默认 `BINARY`
排序规则 —— **大小写会被当成两个账号**，因此必须先归一化再查重与写入。

**冲突处理**：捕获唯一索引冲突，返回**同一句**「该邮箱已被注册」，
**不区分「已存在」与「其它写入失败」**，避免账号枚举。

### 4.4 会话与鉴权（六次修订重写）

D23 取消了免登录管理链接，因此**不再有管理令牌** ——
原先「`/manage/<token>` 5xx 时令牌会落进日志」（`app.ts:174` 记录 `url: request.url`，
而 `logger.redact` 只按键名匹配）的风险**随之消失**。

**两套并行的会话（D30）**：

| | 运营者 | 用户 |
| --- | --- | --- |
| 入口 | `/admin/` | `/login` |
| 凭据 | `ADMIN_PASSWORD`（现状不变） | 邮箱 + 密码（`users.password_hash`） |
| Cookie | `admin_session`（现有） | `user_session`（新增） |
| 作用范围 | `/api/admin/*` | `/api/app/*` |

**分开的原因**：既有运营者鉴权已通过验收且被大量测试覆盖，**改动它的收益远小于风险**。
两套 cookie 各自签名、各自校验，互不提升权限。

**⚠️ 用户会话必须用独立密钥，否则等于把后台权限送给每个注册用户**

现有实现（`src/http/security.ts:51-78`，已核实）：

```ts
export function createSessionToken(secret, ttlMs, now) {
  const payload = { iat, exp, role: 'admin' };   // role 写死
  return signPayload(secret, payload);
}
export function verifySessionToken(secret, token, now) {
  // 只验 HMAC 与 exp，从不检查 role
  return payload;
}
```

而 admin 守卫（`src/http/app.ts:97-110`）只判断 `verifySessionToken(...)` 是否为真。
因此若用户令牌与运营者令牌**共用 `sessionSecret`**，任何注册用户拿自己的令牌
以 `Cookie: admin_session=<token>` 请求 `/api/admin/*` **即可获得运营者权限** ——
这是真实的提权漏洞，公开注册即可利用。

**修法（两层都要做）**：

1. **独立密钥（主要防线）**：用户会话密钥由 `sessionSecret` 做**域分离派生**，
   不新增环境变量：
   ```ts
   const userSessionSecret = createHmac('sha256', sessionSecret).update('zhirai-user-session-v1').digest();
   ```
   两个密钥不同 ⇒ 用户令牌在运营者守卫处**签名校验必然失败**，D30「运营者鉴权不动」成立。
2. **角色校验（纵深防御）**：在 admin 守卫里补一句 `session.role === 'admin'` 判断。
   `SessionPayload.role` 字段**本来就存在**（注释写着「便于后续扩展多用户」），只是从未被校验。
   这是 2 行改动，能把这一类问题永久封死。

**签发与校验函数需要新增（现有函数用不了）**：`createSessionToken` **不接受 payload**、
`iat`/`role` 都是写死的，因此 `{ userId, role, exp }` 按现状写不出来。需新增：

```ts
signSession(secret, payload, ttlMs, now): string
verifySession(secret, token, now): SessionPayload | null   // 载荷扩展为 { iat, exp, role, userId? }
```

**用户会话其余规则**：

- TTL 与运营者会话一致（沿用 `SESSION_TTL_*` 配置）；
- **载荷缺 `userId` 一律视为无效会话**（防止签出一个没有身份的令牌）；
- **越权防护**：所有 `/api/app/*` 端点先校验会话，再校验**资源归属**
  （页面的 `user_id` 必须等于会话里的 `userId`）；归属不符一律返回 **404**（不返回 403，避免探测他人页面是否存在）；
- 登出即清 cookie；用户被 `status = disabled` 后，既有会话在下次校验时立即失效。

---

## 五、运营者后台（`/admin/`）

### 5.1 布局

**修复全屏半截**：`.view` 去掉 `max-width:1100px` 硬上限，改为撑满可用宽度（仅保留内边距）。
表格列宽随容器重新分配，标题与价格不再换行。

> ⚠️ **该上限在 `public/admin/styles.css` 里有两处，必须同时改**：
> `:81`（基础规则，手机端生效）与 `:228`（`@media (min-width:900px)` 内，桌面端生效）。
> 后者位置更靠后，**在 ≥900px 时覆盖前者** —— 只改 `:81` 在 1920px 下毫无效果，验收 1 达不成。

### 5.2 房东列表（首页）

```
统计条：房东数 · 已发布 · 总访问量 · 本月生成

房东     后缀              房源   状态     访问量   创建时间      操作
王阿姨   wang-ayi          3 套   已发布    1,204   2026-10-12   管理 复制分享链接 二维码 导出HTML 撤下
张先生   zhang-xiansheng   1 套   已发布      587   2026-10-12   管理 复制分享链接 二维码 导出HTML 撤下
李女士   li-nvshi          2 套   未发布        0   2026-10-12   管理 复制分享链接 二维码 导出HTML —
```

- 搜索：称呼 / 后缀；筛选：状态（未发布 / 已发布 / 已撤下，**即现有三值，无新增**）
- 「撤下」复用现有 `withdraw` 路由，不新增归档状态
- **新建业主页**：选账号 → 填称呼 → 自动生成地址 → 返回分享链接

### 5.3 房东页详情

| 区块 | 内容 |
| --- | --- |
| 基本信息 | 称呼、后缀（可改）、状态、模板、语言 |
| 房源列表 | 该房东的多套房，可增删改（复用现有房源表单，**移除「发布页」标签**） |
| 联系方式 | **房东级**联系方式 + 微信二维码上传/删除 |
| 分享与导出 | 分享链接、二维码、导出 HTML（ZIP）、自定义域名 |
| 改动记录 | 该房东的修改历史（时间、来源 IP、改动字段名） |

### 5.4 记录（扩展 `audit_logs`）

1. **生成流水**：创建页面、发布、导出、撤下 —— **含 `user_id`**，直接可作计费依据（D28 后期接支付时无需再加字段）；
2. **用户改动**：`/api/app/*` 的每次写操作 —— 时间、IP、改动字段名；
3. **账号事件**：注册、登录、登录失败、会员授予/到期。

### 5.5 用户管理（六次修订新增）

> **属于计划 B**（§2.2）。计划 A 阶段后台只有业主页管理，没有用户管理页。

运营者后台新增「用户」页：

| 功能 | 说明 |
| --- | --- |
| 用户列表 | 邮箱、称呼、档位、到期时间、页面数、注册时间、状态 |
| 授予会员 | 手动设置 `tier` 与 `member_until`（D28 的占位实现，替代支付） |
| 停用账号 | `status = disabled`（既有会话下次校验即失效） |
| 标记示例 | 把某个业主页标为 `is_showcase`，供平台首页展示（§7.6） |
| 改派归属 | 把「历史数据」用户名下的页面改派给真实用户（§3.7.4） |

**隐私约束**：只记字段名，**不记联系方式的完整值**。

---

## 六、用户工作台（`/app`，登录后，手机优先）

> **本章属于计划 B**（§2.2）。计划 A 阶段业主页由运营者在后台代建，没有用户自助入口。

### 6.1 工作台结构

```
/app
├─ 顶部：我的用量 —— 数据来源一目了然（§3.7.3）
│    试用档：免费额度是否已用（users.free_quota_consumed）
│    按次档：剩余生成次数（users.oneoff_credits）
│    月卡/专业：会员到期时间（users.member_until）
├─ 页面列表：每个页面一张卡片
│    页面地址 · 房源 3/10 套 · 状态 · 访问量
│    操作：管理 / 复制分享链接 / 二维码 / 导出HTML / 删除
├─ 新建页面（受配额限制，见 §3.7.3）
└─ 会员：当前档位 · 到期时间 · [升级]（本期为占位入口，D28）
```

点进一个页面 → **三步向导**：

### 6.1.1 三步向导

```
① 我是谁    称呼、电话、微信（可选上传微信二维码）
② 我的房子  逐套添加：标题 / 地址 / 价格 / 面积 / 房型 / 照片（可加多套）
③ 生成      预览 → 发布 → 复制分享链接 / 保存二维码
```

「我的房子」支持增删改；删除有二次确认。

### 6.2 房源状态：向导新建固定为 active（关键）

**问题**：`emptyPropertyForm` 的 `status` 默认是 `draft`（`src/domain/property.ts:63`），
`restoreProperty` 也落回 `draft`（`property-service.ts:127-129`）；而 §6.1 向导字段清单
**没有 status 项**。叠加 §3.1 新增的公开列表筛选
`properties.status NOT IN ('draft','archived')`，结果是：
**房东从向导建的所有房源都会被过滤掉，访客看到一个空列表**，
而发布就绪校验只看标题/地址/照片/联系方式 → 校验照旧通过、分享链接照常显示。
验收 2 与 §10.2 冒烟（房东填 3 套房 → 访客列表）都会失败。

**决策**：

1. **房东端新建房源固定 `status = 'active'`**（向导不暴露该字段；房东要「收起某套房」用删除或后续的归档动作）；
2. **就绪校验追加一条**：该房东页下**至少有一套 `status NOT IN ('draft','archived')` 的房源**，
   否则视为未就绪、不予发布、不展示分享链接；
3. 运营者后台通过既有表单建房时仍可自由设置 `status`（内部使用，不受此限）。

### 6.3 发布就绪校验与失败路径

现有发布带就绪校验（`publish-service.ts:178-182` 不满足即抛 unprocessable；
`collectPublishReadiness` 会因标题或地址为空而阻断）。**D14 必须补失败分支**：

| 情况 | 行为 |
| --- | --- |
| 就绪校验**通过** | 置 `published`，写 `published_at`，生成第 7/15 天提醒，**显示分享链接** |
| 就绪校验**不通过** | **不发布**，停留 `unpublished`；向导列出**具体阻塞项**，说明「补齐后才能生成分享链接」 |

**关键约束**：分享链接**只在发布成功后展示**，这样 §12.3 才成立，不会因漏填地址产生死链。

---

## 七、访客页

> 本章含两块：**平台首页**（§7.6，产品门面）与**业主页**（§7.1–§7.5，房东分享给租客的页面）。

### 7.1 列表页（`/<slug>`）

```
┌─────────────────────────────┐
│  王阿姨的房源                 │   ← owner_name
│  上海 · 浦东新区              │
├─────────────────────────────┤
│  [主图]  浦东新区精装两居室    │
│          ¥8,500/月  2室1卫    │
│          ● 出租中             │
├─────────────────────────────┤
│  [主图]  世纪大道单间          │
│          ¥4,200/月  1室1卫    │
│          ● 已租              │
└─────────────────────────────┘
        [📞 电话]  [💬 微信]      ← 底部固定
```

- 房源筛选：`properties.status NOT IN ('draft','archived')`（注意是**房源**状态，见 §3.1 的双 status 说明）
- 底栏联系渠道来源：**仅房东级**（D20）；无房东级联系方式时**整条底栏不渲染**（统一空态见 §3.2.1）
- 点卡片 → `/<slug>/<propertyId>`

### 7.2 详情页（`/<slug>/<propertyId>`）

**复用现有紧凑详情页**：可滑动图集 + 自动轮播、主图状态标签、折叠区块、底部菜单栏、内置地图。
本期只改三处：§7.3 联系方式、§7.4 费用区、§7.5 房源介绍。

### 7.3 联系方式防抓取

| 层 | 做法 |
| --- | --- |
| 首屏 HTML | 服务端直出渠道列表，**只含 `{kind, masked, contactId}`**（D19） |
| 点击图标 | 前端请求 `/<slug>/contact/<contactId>` 取**完整值** |
| 二维码 | 点击后才请求 `/<slug>/contact/<contactId>/qr` |
| `tel:` 链接 | **不在首屏 HTML 中生成**，点击后再构造 |
| 限流 | 按 IP + 房东页维度，阈值**可配置**（默认 20 次 / 10 分钟），超限 429 |

**响应体**：`{ "kind": "phone", "masked": "138****1234", "value": "13800001234" }`

**掩码规则（服务端唯一实现，首屏 HTML 与接口共用同一口径）**

| `kind` | 规则 | 示例 |
| --- | --- | --- |
| `phone` | 保留前 3 与后 4；长度 < 8 时只保留末 2 | `138****1234` |
| `email` | 保留 `@` 前首字符与完整域名 | `z***@example.com` |
| `wechat` / `whatsapp` / `telegram` / `qq` / `chat` / `other` | 保留首 2 与末 1；长度 ≤ 3 时全部替换为 `*` | `zh***g` |
| 任意 | 长度不足以按规则掩码时，**整体替换为 `***`** | `***` |

**各渠道点击交互**：`phone` → 掩码 + [拨打] [复制]；`wechat` → 有二维码显示二维码，
无则显示微信号 + [复制]；`email` → [写邮件] [复制]；`other` → 完整值 + [复制]。

#### 7.3.1 二维码端点的数据来源与返回语义

`media` 表**没有 `contact_id`**，因此 `/<slug>/contact/<contactId>/qr` 的数据来源必须明确：

| 情况 | 返回 |
| --- | --- |
| `contactId` 对应的渠道 `kind = 'wechat'`，且该房东页存在 `kind='wechat_qr'` 的媒体 | **200** + 二维码图片（`Content-Type` 由存储键扩展名决定） |
| `contactId` 对应渠道不是 `wechat` | **404**（不泄露该渠道是否存在二维码） |
| 该房东页没有上传二维码 | **404**；前端收到 404 后**回退为显示微信号 + [复制]**（与 §7.3 的交互表一致） |

**归属校验**：二维码必须按 **房东页** 取，且该页必须与 URL 中的 `slug` 一致 ——
不得仅凭 `contactId` 跨页取图。

**覆盖语义**：房东重新上传二维码时，**必须先删除被替换的旧 blob**（存储与备份的
`mediaFiles` 计数否则只增不减），再写入新的。

**429 回退**：显示「请求过于频繁，请稍后再试」，保留掩码展示，不出现空白。

**如实说明的限制**（同步写入 README 已知限制）：

- 内存限流在单进程内有效；多实例部署需换共享存储
- 抵御的是**批量自动抓取**，不能阻止真人逐个点击
- 首页仍会暴露「该房东有电话/微信」这一事实
- **导出包是例外**（§9.2）

### 7.4 费用区（紧凑化）

```
价格  8,500 元/月        押金  17,000 元
计价方式  月              可入住  2026-11-01
──────────────────────────────────────────
附加费用
物业费 380 元/月由租客承担；水电燃气按实际用量结算。
```

- **四项同排**（窄屏两列、宽屏四列）
- **价格单位紧跟价格**（`8,500 元/月`），不另起一行
- 「计价方式」显示**当前取值**，不是可选项集合
- 附加费用单独一排，完整展示原文

**计价方式取值（D10）**：表单只提供 **月 / 年 / 总价**；数据库枚举保留
`per_week` / `per_night` 兼容既有数据。

### 7.5 房源介绍紧凑化

- 默认**只显示前 3 行**，超出显示「展开」（原生 `<details>`）
- 收紧行距与段间距；空描述时整块不渲染

---

### 7.6 平台首页（`/`）

> **属于计划 B**（§2.2）。计划 A 阶段 `/` 仍指向 `/admin/`，平台首页在 B 阶段落地。

**现状**：`/` 目前直接跳到 `/admin/`。按 D29 改为**平台首页**，这是产品的门面，
也是「这是一台平台」这一新定位的落点。

```
┌───────────────────────────────────────────────┐
│  ZHIRAI 标识            租客看房 · 房东发页     │  [登录] [免费试用]
├───────────────────────────────────────────────┤
│  把你的房源，做成一个可以发到任何地方的链接       │
│  · 录一次，拿到独立网址  · 二维码一扫就开        │
│  · 手机上看最好         · 随时改，即时生效      │
│                              [免费试用 →]      │
├───────────────────────────────────────────────┤
│  看看别人怎么用的（示例页展示）                  │
│  ┌────────┐ ┌────────┐ ┌────────┐            │
│  │ 示例1  │ │ 示例2  │ │ 示例3  │            │  ← 来自 is_showcase=1
│  └────────┘ └────────┘ └────────┘            │     且 published 的业主页
├───────────────────────────────────────────────┤
│  价格：试用免费 · 按次 ¥9.9 · 月卡 ¥29 · 专业 ¥99 │
├───────────────────────────────────────────────┤
│  Powered by 智睿 · 把想法变成现实                │  ← 品牌页脚（§9.1）
│  © 2026 智睿科技 保留所有权利。                  │
└───────────────────────────────────────────────┘
```

**要点**：

- **示例页来源**：`landlord_pages.is_showcase = 1 AND status = 'published'`，
  由运营者在后台标记（§5.5）。**不得硬编码示例**，也不得展示未发布的页面。
- 价格为**展示文案**，从配置读取（§3.7.3）；本期不接支付，按钮跳转到注册/会员说明。
- 移动端优先：示例卡片在窄屏为横向滑动，与业主页的卡片语言一致。
- 品牌元素遵循 §9.1（ZHIRAI 标识、页脚、版权），不自行发明。

## 八、地图适配器

### 8.1 提供方

| 提供方 | 配置 | 适用 | 代价 |
| --- | --- | --- | --- |
| `osm` | 无需 Key（默认） | 国外 | 国内数据陈旧 |
| `amap` | `MAP_API_KEY` | **国内** | 需注册高德开放平台；商用需授权 |
| `google` | `MAP_API_KEY` | 国外 | 需 Key 且绑定信用卡；国内访问不通 |
| `disabled` | — | 任意 | **保留现有取值** |

**Key 与现有 `MAP_API_KEY` 的关系**：**不新增变量**，沿用 `MAP_API_KEY`（`config.ts:209`）
作为统一密钥位，由 `MAP_PROVIDER` 决定它属于哪个服务商。后续若需同时配置多家再拆分。

**回退**：选 `amap`/`google` 但未配 Key → **自动回落 `osm` 并在后台显著提示**。

**本期范围（D16）**：只做提供方预设、坐标转换、缺 Key 回落提示。
**不交付**需真实 Key 才能验证的联网行为，也不报告为「已验证」。

### 8.2 坐标系：转换作用范围

高德用 **GCJ-02**，OSM/谷歌用 **WGS-84**，混用会偏约 50–500 米。
**数据库统一存 WGS-84，转换只作用于「画在地图上的点」**：

| 消费者 | 处理 |
| --- | --- |
| 地图瓦片与标记（`amap`） | WGS-84 → GCJ-02 后绘制 |
| 地图瓦片与标记（`osm`/`google`） | 直接使用 |
| 页面显示的「经纬度」文本 | **始终 WGS-84** |
| 「在地图中打开」外链 | **始终指向 OSM/Google（WGS-84）** |
| `nearby()` 的 Overpass 查询 | **始终 WGS-84** |

转换算法为公开固定公式（约 30 行纯数学），**自行实现，不引入第三方库**。

### 8.3 瓦片实现

现有 `src/render/mini-map.ts` 已支持 `{z}/{x}/{y}` 模板，高德与谷歌可用同一机制接入，
**不需要引入任何地图 JS 库**。按提供方切换瓦片地址模板与署名文案（受 §8.2 约束）。

---

## 九、复用的现有资产与导出

### 9.1 复用清单

| 能力 | 现状 |
| --- | --- |
| 照片上传、魔数校验、封面设置 | 完整可用 |
| 紧凑详情页渲染 | 完整可用 |
| 自研 SVG 图标（9 个） | 完整可用 |
| 自研地图（滑移 / 缩放 / 降级） | 完整可用，本期加提供方预设 |
| 多语言（4 套界面文案 + 译文表） | 完整可用 |
| 备份 / 恢复 / 校验 | 完整可用，**`BACKUP_TABLES` 必须随迁移更新**（§3.6.3） |
| 运营者会话鉴权（`ADMIN_PASSWORD` + 签名 Cookie） | 完整可用，**本期不动**（D30），CSP 判定须随路由更新（§3.6.3） |
| 上传限制与文件头魔数校验 | 完整可用 |
| **用户账号与密码哈希** | **新增**，但用 `node:crypto` 的 `scryptSync`，**不引入任何依赖**（§3.7.2） |
| 品牌体系（ZHIRAI 图标 / 页脚 / 版权） | 完整可用 |

### 9.2 静态导出（与 §7.3 的交汇）

**现状**：导出产物为「单套房源 × 每种语言一个 HTML + `assets/`」（`export-service.ts:74-113`）。

**改动**：

1. 导出目标改为「整个房东页」—— **1 个列表页 + N 个详情页 + `assets/`**，页间**相对链接**互联
2. 导出包**包含完整联系方式**（D15）—— 离线包取不到联系方式就毫无用处。
   导出件是**房东自己的副本**，由房东自主分发，**不套用 §7.3 的线上首屏防护**
2.1 **语言维度必须交代清楚**：现状是「每套房源 × 每种语言一个 HTML」（`export-service.ts:92-114`），
   改为房东页后变成 **「列表页 × 每种语言」+「每套详情页 × 每种语言」**。
   需定义文件名矩阵（如 `index.html` / `index.en.html` / `p-<id>.html` / `p-<id>.en.html`）
   与**离线相对链接**的生成规则，并保证同一语言内的页间跳转不串语言
3. 保留「这是静态快照」提示条
4. 导出件内联系方式以静态文本呈现，不走 `/contact` 端点

**这是有意的例外，必须在 README 已知限制中写明**：
「导出的静态包包含完整联系方式，请勿当作公开页面分发。」

---

## 十、测试策略

### 10.1 测试迁移（必做任务）

实体翻转会**大量改写现有用例**（涉及 `/p/:slug`、`listing_pages`、提醒）。
实施计划中必须包含**显式的测试迁移任务**，逐条确认改写而非删除。
§3.6.3 已列出具体文件与行号。

### 10.2 新增测试

| 层 | 内容 |
| --- | --- |
| 单元 | 后缀生成与保留字冲突与**空 slug 兜底**、**六类渠道的掩码规则**、WGS-84→GCJ-02 转换、费用区渲染、介绍截断 |
| 单元 | **密码哈希往返与常数时间比较**、配额判定（四档 × 新建页面 × 新增房源）、`member_until` 过期判定 |
| 集成 | **注册/登录/登出/会话探测**、**注册即得试用额度**、**越权访问他人页面返回 404 而非 403**、**配额超限被拒**、**停用账号后会话立即失效**、首页只展示 `is_showcase` 且 `published` 的页面、页面 CRUD、`/<slug>` 路由与**匹配优先级**、发布就绪校验的**失败分支**、**公开页不下探工作区级联系方式**、**向导新建房源默认 `active` 且出现在公开列表**、§10.3 防护断言（第 3 条除外，见下）、限流 429 |

> 同步改写一处既有断言：`public-page.test.ts:179` 断言的空态文案「未公开联系方式」
> 需改为新文案（§3.2.1 统一后的措辞）。
| 迁移 | 无 NULL 归属、`PRAGMA foreign_key_check` 无输出、**索引存在性**（含 `idx_reminders_idempotency` 唯一性）、**多房源共用房东页时的提醒去重**、**备份校验 `ok=true`**、§3.6.5 回归基线 |
| 冒烟 | 运营者建房东页 → 房东填 3 套房 → 发布 → 访客列表 → 详情 → 点击电话取到完整值 → 导出 ZIP |
| 浏览器 | 手机（390×844）与桌面（1920×1080）双视口截图；**1920 宽内容区利用率**专项断言 |

### 10.3 关键回归断言

1. `GET /<slug>` 响应体**不出现**任何完整电话号码数字串
2. `GET /<slug>` 响应体**不出现**联系方式二维码（含 base64 与 `data:` URI）
3. 未点击时**不应有任何**指向 `/contact/<id>` 或 `/contact/<id>/qr` 的预加载请求
   （**只能在浏览器层验证**，不可写成集成断言 —— `inject` 不执行前端脚本）

> 断言范围**限定为联系方式及其二维码**。**分享二维码**（`/<slug>/qr.svg`）是公开分享用的，
> 不属于防护范围，断言不得误伤。

---

## 十一、未决与风险

| # | 事项 | 状态 |
| --- | --- | --- |
| R1 | 高德 / 谷歌 API Key | **未提供**。适配器先做并默认 OSM；拿到 Key 后再做联网验证（D16） |
| R2 | 支付与计费 | 后期阶段，本期只保证流水可被消费 |
| R3 | 限流的分布式一致性 | 单进程内存限流；多实例需换共享存储。**已登记为已知限制** |
| R4 | 迁移入口改造 | `createBackup(ctx)` 需要 `AppContext`，而 `src/db/migrate.ts` 只持 `db`；改造方案在实施计划中定 |
| R10 | 真实支付通道 | 未接。会员由运营者手动授予（D28）；接支付时需新增订单表与回调校验，届时再评估 |
| R11 | 邮箱验证与找回密码 | 未做。依赖真实邮件通道，与「SMTP 未实测」同属后期 |
| R12 | 用户侧限流与配额竞态 | 注册与登录按 IP 限流（复用既有 `LoginRateLimiter`）；**配额校验为应用层，并发下必须放进同一事务**，否则可能出现超额。多进程部署应改 `BEGIN IMMEDIATE` |
| R13 | 新页面的 CSP 与静态托管 | `/`、`/login`、`/register`、`/app` 都是新的 HTML 面：**CSP 的 `allowInlineStyles` 判定要一并纳入**（现按 `/p/` 前缀判定，见 §3.6.3），且现有 `fastifyStatic` 只挂了 `/admin/` 一个 root → 新页面的静态资源托管方式需在计划中定 |

### 11.1 已定案（不再讨论）

| # | 事项 | 定案 |
| --- | --- | --- |
| R5 | `/p/` 兼容跳转 | **需要**，§3.6.4 与 §3.6.3 清单已定 |
| R6 | 联系方式回退链 | 公开页**两级**（房源级 → 房东级），**不下探工作区级**（D21） |
| R7 | 二维码存储 | **复用 `media`** 并按 §3.3 重建表 |
| R8 | `properties` 是否重建 | **不重建**，可空列 + 三重保证（D17） |
| R9 | 是否新增 `archived` 状态 | **不新增**，沿用现有三值（D18，§3.1.1） |

---

## 十二、验收标准

1. 后台首页是**房东表格**，指标为房东口径；1920px 宽下内容区**无大面积空白**，表格不换行
   （`.view` 的 `max-width:1100px` 在 `styles.css:81` 与 `:228` **两处都要去掉**，见 §5.1）
2. 一个房东对应**一个后缀、一个页面**，页面内含其全部房源，访客可列表 → 详情
   （**房东从向导新建的房源必须出现在公开列表里** —— 见 §6.2 的 `status = 'active'` 决策）
3. 用户**注册登录后**在工作台完成填写与修改；**就绪校验通过并发布成功后**
   分享链接立即可用（校验不通过时列出阻塞项，不展示分享链接）
4. `GET /<slug>` 首屏 HTML **不含**任何完整联系方式与**联系方式二维码**数据；
   点击后才可取到（分享二维码不受此限）
5. 费用区按 §7.4 排版；房源介绍按 §7.5 默认折叠
6. 地图提供方可经配置切换，缺 Key 时**自动回落并提示**，不出现空白地图；
   未配 Key 的提供方**不作为「已验证」报告**
7. **迁移后的测试套件（含 §10.1 改写的用例）全部通过**
8. 手机与桌面双视口经真实浏览器验证并留存截图
9. **公开页不出现运营者（工作区级）的联系方式**
10. **账号与配额生效**：注册即得试用额度（1 个页面、每页 1 套）；
    超出配额的新建页面 / 新增房源被明确拒绝并给出升级提示；
    成员到期后已有页面不受影响、但不能新建页面；
    越权访问他人页面返回 404
11. **平台首页（`/`）**只展示被标记为示例**且已发布**的页面，未登录也能浏览与注册
12. 迁移满足全部硬性检查：**既有数据不丢失**（含**每套既有房源的照片数量不变**——
    第 11 步重建 `media` 时必须保留原 `property_id`，不得置 NULL）、

    > **第 10 步「上移并删除房源级公开联系方式」是本设计明确认可的例外**：
    > 迁移前后 `contacts` **总行数不变**（仅公开记录换了归属层级，非公开记录原地保留），
    > 因此「数据未丢失」应使用**计数与归属断言**判定，不得写成逐行快照比对，否则会误判。

    **`landlord_page_id` 无 NULL**、**提醒无 UNIQUE 冲突**、**迁移后备份校验 `ok=true`**

---

*本设计为改版依据。实施顺序、任务拆分与验收细节见后续实施计划。*
