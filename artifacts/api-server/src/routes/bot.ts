import { Router, type IRouter } from "express";
import { startBot, stopBot, getBotState, getBotConfig, updateBotConfig, manualTrade, coinFlipTrade } from "../lib/kalshi-bot";
import { db, botLogsTable, tradesTable } from "@workspace/db";
import { desc, count } from "drizzle-orm";
import {
  GetBotStatusResponse,
  StartBotResponse,
  StopBotResponse,
  GetBotConfigResponse,
  UpdateBotConfigBody,
  UpdateBotConfigResponse,
  GetBotLogsResponse,
  GetBotLogsQueryParams,
  ListTradesResponse,
  ListTradesQueryParams,
  GetTradeStatsResponse,
  ManualTradeBody,
  ManualTradeResponse,
  CoinFlipResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeState(s: ReturnType<typeof getBotState>) {
  return {
    running: s.running,
    startedAt: s.startedAt,
    marketsScanned: s.marketsScanned,
    tradesAttempted: s.tradesAttempted,
    tradesSucceeded: s.tradesSucceeded,
    totalPnlCents: s.totalPnlCents,
    dailyPnlCents: s.dailyPnlCents,
    openPositionCount: s.openPositionCount,
    balanceCents: s.balanceCents,
    stoppedReason: s.stoppedReason,
  };
}

router.get("/bot/config", async (_req, res): Promise<void> => {
  res.json(GetBotConfigResponse.parse(getBotConfig()));
});

router.patch("/bot/config", async (req, res): Promise<void> => {
  const parsed = UpdateBotConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updated = updateBotConfig(parsed.data);
  res.json(UpdateBotConfigResponse.parse(updated));
});

router.get("/bot/status", async (_req, res): Promise<void> => {
  res.json(GetBotStatusResponse.parse(serializeState(getBotState())));
});

router.post("/bot/start", async (_req, res): Promise<void> => {
  const s = await startBot();
  res.json(StartBotResponse.parse(serializeState(s)));
});

router.post("/bot/stop", async (_req, res): Promise<void> => {
  const s = await stopBot();
  res.json(StopBotResponse.parse(serializeState(s)));
});

router.get("/logs", async (req, res): Promise<void> => {
  const params = GetBotLogsQueryParams.safeParse(req.query);
  const limit = params.success ? (params.data.limit ?? 50) : 50;

  const logs = await db
    .select()
    .from(botLogsTable)
    .orderBy(desc(botLogsTable.createdAt))
    .limit(limit);

  res.json(GetBotLogsResponse.parse({
    logs: logs.map((l) => ({
      ...l,
      createdAt: l.createdAt.toISOString(),
    })),
  }));
});

router.get("/trades", async (req, res): Promise<void> => {
  const params = ListTradesQueryParams.safeParse(req.query);
  const limit = params.success ? (params.data.limit ?? 100) : 100;
  const offset = params.success ? (params.data.offset ?? 0) : 0;

  const [trades, totalResult] = await Promise.all([
    db.select().from(tradesTable).orderBy(desc(tradesTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(tradesTable),
  ]);

  res.json(ListTradesResponse.parse({
    trades: trades.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    })),
    total: totalResult[0]?.count ?? 0,
  }));
});

router.get("/trades/stats", async (_req, res): Promise<void> => {
  const all = await db.select().from(tradesTable);

  const totalTrades = all.length;
  const openTrades = all.filter((t) => t.status === "open").length;
  const closedTrades = all.filter((t) => t.status === "closed");
  const winningTrades = closedTrades.filter((t) => (t.pnlCents ?? 0) > 0).length;
  const losingTrades = closedTrades.filter((t) => (t.pnlCents ?? 0) <= 0).length;
  const totalPnlCents = all.reduce((acc, t) => acc + (t.pnlCents ?? 0), 0);
  const winRate = closedTrades.length > 0 ? winningTrades / closedTrades.length : 0;
  const avgPnlCents = closedTrades.length > 0 ? totalPnlCents / closedTrades.length : 0;

  res.json(GetTradeStatsResponse.parse({
    totalTrades,
    winningTrades,
    losingTrades,
    openTrades,
    totalPnlCents,
    winRate,
    avgPnlCents,
  }));
});

router.post("/bot/manual-trade", async (req, res): Promise<void> => {
  const parsed = ManualTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { ticker, side, limitCents, quantity } = parsed.data;
  const result = await manualTrade(ticker, side, limitCents, quantity ?? 1);
  res.json(ManualTradeResponse.parse(result));
});

router.post("/bot/coin-flip", async (_req, res): Promise<void> => {
  const result = await coinFlipTrade();
  res.json(CoinFlipResponse.parse(result));
});

export default router;
