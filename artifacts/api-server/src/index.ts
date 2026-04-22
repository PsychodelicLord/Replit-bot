import app from "./app";
import { logger } from "./lib/logger";
import { retryOpenPositions, refreshBalance, syncPortfolioFromKalshi, registerOpenPosition, loadBotConfigFromDb } from "./lib/kalshi-bot";
import { startMomentumBot, loadMomentumConfig } from "./lib/momentumBot";
import { runMigrations } from "./migrate";
import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

    // ── Load saved config + hydrate positions from DB asynchronously ─────────
    // These are best-effort — bots work fine with defaults if DB is unavailable.
    loadBotConfigFromDb()
      .catch(err => logger.warn({ err }, "startup: loadBotConfigFromDb failed — using defaults"))
      .finally(() => {
        db.select().from(tradesTable).where(eq(tradesTable.status, "open"))
          .then(openTrades => {
            for (const t of openTrades) {
              registerOpenPosition({
                tradeId:         t.id,
                marketId:        t.marketId,
                side:            t.side as "YES" | "NO",
                entryPriceCents: t.buyPriceCents,
                contractCount:   t.contractCount,
                enteredAt:       t.createdAt.getTime(),
                buyOrderId:      t.kalshiBuyOrderId ?? null,
              });
            }
            logger.info({ count: openTrades.length }, "startup: DB hydration complete");
          })
          .catch(err => logger.warn({ err }, "startup: DB hydration failed — Kalshi sync will recover"))
          .finally(() => {
            syncPortfolioFromKalshi().catch(err =>
              logger.warn({ err }, "startup: Kalshi sync failed"),
            );
          });
      });

    setInterval(retryOpenPositions, 2_000);

    refreshBalance();
    setInterval(refreshBalance, 60_000);
  });
});
