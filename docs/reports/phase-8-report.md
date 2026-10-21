# 修订记录（2026-10-12 二次修订）

> 本报告初稿写于本轮开发过程中。此后又完成了若干修复与补充验证，**以下修订单独列出，并取代正文中相应结论**；正文其余内容仍然有效。

## 修订内容

1. **测试从「未完成」变为完成**：**251 项单元 + 集成测试全部通过**（初稿写就时实为 216 项，其后补齐 `tests/integration/security.test.ts` 与 `tests/adapters/map.test.ts` 增至 251 项；以最终实测值为准）。其中 `tests/integration/security.test.ts` 覆盖 CSP（脚本不用 `unsafe-inline`、公开页样式放宽的边界、后台不放宽）、安全响应头、后台不缓存、登录限流、伪造 Cookie、退出登录、诊断接口不泄露密钥、媒体路径穿越、`nosniff`、错误响应不含堆栈、超长请求体被拒。
2. **备份与媒体改为经存储适配器读写（修复了同类隐患）。**
   - 初稿登记的「备份未加密且只在本机」之外，又发现一个**更严重的隐患**：备份原先直接扫描 `UPLOAD_DIR`，`/media/*` 原先直接由 `@fastify/static` 从磁盘提供 —— 两者都**绕过了存储适配器**。一旦把 `STORAGE_PROVIDER` 换成对象存储，**备份会静默丢失全部素材、展示页图片会全部 404**。
   - 现已改为：`/media/*` 由适配器读取并输出（含路径穿越校验与显式 404）；备份按数据库中登记的存储键经适配器逐个读取，读取失败的素材会在 manifest 中明确记录，不再静默丢失。
3. **列表接口 N+1 已消除**：`GET /api/admin/properties` 由「每行再取一次聚合」改为单条 SQL（含 `LEFT JOIN listing_pages` 与照片数子查询）。
4. **依赖清理与许可证校正**：移除了声明但零引用的 `zod`；`typescript` 实际为 **Apache-2.0**（非 MIT），`qrcode-generator` 包内无 LICENSE 文件（仅 package.json 声明 MIT）—— 均已在 `docs/licenses.md` 中登记。
5. **仓库已初始化 Git**（137 个文件，一个提交），回滚不再依赖人工留副本。

**仍然存在的限制：** 备份未加密、只存本机；未做依赖漏洞审计；未做性能压测；应用不做 TLS 终结；`typescript` 与 `qrcode-generator` 的许可证证据强度偏弱。

---

# 第 8 阶段验收报告：安全、性能与上线准备

- 项目根目录：`E:\轻量化房源管理`
- 对应方案：第五章第 8 阶段（工作与验收项）、第六章第 6、8 条、第八章全部风险控制项
- 运行方式：`pnpm install` → `pnpm migrate` → `pnpm start`；健康检查 `GET /healthz`；自检 `GET /api/admin/diagnostics`
- 证据复跑（2026-10-12 18:2x）：
  - `node --disable-warning=ExperimentalWarning scripts/smoke.ts` → 「共 73 项检查，通过 73 项，失败 0 项」，退出码 0；
  - `node node_modules/typescript/bin/tsc --noEmit` → 退出码 0；
  - 已归档的浏览器截图（截至本次核验 2026-10-12，共 15 个文件）：`01-admin-login.png`、`02-admin-properties.png`、`03-property-edit-basic.png`、`04-public-page-desktop.png`、`05-public-page-en.png`、`05-public-page-en-before-i18n.png`、`06-public-page-en-i18n.png`、`07-admin-reminders.png`、`08-reminder-dispatched.png`、`09-backup-restore-drill.png`、`10-admin-settings.png`、`11-validation-errors.png`、`12-public-page-mobile.png`、`13-publish-tab.png`、`14-export-offline-standalone.png`
- 许可证归档：`docs/licenses.md`（快照 2026-10-12）、`docs/phase0-decision-record.md`

## 阶段名称与目标

第 8 阶段：安全、性能与上线准备。目标为检查权限隔离、上传文件校验、备份恢复、日志、错误提示、移动端体验、基础性能、许可证归档和部署/回滚步骤。验收要求：关键用户路径通过真实浏览器测试；备份能够恢复；无硬编码密钥；上线与回滚流程清楚。

