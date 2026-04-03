import app from "./app";
import { logger } from "./lib/logger";
import { retryOpenPositions, refreshBalance, startCoinFlipAuto, syncPortfolioFromKalshi, registerOpenPosition, loadBotConfigFromDb } from "./lib/kalshi-bot";
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
    logger.info({ COINFLIP_AUTO_START: process.env["COINFLIP_AUTO_START"] ?? "(not set)", MOMENTUM_AUTO_START: process.env["MOMENTUM_AUTO_START"] ?? "(not set)" }, "env check");

    // ── Auto-start bots IMMEDIATELY — never wait for DB ──────────────────────
    // loadBotConfigFromDb can hang if Neon is sleeping; starting bots first
    // means they use safe defaults and trade without delay.
    const autoStart = process.env["COINFLIP_AUTO_START"];
    if (autoStart === "true") {
      startCoinFlipAuto(900);
      logger.info("🪙 Coin flip auto-mode started via COINFLIP_AUTO_START");
    } else {
      logger.warn({ autoStartValue: autoStart ?? "(not set)" }, "COINFLIP_AUTO_START is not 'true' — coin flip will not auto-trade");
    }

    const momentumAutoStart = process.env["MOMENTUM_AUTO_START"];
    if (momentumAutoStart === "true") {
      startMomentumBot();
      logger.info("📈 Momentum bot auto-mode started via MOMENTUM_AUTO_START");
    }

    // ── Restore momentum bot state from DB (auto-restarts if was enabled) ────
    // Runs after MOMENTUM_AUTO_START check so explicit env var still wins.
    loadMomentumConfig().catch(err => logger.warn({ err }, "startup: loadMomentumConfig failed"));

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
