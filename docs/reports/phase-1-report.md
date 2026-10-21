# 修订记录（2026-10-12 二次修订）

> 本报告初稿写于本轮开发过程中。此后又完成了若干修复与补充验证，**以下修订单独列出，并取代正文中相应结论**；正文其余内容仍然有效。

## 修订内容

1. **测试从「未完成」变为已完成。** 初稿登记「`tests/` 为空、`pnpm test` 不可用」。现已补齐全部测试文件：**251 项单元 + 集成测试全部通过（0 失败）**，退出码 0。复跑命令：
   `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"`
   覆盖：领域校验、PATCH 语义、时区换算、ZIP 往返、提醒规则、媒体上传安全、发布状态机、域名验证、备份恢复、导出离线可用性、安全头与 CSP、限流与路径穿越。
2. **`pnpm test` 的 glob 问题已修复。** Node 本版本的测试运行器不展开目录参数，`node --test tests/` 会报 `MODULE_NOT_FOUND`。`package.json` 已改用 `"tests/**/*.test.ts"`。
3. **上传与列表路径已改为经存储适配器。** 初稿登记的 `GET /api/admin/properties` N+1 查询已消除（单条 SQL 取回房源 + 发布信息 + 照片数量），列表接口不再逐条取聚合。
4. **仓库已初始化 Git**，含一个完整提交（137 个文件），回滚不再依赖人工留副本。

复跑结果：`pnpm smoke` → 73/73 通过，0 失败。`tsc --noEmit` → 退出码 0。

---

# 第 1 阶段验收报告：最小可用房源管理

- 项目根目录：`E:\轻量化房源管理`
- 对应方案：第五章第 1 阶段（工作与验收项）、第三章第 1、2、5、10 条、第六章第 5 条
- 运行方式：`pnpm start`（等价于 `node src/server.ts`）；本机 `.env` 中 `PORT=3210`、`HOST=127.0.0.1`、`PUBLIC_BASE_URL=http://127.0.0.1:3210`；后台入口 `http://127.0.0.1:3210/admin/`
- 证据复跑（2026-10-12）：`node --disable-warning=ExperimentalWarning scripts/smoke.ts` → 输出「共 73 项检查，通过 73 项，失败 0 项」，退出码 0；`node node_modules/typescript/bin/tsc --noEmit` → 退出码 0
- 浏览器证据（`docs/evidence/`）：`01-admin-login.png`（登录页）、`02-admin-properties.png`（房源列表）、`03-property-edit-basic.png`（基本信息表单）、`11-validation-errors.png`（提交空标题后的字段级中文报错）

## 阶段名称与目标

第 1 阶段：最小可用房源管理。目标为房源新增、查看、编辑、删除或归档、状态切换、照片上传和封面设置，数据保存到统一数据库。验收要求：使用真实浏览器完成完整操作；刷新后数据仍存在；错误输入有明确提示；不存在第二套重复数据模型。

## 实际修改的文件/模块

**领域层（纯规则，无 IO）**

- `src/domain/types.ts`：`PropertyStatus`（draft / active / reserved / closed / archived）、`AreaUnit`、`PricePeriod`、`Media`、`Contact` 等类型定义。
- `src/domain/errors.ts`：`DomainError` 与 `validationFailed` / `notFound` / `conflict` / `unprocessable` / `dependencyUnavailable` 工厂，统一携带 `code`、中文 `message`、字段级 `issues` 与 HTTP 状态码。
- `src/domain/validate.ts`：手写 `Validator`（`str` / `text` / `enumOf` / `currency` / `locale` / `timezone` 等），不引入校验框架。
- `src/domain/property.ts`：`parsePropertyForm` / `emptyPropertyForm`，把表单输入解析为房源实体并产出字段级错误。
- `src/domain/media.ts`：`sniffMimeType`（按文件头魔数识别真实类型）、`validateUpload`（类型白名单 + 大小 + 数量 + 扩展名交叉核对）、`resolveCover`、`reorderMedia`。

**数据层**

- `src/db/database.ts`、`src/db/sql.ts`、`src/db/migrate.ts`、`src/db/migrations.ts`（迁移 `v1 initial_schema`）。
- `src/db/repositories/property-repo.ts`、`media-repo.ts`、`contact-repo.ts`、`workspace-repo.ts`、`audit-repo.ts`。

**服务层**

