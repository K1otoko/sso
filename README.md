# SSO Server

基于 Express 5、`oidc-provider`、PostgreSQL、Drizzle ORM 和 TypeScript 的
OpenID Connect 服务端骨架。

## 环境要求

- Node.js 24 或更高版本
- npm 10 或更高版本
- PostgreSQL 仅在执行迁移或启用数据库代码时需要

```bash
nvm use
npm install
cp .env.example .env
npm run dev
```

默认访问地址：

- 服务信息：<http://127.0.0.1:4000/>
- 健康检查：<http://127.0.0.1:4000/health>
- OIDC Discovery：<http://127.0.0.1:4000/oidc/.well-known/openid-configuration>

## 本地 OIDC 客户端

开发环境内置一个用于联调的客户端：

| 配置 | 值 |
| --- | --- |
| Client ID | `local-client` |
| Client Secret | `local-client-secret` |
| Redirect URI | `http://127.0.0.1:3000/callback` |
| Grant Types | `authorization_code`, `refresh_token` |

开发环境启用了 `oidc-provider` 自带的交互页面，可使用任意用户名和密码完成
本地授权流程。PKCE 是必需的。生产环境会自动禁用该页面。

## 常用命令

```bash
npm run dev
npm run typecheck
npm run lint
npm run build
npm start
```

## 数据库

当前服务启动时不会创建 PostgreSQL 连接。数据库工厂位于
`src/db/client.ts`，只有显式调用 `createDatabase()` 后才会创建连接池。

初始用户表定义位于 `src/db/schema.ts`。配置 `DATABASE_URL` 后可执行：

```bash
npm run db:generate
npm run db:migrate
npm run db:studio
```

当前 OIDC 数据使用 `oidc-provider` 的内存适配器，进程重启后会丢失。上线前
需要实现持久化适配器、真实登录交互、密钥管理，并替换示例客户端凭据。
