# 后台管理界面（`/admin/`）房源管理能力 · 真实差异审计

- **审计对象**：`E:\轻量化房源管理`（Node 24 + TypeScript + Fastify + SQLite）
- **审计范围**：`src/http/routes/admin-*.ts` 的全部后台端点 ↔ `public/admin/**` 的全部前端代码
- **审计方式**：**只读**。阅读源码 + `Select-String` 交叉引用 + `node:sqlite` 以 `readOnly: true` 打开 `var/db/app.sqlite`
- **数据库读取**：`new DatabaseSync('var/db/app.sqlite', { readOnly: true })`（未使用主库文件 SHA256 判断状态）
- **未做的事**：没有重启 / 停止任何服务，没有触碰 3210 端口，没有执行任何写操作
- **审计基准（重要）**：HEAD = `435cd6d feat(i18n): 展示页语言收口到中英两种；删除重复实现的模块`，但**工作树有大量未提交修改与未跟踪文件**（`git status` 显示 `src/http/app.ts`、`src/server.ts`、`src/config.ts`、`src/http/security.ts`、`src/services/publish-service.ts`、`src/db/migrations.ts`、`tests/**` 等处于 `M`；`src/platform/`、`src/http/routes/platform.ts`、`src/domain/page-safety.ts`、`public/app/` 等为未跟踪）。**本报告读的是工作树当前内容，所有行号都对应工作树版本，不对应 HEAD 提交版本。** 若要复核，请在**当前工作树**上复核；`git checkout` 之后再核行号会对不上。

> **审计纪律声明**
> 本报告**不把「测试通过」当作「功能可用」**。每一项结论都给出 `文件:行号` 或命令输出。
> 凡是不能从源码确证的，一律写「**未验证**」，不做推测。没有粉饰。

---

## 0. 结论速览（先看这个）

| # | 事实 | 数量 |
|---|---|---|
| 1 | `/api/admin/*` 后端端点（§1 各表逐行机器计数） | **60 行** = `admin-*.ts` 59 + `health.ts` 1 |
| 2 | 分类计数（机器核对，和 = 60） | **完整 40 / 不完整 9 / 无调用(有间接物) 6 / 无入口 5** |
| 2b | 其中**界面上连按钮/输入框都不存在**的端点 | **5**：`properties/:id/audit`、`properties/:id/media/reorder`、`reminders/:id`(PATCH)、`diagnostics`、`properties/validate` |
| 2c | 其中**接口已就绪、前端 0 调用，但同一份数据已从别的端点进界面**（死端点） | **6**：`properties/:id/readiness`、`properties/:id/media`(GET)、`templates`、`locales`、`external-services`(GET)、`dev/clock` |
| 3 | `properties` 表实际列数（`PRAGMA table_info` 实测） | **29**（提问中说的「26 列」对不上） |
| 4 | `properties` 表列**在界面上完全没有输入控件** | **1 列**（`postal_code`）；另有 **2 列**是「只读展示」或「程序隐含同步」，无独立控件 |
| 5 | i18n 词典：zh 唯一 key 数 | **280**（`PAIRS` 数组写了 286 条，含 5 组重复） |
| 6 | fr / it / de 三语词典 key 数 | **各 280，与 zh 一一对应，无缺 key** |
| 7 | 界面上**硬编码、未走 i18n 词典**的中文纯文本 | **89 条**（去重后；出现 93 次） |
| 8 | 界面语言切换入口 | **只有 1 个**，在「房源编辑 → 基本信息」里（`property-edit.js:390-394`）；**其它 5 个视图都没有语言切换入口** |
| 9 | `/admin/` 导航入口数 | **5 个**（`index.html:60-64`），与 `views/` 里 6 个视图文件**对得上**（多出的 `property-edit.js` 是详情页，由 hash 路由进入，不在导航里） |
| 10 | 后端真做完、界面上**连按钮都没有**的功能 | **5 项**：照片排序、改提醒时间、房源操作日志、系统诊断、列表排序+分页 |

**三个最重要的发现**（详见 §5、§6、§7）：

1. **`postal_code` 在界面上根本没有输入控件**，但它在公开展示页上是**会被渲染**的（`src/render/page-renderer.ts:80`）。实测数据库里 4 套房源中有 **3 套 `postal_code` 非空**——这些数据现在**在后台完全无法查看和修改**，只能靠直接改库。
2. **房源列表没有排序控件、没有分页控件**，而后端两个能力都已实现待用：`admin-properties.ts:72-73` 接受 `sort`，`property-repo.ts:327-328` 接受 `limit/offset`（上限 200）。前端 `properties.js:137-142` 只传 `search/status/includeArchived`，其余一律吃默认值 → **列表被硬截断在 50 条，第 51 条起永远看不到，且界面不给任何提示**。
3. **i18n 词典与界面文案对不上**：词典 280 个 key 在 zh/en/fr/it/de 五语之间**完全对齐、一个不缺**（§4.2 实测），但**界面上有 89 条中文纯文本根本没有进词典**（§4.3 实测）。`ui.js:119-145` 的「裸文本节点自动扫描」以 `hasKey()`（只查英文词典 `EN`，`i18n.js:426-429`）为唯一准入条件，因此这 89 条在 **en/fr/it/de 四种非中文界面下表现一致——全部原样显示中文**。另有 1 条（删除房源的二次确认后半句）虽在词典里，却因 key 里字面 `\n` 与词典真换行不一致而**恒回落中文**（§4.2 第 3 点）。**注意：只对比词典文件会得出「翻译完整」的错误安全感——必须把界面文案本身也纳入比对。**

---

## 1. 总表：每个后端端点 → 前端是否调用 → 状态分类 → 证据

**分类定义**

- `完整` — 前端有真实调用，且调用后渲染了返回值
- `无入口` — `/admin/` 界面上既没有按钮也没有输入控件能触发它（用户不可能用到）
- `不完整` — 前端有调用，但存在「有按钮没接事件」「返回后没渲染」「能力被 UI 挡住」等问题
- `无调用(有间接物)` — 前端没有直接调它，但同一份数据通过别的端点已经进了界面，或它只是被「顺带」调用来保证不变量

### 1.1 `admin-properties.ts`（14 个）

| 端点 | 方法 | 定义位置 | 前端调用 | 分类 | 证据 |
|---|---|---|---|---|---|
| `/api/admin/overview` | GET | `admin-properties.ts:41` | ✅ | **不完整** | 调用：`app.js:159`。**返回值只用了 `workspace.name`**（`app.js:160-164`）；`properties` / `listings` / `reminders` / `templates` / `timeTravel` / `adapters` / `recentAudit` 全部丢弃。首页**没有任何概览面板** |
| `/api/admin/properties` | GET | `admin-properties.ts:67` | ✅ | **不完整** | 调用：`properties.js:142`。**不传 `sort`、不传 `limit/offset`** → 恒用 `updated_desc` + `limit=50`（默认值见 `admin-properties.ts:69-70`）。返回的 `total` / `statusCounts` 有用（`properties.js:144-145`）；`availabilityStatus` 有用（`properties.js:94`） |
| `/api/admin/properties` | POST | `admin-properties.ts:108` | ✅ | **完整** | `property-edit.js:595`，返回后 `state.id = created.property.id` 并处理 `duplicateOf`（`property-edit.js:596-605`） |
| `/api/admin/properties/:id` | GET | `admin-properties.ts:114` | ✅ | **完整** | `property-edit.js:195`，返回 `property`/`media`/`listingPage`/`readiness` 全部被消费（`property-edit.js:196-199`） |
| `/api/admin/properties/:id` | PATCH | `admin-properties.ts:124` | ✅ | **完整** | `property-edit.js:607` |
| `/api/admin/properties/:id` | DELETE | `admin-properties.ts:129` | ✅ | **完整** | `properties.js:250`（有二次确认 `properties.js:249`） |
| `/api/admin/properties/:id/status` | POST | `admin-properties.ts:134` | ⚠️ 部分 | **不完整** | 只用到 2 个分支：`'archived'`（`properties.js:240`）、`'restore'`（`properties.js:243`）。**`setPropertyStatus` 的通用分支（`draft`/`active`/`reserved`/`closed`，`admin-properties.ts:141`）在这条路径上没有任何 UI 入口**——列表页只能「归档/恢复」。改状态只能在编辑页用表单 PATCH（走的是另一个端点） |
| `/api/admin/properties/:id/duplicate` | POST | `admin-properties.ts:144` | ✅ | **完整** | `properties.js:246`，返回的 `copy.title` 被 toast 使用（`properties.js:247`） |
| `/api/admin/properties/:id/readiness` | GET | `admin-properties.ts:151` | ❌ | **无调用（有间接物）** | 前端 0 处引用。readiness 数据由 `GET /api/admin/properties/:id`（`admin-properties.ts:120`）和 `GET .../listing`（`admin-pages.ts:65`）各自带出，`property-edit.js:199` / `1157` 使用。**这个专用端点自身是死代码** |
| `/api/admin/upload-policy` | GET | `admin-properties.ts:159` | ✅ | **完整** | `property-edit.js:1149`，用于渲染上传上限提示（`property-edit.js:641-642`） |
| `/api/admin/properties/:id/audit` | GET | `admin-properties.ts:166` | ❌ | **无入口** | 前端 0 处引用。**房源详情页没有任何「修改历史 / 操作日志」区域**，用户无法看到某一套房源被谁在何时改过 |
| `/api/admin/meta` | GET | `admin-properties.ts:172` | ✅ | **不完整** | 调用：`property-edit.js:188` + `1142`（**同一入口被请求两次**）。`statuses`/`propertyTypes`/`pricePeriods`/`areaUnits`/`currencies`/`locale`/`currency`/`areaUnit` 均被使用；**`availabilityNote`（`admin-properties.ts:184-185`）返回了但前端从未读取** |
| `/api/admin/properties/validate` | POST | `admin-properties.ts:226` | ❌ | **无入口（冗余端点）** | 前端 0 处引用。校验实际发生在 POST/PATCH 里（`property-edit.js:613-614` 用返回的 `issues` 渲染字段级错误）。**这个「兼容用」端点没有任何调用方，属于纯冗余** |
| `/api/admin/diagnostics` | GET | `health.ts:28` | ❌ | **无入口** | 前端 0 处引用。**界面上没有「系统自检 / 环境诊断」入口**（注意：它只返回脱敏摘要，见 `health.ts:27`） |

