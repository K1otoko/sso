import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from 'express';

import type { AppConfig } from './config/env.js';
import { createOidcProvider } from './oidc/provider.js';

export function createApp(config: AppConfig): Express {
  const app = express();
  const oidc = createOidcProvider(config);
  const issuerUrl = new URL(config.oidcIssuer);
  const oidcMountPath =
    issuerUrl.pathname === '/' ? '/' : issuerUrl.pathname.replace(/\/$/, '');

  app.disable('x-powered-by');

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
    response.status(500).json({ error: 'internal_server_error' });
  };

  app.use(errorHandler);

  return app;
}
