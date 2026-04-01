import express, { type Express } from "express";
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

app.use("/api", router);

const frontendDist = path.resolve(process.cwd(), "artifacts/kalshi-bot/dist/public");
logger.info({ frontendDist }, "Serving frontend from");

app.use(express.static(frontendDist));

app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"), (err) => {
    if (err) {
      res.status(200).send(`<h2>Bot is running</h2><p>Frontend not found at: ${frontendDist}</p>`);
    }
  });
});

export default app;
