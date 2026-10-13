/** 三档等级权限：super > admin > user（包含式语义）。 */
export const ROLES = ['super', 'admin', 'user'] as const;

export type Role = (typeof ROLES)[number];

export const roleRank: Record<Role, number> = {
  super: 3,
  admin: 2,
  user: 1,
};

/** actual 的等级是否 ≥ required。 */
export function roleAtLeast(actual: Role, required: Role): boolean {
  return roleRank[actual] >= roleRank[required];
}