### 1.2 `admin-media.ts`（7 个）

| 端点 | 方法 | 定义位置 | 前端调用 | 分类 | 证据 |
|---|---|---|---|---|---|
| `/api/admin/properties/:id/media` | GET | `admin-media.ts:20` | ❌ | **无调用（有间接物）** | 前端 0 处直接调用。媒体列表由 `GET /api/admin/properties/:id` 的 `media` 字段带出（`property-edit.js:197`）。**该端点为死代码** |
| `/api/admin/properties/:id/media` | POST | `admin-media.ts:25` | ✅ | **完整** | `property-edit.js:694`，multipart 上传，含 `sourceNote` |
| `/api/admin/properties/:id/media/link` | POST | `admin-media.ts:53` | ✅ | **完整** | `property-edit.js:707` |
| `/api/admin/media/:mediaId` | PATCH | `admin-media.ts:63` | ✅ | **不完整（降级实现）** | `property-edit.js:764`。**用 `window.prompt()` 收集输入**（`property-edit.js:762`）——不是页面内表单，移动端体验差且无法做校验 |
| `/api/admin/media/:mediaId` | DELETE | `admin-media.ts:69` | ✅ | **完整** | `property-edit.js:758`（有确认 `property-edit.js:757`） |
| `/api/admin/properties/:id/media/reorder` | POST | `admin-media.ts:74` | ❌ | **无入口** | 前端 0 处引用；全仓库搜 `draggable` / `dragstart` / `上移` / `下移` **0 命中**。**界面上没有任何调序控件**。但媒体页却明确写着「可调整顺序」——`property-edit.js:655`「第一张自动成为封面；**可调整顺序**或指定封面。」→ **文案承诺了界面没有的能力** |
| `/api/admin/properties/:id/media/cover` | POST | `admin-media.ts:85` | ✅ | **不完整** | 调用：`property-edit.js:754`。但事件委托绑在 **`body.querySelector('.media-grid')`（单数，只取第一个）** 上（`property-edit.js:718`）。当房源**没有照片**时，照片区渲染的是 `<p class="muted">尚未上传照片。</p>`（`property-edit.js:659`）而不是 `.media-grid` → **视频卡片上的「来源 / 删除」按钮点了没有任何反应** |

### 1.3 `admin-pages.ts`（11 个）

| 端点 | 方法 | 定义位置 | 前端调用 | 分类 | 证据 |
|---|---|---|---|---|---|
| `/api/admin/pages` | GET | `admin-pages.ts:30` | ✅ | **完整** | `pages.js:11`，`items` 全字段渲染（`pages.js:38-60`） |
| `/api/admin/templates` | GET | `admin-pages.ts:32` | ❌ | **无调用（有间接物）** | 前端 0 处引用。模板列表由 `GET .../listing` 带回（`admin-pages.ts:66` → `property-edit.js:1158`） |
| `/api/admin/locales` | GET | `admin-pages.ts:42` | ❌ | **无调用（有间接物）** | 前端 0 处引用。语言清单来自 `GET .../translations` 的 `supportedLocales`/`pageLocales`（`admin-pages.ts:152-155` → `property-edit.js:201`、`841`）。前端自己的 `LOCALES` 常量在 `i18n.js:23-29` |
| `/api/admin/properties/:id/listing` | GET | `admin-pages.ts:48` | ✅ | **不完整（有隐藏副作用）** | 调用：`property-edit.js:1156`。**它是一个 GET，但内部调用 `ensureListingPage`（`admin-pages.ts:49`）会创建 `listing_pages` 行**（`publish-service.ts:57-85`）。打开编辑页 = 一次隐式写库。返回值只用了 `qrSvg` 和 `templates`（`property-edit.js:1157-1158`）；**`publicUrl` / `urlKind` / `urlNote` / `readiness` / `localeLinks` / `translationCount` 全部丢弃**（URL 改从 `state.hosting.state.publicUrl` 取，`property-edit.js:780`） |
| `/api/admin/properties/:id/listing` | PATCH | `admin-pages.ts:72` | ✅ | **完整** | `property-edit.js:899` |
| `/api/admin/properties/:id/publish` | POST | `admin-pages.ts:81` | ✅ | **完整** | `property-edit.js:868`、`pages.js:78` |
| `/api/admin/properties/:id/withdraw` | POST | `admin-pages.ts:85` | ✅ | **完整** | `property-edit.js:878`、`pages.js:81` |
| `/api/admin/properties/:id/preview` | GET | `admin-pages.ts:94` | ✅ | **完整（走 `<a href>`）** | `property-edit.js:810`（新窗口打开）。**同为 GET 且同样有 `ensureListingPage` 副作用**（`admin-pages.ts:97`） |
| `/api/admin/properties/:id/translations` | GET | `admin-pages.ts:142` | ✅ | **完整** | `property-edit.js:201` |
| `/api/admin/properties/:id/translations` | PUT | `admin-pages.ts:159` | ✅ | **完整** | `property-edit.js:478`（切语言时批量写）、`992`（译文表单） |
| `/api/admin/properties/:id/translations/:locale` | DELETE | `admin-pages.ts:166` | ✅ | **完整** | `property-edit.js:1018`（有确认 `property-edit.js:1016`） |

### 1.4 `admin-reminders.ts`（6 个）

| 端点 | 方法 | 定义位置 | 前端调用 | 分类 | 证据 |
|---|---|---|---|---|---|
| `/api/admin/reminders` | GET | `admin-reminders.ts:21` | ✅ | **完整** | `reminders.js:47`。`items` / `nextPending` / `config` / `now` / `timeTravel` 均被使用（`reminders.js:53-78`） |
| `/api/admin/reminders/:id/complete` | POST | `admin-reminders.ts:66` | ✅ | **完整** | `reminders.js:181`——**通过 `remAction` 变量拼接**（`reminders.js:106` 的 `data-rem-action="complete"`）。静态搜索匹配不到，属动态构造 |
| `/api/admin/reminders/:id/skip` | POST | `admin-reminders.ts:70` | ✅ | **完整** | `reminders.js:181`（按钮 `reminders.js:107`） |
| `/api/admin/reminders/:id/reopen` | POST | `admin-reminders.ts:74` | ✅ | **完整** | `reminders.js:181`（按钮 `reminders.js:108`） |
| `/api/admin/reminders/:id` | PATCH | `admin-reminders.ts:78` | ❌ | **无入口** | **前端 0 处调用。提醒列表里没有任何「改计划时间」控件**（表头见 `reminders.js:88`，只有「房源/提醒类型/计划时间/状态/尝试/最后错误/操作」）。后端 `rescheduleReminder` 已实现并已接路由，**用户无法在界面上改提醒时间** |
| `/api/admin/reminders/dispatch` | POST | `admin-reminders.ts:85` | ✅ | **完整** | `reminders.js:132`，返回 `report` 全字段渲染（`reminders.js:139-148`） |

**顺带发现（前端 bug）**：`reminders.js:175` 直接 `container.querySelector('tbody').addEventListener(...)`（**没加 `?.`**）。当提醒列表为空时，`reminders.js:93` 渲染的是一行 `colspan=7` 的「暂无提醒」，`<tbody>` 仍存在，所以不会崩；但这是唯一一处没有防御性判断的查询。

### 1.5 `admin-settings.ts`（10 个）

