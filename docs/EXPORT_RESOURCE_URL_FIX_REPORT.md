# 修复报告：独立页面导出 ZIP 的资源 URL

**修复日期**：2026-10-13
**基准 HEAD**：`435cd6d3e4ab57af383ccb60ce04687134076dca`（未变）
**修复范围**：只处理导出资源 URL 被盲替换成畸形地址这一个缺陷。

---

## 一、根因

`src/services/export-service.ts` 原先用一行做资源路径改写：

```ts
html.replaceAll('/media/', 'assets/')
```

`replaceAll` **不认 URL 边界**：

| 输入 | 输出 | 判定 |
| --- | --- | --- |
| `<img src="/media/prp_a/a.png">` | `assets/prp_a/a.png` | ✅ 正确 |
| `<meta property="og:image" content="http://host:3210/media/prp_a/a.png">` | `http://host:3210assets/prp_a/a.png` | ❌ **缺斜杠，任何环境都解析不了** |

**为什么会有绝对 URL**：`src/render/page-renderer.ts:750-760` 的 `renderOgImage()`：

```ts
const base = input.publicUrl.replace(/\/p\/.*$/, '');   // → http://host:3210
const url = safeUrl(`${base}${mediaUrl(cover.storageKey)}`);   // → http://host:3210/media/...
```

`mediaUrl()` 产出的是**站内相对路径** `/media/<key>`（`page-renderer.ts:86-88`），
og:image 把它拼上基址变成了**完整 URL** —— 于是撞上了盲替换。

**修复前的实测证据**（临时恢复旧逻辑后运行测试）：

```
✖ 场景E：真实导出 ZIP 解压后，本地资源引用与包内文件一致，且无畸形 URL
  AssertionError: 不得出现 host:portassets 这种缺斜杠的地址
✖ 场景E2：导出目录形式同样得到正确的资源引用
  AssertionError: 目录导出同样不得出现畸形 URL
```

---

## 二、修复前后 URL 的实际差异

来自真实导出 ZIP 的解压检查（同一份页面）：

| 位置 | 修复前 | 修复后 |
| --- | --- | --- |
| `og:image` | `http://127.0.0.1:5279assets/prp_…/mv6sz9q6-….png` ❌ | `assets/prp_…/mv6sz9q6-….png` ✅ |
| `<img src>` | `assets/prp_…/mv6sz9q6-….png` ✅ | `assets/prp_…/mv6sz9q6-….png` ✅（不变） |

修复后**目标文件真实存在于 ZIP 中**：

```
index.html  (27390 字节)
README.txt  (955 字节)
share-url.txt  (88 字节)
assets/prp_012cf6b3-30e3-4a08-a1bd-b308255e1544/mv6sz9q6-rv67kars.png  (120 字节)
```

---

## 三、改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `src/services/export-url.ts` | **新增**：URL 感知的引用改写（约 150 行） |
| `src/services/export-service.ts` | 先读媒体确定「真的会进包的 key」；用改写函数替换盲替换；未打包的引用写入 notes |
| `tests/services/export-url.test.ts` | **新增** 12 个单元测试（场景 A/B/C/D 的字符串层） |
| `tests/platform/hosting.test.ts` | **新增** 2 个集成测试（场景 E：真实 ZIP 解压验证） |

### 改写的判定规则

按 URL 边界识别四类引用：

| 形式 | 处理 |
| --- | --- |
| `http(s)://<本站 origin>/media/<key>` | → `assets/<key>`（去掉 origin，变相对路径） |
| `//<本站 origin>/media/<key>` | → `assets/<key>` |
| `/media/<key>` | → `assets/<key>` |
| 指向**其它站点**的绝对/协议相对 URL | **原样保留**（那不是导出包里的资源，改写只会指向不存在的文件） |
| `data:` 等其它形式 | 原样保留 |

**查询串与片段原样保留**：`/media/a.png?v=2#frag` → `assets/a.png?v=2#frag`。

