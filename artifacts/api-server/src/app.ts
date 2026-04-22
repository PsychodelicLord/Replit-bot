import express, { type Express } from "express";
import type { RequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BOT_ADMIN_TOKEN = (process.env["BOT_ADMIN_TOKEN"] ?? "").trim();
const isProductionDeployment = !!process.env["RAILWAY_ENVIRONMENT"];
const disableBotAdminAuth = (process.env["DISABLE_BOT_ADMIN_AUTH"] ?? "").toLowerCase() === "true";
const PROTECTED_API_PREFIXES = [
  "/bot/start",
  "/bot/stop",
  "/bot/config",
  "/bot/clear-positions",
  "/bot/momentum/auto",
  "/bot/momentum/reset-sim",
  "/bot/momentum/reset-all",
  "/bot/momentum/emergency-stop",
];

const requireBotAdminToken: RequestHandler = (req, res, next) => {
  if (!isProductionDeployment) return next();
  if (disableBotAdminAuth) return next();
  const pathOnly = req.path.split("?")[0];
  const method = req.method.toUpperCase();
  const needsAuth = PROTECTED_API_PREFIXES.some((prefix) => pathOnly.startsWith(prefix));
  if (!needsAuth) return next();
  if (!BOT_ADMIN_TOKEN) {
    logger.error({ path: pathOnly, method }, "BOT_ADMIN_TOKEN missing in production");
    res.status(500).json({ error: "Server auth misconfigured" });
    return;
  }
  const auth = (req.header("authorization") ?? "").trim();
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (token !== BOT_ADMIN_TOKEN) {
    logger.warn({ path: pathOnly, method }, "Unauthorized bot control request blocked");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  return next();
};

app.use("/api", requireBotAdminToken);
app.use("/api", router);

const frontendDist = path.join(new URL(".", import.meta.url).pathname, "../../kalshi-bot/dist/public");
app.use(express.static(frontendDist));
app.use((_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"), (err) => {
    if (err) {
      res.status(200).send("Bot is running.");
    }
  });
});

export default app;
