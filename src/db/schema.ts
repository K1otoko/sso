import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { ROLES } from '../auth/roles.js';

export const userRole = pgEnum('user_role', ROLES);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    username: varchar('username', { length: 64 }).notNull(),
    passwordHash: varchar('password_hash', { length: 512 }).notNull(),
    role: userRole('role').default('user').notNull(),
    status: userStatus('status').default('active').notNull(),
    email: varchar('email', { length: 320 }),
    displayName: varchar('display_name', { length: 255 }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('users_username_unique').on(table.username),
    uniqueIndex('users_email_unique').on(table.email),
  ],
);

/**
 * oidc-provider 通用持久化表：
 * 承载 Session / Grant / AuthorizationCode / RefreshToken / Interaction 等全部运行时模型。
 * （JWT 格式的 AccessToken 是无状态令牌，不落库。）
 */
export const oidcPayloads = pgTable(
  'oidc_payloads',
  {
    model: varchar('model', { length: 64 }).notNull(),
    id: varchar('id', { length: 255 }).notNull(),
    payload: jsonb('payload').notNull(),
    grantId: varchar('grant_id', { length: 255 }),
    userCode: varchar('user_code', { length: 255 }),
    uid: varchar('uid', { length: 255 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ name: 'oidc_payloads_pk', columns: [table.model, table.id] }),
    index('oidc_payloads_expires_at_idx').on(table.expiresAt),
    index('oidc_payloads_grant_id_idx').on(table.grantId),
    index('oidc_payloads_uid_idx').on(table.uid),
    index('oidc_payloads_user_code_idx').on(table.userCode),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserStatus = (typeof userStatus.enumValues)[number];
