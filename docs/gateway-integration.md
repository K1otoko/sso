# 网关对接文档（Fastify 网关，独立仓库）

> 认证中心（本仓库）对外界依赖的完整约定。
> **拓扑：前端 Nginx 将 `/api/**` 转到后端 Nginx；后端 Nginx 将
> `/api/sso/**` 路由到认证中心，将 `/api/gateway/**` 路由到 Gateway。**

## 1. 网关职责

| 动作 | 说明 |
| --- | --- |
| 保护 API | `/api/gateway/**` 校验用户 access token，验签失败一律 401 |
| 身份注入 | 剥离客户端传入的 `X-User-*`，验签通过后注入可信身份头 |
| 不做 | 不处理 `/api/sso/**`；该前缀由后端 Nginx 在进入 Gateway 前分流 |

## 2. 令牌校验（本地离线验签）

| 项 | 约定 |
| --- | --- |
| 算法 | ES256（从认证中心 `{issuer}/jwks` 获取公钥，按 `kid` 匹配，缓存并支持刷新；建议走内网地址拉取） |
| iss | 必须等于认证中心的 issuer，如 `https://sso.example.com/api/sso/oidc` |
| aud | 必须包含 `urn:sso:api` |
| 类型 | JWT（`typ: at+jwt`），没有 opaque token |
| 必须校验 | 签名、`iss`、`exp`、`aud`、`token_use=user` |
| 拒绝 | `token_use=service` 的令牌（服务令牌不面向公网）；时钟偏移容忍 60 秒 |

推荐实现：Fastify + `jose`（`createRemoteJWKSet`）。网关无需向认证中心注册身份、
也无需共享任何密钥，只用公开的 JWKS。

## 3. 身份头约定（注入给下游服务）

验签通过后注入；客户端传入的同名头必须先删除：

| 头 | 值 | 说明 |
| --- | --- | --- |
| `X-User-Id` | `sub` | 用户 ID（uuid） |
| `X-User-Role` | `role` | `super` / `admin` / `user` |
| `X-Request-Id` | 随机 ID | 链路追踪 |
| `Authorization` | 原样转发 | 服务可自行二次验签（纵深防御） |

下游信任这些头的前提：服务只在内网监听 + 网关已剥离客户端伪造头。

## 4. 错误语义

| 状态 | 场景 | 响应体 |
| --- | --- | --- |
| 401 | 缺令牌 / 验签失败 / 过期 | `{ "error": "invalid_token" }` + `WWW-Authenticate: Bearer` |
| 403 | 令牌有效但等级不足（如 `/admin/**` 需要 admin+） | `{ "error": "insufficient_role" }` |
| 404 | 未配置的路由（默认拒绝） | `{ "error": "not_found" }` |

等级比较规则：`super(3) > admin(2) > user(1)`，要求等级 ≥ 路由配置的最低等级。

## 5. 路由参考

| 路径 | 上游 | 要求 |
| --- | --- | --- |
| `/health` | 网关自身 | 公开 |
| `/api/sso/**` | 认证中心（由 Nginx 优先分流） | 不进入 Gateway |
| `/api/gateway/**` | 各业务服务 | 有效用户令牌（`token_use=user`） |
| 其他 | – | 404 |

## 6. 部署注意

- 认证中心 issuer 使用前端公开地址的 `/api/sso/oidc` 路径；网关验签时
  `iss` 必须完整匹配该值。
- 后端 Nginx 分别配置 `/api/sso/` 与 `/api/gateway/` location，
  两者都不能移除路径前缀。
- Gateway 无需代理认证中心，只负责验证认证中心签发的 access token。

## 7. 可用性说明（依赖关系）

- **认证中心故障**：存量 access token 离线验签仍可用（≤10 分钟），之后逐步全断；
  登录、换令牌、刷新失败。网关转发业务不受影响（不依赖认证中心在线）。
- **Gateway 应用故障**：只影响业务 API；Nginx 对 `/api/sso/**` 独立分流，
  登录链路不受影响。
- 提升可用性的建议：网关做无状态多副本 + 负载均衡与健康检查；
  认证中心同样可以多副本（会话与令牌已持久化在 PostgreSQL，不依赖进程内存；
  登录限速计数目前为单实例内存，可接受或后续换共享存储）。
