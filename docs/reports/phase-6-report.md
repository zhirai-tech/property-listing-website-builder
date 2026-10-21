# 修订记录（2026-10-12 二次修订）

> 本报告初稿写于本轮开发过程中。此后又完成了若干修复与补充验证，**以下修订单独列出，并取代正文中相应结论**；正文其余内容仍然有效。

## 修订内容

初稿判定「否」，理由是「TXT 域名所有权验证从未在真实 DNS 上跑通；应用不做 TLS 终结、无 HSTS」。**这两点属实，且第二点至今未变**，但第一点的验证覆盖已补齐：

1. **新增 13 项域名与托管服务测试**（`tests/services/hosting-service.test.ts`），用可注入的 DNS 适配器（`FakeDnsResolver`）**完整跑通**：
   - 绑定域名 → 生成 TXT 指引 → 未验证时地址仍为平台默认地址；
   - 无 TXT 记录 / 记录值不匹配 → 验证失败并说明原因，**不启用自定义域名**；
   - TXT 记录正确 → 验证通过，公开地址切换为自定义域名；
   - **DNS 把长 TXT 记录拆成多段时的拼接比对**；
   - 换绑域名后**必须重新验证**（`domainVerifiedAt` 被清空）；
   - 解绑后回到平台默认地址；
   - 域名被其它房源占用、非法域名被拒绝、未绑定即验证被拒绝。
2. **中文 slug 生成子域名的回退已修复。** DNS 标签只能是 ascii，中文 slug（如「浦东新区精装两居室」）此前会直接抛错；现回退为 `listing-<随机6位>`，用户仍可自行修改。

**仍然存在的限制（因此本阶段整体判定仍为「部分完成」）：**

- **未在真实公网 DNS 上验证过**：需要自有域名与 DNS 控制权，本环境不具备，已如实登记。
- **应用不做 TLS 终结，也没有 HSTS**：HTTPS 需由 Nginx/Caddy 等反向代理提供。
- 子域名模式（`<slug>.<CNAME 目标>`）只生成建议值，**未做实际的 DNS 记录自动开通**（多数 DNS 服务商需要 API 凭据，属于部署侧配置）。

---

# 第 6 阶段验收报告：托管发布与子域名

- 项目根目录：`E:\轻量化房源管理`
- 对应方案：第五章第 6 阶段（工作与验收项）、第三章第 8 条
- 运行配置（本机 `.env`）：`HOSTING_PROVIDER=custom_domain`、`HOSTING_CNAME_TARGET=listings.example.com`、`DOMAIN_VERIFY_PREFIX=_property-listing-verify`、`PUBLIC_BASE_URL=http://127.0.0.1:3210`
- 证据性质说明：本阶段**没有**端到端自动化断言（73 项冒烟检查不含托管/域名用例），也**没有**浏览器截图；以下结论来自代码与配置核对，以及第 2 阶段已验证的「发布/撤下可重复操作」结论

## 阶段名称与目标

第 6 阶段：托管发布与子域名。目标为先实现默认托管地址，再支持自定义子域名或域名绑定、HTTPS、发布撤回和错误处理。验收要求：完成域名所有权验证；HTTPS 有效；发布和撤回可以重复操作；未经验证的域名不能直接绑定。

## 实际修改的文件/模块

- `src/domain/hosting.ts`：托管领域规则。
  - `buildDefaultPublicUrl(baseUrl, slug)`：平台默认地址 `${PUBLIC_BASE_URL}/p/<slug>`；
  - `buildSubdomain(slug, cnameTarget)`：按 slug 生成建议子域名 `<label>.<CNAME 目标>`；
  - `buildCustomDomainUrl(domain, slug)`：`https://<domain>/p/<slug>`；
  - `resolvePublicUrl(slug, state, options)`：**只有通过验证的自定义域名才会生效**，未验证时回退默认地址并在 `note` 中给出 TXT 记录指引；
  - `domainVerificationInstructions(domain, token, prefix)`：生成 TXT 记录指引（记录名、记录值 `_property-listing-verify=<token>`、四步操作说明）；
  - `validateSubdomainLabel(label)`：长度 ≥ 2，并保留 18 个系统保留标签（www / api / admin / app / mail / smtp / ftp / cdn / static / assets / test / staging / dev / prod / status / docs / help / support）。
