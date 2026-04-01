import app from "./app";
import { logger } from "./lib/logger";
import { retryOpenPositions, refreshBalance, startCoinFlipAuto, syncPortfolioFromKalshi, registerOpenPosition } from "./lib/kalshi-bot";
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
    logger.info({ COINFLIP_AUTO_START: process.env["COINFLIP_AUTO_START"] ?? "(not set)" }, "env check");

    // Step 1: Try to hydrate from DB (fast path if Neon is awake)
    // Step 2: ALWAYS run Kalshi sync after — catches anything DB missed or
    //         when Neon is suspended. syncPortfolioFromKalshi is fully DB-independent.
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
      .catch(err => logger.warn({ err }, "startup: DB hydration failed — Kalshi sync will recover positions"))
      .finally(() => {
        // Always run Kalshi sync regardless of DB state — this is the safety net
        syncPortfolioFromKalshi().catch(err =>
          logger.warn({ err }, "startup: Kalshi sync failed"),
        );
      });

    setInterval(retryOpenPositions, 2_000);

    refreshBalance();
    setInterval(refreshBalance, 60_000);

    const autoStart = process.env["COINFLIP_AUTO_START"];
    if (autoStart === "true") {
      startCoinFlipAuto(900);
      logger.info("🪙 Coin flip auto-mode started automatically via COINFLIP_AUTO_START");
    } else {
      logger.warn({ autoStartValue: autoStart ?? "(not set)" }, "COINFLIP_AUTO_START is not 'true' — bot will not trade automatically");
    }
  });
});
