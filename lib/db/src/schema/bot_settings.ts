import { pgTable, integer, real, text, jsonb } from "drizzle-orm/pg-core";

export const botSettingsTable = pgTable("bot_settings", {
  id: integer("id").primaryKey().default(1),
  maxEntryPriceCents: integer("max_entry_price_cents").notNull().default(59),
  minNetProfitCents: integer("min_net_profit_cents").notNull().default(5),
  maxNetProfitCents: integer("max_net_profit_cents").notNull().default(99),
  minMinutesRemaining: real("min_minutes_remaining").notNull().default(4),
  exitWindowMins: integer("exit_window_mins").notNull().default(2),
  maxOpenPositions: integer("max_open_positions").notNull().default(1),
  balanceFloorCents: integer("balance_floor_cents").notNull().default(0),
  dailyProfitTargetCents: integer("daily_profit_target_cents").notNull().default(0),
  dailyLossLimitCents: integer("daily_loss_limit_cents").notNull().default(0),
  feeRate: real("fee_rate").notNull().default(0.07),
  pollIntervalSecs: integer("poll_interval_secs").notNull().default(5),
  marketCategories: jsonb("market_categories").$type<string[]>().notNull().default(["crypto"]),
  cryptoCoins: jsonb("crypto_coins").$type<string[]>().notNull().default(["BTC", "ETH", "SOL", "DOGE"]),
});