- `src/adapters/hosting.ts`：`HostingProvider` 接口与两个实现 —— `DefaultHostingProvider`（仅默认地址，`allowsCustomDomain = false`）与 `CustomDomainHostingProvider`（带 `verifyDomain()`，读取并比对 TXT 记录）。
- `src/adapters/dns.ts`：`DnsResolver` 接口、`SystemDnsResolver`（`node:dns/promises`，查询失败与「没有记录」等价处理为未验证）、`FakeDnsResolver`（内存记录，供无真实域名时验证流程）、`flattenTxtRecords`（把被拆分的 TXT 片段拼回）。
- `src/services/hosting-service.ts`：`hostingState`、`bindDomain`、`verifyBoundDomain`、`unbindDomain`、`suggestSubdomain`。
- `src/http/routes/admin-settings.ts`：`GET /api/admin/properties/:id/hosting`、`POST .../hosting/domain`、`POST .../hosting/verify`、`DELETE .../hosting/domain`。
- `public/admin/views/property-edit.js`：「自定义域名」标签（绑定输入框、绑定按钮、验证域名、解绑、当前公开地址与验证状态）。
- `.env.example` 与 `src/config.ts`：`HOSTING_PROVIDER`、`HOSTING_CNAME_TARGET`、`DOMAIN_VERIFY_PREFIX`。

## 数据库变更与迁移结果

- 本阶段无新增迁移；使用 `v1 initial_schema` 中 `listing_pages` 的既有列：`custom_domain`、`domain_verify_token`、`domain_verified_at`，以及索引 `idx_listing_pages_domain(custom_domain)`。
- 关键行为（写入层面）：
  - `bindDomain`：规范化域名 → 检查该域名是否已被**其它房源**占用（`getListingPageByDomain`，冲突时返回 409「已绑定到其它房源」）→ 复用或新生成验证令牌（`newToken(18)`，18 字节随机数的 base64url）→ 写入 `custom_domain` / `domain_verify_token`，并**强制把 `domain_verified_at` 置为 null**（重新绑定必须重新验证）；
  - `verifyBoundDomain`：验证通过才写入 `domain_verified_at`（取 `Clock` 的当前时间），并写审计 `hosting.verify`；
  - `unbindDomain`：清空三列并写审计 `hosting.unbind`；
  - 绑定、验证、解绑都写审计日志（`hosting.bind` / `hosting.verify` / `hosting.unbind`）。
- 未验证域名的影响面：由于公开路由只按 `slug` 取发布页、且 `resolvePublicUrl` 在未验证时回退默认地址，因此**绑定未验证的域名不会让该域名立刻可访问**（域名是否解析到本服务、是否有证书，均由外部基础设施决定，见失败项第 3 条）。

## API/服务端验证

| 方法 | 路径 | 代码级验证结果 |
| --- | --- | --- |
| GET | `/api/admin/properties/:id/hosting` | 返回 `state`（provider、allowsCustomDomain、slug、publicUrl、urlKind、note、customDomain、domainVerifiedAt、verifyToken）、`cnameTarget`、`verifyPrefix` |
| POST | `/api/admin/properties/:id/hosting/domain` | `HOSTING_PROVIDER=default` 时返回 422「当前托管模式为『平台默认地址』…」；域名格式非法返回 409；域名已被其它房源占用返回 409；成功返回 `page`、TXT 记录指引 `instructions` 与当前可用的 `publicUrl`（验证通过前为默认地址） |
| POST | `/api/admin/properties/:id/hosting/verify` | 未绑定域名返回 422「尚未绑定自定义域名」；调用适配器查询 TXT 并与 `_property-listing-verify=<token>` 比对；DNS 查询抛错时返回「依赖不可用」错误；验证成功写入 `domain_verified_at` 并返回 `publicUrl`（此时为 `https://<domain>/p/<slug>`）；失败返回 `verified: false` + `found` 记录列表 + 指引 |
| DELETE | `/api/admin/properties/:id/hosting/domain` | 解绑并清空验证状态，返回更新后的 `page` |
| GET | `/p/:slug` | 公开地址按 `resolvePublicUrl` 的结果生成（页面内分享链接与二维码都使用该地址） |

