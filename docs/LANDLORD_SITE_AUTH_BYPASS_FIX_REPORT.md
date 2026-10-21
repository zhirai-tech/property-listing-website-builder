# 后台 API 认证绕过：修复与验证报告

**修复日期**：2026-10-13
**范围**：仅修复 `docs/LANDLORD_SITE_CURRENT_STATE_AND_GAP_REPORT.md` 记录的后台 API 认证绕过（P0）
**未执行**：计划 A、冒烟断言修复、联系方式反爬、备份/导出路径限制（按用户要求，等待确认后再进入下一阶段）

---

## 一、漏洞根因及证据

### 1.1 根因

**守卫与路由用了两个不同的「路径来源」。**

原实现（`src/http/app.ts:91-111`，修复前）：

```ts
app.addHook('onRequest', async (request, reply) => {
  request.cspNonce = createNonce();
  const path = request.url.split('?')[0] ?? '';          // ← 原始 URL，未解码
  if (path.startsWith('/api/admin/') && !PUBLIC_ADMIN_PATHS.has(path)) {
    // ... 401 ...
  }
});
```

问题出在 **`onRequest` 的执行时机**：它跑在**路由匹配之前**。
那一刻框架还不知道「这条请求最终会命中哪条路由」，所以守卫只能拿 `request.url` 猜前缀。
而 Fastify 的路由器（find-my-way）用的是**解码后**的路径。

两者口径不一致：

| 阶段 | 看到的路径 | 判断 |
| --- | --- | --- |
| `onRequest` 守卫 | `/%61pi/admin/overview` | **不以 `/api/admin/` 开头 → 跳过鉴权** |
| 路由器匹配 | `/api/admin/overview` | **命中后台路由 → 执行 handler** |

结果：**鉴权被完全跳过**。

### 1.2 实测证据（修复前，真实运行服务）

用探针脚本对 `127.0.0.1:3210` 发出请求，**全程不带任何 Cookie**：

| 请求 | 状态码 | 说明 |
| --- | --- | --- |
| `GET /api/admin/overview` | **401** | 基线：守卫认识这个路径 |
| `GET /%61pi/admin/overview` | **200** | ❌ 绕过，返回工作区数据 |
| `GET /ap%69/admin/overview` | **200** | ❌ 绕过 |
| `GET /%61%70%69/admin/overview` | **200** | ❌ 绕过 |
| `GET /api/%61dmin/overview` | **200** | ❌ 绕过 |
| `GET /%61pi/%61dmin/overview` | **200** | ❌ 绕过 |
| `GET /%61pi/admin/properties/<id>` | **200** | ❌ 绕过，**含 `is_public=0` 的私有联系方式** |
| `POST /%61pi/admin/properties/validate` | **200** | ❌ **写端点同样绕过** |
| `GET /%61pi/admin/settings` | **200** | ❌ 绕过（对照 `/api/admin/settings` = 401） |
| `GET /%61pi/admin/backups` | **200** | ❌ 绕过（对照 `/api/admin/backups` = 401） |

### 1.3 这不是「某几个 URL」的问题

回归测试对 `api` / `admin` 的**每一个字母位置**逐个生成编码变体，修复前的失败清单是：

```
GET /%61pi/admin/overview        （第 1 位 a→%61）→ 200
GET /a%70i/admin/overview        （第 2 位 p→%70）→ 200
GET /ap%69/admin/overview        （第 3 位 i→%69）→ 200
GET /api/%61dmin/overview        （第 5 位 a→%61）→ 200
GET /api/a%64min/overview        （第 6 位 d→%64）→ 200
GET /api/ad%6din/overview        （第 7 位 m→%6d）→ 200
GET /api/adm%69n/overview        （第 8 位 i→%69）→ 200
GET /api/admi%6e/overview        （第 9 位 n→%6e）→ 200
...（每个受测端点 × 每个字母位置，全部 200）
```

**任意一个字母的百分号编码都能成为入口** —— 所以修复必须消除「两个路径来源」这件事本身，
而不是给那几个 URL 打补丁。

### 1.4 为什么 272 个测试没抓到

`tests/integration/*.ts` 全部使用**字面量** `/api/admin/...` 路径，**从未覆盖编码形态**。
测试只验证了「守卫拦得住它认识的路径」，没有验证「守卫是否认识所有能到达路由的路径形态」。

