import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from 'express';
import cors from 'cors';

import { createInteractionRouter } from './auth/interaction.js';
import type { AppConfig } from './config/env.js';
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
  const issuerUrl = new URL(config.oidcIssuer);
  const oidcMountPath =
    issuerUrl.pathname === '/' ? '/' : issuerUrl.pathname.replace(/\/$/, '');

  app.disable('x-powered-by');
  // 独立入口部署：前置自有 LB/WAF 时按第一跳信任 X-Forwarded-For（限速取真实客户端 IP）；
  // 生产需限制服务端口只允许 LB 访问，避免伪造转发头。
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

  app.use(express.json({ limit: '100kb' }));

  app.use(createInteractionRouter({ provider: oidc, users, config }));

  app.use(oidcMountPath, oidc.callback() as RequestHandler);

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