「发布和撤回可以重复操作」由第 2 阶段的实测覆盖：`POST .../publish` → 200、`POST .../withdraw` → 200、再次 publish → 200、再次 withdraw → 200，且撤下后公开访问返回 404。

## 真实浏览器操作路径

1. 后台 → 房源详情 → 「自定义域名」标签 → 输入 `listings.example.com` 一类域名 → 点「绑定」。
2. 界面返回 TXT 记录指引（记录名 = 域名，记录值 = `_property-listing-verify=<token>`），并提示「自定义域名 X 尚未通过所有权验证，暂时使用平台默认地址」。
3. 到域名 DNS 后台添加 TXT 记录 → 回到页面点「验证域名」。
4. 验证通过后公开地址切换为 `https://<domain>/p/<slug>`；点「解绑」可恢复默认地址。

> 证据归档说明：**该路径没有截图，也没有自动化断言**。本机没有可用于签发的自有公网域名，第 3 步（真实 DNS TXT 生效）与第 4 步（HTTPS 实际可访问）**未执行**。上述流程为代码与接口定义所描述的行为。

## 通过项与证据

1. **先默认地址、后自定义域名**：`DefaultHostingProvider` 与 `CustomDomainHostingProvider` 覆盖两种模式，切换只改 `HOSTING_PROVIDER`；默认地址始终可用（`buildDefaultPublicUrl`）。
2. **未经验证的域名不能直接绑定（核心规则成立）**：`resolvePublicUrl` 只有在 `customDomain && domainVerifiedAt` 同时成立时才使用自定义域名，否则回退默认地址；`bindDomain` 只要重新绑定就清空 `domainVerifiedAt`。这是本阶段最重要的一条验收规则，实现与方案原文一致。
3. **域名所有权验证方式明确**：DNS TXT 记录比对（`DOMAIN_VERIFY_PREFIX` 可配置，默认 `_property-listing-verify`），并把「查询到的全部 TXT 记录」回显给用户，便于排查（`DomainVerificationResult.found`）。
4. **发布与撤回可重复操作**：已由第 2 阶段实测（重复发布、重复撤下均 200，撤下后 404）。
5. **域名冲突保护**：同一域名不能被绑定到两个房源（409），避免互相覆盖。
6. **子域名建议与保留字**：`validateSubdomainLabel` 拒绝空值、过短与 18 个系统保留标签，防止把 `admin`、`api` 一类标签用作房源子域名。
7. **DNS 查询可替换**：`DnsResolver` 抽象 + `FakeDnsResolver` 使整条验证流程在无真实域名时可被驱动（但当前没有使用它的自动化用例，见失败项第 1 条）。
8. **错误处理**：托管模式不支持自定义域名（422）、域名格式非法（409）、域名被占用（409）、未绑定就验证（422）、DNS 依赖不可用（dependencyUnavailable）都有明确中文提示。

## 失败项、原因与影响

1. **域名所有权验证没有端到端证据（重要）**：本机无可用的自有公网域名，因此「在真实 DNS 上添加 TXT 记录 → 服务端查询到 → 验证通过」这条链路**从未真实跑通**。`SystemDnsResolver` 的真实解析路径、TXT 记录被分段时的拼接（`flattenTxtRecords`）、DNS 传播延迟场景都没有实测。`FakeDnsResolver` 虽然存在，但 `tests/` 目录为空，没有用例使用它。
2. **HTTPS 未验证（重要）**：应用本身不做 TLS 终结（`src/server.ts` 只 `app.listen`），代码中也没有 HSTS 头（`src/http/security.ts` 的头部集合里没有 `Strict-Transport-Security`）。当前只有配置层约束：生产环境下 `PUBLIC_BASE_URL` 必须以 `https://` 开头（`validateConfig`）；会话 Cookie 的 `secure` 标志也取决于该前缀。**证书签发、HTTP→HTTPS 跳转、混合内容、HSTS 均未实现或未验证**，因此验收项「HTTPS 有效」未达成。
3. **自定义域名缺少服务端承接说明**：服务端没有任何按 `Host` 头判断或校验的逻辑，自定义域名要真正可访问，必须由外部反向代理（nginx / Caddy / 云负载均衡）把该域名指向本服务并配置证书。仓库中**没有部署样例或说明文档**（`README.md` 为空文件）。影响：用户按界面完成域名验证后，域名仍然打不开，缺少必要的运维指引。
4. **验证是手动触发、无自动复核**：用户必须点「验证域名」；DNS 传播期间反复失败只能手动重试，没有定时重试、也没有「上次尝试验证时间」的展示。
5. **子域名只是建议值**：`buildSubdomain` / `suggestSubdomain` 只生成字符串，平台不会创建 DNS 记录；`HOSTING_CNAME_TARGET` 目前只作为提示文本存在。
6. **验证令牌长期有效且不过期**：`domain_verify_token` 只在解绑或重新绑定时变化，没有有效期与轮换机制；若令牌泄漏，他人可在自己的 DNS 上添加同样的 TXT 记录来通过验证（这是 TXT 验证方式的固有限制，但对多租户场景需要额外防护，例如绑定唯一性检查之外的归属复核）。
7. **无同名域名与 IDN 处理**：`isValidDomain` 只接受 ASCII 标签（`[a-z0-9-]`），国际化域名（IDN）需要用户自己转成 punycode；界面没有提示。

