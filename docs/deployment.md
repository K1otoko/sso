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
OIDC_ISSUER=https://<前端公网域名>/api/sso/oidc
DATABASE_URL=postgresql://...
OIDC_COOKIE_KEYS=<随机长字符串,随机长字符串>
LOGIN_UI_URL=https://<前端域名>/login
CORS_ORIGINS=https://<前端域名>
WEB_CLIENT_REDIRECT_URIS=https://<前端域名>/callback
API_RESOURCE=urn:sso:api
TRUST_PROXY=2
SSO_BIND_ADDRESS=127.0.0.1
SSO_PORT=4400
```

可选覆盖：`SSO_BIND_ADDRESS`（默认 `127.0.0.1`）、`SSO_PORT`（默认 `4000`）、
`TRUST_PROXY`（Compose 默认 `2`）、`SECRETS_PATH`（默认 `./secrets`）。

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

## 7. Nginx 反向代理（当前生产拓扑）

- **公开路径**：`https://<前端域名>/api/sso/**`
- **前端 Nginx**：将全部 `/api/**` 原样转发到后端服务器的 Nginx
- **后端 Nginx**：只监听 `80`；优先将 `/api/sso/**` 转发到
  `http://127.0.0.1:4400`，将 `/api/gateway/**` 交给 Gateway
- **配置归档**：[deploy/nginx/sso.conf](../deploy/nginx/sso.conf) 是
  `location` 路由片段，必须包含在后端统一的 `server { listen 80; }` 中，
  不能单独软链到 `sites-enabled`
- **路径要求**：`proxy_pass` 后不能添加 `/`，否则会移除
  `/api/sso/` 前缀，导致 issuer 与实际端点不一致
- **代理信任**：请求经过前端和后端两层 Nginx，因此使用
  `TRUST_PROXY=2`
- **Cookie**：`Secure` 属性跟随 `OIDC_ISSUER` 的 HTTPS 协议自动启用

后端 `80` 通过公网接收前端 Nginx 流量时，必须在安全组中仅允许前端服务器
公网 IP。该限制不提供链路加密，生产环境仍建议为两台服务器之间增加 HTTPS
回源或加密隧道。

前端 Nginx 的转发必须保留 `/api` 路径和公网协议信息：

```nginx
location ^~ /api/ {
    # 结尾不能添加 `/`
    proxy_pass http://<后端公网 IP>;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Port $server_port;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

后端统一站点为 SSO 与 Gateway 使用互不重叠的明确前缀：

```nginx
server {
    listen 80;
    server_name _;

    allow <前端服务器公网 IP>;
    deny all;

    include /project/sso/nginx/sso.conf;

    location = /api/gateway {
        return 308 /api/gateway/;
    }

    location ^~ /api/gateway/ {
        proxy_pass http://127.0.0.1:<Gateway 端口>;
    }

    location / {
        return 404;
    }
}
```
