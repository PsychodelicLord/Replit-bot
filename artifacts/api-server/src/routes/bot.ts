import { Router, type IRouter } from "express";
import { startBot, stopBot, getBotState, getBotConfig, updateBotConfig, saveBotConfigToDb, manualTrade, clearStuckPositions } from "../lib/kalshi-bot";
import { getMomentumBotState, startMomentumBot, stopMomentumBot, updateMomentumConfig, debugMomentumMarkets, resetSimStats, resetAllStats, getLivePerformanceReport } from "../lib/momentumBot";
import { getOutcomeBotState, startOutcomeBot, stopOutcomeBot, updateOutcomeBotConfig, resetOutcomeStats, getOutcomeMarketStates, getOutcomeOpenPositions } from "../lib/outcomeBot";
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
  MomentumBotAutoBody,
  MomentumBotStatus,
  OutcomeBotToggleBody,
  OutcomeBotStatus,
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

router.post("/bot/clear-positions", async (_req, res): Promise<void> => {
  const result = await clearStuckPositions();
  res.json(result);
});

// ─── Momentum Bot routes ────────────────────────────────────────────────────
router.get("/bot/momentum/status", (_req, res): void => {
  const state = getMomentumBotState();
  db.select({
    allTimeWins:    sql<number>`cast(count(*) filter (where ${tradesTable.pnlCents} > 0) as int)`,
    allTimeLosses:  sql<number>`cast(count(*) filter (where ${tradesTable.pnlCents} < 0) as int)`,
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

router.post("/bot/momentum/reset-all", async (_req, res): Promise<void> => {
  const state = await resetAllStats();
  res.json(MomentumBotStatus.parse(state));
});

// Live execution quality report — purely observational, real trades only
router.get("/bot/momentum/live-performance", (_req, res): void => {
  res.json(getLivePerformanceReport());
});

router.post("/bot/momentum/auto", (req, res): void => {
  try {
    const parsed = MomentumBotAutoBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const { enabled, balanceFloorCents, maxSessionLossCents, consecutiveLossLimit, betCostCents, simulatorMode, priceMin, priceMax, tpCents, slCents, staleMs, tpAbsoluteCents, sessionProfitTargetCents } = parsed.data;

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
      tpCents:              tpCents,
      slCents:              slCents,
      staleMs:              staleMs,
      tpAbsoluteCents:          tpAbsoluteCents,
      sessionProfitTargetCents: sessionProfitTargetCents,
    });

    const state = enabled ? startMomentumBot() : stopMomentumBot();
    res.json(MomentumBotStatus.parse(state));
  } catch (err) {
    console.error("[momentum/auto] unexpected error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
});

// ─── Outcome Bot routes ──────────────────────────────────────────────────────

router.get("/bot/outcome/status", (_req, res): void => {
  const s = getOutcomeBotState();
  const positions   = getOutcomeOpenPositions();
  const mktStates   = getOutcomeMarketStates();
  try {
    res.json(OutcomeBotStatus.parse({ ...s, openPositions: positions, marketStates: mktStates }));
  } catch {
    res.json({ ...s, openPositions: positions, marketStates: mktStates });
  }
});

router.post("/bot/outcome/toggle", (req, res): void => {
  try {
    const parsed = OutcomeBotToggleBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

    const { enabled, betCostCents } = parsed.data;
    if (betCostCents !== undefined) updateOutcomeBotConfig({ betCostCents });

    const s = enabled ? startOutcomeBot() : stopOutcomeBot();
    res.json(OutcomeBotStatus.parse({ ...s, openPositions: getOutcomeOpenPositions(), marketStates: getOutcomeMarketStates() }));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
  }
});

router.post("/bot/outcome/reset", (_req, res): void => {
  res.json(resetOutcomeStats());
});

router.get("/bot/outcome/emergency-stop", (req, res): void => {
  if (req.query.confirm !== "yes") {
    res.status(400).json({ error: "Add ?confirm=yes to confirm", hint: "/api/bot/outcome/emergency-stop?confirm=yes" });
    return;
  }
  const s = stopOutcomeBot("Emergency stop via URL");
  res.json({ ok: true, enabled: s.enabled, status: s.status });
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
