import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tradeEntryLocksTable = pgTable("trade_entry_locks", {
  asset: text("asset").primaryKey(),
  ownerId: text("owner_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
