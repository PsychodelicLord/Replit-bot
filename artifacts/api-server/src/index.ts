import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./lib/kalshi-bot";

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

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Auto-start the bot on server boot if API keys are present
  if (process.env.KALSHI_API_KEY && process.env.KALSHI_PRIVATE_KEY) {
    try {
      await startBot();
      logger.info("Bot auto-started on server boot");
    } catch (e) {
      logger.error({ err: e }, "Bot auto-start failed");
    }
  }
});