## 实际修改的文件/模块

- 安全层 `src/http/security.ts`：HMAC-SHA256 会话令牌（含 `iat` / `exp` / `role`）、恒定时间比较（长度对齐后再比较）、per-request CSP nonce、统一安全响应头、登录限流器（5 次 / 15 分钟窗口 / 封禁 15 分钟 + 定期清理）。
- `src/http/app.ts`：全局 `onRequest` 鉴权（`/api/admin/*` 除登录与会话探测外一律校验）、`onSend` 统一注入安全头、`/api/*` 一律 `Cache-Control: no-store`、统一错误处理（`DomainError` → 结构化中文；multipart 超限 → 413；未知错误 → 500 通用提示且堆栈只进日志）、统一 404（接口返回 JSON、页面返回 HTML）、`bodyLimit: 2 MB`、`trustProxy: true`。
- `src/util/logger.ts`：结构化日志、敏感键名自动脱敏（`password|secret|token|api_key|access_key|credential|authorization|cookie|session`）、`child()` 绑定字段、可替换 sink。
- `src/config.ts`：启动期配置校验（生产环境拒绝默认口令、口令长度 < 12、`SESSION_SECRET` 为示例值或长度 < 32、`PUBLIC_BASE_URL` 非 https、非法 IANA 时区、提醒天数关系错误、端口越界）与 `redactedConfig()` 脱敏快照。
- 上传校验 `src/domain/media.ts` + `src/services/media-service.ts`：文件头魔数识别真实类型 → 扩展名交叉核对 → 大小/数量上限 → 内部生成存储键（不使用用户文件名）→ 落盘 → 入库 → 审计。
- 备份恢复 `src/services/backup-service.ts` + `src/http/routes/admin-backup.ts`，界面 `public/admin/views/backup.js`。
- 审计与外部服务配置 `src/services/audit-service.ts`、`src/http/routes/admin-settings.ts`（拒绝保存疑似密钥字段）、界面 `public/admin/views/settings.js`。
- 自检 `src/http/routes/health.ts`（`/healthz` 与 `/api/admin/diagnostics`，含存储可写探针）。
- 证据与文档：`scripts/smoke.ts`（73 项端到端检查）、`docs/licenses.md`、`docs/phase0-decision-record.md`、`docs/evidence/*.png`。
- 工程约束：`.gitignore`（排除 `node_modules/`、`var/*`、`.env`、日志、临时文件）、`.npmrc`（exFAT 卷强制 `node-linker=hoisted`）、`package.json` 脚本（`start` / `dev` / `migrate` / `seed` / `reminders` / `smoke` / `test` / `typecheck`）。

## 数据库变更与迁移结果

- 本阶段无新增迁移（安全与运维能力不改变业务表结构）。
- 备份覆盖 10 张表（`src/services/backup-service.ts` 的 `BACKUP_TABLES`）：`workspaces`、`users`、`properties`、`property_translations`、`contacts`、`media`、`listing_pages`、`reminders`、`external_service_configs`、`audit_logs`。
- 备份机制：`VACUUM INTO` 生成一致性快照（运行中可安全备份）→ 与全部上传素材一起打包为 ZIP → 附 `manifest.json`（创建时间、`db/app.sqlite` 路径、每张表行数、媒体文件数、说明）。
- 恢复演练机制：解包到独立目录（默认 `${DATA_DIR}/restore-drill`，可传 `targetDir`）→ 用 `tableCounts()` 逐表统计 → 与 manifest 比对，**不覆盖正在运行的数据**；归档内 `..` 路径与写出目录越界都会被拒绝（`unprocessable`）。
- 保留策略：`BACKUP_RETENTION_DAYS`（默认 30 天），`POST /api/admin/backups/prune` 手工触发清理并写审计。
- 审计：备份创建 / 校验 / 恢复演练 / 清理都有审计记录（`backup.create`、`backup.restore_drill`、`backup.prune` 等）；实测备份时 `audit_logs` 为 16 行并随快照一起备份。

## API/服务端验证

