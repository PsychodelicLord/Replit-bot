import { pgTable, integer, boolean } from "drizzle-orm/pg-core";

export const outcomeSettingsTable = pgTable("outcome_settings", {
  id:          integer("id").primaryKey().default(1),
  enabled:     boolean("enabled").notNull().default(false),
  betCostCents: integer("bet_cost_cents").notNull().default(100),
  // Sim stats — persisted across restarts
  simWins:     integer("sim_wins").notNull().default(0),
  simLosses:   integer("sim_losses").notNull().default(0),
  simPnlCents: integer("sim_pnl_cents").notNull().default(0),
  noEdgeCount: integer("no_edge_count").notNull().default(0),
});