---

## 二、修复方案及选择理由

### 2.1 方案对比

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A. 只对 `%61pi` 写特例 | 匹配已知绕过串 | ❌ 明确排除。字母位置有 8 个、编码形式无穷，打不完 |
| B. 在 `onRequest` 里自行解码后判断 | `decodeURIComponent(request.url)` 再比前缀 | ⚠️ 部分有效，但仍是**自己实现一套路径解析**，与框架的解析规则未必一致（双重编码、异常序列、`+` 处理等），埋下第二处口径差异 |
| **C. 用路由器自己的判断结果（采用）** | 把权威判断移到 `preHandler`，读 `request.routeOptions.url` | ✅ 守卫与路由**共用同一个事实来源**，从根上消除差异 |

### 2.2 为什么选 C

`preHandler` 在**路由匹配之后**执行，此时 `request.routeOptions.url` 就是
**路由器实际匹配到的那条路由模式**（如 `/api/admin/properties/:id`）。

实测验证（独立 Fastify 实例）：

| 请求 URL | `onRequest` 的 `request.url` | `preHandler` 的 `routeOptions.url` |
| --- | --- | --- |
| `/api/admin/overview` | `/api/admin/overview` | `/api/admin/overview` |
| **`/%61pi/admin/overview`** | **`/%61pi/admin/overview`** ← 守卫漏掉 | **`/api/admin/overview`** ← 路由器已解码 |
| `/ap%69/admin/overview` | `/ap%69/admin/overview` | **`/api/admin/overview`** |
| `/p/abc` | `/p/abc` | `/p/:slug`（不匹配 admin 前缀，不拦） |
| `/no-such-route` | `/no-such-route` | **`preHandler` 不执行**（404 由 notFoundHandler 处理） |

**这个方案的性质**：守卫的判断条件不再是「路径长什么样」，
而是「**路由器把这条请求交给了哪条路由**」。二者永远一致，因为读的就是同一个值。

**顺带保证的三件事**：
1. 任何**新增**的 `/api/admin/*` 路由自动受保护，不需要记得加守卫
2. **任意 HTTP 方法**（GET/POST/PUT/PATCH/DELETE）一视同仁
3. 编码、大小写、点段、重复斜杠等所有路径变体都不再有区别 —— 因为它们都已经被路由器归一化了

### 2.3 保留了一层早拒（但非权威）

移动到 `preHandler` 会把鉴权推迟到路由匹配与请求体解析之后。
为了不让未授权请求白白触发 2MB 请求体解析，`onRequest` 里保留了一层**尽力解码后的早拒**：

```ts
const decoded = decodePathBestEffort((request.url.split('?')[0] ?? ''));
if (decoded !== null && isProtectedAdminRoute(decoded) && !hasValidSession(request)) {
  return rejectUnauthorized(reply);
}
```

**明确说明它的定位**：
- 它**只是提前拒绝**，不是安全边界。`onRequest` 的 `request.url` 是原始未解码串，
  双重编码（`%2561pi`）等形态它认不出来 —— 这些由 `preHandler` 兜住。
- 解码失败时**不做判断**（返回 `null` 跳过），交给 `preHandler`，**绝不在这里放行**。
- 两层共用同一个谓词函数 `isProtectedAdminRoute()`，从代码结构上防止两处判断漂移。

这一层是「纵深 + 性能」，安全性完全由 `preHandler` 那一层保证。

---

## 三、修改文件和关键代码位置

### 3.1 改动清单

| 文件 | 类型 | 改动 |
| --- | --- | --- |
| `src/http/app.ts` | 修改 | +83 / −19 行，重构鉴权守卫 |
| `tests/integration/security.test.ts` | 修改 | +178 行，新增 5 个回归测试 |

**仅此两个受版本控制的文件。** 未触碰数据库、迁移、配置、前端、其它服务模块。

### 3.2 关键代码位置（`src/http/app.ts`）

