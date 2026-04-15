import { Router, type IRouter } from "express";
import { startBot, stopBot, getBotState, getBotConfig, updateBotConfig, saveBotConfigToDb, manualTrade, coinFlipTrade, startCoinFlipAuto, stopCoinFlipAuto, getCoinFlipAutoState, clearStuckPositions } from "../lib/kalshi-bot";
import { getMomentumBotState, startMomentumBot, stopMomentumBot, updateMomentumConfig, debugMomentumMarkets, resetSimStats } from "../lib/momentumBot";
import { db, botLogsTable, tradesTable } from "@workspace/db";
import { desc, count, sql } from "drizzle-orm";
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
  CoinFlipAutoBody,
  CoinFlipAutoStatus,
  MomentumBotAutoBody,
  MomentumBotStatus,
} from "@workspace/api-zod";

const router: IRouter = Router();

/** Returns true only when running on Railway (the live deployment).
 *  Prevents the local dev server from accidentally placing real trades. */
function isProductionDeployment(): boolean {
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.COINFLIP_AUTO_START === "true");
}

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
  saveBotConfigToDb(updated).catch(() => {});
  res.json(UpdateBotConfigResponse.parse(updated));
});

router.get("/bot/status", async (_req, res): Promise<void> => {
  res.json(GetBotStatusResponse.parse(serializeState(getBotState())));
});

router.post("/bot/start", async (_req, res): Promise<void> => {
  if (!isProductionDeployment()) {
    res.status(403).json({ error: "Trading is disabled on the dev server — use the Railway deployment." });
    return;
  }
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

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const totalTrades = all.length;
  const openTrades = all.filter((t) => t.status === "open").length;
  const closedTrades = all.filter((t) => t.status === "closed");
  const wins = closedTrades.filter((t) => (t.pnlCents ?? 0) > 0);
  const losses = closedTrades.filter((t) => (t.pnlCents ?? 0) < 0);
  const winningTrades = wins.length;
  const losingTrades = losses.length;
  const totalPnlCents = closedTrades.reduce((acc, t) => acc + (t.pnlCents ?? 0), 0);
  const totalWinCents = wins.reduce((acc, t) => acc + (t.pnlCents ?? 0), 0);
  const totalLossCents = Math.abs(losses.reduce((acc, t) => acc + (t.pnlCents ?? 0), 0));
  const todayPnlCents = all
    .filter((t) => t.closedAt && new Date(t.closedAt) >= todayStart && t.pnlCents != null)
    .reduce((acc, t) => acc + (t.pnlCents ?? 0), 0);
  const settledTrades = winningTrades + losingTrades;
  const winRate = settledTrades > 0 ? winningTrades / settledTrades : 0;
  const avgPnlCents = settledTrades > 0 ? totalPnlCents / settledTrades : 0;

  res.json(GetTradeStatsResponse.parse({
    totalTrades,
    winningTrades,
    losingTrades,
    openTrades,
    totalPnlCents,
    totalWinCents,
    totalLossCents,
    todayPnlCents,
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
  if (!isProductionDeployment()) {
    res.status(403).json({ success: false, message: "Trading is disabled on the dev server — use the Railway deployment." });
    return;
  }
  const result = await coinFlipTrade();
  res.json(CoinFlipResponse.parse(result));
});

router.get("/bot/coin-flip/auto", (_req, res): void => {
  res.json(CoinFlipAutoStatus.parse(getCoinFlipAutoState()));
});

router.post("/bot/coin-flip/auto", (req, res): void => {
  const parsed = CoinFlipAutoBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { enabled, intervalSecs } = parsed.data;
  if (enabled && !isProductionDeployment()) {
    res.status(403).json({ error: "Trading is disabled on the dev server — use the Railway deployment." });
    return;
  }
  const state = enabled
    ? startCoinFlipAuto(intervalSecs ?? 60)
    : stopCoinFlipAuto();
  res.json(CoinFlipAutoStatus.parse(state));
});

router.post("/bot/clear-positions", async (_req, res): Promise<void> => {
  const result = await clearStuckPositions();
  res.json(result);
});

// ─── Momentum Bot routes ────────────────────────────────────────────────────
router.get("/bot/momentum/status", (_req, res): void => {
  const state = getMomentumBotState();
  db.select({
    allTimeWins:    sql<number>`cast(count(*) filter (where ${tradesTable.pnlCents} > 0) as int)`,
    allTimeLosses:  sql<number>`cast(count(*) filter (where ${tradesTable.pnlCents} <= 0 and ${tradesTable.pnlCents} is not null) as int)`,
    allTimePnlCents: sql<number>`cast(coalesce(sum(${tradesTable.pnlCents}), 0) as int)`,
  }).from(tradesTable).where(sql`${tradesTable.status} = 'closed'`)
    .then(([row]) => {
      res.json(MomentumBotStatus.parse({
        ...state,
        allTimeWins:     row?.allTimeWins     ?? 0,
        allTimeLosses:   row?.allTimeLosses   ?? 0,
        allTimePnlCents: row?.allTimePnlCents ?? 0,
      }));
    })
    .catch(() => {
      res.json(MomentumBotStatus.parse(state));
    });
});

router.get("/bot/momentum/debug", async (_req, res): Promise<void> => {
  try {
    const data = await debugMomentumMarkets();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/bot/momentum/reset-sim", (_req, res): void => {
  res.json(MomentumBotStatus.parse(resetSimStats()));
});

router.post("/bot/momentum/auto", (req, res): void => {
  const parsed = MomentumBotAutoBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { enabled, balanceFloorCents, maxSessionLossCents, consecutiveLossLimit, betCostCents, simulatorMode, priceMin, priceMax } = parsed.data;

  // Real trading requires Railway deployment. Simulator mode can run anywhere.
  if (enabled && !simulatorMode && !isProductionDeployment()) {
    res.status(403).json({ error: "Live trading is disabled on the dev server — use Railway or enable Simulator mode." });
    return;
  }

  // Update risk config if provided
  updateMomentumConfig({
    balanceFloorCents:    balanceFloorCents    ?? 0,
    maxSessionLossCents:  maxSessionLossCents  ?? 0,
    consecutiveLossLimit: consecutiveLossLimit ?? 0,
    betCostCents:         betCostCents         ?? 30,
    simulatorMode:        simulatorMode        ?? false,
    priceMin:             priceMin             ?? 20,
    priceMax:             priceMax             ?? 80,
  });

  const state = enabled ? startMomentumBot() : stopMomentumBot();
  res.json(MomentumBotStatus.parse(state));
});

export default router;
