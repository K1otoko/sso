import { createHash, randomBytes } from 'node:crypto';

import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTERACTION_PATH, OIDC_PATH } from '../../src/config/paths.js';
import { createTestContext, ensureUser, type TestContext } from '../helpers/test-context.js';

const ISSUER = `http://127.0.0.1:4000${OIDC_PATH}`;
const REDIRECT_URI = 'http://127.0.0.1:5173/callback';
const FRONTEND_ORIGIN = 'http://127.0.0.1:5173';
const CLIENT_ID = 'web';
const SCOPE = 'openid profile email';

let context: TestContext;

beforeAll(async () => {
  context = createTestContext();
  await ensureUser(context.users, {
    username: 'e2e-user',
    password: 'e2e-password',
    role: 'admin',
  });
});

afterAll(async () => {
  await context.close();
});

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizationQuery(challenge: string, state: string): Record<string, string> {
  return {
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  };
}

async function beginAuthorization(
  agent: request.Agent,
  state: string,
): Promise<{ verifier: string; interactionPath: string }> {
  const { verifier, challenge } = createPkce();
  const response = await agent
    .get(`${OIDC_PATH}/auth`)
    .query(authorizationQuery(challenge, state))
    .expect(303);

  const location = response.headers.location;
  expect(location).toBeDefined();
  const interactionPath = new URL(location as string, ISSUER).pathname;
  expect(interactionPath.startsWith(`${INTERACTION_PATH}/`)).toBe(true);
  return { verifier, interactionPath };
}

/** 跟随重定向链（授权恢复 → consent → 发码），最终落到前端回调并取出 code。 */
async function followRedirectsToCode(agent: request.Agent, startUrl: string, state: string): Promise<string> {
  let current = startUrl;

  for (let hop = 0; hop < 8; hop += 1) {
    const url = new URL(current, ISSUER);
    const response = await agent.get(`${url.pathname}${url.search}`);
    expect([302, 303]).toContain(response.status);

    const location = response.headers.location;
    expect(location).toBeDefined();
    const next = new URL(location as string, ISSUER);

    if (next.origin === FRONTEND_ORIGIN) {
      expect(next.pathname).toBe('/callback');
      expect(next.searchParams.get('state')).toBe(state);
      const code = next.searchParams.get('code');
      if (code === null) {
        throw new Error('回调地址缺少 code 参数');
      }
      return code;
    }

    current = next.toString();
  }

  throw new Error('重定向次数超出预期');
}