| 位置 | 内容 |
| --- | --- |
| `:10` | 补充 `FastifyReply` / `FastifyRequest` 类型导入 |
| `:90-103` | `isProtectedAdminRoute()` —— 唯一的鉴权谓词，两层共用 |
| `:106-113` | `decodePathBestEffort()` —— 解码失败返回 `null`，不放行 |
| `:115-120` | `rejectUnauthorized()` —— 统一的 401 响应 |
| `:122-129` | `hasValidSession()` —— 会话校验（有效期用真实时间，保留原有注释说明） |
| `:131-142` | `onRequest` —— 只做 nonce + 早拒 |
| `:144-153` | **`preHandler` —— 权威鉴权判断** |

### 3.3 新增的回归测试（`tests/integration/security.test.ts`）

| 测试 | 作用 |
| --- | --- |
| `encodedPathVariants()` 辅助函数 | **程序化**生成每一位的编码变体，而不是硬编码那几个 URL |
| `后台接口：未登录时路径编码变体不能绕过鉴权` | 核心回归：6 个端点（读/写/删）× 每个端点的全部变体，断言只能是 401 或 404 |
| `后台接口：未登录时不得产生任何业务副作用` | 断言未授权请求不改变 `listing_pages` 行数 |
| `后台接口：已登录的合法请求仍然可用（修复不得误伤）` | 防止「一律拦截」式的假修复 |
| `后台接口：已登录时编码路径同样可用` | 编码不应让**合法**请求被误判 |
| `鉴权改动不影响登录接口、会话接口与公开页面` | 登录页、`/healthz`、公开房源页的回归 |

> 测试全部使用 `createTestApp()` 的**内存数据库**（`tests/helpers/test-app.ts:44`），
> **不触碰真实业务数据**。

---

## 四、测试环境说明

| 项 | 值 |
| --- | --- |
| 运行环境 | Windows，Node **v24.14.0** |
| 框架 | Fastify **5.12.5** |
| 数据库 | `node:sqlite`（SQLite 3.51.2） |
| 单元/集成测试库 | **内存库**（`tests/helpers/test-app.ts` 用临时目录 + 内存库） |
| 真实 HTTP 验证 | `127.0.0.1:3210`，服务由 `node src/server.ts` 启动 |
| 真实 HTTP 用的库 | `var/db/app.sqlite`（演示数据：3 房源 / 15 照片 / 6 提醒） |
| 浏览器 | Playwright MCP，同一 `127.0.0.1:3210` |

**数据安全措施**：
- 验证脚本**只输出状态码与响应长度，从不打印响应体** —— 避免把真实联系方式写进日志
- 回归测试跑在内存库，与真实数据完全隔离
- 真实 HTTP 验证只发 GET/POST 到**只读或校验类**端点（`/overview`、`/properties`、`/settings`、`/backups`、`/audit`、`/pages`、`/reminders`、`/meta`、`properties/validate`）
- **未对真实数据执行任何写操作**（未新建、未修改、未删除任何业务记录）

---

## 五、未登录请求的验证结果 —— **已实现并验证**

### 5.1 对真实运行服务的批量验证

对 **11 个后台端点**（覆盖读、写、删）× 每个端点的**全部编码变体**发出未登录请求：

```
【未登录】后台接口 × 全部编码变体
------------------------------------------------------------------
拦截 401: 230   无路由 404: 0   未拦截(泄漏): 0
合计 230 个未登录请求
```

**全部 230 个未登录请求返回 401，零泄漏。**

覆盖的端点：

| 方法 | 端点 |
| --- | --- |
| GET | `/api/admin/overview`、`/properties`、`/settings`、`/backups`、`/audit`、`/diagnostics`、`/pages`、`/reminders`、`/meta` |
| POST | `/api/admin/properties/validate` |
| DELETE | `/api/admin/properties/prp_nonexistent` |

每个端点都测了：原文 + 每个字母位置的编码 + `api` 整段编码 + `admin` 整段编码。

### 5.2 修复前 vs 修复后

| 请求（无 Cookie） | 修复前 | 修复后 |
| --- | --- | --- |
| `GET /api/admin/overview` | 401 | **401** ✅ |
| `GET /%61pi/admin/overview` | **200** ❌ | **401** ✅ |
| `GET /ap%69/admin/overview` | **200** ❌ | **401** ✅ |
| `GET /%61%70%69/admin/overview` | **200** ❌ | **401** ✅ |
| `GET /api/%61dmin/overview` | **200** ❌ | **401** ✅ |
| `POST /%61pi/admin/properties/validate` | **200** ❌ | **401** ✅ |