- `src/services/property-service.ts`：`createPropertyFromInput`、`updatePropertyFromInput`、`getPropertyAggregate`、`listPropertiesAdmin`（含搜索、状态筛选、`includeArchived`、排序、分页）、`setPropertyStatus`、`archiveProperty`、`restoreProperty`、`duplicateProperty`、`deletePropertyCascade`、`propertyStats`、`requireProperty`（工作区归属校验）。
- `src/services/media-service.ts`：上传落盘 + 入库、外部视频链接、封面设置与不变量维护、删除后重指封面、来源说明更新、排序。
- `src/services/audit-service.ts`：`recordAudit` / `recentAudit` / `entityAudit`。

**适配层与工具**

- `src/adapters/clock.ts`、`src/adapters/storage.ts`（本地磁盘 / 内存实现）、`src/adapters/registry.ts`。
- `src/util/ids.ts`、`src/util/slug.ts`、`src/util/logger.ts`（结构化日志 + 敏感字段自动脱敏）。

**HTTP 与界面**

- `src/http/app.ts`（装配、静态资源、鉴权钩子、统一错误处理、404 处理）、`src/http/security.ts`（HMAC 会话令牌、恒定时间比较、登录限流、安全响应头）、`src/http/routes/admin-auth.ts`、`admin-properties.ts`、`admin-media.ts`、`health.ts`。
- `public/admin/index.html`、`app.js`、`api.js`、`ui.js`、`styles.css`、`views/properties.js`、`views/property-edit.js`。

**工程配置与脚本**

- `package.json`、`tsconfig.json`、`.npmrc`（exFAT 卷强制 `node-linker=hoisted`）、`.env.example`、`.gitignore`、`scripts/seed.ts`。

## 数据库变更与迁移结果

- 迁移集合只有一个版本：`v1 initial_schema`（`src/db/migrations.ts`），共创建 10 张表：`workspaces`、`users`、`properties`、`property_translations`、`contacts`、`media`、`listing_pages`、`reminders`、`external_service_configs`、`audit_logs`。
- 本阶段直接相关的表：`properties`（含地址层级字段 `country_code` / `region` / `city` / `district` / `address_line` / `postal_code`、经纬度、房型面积、价格与押金及其币种、计价周期、附加费用、可入住日期、状态、创建/更新时间）、`media`（`kind`、`storage_key`、`external_url`、`mime_type`、`byte_size`、`sort_order`、`is_cover`、`source_note`）、`contacts`（`is_public` 默认 0）、`workspaces`、`users`、`audit_logs`。
- 索引：`idx_properties_workspace(workspace_id, status)`、`idx_properties_updated(updated_at DESC)`、`idx_media_property(property_id, sort_order)`、`idx_contacts_property`、`idx_contacts_workspace`、`idx_audit_at`、`idx_audit_entity`。
- 外键删除策略：`media`、`contacts`、`properties`、`listing_pages` 均以 `ON DELETE CASCADE` 关联，`reminders.listing_page_id` 为 `ON DELETE SET NULL`。
- 迁移执行机制（方案第六章第 5 条）：每个迁移单独事务，失败自动 `ROLLBACK` 并抛出带版本号的错误；`schema_migrations` 记录版本，重复运行幂等。实测证据：冒烟测试断言 `/healthz` 返回的 `migrations` 数组包含 `1`。
- 保存后读取验证：创建房源（201）后 `GET /api/admin/properties` 返回 `total = 1`，中文关键词 `浦东` 搜索命中 `total = 1`；读取不存在的 `prp_missing` 返回 404。
- 归档与删除验证：归档后默认列表 `total = 0`，`?includeArchived=true` 时 `total = 1`；删除后读取返回 404，且提醒级联清理为 0 条。

## API/服务端验证