| 端点 | 方法 | 定义位置 | 前端调用 | 分类 | 证据 |
|---|---|---|---|---|---|
| `/api/admin/settings` | GET | `admin-settings.ts:28` | ✅ | **不完整** | `settings.js:11`。`workspace` / `reminders` / `adapters` / `areaUnits` / `externalServices` 被用；**`config`（`redactedConfig`）只被取了 `map.tileUrl`、`mail.smtpHost`、`hosting.cnameTarget`、`hosting.domainVerifyPrefix`、`map.freeTierNote` 五项**（`settings.js:51-60`） |
| `/api/admin/settings` | PATCH | `admin-settings.ts:50` | ✅ | **完整** | `settings.js:89` |
| `/api/admin/external-services` | GET | `admin-settings.ts:112` | ❌ | **无调用（有间接物）** | 前端 0 处直接调用。同一份 `listExternalServices` 数据由 `GET /api/admin/settings` 带回（`admin-settings.ts:47` → `settings.js:152`）。**该端点为死代码** |
| `/api/admin/external-services` | PUT | `admin-settings.ts:118` | ✅ | **不完整** | `settings.js:136`。**表单只允许登记 `adapterKind` ∈ {map, storage, mail, hosting}**（`settings.js:163-170`），但后端 `ADAPTER_KINDS` 还含 `dns` / `clock`（`admin-settings.ts:112-116` 的 `kinds`）。**`dns` 与 `clock` 无法通过界面登记**。另：`data-config-key` 只硬编码了一个 `tileUrl`（`settings.js:178`），其它配置键无法录入 |
| `/api/admin/audit` | GET | `admin-settings.ts:179` | ✅ | **完整** | `settings.js:101`，**但为手动触发**（需点「刷新」按钮 `settings.js:79`，初始状态是「点击刷新以加载」（`settings.js:81`）） |
| `/api/admin/properties/:id/hosting` | GET | `admin-settings.ts:187` | ✅ | **完整** | `property-edit.js:202`。**同为 GET 却有副作用**——内部 `hostingState` 调用 `ensureListingPage`（`hosting-service.ts:38`） |
| `/api/admin/properties/:id/hosting/domain` | POST | `admin-settings.ts:193` | ✅ | **完整（受环境变量门控）** | `property-edit.js:1094`。**仅当 `h.allowsCustomDomain` 为真时才渲染表单**（`property-edit.js:1052`）；否则显示「请设置环境变量 `HOSTING_PROVIDER=custom_domain`」（`property-edit.js:1043-1045`）。默认托管模式下**用户看不到绑定按钮** |
| `/api/admin/properties/:id/hosting/verify` | POST | `admin-settings.ts:199` | ✅ | **完整（同上受门控）** | `property-edit.js:1109` |
| `/api/admin/properties/:id/hosting/domain` | DELETE | `admin-settings.ts:203` | ✅ | **完整（同上受门控）** | `property-edit.js:1122` |

### 1.6 `admin-backup.ts`（5 个）

| 端点 | 方法 | 定义位置 | 前端调用 | 分类 | 证据 |
|---|---|---|---|---|---|
| `/api/admin/backups` | GET | `admin-backup.ts:17` | ✅ | **完整** | `backup.js:11` |
| `/api/admin/backups` | POST | `admin-backup.ts:23` | ✅ | **完整** | `backup.js:72` |
| `/api/admin/backups/verify` | POST | `admin-backup.ts:28` | ✅ | **完整** | `backup.js:102`，`ok` / `tables` / `problems` 均渲染（`backup.js:103-109`） |
| `/api/admin/backups/restore-drill` | POST | `admin-backup.ts:38` | ✅ | **完整** | `backup.js:111`，`targetDir` / `databaseFile` / `restoredMediaFiles` / `restoredTables` 均渲染（`backup.js:112-118`） |
| `/api/admin/backups/prune` | POST | `admin-backup.ts:52` | ✅ | **完整** | `backup.js:84` |

> **注意语义边界**：这里只有「**恢复演练**」（解包到独立目录，不动运行中的数据）和「**校验**」。**没有「从备份真正恢复覆盖当前库」的端点，界面上也没有对应按钮**。这是设计如此（见 `admin-backup.ts:37` 注释），不是缺口，但容易被误读为「后台能做恢复」。

### 1.7 `admin-export.ts`（3 个）

| 端点 | 方法 | 定义位置 | 前端调用 | 分类 | 证据 |
|---|---|---|---|---|---|
| `/api/admin/properties/:id/export.zip` | GET | `admin-export.ts:13` | ✅ | **完整（走 `<a href>`）** | `property-edit.js:856` |
| `/api/admin/properties/:id/export` | POST | `admin-export.ts:34` | ✅ | **完整** | `property-edit.js:911`，`files.length` / `entry` 渲染（`property-edit.js:912`） |
| `/api/admin/properties/:id/export-preview` | GET | `admin-export.ts:47` | ✅ | **完整（走 `<a href>`）** | `property-edit.js:858` |

### 1.8 `admin-auth.ts`（5 个）

| 端点 | 方法 | 定义位置 | 前端调用 | 分类 | 证据 |
|---|---|---|---|---|---|
| `/api/admin/login` | POST | `admin-auth.ts:28` | ✅ | **完整** | `app.js:131` |
| `/api/admin/logout` | POST | `admin-auth.ts:68` | ✅ | **完整** | `app.js:146`（顶部栏 + 侧栏两个按钮都绑了，`app.js:153-155`） |
| `/api/admin/session` | GET | `admin-auth.ts:73` | ✅ | **完整** | `app.js:173` |
| `/api/admin/dev/advance-time` | POST | `admin-auth.ts:91` | ✅ | **完整** | `reminders.js:164` / `166` / `167`。**仅当 `DEV_TIME_TRAVEL=true` 时可用**；未启用时 `reminders.js:21-25` 渲染的是配置说明而不是按钮 |
| `/api/admin/dev/clock` | GET | `admin-auth.ts:147` | ❌ | **无调用（有间接物）** | 前端 0 处引用。是否启用时间旅行由 `GET /api/admin/reminders` 的 `timeTravel.enabled` 带回（`admin-reminders.ts:62` → `reminders.js:78`）。**该端点为死代码** |

### 1.9 端点分类汇总

**四条互斥的判据（每个端点只归一类）：**

- **A `完整`** — 前端有调用，且返回值被消费
- **B `不完整`** — 前端有调用，但返回值被部分丢弃 / 能力被 UI 结构挡住
- **C `无调用（有间接物 / 死端点）`** — 前端 0 处调用，但同一份数据经别的端点已进界面，或它本身是纯冗余端点
- **D `无入口（界面无任何控件）`** — 前端 0 处调用 **且** 没有任何 UI 控件

**机器核对结果**（脚本数 §1.1–§1.8 各表里以 `` | `/api/ `` 开头的行，并按分类单元格归类）：

```
§1.1 admin-properties.ts  ->  14 行
§1.2 admin-media.ts       ->   7 行
§1.3 admin-pages.ts       ->  11 行
§1.4 admin-reminders.ts   ->   6 行
§1.5 admin-settings.ts    ->   9 行   （注释写「10 个」，实为 9 行 —— 以行数为准）
§1.6 admin-backup.ts      ->   5 行
§1.7 admin-export.ts      ->   3 行
§1.8 admin-auth.ts        ->   5 行
                             ─────
                    合计      60 行

