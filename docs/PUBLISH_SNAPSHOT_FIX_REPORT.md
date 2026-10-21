# 修复报告：房源插件发布快照隔离

**修复日期**：2026-10-13
**基准 HEAD**：`435cd6d3e4ab57af383ccb60ce04687134076dca`（未变）
**修复范围**：只处理「房源插件发布后改草稿直接影响线上公开页」这一个缺陷。

---

## 一、缺陷是什么

房源类项目的公开页**直接渲染当前 `properties` 记录**：

```ts
// 修复前 src/http/routes/public-sites.ts
const aggregate = aggregateFor(scoped, propertyId);   // ← 读“现在”的房源
renderListingPage({ aggregate, ... });
```

而 `saveDraft` 会把草稿 spec 同步写进 `properties`（`specSyncerFor('listing')`）。
两者叠在一起：**用户一改草稿，已经发布出去的公开页面当场就变了。**

修复前的实测证据（临时禁用快照分支后运行场景测试）：

```
✖ 场景B：改草稿不影响线上，草稿与发布版本确实分离
  AssertionError: 线上应仍是发布版本的标题
✖ 场景F：原有房源能力与数据未受快照改动影响
  AssertionError: 线上应仍是发布版本（快照未被草稿改动）
```

自定义页面（`custom-page`）**没有**这个问题 —— 它的公开路由一直读发布版本的 spec。本次是把同样的保证补给房源类插件。

---

## 二、改了什么

### 2.1 数据存储方式

**新增迁移 v6（纯追加）**：`src/db/migrations.ts`

```sql
ALTER TABLE project_versions ADD COLUMN snapshot_json TEXT;
```

- 可空列；老版本没有快照 → 读取返回 `null` → 调用方**回退到原有逻辑**，既有发布页不会打不开。
- 快照存在**发布版本**这一行上（`kind='published'`），与草稿版本天然分离。
- 草稿版本不写快照 —— 需要冻结的只有「已经对外公开的那一份」。

### 2.2 新增模块：`src/platform/publish-snapshot.ts`

| 导出 | 作用 |
| --- | --- |
| `captureListingSnapshot(ctx, workspaceId, propertyId)` | 在**发布时**冻结整套可渲染数据（房源 + 照片 + 联系方式 + 展示页设置 + 译文），并确定语言 |
| `serializeSnapshot(snapshot)` | 序列化入库 |
| `readPublishedSnapshot(db, publishedVersionId)` | 读取**最近一次成功发布**的快照；无/损坏 → `null`（回退，不 500） |

**为什么冻结「数据」而不是冻结「渲染好的 HTML」**：

渲染结果里含 CSP nonce，而 nonce 是**每次请求**生成的。把 HTML 冻在发布时会导致
nonce 与响应头不匹配，**页面上所有脚本被 CSP 拦掉**。所以冻结数据、渲染仍在请求时做。

### 2.3 发布流程：先冻结，再写版本

`src/platform/projects.ts` 的 `publishProject()`：

- `appendVersion()` 增加可选 `snapshotJson` 参数；
- 房源类项目在写版本**之前**采集快照；**采不到就拒绝发布**（`not_publishable`），
  而不是先写一个「已发布」的版本、页面却渲染不出东西；
- 采集时用项目自己的 `workspaceId` 作用域（平台用户各自有工作区）。

### 2.4 读取路径：公开页从快照渲染

`src/http/routes/public-sites.ts`：

1. **优先**：读到快照 → 用 `snapshot.aggregate` 与 `snapshot.locale` 渲染；
2. **回退**：没有快照（本修复之前发布的旧版本）→ 沿用原有实时读取逻辑。

顺带消除了一处副作用：快照分支**不再调用 `ensureListingPage`**，
因此公开页 GET 不再写库（旧版本回退路径仍保留该调用，因为它可能确实还没有展示页记录）。

### 2.5 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `src/db/migrations.ts` | +迁移 v6 |
| `src/platform/publish-snapshot.ts` | **新增**（111 行） |
| `src/platform/projects.ts` | `appendVersion` 支持快照；`publishProject` 发布前冻结 |
| `src/http/routes/public-sites.ts` | 公开页优先从快照渲染 |
| `tests/platform/hosting.test.ts` | +6 个场景测试（A–F） |

---

## 三、验证结果

### 3.1 迁移安全性（先在隔离克隆库上验证）

```
应用迁移: v6      跳过: 1,2,3,4,5
行数变化表数: 0   内容变化表数: 0   ✅ 零丢失零改动
project_versions 列: id,project_id,version_no,kind,spec_json,created_by,created_at
              新增: snapshot_json
外键违规: 0   integrity: ok
```

