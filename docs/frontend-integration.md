# 前端对接文档（SSO 认证中心）

> 适用：前端仓库（独立开发）。登录页面由前端实现，认证中心提供交互 API。
> 联调环境默认值：issuer = `http://127.0.0.1:4000/oidc`，前端 origin = `http://127.0.0.1:5173`。
> 认证中心为基础设施独立入口：issuer 就是认证中心自己的地址（生产为其公网域名），
> 登录链路不经过业务网关。

## 1. 基本信息

| 项 | 值 |
| --- | --- |
| issuer | `http://127.0.0.1:4000/oidc` |
| discovery | `{issuer}/.well-known/openid-configuration` |
| client_id | `web`（public client，无 client_secret） |
| 授权类型 | `authorization_code` + PKCE（S256，必需） |
| scope | `openid profile email` |
| 回跳地址 | `http://127.0.0.1:5173/callback`（白名单；改地址需在认证中心 .env 登记） |
| 登出回跳 | `http://127.0.0.1:5173/`（post_logout_redirect_uri，白名单） |

## 2. 登录流程

1. **发起授权**：生成 PKCE `code_verifier`（随机 43–128 字符）与
   `code_challenge = base64url(sha256(verifier))`，跳转：

   ```
   GET {issuer}/auth
     ?client_id=web
     &response_type=code
     &scope=openid profile email
     &redirect_uri=http://127.0.0.1:5173/callback
     &code_challenge={challenge}
     &code_challenge_method=S256
     &state={前端生成的随机值}
   ```

2. **无登录会话时**：认证中心 302 到登录页
   `{LOGIN_UI_URL}?interaction={uid}`（默认 `http://127.0.0.1:5173/login`）。

3. **提交凭据**（登录页 JS，`fetch` + `credentials: 'include'`）：

   ```
   POST {issuer}/interaction/{uid}/login
   Content-Type: application/json
   { "username": "...", "password": "..." }
   ```

   | 结果 | 响应 |
   | --- | --- |
   | 成功 | `200 { "redirectTo": "..." }` |
   | 凭据错误 | `401 { "error": "invalid_credentials", "message": "用户名或密码错误" }` |
   | 失败过多 | `429 { "error": "too_many_attempts", ... }`（同 IP+用户名 15 分钟 5 次） |

4. **继续流程**：`location.href = redirectTo`；浏览器经认证中心自动续跑，
   最终落回 `redirect_uri?code=...&state=...`（校验 state）。

5. **换取令牌**（浏览器直连，SPA 模式）：

   ```
   POST {issuer}/token
   Content-Type: application/x-www-form-urlencoded
   grant_type=authorization_code&code=...&redirect_uri=...&client_id=web&code_verifier=...
   ```

6. **调用业务 API**：`Authorization: Bearer <access_token>`（经网关）。

> 提示：可以直接使用现成库（如 `oidc-client-ts`），配置 issuer / client_id /
> redirect_uri / scope；登录页按第 3 步对接交互接口。

## 3. 令牌说明

| 令牌 | 有效期 | 说明 |
| --- | --- | --- |
| access_token | 10 分钟 | JWT（ES256）。claims：`sub` `role`（super/admin/user）`username` `token_use=user` `aud=urn:sso:api` `exp` |
| id_token | 10 分钟 | JWT。claims：`sub` `role` `preferred_username` `name`、`email`（请求 email scope 时） |
| refresh_token | 14 天 | 与登录会话绑定（登出即失效）；每次刷新都会轮换 |

重要行为：

- `userinfo` 端点未启用：身份信息直接读 **ID token**、不依赖 userinfo。
- 刷新令牌轮换：刷新成功后旧 refresh_token 立即作废；重放旧 refresh_token
  会触发泄露检测，**整条授权（全部令牌）作废、需要重新登录**。
  前端务必只在刷新成功后丢弃旧令牌，不要重试旧令牌。

## 4. 单点登录（SSO）行为

- 同一浏览器任一端登录后，认证中心持有会话 cookie（7 天滚动）；
  其他应用再发起授权时不再出现登录页，直接回跳拿 code。
- 登录一次覆盖所有接入认证中心的应用（新增应用 = 注册新的 client）。

## 5. 登出

浏览器跳转：

```
GET {issuer}/session/end?client_id=web&post_logout_redirect_uri=http://127.0.0.1:5173/
```

认证中心显示内置确认页，用户确认后回跳 `post_logout_redirect_uri`。
登出后：会话与 refresh_token 立即失效；已签发 access token 在剩余有效期内
（≤10 分钟）自然过期。

## 6. 跨域（CORS）

以下端点已对前端 origin 白名单放行（请求需带凭据）：

- `POST {issuer}/interaction/{uid}/login`
- `POST {issuer}/token`

新增前端域名时，在认证中心 `.env` 的 `CORS_ORIGINS` /
`WEB_CLIENT_REDIRECT_URIS` 登记后重启。

## 7. 错误处理建议

| 场景 | 处理 |
| --- | --- |
| 登录 401 | 原地提示「用户名或密码错误」 |
| 登录 429 | 提示稍后再试（可展示 retry_after 秒数） |
| 回跳带 error | 校验 state 后按 error / error_description 提示 |
| API 401 | access token 过期 → 先 refresh；refresh 失败 → 重新走登录流程 |