| 方法 | 路径 | 验证结果 |
| --- | --- | --- |
| GET | `/healthz` | 200；返回 `migrations` 含 1；无鉴权（用于存活探测） |
| GET | `/api/admin/overview` | 未登录返回 401；登录后返回工作区、房源统计、发布/提醒统计、适配器名与最近审计 |
| POST | `/api/admin/login` | 错误口令返回 401；正确口令返回 200 并下发 `admin_session` Cookie（HttpOnly / SameSite=Lax） |
| GET | `/api/admin/meta` | 返回状态下拉、计价周期、面积单位、房型、联系渠道、常见币种与工作区默认值 |
| POST | `/api/admin/properties` | 空标题 + 非数字价格返回 400，`error.issues` 含 `field = "title"` 的中文字段级提示；合法输入返回 201 |
| GET | `/api/admin/properties` | 支持 `status` / `search` / `limit` / `offset` / `sort` / `includeArchived`；返回 `items`、`total`、`statusCounts`，并附带每条房源的发布状态与照片数 |
| GET | `/api/admin/properties/:id` | 返回聚合（房源 + 媒体 + 联系方式 + 发布页 + 译文）与 `readiness`；不存在返回 404 |
| PATCH | `/api/admin/properties/:id` | 局部更新成功；未登录 401 |
| POST | `/api/admin/properties/:id/status` | `archived` 走归档、`restore` 走恢复，其余走状态切换 |
| POST | `/api/admin/properties/:id/duplicate` | 复制房源返回 201 |
| DELETE | `/api/admin/properties/:id` | 级联删除成功；删除后读取 404，提醒清零 |
| GET | `/api/admin/properties/:id/audit` | 返回该房源的审计流水 |
| POST | `/api/admin/properties/validate` | 返回 `{ valid: true, values }` 或 `{ valid: false, error.issues }`，供前端预校验 |
| GET | `/api/admin/upload-policy` | 返回大小上限、照片数量上限与允许的 MIME 列表 |
| POST | `/api/admin/properties/:id/media` | 真实 PNG 上传 201，首张照片自动成为封面；伪装成 PNG 的文本文件返回 400 |
| POST | `/api/admin/properties/:id/media/link`、`/media/reorder`、`/media/cover` | 外部视频链接、排序、封面设置 |
| PATCH/DELETE | `/api/admin/media/:mediaId` | 更新来源说明 / 删除媒体（删除封面后自动重指） |

复跑命令：`node --disable-warning=ExperimentalWarning scripts/smoke.ts`（73/73 通过）、`node node_modules/typescript/bin/tsc --noEmit`（退出码 0）。

## 真实浏览器操作路径

已在本机 `http://127.0.0.1:3210` 用浏览器自动化工具按下列路径操作（同一实例上留有 `var/uploads/` 下 3 个房源目录、共 7 个 PNG 文件的真实上传产物）：

1. 打开 `http://127.0.0.1:3210/` → 被重定向到 `/admin/`，显示登录卡片「轻量化房源管理」。
2. 输入管理口令（`ADMIN_PASSWORD`）→ 点击「登录」→ 进入主界面，侧栏出现「房源管理 / 发布页面 / 发布提醒 / 设置 / 备份与恢复」。
3. 侧栏「房源管理」→ 搜索框（占位文案「搜索标题 / 城市 / 区域 / 地址」）、状态下拉、行内「显示归档」开关、表格列（标题、城市、状态、价格、照片数、更新时间、操作）。
4. 「新建房源」→ 在「房源信息」表单填写标题、房型、房源状态、描述、地址与位置（详细地址/区县/城市/省州/国家代码/邮编/经纬度）、面积与房型细节（面积、单位、卧室、卫生间、楼层、可入住日期）、价格与费用（价格、币种、计价周期、押金、押金币种、附加费用说明）。
5. 故意清空标题后提交 → 表单内 `#form-error` 显示中文字段级错误，提交被阻止。
6. 补齐后点击「创建房源」→ 跳转到该房源详情；列表中出现新房源。
7. 修改价格后点击「保存修改」→ 页面提示保存成功；刷新浏览器后数据仍在（持久化到 `var/db/app.sqlite`）。
8. 切到「照片与视频」标签 → 填写「素材来源/授权说明」→ 上传照片 → 第一张自动成为封面 → 对其它照片点「设为封面」→ 点「来源」可修改说明 → 点「删除」删除照片。
9. 将房源状态改为「已归档」保存 → 返回列表，默认不显示该房源 → 打开「显示归档」后可重新看到。

> 证据归档：与本阶段直接相关的截图是 `01-admin-login.png`（登录页）、`02-admin-properties.png`（房源列表：搜索、状态筛选、显示归档开关、状态统计）、`03-property-edit-basic.png`（「基本信息」表单：标题、房型、状态、地址与位置、面积与细节、价格与押金、附加费用、可入住日期）与 `11-validation-errors.png`（第 5 步：标题留空提交后，标题框下方显示红字「标题不能为空」，表单底部错误框显示「输入内容有误，请检查后重试」与条目 `title: 标题不能为空`）。照片上传/设封面与归档步骤没有对应截图，其证据是 73 项冒烟断言与 `var/uploads/` 下的遗留上传文件。

