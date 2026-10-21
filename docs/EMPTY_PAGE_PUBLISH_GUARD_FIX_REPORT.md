# 修复报告：阻止空内容或无效页面发布成功

**修复日期**：2026-10-13
**基准 HEAD**：`435cd6d3e4ab57af383ccb60ce04687134076dca`（未变）
**修复范围**：只处理「内容无效也能发布成功」这一个缺陷。

---

## 一、根因

`src/platform/projects.ts` 的 `publishProject()` **没有任何内容校验**：
它只检查「项目属于该用户」和「套餐包含托管」，然后直接写发布版本、改状态、分配短链。

实测（修复前）：

```
项目 spec = {}                        ← 从未写入任何内容
POST /publish  →  HTTP 200
                 status = published
                 publicUrl = http://127.0.0.1:4451/s/从未生成内容
GET publicUrl  →  HTTP 404            ← 接口说成功，地址打不开
```

**为什么必须修**：这比直接拒绝更糟 —— 用户会以为发布成功，把打不开的链接分享出去，
而且不知道该改什么。

**注意**：房源插件那条路已经有部分保护（关联不到房源 / 采不到快照就拒绝），
所以这个缺陷**只在自定义页面插件上暴露**。

---

## 二、改了哪些文件

| 文件 | 关键位置 | 改动 |
| --- | --- | --- |
| `src/platform/plugins/types.ts` | `PublishCheck` 类型 | **新增**发布校验契约 |
| `src/platform/plugins/custom-page-plugin.ts` | `customPagePublishCheck()` | **新增**校验：必须有可渲染的 HTML |
| `src/platform/plugins/listing-plugin.ts` | `listingPublishCheck()` | **新增**校验：必须关联到房源 |
| `src/platform/plugins/registry.ts` | `PUBLISH_CHECKS` / `publishCheckFor()` | **新增**按插件查表 |
| `src/platform/projects.ts` | `publishProject()` | 写任何东西**之前**先校验 |
| `src/http/routes/platform.ts` | 发布路由 | `not_publishable` → **422 UNPROCESSABLE** |
| `tests/platform/publish-guard.test.ts` | — | **新增** 7 个单元测试 |
| `tests/platform/hosting.test.ts` | — | **新增** 6 个场景集成测试（A–F） |

### 校验为什么放在插件里，而不是写成 if

平台发布逻辑只需要问一句「**这个插件说能发吗**」：

```ts
const publishCheck = publishCheckFor(project.pluginId);
if (!publishCheck) return { ok: false, code: 'not_publishable', message: '这个插件类型暂不支持发布到平台托管。' };
const check = publishCheck(project.spec);
if (!check.ok) return { ok: false, code: 'not_publishable', message: check.message };
```

- 新增插件时**不会漏掉校验**（没有注册就只能被拒绝，fail-closed）；
- 不用维护一张 if 表；
- 规则与插件的数据结构天然放在一起。

---

## 三、校验规则及其与插件类型的关系

| 插件 | 「有内容」的含义 | 拒绝条件 |
| --- | --- | --- |
| `custom-page` | 有一份**可渲染且通过安全校验门**的 HTML | `html` 缺失 / 空串 / 纯空白 / 非字符串；或未通过 `validateGeneratedPage` |
| `listing` | 关联到一套**真实存在**的房源 | `spec.propertyId` 缺失或为空；或发布时采集不到房源快照 |
| 其它 | — | 未注册校验 → 一律拒绝（`not_publishable`） |

### 与 `checkSpec` 的区别是刻意的

`checkSpec()`（草稿保存用）**明确允许**「还没有 html」：

> 还没生成过 HTML 是允许的（项目刚建好的状态），不算违规

那对**保存草稿**是对的 —— 刚建好项目就报错会很难用。
但**发布**是另一回事：公开页面必须真的有内容。所以这是两条不同的规则，
而不是把草稿门调严。

### 不因为可选字段为空而误拒

`listing` 的校验只看 `propertyId`。房源项目的 spec 里**本来就没有 `html` 字段**，
用自定义页面的规则去卡它会拒掉所有合法房源页 —— 有测试专门守着这一点。

---

## 四、场景 A–F 实测结果

全部在隔离临时环境通过真实 API 执行。

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| **A** 空对象 | 拒绝，不返回 URL，不改状态 | ✅ **422**；无 `publicUrl`；状态仍 `draft`；`publicSlug` 仍 `null`；未产生发布版本 |
| **B** 缺少必要内容 | 拒绝 + 可理解原因 | ✅ 缺 `html` / `html:''` / 纯空白 **三种都 422**；提示「这个页面还没有内容，无法发布。先用 AI 生成，或者自己写好页面内容再发布。」**不含**权限/套餐字样 |
| **C** 正常有效内容 | 发布成功，公开页与发布版本一致 | ✅ **200**；公开地址 200 且含发布版本标题与正文；详情接口地址与发布响应一致 |
| **D** 已发布项目的无效草稿 | 重新发布失败，旧版本原样保留 | ✅ **422**；旧地址仍 **200** 且内容不变；`status` 仍 `published`；`publicSlug`/`publicUrl` 不变；**反复失败不累积发布版本** |
| **E** 不同插件类型 | 校验与各插件结构匹配 | ✅ 见下 |
| **F** 错误语义 | 与失败原因一致 | ✅ 见下 |

