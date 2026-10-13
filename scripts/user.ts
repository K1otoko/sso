/**
 * 用户管理 CLI（本轮替代管理 API）：
 *   pnpm user create --username demo2 --password 'x' --role user [--email a@b.c] [--name 名称]
 *   pnpm user set-role --username demo2 --role admin
 *   pnpm user set-password --username demo2 --password 'x'
 *   pnpm user disable --username demo2
 *   pnpm user enable --username demo2
 *   pnpm user list
 */
import { hashPassword } from '../src/auth/password.js';
import { ROLES, type Role } from '../src/auth/roles.js';
import { createDatabase } from '../src/db/client.js';
import { UsersRepository } from '../src/users/repository.js';

function parseArguments(argv: string[]): { command: string | undefined; options: Map<string, string> } {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined || !token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`参数 --${key} 缺少值`);
      process.exit(1);
    }
    options.set(key, value);
    index += 1;
  }

  return { command, options };
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined) {
    console.error(`缺少参数 --${key}`);
    process.exit(1);
  }
  return value;
}

function parseRole(value: string): Role {
  if ((ROLES as readonly string[]).includes(value)) {
    return value as Role;
  }
  console.error(`无效角色：${value}（可选：${ROLES.join(' / ')}）`);
  process.exit(1);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    console.error('DATABASE_URL 未设置');
    process.exit(1);
  }

  const { command, options } = parseArguments(process.argv.slice(2));
  const database = createDatabase(databaseUrl);
  const users = new UsersRepository(database.db);

  try {
    switch (command) {
      case 'create': {
        const username = required(options, 'username');
        const password = required(options, 'password');
        const role = parseRole(options.get('role') ?? 'user');
        const existing = await users.findByUsername(username);
        if (existing !== undefined) {
          console.error(`用户已存在：${username}`);
          process.exitCode = 1;
          return;
        }
        const created = await users.create({
          username,
          passwordHash: await hashPassword(password),
          role,
          email: options.get('email') ?? null,
          displayName: options.get('name') ?? null,
        });
        console.log(`已创建：${created.username}（${created.role} / ${created.status}）`);
        return;
      }
      case 'set-role': {
        const username = required(options, 'username');
        const role = parseRole(required(options, 'role'));
        const updated = await users.setRole(username, role);
        console.log(updated === undefined ? `用户不存在：${username}` : `已更新：${username} → ${role}`);
        return;
      }
      case 'set-password': {
        const username = required(options, 'username');
        const password = required(options, 'password');
        const updated = await users.setPasswordHash(username, await hashPassword(password));
        console.log(updated === undefined ? `用户不存在：${username}` : `已重置密码：${username}`);
        return;
      }
      case 'disable':
      case 'enable': {
        const username = required(options, 'username');
        const status = command === 'disable' ? 'disabled' : 'active';
        const updated = await users.setStatus(username, status);
        console.log(updated === undefined ? `用户不存在：${username}` : `已更新：${username} → ${status}`);
        return;
      }
      case 'list': {
        const rows = await database.db.query.users.findMany();
        for (const row of rows) {
          console.log(`${row.username}\t${row.role}\t${row.status}\t${row.id}`);
        }
        return;
      }
      default:
        console.error('用法：create | set-role | set-password | disable | enable | list');
        process.exitCode = 1;
    }
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error('执行失败：', error);
  process.exitCode = 1;
});
