import { pgTable, integer, boolean } from "drizzle-orm/pg-core";

export const momentumSettingsTable = pgTable("momentum_settings", {
  id:                   integer("id").primaryKey().default(1),
  enabled:              boolean("enabled").notNull().default(false),
  balanceFloorCents:    integer("balance_floor_cents").notNull().default(0),
  maxSessionLossCents:  integer("max_session_loss_cents").notNull().default(0),
  consecutiveLossLimit: integer("consecutive_loss_limit").notNull().default(0),
  betCostCents:         integer("bet_cost_cents").notNull().default(30),
  simulatorMode:        boolean("simulator_mode").notNull().default(false),
});
