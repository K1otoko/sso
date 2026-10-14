# 执行方案 v1 —— 认证中心本轮实现（登录 + 令牌 + 持久化）

> 状态：待确认开工（2026-10-13）。本文件是 docs/auth-center-plan.md（v0.5）的落地细化版：
> 数据库设计、服务设计、执行步骤、验收标准。

## 0. 结论速览（先回答两个核心问题）

**Q1：数据库如何设计？**

- 本轮数据库里只有两张业务表：`users`（账号 / 角色 / 密码哈希）和 `oidc_payloads`
  （OIDC 运行时数据：会话、授权码、refresh token 等，通用持久化表）。
- 客户端注册（前端 client、回调白名单）本轮用配置文件管理，不建表；管理面下一轮再迁数据库。
- 所有表由 Drizzle 迁移管理（`drizzle/*.sql`），开发环境自动运行迁移。

**Q2：单独数据库还是服务间共享？**

**每个服务独立数据库，不共享。** 认证中心独占一个专属库 `sso`：

- 数据所有权：密码哈希、登录会话、授权码只属于认证中心；业务服务拿到的应该是**令牌**，
  而不是数据库连接。
- 安全边界：数据库凭据不扩散到各业务服务；某个业务服务被攻破，也无法直读全站账号数据。
- 解耦：认证中心可随时演进表结构，业务服务不受影响；服务间契约是 HTTP + 令牌，不是表结构。
- 业务服务要用户信息 / 角色 → 用令牌 claim 或 userinfo 接口获取，永远不查认证中心的库。

（共享数据库 = 隐式强耦合 + 安全面扩大，本架构明确不采用。）

## 1. 数据库设计

### 1.1 实例与库

| 项 | 值 |
| --- | --- |
| 服务器 | `82.157.56.196:5432`（已提供凭据） |
| 专用数据库 | `sso`（开工时在服务器上 `CREATE DATABASE sso`；**不触碰服务器上其他库**） |
| 连接串 | `postgresql://postgres:••••••@82.157.56.196:5432/sso`（口令含 `@` `#`，写入 .env 时做 URL 编码） |
| 凭据存放 | 仅本地 `.env`（已被 .gitignore 忽略），代码 / 文档 / 提交记录不出现明文 |
| SSL | 开工第一步探测（`sslmode` 参数按实际结果配置） |

### 1.2 表 `users`（账号）

> 相对现有基线迁移的变化：新增 `username` / `password_hash` / `role` / `status` /
> `last_login_at`；删除占位的 `subject`（`sub` 直接用 `id`）；`email` 改为可空。
> 库是全新的，直接重建 baseline 迁移（squash），不留过渡迁移。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | uuid | PK，default `gen_random_uuid()` | 同时作为 OIDC 的 `sub` |
| `username` | varchar(64) | NOT NULL，UNIQUE | 登录名 |
| `password_hash` | varchar(512) | NOT NULL | scrypt 格式：`scrypt$N$r$p$salt$hash` |
| `role` | `user_role` 枚举 | NOT NULL，default `user` | `super` / `admin` / `user` |
| `status` | `user_status` 枚举 | NOT NULL，default `active` | `active` / `disabled` |
| `email` | varchar(320) | NULL，UNIQUE | 可选 |
| `display_name` | varchar(255) | NULL | 可选 |
| `last_login_at` | timestamptz | NULL | 登录审计 |
| `created_at` / `updated_at` | timestamptz | NOT NULL，default `now()` | |

### 1.3 表 `oidc_payloads`（oidc-provider 持久化适配器）

一张通用表承载 oidc-provider 的所有模型（Session / Grant / AccessToken /
RefreshToken / AuthorizationCode / Interaction 等）。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `model` | varchar(64) | 模型名 |
| `id` | varchar(255) | 模型内 ID |
| `payload` | jsonb | 序列化数据 |
| `grant_id` | varchar(255) | 授权组 ID（refresh 撤销用） |
| `uid` / `user_code` | varchar(255) | 交互 / device 查询用 |
| `expires_at` | timestamptz | 过期时间 |
| `consumed_at` | timestamptz | 一次性对象（授权码等）用后标记 |
| `created_at` | timestamptz | default `now()` |

