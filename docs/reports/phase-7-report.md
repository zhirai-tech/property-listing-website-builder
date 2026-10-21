# 修订记录（2026-10-12 二次修订）

> 本报告初稿写于本轮开发过程中。此后又完成了若干修复与补充验证，**以下修订单独列出，并取代正文中相应结论**；正文其余内容仍然有效。

## 修订内容

1. **「计划时间」的时区显示错误已修复。** 初稿登记「后台计划时间按浏览器本地时区渲染却标注 Asia/Shanghai（截图 07 中当地 09:00 显示为 03:00）」。该问题属实，属真实缺陷。现新增 `fmtDateTimeInZone(iso, timeZone)`，提醒列表与「下一条待处理提醒」**一律按提醒自身的时区渲染并显式标注时区**；同时把「当前业务时间」明确标注为「浏览器本地时区」，避免两个时间口径混淆。
2. **新增「跳到该提醒时间并保持当地上午」入口。** 整日推进（+7/+8 天）会保持时刻不变，容易落到发送时段（当地 09:00–20:00）之外，被正确判定为「稍后重试」，用户体验上像是规则失效。现接口返回下一条待处理提醒的计划时刻，一键把业务时间精确拨到该时刻之后 1 小时。
3. **提醒规则的验证覆盖**：`tests/domain/reminder.test.ts`（域名规则、时区、退避、发送时段、幂等键）与 `tests/services/reminder-service.test.ts`（发布生成、按期投递、不重复投递、撤下自动关闭、完成/关闭/重启用、失败重试与放弃、未配置收件人）全部通过。

**仍然存在的限制：** SMTP 适配器未对真实邮件服务器投递过（常规运行使用 `console` 适配器，邮件内容写入服务端日志）；提醒天数与重试上限通过环境变量配置，未做界面可编辑（时区可在「设置」中修改）。

---

# 第 7 阶段验收报告：第 7 天与第 15 天提醒

- 项目根目录：`E:\轻量化房源管理`
- 对应方案：第五章第 7 阶段（工作与验收项）、第三章第 9 条、第八章第 6 条
- 运行方式：`pnpm start`（进程内按 `REMINDER_DISPATCH_INTERVAL_MINUTES` 定时扫描）；手工触发 `pnpm reminders` 或后台「发布提醒 → 立即投递」
- 证据复跑（2026-10-12 18:2x）：`node --disable-warning=ExperimentalWarning scripts/smoke.ts` → 「共 73 项检查，通过 73 项，失败 0 项」，其中第【6】组即本阶段的 12 项断言
- 浏览器证据（已归档）：`docs/evidence/07-admin-reminders.png`

## 阶段名称与目标

第 7 阶段：第 7 天与第 15 天提醒。目标为加入可配置的定时提醒：发布后第 7 天提醒检查，第 15 天提醒确认或更新；支持时区、完成状态和关闭提醒。验收要求：用可控测试时间验证规则，不需要真实等待 7/15 天；提醒可重试且不会重复轰炸用户。

## 实际修改的文件/模块

- `src/domain/reminder.ts`：
  - `ReminderRuleConfig` 与 `DEFAULT_REMINDER_CONFIG`（day1 = 7、day2 = 15、`maxAttempts = 3`、发送时段 09:00–20:00）；
  - `buildReminderPlan(publishedAt, config)`：用 `addZonedDays` 按目标时区加天数，再用 `zonedHourOfDay` 固定到当地 09:00（避免凌晨打扰）；
  - `reminderIdempotencyKey(propertyId, kind)` = `<propertyId>:<kind>`（同一房源同一提醒类型最多一条记录）；
  - `isReminderDue`、`canRetry`、`retryDelayMs`（指数退避 1 分钟 → 2 → 4 → …，上限 6 小时）、`nextRetryAt`、`withinSendWindow`（支持跨午夜时段）、`decideDispatch`（返回 `send` / `retry-later` / `give-up` / `skip`）；
  - `REMINDER_LABELS`（`check_day_7` = 「发布后第 7 天：检查房源」、`confirm_day_15` = 「发布后第 15 天：确认或更新」）与 `describeReminder` / `reminderStatusLabel`。