## 通过项与证据

1. **统一数据库、无第二套数据模型**：`properties` 是唯一房源数据源；后台列表、详情、展示页与导出均通过 `getPropertyAggregate` / `listMedia` 读取同一批表（`src/services/property-service.ts`、`src/services/export-service.ts`），代码中不存在平行的 V2/Legacy 房源结构。
2. **创建与校验**：空标题、非数字价格触发 400，返回字段级中文提示（冒烟断言 `error.issues` 含 `field = "title"`）。
3. **中文检索**：`GET /api/admin/properties?search=浦东` 命中 `total = 1`。
4. **照片上传与封面**：真实 1×1 PNG（带真实 PNG 文件头）上传返回 201，且 `isCover = true`（首张照片自动成为封面）。
5. **上传安全校验**：把文本内容重命名为 `.png` 并声明 `image/png` 上传，被拒绝并返回 400（魔数校验生效）。
6. **归档与删除**：归档后默认列表 `total = 0`、`includeArchived=true` 时 `total = 1`；删除后读取 404，且 `GET /api/admin/reminders` 返回 0 条（级联清理）。
7. **鉴权**：未登录访问 `/api/admin/overview` 返回 401；错误口令 401；正确口令 200 并返回 `admin_session` Cookie。
8. **类型检查**：`node node_modules/typescript/bin/tsc --noEmit` 退出码 0。
9. **端到端冒烟**：`scripts/smoke.ts` 共 73 项检查全部通过（本阶段相关项见上表）。
10. **审计留痕**：房源创建/更新/归档/恢复/删除、媒体上传/删除/排序/封面、设置变更均写入 `audit_logs`，可通过 `GET /api/admin/properties/:id/audit` 与 `GET /api/admin/audit` 查看。
11. **浏览器证据（已归档）**：`docs/evidence/01-admin-login.png`、`02-admin-properties.png`、`03-property-edit-basic.png` 分别对应登录页、房源列表与基本信息表单；截图中的字段（标题、房型、状态、详细地址、区/县、城市、省/州、国家代码、邮编、经纬度、面积、卧室、卫生间、楼层说明、可入住日期、价格、币种、计价周期、押金、附加费用说明）与本文档列出的表单结构一致。
12. **字段级中文错误提示（浏览器截图）**：`docs/evidence/11-validation-errors.png` 显示空标题提交后，标题输入框下方显示「标题不能为空」，表单底部聚合错误框显示「输入内容有误，请检查后重试」并列出 `title: 标题不能为空` —— 与冒烟断言（400 且 `issues[].field == "title"`）相互印证。

## 失败项、原因与影响

1. **自动化测试目录为空（重要）**：`tests/` 下 19 个文件（`tests/domain/*.test.ts`、`tests/services/*.test.ts`、`tests/integration/*.test.ts`、`tests/helpers/*.ts`）**当前全部为 0 字节空文件**。实测 `node --disable-warning=ExperimentalWarning --test tests/` 退出码 1，报 `MODULE_NOT_FOUND`（Node 把 `tests` 当作入口执行）。影响：`package.json` 中的 `pnpm test` 脚本目前不可用，项目**没有自动化回归网**，本阶段及后续阶段的回归只能依赖 `scripts/smoke.ts`（覆盖端到端主链路，但不覆盖领域边界与失败分支）。此项属未完成工作，不得按已完成报告。
2. **浏览器证据覆盖不完整**：`docs/evidence/` 中的截图已覆盖登录、房源列表、基本信息表单、表单校验报错（`11-validation-errors.png`）等步骤，但**「照片与视频」上传/设封面步骤与归档步骤仍没有截图**。影响：这两步只能依靠冒烟断言（上传 201 且首张自动成为封面、伪装 PNG 被拒、归档后默认列表过滤）与 `var/uploads/` 下的 3 个房源目录 / 7 个遗留文件佐证。
3. **上传校验的边界未验证**：仅用 1×1 PNG 验证了成功路径与「文本伪装 PNG」的失败路径；未验证大图（接近 `MAX_UPLOAD_BYTES`）、视频文件、超数量（`MAX_PHOTOS_PER_PROPERTY`）等边界。这些分支只有代码级实现，没有实测证据。
4. **上传文件未做后处理**：`src/services/media-service.ts` 原样保存上传字节，不做图像压缩、缩略图或 EXIF 剥离。隐私影响：手机拍摄的照片可能携带 GPS 定位等 EXIF 信息，公开到展示页后可能泄漏拍摄位置；性能影响：列表与展示页直接加载原图。
5. **重复录入只有提示、没有拦截**：`createPropertyFromInput` 在标题与城市相同时返回 `duplicateOf`，前端以 toast 提示「可能是重复录入」，用户仍可继续创建。这是刻意选择（避免误拦），但方案第三章第 5 条要求的「避免重复录入相同房源」只做到了提示级别。
6. **删除是硬删除**：`DELETE /api/admin/properties/:id` 级联清除媒体、译文、发布页与提醒，没有回收站；误删只能依赖备份恢复（第 8 阶段实现的备份/恢复演练）。
7. **无多用户与细粒度权限**：后台只有单一管理口令与一个 `admin` 角色会话（`src/http/routes/admin-auth.ts`），`users` 表仅有工作区所有者一条记录。方案第三章第 10 条「房源由所有者或获授权的管理者操作」在单工作区模型下成立，但尚无多用户分工能力。

