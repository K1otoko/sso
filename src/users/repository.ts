import { eq } from 'drizzle-orm';

import type { Role } from '../auth/roles.js';
import type { Database } from '../db/client.js';
import { users, type User, type UserStatus } from '../db/schema.js';

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: Role;
  email?: string | null;
  displayName?: string | null;
}

export class UsersRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<User | undefined> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0];
  }

  async findByUsername(username: string): Promise<User | undefined> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return rows[0];
  }

  async create(input: CreateUserInput): Promise<User> {
    const rows = await this.db
      .insert(users)
      .values({
        username: input.username,
        passwordHash: input.passwordHash,
        role: input.role,
        email: input.email ?? null,
        displayName: input.displayName ?? null,
      })
      .returning();
    const created = rows[0];
    if (created === undefined) {
      throw new Error('创建用户失败：数据库未返回记录');
    }
    return created;
  }

  async setRole(username: string, role: Role): Promise<User | undefined> {
    const rows = await this.db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.username, username))
      .returning();
    return rows[0];
  }

  async setStatus(username: string, status: UserStatus): Promise<User | undefined> {
    const rows = await this.db
      .update(users)
      .set({ status, updatedAt: new Date() })
      .where(eq(users.username, username))
      .returning();
    return rows[0];
  }

  async setPasswordHash(username: string, passwordHash: string): Promise<User | undefined> {
    const rows = await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.username, username))
      .returning();
    return rows[0];
  }

  async touchLogin(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id));
  }
}