| 方法 | 路径 | 验证结果 |
| --- | --- | --- |
| GET | `/healthz` | 200；返回状态、当前时间、已应用迁移、各适配器名称 |
| GET | `/api/admin/diagnostics` | 需登录；返回环境、迁移列表、房源统计、适配器名、`storageWritable`（写-读-删探针文件）、`timeTravelEnabled` 与**脱敏后**配置 |
| GET/POST | `/api/admin/backups` | 列表（含 `backupDir` 与保留天数）/ 创建备份（201，返回文件路径、字节数与 manifest） |
| POST | `/api/admin/backups/verify` | 解码归档 → 打开快照库 → 逐表与 manifest 比对；实测 `{ ok: true }` |
| POST | `/api/admin/backups/restore-drill` | 解包到独立目录并返回 `restoredTables`、`restoredMediaFiles`、`manifest` |
| POST | `/api/admin/backups/prune` | 按保留天数删除过期备份 |
| GET/PUT | `/api/admin/external-services` | 配置只存非敏感值；键名疑似密钥时拒绝保存（400） |
| GET | `/api/admin/audit` | 返回最近审计记录（默认 100 条） |
| PATCH | `/api/admin/settings` | 工作区名称、默认语言、币种、面积单位、时区（全部带格式校验） |

实测（冒烟测试第【8】组，全部通过）：

1. 创建备份成功（201）；实测字节数 168891，manifest 行数 `workspaces 1 / users 1 / properties 1 / property_translations 1 / contacts 0 / media 1 / listing_pages 1 / reminders 2 / external_service_configs 0 / audit_logs 16`，`mediaFiles = 1`；
2. 备份校验通过（`ok = true`，逐表与 manifest 一致）；
3. 恢复演练成功（解包到临时目录的 `restore-drill`，返回数据文件与上传目录路径）；
4. **恢复后行数一致**：`properties = 1`；
5. **恢复后媒体文件存在**：`restoredMediaFiles = 1`；
6. **恢复后提醒行数一致**：`reminders = 2`。

其他安全相关实测（分布在其他分组）：

- 未登录访问 `/api/admin/overview` 返回 401；错误口令 401；正确口令下发 `admin_session` Cookie；
- 伪装成 PNG 的文本文件被拒绝（400）；首张照片自动成为封面；
- 公开页 CSP 使用 `nonce-` 而非 `unsafe-inline`；
- 未知房源 ID 返回 404；错误输入返回字段级中文提示；
- 删除房源后提醒级联清零（数据一致性）。

## 真实浏览器操作路径

已归档截图对应的路径（`docs/evidence/`）：

1. `01-admin-login.png`：登录页（口令输入 + 「口令由环境变量 ADMIN_PASSWORD 配置」提示）。
2. `02-admin-properties.png`：房源列表（搜索、状态筛选、显示归档开关、状态统计）。
3. `03-property-edit-basic.png`：房源编辑「基本信息」标签（标题/房型/状态、地址与位置、面积与细节、价格与费用、附加费用）。
4. `04-public-page-desktop.png`：桌面视口公开展示页（标题、价格、关键信息、语言栏、房源介绍、视频、价格与费用、位置、周边信息、联系方式、分享二维码、页脚免责声明）。
5. `06-public-page-en-i18n.png`：同一页面的英文版（界面标签与格式均切换为英文）。
6. `07-admin-reminders.png`：发布提醒页（规则卡片、时间旅行面板、2 条提醒、立即投递、规则说明）。
7. `08-reminder-dispatched.png`：执行「立即投递」之后的发布提醒页。
8. `09-backup-restore-drill.png`：备份与恢复页执行「恢复演练」后的结果 —— 备份文件 `backup-2026-10-20T02-00-00-000Z.zip`（1012.0 KB，文件创建时间 2026/10/12 18:24:20；文件名时间戳来自被推进的业务时钟）、恢复目录 `E:\轻量化房源管理\var\restore-drill`、数据文件 `...\var\restore-drill\db\app.sqlite`、素材文件 7 个、表行数 `{workspaces:1, users:1, properties:3, property_translations:2, contacts:5, media:10, listing_pages:3, reminders:2, external_service_configs:0, audit_logs:24}`。
9. `10-admin-settings.png`：设置页（工作区默认语言/币种/面积单位/时区与外部服务适配器配置）。
10. `11-validation-errors.png`：新建房源表单提交空标题后的字段级中文报错（标题框下方「标题不能为空」+ 底部聚合错误框「输入内容有误，请检查后重试」）。
11. `12-public-page-mobile.png`：手机视口下的公开展示页。
12. `13-publish-tab.png`：房源详情「发布页面」标签。
13. `14-export-offline-standalone.png`：导出形态的静态页面（底部导出说明 + 位置区块的离线降级文案）。