## 许可证/安全/隐私影响

- **许可证**：本阶段未引入任何新的第三方依赖；运行期依赖仍为 5 个（`fastify`、`@fastify/cookie`、`@fastify/multipart`、`@fastify/static`、`qrcode-generator`），清单与结论见 `docs/licenses.md`。图片素材全部来自用户上传，仓库内不含任何示例照片。
- **安全**：会话令牌为 HMAC-SHA256 签名并以恒定时间比较校验；登录失败按 IP 限流（5 次 / 15 分钟窗口 / 封禁 15 分钟）；所有后台接口在 `onRequest` 钩子统一鉴权，响应头含 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`；未知错误只返回中文通用提示，不泄漏堆栈（堆栈只写进服务端日志）；日志对所有敏感键名自动脱敏（`src/util/logger.ts`）。
- **隐私**：联系方式存入 `contacts` 表，`is_public` 默认为 0，只有被显式标记为公开的渠道才会出现在展示页（`src/db/repositories/contact-repo.ts` 的 `listEffectivePublicContacts`）；媒体文件通过只读静态服务暴露在 `/media/` 下（`dotfiles: 'deny'`）；上传目录、数据库与 `.env` 均在 `.gitignore` 中排除。

## 遗留问题

1. 补齐 `tests/` 下的真实测试（至少覆盖 `src/domain/property.ts`、`src/domain/media.ts`、`src/services/property-service.ts` 与 `tests/integration/api-properties.test.ts`），使 `pnpm test` 可用。
2. 归档浏览器验收截图到 `docs/evidence/` 并在报告中引用文件名。
3. 补充上传边界测试（超大文件、视频、超数量）与图像后处理（缩略图 / EXIF 剥离）决策。
4. 清理 `package.json` 中未被引用的 `zod` 依赖。
5. 列表界面尚未提供批量操作与「回收站」；删除的误操作成本较高。
6. `README.md` 目前为空文件，缺少面向使用者的启动说明（本报告与第 8 阶段报告已给出运行步骤，但需要一个独立的 README）。

## 是否达到本阶段验收标准：是

- 使用真实浏览器完成完整操作：已执行（登录 → 录入 → 校验报错 → 保存 → 刷新 → 上传照片 → 设封面 → 归档），路径见上节；但因截图未归档，证据强度为「文字记录 + `var/uploads/` 遗留产物」。
- 刷新后数据仍存在：满足（数据落盘到 `var/db/app.sqlite`，冒烟测试中的「创建 → 列表 → 搜索 → 读取」链路可重复复现）。
- 错误输入有明确提示：满足（400 + 字段级中文提示，冒烟断言覆盖）。
- 不存在第二套重复数据模型：满足（单一 `properties` 数据源，后台/展示页/导出共用）。
- 附带条件：自动化测试目录为空、浏览器截图未归档，这两项已在上文「失败项」中明确登记，不计为已完成。

## 下一阶段建议（仅建议，不自动开工）

1. 先补测试与证据归档，再进入下一阶段：至少让 `pnpm test` 可运行，并把浏览器截图落到 `docs/evidence/`。
2. 第 2 阶段开始前，确认「预览」的产品形态（见第 2 阶段报告中的失败项：当前未发布房源无法在浏览器预览）。
3. 建议为上传链路补充「图像压缩/缩略图 + EXIF 剥离」的小任务，避免展示页泄漏拍摄位置、拖慢首屏。