### 5.3 浏览器实测（未登录态）

```
✔ 已清空会话（session.authenticated=false）
✔ 未登录 /api/admin/overview 被拦                       HTTP 401
✔ 未登录 /%61pi/admin/overview 被拦                     HTTP 401
✔ 未登录 POST 编码写接口被拦                            HTTP 401
```

---

## 六、已登录请求的验证结果 —— **已实现并验证**

| 检查项 | 状态码 | 结论 |
| --- | --- | --- |
| 登录接口（正确口令，匿名可达） | 200 | ✅ |
| 登录接口（错误口令） | 401 | ✅ 凭据错误语义不变 |
| 会话探测接口（匿名可达） | 200 | ✅ |
| 后台登录页 `/admin/`（匿名可达） | 200 | ✅ |
| 已登录 `GET /api/admin/overview` | 200 | ✅ |
| 已登录 `GET /%61pi/admin/overview`（编码） | 200 | ✅ 编码不误伤合法请求 |
| 已登录 `GET /api/admin/properties` | 200 | ✅ |
| 已登录 `GET /%61pi/admin/settings`（编码） | 200 | ✅ |
| 已登录 `GET /api/a%64min/settings`（编码） | 200 | ✅ |
| 已登录 `GET /ap%69/admin/settings`（编码） | 200 | ✅ |
| 已登录 `GET /api/%61%64%6d%69%6e/settings`（整段编码） | 200 | ✅ |
| 已登录 `POST /api/admin/properties/validate` | 200 | ✅ 写接口正常 |
| 健康检查 `/healthz`（匿名） | 200 | ✅ |

### 浏览器真实 UI 流程

```
✔ 登录页显示、主界面隐藏               login hidden=false  app hidden=true
✔ 通过登录表单成功登录                 app hidden=false
✔ 后台主界面已渲染内容                 7064 字符
✔ 已登录后台 API 可用                  HTTP 200
✔ 已登录编码路径同样可用               HTTP 200
✔ 找到登出按钮                         logout-side
✔ 登出后回到登录页                     login hidden=false  app hidden=true
✔ 登出后 /api/admin/overview 被拦      HTTP 401
✔ 登出后编码路径同样被拦               HTTP 401
✔ 公开端点 /healthz 仍可匿名访问       HTTP 200
```

**登录表单 → 后台渲染 → 登出 → 会话失效** 全链路通过。
---

## 七、编码路径及其他变体的验证结果 —— **已实现并验证**

### 7.1 全部变体实测（修复后，未登录）

| 变体 | 路径形态 | 修复前 | 修复后 | 说明 |
| --- | --- | --- | --- | --- |
| 基线 | `/api/admin/overview` | 401 | **401** ✅ | |
| 单字母编码 | `/%61pi/admin/overview` | **200** | **401** ✅ | 已修复 |
| 单字母编码 | `/ap%69/admin/overview` | **200** | **401** ✅ | 已修复 |
| 整段编码 | `/%61%70%69/admin/overview` | **200** | **401** ✅ | 已修复 |
| 单字母编码 | `/api/%61dmin/overview` | **200** | **401** ✅ | 已修复 |
| 两段编码 | `/%61pi/%61dmin/overview` | **200** | **401** ✅ | 已修复 |
| 大写 | `/%41pi/admin/overview` | 404 | **401** ✅ | 无此路由 |
| 双重编码 | `/%2561pi/admin/overview` | 404 | **401** ✅ | 解码一次得 `%61pi`，无此路由 |
| 点段 | `/./api/admin/overview` | 401 | **401** ✅ | Node HTTP 层已归一化 |
| 点段 | `/x/../api/admin/overview` | 401 | **401** ✅ | 同上 |
| 重复斜杠 | `//api/admin/overview` | 404 | **401** ✅ | 无此路由 |
| 尾部斜杠 | `/api/admin/overview/` | 401 | **401** ✅ | |
| 编码斜杠 | `/%2Fapi%2Fadmin%2Foverview` | 404 | **401** ✅ | 无此路由 |
| query 混淆 | `/api/admin/overview?x=/api/admin/` | 401 | **401** ✅ | |
| 大小写混合 | `/API/ADMIN/overview` | 404 | **401** ✅ | 无此路由 |

