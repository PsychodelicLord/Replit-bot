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

    // Hydrate openPositions from DB at startup so the sell monitor can act on
    // any trades that were open before this restart — without waiting for startBot.
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
        if (openTrades.length > 0) {
          logger.info({ count: openTrades.length }, "startup: hydrated open positions for sell monitor");
        }
      })
      .catch(err => logger.warn({ err }, "startup: could not hydrate open positions — sell monitor will pick up new trades only"));

    // Sync any Kalshi positions not in DB (handles DB resets / missing trades)
    syncPortfolioFromKalshi().catch(() => {});

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
