import { Router, type Request, type Response } from 'express';
import { errors } from 'oidc-provider';
import type Provider from 'oidc-provider';
import { z } from 'zod';

import type { AppConfig } from '../config/env.js';
import { INTERACTION_PATH } from '../config/paths.js';
import { LoginRateLimiter } from '../middleware/login-rate-limit.js';
import { FIRST_PARTY_CLIENT_IDS } from '../oidc/clients.js';
import type { UsersRepository } from '../users/repository.js';
import { verifyPassword } from './password.js';

const loginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

interface ConsentPromptDetails {
  missingOIDCScope?: string[];
  missingOIDCClaims?: string[];
  missingResourceScopes?: Record<string, string[]>;
}

export interface InteractionDependencies {
  provider: Provider;
  users: UsersRepository;
  config: AppConfig;
  rateLimiter?: LoginRateLimiter;
}

/**
 * 登录交互 API（登录页面由前端仓库实现）：
 * - GET  /api/sso/interaction/:uid        未登录 → 302 到前端登录页；已登录 → 直接完成登录步骤
 * - POST /api/sso/interaction/:uid/login  提交凭据（限速 + scrypt 校验），返回 { redirectTo }
 * - GET  /api/sso/interaction/:uid        授权确认（consent）：首方客户端自动通过
 */
export function createInteractionRouter(deps: InteractionDependencies): Router {
  const { provider, users, config } = deps;
  const limiter = deps.rateLimiter ?? new LoginRateLimiter();
  const router = Router();

  router.get(`${INTERACTION_PATH}/:uid`, async (request, response, next) => {
    try {
      const details = await provider.interactionDetails(request, response);
      const promptName = details.prompt.name;

      if (promptName === 'login') {
        const accountId = details.session?.accountId;
        if (accountId !== undefined) {
          // 已有登录会话（SSO）：直接完成登录步骤，不再询问凭据
          const redirectTo = await provider.interactionResult(
            request,
            response,
            { login: { accountId } },
            { mergeWithLastSubmission: false },
          );
          response.redirect(303, redirectTo);
          return;
        }

        const loginUrl = new URL(config.loginUiUrl);
        loginUrl.searchParams.set('interaction', details.uid);
        response.redirect(302, loginUrl.toString());
        return;
      }

      if (promptName === 'consent') {
        await autoApproveConsent(provider, request, response);
        return;
      }

      response.status(501).json({
        error: 'unsupported_interaction',
        message: `暂不支持的交互步骤: ${promptName}`,
      });
    } catch (error) {
      if (error instanceof errors.SessionNotFound) {
        response.status(400).json({
          error: 'interaction_expired',
          message: '登录会话已过期，请重新发起登录',
        });
        return;
      }
      next(error);
    }
  });

  router.post(`${INTERACTION_PATH}/:uid/login`, async (request, response, next) => {
    try {
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name !== 'login') {
        response.status(409).json({ error: 'prompt_mismatch', message: '当前交互不是登录步骤' });
        return;
      }

      const parsed = loginBodySchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'invalid_request', message: '请输入用户名和密码' });
        return;
      }

      const { username, password } = parsed.data;
      const rateKey = `${request.ip ?? 'unknown'}|${username.toLowerCase()}`;

      const verdict = limiter.check(rateKey);
      if (!verdict.allowed) {
        response.status(429).json({
          error: 'too_many_attempts',
          message: '尝试次数过多，请稍后再试',
          retry_after: verdict.retryAfterSeconds ?? null,
        });
        return;
      }

      const user = await users.findByUsername(username);
      const valid =
        user !== undefined &&
        user.status === 'active' &&
        (await verifyPassword(password, user.passwordHash));

      if (!valid) {
        limiter.recordFailure(rateKey);
        response.status(401).json({ error: 'invalid_credentials', message: '用户名或密码错误' });
        return;
      }

      limiter.reset(rateKey);
      await users.touchLogin(user.id);

      const redirectTo = await provider.interactionResult(
        request,
        response,
        { login: { accountId: user.id } },
        { mergeWithLastSubmission: false },
      );
      response.json({ redirectTo });
    } catch (error) {
      if (error instanceof errors.SessionNotFound) {
        response.status(400).json({
          error: 'interaction_expired',
          message: '登录会话已过期，请重新发起登录',
        });
        return;
      }
      next(error);
    }
  });

  return router;
}

/**
 * 首方客户端自动通过授权确认（consent）：
 * 逻辑与 oidc-provider 内置 devInteractions 的 consent 提交一致，只是没有页面。
 */
async function autoApproveConsent(
  provider: Provider,
  request: Request,
  response: Response,
): Promise<void> {
  const details = await provider.interactionDetails(request, response);
  const clientId = details.params.client_id;

  if (typeof clientId !== 'string' || !FIRST_PARTY_CLIENT_IDS.has(clientId)) {
    response.status(501).json({
      error: 'unsupported_client',
      message: '该客户端需要人工确认授权，暂未支持',
    });
    return;
  }

  let grant =
    details.grantId !== undefined ? await provider.Grant.find(details.grantId) : undefined;

  if (grant === undefined) {
    const accountId = details.session?.accountId;
    if (accountId === undefined) {
      response.status(400).json({ error: 'session_required', message: '缺少登录会话' });
      return;
    }
    grant = new provider.Grant({ accountId, clientId });
  }

  const promptDetails = details.prompt.details as ConsentPromptDetails;

  if (promptDetails.missingOIDCScope !== undefined && promptDetails.missingOIDCScope.length > 0) {
    grant.addOIDCScope(promptDetails.missingOIDCScope.join(' '));
  }
  if (promptDetails.missingOIDCClaims !== undefined && promptDetails.missingOIDCClaims.length > 0) {
    grant.addOIDCClaims(promptDetails.missingOIDCClaims);
  }
  if (promptDetails.missingResourceScopes !== undefined) {
    for (const [indicator, scopes] of Object.entries(promptDetails.missingResourceScopes)) {
      grant.addResourceScope(indicator, scopes.join(' '));
    }
  }

  const result = { consent: { grantId: await grant.save() } };
  const redirectTo = await provider.interactionResult(request, response, result, {
    mergeWithLastSubmission: true,
  });
  response.redirect(303, redirectTo);
}