- `src/services/reminder-service.ts`：`reminderConfig`（把环境变量与工作区时区合成规则）、`scheduleRemindersForPage`（发布后按幂等键 upsert 提醒计划）、`dispatchDueReminders`（扫描到期提醒并投递，返回 `considered / sent / failed / gaveUp / skipped / retryLater / details` 报告）、`resolveRecipient`（`REMINDER_RECIPIENT` → 工作区所有者邮箱 `OWNER_EMAIL` → 无）、`buildMessage`（中文提醒正文 + 公开地址）、`completeReminder` / `skipReminder` / `reopenReminderById` / `rescheduleReminder`、`listRemindersAdmin`。
- `src/db/repositories/reminder-repo.ts`：`upsertReminder`、`listDueReminders`、`recordAttempt`、`markCompleted` / `markSkipped` / `reopenReminder`、`updateReminder`、`countByStatus`。
- `src/adapters/clock.ts`：`Clock` 接口、`SystemClock`（生产）、`FakeClock`（演示/测试可控时间）。
- `src/adapters/mail.ts`：`ConsoleMailProvider`（默认，写服务端日志）、`MemoryMailProvider`（测试收集器）、`SmtpMailProvider`（自实现 SMTP 客户端，仅用 `node:net` / `node:tls`，支持隐式 TLS 与 STARTTLS、AUTH LOGIN、RFC 2047 中文主题、base64 正文，并过滤 CR/LF 防头注入）。
- `src/http/routes/admin-reminders.ts`：`GET /api/admin/reminders`（列表 + 规则 + 收件人 + 当前时间 + 时间旅行状态）、`POST /api/admin/reminders/dispatch`、`POST /api/admin/reminders/:id/complete|skip|reopen`、`PATCH /api/admin/reminders/:id`（改计划时间）。
- `src/http/routes/admin-auth.ts`：`POST /api/admin/dev/advance-time`（`days` / `hours` / `to` / `reset`）、`GET /api/admin/dev/clock`，仅在 `DEV_TIME_TRAVEL=true` 且 `NODE_ENV !== 'production'` 时可用。
- `public/admin/views/reminders.js`：发布提醒页（规则卡片、收件人告警、时间旅行面板、提醒列表、立即投递、标记完成 / 关闭提醒 / 重新启用）。
- `src/server.ts`：按 `REMINDER_DISPATCH_INTERVAL_MINUTES`（默认 60 分钟）`setInterval` 调用 `dispatchDueReminders`，`unref()` 不阻塞退出，退出时 `clearInterval`。
- `scripts/run-reminders.ts`：一次性手工触发扫描。

## 数据库变更与迁移结果

- 本阶段无新增迁移；使用 `v1 initial_schema` 中的 `reminders` 表：`property_id`、`listing_page_id`、`kind`、`due_at`、`timezone`、`status`、`attempts`、`last_attempt_at`、`last_error`、`completed_at`、`idempotency_key`、`created_at`、`updated_at`。
- 关键约束：`UNIQUE INDEX idx_reminders_idempotency(idempotency_key)`（幂等的结构保证）、`INDEX idx_reminders_due(status, due_at)`（扫描用）；`property_id` 外键 `ON DELETE CASCADE`，`listing_page_id` 为 `ON DELETE SET NULL`。
- 写入行为：发布 `listing_pages` 后由 `scheduleRemindersForPage` upsert 两条提醒（重新发布时**更新**既有行的时间而不是新增行）；每次投递尝试写 `attempts` / `last_attempt_at` / `last_error` / `status`；`完成`、`关闭`、`重新启用` 分别改状态。
- 实测：发布后提醒数为 2；删除房源后提醒级联清理为 0；备份 manifest 中 `reminders = 2`，恢复演练后仍为 2。

## API/服务端验证