### 场景 E 细节

- 当前注册并支持发布的插件**只有两个**：`listing`、`custom-page`（实测 `/api/platform/plugins`）——**没有未测试的插件**。
- `custom-page` 无 html → 422。
- `listing` 合法 → 200（`spec` 里没有 `html` 也不影响）。
- `listing` 房源被删除后重新发布 → **422**，提示含「房源」。
- **单元测试补充**了接口进不去的一条分支：`spec` 里没有 `propertyId` → 拒绝。
  （接口进不去的原因：`saveDraft` 会**保留结构性键**，保存部分字段不会把项目与房源解绑 ——
  这是正确行为，所以那条分支只能直接调用校验函数覆盖。）
- 另有测试断言**两个插件的规则确实不同**：同一份 `{propertyId}` 在 listing 视角合法、在 custom-page 视角不合法。

### 场景 F 细节

| 检查 | 结果 |
| --- | --- |
| 内容无效的 HTTP 状态 | **422**（不是 403，也不是 200） |
| 错误码 | **`UNPROCESSABLE`**（不是 `FORBIDDEN`） |
| 用户提示 | 只讲内容问题，**不含**「套餐 / 升级 / 额度 / Token / 权限」 |
| 对照：项目不存在 | 仍 **404 + `NOT_FOUND`**（未被本次改动破坏） |
| 对照：免费用户发布 | 仍 **403**（配额/权限路径未受影响） |

**失败发生在写任何东西之前**：不产生版本、不改状态、不动公开地址，因此场景 D 的旧版本保护是天然的。

---

## 五、测试命令与结果

| 命令 | 退出码 | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- | --- |
| `pnpm typecheck` | **0** | — | — | — | — |
| `pnpm test` | **0** | **451** | **451** | **0** | **0** |
| `pnpm smoke` | **0** | — | 74 / 74 | 0 | — |
| `pnpm verify` | **0** | — | 45 / 45 | 0 | — |

修复前 `pnpm test` 为 438，本次 **+13**（7 单元 + 6 场景）。
**未删除、跳过或弱化任何既有测试**。

**关键证明**：临时禁用发布校验（模拟修复前）后重跑，
**场景 A / B / D / E / F 全部失败**，报错正是「空内容不应发布成功，实际 200」。
恢复修复后 24/24 通过。

---

## 六、数据库与 Git 状态

| 项 | 说明 |
| --- | --- |
| 是否执行迁移 | **否**（本次无 schema 变更） |
| 真实库 SHA256 | `0c9ac8307c5dd2838ecb1f4d5aa4a9b8b8380006daa56c9c6fac325a034b9c4d` —— 修复前后**一致** |
| 既有业务数据 | 房源 3 / 展示页 3 / 照片 15 / 提醒 6 / 联系方式 5 / 译文 2 —— **未变** |
| 实测环境 | `os.tmpdir()` 下的临时服务与临时库；**未连接真实库** |
| HEAD | `435cd6d3e4ab57af383ccb60ce04687134076dca` —— **未变** |
| 暂存区 | **空** |
| 提交 / 推送 / 部署 | **均未执行** |
| 此前的未提交改动 | **全部保留**（含发布快照修复、导出 URL 修复及各阶段文档） |
| 本次新增文件 | `tests/platform/publish-guard.test.ts`、本报告 |
| 本次修改文件 | `src/platform/plugins/types.ts`、`custom-page-plugin.ts`、`listing-plugin.ts`、`registry.ts`、`src/platform/projects.ts`、`src/http/routes/platform.ts`、`tests/platform/hosting.test.ts` |

**注**：其中 `src/platform/projects.ts`、`src/http/routes/platform.ts`、`src/platform/plugins/*`、
`tests/platform/hosting.test.ts` 在修复前**已处于未提交状态**（属早前阶段的改动），
本次是在其上继续追加；未覆盖、未回滚任何既有改动。

---

## 七、尚未验证的边界

| 项 | 说明 |
| --- | --- |
| **房源快照的可渲染性** | `listing` 的校验保证「关联到房源 + 采到快照」；但**快照里的内容本身是否足以渲染出有意义的页面**（例如房源标题为空、无照片）**未校验也未验证** |
| **`custom-page` 的内容质量** | 只校验「有内容 + 通过安全门 + 通过内容质量门」。**页面好看不好看、是否答非所问，不在校验范围** —— 那属于 AI 生成质量，需单独验证 |
| **AI 生成能否产出可发布内容** | **未验证**。全部测试使用手工构造的、符合真实数据结构的有效内容。**真实模型产出质量仍需单独验证**（本次按要求未调用真实 AI） |
| **发布同时并发的边界** | 未测 |
| **`not_publishable` 之外的历史错误码** | 发布路由现在把「非 not_found / 非 not_publishable」的失败都映射为 403 `FORBIDDEN`；那些分支（如配额）语义是否正确，**不在本次范围** |
| **前端对 422 的处理** | 后端已正确返回 422 `UNPROCESSABLE` 与可读提示；**前端是否把它显示成恰当的界面提示未逐项验证** |