## 许可证/安全/隐私影响

- **许可证**：本阶段无新增依赖（DNS 查询使用 Node 内置 `node:dns/promises`）。
- **安全**：域名所有权验证防止他人把不属于自己的域名绑到平台上；重新绑定清空验证状态，避免「换域名后沿用旧验证」；域名唯一性检查防止房源之间互相劫持；绑定/验证/解绑全部写审计日志。未实现 HSTS 与 TLS 终结（见失败项第 2 条），这是上线前的必修项。
- **隐私**：自定义域名会把房源页面暴露在该域名下，页面本身的隐私策略与第 2 阶段一致（只渲染公开联系方式、撤下后 404）；域名验证需要向系统 DNS 解析器查询用户域名，属功能必需。

## 遗留问题

1. 用一个受控的公网测试域名完整跑通 TXT 验证（含传播延迟与记录分段两种情况），并归档证据。
2. 决定 HTTPS 的落地方案（反向代理 + 证书签发与续期 / 云托管），写入部署与回滚说明，并补 HSTS 与 HTTP→HTTPS 跳转。
3. 提供一份自定义域名接入说明（DNS 记录、CNAME/TXT、代理配置要点），放在 `docs/` 下并在界面链接。
4. 让「验证域名」支持有限次自动重试，并显示上次验证时间与结果。
5. 评估验证令牌的有效期与轮换策略。
6. 为 IDN 域名提供 punycode 提示或自动转换。
7. 补 `tests/services/hosting-service.test.ts`（用 `FakeDnsResolver` 驱动）与相关集成测试。

## 是否达到本阶段验收标准：否

- 完成域名所有权验证：**未达成**——验证机制已实现，但从未在真实 DNS 上跑通，也没有自动化用例；属「已实现、未验证」。
- HTTPS 有效：**未达成**——应用不做 TLS 终结，无证书、无跳转、无 HSTS，仅在生产配置层要求 `https://` 前缀。
- 发布和撤回可以重复操作：达成（第 2 阶段实测：重复发布、重复撤下均 200；撤下后 404）。
- 未经验证的域名不能直接绑定：达成（`resolvePublicUrl` 的回退逻辑 + 重新绑定清空验证状态 + 域名唯一性检查）。
- 结论：四项验收项中两项达成，两项因缺少真实域名与 TLS 环境而未验证，故本阶段判定为**未达到验收标准**。达到标准所需的最小动作是：一个可用的测试域名 + 一次真实 TXT 验证 + 一套 HTTPS 终结方案。

## 下一阶段建议（仅建议，不自动开工）

1. 第 7 阶段（提醒）不依赖域名，可以先做；但提醒邮件里的「展示页地址」会使用 `resolvePublicUrl` 的结果，因此在域名未验证的环境下邮件链接应是默认地址——这一点已在实现中成立，建议在提醒报告里复核一次。
2. 上线准备阶段（第 8 阶段）必须把「HTTPS 终结 + 反向代理样例 + 回滚步骤」写成可执行文档，否则本阶段的缺口会直接变成上线阻塞项。
3. 建议为「域名已验证但服务端未承接」这一情形在后台加显式提示，避免用户误以为域名已经可用。