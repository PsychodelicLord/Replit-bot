import { Router, type IRouter } from "express";
import { startBot, stopBot, getBotState } from "../lib/kalshi-bot";
import { db, botLogsTable, tradesTable } from "@workspace/db";
import { desc, count, sum, eq, isNull, isNotNull } from "drizzle-orm";
import {
  GetBotStatusResponse,
  StartBotResponse,
  StopBotResponse,
  GetBotLogsResponse,
  GetBotLogsQueryParams,
  ListTradesResponse,
  ListTradesQueryParams,
  GetTradeStatsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/bot/status", async (_req, res): Promise<void> => {
  const s = getBotState();
  res.json(GetBotStatusResponse.parse({
    running: s.running,
    startedAt: s.startedAt,
    marketsScanned: s.marketsScanned,
    tradesAttempted: s.tradesAttempted,
    tradesSucceeded: s.tradesSucceeded,
    totalPnlCents: s.totalPnlCents,
  }));
});

router.post("/bot/start", async (_req, res): Promise<void> => {
  const s = await startBot();
  res.json(StartBotResponse.parse({
    running: s.running,
    startedAt: s.startedAt,
    marketsScanned: s.marketsScanned,
    tradesAttempted: s.tradesAttempted,
    tradesSucceeded: s.tradesSucceeded,
    totalPnlCents: s.totalPnlCents,
  }));
});

router.post("/bot/stop", async (_req, res): Promise<void> => {
  const s = await stopBot();
  res.json(StopBotResponse.parse({
    running: s.running,
    startedAt: s.startedAt,
    marketsScanned: s.marketsScanned,
    tradesAttempted: s.tradesAttempted,
    tradesSucceeded: s.tradesSucceeded,
    totalPnlCents: s.totalPnlCents,
  }));
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

export default router;