涉及备份与恢复的界面路径：后台「备份与恢复」→「立即备份」→ 列表出现备份文件 → 点「校验」显示逐表行数 → 点「恢复演练」显示恢复目录、数据文件、素材文件数与表行数 →「清理过期备份」。

> 说明：截图已覆盖登录、房源列表、房源编辑与校验报错、「发布页面」标签、展示页（桌面/手机、中/英）、发布提醒与投递、备份恢复演练、设置页与导出形态页面；导出产物「用 `file://` 打开解压目录」这一步仍缺少带地址栏的截图（已在第 3 阶段报告登记为未完全闭环）。

## 通过项与证据

1. **权限隔离**：后台接口在 `onRequest` 统一鉴权（仅 `/api/admin/login` 与 `/api/admin/session` 例外），实测未登录 401；会话令牌 HMAC 签名 + 恒定时间比较 + 12 小时有效期；房源、媒体、提醒的读写都经 `requireProperty` / `requireMedia` / `requireReminder` 校验工作区归属，防止跨工作区越权（多工作区场景的预留）。
2. **上传文件校验**：不信任客户端 MIME，按文件头魔数判定真实类型（JPEG / PNG / GIF / WebP / MP4 / MOV / WebM），扩展名交叉核对，类型白名单之外一律拒绝；大小上限 `MAX_UPLOAD_BYTES`（默认 15 MB）与 `MAX_VIDEO_BYTES`（默认 200 MB），照片数量上限 `MAX_PHOTOS_PER_PROPERTY`（默认 30）；存储键由服务端生成（`<propertyId>/<timestamp>-<random>.<ext>`），不使用用户文件名，避免路径穿越与覆盖。
3. **备份能够恢复**：见上节 6 项实测断言；采用「恢复到独立目录 + 逐表校验」而非直接覆盖线上数据，可反复演练。浏览器证据：`docs/evidence/09-backup-restore-drill.png` 显示恢复演练成功，素材文件 7 个，逐表行数 `{workspaces:1, users:1, properties:3, property_translations:2, contacts:5, media:10, listing_pages:3, reminders:2, external_service_configs:0, audit_logs:24}`。
4. **日志**：结构化日志 + 敏感键名自动脱敏；未处理异常记录 URL、方法、消息与堆栈前 6 行，但只向客户端返回通用中文提示（不泄漏堆栈）。
5. **错误提示**：所有领域错误都有中文 `message` 与可选字段级 `issues`，后台界面按字段就近展示；multipart 超限返回 413「上传文件超过大小限制」。浏览器证据：`docs/evidence/11-validation-errors.png`（标题留空 → 字段下方「标题不能为空」+ 底部聚合错误框）。
6. **移动端体验**：展示页为移动优先的响应式布局（`<meta name="viewport">`、`aspect-ratio` 图集、`auto-fit` 网格、`@media (min-width: 720px)` 与打印样式）；后台侧栏在窄屏下的表现见失败项第 7 条。
7. **密钥纪律（无硬编码密钥）**：密钥只从环境变量读取；`src/config.ts` 中的默认值全部是明显的占位符，且生产环境启动校验会因默认口令 / 示例会话密钥 / 非 https 的 `PUBLIC_BASE_URL` 直接拒绝启动；`var/` 与 `.env` 均在 `.gitignore` 中；后台只展示脱敏配置；日志脱敏；外部服务配置接口拒绝保存疑似密钥字段。
8. **许可证归档**：`docs/licenses.md`（候选项目 + 5 个运行期依赖 + 2 个开发依赖 + 外部数据服务署名义务 + 商用前复核清单，并明确指出 `typescript` 为 Apache-2.0、`qrcode-generator` 包内无 LICENSE 文件这两个证据弱点）；`docs/phase0-decision-record.md`（底座决策与偏差）。
9. **基础性能（定性）**：页面渲染为纯字符串拼接，无模板引擎与打包步骤；SQLite 为本地文件、无网络往返；媒体通过静态服务直出；周边信息按需加载且有 24 小时缓存；导出为内存构建 + 流式返回。**没有量化压测数据**，见失败项第 5 条。
10. **可观测与自检**：`/healthz` 可用于存活探测；`/api/admin/diagnostics` 提供存储可写探针与脱敏配置，便于上线后第一时间定位配置问题。