**未打包的资源不猜**（要求 4）：只有**确实已进入导出包**的 key 才会被改写
（`exportedKeys` 由「真的读到了文件」的媒体集合构建）。引用了一个没被打包的 key 时：
**保持原样并写进导出包的 `README.txt` 提示**，而不是生成一个
「看起来有效、实际加载不到」的 `assets/<key>`。

---

## 四、各场景实测结果

| 场景 | 内容 | 结果 |
| --- | --- | --- |
| **A** 完整 URL | 断言不得出现 `host:portassets`；直接对比旧逻辑的产物确认旧缺陷形状真实存在；应改写为相对路径 | ✅ |
| **B** 站内 `/media/` | 改写为 `assets/`，且改写后的文件确实在 ZIP 中（集成测试用 `readZip` 解压核对） | ✅ |
| **C** 相对路径与多种资源 | 查询串/片段保留；URL 编码的空格保持可解析；不相干文本（含「/media/ 这个词」）、`/p/` 链接、`data:` 图片**均未被误改** | ✅ |
| **D** 外部资源 | 外部站点的绝对 URL 与协议相对 URL **原样保留**，不被改写成包内路径；本站协议相对 URL 正常改写 | ✅ |
| **E** 真实 ZIP 解压 | 见下节 | ✅ |
| **F** 回归 | 见第六节 | ✅ |

**安全边界**：测试只使用 `cdn.example.com` 这类示例域名，**未访问任何内网地址、
云元数据地址或其它敏感目标**。

---

## 五、真实 ZIP 解压与浏览器验证

### 5.1 解压核对（场景 E）

用 `readZip()` 解开真实导出的 ZIP（29083 字节）后逐项检查：

| 检查 | 结果 |
| --- | --- |
| ZIP 含 `index.html` | ✅ |
| ZIP 含 `assets/` 下的资源 | ✅ 1 个（照片） |
| **HTML 引用的每个本地资源都真实存在** | ✅ `assets/prp_…/mv6sz9q6-….png` 与条目完全一致 |
| 无畸形 URL（`:\d+assets/`） | ✅ 未出现 |
| 无本站 `/media/` 残留 | ✅ |
| 无 `/api/` 私有接口依赖 | ✅ |
| 无凭证/服务器信息（`ADMIN_PASSWORD`、`SESSION_SECRET`、`AI_API_KEY`、`app.sqlite`、实际口令） | ✅ 均未出现 |
| 内容确实来自该项目 | ✅ 含房源标题与图片 |

### 5.2 浏览器实际打开验证

把解压目录用一个极小的本地静态服务器托管（模拟用户自部署），用真实浏览器打开：

```
页面标题        浏览器验证房源
图片数量        1
图片 src        assets/prp_012cf6b3-…/mv6sz9q6-rv67kars.png
图片 resolved   http://127.0.0.1:5777/assets/prp_…/mv6sz9q6-rv67kars.png
图片 complete   true
图片 naturalWidth 32  ← 真实加载成功
og:image        assets/prp_012cf6b3-…/mv6sz9q6-rv67kars.png
含畸形 URL      false
含 /api/ 依赖   false
控制台错误       0
控制台警告       0
页面内容        标题、出租中、¥6,800、上海 浦东新区、卧室2、卫生间1、联系方式 均正常渲染
```

**注意**：浏览器工具**禁止 `file://` 协议**，因此改用本地静态服务器托管解压目录。
这与「用户把导出包放到任意静态托管上」是同一个场景；**纯 `file://` 直接双击打开未验证**。

### 5.3 仍存在的平台引用（非资源依赖，属另一问题）

导出 HTML 里还有两个**链接**（不是资源加载依赖）：

- `http://127.0.0.1:5279/p/<房源短链>` —— README/页面里的「分享链接」，指向原平台的公开页
- `https://zhirai.cloud` —— 品牌外链

`http://www.w3.org/2000/svg` 是 SVG 命名空间，不产生网络请求。