主键 `(model, id)`；索引：`expires_at`、`grant_id`、`uid`、`user_code`。

适配器方法映射：

| 方法 | SQL 语义 |
| --- | --- |
| `find(id)` / `findByUid` / `findByUserCode` | 按主键 / uid / user_code 查询 |
| `upsert(id, payload, expiresIn)` | INSERT ... ON CONFLICT (model,id) DO UPDATE |
| `consume(id)` | 更新 `consumed_at = now()` |
| `destroy(id)` | 删除单条 |
| `revokeByGrantId(grantId)` | 按 grant_id 批量删除 |

维护：`scripts/cleanup.ts` 定期清理 `expires_at < now() - interval '1 day'` 的行
（随 M3 交付，可挂系统定时任务）。

### 1.4 迁移与初始化

1. 开工第一步：连接服务器 → `CREATE DATABASE sso`（不存在才建）→ 确认 SSL 模式。
2. 重建 schema 与 baseline 迁移（现有 `0000_*.sql` 为占位版本，直接重新生成）。
3. `pnpm db:migrate` 应用迁移；`pnpm db:seed` 写入初始账号（1 个 super + 1 个 user）。
4. drizzle-kit 会自动读取 `.env`（执行时验证；如未生效则引入 dotenv 兜底）。

### 1.5 为什么只有两张表（设计说明）

物理表少 ≠ 实体少：`oidc_payloads` 是 oidc-provider 的标准"通用适配器表"，
通过 `model` 列承载全部运行时实体：

| 逻辑实体 | 存放位置 |
| --- | --- |
| 账号 / 角色 / 密码哈希 | `users`（角色为三档枚举列，按约束 1 不做 RBAC 四件套） |
| 登录会话（Session） | `oidc_payloads`，`model='Session'` |
| 授权记录（Grant） | `oidc_payloads`，`model='Grant'` |
| 授权码（AuthorizationCode） | `oidc_payloads`，`model='AuthorizationCode'` |
| access / refresh token | `oidc_payloads`，`model='AccessToken'` / `'RefreshToken'` |
| 登录交互状态（Interaction） | `oidc_payloads`，`model='Interaction'` |
| 客户端注册（client） | 本轮用配置文件；管理面落地时迁移为 `oidc_clients` 表 |
| 审计日志 | 下一轮按需增加 `audit_logs` 表 |

原因：

1. oidc-provider 的 Adapter 接口本身是泛型的（按 `model + id` 存取 JSON），
   一张通用表就是标准实现；拆成 8 张表没有查询收益（除辅助列外都是不可查询的 JSON），
   只会增加维护面。
2. 权限模型是三档枚举（约束 1），不需要 `roles` / `permissions` / `user_roles` 这类表。
3. 表随需求出现：管理面来了加 `oidc_clients`，审计需求明确后加 `audit_logs`，
   而不是现在预先铺开一半用不上的表。

## 2. 服务设计（认证中心）

### 2.1 模块结构

```
src/
├── index.ts                  # 启动（已有，基本不变）
├── app.ts                    # Express 组装：CORS、路由、错误处理
├── config/env.ts             # zod 配置校验（扩展）
├── middleware/
│   ├── cors.ts               # 白名单 + credentials
│   └── login-rate-limit.ts   # 登录失败限速（内存计数）
├── auth/
│   ├── password.ts           # scrypt 哈希 / 校验
│   └── interaction.ts        # GET/POST /api/sso/interaction/:uid
├── oidc/
│   ├── provider.ts           # JWT access token、claims、interactionPolicy、TTL
│   ├── adapter.ts            # Drizzle 持久化适配器（oidc_payloads）
│   ├── jwks.ts               # ES256 密钥生成 / 加载（落盘）
│   └── clients.ts            # 客户端注册表（配置驱动）
├── users/repository.ts       # 用户查询：findByUsername / touchLogin / create
└── db/
    ├── client.ts             # 连接池（已有）
    └── schema.ts             # users + oidc_payloads（重写）
scripts/
├── seed.ts                   # 种子账号
├── user.ts                   # CLI：建号 / 改角色 / 停用
└── cleanup.ts                # 过期 oidc_payloads 清理
test/                         # vitest：单元 / 集成 / e2e 冒烟
```

