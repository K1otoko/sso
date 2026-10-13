# 部署与发布（GitHub Actions → 阿里云 ACR → 服务器 Docker Compose）

> 与 gateway 仓库同一套发布模式：push 到 `master` 即触发
> 「校验 → 构建镜像 → SSH 部署」，部署失败自动回滚。

## 1. 发布流程总览

1. **verify**：pnpm 安装 → typecheck → test（连 `sso_test` 测试库）→ build
2. **build**：构建 Docker 镜像并推送到阿里云 ACR（tag：`git sha` + `latest`）
3. **deploy**：SSH 到目标服务器，上传 `compose.yaml`、更新镜像版本文件，
   执行 `docker compose up -d --wait`（健康检查 = `/health/ready`），
   失败自动回滚到上一版本

## 2. GitHub 需要配置的内容

仓库 Settings → Secrets and variables → Actions：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `ACR_USERNAME` / `ACR_PASSWORD` | 阿里云容器镜像仓库凭据 |
| Secret | `DEPLOY_HOST` / `DEPLOY_PORT` / `DEPLOY_USER` / `DEPLOY_PATH` | SSH 部署目标 |
| Secret | `DEPLOY_SSH_KEY` / `DEPLOY_KNOWN_HOSTS` | 部署私钥与 known_hosts |
| Secret | `TEST_DATABASE_URL` | `sso_test` 库连接串（CI 跑测试用） |
| Variable | `ACR_IMAGE` | 镜像地址，`registry/namespace/image` 格式，如 `registry.cn-hangzhou.aliyuncs.com/<命名空间>/sso` |

建议创建 `production` environment（build / deploy 两个 Job 已挂在它下面，
可加保护规则）。首次推送时如果 secrets 未配置，workflow 会失败（预期行为），
配置完成后在 Actions 页 Re-run 即可。

## 3. 服务器一次性准备

1. 安装 Docker + Compose 插件
2. 登录镜像仓库：`docker login <registry>`（服务器要能拉取镜像）
3. 在 `DEPLOY_PATH` 下准备运行时 `.env`（含下面这些变量）
4. 准备签名密钥目录并授权给容器内用户（uid 1000）：

   ```bash
   install -d -o 1000 -g 1000 <DEPLOY_PATH>/secrets
   ```

   JWKS 签名密钥会持久化在这里：升级不换密钥，多副本可共享同一目录。

服务器 `.env` 至少包含：

```
NODE_ENV=production
OIDC_ISSUER=https://<认证中心公网域名>/oidc
DATABASE_URL=postgresql://...
OIDC_COOKIE_KEYS=<随机长字符串,随机长字符串>
LOGIN_UI_URL=https://<前端域名>/login
CORS_ORIGINS=https://<前端域名>
WEB_CLIENT_REDIRECT_URIS=https://<前端域名>/callback
API_RESOURCE=urn:sso:api
```

可选覆盖：`SSO_BIND_ADDRESS`（默认 `127.0.0.1`）、`SSO_PORT`（默认 `4000`）、
`TRUST_PROXY`（默认 `1`）、`SECRETS_PATH`（默认 `./secrets`）。

## 4. 数据库迁移

迁移不随发布自动执行：发布包含 schema 变更的版本前，
先用 `pnpm db:migrate` 单独执行迁移。

## 5. 回滚

- **自动**：deploy 步骤失败会自动恢复上一版 `.image.env` 并重新拉起
- **手动**：在 Actions 里重跑历史上任意一次成功的 workflow，
  或直接修改服务器 `.image.env` 里的 `IMAGE_TAG` 后 `docker compose up -d`

## 6. 注意事项

- 健康检查用的 `/health/ready` 会检查数据库连通性：数据库不可用时
  部署会被判定失败并触发回滚（这是有意的门禁）
- 部署机器上需要已登录 ACR，容器才能拉取私有镜像
- 本仓库分支必须是 `master`（或在 workflow 里改触发分支）

## 7. nginx 反向代理（当前生产拓扑）

- **对外入口**：`http://82.157.201.240:4000`（nginx），与 gateway 同机不同端口
- **配置归档**：[deploy/nginx/sso.conf](../deploy/nginx/sso.conf)；
  服务器上位于 `/project/sso/nginx/sso.conf`，
  软链到 `/etc/nginx/sites-enabled/sso`（nginx -t 后 reload 生效）
- **上游**：`http://127.0.0.1:4400` —— 服务端 `.env` 中 `SSO_PORT=4400`，
  把 4000 端口让给 nginx；compose 默认值（4000）不受影响
- **关键细节**：`proxy_set_header Host $http_host` 必须保留端口，
  否则 discovery 与授权跳转地址会缺少 `:4000`（`$host` 会丢端口）
- **Cookie**：`Secure` 属性跟随 `OIDC_ISSUER` 协议——纯 HTTP 阶段自动关闭
  （否则 koa 发 cookie 会抛错、登录接口全部 500）；将来换
  `https://<域名>/oidc` + TLS 后会自行启用
