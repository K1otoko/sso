# SSO 认证中心方案 v0.5 —— 本轮：核心登录与认证

> 状态：草案（2026-10-13）。v0.5 变化：**服务间认证移出本轮**（下一轮实现）；
> 本期范围 = 用户登录 + 用户令牌 + 网关对接。登录页由前端仓库实现、
> 接入方式为 SPA 直连（均已确认）。待复核：第 13 节「假设与待确认」。

## 1. 本轮目标与范围（本仓库）

**交付**

- 真实登录：用户名 + 密码（scrypt 哈希）；**登录页面由前端仓库实现**，
  认证中心提供交互重定向与登录提交 API（含防爆破限速）
- OIDC：authorization_code + PKCE、refresh token、logout（userinfo 关闭：claims 随 ID token 返回）
- 三档等级权限：`super > admin > user`，写入令牌 claim
- JWT access token + JWKS：网关与业务服务可本地离线验签
- 两份对接文档：前端对接、网关对接（令牌与验签契约）
- 账号供应：种子脚本 + 最小 CLI（建号 / 改角色）
- vitest 测试 + 仓内 e2e 冒烟（模拟前端登录页与换码）

**不做（本仓库范围外或下一轮）**

- **服务间认证**（client_credentials、服务令牌、服务侧验签）—— 下一轮（设计概要见第 8 节）
- 网关、业务服务、前端代码（均在独立仓库）
- 登录页面的实现与样式（前端仓库负责）
- 管理 API / 管理界面、自助注册、找回密码、审计体系
- 多租户、邮件 / 短信、WebAuthn、mTLS、private_key_jwt
- CI/CD 与生产部署编排（本轮以本地联调为准）

## 2. 边界与角色

- 本仓库唯一产物：SSO 认证中心（`sso-server`，Express 5 + oidc-provider + PostgreSQL）。
- 网关（Fastify，独立仓库）：处理 `/api/gateway/**` 业务流量，校验用户令牌
  并注入身份头；`/api/sso/**` 由后端 Nginx 分流到认证中心。
- 前端（独立仓库）：OIDC 客户端 `web`（授权码 + PKCE）+ **自建登录页**；
  登录页通过认证中心登录 API 提交凭据；浏览器直连 token 端点换令牌（SPA 直连，已确认）。
- 其他后端服务（独立仓库）：本轮仅作为用户令牌的最终消费方（经网关接收身份头）；
  服务间认证下一轮实现。
- 认证中心公开路径固定为 `/api/sso/**`：issuer 开发值为
  `http://127.0.0.1:4000/api/sso/oidc`，生产使用前端公网域名下的同一路径；
  请求由前后端 Nginx 转发，但不经过 Gateway 应用。
- 本地开发建议前端与认证中心使用同一 host（都用 `127.0.0.1`，端口不同视为同站），
  否则 Cookie 会按跨站规则处理。

## 3. 术语表（便于评审）

| 术语 | 一句话解释 |
| --- | --- |
| OIDC | 基于 OAuth 2.0 的登录 / 身份标准；认证中心是 Provider，前端是 Client |
| 授权码 | 登录成功后的一次性凭证，前端拿它去换令牌；令牌不经过浏览器地址栏 |
| PKCE | 浏览器 / 移动端这类无 client_secret 客户端的防截胡机制（challenge / verifier 校验） |
| 交互（interaction） | 认证流程里需要用户参与的一步（如登录）；本方案中交给前端登录页完成 |
| access token | 访问 API 用的令牌（本方案为 JWT，可离线验签） |
| refresh token | 续期令牌（轮换式） |
| ID token | 身份凭证，前端用它知道"当前登录的是谁" |
| JWKS | 认证中心公钥集，验签方用它校验令牌签名 |
| client_credentials | 服务对服务的取令牌方式（无用户参与）—— 下一轮实现 |

## 4. 总体架构

```
 前端(独立仓库)
   │ ① 登录跳转 / 提交凭据 ───────────────▶ 前端 Nginx → 后端 Nginx
   │                                                   └─ /api/sso/** → SSO 认证中心
   │                                        登录 API · token 端点 · JWKS
   │ ② 业务请求（Authorization: Bearer）
   ▼
 Gateway (Fastify, 独立仓库)
   └─ /api/gateway/**（验签 + 注入 X-User-*）──▶ 业务服务(各自独立仓库, 内网)
```

- 前端 Nginx 将 `/api/**` 转到后端 Nginx；后端 Nginx 将
  `/api/sso/**` 交给认证中心，将 `/api/gateway/**` 交给 Gateway。
- 两层代理均需正确传递 `Host` 与 `X-Forwarded-Proto/For`。