### 2.2 配置项（含本轮默认值）

| 变量 | 本轮值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | |
| `HOST` / `PORT` | `127.0.0.1` / `4000` | 开发默认；生产容器监听 4000，由宿主机 `127.0.0.1:4400` 转给后端 Nginx |
| `OIDC_ISSUER` | `http://127.0.0.1:4000/api/sso/oidc` | 生产使用前端公网域名下的相同路径 |
| `OIDC_COOKIE_KEYS` | 本地随机生成 | 生产必填 |
| `DATABASE_URL` | 见 .env（真实库） | 口令 URL 编码 |
| `LOGIN_UI_URL` | `http://127.0.0.1:5173/login` | 前端登录页（占位默认） |
| `CORS_ORIGINS` | `http://127.0.0.1:5173` | 前端 origin 白名单（占位默认） |
| `WEB_CLIENT_REDIRECT_URIS` | `http://127.0.0.1:5173/callback` | 前端回跳白名单（占位默认） |
| `JWKS_PATH` | `./secrets/jwks.json` | 开发密钥落盘（gitignore） |
| `TRUST_PROXY` | `2` | 生产经过前端、后端两层 Nginx；服务端口仅允许后端 Nginx 访问 |

### 2.3 端点清单

| 端点 | 用途 | CORS |
| --- | --- | --- |
| `GET /health` | 健康检查 | – |
| `GET /api/sso/oidc/.well-known/openid-configuration` | discovery | – |
| `GET /api/sso/oidc/jwks` | 公钥（网关 / 服务验签） | – |
| `GET /api/sso/oidc/auth` | 授权入口（授权码 + PKCE） | – |
| `POST /api/sso/oidc/token` | 换令牌 / 刷新 | 白名单 |
| `GET /api/sso/oidc/me` | userinfo —— **本轮关闭**（前端从 ID token 读 claims） | – |
| `GET /api/sso/oidc/session/end` | 登出 | – |
| `GET /api/sso/interaction/:uid` | 已登录继续流程；否则 302 到前端登录页 | – |
| `POST /api/sso/interaction/:uid/login` | 提交凭据，返回 `{redirectTo}` | 白名单 |

### 2.4 关键机制

- **口令**：Node 内置 `crypto.scrypt`（无原生依赖），格式 `scrypt$N$r$p$salt$hash`，
  恒定时间比较；`status=disabled` 的账号拒绝登录。
- **登录限速**：同一 IP + 用户名，15 分钟窗口 5 次失败后返回 429；内存实现（单实例足够）。
- **令牌**：`formats.accessToken='jwt'`；access / ID 10 分钟，refresh 14 天轮换；
  claims：`sub` / `role` / `username` / `token_use=user`。
- **findAccount / claims**：从 `users` 读取；`role` / `username` 经 `extraTokenClaims` 注入。
- **JWKS**：ES256；开发首次启动生成并写 `JWKS_PATH`；生产从环境变量 / 挂载读取。
- **交互策略**：首方客户端跳过 consent；登录一步完成（interactionPolicy 配置）。
- **持久化**：Drizzle Adapter 落库，重启不掉会话与 refresh token。
- **客户端注册**：`src/oidc/clients.ts` 配置驱动 —— 本轮注册前端 `web`
  （public client + PKCE + 回跳白名单）。

### 2.5 登录流程（与 v0.5 一致，简述）

1. 前端跳 `{issuer}/auth`（PKCE）→ 认证中心无会话 → 302 到 `{LOGIN_UI_URL}?interaction={uid}`
2. 前端登录页 `POST {issuerOrigin}/api/sso/interaction/{uid}/login`（限速 + scrypt 校验）
3. 认证中心建会话、返回 `{redirectTo}`；前端跳回 → 认证中心签发 code
4. 浏览器落回前端 `redirect_uri?code=...`；前端直连
   `POST /api/sso/oidc/token` 换令牌
5. 前端带 `Authorization: Bearer` 调 `/api/gateway/**`
   （网关验签 + 注入身份头）

