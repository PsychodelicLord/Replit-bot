import { Router, type IRouter } from "express";
import { getBotState, getBotConfig, updateBotConfig, saveBotConfigToDb, clearStuckPositions, refreshBalance } from "../lib/kalshi-bot";
import { getMomentumBotState, startMomentumBot, stopMomentumBot, updateMomentumConfig, debugMomentumMarkets, resetSimStats, resetAllStats, getLivePerformanceReport, getPaperStats } from "../lib/momentumBot";
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
  SetMomentumBotAutoBody,
  GetMomentumBotStatusResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

/** Returns true only when running on Railway (the live deployment).
 *  Prevents the local dev server from accidentally placing real trades. */
function isProductionDeployment(): boolean {
  return !!process.env.RAILWAY_ENVIRONMENT;
}

function serializeMomentumState(s = getMomentumBotState()) {
  const core = getBotState();
  return {
    running: s.enabled,
    startedAt: null,
    marketsScanned: 0,
    tradesAttempted: 0,
    tradesSucceeded: 0,
    totalPnlCents: s.totalPnlCents ?? 0,
    dailyPnlCents: s.sessionPnlCents ?? 0,
    openPositionCount: s.simulatorMode ? (s.simOpenTradeCount ?? 0) : s.openTradeCount,
    balanceCents: core.balanceCents,
    stoppedReason: s.stopReason ?? null,
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
  // Keep dashboard balance fresh even when the legacy kalshi-bot loop is disabled.
  // Non-fatal on API issues: we return the last known balance snapshot.
  try {
    await refreshBalance();
  } catch {
    // ignore: status endpoint should remain available even if balance refresh fails
  }
  res.json(GetBotStatusResponse.parse(serializeMomentumState()));
});

router.post("/bot/start", async (_req, res): Promise<void> => {
  const momentum = getMomentumBotState();
  if (!isProductionDeployment() && !momentum.simulatorMode) {
    res.status(403).json({ error: "Trading is disabled on the dev server — use the Railway deployment." });
    return;
  }
  const s = startMomentumBot();
  res.json(StartBotResponse.parse(serializeMomentumState(s)));
});

