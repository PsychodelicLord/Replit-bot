import app from "./app";
import { logger } from "./lib/logger";
import { retryOpenPositions } from "./lib/kalshi-bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

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
});