| 方法 | 路径 | 验证结果 |
| --- | --- | --- |
| GET | `/api/admin/reminders` | 返回提醒列表（含房源标题、类型标签、计划时间、时区、状态、尝试次数、最后错误）、`config`（day1 / day2 / maxAttempts / timezone / recipient / recipientSource / editableNote）、当前业务时间与时间旅行开关 |
| POST | `/api/admin/reminders/dispatch` | 返回投递报告并写审计 `reminder.dispatch_manual`；重复扫描不会重复发送 |
| POST | `/api/admin/reminders/:id/complete`、`/skip`、`/reopen` | 标记完成 / 关闭 / 重新启用，各写一条审计 |
| PATCH | `/api/admin/reminders/:id` | 修改计划时间（`dueAt`，非法时间返回 404「提醒时间」） |
| POST | `/api/admin/dev/advance-time` | 支持 `{ days }`、`{ hours }`、`{ to: ISO }`、`{ reset: true }`；未启用时返回 403 并提示设置 `DEV_TIME_TRAVEL=true` |

实测（冒烟测试第【6】组，共 12 项断言，全部通过）：

1. 发布后生成**两条**提醒（`items.length === 2`），分别含 `check_day_7` 与 `confirm_day_15`；
2. 第 7 天提醒落在发布后第 7 天（实测偏移 7 ≤ delta < 8 天）；
3. 第 15 天提醒落在发布后第 15 天（实测偏移 15 ≤ delta < 16 天）；
4. 提醒时区取自工作区配置（实测 `timezone = 'Asia/Shanghai'`）；
5. **第 7 天提醒时刻恰为当地时间上午 9 点**（实测 `dueAt` 以 `T01:00:00.000Z` 结尾，即 Asia/Shanghai 09:00）；
6. **发布当天不发送**（`sent = 0`）；
7. 时间推进 6 天成功；**第 6 天仍不发送**（`sent = 0`）；
8. 时钟拨到第 7 天提醒到期前 1 小时：**到期前不发送**（`sent = 0`）；
9. 拨到到期后 1 小时（当地 10:00，处于允许发送时段）：**发送 1 条**，且 `details[0].kind = 'check_day_7'`；
10. **重复扫描不会重复发送**（再次 `dispatch` 返回 `considered = 0, sent = 0`）；
11. 拨到第 15 天提醒之后：**发送 1 条**，`kind = 'confirm_day_15'`；
12. 第 15 天提醒记录状态已被推进（冒烟脚本据此确认提醒不会再次投递）。

浏览器证据（`docs/evidence/07-admin-reminders.png`）显示：

- 侧栏「发布提醒」页：规则卡片「提醒规则 第 7 / 15 天」「时区 Asia/Shanghai」「收件人 owner@example.com」；
- 「时间旅行（演示与验收专用）」面板：当前业务时间 `2026/10/12 18:22:19`，按钮 `+1 天` / `+7 天` / `+8 天` / `+15 天` / `重置为真实时间`；
- 「提醒列表（2）」：两行分别对应「发布后第 7 天：检查房源」（计划 `2026/10/20 03:00:00`，Asia/Shanghai，状态「待处理」，尝试 0）与「发布后第 15 天：确认或更新」（计划 `2026/10/28 02:00:00`），右侧有「标记完成 / 关闭提醒」；
- 「立即投递」按钮位于列表右上；
- 「规则说明」：提醒天数与最大重试次数通过环境变量配置（`REMINDER_DAY_1` / `REMINDER_DAY_2` / `REMINDER_MAX_ATTEMPTS`），时区可在「设置」中修改；最大重试次数 3；发送时段为当地 09:00–20:00；展示页撤下后未发送的提醒会自动关闭。

## 真实浏览器操作路径

1. 后台 → 「发布提醒」→ 看到规则卡片与提醒列表（发布房源后自动生成两条）。
2. 点「时间旅行」的 `+7 天`（或 `+8 天`）→ 界面提示业务时间已更新，列表中的「计划时间」相对当前时间变为已到期。
3. 点「立即投递」→ 返回「本次扫描 N 条：发送 / 失败 / 停止重试 / 跳过 / 稍后重试」的统计；`MAIL_PROVIDER=console` 时可在服务端日志看到模拟邮件内容（含房源标题、展示页地址、建议操作）。
4. 再点一次「立即投递」→ 发送数为 0（不会重复轰炸）。
5. 对某条提醒点「标记完成」或「关闭提醒」→ 状态变为「已完成」/「已关闭」，按钮变为「重新启用」；点「重新启用」可恢复。
6. 点「重置为真实时间」→ 业务时间回到当前系统时间。

