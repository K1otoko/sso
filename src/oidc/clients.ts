import type { ClientMetadata } from 'oidc-provider';

import type { AppConfig } from '../config/env.js';

/** 首方客户端：自动跳过 consent、自动获得续期令牌（管理面落地前用常量维护）。 */
export const FIRST_PARTY_CLIENT_IDS = new Set(['web']);

/**
 * 客户端注册表（v1 配置驱动，管理面落地后迁移到数据库）。
 * 当前只有前端 `web`：public client + PKCE，浏览器直连 token 端点。
 * 服务间认证客户端（client_credentials）下一轮加入。
 */
export function buildClients(config: AppConfig): ClientMetadata[] {
  const redirectUris = config.webClientRedirectUris;
  const postLogoutRedirectUris = [
    ...new Set(redirectUris.map((uri) => `${new URL(uri).origin}/`)),
  ];

  return [
    {
      client_id: 'web',
      client_name: 'Web Frontend',
      application_type: 'web',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: redirectUris,
      post_logout_redirect_uris: postLogoutRedirectUris,
      scope: 'openid profile email',
    },
  ];
}