这些**不影响离线运行**（页面无登录态依赖、无私有 API 调用），
但「导出页回链原平台」是**另一个已记录的问题**，按本次范围要求**未处理**。

---

## 六、测试命令与结果

| 命令 | 退出码 | tests | pass | fail | skipped |
| --- | --- | --- | --- | --- | --- |
| `pnpm typecheck` | **0** | — | — | — | — |
| `pnpm test` | **0** | **438** | **438** | **0** | **0** |
| 导出相关回归（4 个文件） | **0** | 34 | 34 | 0 | 0 |
| `tests/services/export-url.test.ts`（新增） | **0** | 12 | 12 | 0 | 0 |
| `tests/platform/hosting.test.ts`（含 2 个新增集成测试） | **0** | 18 | 18 | 0 | 0 |

修复前 `pnpm test` 为 424，本次 **+14**。既有导出测试（`tests/integration/export.test.ts`、
`tests/services/export-service.test.ts`、`tests/util/zip.test.ts`）**全部保留、全部通过**，
未删除或弱化任何既有断言。

**关键证明**：把盲替换临时恢复后重跑，**场景 E 与 E2 立即失败**，
报错正是「不得出现 host:portassets 这种缺斜杠的地址」。

---

## 七、对真实数据库的影响

| 项 | 说明 |
| --- | --- |
| 是否执行迁移 | **否**（本次不涉及 schema 变更） |
| 真实库 SHA256 | `0c9ac8307c5dd2838ecb1f4d5aa4a9b8b8380006daa56c9c6fac325a034b9c4d` —— 修复前后**一致** |
| 既有业务数据 | 房源 3 / 展示页 3 / 照片 15 / 提醒 6 / 联系方式 5 / 译文 2 —— **未变** |
| 所有实测环境 | `os.tmpdir()` 下的临时服务与临时库；**未连接真实库** |
| 临时资源 | 静态服务器已停止、解压目录已删除（27.9 KB）、临时环境 0 残留 |

---

## 八、Git 状态

| 项 | 状态 |
| --- | --- |
| HEAD | `435cd6d3e4ab57af383ccb60ce04687134076dca` —— **未变** |
| 暂存区 | **空** |
| 提交 / 推送 / 部署 | **均未执行** |
| 修复前已有的 14 个已跟踪改动 | **全部保留**（未覆盖、未回滚、未清理） |
| 本次**新增**文件 | `src/services/export-url.ts`、`tests/services/export-url.test.ts`、本报告 |
| 本次**修改**文件 | `src/services/export-service.ts`（此前是干净的跟踪文件，本次为修复所改）、`tests/platform/hosting.test.ts`（追加 2 个集成测试） |
| 逐项比对结果 | 此前的 14 个已跟踪改动**集合完全一致**；唯一新增的改动项是 `src/services/export-service.ts`（预期之内） |

---

## 九、尚未验证的场景

| 项 | 说明 |
| --- | --- |
| **纯 `file://` 双击打开** | 浏览器工具禁止 `file://`，改用本地静态服务器验证。**目录形式的导出（`exportListingToDirectory`）未在 `file://` 下实测** |
| **视频资源** | 媒体循环对 `kind` 不区分，视频应同样进入 `assets/`；但本次**未构造含视频的项目实测** |
| **CSS 中的 `url(/media/…)`** | 改写是基于全文的 URL token 匹配，理论上覆盖 CSS；但当前渲染器的内联样式**没有**产出 `/media/` 引用，因此**未做真实 CSS 背景图实测** |
| **外部资源下载到包内** | 当前设计**不下载**外部资源，只在 HTML 中保留链接。外部资源离线不可用属设计取舍，已在 `README.txt` 说明 |
| **`externalUrl`（外链图片）** | 房源照片支持外链 URL；这类 URL 不属于本站 origin，会被**原样保留**。未构造实测 |
| **多语言导出的多个 HTML** | 改写对每个语言文件分别执行（同一逻辑），但**未逐语言核对**改写结果 |