describe('认证全流程（授权码 + PKCE）', () => {
  it('登录 → 换取令牌 → 刷新轮换 → SSO 免登录 → 登出', async () => {
    const agent = request.agent(context.app);
    const state = 'e2e-state-1';

    // 1. 发起授权 → 收到登录交互
    const { verifier, interactionPath } = await beginAuthorization(agent, state);

    // 2. GET 交互 → 跳到前端登录页（带 interaction uid）
    const uiRedirect = await agent.get(interactionPath).expect(302);
    const interactionUid = interactionPath.split('/').pop();
    expect(uiRedirect.headers.location).toBe(
      `http://127.0.0.1:5173/login?interaction=${interactionUid}`,
    );

    // 3. 错误密码 → 401（提示统一，不泄露账号是否存在）
    const wrong = await agent
      .post(`${interactionPath}/login`)
      .send({ username: 'e2e-user', password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body as unknown).toEqual({
      error: 'invalid_credentials',
      message: '用户名或密码错误',
    });

    // 4. 正确密码 → 200 { redirectTo }
    const login = await agent
      .post(`${interactionPath}/login`)
      .send({ username: 'e2e-user', password: 'e2e-password' })
      .expect(200);
    const loginBody = login.body as { redirectTo: string };
    expect(typeof loginBody.redirectTo).toBe('string');

    // 5. 跟随后续跳转拿到授权码
    const code = await followRedirectsToCode(agent, loginBody.redirectTo, state);

    // 6. 换令牌
    const tokenResponse = await agent
      .post(`${OIDC_PATH}/token`)
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      })
      .expect(200);

    const tokens = tokenResponse.body as {
      access_token: string;
      id_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(tokens.token_type).toBe('Bearer');
    expect(typeof tokens.refresh_token).toBe('string');

    // 7. access token 是 JWT，且可用 JWKS 离线验签
    const jwksResponse = await request(context.app).get(`${OIDC_PATH}/jwks`).expect(200);
    const keySet = createLocalJWKSet(
      jwksResponse.body as Parameters<typeof createLocalJWKSet>[0],
    );
    const verified = await jwtVerify(tokens.access_token, keySet, {
      issuer: ISSUER,
      audience: context.config.apiResource,
    });
    expect(verified.payload.sub).toBeDefined();
    expect(verified.payload.role).toBe('admin');
    expect(verified.payload.username).toBe('e2e-user');
    expect(verified.payload.token_use).toBe('user');

    // 8. ID token 带角色 claim
    const idClaims = decodeJwt(tokens.id_token);
    expect(idClaims.role).toBe('admin');
    expect(idClaims.preferred_username).toBe('e2e-user');

    // 9. refresh 轮换：拿到新的 refresh token（旧令牌的"重放拒绝"在下一个测试单独验证）
    const refreshed = await agent
      .post(`${OIDC_PATH}/token`)
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID })
      .expect(200);
    const refreshedBody = refreshed.body as { refresh_token: string };
    expect(refreshedBody.refresh_token).not.toBe(tokens.refresh_token);

    // 10. SSO：同一登录会话再次授权 → 不再出现登录页，直接发码
    const { challenge } = createPkce();
    const ssoAuthorize = await agent
      .get(`${OIDC_PATH}/auth`)
      .query(authorizationQuery(challenge, 'e2e-state-sso'));
    expect([302, 303]).toContain(ssoAuthorize.status);
    const ssoCallback = new URL(ssoAuthorize.headers.location as string, ISSUER);
    expect(ssoCallback.origin).toBe(FRONTEND_ORIGIN);
    expect(ssoCallback.searchParams.get('state')).toBe('e2e-state-sso');
    expect(ssoCallback.searchParams.get('code')).toBeTruthy();

    // 11. 登出：确认页 → POST confirm → 回跳 post_logout_redirect_uri
    const endSession = await agent
      .get(`${OIDC_PATH}/session/end`)
      .query({ client_id: CLIENT_ID, post_logout_redirect_uri: 'http://127.0.0.1:5173/' })
      .expect(200);
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(endSession.text)?.[1];
    expect(xsrf).toBeDefined();
    const confirmed = await agent
      .post(`${OIDC_PATH}/session/end/confirm`)
      .type('form')
      .send({ xsrf: xsrf as string, logout: 'yes' });
    expect([302, 303]).toContain(confirmed.status);
    expect(confirmed.headers.location).toBe('http://127.0.0.1:5173/');

    // 12. 登出后 refresh 失效
    await agent
      .post(`${OIDC_PATH}/token`)
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: refreshedBody.refresh_token,
        client_id: CLIENT_ID,
      })
      .expect(400);

    // 13. 登出后再次授权 → 需要重新登录
    const afterLogout = await agent
      .get(`${OIDC_PATH}/auth`)
      .query(authorizationQuery(createPkce().challenge, 'e2e-state-after-logout'))
      .expect(303);
    const nextInteractionPath = new URL(afterLogout.headers.location as string, ISSUER).pathname;
    const uiAgain = await agent.get(nextInteractionPath).expect(302);
    expect(uiAgain.headers.location).toContain('http://127.0.0.1:5173/login?interaction=');
  });

  it('refresh token 重放触发泄露检测：整个授权被撤销', async () => {
    const agent = request.agent(context.app);
    const state = 'e2e-state-replay';

    const { verifier, interactionPath } = await beginAuthorization(agent, state);
    const login = await agent
      .post(`${interactionPath}/login`)
      .send({ username: 'e2e-user', password: 'e2e-password' })
      .expect(200);
    const code = await followRedirectsToCode(
      agent,
      (login.body as { redirectTo: string }).redirectTo,
      state,
    );
    const tokens = (
      await agent
        .post(`${OIDC_PATH}/token`)
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        })
        .expect(200)
    ).body as { refresh_token: string };

    // 正常轮换一次
    const rotated = (
      await agent
        .post(`${OIDC_PATH}/token`)
        .type('form')
        .send({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: CLIENT_ID,
        })
        .expect(200)
    ).body as { refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // 重放已经被轮换掉的旧 refresh token → 400，且触发泄露检测
    await agent
      .post(`${OIDC_PATH}/token`)
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
      })
      .expect(400);

    // 泄露检测：整条授权的令牌全部作废（连最新的 refresh token 也不可用）
    await agent
      .post(`${OIDC_PATH}/token`)
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: rotated.refresh_token,
        client_id: CLIENT_ID,
      })
      .expect(400);
  });

  it('连续错误登录触发限速（429）', async () => {
    const agent = request.agent(context.app);
    const { interactionPath } = await beginAuthorization(agent, 'e2e-state-ratelimit');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await agent
        .post(`${interactionPath}/login`)
        .send({ username: 'e2e-ratelimit-user', password: 'wrong-password' });
      expect(response.status).toBe(401);
    }

    const limited = await agent
      .post(`${interactionPath}/login`)
      .send({ username: 'e2e-ratelimit-user', password: 'wrong-password' });
    expect(limited.status).toBe(429);
    expect((limited.body as { error: string }).error).toBe('too_many_attempts');
  });

  it('未登录状态直接访问受保护流程会要求登录（无 Cookie 时交互会话缺失）', async () => {
    const anonymous = request.agent(context.app);
    const { interactionPath } = await beginAuthorization(anonymous, 'e2e-state-anon');

    // 模拟"没有交互 Cookie"的外部请求（例如他人伪造链接直接打开交互 URL）
    const response = await request(context.app).get(interactionPath);
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe('interaction_expired');
  });
});

describe('健康检查', () => {
  it('就绪探针 /health/ready 在数据库可用时返回 ready', async () => {
    const response = await request(context.app).get('/health/ready');
    expect(response.status).toBe(200);
    expect((response.body as { status: string }).status).toBe('ready');
  });
});
