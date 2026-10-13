import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * 测试开跑前把迁移应用到测试库（TEST_DATABASE_URL，默认与业务库同服务器）。
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url === undefined) {
    throw new Error('测试需要 TEST_DATABASE_URL（或 DATABASE_URL）');
  }

  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: 'drizzle' });
  } finally {
    await pool.end();
  }
}
