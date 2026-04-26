import app from "./app";
import { logger } from "./lib/logger";
import { refreshBalance, loadBotConfigFromDb } from "./lib/kalshi-bot";
import { loadMomentumConfig } from "./lib/momentumBot";
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
    logger.info({
      MOMENTUM_AUTO_START: process.env["MOMENTUM_AUTO_START"] ?? "(not set)",
    }, "env check");

    // ── Restore momentum bot state from DB, then auto-start if enabled ────────
    const momentumAutoStart = process.env["MOMENTUM_AUTO_START"];
    loadMomentumConfig(momentumAutoStart === "true")
      .catch(err => logger.warn({ err }, "startup: loadMomentumConfig failed"));

    // ── Load saved config (best-effort) ───────────────────────────────────────
    loadBotConfigFromDb()
      .catch(err => logger.warn({ err }, "startup: loadBotConfigFromDb failed — using defaults"));

    refreshBalance();
    setInterval(refreshBalance, 60_000);
  });
});
