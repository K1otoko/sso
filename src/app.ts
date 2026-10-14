import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from 'express';
import cors from 'cors';
import { sql } from 'drizzle-orm';

import { createInteractionRouter } from './auth/interaction.js';
import type { AppConfig } from './config/env.js';
import { OIDC_PATH } from './config/paths.js';
import type { Database } from './db/client.js';
import { loadOrCreateJwks } from './oidc/jwks.js';
import { createOidcProvider } from './oidc/provider.js';
import type { UsersRepository } from './users/repository.js';

export interface AppDependencies {
  config: AppConfig;
  database: Database;
  users: UsersRepository;
}

export function createApp({ config, database, users }: AppDependencies): Express {
  const app = express();
  const jwks = loadOrCreateJwks(config.jwksPath);
  const oidc = createOidcProvider({ config, database, users, jwks });

  app.disable('x-powered-by');
  // 生产链路包含前端与后端两层 Nginx，按实际代理跳数信任转发头；
  // 服务端口必须只允许最后一层 Nginx 访问，避免伪造转发头。
  app.set('trust proxy', config.trustProxy);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (origin === undefined || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );

  app.get('/', (_request, response) => {
    response.json({
      name: 'sso-server',
      issuer: config.oidcIssuer,
      discovery: `${config.oidcIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
    });
  });

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  // 就绪检查：数据库连通性（供容器健康检查 / 发布门禁使用；/health 仅代表进程存活）
  app.get('/health/ready', async (_request, response) => {
    try {
      await database.execute(sql`select 1`);
      response.json({ status: 'ready' });
    } catch (error) {
      console.error('readiness check failed', error);
      response.status(503).json({ status: 'unavailable' });
    }
  });

  app.use(express.json({ limit: '100kb' }));

  app.use(createInteractionRouter({ provider: oidc, users, config }));

  app.use(OIDC_PATH, oidc.callback() as RequestHandler);

  app.use((_request, response) => {
    response.status(404).json({ error: 'not_found' });
  });

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    console.error(error);
    if (response.headersSent) {
      return;
    }
    // 暴露型客户端错误（如 JSON 解析失败）按其状态码返回，其余统一 500
    const status = (error as { status?: unknown }).status;
    const expose = (error as { expose?: unknown }).expose === true;
    if (expose === true && typeof status === 'number' && status >= 400 && status < 500) {
      response.status(status).json({ error: 'invalid_request', message: '请求格式不正确' });
      return;
    }
    response.status(500).json({ error: 'internal_server_error' });
  };

  app.use(errorHandler);

  return app;
}
