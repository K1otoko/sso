import { describe, expect, it } from 'vitest';

import { roleAtLeast } from '../../src/auth/roles.js';

describe('三档等级权限', () => {
  it('包含式语义：super ⊇ admin ⊇ user', () => {
    expect(roleAtLeast('super', 'super')).toBe(true);
    expect(roleAtLeast('super', 'admin')).toBe(true);
    expect(roleAtLeast('super', 'user')).toBe(true);

    expect(roleAtLeast('admin', 'super')).toBe(false);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'user')).toBe(true);

    expect(roleAtLeast('user', 'super')).toBe(false);
    expect(roleAtLeast('user', 'admin')).toBe(false);
    expect(roleAtLeast('user', 'user')).toBe(true);
  });
});