## 上线与回滚步骤（本报告整理，可直接执行）

> 仓库内目前**没有独立的部署文档**（`README.md` 为空文件），以下步骤依据实现整理；建议在本阶段收尾时把它移入 `README.md` 或 `docs/deploy.md`。

**部署前置**

1. 安装 Node.js ≥ 24（`package.json` 的 `engines` 约束），工作目录可读写。
2. `pnpm install`（工作区为 exFAT 卷时 `.npmrc` 已强制 `node-linker=hoisted`，不可用符号链接模式）。
3. 复制 `.env.example` 为 `.env` 并填写：`NODE_ENV=production`、`PORT` / `HOST`、`PUBLIC_BASE_URL=https://<域名>`、`ADMIN_PASSWORD`（≥ 12 位，非默认值）、`SESSION_SECRET`（≥ 32 字符随机串）、`OWNER_EMAIL`、`DEFAULT_TIMEZONE`、上传上限、`MAP_*`、`STORAGE_PROVIDER=local`、`MAIL_PROVIDER`（生产应设为 `smtp` 并填 `SMTP_*`）、`HOSTING_PROVIDER`、`REMINDER_*`、`BACKUP_RETENTION_DAYS`。
4. 反向代理（HTTPS 终结）由外部承担：把域名指向本服务的 `HOST`:`PORT`，签发并自动续期证书，启用 HTTP→HTTPS 跳转。**当前代码不含 TLS 终结与 HSTS，此步不可省略**（见第 6 阶段报告失败项第 2 条）。

**发布**

5. `pnpm migrate`：执行未应用的迁移（单事务、失败回滚、可重复执行；当前只有 `v1 initial_schema`）。
6. （可选）`pnpm seed`：写入演示/初始数据；生产环境通常不需要。
7. 立即创建一份备份并校验：`POST /api/admin/backups` → `POST /api/admin/backups/verify`（上线前的基线快照）。
8. 启动服务：`pnpm start`（生产建议交给进程管理器，例如 systemd 或容器，并配置自动重启；服务已处理 `SIGINT` / `SIGTERM` 优雅退出）。
9. 冒烟验证：`GET /healthz` 返回 200 且 `migrations` 含 1；`GET /api/admin/diagnostics`（登录后）`storageWritable = true`；打开后台登录页、创建/编辑一条测试房源并发布，然后撤下。
10. 备份定时任务：提醒投递由进程内定时器负责，需确保只有一个实例在运行，或明确接受多实例同时扫描（依赖数据库状态推进避免重复发送）。

**回滚**

11. 触发条件示例：启动失败、迁移失败、关键路径（登录/发布/提醒/备份）验证不通过、或出现数据写入异常。
12. 代码回滚：切回上一版本的代码目录（当前仓库尚未初始化 Git，回滚只能依赖发布时保留的上一版本副本，见失败项第 2 条）。
13. 数据回滚：停止服务 → 用最近一次通过校验的备份恢复：把归档中的 `db/app.sqlite` 覆盖 `var/db/app.sqlite`，把 `uploads/**` 覆盖 `var/uploads/**`（可先用 `POST /api/admin/backups/restore-drill` 在独立目录演练一次并核对 manifest 行数）→ 重新启动服务。
14. 迁移无法单独回退：迁移设计为「只增不改」且没有 `down` 脚本，因此数据层的回滚等价于「整库恢复到备份」；这也是第 7 步必须先做基线备份的原因。
15. 回滚后复核：`/healthz`、后台登录、房源列表、已发布页面 200 / 已撤下页面 404、提醒列表条数与计划时间、备份列表。

