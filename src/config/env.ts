import { z } from 'zod';

const developmentCookieKeys = [
  'development-cookie-key-change-before-deploying-1',
  'development-cookie-key-change-before-deploying-2',
];

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    OIDC_ISSUER: z.url().optional(),
    OIDC_COOKIE_KEYS: z.string().optional(),
    DATABASE_URL: z.url().optional(),
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
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  oidcIssuer: string;
  oidcCookieKeys: string[];
  databaseUrl: string | undefined;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const configuredCookieKeys = parsed.OIDC_COOKIE_KEYS?.split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    oidcIssuer:
      parsed.OIDC_ISSUER ??
      `http://${parsed.HOST}:${String(parsed.PORT)}/oidc`,
    oidcCookieKeys:
      configuredCookieKeys === undefined || configuredCookieKeys.length === 0
        ? developmentCookieKeys
        : configuredCookieKeys,
    databaseUrl: parsed.DATABASE_URL,
  };
}
