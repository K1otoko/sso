import Provider, { errors, type Configuration } from 'oidc-provider';

import type { AppConfig } from '../config/env.js';
import { INTERACTION_PATH } from '../config/paths.js';
import type { Database } from '../db/client.js';
import type { UsersRepository } from '../users/repository.js';
import { createAdapterFactory } from './adapter.js';
import { buildClients, FIRST_PARTY_CLIENT_IDS } from './clients.js';
import type { Jwks } from './jwks.js';

const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
const ID_TOKEN_TTL_SECONDS = 10 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const INTERACTION_TTL_SECONDS = 60 * 60;
const GRANT_TTL_SECONDS = 14 * 24 * 60 * 60;
const CLIENT_CREDENTIALS_TTL_SECONDS = 5 * 60;

const RESOURCE_SERVER_SCOPES = 'openid profile email';

export interface OidcProviderDependencies {
  config: AppConfig;
  database: Database;
  users: UsersRepository;
  jwks: Jwks;
}

export function createOidcProvider(deps: OidcProviderDependencies): Provider {
  const { config, database, users, jwks } = deps;
  // Cookie 的 Secure 属性跟随对外地址的协议：
  // HTTPS 部署启用；纯 HTTP 部署（IP/内网联调阶段）必须关闭，
  // 否则 koa 发送 cookie 时会直接抛错（表现为所有登录请求 500）。
  const secureCookies = new URL(config.oidcIssuer).protocol === 'https:';

  const configuration: Configuration = {
    adapter: createAdapterFactory(database),
    clients: buildClients(config),
    jwks: { keys: jwks.keys },
    claims: {
      openid: ['sub'],
      profile: ['name', 'preferred_username', 'role'],
      email: ['email'],
    },
    // 让 scope 请求的 claims 同时进入 ID token（SPA 直接读令牌，不依赖 userinfo）
    conformIdTokenClaims: false,
    // 密钥集只有 ES256，客户端默认签名算法保持一致
    clientDefaults: {
      id_token_signed_response_alg: 'ES256',
    },
    cookies: {
      keys: config.oidcCookieKeys,
      long: {
        secure: secureCookies,
        sameSite: 'lax',
      },
      short: {
        secure: secureCookies,
        sameSite: 'lax',
      },
    },
    features: {
      // 登录页面由前端仓库实现，认证中心通过 /api/sso/interaction 提供交互 API
      devInteractions: { enabled: false },
      // 关闭 userinfo：access token 为带 aud 的 JWT（供网关/服务离线验签），
      // 本就与 userinfo 端点不兼容；前端从 ID token 读取身份 claims。
      userinfo: { enabled: false },
      // 通过 resource indicators 启用 JWT 格式的 access token（供网关/服务离线验签）
      resourceIndicators: {
        enabled: true,
        defaultResource: () => config.apiResource,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== config.apiResource) {
            throw new errors.InvalidTarget('resource indicator is not allowed');
          }
          return {
            scope: RESOURCE_SERVER_SCOPES,
            audience: config.apiResource,
            accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
            accessTokenFormat: 'jwt',
          };
        },
      },
    },
    interactions: {
      url: (_ctx, interaction) => `${INTERACTION_PATH}/${interaction.uid}`,
    },
    findAccount: async (_ctx, id) => {
      const user = await users.findById(id);
      if (user === undefined || user.status !== 'active') {
        return undefined;
      }
      return {
        accountId: user.id,
        claims: () => ({
          sub: user.id,
          preferred_username: user.username,
          role: user.role,
          ...(user.displayName !== null ? { name: user.displayName } : {}),
          ...(user.email !== null ? { email: user.email } : {}),
        }),
      };
    },
    extraTokenClaims: async (ctx) => {
      const accountId = ctx.oidc.account?.accountId;
      if (accountId === undefined) {
        // 预留：服务间认证（client_credentials）下一轮启用
        return { token_use: 'service' };
      }
      const user = await users.findById(accountId);
      if (user === undefined) {
        return undefined;
      }
      return { role: user.role, username: user.username, token_use: 'user' };
    },
    // 续期策略：首方客户端的 refresh token 与登录会话绑定
    //（登出即失效；不依赖 offline_access，前端无需 prompt=consent 参数）
    issueRefreshToken: (_ctx, client) => {
      if (!client.grantTypeAllowed('refresh_token')) {
        return false;
      }
      return FIRST_PARTY_CLIENT_IDS.has(client.clientId);
    },
    pkce: {
      required: () => true,
    },
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_SECONDS,
      IdToken: ID_TOKEN_TTL_SECONDS,
      RefreshToken: REFRESH_TOKEN_TTL_SECONDS,
      Session: SESSION_TTL_SECONDS,
      Interaction: INTERACTION_TTL_SECONDS,
      Grant: GRANT_TTL_SECONDS,
      ClientCredentials: CLIENT_CREDENTIALS_TTL_SECONDS,
    },
  };

  const provider = new Provider(config.oidcIssuer, configuration);
  provider.proxy = true;

  return provider;
}
