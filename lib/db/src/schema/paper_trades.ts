import { pgTable, serial, integer, varchar, timestamp } from "drizzle-orm/pg-core";

export const paperTradesTable = pgTable("paper_trades", {
  id:          serial("id").primaryKey(),
  botType:     varchar("bot_type", { length: 20 }).notNull().default("momentum"),
  marketId:    varchar("market_id", { length: 120 }).notNull(),
  coin:        varchar("coin", { length: 10 }).notNull().default(""),
  side:        varchar("side", { length: 5 }).notNull(),
  entryPrice:  integer("entry_price").notNull(),
  exitPrice:   integer("exit_price").notNull(),
  pnlCents:    integer("pnl_cents").notNull(),
  exitReason:  varchar("exit_reason", { length: 80 }).notNull(),
  enteredAt:   timestamp("entered_at").notNull(),
  closedAt:    timestamp("closed_at").notNull().defaultNow(),
});