## 失败项、原因与影响

1. **自动化测试目录为空（上线前必须处理）**：`tests/` 下 19 个文件全部为 0 字节；`node --disable-warning=ExperimentalWarning --test tests/` 退出码 1（`MODULE_NOT_FOUND`），即 `package.json` 的 `pnpm test` 当前不可用。影响：唯一可运行的端到端验证是 `scripts/smoke.ts`（73 项），领域规则分支与失败路径没有回归网；任何后续修改都只能靠人工验证。
2. **尚未初始化版本控制**：仓库根目录存在 `.gitignore`，但**没有 `.git` 目录**（`Test-Path .git` 为假）。影响：① 无法用 Git tag/分支表达「上一版本」，回滚步骤第 12 条只能靠人工保留副本；② 许可证归档与证据文件本身也没有版本历史。
3. **HTTPS / TLS 未验证**：应用不做 TLS 终结，无证书、无跳转、无 HSTS；只有配置层要求生产 `PUBLIC_BASE_URL` 为 https。影响：上线前必须补齐反向代理配置并实测，否则「HTTPS 有效」无法声明（详见第 6 阶段报告）。
4. **SMTP 真实投递未验证**：提醒邮件在正常运行时走 `MAIL_PROVIDER=console`，从未对真实邮件服务器投递（详见第 7 阶段报告）。影响：提醒功能的最后一公里未验证。
5. **性能只有定性结论，没有量化数据**：没有做任何压测、没有首屏耗时/接口耗时统计、没有内存与连接数观察。已知的结构性风险：`GET /api/admin/properties` 会对**每条**房源再取一次聚合（发布页状态与照片数），属 N+1 查询，房源数量大时会放大；SQLite 为单写者模型，并发写会串行化。影响：无法给出容量结论，也无法据此配置资源。
6. **依赖安全审计未做**：未运行 `pnpm audit` 或等价工具，未核对传递依赖的已知漏洞；`docs/licenses.md` 也只逐项核验了直接依赖。
7. **后台窄屏体验未验证**：公开展示页已有手机视口截图（`docs/evidence/12-public-page-mobile.png`），但**管理后台没有窄屏截图**（后台截图均为 1360×900 桌面视口），侧栏与表格在手机宽度下的可用性未验证。
8. **备份的安全与运维缺口**：备份 ZIP 未加密，内容包含房源地址、联系方式等个人信息；备份落在本机 `var/backups`（无异地/离线副本）；过期清理需要手工触发（没有定时任务）；恢复演练只验证到独立目录，**没有验证「用恢复数据真正启动服务」这一步**。
9. **登录限流是单进程内存态**：`LoginRateLimiter` 的状态存在进程内存中，重启即清空，多实例不共享；公开页没有任何速率限制或防抓取措施。
10. **权限模型仍是单账号**：只有一组管理口令与一个 `admin` 角色，没有多用户、角色区分、二次验证与操作者身份区分——审计日志中的 `actor` 无法对应到具体自然人。
11. **`README.md` 为空**：没有面向使用者的启动说明与运维说明；本报告第「上线与回滚步骤」一节目前只存在于报告里。

## 许可证/安全/隐私影响

- **许可证**：`docs/licenses.md` 完整登记了候选项目（4 类）、运行期依赖（5 个）、开发依赖（2 个）、声明但未使用的 `zod`、外部数据服务（OSM 瓦片 / Overpass）的署名与商用限制、模板与媒体素材的来源声明，并给出 8 条商用前复核清单与「快照 2026-10-12，必须重新核验」的声明。已知证据弱点：`qrcode-generator` 包内无 LICENSE 文件；`typescript` 实为 Apache-2.0（非 MIT）。
- **安全**：鉴权、限流、恒定时间比较、CSP nonce、安全响应头、输入校验、上传魔数校验、错误信息不泄漏堆栈、日志脱敏、生产配置校验、外部服务配置拒绝密钥字段——覆盖了方案第六章第 8 条与第八章第 1、5 条的主要要求；未覆盖项：TLS/HSTS、依赖漏洞审计、公开页限流、多用户权限（见失败项）。
- **隐私**：联系方式默认不公开（`is_public` 默认 0）；撤下页面后公开地址立即 404；导出副本不可撤回这一点已在第 3 阶段报告登记为需提示项；精确经纬度默认公开（第 4 阶段报告失败项第 6 条）；备份包含全部个人信息且未加密（本条失败项第 8 条）；日志对敏感字段脱敏但会记录 URL 与 IP（用于限流与审计）。

