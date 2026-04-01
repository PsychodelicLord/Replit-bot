import app from "./app";
import { logger } from "./lib/logger";
import { retryOpenPositions, refreshBalance, startCoinFlipAuto } from "./lib/kalshi-bot";
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

    setInterval(retryOpenPositions, 5_000);

    refreshBalance();
    setInterval(refreshBalance, 60_000);

    if (process.env["COINFLIP_AUTO_START"] === "true") {
      startCoinFlipAuto(900);
      logger.info("🪙 Coin flip auto-mode started automatically via COINFLIP_AUTO_START");
    }
  });
});
