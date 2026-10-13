import { and, eq } from 'drizzle-orm';
import type { Adapter, AdapterPayload } from 'oidc-provider';

import type { Database } from '../db/client.js';
import { oidcPayloads } from '../db/schema.js';

function expiresAtFrom(expiresIn: number | undefined): Date | null {
  if (expiresIn === undefined || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }
  return new Date(Date.now() + expiresIn * 1000);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * oidc-provider 的通用持久化适配器（单表 oidc_payloads）。
 * 语义对齐库内置的 MemoryAdapter：
 * - find/ findByUid / findByUserCode 返回包含 consumed 的原始 payload（过期由库校验）
 * - consume 在 payload JSON 里写入 consumed（秒级时间戳），保证一次性对象只可用一次
 */
class OidcPayloadAdapter implements Adapter {
  constructor(
    private readonly model: string,
    private readonly db: Database,
  ) {}

  private rowToPayload(
    row: typeof oidcPayloads.$inferSelect | undefined,
  ): AdapterPayload | undefined {
    if (row === undefined) {
      return undefined;
    }
    return row.payload as AdapterPayload;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const expiresAt = expiresAtFrom(expiresIn);
    const grantId = optionalString(payload.grantId);
    const userCode = optionalString(payload.userCode);
    const uid = optionalString(payload.uid);

    await this.db
      .insert(oidcPayloads)
      .values({ model: this.model, id, payload, grantId, userCode, uid, expiresAt })
      .onConflictDoUpdate({
        target: [oidcPayloads.model, oidcPayloads.id],
        set: { payload, grantId, userCode, uid, expiresAt },
      });
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), eq(oidcPayloads.id, id)))
      .limit(1);
    return this.rowToPayload(rows[0]);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), eq(oidcPayloads.uid, uid)))
      .limit(1);
    return this.rowToPayload(rows[0]);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), eq(oidcPayloads.userCode, userCode)))
      .limit(1);
    return this.rowToPayload(rows[0]);
  }

  async consume(id: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), eq(oidcPayloads.id, id)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return;
    }

    const consumedAt = new Date();
    const payload = { ...(row.payload as AdapterPayload), consumed: Math.floor(consumedAt.getTime() / 1000) };

    await this.db
      .update(oidcPayloads)
      .set({ payload, consumedAt })
      .where(and(eq(oidcPayloads.model, this.model), eq(oidcPayloads.id, id)));
  }

  async destroy(id: string): Promise<void> {
    await this.db
      .delete(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), eq(oidcPayloads.id, id)));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.db
      .delete(oidcPayloads)
      .where(and(eq(oidcPayloads.model, this.model), eq(oidcPayloads.grantId, grantId)));
  }
}

export function createAdapterFactory(db: Database): (model: string) => Adapter {
  return (model: string) => new OidcPayloadAdapter(model, db);
}
