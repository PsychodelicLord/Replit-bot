import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function runMigrations(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS trades (
        id              SERIAL PRIMARY KEY,
        market_id       TEXT NOT NULL,
        market_title    TEXT NOT NULL,
        side            TEXT NOT NULL,
        buy_price_cents  INTEGER NOT NULL,
        sell_price_cents INTEGER,
        contract_count  INTEGER NOT NULL,
        fee_cents       INTEGER NOT NULL DEFAULT 0,
        pnl_cents       INTEGER,
        status          TEXT NOT NULL DEFAULT 'open',
        kalshi_buy_order_id  TEXT,
        kalshi_sell_order_id TEXT,
        minutes_remaining    REAL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at       TIMESTAMPTZ
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS bot_logs (
        id         SERIAL PRIMARY KEY,
        level      TEXT NOT NULL DEFAULT 'info',
        message    TEXT NOT NULL,
        data       TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS momentum_settings (
        id                     INTEGER PRIMARY KEY DEFAULT 1,
        enabled                BOOLEAN NOT NULL DEFAULT FALSE,
        balance_floor_cents    INTEGER NOT NULL DEFAULT 0,
        max_session_loss_cents INTEGER NOT NULL DEFAULT 0,
        consecutive_loss_limit INTEGER NOT NULL DEFAULT 0,
        bet_cost_cents         INTEGER NOT NULL DEFAULT 30
      )
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS bet_cost_cents INTEGER NOT NULL DEFAULT 30
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS simulator_mode BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS price_min INTEGER NOT NULL DEFAULT 20
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS price_max INTEGER NOT NULL DEFAULT 80
    `);

    console.log("[migrate] Tables ready.");
  } catch (err) {
    console.error("[migrate] Migration error (server will still start):", err);
  }
}