## 5. 登录流程（授权码 + PKCE，前端自建登录页）

1. 前端把浏览器重定向到 `GET {issuer}/auth?...`（client_id=web，带 PKCE challenge）。
2. 前端与后端 Nginx 转发到认证中心；认证中心检查会话 cookie。
3. 无会话 → 认证中心 302 到前端登录页：`{LOGIN_UI_URL}?interaction={uid}`
   （uid 短时有效、不可猜测）。
4. 前端登录页收集用户名密码，浏览器直接提交：
   `POST {issuerOrigin}/api/sso/interaction/{uid}/login`
   （JSON；CORS 白名单 + 携带凭据）。
   认证中心执行 scrypt 校验 + 限速（按 IP / 用户名），成功后建立会话 cookie
   （认证中心域），返回 `{ redirectTo }`（下一步要继续的地址）。
5. **前端登录页执行跳转**：`location.href = redirectTo`；浏览器回到认证中心后，
   授权流程恢复并签发 code（首方客户端跳过 consent 提示，用 oidc-provider 的
   interactionPolicy 配置），认证中心 302 → 前端 `redirect_uri?code=...&state=...`
   （浏览器自动跟随）。
6. 前端应用在回调地址用 code + PKCE verifier 直接换取 access / refresh / ID token
   （已确认 SPA 直连：浏览器 JS 直接调用 token 端点，需 CORS）。
7. 前端带 `Authorization: Bearer <access token>` 调业务 API；
   网关本地验签后注入身份头并转发。

为什么登录成功后还要"绕回"认证中心再回到前端：此刻授权码尚未生成，
code 必须由认证中心的授权流程签发（同时完成 PKCE、state、客户端白名单校验）。
正确顺序是：登录页跳回认证中心（瞬间完成）→ 认证中心签发 code 并 302 →
浏览器落到前端回调地址。用户视角中间只有一次无感知的跳转。

安全与部署要点：

- 登录 API：仅 POST；失败限速 + 锁定；错误统一返回"用户名或密码错误"（不泄露账号是否存在）。
- Cookie：认证中心与前端建议同站部署（同一父域名；本地同用 `127.0.0.1`，端口不同视为同站），
  此时 `SameSite=Lax` 即可；真正跨站场景需 `SameSite=None; Secure`，
  且受浏览器第三方 Cookie 策略影响，应尽量避免。
- 凭据只从浏览器发往认证中心（HTTPS），经过网关转发；任何一方不得记录密码明文。

## 6. 权限模型（3 档等级）

| 角色 | 等级 | 说明 |
| --- | --- | --- |
| `super` | 3 | 超级管理员（本轮体现为令牌 claim，管理面下一轮） |
| `admin` | 2 | 管理员 |
| `user` | 1 | 普通用户（默认） |

- 包含式语义：`super` ⊇ `admin` ⊇ `user`；`requireRole('admin')` 表示等级 ≥ 2。
- 存储：`users.role` 单列枚举；写入 access / ID token 的 `role` claim。
- 执行点：网关粗粒度拦截（路由级 `minRole`）+ 服务最终判定，共用等级比较逻辑。
- 角色变更生效延迟 ≤ access token TTL（10 分钟），不做实时回查（保持简单）。

## 7. 令牌设计与对外契约

| 令牌 | 场景 | 关键 claim | TTL |
| --- | --- | --- | --- |
| 用户 access token | 浏览器登录 | `sub` `role` `username` `token_use=user` | 10 分钟 |
| ID token | 同上 | 标准 OIDC claims + `role` | 10 分钟 |
| refresh token | 同上 | 轮换（rotation） | 14 天 |

实现要点：

- `formats.accessToken = 'jwt'`：oidc-provider 默认签发 opaque token，必须显式改为 JWT。
- `role` / `username` 通过 `findAccount` + `extraTokenClaims` 从数据库注入。
- 用户令牌带 `token_use=user`（占位设计：下一轮加入服务令牌时验签契约不变）。
- JWKS 持久化：开发自动生成并落盘（gitignore）；生产从环境变量 / 挂载读取；支持 `kid` 轮换。
- 校验方容忍 60 秒时钟偏移。

登录交互契约（前端仓库遵守）：

| 端点 | 行为 |
| --- | --- |
| `GET /api/sso/interaction/{uid}` | 已登录：继续流程；未登录：302 到 `{LOGIN_UI_URL}?interaction={uid}` |
| `POST /api/sso/interaction/{uid}/login` | JSON `{username, password}`；成功 200 `{redirectTo}`；失败 401 `{error}`；CORS 白名单 + 凭据 |

令牌契约（网关 / 服务遵守）：