分类计数：{ A 完整: 40, B 不完整: 9, C 无调用（有间接物）: 6, D 无入口: 5 }  和 = 60  ✓
```

| 分类 | 数量 | 端点 |
|---|---|---|
| **A 完整** | **40** | 见 §1.1–§1.8 各表标 ✅ 且「完整」的行（含 3 个走 `<a href>` 直连的 GET，以及 4 个受环境变量门控的 hosting 端点） |
| **B 不完整** | **9** | `properties`(GET)、`properties/:id/status`（只覆盖 2/5 状态）、`meta`（`availabilityNote` 丢弃 + 同入口请求两次）、`media/:mediaId`(PATCH)（`window.prompt`）、`media/cover`（事件委托只绑第一个网格）、`listing`(GET)（6 个字段丢弃 + GET 有写副作用）、`settings`(GET)、`external-services`(PUT)（`dns`/`clock` 无法登记）、`overview`（只用了 `workspace.name`） |
| **C 无调用（有间接物 / 死端点）** | **6** | `properties/:id/readiness`、`properties/:id/media`(GET)、`templates`、`locales`、`external-services`(GET)、`dev/clock` |
| **D 无入口（界面无任何控件）** | **5** | `properties/:id/audit`、`properties/:id/media/reorder`、`reminders/:id`(PATCH)、`diagnostics`、`properties/validate`（冗余端点） |

**两处需要单独说明的计数：**

- **4 个 hosting 端点归入 A（完整）**，但要附加条件：**仅当 `hostingState().allowsCustomDomain` 为真时才渲染表单**（`property-edit.js:1052`）。默认托管模式下这 4 个端点在界面上**用户看不到入口**。如果你更关心「默认部署下用户能不能用到」，应把这 4 个从 A 移到 D。
- **3 个导出/预览端点归入 A**，但它们走的是 `<a href>` 直连（`property-edit.js:810`、`856`、`858`），不是 `api.*` 调用。这是有意设计（浏览器原生下载/新窗口），不算缺口。

> 诚实说明：上面所有数字是**机器数出来的行数**，不是目测。「行数」与「唯一 URL 路径数」不相等（同一个路径的两个 HTTP 方法各占一行），因此 §1.5 的标题「10 个」与实际 9 行不一致——**以行数为准**。

---

## 2. 房源字段覆盖表

### 2.1 先纠正一个前提：`properties` 表是 **29 列**，不是 26 列

命令与输出（只读）：

```
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('var/db/app.sqlite',{readOnly:true});console.log(db.prepare('PRAGMA table_info(properties)').all().length)"
# → 29
```

完整列清单（`PRAGMA table_info(properties)`，`cid` 升序）：

| # | 列名 | 类型 | 说明 |
|---|---|---|---|
| 0 | `id` | TEXT | 主键 |
| 1 | `workspace_id` | TEXT NOT NULL | 工作区归属 |
| 2 | `title` | TEXT NOT NULL | |
| 3 | `description` | TEXT NOT NULL | |
| 4 | `address_line` | TEXT NOT NULL | |
| 5 | `district` | TEXT NOT NULL | |
| 6 | `city` | TEXT NOT NULL | |
| 7 | `region` | TEXT NOT NULL | |
| 8 | `country_code` | TEXT NOT NULL | |
| 9 | **`postal_code`** | TEXT NOT NULL | ← **见下方缺口** |
| 10 | `latitude` | REAL | |
| 11 | `longitude` | REAL | |
| 12 | `property_type` | TEXT NOT NULL | |
| 13 | `bedrooms` | INTEGER | |
| 14 | `bathrooms` | INTEGER | |
| 15 | `area_value` | REAL | |
| 16 | `area_unit` | TEXT NOT NULL | |
| 17 | `floor_note` | TEXT NOT NULL | |
| 18 | `price_amount` | REAL | |
| 19 | `price_currency` | TEXT NOT NULL | |
| 20 | `price_period` | TEXT NOT NULL | |
| 21 | `deposit_amount` | REAL | |
| 22 | **`deposit_currency`** | TEXT NOT NULL | ← **无独立控件** |
| 23 | `extra_fees_note` | TEXT NOT NULL | |
| 24 | `available_from` | TEXT | |
| 25 | `status` | TEXT NOT NULL | |
| 26 | `created_at` | TEXT NOT NULL | |
| 27 | `updated_at` | TEXT NOT NULL | |
| 28 | **`availability_status`** | TEXT NOT NULL DEFAULT 'available' | v2 迁移加列（`src/db/migrations.ts:208`） |

另核对：`schema_migrations` 当前为 v1–v7（`initial_schema` / `property_availability_status` / `platform_foundation` / `session_revocation` / `project_public_slug` / `project_version_snapshot` / `plugin_installation_scope`）——**v1 建表 27 列 + v2 加 1 列 = 28**，实测 29 是因为 v1 建表语句本身就有 28 列（`src/db/migrations.ts:51-80` 含 `postal_code`）。此处不再展开，以 `PRAGMA table_info` 实测 **29** 为准。

### 2.2 逐列 → 界面控件对照

「控件位置」均指 `public/admin/views/property-edit.js`（分页签：基本信息 / 发布页面 / 多语言）。

| 列名 | 有输入控件？ | 控件在哪个文件哪一行 | 说明 |
|---|---|---|---|
| `id` | ❌ 只读展示 | `property-edit.js:232` | 页头显示 `ID：<span class="mono">…` |
| `workspace_id` | ❌ 无 | — | 内部字段，由 `ctx.workspace.id` 决定（`admin-properties.ts:77`），不应有控件 |
| `title` | ✅ | `property-edit.js:398-401` | `field({ label:'标题', name:'title', required:true })` |
| `description` | ✅ | `property-edit.js:409-410` | textarea |
| `address_line` | ✅ | `property-edit.js:419-420` | 「详细地址」 |
| `district` | ✅ | `property-edit.js:418` | 「区/县」，combo |
| `city` | ✅ | `property-edit.js:417` | 「城市」，combo |
| `region` | ✅ | `property-edit.js:415-416` | 「省/州」，combo |
| `country_code` | ✅（间接） | `property-edit.js:413-414` + 303-316 | 界面上是「国家/地区」文本框 `countryDisplay`，真正的值存在**隐藏字段** `countryCode`（`property-edit.js:150`）；手打不中预设时会**清空**（`property-edit.js:315`） |
| **`postal_code`** | ❌ **完全没有** | — | **全仓库搜索**：`Select-String -Path public -Pattern 'postalCode|postal_code|邮政编码|邮编'` → **只有 1 处命中，且只是默认值对象里的字面量**（`property-edit.js:377`）。表单里没有这个字段，`readForm()` 读不到它，PATCH 不会提交它 |
| `latitude` | ✅ | `property-edit.js:454` | 收在 `<details>` 里（`property-edit.js:443-458`） |
| `longitude` | ✅ | `property-edit.js:455` | 同上 |
| `property_type` | ✅ | `property-edit.js:407-408` | 有「未指定」空选项 |
| `bedrooms` | ✅ | `property-edit.js:425` | |
| `bathrooms` | ✅ | `property-edit.js:426` | |
| `area_value` | ✅ | `property-edit.js:423-424` | 带单位后缀下拉 |
| `area_unit` | ✅ | `property-edit.js:424`（`suffixSelect` 定义在 `property-edit.js:39-48`） | 贴在面积输入框右侧 |
| `floor_note` | ✅ | `property-edit.js:427-428` | |
| `price_amount` | ✅ | `property-edit.js:431-433` | 带币种后缀 |
| `price_currency` | ✅ | `property-edit.js:432` | 后缀下拉 |
| `price_period` | ✅ | `property-edit.js:434` | |
| `deposit_amount` | ✅ | `property-edit.js:435-436` | |
| **`deposit_currency`** | ⚠️ **无独立控件，被程序强制同步** | `property-edit.js:582` | `if (values.priceCurrency) values.depositCurrency = values.priceCurrency;` —— **保存时押金币种永远被改写成价格币种**。如果想登记「价格 USD / 押金 CNY」，一保存就被改掉，**用户不知道**（提示文案 `property-edit.js:436` 只说「与价格使用同一种币种」，算是有交代，但这是**静默覆盖已有数据**） |
| `extra_fees_note` | ✅ | `property-edit.js:438-439` | |
| `available_from` | ✅ | `property-edit.js:437` | `type="date"` |
| `status` | ✅ | `property-edit.js:402-403` | 下拉，选项来自 `/api/admin/meta`（`admin-properties.ts:173-179`） |
| `created_at` | ❌ 无 | — | 界面上任何地方都没有显示创建时间 |
| `updated_at` | ❌ 只读展示 | `property-edit.js:232` | 「最后更新 …」 |
| `availability_status` | ✅ | `property-edit.js:404-406` | 下拉「可租状态」 |

### 2.3 缺失/异常列汇总

| 类别 | 列名 | 后果 |
|---|---|---|
| **界面上完全没有输入控件** | **`postal_code`** | 展示页会渲染它（`src/render/page-renderer.ts:80`，`composeAddress` 把它拼在地址末尾），API 也接受它（`src/domain/property.ts:148`），DB 里有值（实测 4 行中 3 行非空）。**用户在后台看不到、改不了、也删不掉这个字段的值** |
| 无独立控件（被程序强制同步） | `deposit_currency` | 保存时被静默改写为 `price_currency`（`property-edit.js:582`） |
| 无输入控件（合理） | `id` / `workspace_id` / `created_at` | 前者只读展示，后两者属内部/未展示 |
| 只读展示无控件 | `updated_at` | 仅显示 |

### 2.4 表单实际控件清单（用于核对）

基本信息页签共 **23 个可提交字段**（全部带 `data-field`，由 `ui.js:230-238` 的 `readForm()` 收集）：
`title`、`status`、`availabilityStatus`、`propertyType`、`description`、`countryCode`、`region`、`city`、`district`、`addressLine`、`areaValue`、`areaUnit`、`bedrooms`、`bathrooms`、`floorNote`、`priceAmount`、`priceCurrency`、`pricePeriod`、`depositAmount`、`availableFrom`、`extraFeesNote`、`latitude`、`longitude`。
发布页面页签另有 **3 个**：`slug`、`locale`、`templateId`（`property-edit.js:839-843`）。
多语言页签另有 **3 个**：`locale`、`title`、`description`（`property-edit.js:968-976`）。

---

## 3. 房源列表（`properties.js`）能力实测

| 能力 | 后端支持 | 前端使用 | 结论 |
|---|---|---|---|
| **搜索** | ✅ `admin-properties.ts:79` / `property-repo.ts:300-311` 匹配 `title`/`city`/`district`/`address_line`/`region` | ✅ `properties.js:162` 输入框 + `188-194` 320ms 防抖 | **可用**（但不搜 `description`、不搜 `postal_code`、不搜译文） |
| **状态筛选** | ✅ `admin-properties.ts:78` | ✅ `properties.js:163-174`，下拉含 全部/草稿/在售在租/已预订/已成交/已归档 | **可用** |
| **归档可见性** | ✅ `admin-properties.ts:80` | ✅ `properties.js:175-178`「含归档」复选框 | **可用** |
| **可租状态筛选** | ❌ 后端**不支持** `availabilityStatus` 过滤（`ListQuery` 里没有这个字段，`admin-properties.ts:30-37`） | ❌ | **双向都没有**（既然后端没做，这条不算前后端差异，但要记：用户无法「只看已租 / 只看未确认」） |
| **排序** | ✅ `admin-properties.ts:72-73` 接受 `sort` ∈ {`created_desc`, `title_asc`}，其它一律 `updated_desc`（`property-repo.ts:320-325`） | ❌ **完全不传** `sort`（`properties.js:137-141` 只 set 了 `search`/`status`/`includeArchived`） | **后端有、前端无入口**。列表**永远只能按「最后更新倒序」** |
| **分页** | ✅ `admin-properties.ts:69-70` 接受 `limit`/`offset`，`property-repo.ts:327` 夹取到 **1–200**，默认 **50** | ❌ **完全不传** `limit`/`offset`（同上） | **后端有、前端无入口**。列表**硬截断在 50 条**；`total` 拿到了（`properties.js:144`）**但界面没有分页器、也没有「仅显示前 50 条」的提示**。第 51 条起**永远看不到**，且没有任何迹象 |

当前数据量（只读查询）：`properties` 共 **4 行**、`listing_pages` 3 行、`media` 15 行，分布在 **2 个 workspace**。
→ **50 条上限在当前数据量下不会暴露**。这是「测试通过 ≠ 功能可用」的典型：现有数据永远测不出这个缺口。

### 3.1 状态展示

| 字段 | 展示方式 | 位置 |
|---|---|---|
| `status` | 卡片右上角 `<span class="tag">` 文字标签 | `properties.js:95`（`tag(property.status)`），中文映射表在 `ui.js:43-47` |
| `availability_status` | 卡片右上角另一个标签，颜色映射 `available→active` / `rented→archived` / `unconfirmed→pending` | `properties.js:94`（`availabilityTag(property.availabilityStatus)`），实现 `properties.js:34-42` |
| 推导值 `unconfirmed` | **后端算好再下发**：`admin-properties.ts:88-94` 用 `resolveAvailability(...)` 结合 `ctx.config.listingStaleDays` | 列表**不会**显示「为什么是未确认」的天数依据 |
| 发布状态 | 卡片底部显示 slug，或「尚未创建页面」 | `properties.js:84-86` |
| 照片数 | 「N 张」 | `properties.js:108` |

---

## 4. 多语言缺口

### 4.1 结构

- `public/admin/i18n.js` 的 `PAIRS` 是 `[中文原文, 英文译文]` 数组，**中文原文即 key**（设计说明见 `i18n.js:5-21`）
- `public/admin/i18n-fr.js` / `i18n-it.js` / `i18n-de.js` 各自导出 `new Map(Object.entries({...}))`，**key 同样是中文原文**
- 查找：`t(zh)`，查不到**原样返回中文**（`i18n.js` 末尾的 `t` 实现）

### 4.2 key 集合对比（脚本实测，非估算）

我用脚本分别解析 `PAIRS` 数组的字符串键与三份词典的 `"key":` 键，做集合差：

```
i18n.js PAIRS 条数 = 286
fr 条数 = 280
it 条数 = 280
de 条数 = 280