对 12 张表逐一比对**行数**与**全表内容长度**，迁移前后完全一致。**真实数据库未执行迁移。**

### 3.2 场景实测（全部在隔离临时环境）

| 场景 | 内容 | 结果 |
| --- | --- | --- |
| **A** 首次发布 | 发布后公开地址显示发布版本的标题与价格 | ✅ |
| **B** 改草稿 | 改标题+价格后保存：线上仍是旧标题、旧价格，**且草稿接口能看到修改后的内容**（证明两者确实分离） | ✅ |
| **C** 重新发布 | 同一地址切换到新版本（沿用同一 slug），旧内容不残留 | ✅ |
| **D** 重新发布失败 | 把项目指向不存在的房源后发布 → 返回错误；**旧版本仍 200 且内容完好**；项目状态仍 `published`、`publicUrl` 不变 | ✅ |
| **E** 未发布项目 | 保存草稿后状态仍 `draft`、无 `publicSlug`、无 `publicUrl`；猜测短链访问 `/s/*` 全部 404 | ✅ |
| **F** 原有功能回归 | 草稿仍同步进 `properties`（原有行为不变）；照片可上传且出现在公开页；改草稿后线上照片不丢；`?lang=en` 仍可用 | ✅ |

**关键证明**：把快照分支临时禁用（= 修复前行为）后重跑，**场景 B 与 F 立即失败**，
报错正是「线上应仍是发布版本的标题」。**这证明测试确实抓住了原缺陷，且修复确实生效。**

### 3.3 测试命令与结果

| 命令 | 退出码 | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- | --- |
| `pnpm typecheck` | **0** | — | — | — | — |
| `pnpm test` | **0** | **424** | **424** | **0** | **0** |
| `pnpm smoke` | **0** | — | 74 / 74 | 0 | — |
| `pnpm verify` | **0** | — | 45 / 45 | 0 | — |

修复前 `pnpm test` 为 418，本次 **+6**（场景 A–F）。

---

## 四、对真实数据库与既有数据的影响

| 项 | 说明 |
| --- | --- |
| 迁移是否已在真实库执行 | **否。** 只在 `os.tmpdir()` 的克隆库上验证 |
| 真实库 SHA256 | `0c9ac8307c5dd2838ecb1f4d5aa4a9b8b8380006daa56c9c6fac325a034b9c4d` —— 修复前后**一致** |
| 既有业务数据 | 房源 3 / 展示页 3 / 照片 15 / 提醒 6 / 联系方式 5 / 译文 2 —— **未变** |
| 既有发布页 | 迁移是纯追加；老版本无快照 → 回退到原有渲染逻辑 → **不会打不开** |
| 真实库中的发布版本 | 当前 `kind='published'` 行数为 0（平台上尚无已发布项目），因此迁移对其无影响 |

**部署时需要知道**：`pnpm start` 会自动执行迁移（既有行为）。v6 是纯追加、可空列，
不改任何既有行 —— 但仍建议按惯例先在库副本上验证。

---

## 五、Git 状态

| 项 | 状态 |
| --- | --- |
| HEAD | `435cd6d3e4ab57af383ccb60ce04687134076dca` —— **未变** |
| 暂存区 | **空** |
| 提交 / 推送 / 部署 | **均未执行** |
| 修复前已有的 14 个未提交改动 | **全部保留**（未覆盖、未回滚、未清理） |
| 本次新增改动 | `src/db/migrations.ts`、`src/platform/projects.ts`、`src/http/routes/public-sites.ts`、`tests/platform/hosting.test.ts` 的**增量追加**，以及新增文件 `src/platform/publish-snapshot.ts` |
| 本次新增文档 | 本文件 |

---

## 六、未验证 / 已知边界

| 项 | 说明 |
| --- | --- |
| **真实数据库上的迁移** | 未执行（按保护要求）。只在克隆库上验证零丢失 |
| **照片被删除后旧快照的引用** | 快照冻结的是照片**元数据**（storage key），不是文件副本。若用户在**不重新发布**的情况下删除照片，旧快照仍引用该 key，图片会 404。本次未构造该场景，**标记为未验证** |
| **旧版本（无快照）与新版本混用** | 回退路径有代码与测试覆盖（既有 10 个托管测试全部通过），但**未构造「先发旧版、再改代码、再访问」的跨版本实测** |
| **非 listing / 非 custom-page 的插件** | 不存在这类插件；`publishProject` 对它们不采集快照，走原有逻辑 |
| **并发发布** | 未测 |