| 项目 | 约定 |
| --- | --- |
| issuer / discovery | 公网地址；`{issuer}/.well-known/openid-configuration` |
| JWKS | `{issuer}/jwks`，本地缓存 + 未知 `kid` 时刷新 |
| 用户令牌校验 | 签名、`iss`、`exp`、`token_use=user` |
| 身份头 | 网关剥离客户端 `X-User-*`，验签后注入 `X-User-Id` / `X-User-Role`；服务仅在"内网 + 请求已验签"前提下信任 |

## 8. 下一轮：服务间认证（本次不做，仅存档设计）

- 每个服务注册 `client_credentials` 客户端；服务令牌的 `aud` 精确指向目标服务
  （resource indicators / RFC 8707），TTL 5 分钟，防跨服务串用。
- 服务侧用 JWKS 本地验签，校验 `token_use=service`、`aud=自己`；
  代表用户发起调用时，用户上下文头仅在服务身份有效时信任。
- 本轮不交付上述内容；本轮令牌与验签契约已为下一轮预留 `token_use` 字段。

## 9. 数据与账号供应

- `users` 表扩展：`username`（唯一）、`password_hash`（scrypt）、`role` 枚举、`status`。
- Drizzle 迁移 + 种子（1 个 super + 1 个 user）+ CLI：`pnpm user:create --username --role`。
- OIDC 运行时数据：v1 先用内存适配器，最后一步落地轻量 Drizzle Adapter（重启不掉登录态）。
- 客户端注册：v1 用配置文件（zod 校验）；管理面做成后迁至数据库。

## 10. 本仓库结构

```
sso/
├── src/                 # 现有 Express 5 + oidc-provider 代码
│   ├── config/  db/  oidc/
├── drizzle/             # 迁移文件
├── scripts/             # 种子、user CLI
├── test/                # vitest 单元 / 集成 / e2e 冒烟
└── docs/
    ├── auth-center-plan.md
    ├── frontend-integration.md   # 给前端仓库（含登录页对接）
    └── gateway-integration.md    # 给网关仓库
```

## 11. 里程碑

| 里程碑 | 内容 | 验收标准 | 预估 |
| --- | --- | --- | --- |
| M0 工程基线 | vitest 接入、脚本规范、env 扩展（signing key、CORS、`LOGIN_UI_URL`、客户端配置） | 全仓 typecheck/lint/test 通过；现有 `/health`、discovery 冒烟不变 | 0.5 天 |
| M1 账号与登录交互 | users 扩展 + 迁移 + 种子 + CLI；交互重定向 + 登录 API（scrypt、限速）；`role` claim；登出 | 用 curl 模拟前端登录页，跑通授权码 + PKCE 全流程并拿到带 role 的令牌；错误密码受限速 | 1–1.5 天 |
| M2 令牌与对接文档 | JWT access token、JWKS 落盘；`web` 客户端 + CORS（登录 API / token / userinfo）；前端、网关对接文档 | 前端仓库按文档可完成跳转登录与换码；网关按文档可对接 | 1–1.5 天 |
| M3 持久化与收尾 | 轻量 Drizzle Adapter（会话 / 授权码 / refresh 落库）；e2e 冒烟；README | 认证中心重启后 refresh token 仍可用；`pnpm e2e` 一键通过 | 0.5–1 天 |

合计约 3–4.5 个工作日。

## 12. 测试要点

- 单元：角色等级比较、scrypt 校验、令牌校验（过期 / 错签 / 错 iss / 未知 kid）。
- 集成：交互重定向 + 登录 API（成功 / 失败 / 限速）、完整登录（含 PKCE）、
  刷新轮换、登出、CORS。
- e2e 冒烟：模拟前端登录页 → 授权 → 换令牌 → 带令牌访问（模拟）受保护接口。

## 13. 假设与待确认

1. 登录页由前端仓库实现（已确认）：认证中心提供 `{LOGIN_UI_URL}` 重定向 +
   登录交互 API；仓内测试用 curl / 模拟客户端验证。
2. 接入方式为 SPA 直连（已确认）：浏览器 JS 直连 token 端点换令牌
   （public client，PKCE 必需；token / userinfo 端点需 CORS 白名单）。
3. **服务间认证本轮不做（已确认）**，下一轮实现（设计概要见第 8 节）。
4. 部署路径固定为前端公网域名下的 `/api/sso/**`，由前后端 Nginx 原样转发，
   保证 Cookie 策略简单可靠。

## 14. 开始实现前需要你提供的信息

- 前端登录页的 dev / prod 地址（即 `LOGIN_UI_URL`）
- 前端 origin（CORS 白名单）
- 前端回跳地址（redirect_uri，dev / prod）
- 数据库连接信息（本地 PostgreSQL 即可）
