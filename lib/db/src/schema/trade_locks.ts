import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tradeLocksTable = pgTable("trade_locks", {
  asset: text("asset").primaryKey(),
  ownerId: text("owner_id").notNull(),
  lockToken: text("lock_token"),
  state: text("state").notNull().default("locked"),
  intentPayload: text("intent_payload"),
  intentCreatedAt: timestamp("intent_created_at", { withTimezone: true }),
  intentExpiresAt: timestamp("intent_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
