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
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS simulator_mode BOOLEAN NOT NULL DEFAULT TRUE
    `);
    // Safety fix: only correct dangerous price ranges (extreme prices cause gap losses).
    // simulator_mode is intentionally NOT forced here — the user controls that via the dashboard
    // and we must not override it on every deploy.
    await db.execute(sql`
      UPDATE momentum_settings
      SET price_min = GREATEST(price_min, 20),
          price_max = LEAST(price_max, 80)
      WHERE id = 1
        AND (price_min < 20 OR price_max > 80)
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS price_min INTEGER NOT NULL DEFAULT 20
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS price_max INTEGER NOT NULL DEFAULT 80
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS sim_wins INTEGER NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS sim_losses INTEGER NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS sim_pnl_cents INTEGER NOT NULL DEFAULT 0
    `);
    // Real trade lifetime stats
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS total_wins INTEGER NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS total_losses INTEGER NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS total_pnl_cents INTEGER NOT NULL DEFAULT 0
    `);
    // Balance snapshot at last reset (nullable — null means never reset)
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS starting_balance_cents INTEGER
    `);
    // Exit thresholds — persisted so restarts don't reset to defaults
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS tp_cents INTEGER NOT NULL DEFAULT 5
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS sl_cents INTEGER NOT NULL DEFAULT 2
    `);
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS stale_ms INTEGER NOT NULL DEFAULT 65000
    `);
    // Absolute price TP (0 = disabled, use relative tpCents)
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS tp_absolute_cents INTEGER NOT NULL DEFAULT 0
    `);
    // Session profit target — stop when session gain hits this (0 = disabled)
    await db.execute(sql`
      ALTER TABLE momentum_settings ADD COLUMN IF NOT EXISTS session_profit_target_cents INTEGER NOT NULL DEFAULT 0
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS paper_trades (
        id           SERIAL PRIMARY KEY,
        bot_type     VARCHAR(20) NOT NULL DEFAULT 'momentum',
        market_id    VARCHAR(120) NOT NULL,
        coin         VARCHAR(10)  NOT NULL DEFAULT '',
        side         VARCHAR(5)   NOT NULL,
        entry_price  INTEGER      NOT NULL,
        exit_price   INTEGER      NOT NULL,
        pnl_cents    INTEGER      NOT NULL,
        exit_reason  VARCHAR(80)  NOT NULL,
        entered_at   TIMESTAMPTZ  NOT NULL,
        closed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    console.log("[migrate] Tables ready.");
  } catch (err) {
    console.error("[migrate] Migration error (server will still start):", err);
  }
}
