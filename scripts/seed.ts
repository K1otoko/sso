/**
 * 种子脚本：创建初始账号（1 个 super + 1 个 user），已存在则跳过。
 * 可通过环境变量覆盖默认用户名/密码：
 *   SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD
 *   SEED_USER_USERNAME  / SEED_USER_PASSWORD
 */
import { hashPassword } from '../src/auth/password.js';
import { createDatabase } from '../src/db/client.js';
import { UsersRepository } from '../src/users/repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  console.error('DATABASE_URL 未设置');
  process.exit(1);
}

const seeds = [
  {
    username: process.env.SEED_ADMIN_USERNAME ?? 'admin',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'admin-123456',
    role: 'super' as const,
    displayName: 'Super Admin',
  },
  {
    username: process.env.SEED_USER_USERNAME ?? 'demo',
    password: process.env.SEED_USER_PASSWORD ?? 'demo-123456',
    role: 'user' as const,
    displayName: 'Demo User',
  },
];

async function main(): Promise<void> {
  const database = createDatabase(databaseUrl as string);
  const users = new UsersRepository(database.db);

  try {
    for (const seed of seeds) {
      const existing = await users.findByUsername(seed.username);
      if (existing !== undefined) {
        console.log(`已存在，跳过：${seed.username}（${existing.role}）`);
        continue;
      }
      const created = await users.create({
        username: seed.username,
        passwordHash: await hashPassword(seed.password),
        role: seed.role,
        displayName: seed.displayName,
      });
      console.log(`已创建：${created.username}（${created.role}）密码：${seed.password}`);
    }
  } finally {
    await database.close();
  }

  console.log('种子完成。');
}

main().catch((error: unknown) => {
  console.error('种子失败：', error);
  process.exitCode = 1;
});