### 2.6 单点登录（SSO）说明

- 机制：认证中心的**中央会话 cookie** 是唯一登录态；任何应用跳转过来时，
  已有会话 → 直接发码（不再出现登录页），这就是"一次登录、处处通行"。
- 覆盖范围：所有在本认证中心注册为 client 的应用（新增应用 = 新增一条注册）。
- 会话有效期：默认 7 天滚动续期（可配置）；refresh token 14 天。
- 登出：任一应用触发 end_session → 中央会话终结 → 其他应用的令牌到期后
  （≤10 分钟）无法续期、被要求重新登录；"秒级全端踢出"需后续加
  back-channel logout（下一轮增强，非本轮范围）。

## 3. 执行步骤（里程碑细化）

| 步骤 | 内容 | 验收标准 | 预估 |
| --- | --- | --- | --- |
| M0 联通与基线 | 连通数据库 → `CREATE DATABASE sso`；SSL 探测；.env 落真实配置；.env.example 更新；vitest 接入；脚本规范 | `pnpm typecheck / lint / test` 通过；`pnpm db:studio` 能连上 `sso` 库 | 0.5 天 |
| M1 账号与登录 | schema 定稿 + baseline 迁移 + migrate；scrypt + 用户仓库 + 种子 + CLI；交互路由（重定向 + 登录 API + 限速）；role claim；登出 | curl 模拟前端：授权 → 登录页跳转 → 提交凭据 → 跟 redirectTo → 换到带 `role` 的 JWT；错误密码 429；停用账号被拒 | 1–1.5 天 |
| M2 令牌与持久化 | JWT access token + JWKS 落盘；Drizzle Adapter（`oidc_payloads`）；`web` 客户端 + CORS；前端 / 网关对接文档 | **重启认证中心后 refresh token 仍可用**；curl 换 token 并用 jwks 验签通过；OPTIONS 预检通过 | 1–1.5 天 |
| M3 冒烟与收尾 | e2e 冒烟（模拟前端全链路）；cleanup 脚本；README 更新 | `pnpm e2e` 一键通过；过期数据清理脚本可运行 | 0.5 天 |

合计约 3–4 个工作日。

> 与 v0.5 的一处调整：原「M3 才做持久化」改为「M2 一次做到位」——
> 数据库已就绪，先接适配器可避免会话/令牌逻辑二次改造，收尾更干净。

## 4. 安全与凭据管理

- 数据库口令只写入本地 `.env`（gitignore）；代码、文档、提交记录不出现明文。
- 该口令已在聊天中出现过：建议开发联调完成后在服务器上轮换一次；
  长期建议建专用数据库账号（替代 `postgres` 超级用户直连）并限制来源 IP。
- 执行步骤 M0 需要从本机访问 `82.157.56.196:5432`（届时我会发起一次网络访问授权请求）。
- 迁移只操作 `sso` 库，不触碰服务器上的其他数据库。

## 5. 实现结果与验证（2026-10-13 更新）

已按本方案完成 M0–M3 并全部验证通过：

- 数据库：`sso` / `sso_test` 已创建（82.157.56.196，PostgreSQL 18.6）；
  两张表迁移完成；种子账号 `admin`(super) / `demo`(user)。
- 登录：`GET /api/sso/interaction/:uid`（跳前端登录页；已有会话直接续跑）+
  `POST /api/sso/interaction/:uid/login`（scrypt 校验、限速、统一错误文案）。
- 令牌：JWT access token（ES256、`aud=urn:sso:api`、`role`/`username`/`token_use`）；
  ID token 带 `role`；refresh 会话绑定 + 轮换 + 重放检测。
- 持久化：Drizzle 适配器（`oidc_payloads`），认证中心重启不掉登录态。
- 测试：`pnpm test` 9/9 通过——覆盖完整登录、PKCE、SSO 免登录、
  登出后令牌失效、重放撤销、登录限速、无 cookie 交互保护、JWKS 离线验签。
- 文档：README、`docs/frontend-integration.md`、`docs/gateway-integration.md`。

实现中确认的两个库级行为（已反映到对接文档）：