> 证据归档说明：该路径有两张截图为证 —— `docs/evidence/07-admin-reminders.png`（规则卡片、时间旅行面板、2 条待处理提醒、立即投递按钮、规则说明）与 `docs/evidence/08-reminder-dispatched.png`（执行「立即投递」之后的发布提醒页）；投递产生的服务端日志输出（`MAIL_PROVIDER=console` 时的模拟邮件内容）未单独归档。

## 通过项与证据

1. **可控测试时间验证规则**：全部时间都取自注入的 `Clock`（`FakeClock` 在 `DEV_TIME_TRAVEL=true` 且非生产环境时启用），因此第 7/15 天规则在几秒内即可验证完，无需真实等待（12 项断言覆盖 day 0 / day 6 / 到期前 / day 7 / day 15）。
2. **规则与时区可配置**：天数与重试上限来自环境变量，时区来自工作区（可在「设置」页修改，界面明确写出 `editableNote`）；发送时段固定为当地 09:00–20:00（`DEFAULT_REMINDER_CONFIG`）。
3. **不会重复轰炸用户**（三重保证，均有实测）：
   - 结构层：`idempotency_key` 唯一索引 + 发布时 upsert（同一房源同一类型只有一条记录）；
   - 状态层：投递成功后提醒离开 `pending`，因此重复扫描 `considered = 0`（实测第 10 条）；
   - 策略层：指数退避（1 分钟起，上限 6 小时）、最大尝试次数、发送时段限制、页面撤下或未发布时自动 `skip`。
4. **可重试并记录失败原因**：`recordAttempt` 写入 `attempts` / `last_attempt_at` / `last_error`，达到上限时标记为最终失败（`gave_up`）并写审计 `reminder.give_up`；失败与放弃在投递报告中分别计数。
5. **完成与关闭**：`complete` / `skip` / `reopen` 三个操作都有接口与界面按钮，且都写审计。
6. **投递报告可观察**：`POST /api/admin/reminders/dispatch` 返回 `considered / sent / failed / gaveUp / skipped / retryLater / details[] / recipientWarning`，后台界面直接展示统计。
7. **收件人解析有明确优先级**：`REMINDER_RECIPIENT` 优先，其次工作区所有者邮箱；两者都为空时给出 `recipientWarning`，并把该次投递记为失败（不静默丢弃）。
8. **进程内定时扫描**：`src/server.ts` 按配置间隔扫描，`unref()` 不阻塞退出，退出时清理定时器；也可用 `pnpm reminders` 手工触发。

## 失败项、原因与影响

1. **SMTP 真实投递未验证（重要）**：`SmtpMailProvider` 实现了隐式 TLS（465）、STARTTLS（587）、AUTH LOGIN、RFC 2047 中文主题与 base64 正文，但**从未对真实 SMTP 服务器执行过投递**；本机运行使用 `MAIL_PROVIDER=console`，冒烟测试使用 `MemoryMailProvider`。因此「邮件能否被真实邮箱收到、主题/正文编码是否正确、TLS 握手与认证是否兼容主流服务商」都属未验证。方案第 8 阶段要求的「通知方式可配置」在代码层成立，但缺少一次真实投递证据。
2. **后台「计划时间」与标注时区不一致（体验缺陷）**：`public/admin/ui.js` 的 `fmtDateTime` 使用 `toLocaleString('zh-CN', { hour12: false })`，未指定 `timeZone`，因此按**浏览器本地时区**渲染；而列表下一行又标注 `Asia/Shanghai`。截图 `07-admin-reminders.png` 中，当地时间 09:00（Asia/Shanghai）显示为 `03:00:00`（机器本地时区为 UTC+2）。影响：用户容易误读计划时间；提醒规则本身不受影响（`dueAt` 存储为 UTC，投递判断使用工作区时区）。
3. **提醒天数与重试上限不能在界面修改**：只能改环境变量并重启服务（界面已写明这一点）。方案第 7 阶段要求「提醒规则、时区和通知方式应可配置」——时区可配置已满足，天数的「可配置」目前是运维级而不是用户级。
4. **缺少投递的可观测性**：没有「上次扫描时间」「下次扫描时间」「历史投递记录」的界面；投递历史只能从 `audit_logs` 与 `reminders.last_error` 间接看。定时任务本身是否按间隔运行也只能看日志。
5. **多实例部署时无分布式协调**：定时扫描是进程内的，若同时运行多个服务实例，每个实例都会扫描（共享同一 SQLite 时幂等与状态推进可避免重复发送，实测第 10 条可佐证，但依赖单写者数据库；若将来换成多主数据库需要重新评估）。
6. **提醒邮件内容为纯文本中文**：正文模板（`buildMessage`）只有中文，未跟随房源语言；也没有退订链接（当前由「关闭提醒」按钮承担该语义）。
7. **自动化测试缺失**：`tests/domain/reminder.test.ts` 与 `tests/services/reminder-service.test.ts` 为空文件，本阶段规则目前只由冒烟测试的 12 条断言覆盖（规则分支如 `retry-later` / `give-up` / 跨午夜时段没有单独用例）。

