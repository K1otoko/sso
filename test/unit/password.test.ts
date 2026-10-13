import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('password（scrypt 哈希）', () => {
  it('哈希后可校验通过，且散列值不含明文', async () => {
    const stored = await hashPassword('S3cret-Password!');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('S3cret-Password!');
    await expect(verifyPassword('S3cret-Password!', stored)).resolves.toBe(true);
  });

  it('错误口令校验失败', async () => {
    const stored = await hashPassword('correct-password');
    await expect(verifyPassword('wrong-password', stored)).resolves.toBe(false);
  });

  it('相同口令每次生成不同散列（随机盐）', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');
    expect(first).not.toBe(second);
    await expect(verifyPassword('same-password', first)).resolves.toBe(true);
    await expect(verifyPassword('same-password', second)).resolves.toBe(true);
  });

  it('畸形存储值一律返回 false', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$whatever')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$1$2$3')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$bad$8$1$c2FsdA$aGFzaA')).resolves.toBe(false);
  });
});
