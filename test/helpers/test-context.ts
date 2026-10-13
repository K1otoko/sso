import type { Express } from 'express';

import { hashPassword } from '../../src/auth/password.js';
import type { Role } from '../../src/auth/roles.js';
import { createApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { UsersRepository } from '../../src/users/repository.js';

export interface TestContext {
  app: Express;
  users: UsersRepository;
  config: AppConfig;
  close: () => Promise<void>;
}

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url === undefined) {
    throw new Error('测试需要 TEST_DATABASE_URL（或 DATABASE_URL）');
  }
  return url;
}

export function createTestContext(): TestContext {
  const config: AppConfig = {
    ...loadConfig(process.env),
    nodeEnv: 'test',
    databaseUrl: testDatabaseUrl(),
    jwksPath: './secrets/jwks.test.json',
  };

  const database: DatabaseClient = createDatabase(config.databaseUrl as string);
  const users = new UsersRepository(database.db);
  const app = createApp({ config, database: database.db, users });

  return {
    app,
    users,
    config,
    close: () => database.close(),
  };
}

/** 确保测试用户存在且处于可登录状态（已存在则重置密码和角色）。 */
export async function ensureUser(
  users: UsersRepository,
  input: { username: string; password: string; role: Role },
): Promise<void> {
  const existing = await users.findByUsername(input.username);
  if (existing === undefined) {
    await users.create({
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
    });
    return;
  }

  await users.setPasswordHash(input.username, await hashPassword(input.password));
  await users.setRole(input.username, input.role);
  await users.setStatus(input.username, 'active');
}