**说明**：修复后，这些路径统一返回 **401**（而非 404）。
原因是早拒层对**解码后**的路径做前缀判断，即使路由不存在也先返回 401。
这比 404 更安全 —— **不泄露某条后台路由是否存在**，也让路由枚举更困难。

### 7.2 变体覆盖方式

测试不是硬编码那几个已知 URL，而是**程序化生成**：

```ts
function encodedPathVariants(path: string): { label: string; url: string }[] {
  const out = [{ label: '原文', url: path }];
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i] as string;
    if (!/[a-zA-Z]/.test(ch)) continue;
    const enc = `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
    out.push({ label: `第 ${i} 位 ${ch}→${enc}`, url: path.slice(0, i) + enc + path.slice(i + 1) });
  }
  out.push({ label: 'api 整段编码', url: path.replace('/api/', '/%61%70%69/') });
  out.push({ label: 'admin 整段编码', url: path.replace('/admin/', '/%61%64%6d%69%6e/') });
  return out;
}
```

这样将来若有人把守卫改回基于路径字符串的判断，测试会**立刻**变红。

---

## 八、公开页面和其他功能的回归结果 —— **已实现并验证**

### 8.1 公开功能

| 检查项 | 结果 |
| --- | --- |
| `GET /p/<slug>` 公开房源页（匿名） | **200** ✅ |
| `GET /p/<slug>/qr.svg` 二维码（匿名） | **200** ✅ |
| `GET /healthz` 健康检查（匿名） | **200** ✅ |
| `GET /admin/` 后台登录页（匿名） | **200** ✅ |
| `POST /api/admin/login` 登录接口（匿名） | **200** ✅ |
| `GET /api/admin/session` 会话探测（匿名） | **200** ✅ |

### 8.2 全量测试套件

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 测试总数 | 272 | **277**（+5 个新回归测试） |
| 通过 | 272 | **277** |
| 失败 | 0 | **0** |
| 跳过 | 0 | **0** |

**没有任何原有测试被删除、修改断言或跳过。**

### 8.3 类型检查

```
node node_modules/typescript/bin/tsc --noEmit
→ 退出码 0
```

---

## 九、测试命令、实际结果和失败项

### 9.1 执行的命令与结果

| 命令 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | **退出码 0**，无输出 |
| `node --disable-warning=ExperimentalWarning --test tests/integration/security.test.ts` | **21 / pass 21 / fail 0** |
| `node --disable-warning=ExperimentalWarning --test "tests/**/*.test.ts"` | **277 / pass 277 / fail 0 / skipped 0**，耗时 2813 ms |
| 真实 HTTP 未登录批量验证（230 请求） | **401 × 230，泄漏 0** |
| 真实 HTTP 已登录验证（14 项） | **全部符合预期** |
| 浏览器真实 UI 流程（10 步） | **全部通过** |

### 9.2 失败项

**本次修复过程中出现过 2 个失败，均已定位并说明，均不是产品缺陷：**

| # | 现象 | 定位 | 处理 |
| --- | --- | --- | --- |
| 1 | 我最初写的回归测试里，`鉴权改动不影响登录接口…` 断言「登录接口不应返回 401」而失败 | **我的断言写错了**：登录接口对**错误口令**本来就合法地返回 401（`admin-auth.ts:48`），无法用状态码区分「被守卫拦下」与「口令不对」 | 改用**正确口令能否匿名登录成功**来证明（`assert.equal(login.statusCode, 200)`） |
| 2 | 真实 HTTP 验证中「已登录 GET `/api/admin/a%64min/settings`」返回 404 | **我的测试脚本路径写错了**：该路径解码后是 `/api/admin/admin/settings`（多了一级），本来就不存在 | 修正为 `/api/a%64min/settings`，复测 **200** ✅ |

**最终状态：0 个失败项。**

### 9.3 一处需要澄清的观察（非失败、非本次引入）

真实 HTTP 验证时发现：**拿着登出前的同一个 token 继续访问，仍然返回 200**。

**这不是本次改动引入的**，而是项目的**既有设计**：

- `POST /api/admin/logout` 只下发清除 Cookie 的指令
  （`Set-Cookie: admin_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970...`）
- **没有服务端会话表**，因此没有吊销机制
- 浏览器会按指令清掉 Cookie，所以**真实用户登出后确实进不去**（浏览器实测已验证：登出后 `app` 视图切回登录页，API 返回 401）
- 但**被截获的 token 在 12 小时有效期内仍可用**

该限制已在 `docs/LANDLORD_SITE_CURRENT_STATE_AND_GAP_REPORT.md` 的 F5 条目中记录，
**属于本阶段范围之外**，本次未修改。

---

## 十、数据库、工作区和部署状态

### 10.1 改动文件清单

```
$ git status --porcelain
 M src/http/app.ts
 M tests/integration/security.test.ts
 ?? docs/LANDLORD_SITE_CURRENT_STATE_AND_GAP_REPORT.md   （上一阶段产出）
