/**
 * 数据库初始化脚本：
 * 1. 探测目标服务器的连通性与 SSL 模式
 * 2. 创建业务库（默认 sso）与测试库（sso_test），已存在则跳过
 * 3. 校验连接可用并打印服务器版本
 *
 * 用法：pnpm db:init（读取 .env 里的 DATABASE_URL）
 */
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error('DATABASE_URL 未设置。请先按 .env.example 创建 .env。');
  process.exit(1);
}

const target = new URL(databaseUrl);
const targetDatabase = target.pathname.replace(/^\//, '') || 'sso';
const databasesToCreate = [...new Set([targetDatabase, 'sso_test'])];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function connect(url: string, useSsl: boolean): Promise<Client> {
  const client = new Client({
    connectionString: url,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  return client;
}

async function connectWithSslFallback(url: string): Promise<{ client: Client; ssl: boolean }> {
  try {
    return { client: await connect(url, false), ssl: false };
  } catch (error) {
    const message = describeError(error);
    if (!/ssl|tls/i.test(message)) {
      throw error;
    }
    const client = await connect(url, true);
    return { client, ssl: true };
  }
}

async function main(): Promise<void> {
  const adminUrl = new URL(databaseUrl as string);
  adminUrl.pathname = '/postgres';

  console.log(`连接数据库服务器 ${adminUrl.host} ...`);
  const { client: admin, ssl } = await connectWithSslFallback(adminUrl.toString());
  console.log(ssl ? 'SSL 模式：已启用（require，不校验链）' : 'SSL 模式：未启用');

  try {
    const versionResult = await admin.query<{ server_version: string }>('SHOW server_version');
    console.log(`服务器 PostgreSQL 版本：${versionResult.rows[0]?.server_version ?? 'unknown'}`);

    for (const name of databasesToCreate) {
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (existing.rowCount === 0) {
        await admin.query(`CREATE DATABASE "${name}"`);
        console.log(`已创建数据库：${name}`);
      } else {
        console.log(`数据库已存在：${name}`);
      }
    }
  } finally {
    await admin.end();
  }

  const checkUrl = new URL(databaseUrl as string);
  checkUrl.pathname = `/${targetDatabase}`;
  const { client: check } = await connectWithSslFallback(checkUrl.toString());
  try {
    const now = await check.query<{ now: Date }>('SELECT now() AS now');
    console.log(`业务库 ${targetDatabase} 连接正常（服务器时间 ${String(now.rows[0]?.now)}）`);
  } finally {
    await check.end();
  }

  if (ssl) {
    console.log('提示：服务器要求 SSL。请在 .env 的 DATABASE_URL/TEST_DATABASE_URL 末尾追加 ?sslmode=require');
  }

  console.log('数据库初始化完成。');
}

main().catch((error: unknown) => {
  console.error('数据库初始化失败：', error);
  process.exitCode = 1;
});
