import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { JWK } from 'oidc-provider';

export interface Jwks {
  keys: JWK[];
}

/**
 * 加载或生成 ES256（P-256）签名密钥集。
 * - 文件存在：直接加载（支持多 key，便于 kid 轮换）
 * - 不存在：生成新密钥并落盘（权限 0600，路径在 .gitignore 内）
 */
export function loadOrCreateJwks(jwksPath: string): Jwks {
  const absolutePath = resolve(jwksPath);

  if (existsSync(absolutePath)) {
    const parsed = JSON.parse(readFileSync(absolutePath, 'utf8')) as Jwks;
    if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
      throw new Error(`JWKS 文件内容无效：${absolutePath}`);
    }
    return parsed;
  }

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = privateKey.export({ format: 'jwk' }) as JWK;
  const key: JWK = {
    ...exported,
    kid: randomUUID(),
    use: 'sig',
    alg: 'ES256',
  };
  const jwks: Jwks = { keys: [key] };

  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(jwks, null, 2)}\n`, { mode: 0o600 });
  return jwks;
}