## 遗留问题

1. 补齐 `tests/`（至少领域层 + 服务层 + 集成层各若干用例），让 `pnpm test` 可用。
2. 初始化 Git 仓库并把当前状态作为基线提交，之后每次发布打 tag。
3. 落地 HTTPS 终结方案（反向代理样例 + 证书续期 + HSTS）并实测归档。
4. 完成一次真实 SMTP 投递验证。
5. 做一轮基础性能测试（列表接口在 N 条房源下的耗时、展示页 TTFB、备份/导出耗时），并据此优化 `GET /api/admin/properties` 的 N+1 查询。
6. 运行依赖漏洞审计并记录结论；把 `docs/licenses.md` 的第 7 节清单纳入发布检查表。
7. 补手机视口截图（展示页 + 后台）。
8. 备份加密与异地副本方案；把过期清理改为定时任务；验证「用恢复数据启动服务」的完整切换流程。
9. 把上线与回滚步骤从本报告移入 `README.md` / `docs/deploy.md`，并补一份反向代理配置样例。
10. 评估是否需要多用户与角色（涉及 `users` 表的使用方式与审计 `actor` 的语义）。

## 是否达到本阶段验收标准：是（附带条件）

- 关键用户路径通过真实浏览器测试：**达成**——已归档截图覆盖登录、房源列表、房源编辑与校验报错、「发布页面」标签、展示页（桌面/手机、中/英）、发布提醒与投递结果、备份恢复演练、设置页与导出形态页面；关键闭环（登录 → 录入 → 上传 → 发布 → 公开访问 → 撤下 → 提醒 → 导出 → 备份）由 73 项端到端检查复跑通过（73/73，退出码 0）。
- 备份能够恢复：**达成**——创建 / 校验 / 恢复演练全部通过，恢复后 `properties`、媒体文件数、`reminders` 与 manifest 一致。
- 无硬编码密钥：**达成**——密钥只来自环境变量；默认值均为占位符且生产环境启动即拒绝；`.env` 与 `var/` 已排除；后台与日志均脱敏；外部服务配置拒绝保存密钥字段。
- 上线与回滚流程清楚：**达成（文档层面）**——本报告给出可执行的部署与回滚步骤；但仍需移入独立部署文档，且回滚链条因缺少 Git 与 TLS 方案而存在两处外部依赖（上述失败项第 2、3 条）。
- 附带条件（不影响上述四项判定，但必须在商用上线前关闭）：自动化测试目录为空、未初始化 Git、HTTPS 未验证、SMTP 未实测、无性能量化数据、未做依赖漏洞审计、备份未加密、权限仍为单账号。这些均已逐条登记，**不计为已完成**。

## 下一阶段建议（仅建议，不自动开工）

1. 把本报告的「上线与回滚步骤」提升为独立文档，并补齐反向代理样例、证书续期与回滚演练记录。
2. 上线前的阻塞清单（建议按此顺序关闭）：`tests/` 补测 → Git 初始化与打标签 → HTTPS 实测 → SMTP 实测 → 依赖漏洞审计 → 备份加密与异地副本 → 性能基线 → 手机视口验证。
3. 若计划商用，先按 `docs/licenses.md` 第 7 节完成许可证复核（含 `qrcode-generator` 证据补强与 OSM 瓦片政策），再决定是否开放注册或多工作区。
4. 建议为「精确坐标公开」「导出副本不可撤回」「备份含个人信息」三处隐私事项增加界面提示或选项，避免上线后被动整改。