fr MISSING 1 / EXTRA 1
  [MISS] "」？\n\n将同时删除该房源的展示页、照片文件与提醒，且不可恢复。"
  [EXTRA] "」？<换行><换行>将同时删除该房源的展示页、照片文件与提醒，且不可恢复。"

it MISSING 1 / EXTRA 1   （同上）
de MISSING 1 / EXTRA 1   （同上）
```

**结论：**

1. **`PAIRS` 有 286 条，但唯一 key 只有 280 个**——`PAIRS` 里有 5 组重复键。脚本输出的重复项：
   `已归档 x2`、`恢复 x2`、`照片与视频 x3`、`发布前需要先完善： x2`、`时区，例如 Asia/Shanghai；提醒规则按此时区计算 x2`。
2. **fr / it / de 各 280 条，与 zh 的 280 个唯一 key 一一对应，没有真正的缺 key。**
3. 上面那条 `[MISS]` **不是缺 key，是我的解析器把它读成了字面反斜杠 `\n` 而不是真换行**造成的假阳性——三份词典里存的都是**真换行**，唯独 `i18n.js:239` 的 `PAIRS` 条目里写的是**字面转义序列 `\n\n`**：
   - `public/admin/i18n.js:239` → `['」？\n\n将同时删除该房源的展示页、照片文件与提醒，且不可恢复。',`
   - `public/admin/i18n-de.js` → `"」？\n\n将同时删除…": "…"`
   - 但**这个 key 在前端根本不会被查**：`properties.js:249` 是
     `` `${t('确定要彻底删除「')}${title}${t('」？\\n\\n将同时删除该房源的展示页、照片文件与提醒，且不可恢复。')}` ``
     ——注意 `t()` 收到的参数是**含字面 `\n` 的两字符/多字符短串 `」？\n\n将同时删除…`**，而它**不在词典里**（词典里的 key 是真换行），所以 `t()` 回落成中文原文。**后果：删除房源的二次确认对话框，无论界面语言是什么，后半句恒为中文。**

### 4.3 硬编码中文（未走 i18n）

脚本对 `public/admin/**`（排除词典文件本身）逐行抽取「纯文本中文字面量」（剔除含 `<`/`>`/`${`/`` ` ``/`+` 的拼接片段，剔除注释），再用**真实加载的 `i18n.js` 的 `hasKey()`** 逐条判定：

```
候选中文字符串总数 = 337
其中词典里查不到的 = 116   （含 HTML 片段等噪声）
```

进一步过滤出**纯文本**（无标签、无插值）后：

**→ 89 条硬编码中文，词典里查不到，出现 93 次。**

按文件分布：

| 文件 | 条数 | 代表条目 |
|---|---|---|
| `public/admin/index.html` | 10 | `"登录"`(:32)、`"管理口令"`(:28)、`"管理口令由服务端环境变量 ADMIN_PASSWORD 配置，不在界面里修改。"`(:34)、`"一次录入房源信息，一键生成可分享的展示页。"`(:24)、`"登录后可以管理房源、照片、提醒，并发布可分享的公开页面。"`(:25)、`"主导航"`(:78)、`"智睿"`(:47)、`"© 2026 智睿科技 保留所有权利。"`(:71)、`"轻量化房源管理"`(:22)、`"房源管理后台 · 轻量化房源管理平台"`(:8) |
| `public/admin/views/property-edit.js` | 37 | `"上传"`(:647)、`"视频"`(:665)、`"封面"`(:737)、`"来源"`(:742)、`"发布状态"`(:785)、`"尚未创建"`(:786)、`"提示："`(:798)、`"撤下页面"`(:807)、`"预览效果"`(:810)、`"复制链接"`(:826)、`"发布设置"`(:836)、`"发布失败"`(:872)、`"撤下失败"`(:882)、`"（无描述）"`(:938)、`"请选择语言"`(:972)、`"保存译文"`(:978)、`"删除失败"`(:1022)、`"托管方式"`(:1038)、`"绑定"`(:1058)、`"DNS 验证指引"`(:1076)、`"已解绑"`(:1123)、`"解绑失败"`(:1126) … |
| `public/admin/views/settings.js` | 13 | `"适配器类型"`(:160)、`"服务商标识"`(:172)、`"密钥环境变量名"`(:173)、`"免费额度说明"`(:174)、`"保存配置"`(:181)、`"服务商"`(:185)、`"密钥引用"`(:185)、`"无"`(:191)、`"对象"`(:102)、`"详情"`(:102) … |
| `public/admin/views/reminders.js` | 10 | `"提醒类型"`(:88)、`"尝试次数"`(:101)、`"最后错误"`(:88)、`"标记完成"`(:106)、`"关闭提醒"`(:107)、`"重新启用"`(:108)、`"规则说明"`(:120)、`"未配置"`(:67) … |
| `public/admin/views/backup.js` | 5 | `"备份目录："`(:32)、`"备份中…"`(:70)、`"清理失败"`(:88)、`"校验通过。"`(:104)、`"表行数："`(:104) |
| `public/admin/views/properties.js` | 5 | `"月"`/`"周"`/`"晚"`/`"年"`(:24)、`"已复制为「"`(:247) |
| `public/admin/app.js` | 1 | `"登录失败"`(:136) |
| `public/admin/help.js` | 1 | `"说明"`(:19) |
| `public/admin/ui.js` | 4 | `"已关闭"`/`"发送失败"`(:46) 等状态标签 |

> 说明：`ui.js:46` 的 `STATUS_LABELS` 里 `已关闭` / `发送失败` 不在词典中，但同一张表里的 `草稿/在售/在租/已预订/已成交/已归档/未发布/已发布/已撤下/待处理/已完成/跳过` **在词典中**，因此这张表是「部分可译、部分恒中文」的混合状态。

### 4.4 翻译管线的准入条件：`hasKey()` 只查英文词典（我自己先判断错了，这里留档更正）

我先前的假设是「`ui.js:174` 的 `isEnglish()` 让 fr/it/de 不做文本扫描，导致三语漏译」。
**读代码后确认这个假设是错的**，留档如下：

`public/admin/ui.js:174`：

```js
if (isEnglish()) scanTextNodes(root);
```

`public/admin/i18n.js:422-429`：

```js
export function isEnglish() { return current !== 'zh-CN'; }   // ← 名字有误导性，语义是「非中文」
export function hasKey(zh) { return EN.has(zh); }             // ← 只看英文词典 EN
```

因此实际行为是：

- `applyI18n()` 的四条机制在**全部五种语言**下都生效：`[data-i18n]` 元素（`ui.js:149-151`）、`<option>`（`ui.js:153-158`）、`input[placeholder]`（`ui.js:160-165`）、`[data-i18n-tip]` / `[data-i18n-ph]`（`ui.js:166-173`）
- **裸文本节点扫描在 fr / it / de 下也执行**（`current !== 'zh-CN'` 为真），**不是**只在英文下执行
- 扫描的准入条件是 `ui.js:140` `if (!hasKey(trimmed)) continue;`，而 `hasKey` 只查**英文词典 `EN`**。由于 fr/it/de 的 280 个 key 与 zh/EN 一一对应（§4.2 实测），**一个中文串只要在 EN 里有，在 fr/it/de 里也一定有** → 「非中文即扫描 + 只查 EN」这个组合**不会**造成 fr/it/de 相对英文的额外漏译

**更正后的结论**：§4.3 那 **89 条硬编码中文，在 4 种非中文界面（en/fr/it/de）下全部原样显示中文**，四种语言的表现**一致**，根因是**这些串压根不在词典里**，而不是语言判断。
`ui.js:115-118` 的注释说扫描「天然避开了用户数据」，这成立；但它**同样天然避开了所有没进词典的界面文案**——而这批文案有 89 条。**这就是词典对齐（§4.2 零缺 key）与界面实际表现（89 条恒中文）之间的全部差额。**

> 这一节的价值在于：**「词典没有缺 key」这个结论是真的，但它不能推出「界面翻译完整」。** 只对比词典文件会得出错误的安全感——必须把界面上的文案本身也纳入比对。

### 4.5 界面语言切换入口只有 1 个

- 唯一入口：`property-edit.js:390-394` 的 `.lang-switch`（LOCALES 列表来自 `i18n.js:23-29`），点击处理器 `property-edit.js:549-570`
- 初始语言：`app.js:50-61`（读 `localStorage.adminLocale`，否则按 `navigator.language` 是否 `zh` 决定 zh-CN / en）
- `localStorage` 写入点只有一处：`property-edit.js:562`
- **后果**：一个德语用户首次打开后台，界面是英文（`app.js:58` 的兜底是 `en`），**他必须先进某套房源 → 基本信息页签 → 才找到语言按钮**。登录页、房源列表、发布页面、提醒、设置、备份与恢复这 6 个界面**都没有语言入口**。
- `.lang-switch` 这个控件同时承担两个职责：改**界面语言** + 切换正在填写的**数据语言**（`property-edit.js:543-548` 注释）。在编辑房源时改界面语言，会**顺带把「正在填写的语言」也切走**（`property-edit.js:556-560`）——这是有意的设计，但对「只想把界面换成德语」的用户是意外副作用。

---

## 5. 外壳、路由与导航清单

### 5.1 `public/admin/index.html` 的导航入口

| # | `href` | `data-nav` | 出现位置 | 对应视图文件 |
|---|---|---|---|---|
| 1 | `#/properties` | `properties` | 侧栏 `index.html:60` + 底部标签栏 `index.html:79` | `views/properties.js` ✅ |
| 2 | `#/pages` | `pages` | 侧栏 `index.html:61` + 标签栏 `index.html:80` | `views/pages.js` ✅ |
| 3 | `#/reminders` | `reminders` | 侧栏 `index.html:62` + 标签栏 `index.html:81` | `views/reminders.js` ✅ |
| 4 | `#/settings` | `settings` | 侧栏 `index.html:63` + 标签栏 `index.html:82` | `views/settings.js` ✅ |
| 5 | `#/backup` | `backup` | 侧栏 `index.html:64` + 标签栏 `index.html:83` | `views/backup.js` ✅ |

**入口数 = 5**（桌面侧栏 5 个 + 手机底部标签栏 5 个，同一组）。另有 2 个非导航按钮：`#logout`（`index.html:51`）、`#logout-side`（`index.html:67`），都绑到同一个 `handleLogout`（`app.js:153-155`）。

### 5.2 `views/` 目录 vs 路由表

`views/` 下有 **6 个** `.js`：`properties.js`、`property-edit.js`、`pages.js`、`reminders.js`、`settings.js`、`backup.js`。

`app.js:20-28` 的路由表 **7 条**：

| 路由正则 | 视图 | nav 高亮 | 说明 |
|---|---|---|---|
| `^#\/properties$` | `properties` | `properties` | |
| `^#\/properties\/new$` | `propertyEdit`（params `{id:'new'}`） | `properties` | 新增房源 |
| `^#\/properties\/([^/]+)$` | `propertyEdit` | `properties` | 编辑房源 |
| `^#\/pages$` | `pages` | `pages` | |
| `^#\/reminders$` | `reminders` | `reminders` | |
| `^#\/settings$` | `settings` | `settings` | |
| `^#\/backup$` | `backup` | `backup` | |

**对得上**：6 个视图文件全部被 `app.js:10-15` import 并在路由表中使用；`app.js:105` 对未匹配的 hash 兜底跳回 `#/properties`。**没有孤立视图，也没有指向不存在视图的导航项。**

### 5.3 `views/` 里被 import 但未在界面上暴露的模块

`app.js:6-15` 只 import 了这 6 个 + `api.js` / `help.js` / `ui.js` / `icons.js`。
`public/admin/` 下的 **`combobox.js`（可搜索下拉）被 `property-edit.js:7` 使用**，`data/countries.json`、`data/divisions-cn.json` 由 `property-edit.js:65-66` 懒加载。
→ **`public/admin/` 里没有任何完全未被使用的静态资源。**

### 5.4 后台缺失的页面（后端有对应能力，界面没有入口）

| 缺失页面/区域 | 后端能力 | 证据 |
|---|---|---|
| **系统自检 / 诊断页** | `GET /api/admin/diagnostics`（`health.ts:28`） | 前端 0 处引用（`grep '/api/admin/diagnostics' public/` → 0 命中） |
| **单房源操作日志 / 修改历史** | `GET /api/admin/properties/:id/audit`（`admin-properties.ts:166`） | 前端 0 处引用 |
| **首页概览面板** | `GET /api/admin/overview`（`admin-properties.ts:41`）返回 `recentAudit` 等 7 组数据 | 只用了 `workspace.name`（`app.js:160-164`） |
| **统计/报表页** | `statusCounts`、`countListingByStatus`、`countRemindersByStatus` | 只在房源列表页做了状态计数卡（`properties.js:54-65`） |
| **插件管理页** | `GET /api/platform/plugins/:id/admin`（`platform.ts:517`） | `/admin/` 里没有任何 `/api/platform/` 调用（见 §6.3） |
| **用户/套餐管理页** | `DEFAULT_TIER_LIMITS`（`src/platform/config.ts:60-102`）注释称「由管理员在后台手工授予」（`config.ts:58`） | **全前端 0 处引用 `adminEnabled` 或套餐修改端点**（`grep adminEnabled public/` → 0 命中）。**「后台手工授予」目前只能直接改数据库** |

---

## 6. 空壳功能清单

**先说结论：`/api/admin/*` 里没有发现「返回硬编码」「永远返回空」的假实现。** 我逐个读了 §1 全部端点指向的 service 层函数，`listBackups`（`backup-service.ts:195-224`）、`listPagesAdmin`（`publish-service.ts:289-303`）、`listPropertiesWithMeta`（`property-repo.ts:286-370`）、`listRemindersAdmin` 都在做真实查询。

真正的问题不是「后端造假」，而是 **「后端真做完了，前端没有入口」** 以及 **「注释说没做，代码其实做了」** 这两类。

### 6.1 后端真做完、前端无入口（确定）

| 功能 | 后端 | 前端 | 证据 |
|---|---|---|---|
| **照片 / 视频排序** | `POST /api/admin/properties/:id/media/reorder` → `reorderMediaItems`（`media-service.ts:202-221`），落库 `applyOrder` | **无任何控件** | 全前端搜 `draggable`/`dragstart`/`上移`/`下移`/`排序`/`调整顺序` → **仅 1 处命中，是媒体页的一句承诺文案**（`property-edit.js:655`「…**可调整顺序**或指定封面。」）。**文案承诺了不存在的按钮** |
| **改提醒计划时间** | `PATCH /api/admin/reminders/:id` → `rescheduleReminder`（`admin-reminders.ts:78-82`） | **无任何控件** | `reminders.js:88` 的表头 7 列里没有可编辑的时间；`data-rem-action` 只有 `complete`/`skip`/`reopen` 三个值（`reminders.js:106-108`） |
| **房源级操作日志** | `GET /api/admin/properties/:id/audit`（`admin-properties.ts:166-169`） | **无任何区域** | 前端 0 处引用；`property-edit.js` 五个页签（`TABS`，`property-edit.js:25-31`）里没有「历史」 |
| **系统诊断** | `GET /api/admin/diagnostics`（`health.ts:28-49`） | **无入口** | 前端 0 处引用 |
| **列表排序** | `sort=created_desc\|title_asc`（`admin-properties.ts:72-73`、`property-repo.ts:320-325`） | **无控件** | `properties.js:137-141` 不传 `sort` |
| **列表分页** | `limit`/`offset`，1–200（`admin-properties.ts:69-70`、`property-repo.ts:327-328`） | **无控件** | `properties.js:137-141` 不传 `limit`/`offset`；`total` 拿到但无分页器（`properties.js:144`） |

### 6.2 注释说「未实现」，代码其实实现了（陈旧注释 — 重要！）

`src/http/routes/platform.ts:504`：

> 「但插件**生命周期**（安装 / 启用 / 禁用 / 升级 / 卸载）在本平台尚未实现，且按本次任务要求不予开发」

**但 `src/platform/plugins/lifecycle.ts` 里这些函数全部存在且已实现：**

| 函数 | 位置 |
|---|---|
| `reconcileBuiltins` | `lifecycle.ts:67` |
| `isPluginEnabled` | `lifecycle.ts:128` |
| `listInstallations` | `lifecycle.ts:138` |
| `getInstallation` | `lifecycle.ts:147` |
| `installPlugin` | `lifecycle.ts:159` |
| `setPluginEnabled` | `lifecycle.ts:192` |
| `updatePlugin` | `lifecycle.ts:212` |
| `uninstallPlugin` | `lifecycle.ts:230` |
| `pluginAvailability` | `lifecycle.ts:245` |

**并且这些能力已经全部接入路由**（`platform.ts:433` 段落标题就是「插件生命周期（受 adminEnabled 保护）」）：

| 端点 | 定义位置 | 前端调用 |
|---|---|---|
| `GET /api/platform/plugins/installations` | `platform.ts:439` | ❌ **0 处** |
| `POST /api/platform/plugins/:id/install` | `platform.ts:448` | ❌ **0 处** |
| `` POST /api/platform/plugins/:id/${action} ``（启用/禁用，动态路径） | `platform.ts:461` | ❌ **0 处** |
| `POST /api/platform/plugins/:id/update` | `platform.ts:476` | ❌ **0 处** |
| `DELETE /api/platform/plugins/:id/installation` | `platform.ts:488` | ❌ **0 处** |
| `GET /api/platform/plugins/:id/admin` | `platform.ts:517` | ❌ **0 处** |
| `GET /api/platform/safety-stats` | `platform.ts:411` | ❌ **0 处** |
| `GET /api/platform/examples/:id/preview` | `platform.ts:597` | ❌ **0 处** |

→ **这正是用户描述的「插件启停 API 做完但无入口」**，且**注释还在说它没做**。这是一处会误导后续维护者的陈旧注释。

### 6.3 版本回滚：后端有、界面上是只读列表

- 端点：`POST /api/platform/projects/:id/versions/:versionId/restore`（`platform.ts:1053-1080`），支持 `mode: 'draft' | 'publish'`
- 前端**确实有一块「版本历史」区域**：`public/app/app.js:928-944`
- **但它是只读列表**：`app.js:934-942` 只 `el('li', null, ...)` 输出 `vN · 发布版本/草稿 · AI 改动/手动保存 · 日期`
- **列表里没有任何按钮**，`app.js:928-944` 整段没有 `addEventListener`
- `grep 'versions/' public/` → **0 命中**；`grep 'versionId' public/` → **0 命中**

→ **版本回滚 API 做完，界面只有「看」，没有「回滚」。**

> 注：`public/app/app.js:354` 调用的 `/api/platform/projects/:id/restore`（`platform.ts:714`）是**回收站恢复项目**（配合 `state.showTrash`，`app.js:974`），与版本回滚是两回事，不要混淆。

### 6.4 其它「看起来完整、实际有洞」的地方

| 位置 | 问题 | 证据 |
|---|---|---|
| `property-edit.js:718` | 事件委托只绑**第一个** `.media-grid` | 照片为 0 时照片区是 `<p>`（`property-edit.js:659`）→ 视频的按钮全哑 |
| `property-edit.js:1142` + `188` | `/api/admin/meta` **同一入口请求两次** | `loadAll()` 里 `188` 又取一遍；`render()` 里 `1142` 已取过 |
| `property-edit.js:582` | 保存时静默改写 `depositCurrency` | 见 §2.3 |
| `settings.js:52` | 存储行的「配置来源」渲染成一个**恒空表达式** | `` 上传目录 ${esc(cfg.databaseFile ? '' : '')} `` → **两个分支都是空串**，永远显示「上传目录 」 |
| `admin-pages.ts:49` / `97`、`admin-settings.ts:187-191`、`admin-export.ts:54` | **GET 请求产生写副作用**（`ensureListingPage` 会 insert `listing_pages` 行） | `publish-service.ts:57-85`。仅「打开编辑页」就会建页；`listing_pages` 现有 3 行 vs `properties` 4 行，说明确实存在「有房源无展示页」的中间态 |
| `admin-properties.ts:78` | `status` 查询参数**无运行期校验**，非法值直接进 SQL 当字符串比 | `(query.status as PropertyStatus \| 'all') ?? 'all'` —— 只是 TS 断言，不是校验；传 `status=xx` 会静默返回空列表 |
| `admin-properties.ts:73` | `sort` 是**白名单式静默降级**（非法值 → `updated_desc`） | 行为本身合理，但前端不传任何值，所以这个白名单永远只走默认分支 |
| `reminders.js:175` | `container.querySelector('tbody')` 未用可选链 | 与本文件其它查询风格不一致 |

---

## 7. 按严重程度排序的缺口清单

### 🔴 P0 — 用户会直接踩到

| # | 缺口 | 用户实际遭遇 | 证据 |
|---|---|---|---|
| 1 | **`postal_code` 无输入控件** | 展示页上邮编照常显示（说明数据在流转），但后台**看不到、改不了**。填错一次就永久错下去，只能改库 | 缺失：`property-edit.js` 表单（对照 `:398-455` 无此字段）；会被渲染：`page-renderer.ts:80`；会被校验：`domain/property.ts:148`；库里有值：实测 4 行中 3 行非空 |
| 2 | **房源列表硬截断 50 条，无分页、无提示** | 第 51 套房源起**在列表里彻底消失**，搜索也搜不到（搜索走的是同一个 50 条上限的查询）。用户会以为「数据丢了」 | `admin-properties.ts:69`（默认 `limit=50`）、`property-repo.ts:327`（夹取上限 200）；`properties.js:137-141` 不传 `limit`；`properties.js:144` 拿到 `total` 却没用 |
| 3 | **照片/视频无法排序，但界面承诺可以** | 「第一张自动成为封面；**可调整顺序**或指定封面。」（`property-edit.js:655`）——用户按这句话去找调序按钮，**找不到**。想改封面只能「设为封面」逐个试，想调展示顺序完全无解 | 文案 `property-edit.js:655`；后端 `admin-media.ts:74`；全前端 0 个 drag/排序控件 |
| 4 | **89 条界面中文在非中文界面下恒为中文** | 法语/德语/意大利语/英语用户看到的是一半译文一半中文的混合界面；`index.html` 的**登录页整页**（"登录"、"管理口令"…）都在这一批里 | 脚本实测 89 条；代表：`index.html:28`、`index.html:32`、`property-edit.js:807`「撤下页面」、`reminders.js:106-108` 三个按钮、`settings.js:172-185` 整张外部服务表 |
| 5 | **改提醒时间无入口** | 提醒页只有「标记完成 / 关闭提醒 / 重新启用」，**不能改计划时间**。用户想「推迟 3 天再提醒我」做不到，只能关掉重建 | 后端 `admin-reminders.ts:78`；前端 `reminders.js:88` 表头无时间编辑、`:106-108` 只有三个动作 |
| 6 | **`deposit_currency` 被静默改写** | 登记「价格 USD、押金 CNY」，一保存押金币种就被改成 USD。**没有任何报错或提示** | `property-edit.js:582`（`values.depositCurrency = values.priceCurrency`） |
| 7 | **改状态只能在编辑页** | 列表页只能「归档 / 恢复」。想把 `draft` 改成 `active` 必须进详情页 → 基本信息 → 改「房源状态」→ 保存（走 PATCH，不是 status 端点）。列表页的 `status` 端点只覆盖 2/5 个状态 | `admin-properties.ts:134-142`；前端只用 `'archived'`（`properties.js:240`）和 `'restore'`（`properties.js:243`） |

### 🟠 P1 — 明显缺失，但用户不一定马上撞上

| # | 缺口 | 说明 | 证据 |
|---|---|---|---|
| 8 | **版本回滚只有列表没有按钮** | 用户能看到 `v1 / v2 / v3`，但**没有任何办法回滚**。这是「API 做完、界面无入口」的教科书案例 | 列表 `public/app/app.js:928-944`；端点 `platform.ts:1053`；`grep versionId public/` → 0 |
| 9 | **插件启停 / 安装 / 升级 / 卸载全部无入口** | `lifecycle.ts` 9 个函数 + 6 个受保护端点全部就绪，前端 0 调用 | `lifecycle.ts:67-245`；`platform.ts:439-497`；§6.2 |
| 10 | **插件生命周期注释与代码矛盾** | `platform.ts:504` 说「尚未实现」，实际早已实现。会误导维护者重复开发或误判风险 | `platform.ts:504` vs `lifecycle.ts:159/192/212/230` |
| 11 | **列表无排序控件** | 只有「最后更新倒序」。想按创建时间或标题看，做不到 | `admin-properties.ts:72-73`；`properties.js:137-141` |
| 12 | **后台无「从备份恢复」** | 只有「校验」和「恢复演练」（解包到独立目录）。用户可能误以为点「恢复演练」就把数据恢复了 | `admin-backup.ts:28/38`；`backup.js:54-55` 两个按钮文案分别是「校验」「恢复演练」 |
| 13 | **无首页概览面板** | `/api/admin/overview` 返回的发布数、提醒数、模板、适配器、最近审计、时间旅行状态**全部丢弃**，只留工作区名 | `admin-properties.ts:41-64`；`app.js:159-164` |
| 14 | **房源无操作日志视图** | 出了争执无法回答「谁在什么时候把这套房的租金改了」 | `admin-properties.ts:166`；前端 0 引用 |
| 15 | **无系统诊断入口** | `/api/admin/diagnostics` 已就绪（脱敏），界面上没有 | `health.ts:28` |
| 16 | **无用户/套餐管理界面** | 代码注释称套餐「由管理员在后台手工授予」（`platform/config.ts:58`），但**后台不存在这个界面**，`adminEnabled` 在前端 0 引用 | `platform/config.ts:60-102`；`grep adminEnabled public/` → 0 |
| 17 | **「有照片才能操作视频」的哑按钮** | 房源没有照片时，视频卡片上的「来源 / 删除」点了没反应（事件委托只绑到照片网格） | `property-edit.js:718` + `:659` |
| 18 | **语言切换入口只在房源编辑页内** | 6 个界面里只有 1 个能换语言；德语用户首次登录看到的是英文界面，且找不到开关 | `property-edit.js:390-394`；`app.js:50-61` 兜底是 `en` |
| 19 | **GET 请求产生写副作用** | 打开编辑页 / 预览 / 导出 都会隐式创建 `listing_pages` 行 | `publish-service.ts:57-85` 被 `admin-pages.ts:49/97`、`admin-settings.ts:187` 的 GET 调用 |
| 20 | **媒体来源说明用 `window.prompt`** | 非页面内表单，移动端体验差，无法做长度/内容校验 | `property-edit.js:762` |

### 🟡 P2 — 次要 / 打磨类

| # | 缺口 | 证据 |
|---|---|---|
| 21 | `settings.js:52` 存储配置来源是恒空表达式 | `` `上传目录 ${esc(cfg.databaseFile ? '' : '')}` `` |
| 22 | `/api/admin/meta` 同一入口请求两次 | `property-edit.js:188` 与 `:1142` |
| 23 | `status` 查询参数无运行期校验，非法值静默返回空 | `admin-properties.ts:78` |
| 24 | 列表搜索不覆盖 `description` / `postal_code` / 译文 | `property-repo.ts:302-308` |
| 25 | 无「可租状态」筛选（后端也不支持） | `admin-properties.ts:30-37` 的 `ListQuery` 无此字段 |
| 26 | `availabilityNote` 返回但从不使用 | `admin-properties.ts:184-185` |
| 27 | 删除确认对话框后半句恒中文（key 里字面 `\n` vs 词典真换行） | `properties.js:249` 与 `i18n.js:239`、`i18n-de.js` 对应 key |
| 28 | 创建时间 `created_at` 界面上任何地方都不显示 | — |
| 29 | **11 个端点前端 0 调用**（6 个死端点 + 5 个无入口）：`properties/:id/readiness`、`properties/:id/media`(GET)、`templates`、`locales`、`external-services`(GET)、`dev/clock`、`properties/:id/audit`、`properties/:id/media/reorder`、`reminders/:id`(PATCH)、`diagnostics`、`properties/validate` | §1.9 |
| 30 | `reminders.js:175` 未用可选链（与文件其它处风格不一致） | `reminders.js:175` |
| 31 | `PAIRS` 里有 5 组重复键（`已归档`×2、`恢复`×2、`照片与视频`×3、`发布前需要先完善：`×2、`时区，例如…`×2） | §4.2 |

---

## 8. 我**没能验证**的部分（不假装查过）

以下事项我**没有**验证，报告中的任何结论都**不依赖**它们：

1. **没有对运行中的服务发起任何 HTTP 请求**。所有端点行为都是**读代码**得出的，不是实测响应。因此：
   - 端点是否真的按代码返回预期 JSON —— **未验证**
   - 认证中间件是否真的拦住了未登录访问 —— **未验证**
   - 前后端字段名/结构是否真的对得上（例如 `detail.listingPage` vs 前端读的 `detail.listingPage`）—— **只做了源码级比对，未做运行期比对**
2. **没有启动任何服务或跑任何测试**，也未读取 `tests/` 目录内容来交叉印证。本报告**完全没有引用测试结果**。
3. **没有在浏览器里打开 `/admin/`**。所以：
   - 「点按钮真的触发请求」——**未验证**
   - 「返回后真的渲染出结果」——**未验证**
   - 「列表页 50 条上限」的实际视觉表现 —— **未验证**（严格说：从代码看是硬上限，但我没造 51 条数据去撞它）
4. **没有模拟任何一种界面语言进行视觉核对**。§4 的 89 条是从代码静态抽取 + 真实加载 `i18n.js` 的 `hasKey()` 判定的；「这些文本在页面上确实以文本节点形式出现」这一步**未在浏览器中确认**（但我逐条核对了它们所在的行确实是会被渲染进 DOM 的模板字符串或静态 HTML）。
5. **没有对数据库做任何写入**，因此：
   - 「PATCH 是否真的把 `postal_code` 之外的所有字段都提交了」——**未验证**（只从 `readForm()` 的实现 `ui.js:230-238` 推断：它收集所有 `[data-field]`，而 `postalCode` 没有 `data-field`）
   - 「保存后 `deposit_currency` 是否真的被改写」——**未验证**（`property-edit.js:582` 的赋值是明确的，但我没实际保存过）
6. **`/api/platform/*` 的完整审计只做了「是否有前端调用」这一层**（§6.2、§6.3），因为它们不属于本次任务指定的 `/admin/` 审计对象。平台侧的业务正确性、权限判定细节**未审计**。
7. **`public/app/` 的界面**（平台用户端）只做了「它调用了哪些平台端点」的交叉引用，**没有做界面完整性审计**。
8. **迁移历史中的 `postal_code` 与「26 列」说法的差异**（§2.1）：我以 `PRAGMA table_info` 的实测 **29 列**为准，但没有追溯到「26 列」这个说法的出处（可能在 `docs/` 某份更早的方案文档里）。**未验证**。
9. **性能、并发、索引效率**未审计。`listPropertiesWithMeta` 的子查询封面逻辑（`property-repo.ts:336-342`）在大数据量下的表现 —— **未验证**。
10. **工作树有未提交修改**（`git status` 显示 `public/admin/app.js`、`public/admin/index.html`、`public/admin/styles.css`、`package.json`、`scripts/smoke.ts` 处于 `M`）。**本报告读的是工作树当前内容，不是 HEAD 提交内容**；如果这些修改会被回退，§1 中依赖 `app.js` / `index.html` 行号的结论需要重算。

---

## 9. 复查用命令（只读）

```powershell
# properties 表真实列数与列名
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('var/db/app.sqlite',{readOnly:true});console.log(d.prepare('PRAGMA table_info(properties)').all().map(c=>c.name).join('\n'))"

# 迁移版本（不用主库文件 SHA256 判断状态）
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('var/db/app.sqlite',{readOnly:true});console.log(d.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all())"

# postalCode 在前端是否存在（预期：仅 1 处，且是默认值字面量）
Select-String -Path 'public\admin\views\*.js' -Pattern 'postalCode|postal_code|邮政编码|邮编'

# 照片排序相关控件（预期：0 处）
Select-String -Path 'public\admin\views\*.js' -Pattern 'draggable|dragstart|上移|下移|media/reorder'

# 版本回滚是否有前端调用（预期：0 处）
Select-String -Path 'public\**\*.js' -Pattern 'versionId|versions/'

# 插件生命周期是否有前端调用（预期：0 处）
Select-String -Path 'public\**\*.js' -Pattern 'plugins/.*/install|plugins/.*/update|installation|plugins/.*/admin'

# 列表是否传 sort / limit / offset（预期：都没有）
Select-String -Path 'public\admin\views\properties.js' -Pattern "params.set"

# 死端点抽查
Select-String -Path 'public\admin\**\*.js' -Pattern '/api/admin/diagnostics|properties/validate|/api/admin/locales|/api/admin/templates|dev/clock|properties/.*/audit'
```

---

## 10. 最重要的三个发现（一段话）

**第一，`postal_code`（邮政编码）在后台界面上完全没有输入控件**——`property-edit.js` 的表单从 `:398` 到 `:455` 逐个字段核对下来没有它，全前端搜索只有一处命中且只是默认值字面量（`:377`）——但这个字段既会被公开展示页渲染（`page-renderer.ts:80`），也被 API 正常校验（`domain/property.ts:148`），实测库里 4 套房源有 3 套邮编非空，也就是说**用户能看见它出现在展示页上，却永远无法在后台查看或修改它**。**第二，房源列表被硬截断在 50 条且没有任何提示**：后端早就实现了 `sort` 白名单（`admin-properties.ts:72-73`）和 1–200 的 `limit/offset`（`property-repo.ts:327-328`），但 `properties.js:137-141` 一个都不传，只传 `search`/`status`/`includeArchived`，于是第 51 套房源在列表和搜索结果里彻底消失、界面连「仅显示前 50 条」都不说，而这个缺口在当前只有 4 套房源的库上**永远测不出来**——这正是「测试通过 ≠ 功能可用」。**第三，多语言做了一半且缺口位置很扎眼**：zh/en/fr/it/de 五份词典的 280 个 key **完全一一对齐、一个不缺**，但界面上有 **89 条中文纯文本根本没进词典**（脚本实测），`ui.js:119-145` 的自动扫描以「key 在词典里」为唯一准入条件，因此这些串在**包括英文在内的全部非中文界面下都原样显示中文**——最刺眼的是 `index.html` 的登录页整页（"登录"、"管理口令"）和提醒页的三个操作按钮（"标记完成"/"关闭提醒"/"重新启用"）全在中招名单里；此外 `PAIRS` 有 286 条却只有 280 个唯一 key（5 组重复），版本回滚（`platform.ts:1053`）、插件启停（`lifecycle.ts` 9 个函数 + `platform.ts` 6 个受保护端点）这些「API 做完、界面无入口」的老问题依然原样存在，甚至 `platform.ts:504` 的注释还在声称插件生命周期「尚未实现」。
