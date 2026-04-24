import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  marketId: text("market_id").notNull(),
  marketTitle: text("market_title").notNull(),
  side: text("side").notNull(),
  buyPriceCents: integer("buy_price_cents").notNull(),
  sellPriceCents: integer("sell_price_cents"),
  // Supports fractional contract quantities from Kalshi count_fp.
  contractCount: real("contract_count").notNull(),
  contractCountFp: text("contract_count_fp"),
  feeCents: integer("fee_cents").notNull().default(0),
  pnlCents: integer("pnl_cents"),
  status: text("status").notNull().default("open"),
  kalshiBuyOrderId: text("kalshi_buy_order_id"),
  kalshiSellOrderId: text("kalshi_sell_order_id"),
  minutesRemaining: real("minutes_remaining"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true, createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
