import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';
const FIELDS = 6;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, params, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/** 生成口令哈希，格式：scrypt$N$r$p$salt(base64url)$hash(base64url)。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const params: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const derived = await deriveKey(password, salt, KEY_LENGTH, params);
  return [
    PREFIX,
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/** 校验口令；任何格式错误都返回 false，不做区分。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== FIELDS || parts[0] !== PREFIX) {
    return false;
  }

  const [, nValue, rValue, pValue, saltValue, hashValue] = parts;
  if (
    nValue === undefined ||
    rValue === undefined ||
    pValue === undefined ||
    saltValue === undefined ||
    hashValue === undefined
  ) {
    return false;
  }

  const params: ScryptParams = {
    N: Number(nValue),
    r: Number(rValue),
    p: Number(pValue),
  };
  if (
    !Number.isSafeInteger(params.N) ||
    !Number.isSafeInteger(params.r) ||
    !Number.isSafeInteger(params.p) ||
    params.N <= 0 ||
    params.r <= 0 ||
    params.p <= 0
  ) {
    return false;
  }

  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(hashValue, 'base64url');
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  try {
    const actual = await deriveKey(password, salt, expected.length, params);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
