import Provider, { type Configuration } from 'oidc-provider';

import type { AppConfig } from '../config/env.js';

const localClient: NonNullable<Configuration['clients']>[number] = {
  client_id: 'local-client',
  client_secret: 'local-client-secret',
  grant_types: ['authorization_code', 'refresh_token'],
  redirect_uris: ['http://127.0.0.1:3000/callback'],
  response_types: ['code'],
  token_endpoint_auth_method: 'client_secret_basic',
};

export function createOidcProvider(config: AppConfig): Provider {
  const configuration: Configuration = {
    clients: [localClient],
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name'],
    },
    cookies: {
      keys: config.oidcCookieKeys,
      long: {
        secure: config.nodeEnv === 'production',
        sameSite: 'lax',
      },
      short: {
        secure: config.nodeEnv === 'production',
        sameSite: 'lax',
      },
    },
    features: {
      devInteractions: {
        enabled: config.nodeEnv !== 'production',
      },
    },
    findAccount: (_context, accountId) => ({
      accountId,
      claims: () => ({ sub: accountId }),
    }),
    pkce: {
      required: () => true,
    },
  };

  const provider = new Provider(config.oidcIssuer, configuration);
  provider.proxy = true;

  return provider;
}
