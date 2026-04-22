import app from "./app";
import { logger } from "./lib/logger";
import { refreshBalance } from "./lib/kalshi-bot";
import { startMomentumBot, loadMomentumConfig } from "./lib/momentumBot";
import { runMigrations } from "./migrate";

const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

runMigrations().then(() => {
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    logger.info({ MOMENTUM_AUTO_START: process.env["MOMENTUM_AUTO_START"] ?? "(not set)" }, "env check");

    // ── Restore momentum bot state from DB, then auto-start if enabled ────────
    // loadMomentumConfig reads simulatorMode/betCostCents/etc before starting
    // the bot, so it never boots in live mode by accident.
    // If Neon is completely unreachable after all retries, it falls back to
    // starting in PAPER (sim) mode so real money is never at risk.
    const momentumAutoStart = process.env["MOMENTUM_AUTO_START"];
    loadMomentumConfig(momentumAutoStart === "true")
      .catch(err => logger.warn({ err }, "startup: loadMomentumConfig failed"));

    // Single trade pipeline guardrail:
    // Momentum bot owns signal->gate->execute->update-state flow and startup recovery.
    logger.info({ activeTradePaths: 1 }, "ACTIVE TRADE PATHS: 1 (signal -> gate -> execute -> update state)");

    refreshBalance();
    setInterval(refreshBalance, 60_000);
  });
});