```

### 10.2 未被动过的部分（逐项核对）

| 项 | 状态 |
| --- | --- |
| `src/db/migrations.ts` | **未动** |
| `src/db/database.ts` | **未动** |
| `src/db/migrate.ts` | **未动** |
| `src/db/` 整个目录 | **未动** |
| `src/services/backup-service.ts` | **未动** |
| `src/services/export-service.ts` | **未动** |
| `src/domain/listing-page.ts` | **未动** |
| `src/adapters/map.ts` | **未动** |
| `public/` 整个目录 | **未动** |
| `package.json` / `tsconfig.json` / `.env` | **未动** |

### 10.3 数据库状态

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 迁移版本 | 2 | **2**（未变） |
| 表数量 | 11 | **11**（未变） |
| 房源 / 展示页 | 3 / 3 | **3 / 3**（未变） |
| 照片 / 提醒 | 15 / 6 | **15 / 6**（未变） |
| 联系方式 | 5 | **5**（未变） |
| 外键违规 | 0 | **0** |
| `landlord_pages`（计划 A 新表） | 不存在 | **不存在**（计划 A 未执行） |

### 10.4 工作区原有改动

修复开始前记录的基线：

```
分支: master
HEAD: 435cd6d3e4ab57af383ccb60ce04687134076dca
受版本控制的改动数: 0
未跟踪文件: docs/LANDLORD_SITE_CURRENT_STATE_AND_GAP_REPORT.md
```

**工作区原有改动完整保留**，未被覆盖或回退。

### 10.5 服务与部署状态

| 项 | 值 |
| --- | --- |
| 服务 | `127.0.0.1:3210`（PID 19404） |
| 启动命令 | `node --disable-warning=ExperimentalWarning src/server.ts` |
| 状态 | 运行中，承载修复后的代码 |
| 部署 | **未部署公网**。仅监听 `127.0.0.1`（回环地址） |
| 邮件 / DNS / 付费 API | **未调用** |

**未提交到 git**（按用户要求「先提交报告和测试结果」，等待确认后再决定是否提交）。

---

## 十一、尚未解决的问题与剩余风险

### 11.1 本阶段**未修复**的同类问题（明确保留）

| # | 问题 | 位置 | 为什么没修 |
| --- | --- | --- | --- |
| 1 | **登录限流可被 `X-Forwarded-For` 绕过** | `src/http/app.ts:57`（`trustProxy: true`）+ `src/http/routes/admin-auth.ts:31`（`request.ip`） | 属独立漏洞，用户明确限定本阶段只修认证绕过。**修复后的实际影响上升**：编码绕过被堵住后，口令爆破成为唯一入口，而限流仍可被轮换 IP 绕过 |
| 2 | **登出无服务端吊销** | `src/http/routes/admin-auth.ts:68-71` | 既有设计，需引入会话表，属结构性改动 |
| 3 | **三个后台接口接受任意路径读写** | `admin-backup.ts:44-49`、`admin-export.ts:39` | 用户明确列出为后续阶段 |
| 4 | **`role` 不参与鉴权** | `src/http/security.ts:51-78` | 属计划 B 的账号体系 |
| 5 | **Cookie 无 `Secure`（当前 HTTP）** | `admin-auth.ts:60` | 取决于 `PUBLIC_BASE_URL` 是否 https，部署时自动生效 |
| 6 | **登录限流 `prune()` 从不调用**（内存无上限增长） | `src/http/security.ts:205` | 属独立问题 |

### 11.2 本修复的剩余风险与边界

| 项 | 说明 |
| --- | --- |
| **依赖框架行为** | 修法依赖「`preHandler` 在路由匹配之后执行」这一 Fastify 生命周期约定。已用独立实例实测验证（见 2.2），但**若将来升级 Fastify 大版本，需重新确认该约定** |
| **`routeOptions.url` 的语义** | 它是**路由模式**（如 `/api/admin/properties/:id`），不是请求路径。`PUBLIC_ADMIN_PATHS` 里的两条豁免路径（`/api/admin/login`、`/api/admin/session`）都是无参数路由，精确匹配成立；**若将来新增带参数的公开发后台路由，豁免逻辑需要相应调整** |
| **早拒层不是安全边界** | 双重编码等形态 `onRequest` 认不出来，由 `preHandler` 兜住。**安全性由 `preHandler` 单独保证**，早拒层只为性能 |
| **未做的验证** | 未做：并发压力测试、其它 HTTP 客户端（curl/Postman）的行为差异、反向代理改写路径的场景。**反向代理若重写路径，`preHandler` 看到的仍是路由模式，不受影响**，但未实测 |

### 11.3 状态分类汇总

| 项 | 状态 |
| --- | --- |
| 原始漏洞路径无凭据不可访问 | **已实现并验证** |
| 编码及等效路径变体不能绕过 | **已实现并验证**（230 个未登录请求全部 401） |
| 后台读接口经实际验证 | **已实现并验证** |
| 后台写接口经实际验证 | **已实现并验证**（POST 编码路径 401；已登录 POST 正常） |
| 后台删接口经实际验证 | **已实现但未完整验证** —— 只验证了未登录 DELETE 返回 401；**未对真实数据执行删除**（遵守不触碰真实业务数据的要求） |
| 合法登录正常 | **已实现并验证**（含浏览器真实表单登录） |
| 公开房源页正常 | **已实现并验证** |
| 回归测试与类型检查真实完整 | **已实现并验证**（277/277，tsc 退出码 0） |
| 未覆盖原有改动、未改数据库、未执行计划 A | **已实现并验证**（逐项核对） |
| 登录限流 `X-Forwarded-For` 绕过 | **未实现**（本阶段范围外） |
| 登出服务端吊销 | **未实现**（既有设计限制） |

---

## 附录：可复现的验证脚本

本次验证用到的探针脚本留在 `var/`（已被 `.gitignore` 忽略，不属于仓库内容）：

| 脚本 | 用途 |
| --- | --- |
| `var/probe-variants.mjs` | 修复前：枚举 15 种路径变体的实际状态码 |
| `var/probe-lifecycle.mjs` | 验证 Fastify 两个生命周期阶段的路径可见性 |
| `var/verify-live-unauth.mjs` | 修复后：230 个未登录请求的批量验证 |
| `var/verify-live-auth.mjs` / `verify-live-auth2.mjs` | 修复后：已登录、登出、公开页验证 |
| `var/verify-integrity.mjs` | 数据库 schema 与行数核对 |

**所有脚本均只输出状态码与长度，不打印响应体。**

---

## 结论

**后台 API 认证绕过已修复并验证。**

- 根因是守卫（`onRequest`，用原始 URL）与路由器（用解码后路径）的**路径来源不一致**
- 修法是把权威判断移到 `preHandler`，读 `request.routeOptions.url` —— **守卫与路由共用同一事实来源**
- 这是机制性修复，不是对已知 URL 的特例：任何编码变体、任意 HTTP 方法、**将来新增的** `/api/admin/*` 路由都自动受保护
- 回归测试**程序化生成**全部变体，若有人把守卫改回路径字符串判断，测试会立刻变红
- 真实运行服务上 **230 个未登录请求全部 401**，已登录与公开功能全部正常，**277/277 测试通过**

**本阶段未触碰**：数据库、迁移、配置、前端、计划 A、以及用户列出的后续阶段任务。

**按用户要求，本阶段完成后停止，等待确认后再进入下一阶段。**