1. `userinfo` 端点关闭：JWT access token 带 `aud`，与 userinfo 端点不兼容；
   身份 claims 随 ID token（和 access token）返回。
2. 续期令牌采用「会话绑定」策略（自定义 `issueRefreshToken`），
   不依赖 `offline_access`，登出即失效、前端无需额外参数。

下一步（本方案范围外）：

- 网关仓库按 `gateway-integration.md` 实现 Fastify 验签与身份注入。
- 前端仓库按 `frontend-integration.md` 实现登录页与换码流程。
- 下一轮规划：管理 API / 管理界面、服务间认证（client_credentials）、
  可发布的验签工具包。

## 6. 运维平台接入预留（待平台要求确认）

认证中心后续如纳入运维平台的部署 / 升级 / 监控流程，接入前建议补齐：

| 项 | 现状 | 需要做的 |
| --- | --- | --- |
| 就绪探针 | ✅ `/health`（存活）+ `/health/ready`（数据库连通性，发布健康检查用） | – |
| 版本信息 | 无 | 增加 `GET /version`（版本 / 构建信息） |
| 打包 | `pnpm build` + dist | 容器镜像（Dockerfile）或平台要求的形态 |
| 配置 | 全部走环境变量 ✅ | 生产密钥由平台注入，不落盘 |
| 签名密钥 | 单实例本地 `secrets/jwks.json` | **多副本必须挂载同一份密钥文件**（或后续支持 `JWKS` 环境变量注入） |
| 数据库迁移 | 手动 `pnpm db:migrate` | 作为独立发布步骤（先迁移、后滚动发布），不放在应用启动里 |
| 日志 | stdout ✅ | 平台如需结构化日志 / Prometheus 指标，再补 `/metrics` |
| 优雅退出 | SIGTERM/SIGINT + 关连接池 ✅ | 与平台探针参数对齐即可 |

已知小限制：登录限速计数为单实例内存，多副本下相当于「每副本 5 次」
（可接受；如需严格限制可后续换共享存储）。

网关侧：运维平台「能升级」解决发布效率，但不等于高可用——建议与平台确认
支持多副本滚动升级 + 健康检查 + 自动摘除，这样单台故障不影响对外服务。

### 6.1 关键风险：自举依赖（升级工具的登录依赖被升级对象）

现状组合：单实例 + 运维平台登录走认证中心 + `/api/sso/**` 由 Nginx
直接路由到认证中心（不进入 Gateway 应用）。

⟹ **升级认证中心期间**：运维平台无法完成新登录（认证链路被切断）；
若升级失败需要回滚时正好登不进去，会形成死锁。升级 **Gateway 应用**不影响
登录，因为 Nginx 会绕过 Gateway 处理 `/api/sso/**`。
已登录的管理员能撑多久，取决于运维平台会话设计：若「登录一次后靠自身会话 +
缓存公钥离线验签」，可撑过升级窗口；若每次请求回调认证中心，升级瞬间全部登出。

接入前必须具备（至少其一，建议第 1 + 第 2 条同时满足）：

1. **运维平台本地兜底登录（break-glass）**：不经认证中心的管理员登录通道，
   仅限管理员网络 / 堡垒机。管 IdP 的工具不能 100% 依赖 IdP 自身。
2. **认证中心的管理员可达性**：前后端 Nginx 保留 `/api/sso/**` 直达路由，
   运维侧也可准备 VPN / 专网兜底路径。
3. **运维平台验签离线化**：JWT 用缓存 JWKS 本地验签，登录后依赖自身会话，
   不在每个请求上回调认证中心。

拓扑决定（已确认）：认证中心使用前端公网域名下的 `/api/sso/**` 路径，
经两层 Nginx 直达且不进入 Gateway 应用；接入要求即上面第 1–3 条。

升级操作建议：单实例意味着每次升级都有中断窗口——升级前先验证兜底登录与
回滚路径可用；发布任务在平台服务端执行，不依赖升级期间保持 UI 登录态。
中长期：网关与认证中心各配 2 个副本做滚动升级，彻底消除中断窗口
（多副本前提：共享同一份 JWKS 密钥文件、迁移作为独立发布步骤）。
