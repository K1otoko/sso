import { z } from 'zod';

import { OIDC_PATH } from './paths.js';

const developmentCookieKeys = [
  'development-cookie-key-change-before-deploying-1',
  'development-cookie-key-change-before-deploying-2',
];

const developmentLoginUiUrl = 'http://127.0.0.1:5173/login';
const developmentCorsOrigins = 'http://127.0.0.1:5173';
const developmentRedirectUris = 'http://127.0.0.1:5173/callback';
const defaultApiResource = 'urn:sso:api';

const oidcIssuerSchema = z.url().refine(
  (value) => {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, '');
    return pathname === OIDC_PATH && url.search === '' && url.hash === '';
  },
  {
    message: `OIDC_ISSUER must use the ${OIDC_PATH} path without query or fragment`,
  },
);

function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    OIDC_ISSUER: oidcIssuerSchema.optional(),
    OIDC_COOKIE_KEYS: z.string().optional(),
    DATABASE_URL: z.url().optional(),
    TEST_DATABASE_URL: z.url().optional(),
    LOGIN_UI_URL: z.url().default(developmentLoginUiUrl),
    CORS_ORIGINS: z.string().default(developmentCorsOrigins),
    WEB_CLIENT_REDIRECT_URIS: z.string().default(developmentRedirectUris),
    JWKS_PATH: z.string().min(1).default('./secrets/jwks.json'),
    API_RESOURCE: z.string().min(1).default(defaultApiResource),
    TRUST_PROXY: z.string().default('false'),
  })
  .superRefine((environment, context) => {
    if (
      environment.NODE_ENV === 'production' &&
      !environment.OIDC_COOKIE_KEYS?.split(',').some(
        (key) => key.trim().length > 0,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['OIDC_COOKIE_KEYS'],
        message: 'OIDC_COOKIE_KEYS is required in production',
      });
    }

    if (environment.NODE_ENV === 'production' && !environment.DATABASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL is required in production',
      });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  oidcIssuer: string;
  oidcCookieKeys: string[];
  databaseUrl: string | undefined;
  testDatabaseUrl: string | undefined;
  loginUiUrl: string;
  corsOrigins: string[];
  webClientRedirectUris: string[];
  jwksPath: string;
  apiResource: string;
  trustProxy: boolean | number | string;
}

/**
 * TRUST_PROXY 取值：
 * - "false"：不信任任何代理（直连部署）
 * - 数字：信任前 N 跳（当前生产链路前端 + 后端 Nginx 共 2 跳）
 * - 其他字符串：按 express trust proxy 规则原样传入（如 IP/CIDR）
 */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const configuredCookieKeys = splitCommaList(parsed.OIDC_COOKIE_KEYS ?? '');

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    oidcIssuer:
      parsed.OIDC_ISSUER ??
      `http://${parsed.HOST}:${String(parsed.PORT)}${OIDC_PATH}`,
    oidcCookieKeys:
      configuredCookieKeys === undefined || configuredCookieKeys.length === 0
        ? developmentCookieKeys
        : configuredCookieKeys,
    databaseUrl: parsed.DATABASE_URL,
    testDatabaseUrl: parsed.TEST_DATABASE_URL,
    loginUiUrl: parsed.LOGIN_UI_URL,
    corsOrigins: splitCommaList(parsed.CORS_ORIGINS),
    webClientRedirectUris: splitCommaList(parsed.WEB_CLIENT_REDIRECT_URIS),
    jwksPath: parsed.JWKS_PATH,
    apiResource: parsed.API_RESOURCE,
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
  };
}
