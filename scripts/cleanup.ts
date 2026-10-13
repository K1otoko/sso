/**
 * 清理过期的 oidc_payloads 数据（建议挂系统定时任务，每天一次）。
 * 保留最近 1 天前到期的记录，避免误删仍在时钟偏移容忍期内的数据。
 */
import { lt } from 'drizzle-orm';

import { createDatabase } from '../src/db/client.js';
import { oidcPayloads } from '../src/db/schema.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  console.error('DATABASE_URL 未设置');
  process.exit(1);
}

const RETENTION_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const database = createDatabase(databaseUrl as string);
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const deleted = await database.db
      .delete(oidcPayloads)
      .where(lt(oidcPayloads.expiresAt, cutoff))
      .returning({ id: oidcPayloads.id });
    console.log(`已清理过期记录：${deleted.length} 条（早于 ${cutoff.toISOString()}）`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error('清理失败：', error);
  process.exitCode = 1;
});
