# SSO 认证中心

基于 Express 5、`oidc-provider`、PostgreSQL、Drizzle ORM 和 TypeScript 的
OpenID Connect 认证中心（本仓库只包含认证中心；网关、前端、业务服务在各自独立仓库）。

> 部署拓扑：认证中心公开路径统一为 `/api/sso/*`。前端 Nginx 将 `/api/**`
> 转发到后端 Nginx，后端 Nginx 将 `/api/sso/**` 转给本服务，将
> `/api/gateway/**` 交给 Gateway。

## 功能概览

- 真实登录：用户名 + 密码（scrypt 哈希）；**登录页面由前端仓库实现**，
  认证中心提供交互 API（含防爆破限速）
- OIDC 授权码 + PKCE 全流程；单点登录（SSO）；登出
- JWT access token（ES256，网关/服务可离线验签）+ JWKS；三档角色 claim（super / admin / user）
- 续期令牌（会话绑定、轮换、重放检测）
- 账号工具：种子脚本 + 命令行建号/改角色
- 用户数据与 OIDC 运行时数据持久化（PostgreSQL，重启不掉登录态）

> 说明：`userinfo` 端点未启用——身份信息随 ID token（与 JWT access token）返回。

## 环境要求

- Node.js 24 或更高版本
- pnpm 10 或更高版本
- PostgreSQL（`DATABASE_URL` 配置）

## 快速开始

```bash
nvm use
pnpm install
cp .env.example .env        # 按需修改（DATABASE_URL、issuer、前端地址等）
pnpm db:init                # 创建数据库 sso / sso_test（已存在则跳过）
pnpm db:migrate             # 应用迁移
pnpm db:seed                # 种子账号：admin(super) / demo(user)
pnpm dev                    # http://127.0.0.1:4000
```

默认访问：

- 健康检查：<http://127.0.0.1:4000/health>
- 就绪检查（含数据库连通性）：<http://127.0.0.1:4000/health/ready>
- OIDC Discovery：<http://127.0.0.1:4000/api/sso/oidc/.well-known/openid-configuration>

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式（tsx watch） |
| `pnpm build` / `pnpm start` | 构建 / 运行产物 |
| `pnpm typecheck` / `pnpm lint` | 类型检查 / 代码检查 |
| `pnpm test` / `pnpm e2e` | 全部测试 / 端到端流程测试 |
| `pnpm db:init` / `db:migrate` / `db:generate` | 初始化 / 迁移 / 生成迁移 |
| `pnpm db:seed` | 写入种子账号 |
| `pnpm user <cmd>` | 用户 CLI：create / set-role / set-password / disable / enable / list |
| `pnpm db:cleanup` | 清理过期的 OIDC 运行时数据（建议定时任务每天执行） |

## 关键流程（简要）

1. 前端跳 `{issuer}/auth`（authorization_code + PKCE）
2. 无会话时认证中心 302 到前端登录页（`LOGIN_UI_URL?interaction=uid`）
3. 登录页 `POST /api/sso/interaction/{uid}/login` 提交凭据 → 返回 `{redirectTo}`
4. 浏览器继续授权流程 → 回跳前端 `redirect_uri?code=...`
5. 前端直连 `POST /token` 换取 access / refresh / ID token
6. 前端带 `Authorization: Bearer` 调 `/api/gateway/**`（网关验签并注入身份头）

## 对接文档

- 前端仓库：[docs/frontend-integration.md](docs/frontend-integration.md)
- 网关仓库：[docs/gateway-integration.md](docs/gateway-integration.md)
- 部署与发布：[docs/deployment.md](docs/deployment.md)
- 方案与执行记录：[docs/auth-center-plan.md](docs/auth-center-plan.md)、[docs/implementation-plan.md](docs/implementation-plan.md)

## 目录结构

```
src/
├── app.ts / index.ts        # 组装与启动
├── config/env.ts            # 环境配置（zod 校验）
├── auth/                    # 登录交互、scrypt、角色等级
├── oidc/                    # provider 配置、Drizzle 适配器、JWKS、客户端注册
├── users/repository.ts      # 用户数据访问
└── db/                      # 连接与表结构
scripts/                     # init-db / seed / user CLI / cleanup
test/                        # vitest：单元 + e2e
drizzle/                     # 数据库迁移
```

## 安全说明

- 口令使用 scrypt 哈希存储；登录失败按 IP+用户名限速（15 分钟 5 次）
- access token 有效期 10 分钟；refresh token 与登录会话绑定、轮换签发；
  重放旧 refresh token 会触发泄露检测并撤销整条授权
- 生产环境必须配置 `NODE_ENV=production`、HTTPS、独立的 `OIDC_COOKIE_KEYS`
  与随机签名密钥（`JWKS_PATH` 或挂载密钥文件）
- 生产链路经过前端与后端两层 Nginx，使用 `TRUST_PROXY=2`，并将服务端口
  限制为只允许后端 Nginx 访问（防止伪造转发头影响登录限速）
- 数据库凭据只保存在本地 `.env`（已被 gitignore）
