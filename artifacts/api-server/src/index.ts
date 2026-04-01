import app from "./app";
import { logger } from "./lib/logger";
import { retryOpenPositions, refreshBalance, startCoinFlipAuto } from "./lib/kalshi-bot";

const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Global sell monitor — runs every 5 s regardless of whether the main bot is on.
  // This ensures coin flip trades (and any other open positions) are auto-sold
  // even when the main bot hasn't been started.
  setInterval(retryOpenPositions, 5_000);

  // Global balance refresh — keeps the dashboard balance live even when main bot is off.
  refreshBalance();
  setInterval(refreshBalance, 60_000);

  // Auto-start coin flip if env var is set (useful for Railway so it survives restarts)
  if (process.env["COINFLIP_AUTO_START"] === "true") {
    startCoinFlipAuto(900);
    logger.info("🪙 Coin flip auto-mode started automatically via COINFLIP_AUTO_START");
  }
});