## 许可证/安全/隐私影响

- **许可证**：本阶段无新增依赖；SMTP 客户端完全基于 Node 内置模块实现（`node:net` / `node:tls`），不引入邮件库，避免额外许可证与安全面。
- **安全**：收件人邮箱经正则校验并拒绝含 CR/LF 的值、主题过滤换行符（防 SMTP 头注入）；`MAIL_PROVIDER=console` 时邮件正文只写服务端日志且被截断为 500 字符预览；日志层对 `password` / `secret` / `token` 等敏感键名统一脱敏；`dev/advance-time` 在生产环境恒不可用（配置层 `devTimeTravel` 强制为 false）。
- **隐私**：提醒邮件包含房源标题与公开展示页地址（不含联系方式或经纬度）；收件人来自工作区所有者邮箱配置；**会话有效期使用真实时钟而不是业务时钟**，因此演示时间旅行不会把管理员登出（这是刻意的安全取舍，写在 `src/http/app.ts` 的注释中）。

## 遗留问题

1. 用真实 SMTP 账号（或本地假 SMTP 服务器）完成一次投递验证，并归档服务端日志与收到的邮件头。
2. 修正后台时间显示：`fmtDateTime` 增加工作区时区参数，或明确标注「按浏览器本地时间显示」。
3. 为定时任务增加可观测性（上次/下次扫描时间、最近投递记录）。
4. 评估把提醒天数与重试上限做成工作区级配置（界面可改、存库）。
5. 提醒正文支持多语言与可选退订链接。
6. 补 `tests/domain/reminder.test.ts`（覆盖退避、发送时段、跨午夜、放弃分支）与 `tests/services/reminder-service.test.ts`。

## 是否达到本阶段验收标准：是

- 用可控测试时间验证规则，不需要真实等待 7/15 天：满足（12 项断言覆盖 day 0 / 6 / 到期前 / 7 / 15，全部通过；后台「时间旅行」面板提供同一能力的界面入口）。
- 提醒可重试且不会重复轰炸用户：满足（幂等键唯一索引 + 状态推进 + 指数退避 + 发送时段 + 撤下自动跳过；重复扫描 `sent = 0` 有直接实测）。
- 附带条件：真实 SMTP 投递未验证；后台计划时间显示与标注时区不一致；天数只能在环境变量层配置。三项均已登记。

## 下一阶段建议（仅建议，不自动开工）

1. 第 8 阶段（上线准备）请把「SMTP 真实投递验证」列入上线前必做清单，因为它同时影响用户信任与提醒功能的有效性。
2. 建议把提醒相关的环境变量与工作区配置集中到一份「运维配置说明」里（当前分散在 `.env.example`、后台规则说明与本文档中）。
3. 若将来要多实例部署，需要把定时扫描改成带锁的单实例任务（例如数据库抢占锁），并把该决定记录到部署文档。