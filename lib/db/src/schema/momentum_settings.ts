import { pgTable, integer, boolean } from "drizzle-orm/pg-core";

export const momentumSettingsTable = pgTable("momentum_settings", {
  id:                   integer("id").primaryKey().default(1),
  enabled:              boolean("enabled").notNull().default(false),
  balanceFloorCents:    integer("balance_floor_cents").notNull().default(0),
  maxSessionLossCents:  integer("max_session_loss_cents").notNull().default(0),
  consecutiveLossLimit: integer("consecutive_loss_limit").notNull().default(0),
  betCostCents:         integer("bet_cost_cents").notNull().default(30),
  simulatorMode:        boolean("simulator_mode").notNull().default(false),
  priceMin:             integer("price_min").notNull().default(20),
  priceMax:             integer("price_max").notNull().default(80),
  // Sim stats — persisted so bot restarts don't wipe the scoreboard
  simWins:              integer("sim_wins").notNull().default(0),
  simLosses:            integer("sim_losses").notNull().default(0),
  simPnlCents:          integer("sim_pnl_cents").notNull().default(0),
  // Real trade stats — persisted across restarts
  totalWins:            integer("total_wins").notNull().default(0),
  totalLosses:          integer("total_losses").notNull().default(0),
  totalPnlCents:        integer("total_pnl_cents").notNull().default(0),
  // Snapshot balance captured at last reset — persists until user resets again
  startingBalanceCents: integer("starting_balance_cents"),
});