router.post("/bot/stop", async (_req, res): Promise<void> => {
  const s = stopMomentumBot("Stopped via /api/bot/stop");
  res.json(StopBotResponse.parse(serializeMomentumState(s)));
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
  // Count every settled trade record that has a concrete P&L, not only status==="closed".
  // This prevents dashboard bias when losses are recorded under other final statuses
  // (e.g. expired/cancelled/manual reconciliation rows).
  const settledTradesRows = all.filter((t) => t.status !== "open" && t.pnlCents != null);
  const wins = settledTradesRows.filter((t) => (t.pnlCents ?? 0) > 0);
  const losses = settledTradesRows.filter((t) => (t.pnlCents ?? 0) < 0);
  const winningTrades = wins.length;
  const losingTrades = losses.length;
  const totalPnlCents = settledTradesRows.reduce((acc, t) => acc + (t.pnlCents ?? 0), 0);
  const totalWinCents = wins.reduce((acc, t) => acc + (t.pnlCents ?? 0), 0);
  const totalLossCents = Math.abs(losses.reduce((acc, t) => acc + (t.pnlCents ?? 0), 0));
  const todayPnlCents = all
    .filter((t) => t.status !== "open" && t.closedAt && new Date(t.closedAt) >= todayStart && t.pnlCents != null)
    .reduce((acc, t) => acc + (t.pnlCents ?? 0), 0);
  const settledCount = winningTrades + losingTrades;
  const winRate = settledCount > 0 ? winningTrades / settledCount : 0;
  const avgPnlCents = settledCount > 0 ? totalPnlCents / settledCount : 0;

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

router.post("/bot/clear-positions", async (_req, res): Promise<void> => {
  const result = await clearStuckPositions();
  res.json(result);
});

// ─── Momentum Bot routes ────────────────────────────────────────────────────
router.get("/bot/momentum/status", (_req, res): void => {
  const state = getMomentumBotState();
  const toMomentumStatus = (allTime?: { allTimeWins?: number; allTimeLosses?: number; allTimePnlCents?: number }) =>
    GetMomentumBotStatusResponse.parse({
      ...state,
      allTimeWins: allTime?.allTimeWins ?? 0,
      allTimeLosses: allTime?.allTimeLosses ?? 0,
      allTimePnlCents: allTime?.allTimePnlCents ?? 0,
    });

  db.select({
    allTimeWins:    sql<number>`cast(count(*) filter (where ${tradesTable.pnlCents} > 0) as int)`,
    allTimeLosses:  sql<number>`cast(count(*) filter (where ${tradesTable.pnlCents} < 0) as int)`,
    allTimePnlCents: sql<number>`cast(coalesce(sum(${tradesTable.pnlCents}), 0) as int)`,
  }).from(tradesTable).where(sql`${tradesTable.status} = 'closed'`)
    .then(([row]) => {
      res.json(toMomentumStatus(row));
    })
    .catch(() => {
      // Keep endpoint stable even if DB aggregate query fails.
      res.json(toMomentumStatus());
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
  const state = resetSimStats();
  res.json(GetMomentumBotStatusResponse.parse({
    ...state,
    allTimeWins: state.totalWins ?? 0,
    allTimeLosses: state.totalLosses ?? 0,
    allTimePnlCents: state.totalPnlCents ?? 0,
  }));
});

router.get("/bot/momentum/paper-stats", async (_req, res): Promise<void> => {
  try {
    const stats = await getPaperStats();
    res.json(stats);
  } catch (err) {
    // Return empty stats so the UI never crashes (e.g. table not yet migrated)
    console.error("[paper-stats] DB error, returning empty stats:", String(err));
    res.json({
      totalTrades: 0, wins: 0, losses: 0, winRatePct: 0,
      totalPnlCents: 0, evPerTradeCents: 0, maxDrawdownCents: 0,
      timeOfDay: [
        { label: "00-06", wins: 0, losses: 0, pnlCents: 0 },
        { label: "06-12", wins: 0, losses: 0, pnlCents: 0 },
        { label: "12-18", wins: 0, losses: 0, pnlCents: 0 },
        { label: "18-24", wins: 0, losses: 0, pnlCents: 0 },
      ],
      recentTrades: [],
    });
  }
});

router.post("/bot/momentum/reset-all", async (_req, res): Promise<void> => {
  const state = await resetAllStats();
  res.json(GetMomentumBotStatusResponse.parse({
    ...state,
    allTimeWins: state.totalWins ?? 0,
    allTimeLosses: state.totalLosses ?? 0,
    allTimePnlCents: state.totalPnlCents ?? 0,
  }));
});

// Live execution quality report — purely observational, real trades only
router.get("/bot/momentum/live-performance", (_req, res): void => {
  res.json(getLivePerformanceReport());
});

router.post("/bot/momentum/auto", async (req, res): Promise<void> => {
  try {
    const parsed = SetMomentumBotAutoBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const { enabled, balanceFloorCents, maxSessionLossCents, consecutiveLossLimit, betCostCents, simulatorMode, priceMin, priceMax, tpCents, slCents, staleMs, tpAbsoluteCents, sessionProfitTargetCents, allowedCoins } = parsed.data;

    // Real trading requires Railway deployment. Simulator mode can run anywhere.
    if (enabled && !simulatorMode && !isProductionDeployment()) {
      res.status(403).json({ error: "Live trading is disabled on the dev server — use Railway or enable Simulator mode." });
      return;
    }

    // Await config update so DB write is guaranteed before responding
    await updateMomentumConfig({
      balanceFloorCents:    balanceFloorCents    ?? 0,
      maxSessionLossCents:  maxSessionLossCents  ?? 0,
      consecutiveLossLimit: consecutiveLossLimit ?? 0,
      betCostCents:         betCostCents         ?? 30,
      simulatorMode:        simulatorMode        ?? false,
      priceMin:             priceMin             ?? 20,
      priceMax:             priceMax             ?? 80,
      tpCents:              tpCents,
      slCents:              slCents,
      staleMs:              staleMs,
      tpAbsoluteCents:          tpAbsoluteCents,
      sessionProfitTargetCents: sessionProfitTargetCents,
      allowedCoins:             allowedCoins,
    });

    const state = enabled ? startMomentumBot() : stopMomentumBot();
    res.json(GetMomentumBotStatusResponse.parse({
      ...state,
      allTimeWins: state.totalWins ?? 0,
      allTimeLosses: state.totalLosses ?? 0,
      allTimePnlCents: state.totalPnlCents ?? 0,
    }));
  } catch (err) {
    console.error("[momentum/auto] unexpected error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
});

// Emergency stop — requires ?confirm=yes to prevent accidental triggers from browser history/refresh
router.get("/bot/momentum/emergency-stop", (req, res): void => {
  if (req.query.confirm !== "yes") {
    res.status(400).json({ error: "Add ?confirm=yes to the URL to confirm emergency stop", hint: "e.g. /api/bot/momentum/emergency-stop?confirm=yes" });
    return;
  }
  try {
    const state = stopMomentumBot("Emergency stop via URL");
    res.json({ ok: true, enabled: state.enabled, status: state.status });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
});

export default router;
