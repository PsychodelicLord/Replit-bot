/**
 * Momentum Bot — selective trend-following scalper
 *
 * FIXES APPLIED (stability audit):
 *  1. MAX_POSITIONS reduced to 1 — eliminates all multi-position interference bugs
 *  2. startMomentumBot: NO setTimeout delay — direct setInterval, no zombie timer risk
 *  3. startMomentumBot: always clears existing timers + resets scanInProgress on start
 *  4. placeSellOrder give-up path: fires one final aggressive market sell before removing position
 *  5. placeSellOrder give-up path: records P&L loss in DB and W/L counter (was silent)
 *  6. State consistency: entry gate always uses openPositions.length directly, never derived counter
 *  7. manualTrade bypass: blocked while bot is running (was bypassing all guards)
 *  8. Sell give-up logging: full dbLog entry so Railway logs show orphan positions
 *  9. Partial fill guard: warns if fillCount !== contractCount on sell
 * 10. simulatorMode flip guard: activePositions ref captured once per scan tick
 */

import { kalshiFetch, getBotState, refreshBalance, setTradeClosedHook } from "./kalshi-bot";
import { logger } from "./logger";
import { db, tradesTable, botLogsTable, momentumSettingsTable, paperTradesTable } from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";

// ─── Constants ─────────────────────────────────────────────────────────────
const ALLOWED_COINS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB"];
const ALLOWED_TICKER_PREFIXES = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXDOGE15M", "KXXRP15M", "KXBNB15M"];

const PRICE_MIN  = 20;
const PRICE_MAX  = 80;
const ENTRY_BUFFER_CENTS = 5;
const SPREAD_MAX = 5;
const MIN_MINUTES_REMAINING = 5;

// FIX #1: MAX_POSITIONS = 1
// With 2 slots: two sell monitors compete, two retry loops can both stall,
// state consistency requires tracking two positions. With 1 slot, state is
// binary (in trade / not in trade) and every guard becomes trivially correct.
const MAX_POSITIONS = 1;

const COOLDOWN_MS = 75_000;
const MIN_PRICE_FOR_CONTRACTS = 20;
const MOMENTUM_WINDOW_MS    = 15_000;
const MIN_FAST_MOVE_CENTS   = 2;
const MAX_ENTRY_PRICE_YES   = 87;
const MIN_ENTRY_PRICE_YES   = 13;
const PRICE_HISTORY_MAX_MS  = 60_000;
const TRADE_SPREAD_MAX      = 4;
const TRADE_SPREAD_MAX_SIM  = 5;
const SPREAD_MAX_SIM        = 8;
const MIN_MINUTES_REMAINING_SIM = 2;

const SCAN_INTERVAL_MS = 15_000;
const SELL_INTERVAL_MS = 2_000;

const FEE_RATE = 0.07;

// ─── Types ─────────────────────────────────────────────────────────────────
interface MarketMomentumState {
  priceHistory: Array<{ price: number; ts: number }>;
}

interface MomentumPosition {
  tradeId: number;
  entrySlippageCents?: number;
  marketId: string;
  marketTitle: string;
  side: "YES" | "NO";
  entryPriceCents: number;
  contractCount: number;
  enteredAt: number;
  lastSeenPriceCents: number;
  lastMovedAt: number;
  buyOrderId: string | null;
  closeTs: number;
  sellRetries?: number;
  pendingSellOrderId?: string;
}

interface MomentumDecision {
  action: "BUY_YES" | "BUY_NO" | "SKIP";
  reason: string;
  moveCents: number;
  moveMs: number;
  centsPerSec: number;
}

// ─── State ─────────────────────────────────────────────────────────────────
export interface MomentumBotState {
  enabled: boolean;
  autoMode: boolean;
  status: "DISABLED" | "WAITING_FOR_SETUP" | "IN_TRADE" | "PAUSED";
  openTradeCount: number;
  lastDecision: string | null;
  lastDecisionAt: string | null;
  totalWins: number;
  totalLosses: number;
  totalPnlCents: number;
  sessionPnlCents: number;
  sessionWins: number;
  sessionLosses: number;
  consecutiveLosses: number;
  pausedUntilMs: number | null;
  pauseReason: string | null;
  stopReason: string | null;
  startingBalanceCents: number | null;
  balanceFloorCents: number;
  maxSessionLossCents: number;
  consecutiveLossLimit: number;
  betCostCents: number;
  simulatorMode: boolean;
  simPnlCents: number;
  simWins: number;
  simLosses: number;
  simOpenTradeCount: number;
  priceMin: number;
  priceMax: number;
  tpCents: number;
  slCents: number;
  staleMs: number;
  tpAbsoluteCents: number;
  sessionProfitTargetCents: number;
  allowedCoins: string[];
  healthScore: {
    total: number;
    label: "Healthy" | "Fragile" | "Broken" | "Pending";
    tradesInBuffer: number;
    winRate: number;
    netEV: number;
    avgWin: number;
    avgLoss: number;
    staleRate: number;
    evScore: number; stabilityScore: number; ratioScore: number; staleScore: number; execScore: number;
  } | null;
}

const state: MomentumBotState = {
  enabled: false,
  autoMode: false,
  status: "DISABLED",
  openTradeCount: 0,
  lastDecision: null,
  lastDecisionAt: null,
  totalWins: 0,
  totalLosses: 0,
  totalPnlCents: 0,
  sessionPnlCents: 0,
  sessionWins: 0,
  sessionLosses: 0,
  consecutiveLosses: 0,
  pausedUntilMs: null,
  pauseReason: null,
  stopReason: "Server started — not yet enabled",
  startingBalanceCents: null,
  balanceFloorCents: 0,
  maxSessionLossCents: 0,
  consecutiveLossLimit: 0,
  betCostCents: 30,
  simulatorMode: false,
  simPnlCents: 0,
  simWins: 0,
  simLosses: 0,
  simOpenTradeCount: 0,
  priceMin: 38,
  priceMax: 62,
  tpCents: 5,
  slCents: 2,
  staleMs: 65_000,
  tpAbsoluteCents: 0,
  sessionProfitTargetCents: 0,
  allowedCoins: ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB"],
  healthScore: null,
};

export interface MomentumBotConfig {
  balanceFloorCents: number;
  maxSessionLossCents: number;
  consecutiveLossLimit: number;
  betCostCents: number;
  simulatorMode?: boolean;
  priceMin?: number;
  priceMax?: number;
  tpCents?: number;
  slCents?: number;
  staleMs?: number;
  tpAbsoluteCents?: number;
  sessionProfitTargetCents?: number;
  allowedCoins?: string[];
  enabled?: boolean;
}

const marketMomentum = new Map<string, MarketMomentumState>();

// FIX #6: openPositions is the SINGLE source of truth for live trades.
// Entry gate always reads openPositions.length directly — never state.openTradeCount.
// state.openTradeCount is updated after every mutation for UI reporting only.
const openPositions: MomentumPosition[] = [];
const simPositions: MomentumPosition[] = [];
const marketCooldowns = new Map<string, number>();

const POST_WIN_COOLDOWN_MS  = 60_000;
const POST_LOSS_COOLDOWN_MS = 120_000;
let globalCooldownUntilMs = 0;

const MIN_BALANCE_HARD_FLOOR_CENTS = 200;

let scanTimer: NodeJS.Timeout | null = null;
let sellTimer: NodeJS.Timeout | null = null;

let startupHoldUntilMs = 0;
let recoveryReady = false;

// ─── Bot Health Score rolling buffer ────────────────────────────────────────
interface TradeRecord {
  pnlCents:      number;
  isWin:         boolean;
  exitReason:    "TP" | "SL" | "STALE";
  slippageCents: number;
  timestamp:     number;
}

const healthBuffer: TradeRecord[] = [];
let   healthTradeCount = 0;

// ─── Live Execution Observation Layer ────────────────────────────────────────
export interface LiveTradeRecord {
  timestamp:          number;
  market:             string;
  side:               "YES" | "NO";
  exitReason:         "TP" | "SL" | "STALE";
  entryPriceCents:    number;
  entrySlippage:      number;
  midAtTrigger:       number;
  expectedExitCents:  number;
  actualFillCents:    number;
  exitSlippage:       number;
  pnlCents:           number;
}

const liveTradeBuffer: LiveTradeRecord[] = [];
let   liveTradeCount = 0;

export interface LivePerformanceReport {
  sampleSize:     number;
  winRate:        number;
  avgWinCents:    number;
  avgLossCents:   number;
  evPerTrade:     number;
  staleRate:      number;
  totalPnlCents:  number;
  avgEntrySlip:   number;
  avgExitSlip:    number;
  tpRate:         number;
  slRate:         number;
  recentTrades:   LiveTradeRecord[];
}

function emitLivePerformanceReport(): void {
  const buf = liveTradeBuffer;
  if (buf.length === 0) return;
  const wins   = buf.filter(t => t.pnlCents > 0);
  const losses = buf.filter(t => t.pnlCents < 0);
  const stales = buf.filter(t => t.exitReason === "STALE");
  const tps    = buf.filter(t => t.exitReason === "TP");
  const sls    = buf.filter(t => t.exitReason === "SL");
  const winRate    = wins.length / buf.length;
  const avgWin     = wins.length   ? wins.reduce((s,t)   => s + t.pnlCents, 0) / wins.length   : 0;
  const avgLoss    = losses.length ? losses.reduce((s,t)  => s + t.pnlCents, 0) / losses.length : 0;
  const ev         = buf.reduce((s, t) => s + t.pnlCents, 0) / buf.length;
  const staleRate  = stales.length / buf.length;
  const avgEntrySlip = buf.reduce((s,t) => s + t.entrySlippage, 0) / buf.length;
  const avgExitSlip  = buf.reduce((s,t) => s + t.exitSlippage,  0) / buf.length;
  const totalPnl   = buf.reduce((s, t) => s + t.pnlCents, 0);
  const report = `\n${"─".repeat(60)}\n📊 LIVE EXECUTION REPORT — last ${buf.length} real trades (total: ${liveTradeCount})\n` +
    `  Win rate:      ${(winRate * 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L)\n` +
    `  Avg win:       +${avgWin.toFixed(1)}¢\n` +
    `  Avg loss:      ${avgLoss.toFixed(1)}¢\n` +
    `  EV per trade:  ${ev >= 0 ? "+" : ""}${ev.toFixed(2)}¢\n` +
    `  Stale exits:   ${(staleRate * 100).toFixed(1)}%  (${stales.length})\n` +
    `  TP / SL split: ${tps.length} TP / ${sls.length} SL\n` +
    `  Entry slippage avg: ${avgEntrySlip.toFixed(2)}¢\n` +
    `  Exit  slippage avg: ${avgExitSlip.toFixed(2)}¢\n` +
    `  Total P&L:     ${totalPnl >= 0 ? "+" : ""}${totalPnl}¢\n` +
    `${"─".repeat(60)}`;
  log(report);
  dbLog("info", report, "live-perf-report");
}

function recordLiveTradeExecution(record: LiveTradeRecord): void {
  liveTradeBuffer.push(record);
  if (liveTradeBuffer.length > 100) liveTradeBuffer.shift();
  liveTradeCount++;
  const slipStr = record.exitSlippage >= 0
    ? `+${record.exitSlippage}¢ better than expected`
    : `${record.exitSlippage}¢ worse than expected`;
  log(
    `📋 LIVE EXEC | ${record.side} ${record.market} | ` +
    `entry:${record.entryPriceCents}¢ mid@trigger:${record.midAtTrigger}¢ ` +
    `expectedExit:${record.expectedExitCents}¢ actualFill:${record.actualFillCents}¢ (${slipStr}) | ` +
    `reason:${record.exitReason} pnl:${record.pnlCents >= 0 ? "+" : ""}${record.pnlCents}¢`,
  );
  if (liveTradeCount % 50 === 0) emitLivePerformanceReport();
}

export function getLivePerformanceReport(): LivePerformanceReport {
  const buf = liveTradeBuffer;
  if (buf.length === 0) {
    return {
      sampleSize: 0, winRate: 0, avgWinCents: 0, avgLossCents: 0,
      evPerTrade: 0, staleRate: 0, totalPnlCents: 0,
      avgEntrySlip: 0, avgExitSlip: 0, tpRate: 0, slRate: 0, recentTrades: [],
    };
  }
  const wins   = buf.filter(t => t.pnlCents > 0);
  const losses = buf.filter(t => t.pnlCents < 0);
  return {
    sampleSize:    buf.length,
    winRate:       wins.length / buf.length,
    avgWinCents:   wins.length   ? wins.reduce((s,t)   => s + t.pnlCents, 0) / wins.length   : 0,
    avgLossCents:  losses.length ? losses.reduce((s,t)  => s + t.pnlCents, 0) / losses.length : 0,
    evPerTrade:    buf.reduce((s,t) => s + t.pnlCents, 0) / buf.length,
    staleRate:     buf.filter(t => t.exitReason === "STALE").length / buf.length,
    tpRate:        buf.filter(t => t.exitReason === "TP").length    / buf.length,
    slRate:        buf.filter(t => t.exitReason === "SL").length    / buf.length,
    totalPnlCents: buf.reduce((s,t) => s + t.pnlCents, 0),
    avgEntrySlip:  buf.reduce((s,t) => s + t.entrySlippage, 0) / buf.length,
    avgExitSlip:   buf.reduce((s,t) => s + t.exitSlippage,  0) / buf.length,
    recentTrades:  buf.slice(-20).reverse(),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function log(msg: string, data?: Record<string, unknown>) {
  logger.info(data ?? {}, `[MOMENTUM BOT] ${msg}`);
}

function warn(msg: string, data?: Record<string, unknown>) {
  logger.warn(data ?? {}, `[MOMENTUM BOT] ${msg}`);
}

const _dbLogThrottle = new Map<string, number>();
function dbLog(level: "info" | "warn" | "error", message: string, throttleKey?: string): void {
  if (throttleKey) {
    const last = _dbLogThrottle.get(throttleKey) ?? 0;
    if (Date.now() - last < 60_000) return;
    _dbLogThrottle.set(throttleKey, Date.now());
  }
  db.insert(botLogsTable).values({ level, message }).catch(() => {});
}

function isMomentumMarket(ticker: string): boolean {
  const up = ticker.toUpperCase();
  if (!ALLOWED_TICKER_PREFIXES.some(p => up.startsWith(p))) return false;
  const coin = coinLabel(up);
  return state.allowedCoins.includes(coin);
}

function coinLabel(ticker: string): string {
  for (const coin of ALLOWED_COINS) {
    if (ticker.toUpperCase().includes(coin)) return coin;
  }
  return ticker;
}

// ─── Risk Management ───────────────────────────────────────────────────────
function checkRiskPause(): boolean {
  if (state.pausedUntilMs !== null) {
    if (Date.now() < state.pausedUntilMs) return true;
    log(`⏰ Risk cooldown expired — resuming trading`, { reason: state.pauseReason });
    state.pausedUntilMs = null;
    state.pauseReason = null;
  }
  return false;
}

function triggerPause(durationMs: number, reason: string) {
  state.pausedUntilMs = Date.now() + durationMs;
  state.pauseReason = reason;
  state.status = "PAUSED";
  log(`🚨 ${reason} — pausing for ${Math.round(durationMs / 60_000)} min`);
}

function recordTradeResult(entryPriceCents: number, exitPriceCents: number, pnlCents: number) {
  state.sessionPnlCents += pnlCents;
  if (pnlCents > 0) {
    state.totalWins++;
    state.sessionWins++;
    state.consecutiveLosses = 0;
  } else if (pnlCents < 0) {
    state.totalLosses++;
    state.sessionLosses++;
    state.consecutiveLosses++;
  }
  state.totalPnlCents = (state.totalPnlCents ?? 0) + pnlCents;
  db.insert(momentumSettingsTable)
    .values({ id: 1, totalWins: state.totalWins, totalLosses: state.totalLosses, totalPnlCents: state.totalPnlCents ?? 0 })
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set: { totalWins: state.totalWins, totalLosses: state.totalLosses, totalPnlCents: state.totalPnlCents ?? 0 } })
    .catch(err => console.error("[momentumBot] recordTradeResult DB save failed:", String(err)));
  log(
    `📊 TRADE CLOSED | entry: ${entryPriceCents}¢ → exit: ${exitPriceCents}¢ | P&L: ${pnlCents >= 0 ? "+" : ""}${pnlCents}¢ | W:${state.totalWins} L:${state.totalLosses} | session: ${state.sessionPnlCents >= 0 ? "+" : ""}${state.sessionPnlCents}¢`,
    { entryPriceCents, exitPriceCents, pnlCents, totalWins: state.totalWins, totalLosses: state.totalLosses, sessionPnlCents: state.sessionPnlCents },
  );
  if (state.consecutiveLossLimit > 0 && state.consecutiveLosses >= state.consecutiveLossLimit) {
    stopMomentumBot(`${state.consecutiveLosses} consecutive losses hit limit of ${state.consecutiveLossLimit}`);
    return;
  }
  if (state.maxSessionLossCents > 0 && state.sessionPnlCents <= -state.maxSessionLossCents) {
    stopMomentumBot(`Session loss limit hit: ${state.sessionPnlCents}¢ ≤ -${state.maxSessionLossCents}¢`);
    return;
  }
  if (state.sessionProfitTargetCents > 0 && state.sessionPnlCents >= state.sessionProfitTargetCents) {
    stopMomentumBot(`🎯 Session profit target reached: +${state.sessionPnlCents}¢ ≥ +${state.sessionProfitTargetCents}¢ — locking in gains`);
  }
}

// ─── Time-Based Fast-Move Detection ────────────────────────────────────────
export function evaluateMomentum(marketId: string, currentPriceCents: number): MomentumDecision {
  const now = Date.now();
  if (!marketMomentum.has(marketId)) {
    marketMomentum.set(marketId, { priceHistory: [] });
  }
  const ms = marketMomentum.get(marketId)!;
  ms.priceHistory.push({ price: currentPriceCents, ts: now });
  const cutoff = now - PRICE_HISTORY_MAX_MS;
  ms.priceHistory = ms.priceHistory.filter(p => p.ts >= cutoff);
  const skip = (reason: string): MomentumDecision => ({
    action: "SKIP", reason, moveCents: 0, moveMs: 0, centsPerSec: 0,
  });
  if (ms.priceHistory.length < 2) return skip("First sample — establishing baseline");
  const prevHistory   = ms.priceHistory.slice(0, -1);
  const windowStart   = now - MOMENTUM_WINDOW_MS;
  const windowPrev    = prevHistory.filter(p => p.ts >= windowStart);
  const reference     = windowPrev.length >= 1
    ? windowPrev[0]
    : prevHistory[prevHistory.length - 1];
  const rawMove     = currentPriceCents - reference.price;
  const moveMs      = Math.max(now - reference.ts, 1);
  const absMv       = Math.abs(rawMove);
  const centsPerSec = absMv / (moveMs / 1000);
  console.log(`[MOMENTUM] ${marketId} | ${currentPriceCents}¢ | move:${rawMove > 0 ? "+" : ""}${rawMove}¢ in ${Math.round(moveMs / 1000)}s (${centsPerSec.toFixed(2)}¢/s) | history:${ms.priceHistory.length} samples`);
  if (absMv < MIN_FAST_MOVE_CENTS) {
    return skip(`Flat — ${absMv}¢ move in ${Math.round(moveMs / 1000)}s (need ≥${MIN_FAST_MOVE_CENTS}¢ within ${MOMENTUM_WINDOW_MS / 1000}s)`);
  }
  if (rawMove > 0) {
    if (currentPriceCents > MAX_ENTRY_PRICE_YES) {
      return skip(`BUY_YES blocked — ${currentPriceCents}¢ > hard cap ${MAX_ENTRY_PRICE_YES}¢`);
    }
    return { action: "BUY_YES", reason: `Fast momentum ▲ +${rawMove}¢ in ${Math.round(moveMs / 1000)}s (${centsPerSec.toFixed(2)}¢/s)`, moveCents: absMv, moveMs, centsPerSec };
  } else {
    if (currentPriceCents < MIN_ENTRY_PRICE_YES) {
      return skip(`BUY_NO blocked — ${currentPriceCents}¢ < hard cap ${MIN_ENTRY_PRICE_YES}¢`);
    }
    return { action: "BUY_NO", reason: `Fast momentum ▼ ${rawMove}¢ in ${Math.round(moveMs / 1000)}s (${centsPerSec.toFixed(2)}¢/s)`, moveCents: absMv, moveMs, centsPerSec };
  }
}

// ─── Market scanning ───────────────────────────────────────────────────────
function rawToIntCents(raw: number): number {
  if (raw <= 0) return 0;
  return raw <= 1.0 ? Math.round(raw * 100) : Math.round(raw);
}

async function fetchMarketOrderBook(
  ticker: string,
  hintAskCents?: number,
  hintBidCents?: number,
): Promise<{ bid: number; ask: number; spread: number; mid: number } | null> {
  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}/orderbook`) as {
      orderbook_fp?: { yes_dollars?: Array<[number, number]>; no_dollars?: Array<[number, number]>; yes?: Array<[number, number]>; no?: Array<[number, number]> };
      orderbook?: { yes?: Array<[number, number]>; no?: Array<[number, number]> };
    };
    const ob = resp?.orderbook_fp ?? resp?.orderbook;
    const yesSide = (ob as any)?.yes_dollars ?? (ob as any)?.yes ?? [];
    const noSide  = (ob as any)?.no_dollars  ?? (ob as any)?.no  ?? [];
    if (yesSide.length > 0 || noSide.length > 0) {
      const bestYesAsk = rawToIntCents(yesSide[0]?.[0] ?? 0);
      const bestNoAsk  = rawToIntCents(noSide[0]?.[0] ?? 0);
      const bestYesBid = bestNoAsk > 0 ? 100 - bestNoAsk : 0;
      const ask = bestYesAsk;
      const bid = bestYesBid > 0 ? bestYesBid : Math.max(0, ask - 2);
      const spread = ask - bid;
      const mid = Math.round((ask + bid) / 2);
      if (ask > 0 && bid > 0) return { bid, ask, spread, mid };
    }
    if (hintAskCents && hintBidCents && hintAskCents > 0 && hintBidCents > 0) {
      const spread = hintAskCents - hintBidCents;
      const mid = Math.round((hintAskCents + hintBidCents) / 2);
      return { bid: hintBidCents, ask: hintAskCents, spread, mid };
    }
    const detailResp = await kalshiFetch("GET", `/markets/${ticker}`) as {
      market?: { yes_ask_dollars?: number; yes_bid_dollars?: number };
    };
    const m = detailResp?.market;
    if (m?.yes_ask_dollars && m.yes_ask_dollars > 0) {
      const ask = Math.round(m.yes_ask_dollars * 100);
      const bid = m.yes_bid_dollars ? Math.round(m.yes_bid_dollars * 100) : Math.max(0, ask - 2);
      const spread = ask - bid;
      const mid = Math.round((ask + bid) / 2);
      if (ask > 0 && bid > 0) return { bid, ask, spread, mid };
    }
    return null;
  } catch {
    return null;
  }
}

type RawMarket = {
  ticker?: string;
  title?: string;
  close_time?: string;
  status?: string;
  yes_ask_dollars?: number;
  yes_bid_dollars?: number;
};

function rawToMarket(m: RawMarket, now: number) {
  const closeTs = m.close_time ? new Date(m.close_time).getTime() : 0;
  const minutesRemaining = closeTs > 0 ? Math.max(0, (closeTs - now) / 60_000) : 0;
  const askCents = m.yes_ask_dollars != null && m.yes_ask_dollars > 0 ? Math.round(m.yes_ask_dollars * 100) : 0;
  const bidCents = m.yes_bid_dollars != null && m.yes_bid_dollars > 0 ? Math.round(m.yes_bid_dollars * 100) : 0;
  return { ticker: m.ticker!, title: m.title ?? m.ticker!, minutesRemaining, closeTs, status: m.status ?? "open", askCents, bidCents };
}

let _marketCache: {
  markets: Array<{ ticker: string; title: string; minutesRemaining: number; closeTs: number; status: string; askCents: number; bidCents: number }>;
  cachedAt: number;
} | null = null;
const MARKET_CACHE_TTL_MS = 2 * 60_000;

export async function fetchActiveMarkets(): Promise<Array<{
  ticker: string; title: string; minutesRemaining: number; closeTs: number; status: string; askCents: number; bidCents: number;
}>> {
  const now = Date.now();
  if (_marketCache && now - _marketCache.cachedAt < MARKET_CACHE_TTL_MS) return _marketCache.markets;
  console.log(`[FETCH] Market cache stale — refreshing from Kalshi API`);
  const allRaw: RawMarket[] = [];
  for (const prefix of ALLOWED_TICKER_PREFIXES) {
    try {
      const resp = await kalshiFetch("GET", `/markets?series_ticker=${prefix}&status=open&limit=5`) as { markets?: RawMarket[] };
      const raw = resp?.markets ?? [];
      if (raw.length > 0) {
        allRaw.push(...raw);
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("429")) {
        warn(`[FETCH] Rate-limited on ${prefix} — using stale cache`);
        if (_marketCache) return _marketCache.markets;
        return [];
      }
      warn(`[FETCH] Error fetching ${prefix}: ${msg}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  const markets = allRaw
    .filter(m => m.ticker && (!m.status || m.status === "open" || m.status === "active"))
    .map(m => rawToMarket(m, now))
    .filter(m => m.minutesRemaining > (state.simulatorMode ? MIN_MINUTES_REMAINING_SIM : MIN_MINUTES_REMAINING));
  if (markets.length > 0) {
    _marketCache = { markets, cachedAt: now };
  } else {
    _marketCache = null;
  }
  return markets;
}

// ─── Order placement ────────────────────────────────────────────────────────
type BuyOrderResult =
  | { ok: true; orderId: string; fillPrice: number; contractCount: number }
  | { ok: false; reason: "budget_too_small" | "order_failed"; message: string };

async function placeBuyOrder(
  ticker: string,
  side: "YES" | "NO",
  limitCents: number,
  betCostCents: number,
): Promise<BuyOrderResult> {
  const clientOrderId = `momentum-${ticker}-${side}-${Date.now()}`;
  const noPriceCents      = 100 - limitCents;
  const pricePerContract  = side === "NO" ? noPriceCents : limitCents;
  const contractCount = Math.floor(betCostCents / pricePerContract);
  if (contractCount < 1) {
    return { ok: false, reason: "budget_too_small", message: `budget ${betCostCents}¢ < single-contract price ${pricePerContract}¢` };
  }
  const HARD_MAX_CENTS = 2000;
  const maxContractsByHardCap = Math.max(1, Math.floor(HARD_MAX_CENTS / pricePerContract));
  const safeCount = Math.min(contractCount, maxContractsByHardCap);
  const estimatedCost = safeCount * pricePerContract;
  const balanceCents = getBotState().balanceCents;
  console.log(`[SIZE CHECK] requested=${betCostCents}¢ capped=${estimatedCost}¢ balance=${balanceCents}¢ contracts=${safeCount} price=${pricePerContract}¢`);
  if (estimatedCost > betCostCents) {
    const msg = `[SIZE FAIL-SAFE] estimatedCost=${estimatedCost}¢ exceeds betCostCents=${betCostCents}¢ — ORDER BLOCKED`;
    console.error(msg);
    throw new Error(msg);
  }
  const payload: Record<string, unknown> = {
    ticker,
    client_order_id: clientOrderId,
    type:   "limit",
    action: "buy",
    side:   side.toLowerCase(),
    count:  safeCount,
    yes_price: side === "YES" ? limitCents   : undefined,
    no_price:  side === "NO"  ? noPriceCents : undefined,
  };
  console.log(`[ORDER PAYLOAD] ${JSON.stringify(payload)}`);
  try {
    const resp = await kalshiFetch("POST", "/portfolio/orders", payload) as {
      order?: { order_id?: string; yes_price?: number; no_price?: number; count?: number }
    };
    console.log(`[ORDER RESPONSE] ${JSON.stringify(resp)}`);
    const orderId   = resp?.order?.order_id ?? clientOrderId;
    const rawPrice  = side === "YES" ? (resp?.order?.yes_price ?? 0) : (resp?.order?.no_price ?? 0);
    const fillPrice = rawPrice > 0 ? Math.round(rawPrice * 100) : pricePerContract;
    const filled    = resp?.order?.count ?? contractCount;
    console.log(`[ORDER SUCCESS] orderId:${orderId} fillPrice:${fillPrice}¢ contracts:${filled}`);
    return { ok: true, orderId, fillPrice, contractCount: filled };
  } catch (err) {
    const message = String(err);
    console.error(`[ORDER FAILED] ${message}`);
    warn(`placeBuyOrder failed: ${message}`, { ticker, side, limitCents });
    return { ok: false, reason: "order_failed", message };
  }
}

async function placeSellOrder(
  pos: MomentumPosition,
  currentBidCents: number,
  midAtTrigger = currentBidCents,
  currentAskCents = currentBidCents + 2,
): Promise<boolean> {
  // Cancel any resting sell order before placing a new one
  if (pos.pendingSellOrderId) {
    await kalshiFetch("DELETE", `/portfolio/orders/${pos.pendingSellOrderId}`)
      .catch(e => console.warn(`[SELL] cancel resting order ${pos.pendingSellOrderId} failed: ${e}`));
    pos.pendingSellOrderId = undefined;
    await new Promise(r => setTimeout(r, 300));
  }

  const retries = pos.sellRetries ?? 0;

  // FIX #5: After max retries (5), fire one final aggressive market-crossing sell
  // then force-remove the position. No position ever stays open indefinitely.
  // FIX #8 (logging): Full dbLog entry so Railway shows every give-up clearly.
  if (retries > 5) {
    const aggressiveBid = Math.max(1, currentBidCents - 3); // cross the spread hard
    const giveUpMsg = `[SELL GIVE-UP] ${pos.marketId} ${pos.side} — ${retries} retries exhausted. Firing final aggressive sell @${aggressiveBid}¢ then force-removing.`;
    console.error(giveUpMsg);
    dbLog("error", `[MOMENTUM] ${giveUpMsg}`);

    // Fire a final aggressive sell — best-effort, don't await result
    const finalPayload = {
      ticker: pos.marketId,
      client_order_id: `momentum-sell-final-${Math.abs(pos.tradeId)}-${Date.now()}`,
      type: "limit",
      action: "sell",
      side: pos.side.toLowerCase(),
      count: pos.contractCount,
      yes_price: pos.side === "YES" ? aggressiveBid : undefined,
      no_price:  pos.side === "NO"  ? Math.max(1, (100 - currentAskCents) - 3) : undefined,
    };
    kalshiFetch("POST", "/portfolio/orders", finalPayload)
      .then(r => console.log(`[SELL GIVE-UP] Final sell response: ${JSON.stringify(r)}`))
      .catch(e => console.error(`[SELL GIVE-UP] Final sell also failed: ${e}`));

    // FIX #5 cont: Record an estimated loss so W/L counter stays honest
    const estimatedExitPrice = pos.side === "YES" ? aggressiveBid : 100 - aggressiveBid;
    const gross  = estimatedExitPrice - pos.entryPriceCents;
    const fee    = Math.floor(FEE_RATE * Math.max(0, gross));
    const netPnl = gross - fee;
    recordTradeResult(pos.entryPriceCents, estimatedExitPrice, netPnl);
    dbLog("error", `[MOMENTUM] GIVE-UP LOSS recorded: ${coinLabel(pos.marketId)} ${pos.side} entry:${pos.entryPriceCents}¢ estimatedExit:${estimatedExitPrice}¢ pnl:${netPnl}¢`);

    // Force-remove from openPositions
    const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
    if (idx >= 0) openPositions.splice(idx, 1);
    state.openTradeCount = openPositions.length;
    marketCooldowns.set(coinLabel(pos.marketId), Date.now() + COOLDOWN_MS);
    if (!pos.resultRecorded) {
      pos.resultRecorded = true;
      recordTradeResult(pos.entryPriceCents, exitPriceForPnl, netPnl);
    }

    // Update DB row
    if (pos.tradeId > 0) {
      db.update(tradesTable).set({ status: "closed", pnlCents: netPnl, closedAt: new Date() })
        .where(eq(tradesTable.id, pos.tradeId))
        .catch(err => warn(`[GIVE-UP] DB update failed: ${String(err)}`));
    }
    return true; // position is gone from our state
  }

  // Escalate aggressiveness: bid-2 → bid-1 → bid → at-bid
  const slack = retries === 0 ? 2 : retries === 1 ? 1 : 0;
  const limitCents = pos.side === "YES"
    ? Math.max(1, currentBidCents - slack)
    : Math.max(1, (100 - currentAskCents) - slack);

  if (retries > 0) {
    console.warn(`[SELL-RETRY #${retries}] ${pos.marketId} ${pos.side} — using limit ${limitCents}¢ (slack=${slack})`);
    dbLog("warn", `[MOMENTUM] SELL RETRY #${retries}: ${pos.marketId} ${pos.side} limit:${limitCents}¢`, `sell-retry-${pos.tradeId}`);
  }

  const clientOrderId = `momentum-sell-${Math.abs(pos.tradeId)}-${Date.now()}`;
  const payload = {
    ticker: pos.marketId,
    client_order_id: clientOrderId,
    type: "limit",
    action: "sell",
    side: pos.side.toLowerCase(),
    count: pos.contractCount,
    yes_price: pos.side === "YES" ? limitCents : undefined,
    no_price:  pos.side === "NO"  ? limitCents : undefined,
  };

  try {
    const resp = await kalshiFetch("POST", "/portfolio/orders", payload) as any;
    const fillCount: number = resp?.order?.count ?? resp?.order?.filled_count ?? 0;
    const sellOrderId: string | undefined = resp?.order?.order_id;

    // FIX #9 (logging): Log every sell attempt result clearly
    console.log(`[SELL ATTEMPT] ${pos.marketId} ${pos.side} limit:${limitCents}¢ → fillCount:${fillCount} orderId:${sellOrderId}`);

    if (fillCount === 0) {
      pos.pendingSellOrderId = sellOrderId;
      pos.sellRetries = retries + 1;
      console.warn(`[SELL UNFILLED] ${pos.marketId} ${pos.side} limit ${limitCents}¢ resting — retry #${pos.sellRetries}`);
      dbLog("warn", `[MOMENTUM] SELL UNFILLED: ${pos.marketId} limit ${limitCents}¢ — retry #${pos.sellRetries}`);
      return false;
    }

    // FIX #4: Warn if partial fill (fillCount !== contractCount)
    if (fillCount !== pos.contractCount) {
      console.warn(`[SELL PARTIAL] ${pos.marketId} — expected ${pos.contractCount} contracts, filled ${fillCount}. Treating as full close but ${pos.contractCount - fillCount} contracts may remain on Kalshi.`);
      dbLog("warn", `[MOMENTUM] PARTIAL FILL WARNING: ${pos.marketId} expected:${pos.contractCount} filled:${fillCount}`);
    }

    const exitPriceForPnl = pos.side === "YES" ? midAtTrigger : 100 - midAtTrigger;
    const gross  = exitPriceForPnl - pos.entryPriceCents;
    const fee    = Math.floor(FEE_RATE * Math.max(0, gross));
    const netPnl = gross - fee;

    // FIX #6: Remove from openPositions (single source of truth) immediately
    const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
    if (idx >= 0) openPositions.splice(idx, 1);
    state.openTradeCount = openPositions.length;

    marketCooldowns.set(coinLabel(pos.marketId), Date.now() + COOLDOWN_MS);
    recordTradeResult(pos.entryPriceCents, exitPriceForPnl, netPnl);

    const cooldownMs = netPnl < 0 ? POST_LOSS_COOLDOWN_MS : POST_WIN_COOLDOWN_MS;
    globalCooldownUntilMs = Date.now() + cooldownMs;
    console.log(`[COOLDOWN] ${netPnl < 0 ? "LOSS" : "WIN"} — global cooldown: ${cooldownMs / 1000}s`);

    const liveGain = exitPriceForPnl - pos.entryPriceCents;
    const liveReason: "TP" | "SL" | "STALE" = liveGain >= state.tpCents ? "TP" : liveGain <= -state.slCents ? "SL" : "STALE";
    recordTradeForHealth(netPnl, liveReason, pos.entrySlippageCents ?? 0);
    recordLiveTradeExecution({
      timestamp: Date.now(), market: pos.marketId, side: pos.side, exitReason: liveReason,
      entryPriceCents: pos.entryPriceCents, entrySlippage: pos.entrySlippageCents ?? 0,
      midAtTrigger, expectedExitCents: currentBidCents, actualFillCents: exitPriceForPnl,
      exitSlippage: exitPriceForPnl - currentBidCents, pnlCents: netPnl,
    });

    // FIX #9 (logging): Explicit position removal log
    console.log(`[POSITION REMOVED] ${pos.marketId} ${pos.side} tradeId:${pos.tradeId} — openPositions now:${openPositions.length}`);
    dbLog("info", `[MOMENTUM] ✅ SELL FILLED: ${coinLabel(pos.marketId)} ${pos.side} pnl:${netPnl >= 0 ? "+" : ""}${netPnl}¢ | openPositions:${openPositions.length}`);

    const sellFields = { status: "closed" as const, sellPriceCents: exitPriceForPnl, pnlCents: netPnl, feeCents: fee, closedAt: new Date() };
    if (pos.tradeId > 0) {
      db.update(tradesTable).set(sellFields).where(eq(tradesTable.id, pos.tradeId))
        .catch(err => warn(`DB sell update failed for id=${pos.tradeId}: ${String(err)}`));
    } else if (pos.buyOrderId) {
      setTimeout(() => {
        db.update(tradesTable).set(sellFields)
          .where(eq(tradesTable.kalshiBuyOrderId, pos.buyOrderId!))
          .catch(err => warn(`DB sell update (by buyOrderId) failed: ${String(err)}`));
      }, 6_000);
    }
    return true;
  } catch (err) {
    warn(`placeSellOrder API error: ${String(err)}`, { tradeId: pos.tradeId, market: pos.marketId });
    pos.sellRetries = (pos.sellRetries ?? 0) + 1;
    return false;
  }
}

// ─── Execute Momentum Trade ─────────────────────────────────────────────────
export async function executeMomentumTrade(
  ticker: string,
  title: string,
  side: "YES" | "NO",
  bidCents: number,
  askCents: number,
  closeTs: number = 0,
  betCents?: number,
): Promise<{ status: "trade_opened" | "order_skipped" | "order_unfilled_cancelled"; reason: string }> {
  // FIX #6: Final guard — recheck openPositions.length (the single source of truth)
  // right before placing the order, even though scanMomentumMarkets already checked.
  // This catches any race between the scan check and this execution.
  if (openPositions.length >= MAX_POSITIONS) {
    return { status: "order_skipped", reason: `position already open (openPositions.length=${openPositions.length}) — skipping to prevent stack` };
  }

  const limitCents = Math.min(askCents, bidCents + 1);
  const budget = betCents ?? state.betCostCents;
  const result = await placeBuyOrder(ticker, side, limitCents, budget);
  if (!result.ok) {
    return { status: "order_skipped", reason: `${result.reason}: ${result.message}` };
  }
  if (result.contractCount === 0) {
    console.warn(`[ORDER UNFILLED] ${coinLabel(ticker)} ${side} — resting order, cancelling`);
    dbLog("warn", `[MOMENTUM] ORDER UNFILLED: ${coinLabel(ticker)} ${side} — cancelled`);
    kalshiFetch("DELETE", `/portfolio/orders/${result.orderId}`).catch(() => {});
    return { status: "order_unfilled_cancelled", reason: `order ${result.orderId} returned contractCount=0` };
  }

  let tradeId = -(Date.now());
  db.insert(tradesTable).values({
    marketId: ticker, marketTitle: title, side,
    buyPriceCents: result.fillPrice, contractCount: result.contractCount,
    feeCents: 0, pnlCents: null, status: "open",
    minutesRemaining: null, kalshiBuyOrderId: result.orderId,
  }).returning({ id: tradesTable.id }).then(rows => {
    if (rows[0]) {
      const realId = rows[0].id;
      const pos = openPositions.find(p => p.tradeId === tradeId);
      if (pos) pos.tradeId = realId;
      tradeId = realId;
    }
  }).catch(err => warn(`DB insert failed: ${String(err)}`));

  const entryYesEquiv = side === "YES" ? result.fillPrice : 100 - result.fillPrice;
  const expectedEntryPrice = side === "NO" ? (100 - limitCents) : limitCents;

  const pos: MomentumPosition = {
    tradeId,
    marketId: ticker,
    marketTitle: title,
    side,
    entryPriceCents:   result.fillPrice,
    entrySlippageCents: Math.abs(result.fillPrice - expectedEntryPrice),
    contractCount: result.contractCount,
    enteredAt: Date.now(),
    lastSeenPriceCents: entryYesEquiv,
    lastMovedAt: Date.now(),
    buyOrderId: result.orderId,
    closeTs,
  };

  openPositions.push(pos);
  state.openTradeCount = openPositions.length;
  state.status = "IN_TRADE";

  // FIX #9 (logging): Clear entry log with position count
  console.log(`[POSITION OPENED] ${coinLabel(ticker)} ${side} @${result.fillPrice}¢ tradeId:${tradeId} | openPositions:${openPositions.length}`);
  log(`🟢 BUY ${side} — ${coinLabel(ticker)} @${result.fillPrice}¢ | tradeId:${tradeId}`, { ticker, side, fillPrice: result.fillPrice, tradeId });
  dbLog("info", `[MOMENTUM] 🟢 TRADE OPENED: BUY ${side} ${coinLabel(ticker)} @${result.fillPrice}¢ | tradeId:${tradeId} | openPositions:${openPositions.length}`);

  return { status: "trade_opened", reason: `trade opened with ${result.contractCount} contract(s) at ${result.fillPrice}¢` };
}

// ─── Simulator (Paper Trading) ───────────────────────────────────────────────
function enterSimPosition(ticker: string, title: string, side: "YES" | "NO", bidCents: number, askCents: number, closeTs: number = 0, betCents?: number): void {
  if (simPositions.length >= MAX_POSITIONS) return; // FIX #1: apply same limit to sim
  const limitCents    = Math.min(askCents, bidCents + 1);
  const budget        = betCents ?? state.betCostCents;
  const contractCount = budget / Math.max(limitCents, MIN_PRICE_FOR_CONTRACTS);
  const tradeId       = -(Date.now());
  const pos: MomentumPosition = {
    tradeId, marketId: ticker, marketTitle: title, side,
    entryPriceCents: limitCents, contractCount,
    enteredAt: Date.now(), lastSeenPriceCents: limitCents,
    lastMovedAt: Date.now(), buyOrderId: null, closeTs,
  };
  simPositions.push(pos);
  state.simOpenTradeCount = simPositions.length;
  state.status = "IN_TRADE";
  log(`🎮 [SIM] ENTER ${side} ${coinLabel(ticker)} @${limitCents}¢ | contracts:${contractCount.toFixed(3)}`);
  dbLog("info", `[SIM] ENTER ${side} ${coinLabel(ticker)} @${limitCents}¢`);
}

function closeSimPosition(pos: MomentumPosition, exitPriceCents: number, reason: string): void {
  const rawGain  = pos.side === "YES" ? exitPriceCents - pos.entryPriceCents : pos.entryPriceCents - exitPriceCents;
  const pnlCents = Math.round(rawGain * pos.contractCount);
  const idx = simPositions.findIndex(p => p.tradeId === pos.tradeId);
  if (idx >= 0) simPositions.splice(idx, 1);
  state.simPnlCents      += pnlCents;
  state.simOpenTradeCount = simPositions.length;
  if (pnlCents > 0) state.simWins++; else state.simLosses++;
  recordTradeForHealth(pnlCents, parseExitReason(reason), 0);
  marketCooldowns.set(coinLabel(pos.marketId), Date.now() + COOLDOWN_MS);
  const pnlSign = pnlCents >= 0 ? "+" : "";
  log(`🎮 [SIM] CLOSE ${pos.side} ${coinLabel(pos.marketId)} | entry:${pos.entryPriceCents}¢ exit:${exitPriceCents}¢ pnl:${pnlSign}${pnlCents}¢ | ${reason}`);
  dbLog("info", `[SIM] CLOSE ${pos.side} ${coinLabel(pos.marketId)} pnl:${pnlSign}${pnlCents}¢ W:${state.simWins} L:${state.simLosses}`);
  saveMomentumConfig();
  db.insert(paperTradesTable).values({
    botType: "momentum", marketId: pos.marketId, coin: coinLabel(pos.marketId),
    side: pos.side, entryPrice: pos.entryPriceCents, exitPrice: exitPriceCents,
    pnlCents, exitReason: reason.split(" ")[0] ?? reason,
    enteredAt: new Date(pos.enteredAt), closedAt: new Date(),
  }).catch(err => console.error("[momentumBot] paperTrade insert failed:", String(err)));
}

// ─── Persistent Paper Trade Stats ─────────────────────────────────────────────
export interface TimeOfDayBucket { label: string; wins: number; losses: number; pnlCents: number; }
export interface PaperTradeRecord { id: number; coin: string; side: string; entryPrice: number; exitPrice: number; pnlCents: number; exitReason: string; closedAt: string; }
export interface PaperStats { totalTrades: number; wins: number; losses: number; winRatePct: number; totalPnlCents: number; evPerTradeCents: number; maxDrawdownCents: number; timeOfDay: TimeOfDayBucket[]; recentTrades: PaperTradeRecord[]; }

export async function getPaperStats(): Promise<PaperStats> {
  const rows = await db.select().from(paperTradesTable).where(eq(paperTradesTable.botType, "momentum")).orderBy(asc(paperTradesTable.closedAt));
  const totalTrades = rows.length;
  const wins    = rows.filter(r => r.pnlCents > 0).length;
  const losses  = rows.filter(r => r.pnlCents <= 0).length;
  const totalPnlCents = rows.reduce((s, r) => s + r.pnlCents, 0);
  const winRatePct = totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : 0;
  const evPerTradeCents = totalTrades > 0 ? Math.round(totalPnlCents / totalTrades) : 0;
  let peak = 0, runPnl = 0, maxDrawdownCents = 0;
  for (const r of rows) {
    runPnl += r.pnlCents;
    if (runPnl > peak) peak = runPnl;
    const drawdown = peak - runPnl;
    if (drawdown > maxDrawdownCents) maxDrawdownCents = drawdown;
  }
  const buckets: Record<string, TimeOfDayBucket> = {};
  const bucketDefs: [string, number, number][] = [["00-06",0,5],["06-12",6,11],["12-18",12,17],["18-24",18,23]];
  for (const [label] of bucketDefs) buckets[label] = { label, wins: 0, losses: 0, pnlCents: 0 };
  for (const r of rows) {
    const hour = new Date(r.closedAt).getUTCHours();
    const def = bucketDefs.find(([,lo,hi]) => hour >= lo && hour <= hi);
    if (!def) continue;
    const b = buckets[def[0]]!;
    b.pnlCents += r.pnlCents;
    if (r.pnlCents > 0) b.wins++; else b.losses++;
  }
  const recentTrades: PaperTradeRecord[] = rows.slice(-20).reverse().map(r => ({
    id: r.id, coin: r.coin, side: r.side, entryPrice: r.entryPrice, exitPrice: r.exitPrice,
    pnlCents: r.pnlCents, exitReason: r.exitReason,
    closedAt: r.closedAt instanceof Date ? r.closedAt.toISOString() : String(r.closedAt),
  }));
  return { totalTrades, wins, losses, winRatePct, totalPnlCents, evPerTradeCents, maxDrawdownCents, timeOfDay: Object.values(buckets), recentTrades };
}

async function monitorSimPositions(): Promise<void> {
  if (simPositions.length === 0) return;
  const now = Date.now();
  const toClose: { pos: MomentumPosition; exitPrice: number; reason: string }[] = [];
  for (const pos of [...simPositions]) {
    let currentBid = pos.lastSeenPriceCents, currentAsk = pos.lastSeenPriceCents, currentMid = pos.lastSeenPriceCents;
    try {
      const ob = await fetchMarketOrderBook(pos.marketId);
      if (ob) { currentBid = ob.bid; currentAsk = ob.ask; currentMid = ob.mid; }
    } catch { /* keep last known */ }
    const executableExitPrice = pos.side === "YES" ? (currentBid > 0 ? currentBid : currentMid) : (currentAsk > 0 ? currentAsk : currentMid);
    const gain = pos.side === "YES" ? executableExitPrice - pos.entryPriceCents : pos.entryPriceCents - executableExitPrice;
    if (Math.abs(currentMid - pos.lastSeenPriceCents) >= 1) pos.lastMovedAt = now;
    pos.lastSeenPriceCents = currentMid;
    const realisticExitPrice = pos.side === "YES" ? (currentBid > 0 ? currentBid : currentMid) : (currentAsk > 0 ? currentAsk : currentMid);
    const simMinsLeft = pos.closeTs > 0 ? (pos.closeTs - now) / 60_000 : 999;
    if      (simMinsLeft < 2)                        toClose.push({ pos, exitPrice: realisticExitPrice, reason: `EXPIRY ${simMinsLeft.toFixed(1)}min` });
    else if (gain >= state.tpCents)                  toClose.push({ pos, exitPrice: realisticExitPrice, reason: `TP +${gain}¢` });
    else if (gain <= -state.slCents)                 toClose.push({ pos, exitPrice: realisticExitPrice, reason: `SL ${gain}¢` });
    else if (now - pos.lastMovedAt >= state.staleMs) toClose.push({ pos, exitPrice: realisticExitPrice, reason: `STALE ${Math.round((now - pos.lastMovedAt) / 1000)}s` });
  }
  for (const { pos, exitPrice, reason } of toClose) closeSimPosition(pos, exitPrice, reason);
  state.simOpenTradeCount = simPositions.length;
}

// ─── Sell Monitor ───────────────────────────────────────────────────────────
async function runSellMonitor(): Promise<void> {
  if (openPositions.length === 0) return;

  // Purge 0-contract ghost positions
  for (const pos of [...openPositions]) {
    if (pos.contractCount === 0) {
      const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
      if (idx >= 0) openPositions.splice(idx, 1);
      state.openTradeCount = openPositions.length;
      console.warn(`[GHOST PURGE] Removed 0-contract ghost: ${pos.marketId} ${pos.side} tradeId:${pos.tradeId}`);
      dbLog("warn", `[MOMENTUM] GHOST PURGE: ${pos.marketId} (${pos.side}) — no loss recorded`);
    }
  }
  if (openPositions.length === 0) return;

  for (const pos of [...openPositions]) {
    const now = Date.now();
    const holdMins = (now - pos.enteredAt) / 60_000;

    // Hard max-hold backstop — 10 min
    if (holdMins >= 10) {
      console.warn(`[MAX-HOLD] ${coinLabel(pos.marketId)} ${pos.side} open ${holdMins.toFixed(1)}min — force-exiting`);
      dbLog("warn", `[MOMENTUM] MAX-HOLD EXIT: ${coinLabel(pos.marketId)} open ${holdMins.toFixed(1)}min`);
      const fallbackBid = pos.lastSeenPriceCents > 0
        ? (pos.side === "YES" ? pos.lastSeenPriceCents : 100 - pos.lastSeenPriceCents) : 1;
      await placeSellOrder(pos, fallbackBid, pos.lastSeenPriceCents || fallbackBid);
      continue;
    }

    let currentBid = 0, currentAsk = 0;
    try {
      const ob = await fetchMarketOrderBook(pos.marketId);
      if (ob) { currentBid = ob.bid; currentAsk = ob.ask; }
    } catch { /* fall through to fallback */ }

    if (currentBid <= 0 && currentAsk <= 0) {
      if (pos.closeTs > 0) {
        const minsLeft = (pos.closeTs - now) / 60_000;
        if (minsLeft < 5) {
          const exitPx = Math.max(1, pos.lastSeenPriceCents);
          console.warn(`[EMERGENCY EXIT] ${coinLabel(pos.marketId)} ${minsLeft.toFixed(1)}min left, no liquidity — force-exiting @${exitPx}¢`);
          await placeSellOrder(pos, exitPx, exitPx);
          continue;
        }
      }
      if (pos.lastSeenPriceCents > 0) {
        const fallbackMid = pos.lastSeenPriceCents;
        const fallbackBid = Math.max(1, fallbackMid - 1);
        const gain = pos.side === "YES" ? fallbackMid - pos.entryPriceCents : (100 - pos.entryPriceCents) - fallbackMid;
        if (gain <= -state.slCents) {
          console.warn(`[SL via fallback] ${coinLabel(pos.marketId)} gain:${gain}¢ — force-closing`);
          await placeSellOrder(pos, fallbackBid, fallbackMid);
        }
      }
      continue;
    }

    const currentMid = currentAsk > 0 ? Math.round((currentBid + currentAsk) / 2) : currentBid;
    const executableGain = (() => {
      if (pos.side === "YES") { const yesExit = currentBid > 0 ? currentBid : currentMid; return yesExit - pos.entryPriceCents; }
      const noExit = currentAsk > 0 ? Math.max(1, 100 - currentAsk) : Math.max(1, 100 - currentMid);
      return noExit - pos.entryPriceCents;
    })();

    if (Math.abs(currentMid - pos.lastSeenPriceCents) >= 1) pos.lastMovedAt = now;
    pos.lastSeenPriceCents = currentMid;

    if (pos.closeTs > 0) {
      const minsLeft = (pos.closeTs - now) / 60_000;
      if (minsLeft < 2) {
        log(`⚠️ EXPIRY EXIT — ${minsLeft.toFixed(1)}min left on Trade ${pos.tradeId}`);
        await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid, currentAsk > 0 ? currentAsk : currentMid + 2);
        continue;
      }
    }

    if (state.tpAbsoluteCents > 0) {
      const absHit = pos.side === "YES" ? currentMid >= state.tpAbsoluteCents : currentMid <= (100 - state.tpAbsoluteCents);
      if (absHit) {
        log(`💰 ABS-TP hit — price ${currentMid}¢ on Trade ${pos.tradeId}`);
        await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid, currentAsk > 0 ? currentAsk : currentMid + 2);
        continue;
      }
    }

    if (executableGain >= state.tpCents) {
      log(`💰 TP hit — gain ${executableGain}¢ on Trade ${pos.tradeId}`);
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid, currentAsk > 0 ? currentAsk : currentMid + 2);
      continue;
    }

    if (executableGain <= -state.slCents) {
      log(`🛑 SL hit — loss ${executableGain}¢ on Trade ${pos.tradeId}`);
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid, currentAsk > 0 ? currentAsk : currentMid + 2);
      continue;
    }

    if (now - pos.lastMovedAt >= state.staleMs) {
      log(`⏳ STALE EXIT — flat for ${Math.round((now - pos.lastMovedAt) / 1000)}s on Trade ${pos.tradeId}`);
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid, currentAsk > 0 ? currentAsk : currentMid + 2);
      continue;
    }
  }

  state.openTradeCount = openPositions.length;
  if (openPositions.length === 0 && state.status === "IN_TRADE") {
    state.status = state.enabled ? "WAITING_FOR_SETUP" : "DISABLED";
  }
}

// ─── Market Scanner ─────────────────────────────────────────────────────────
let scanInProgress = false;

export async function scanMomentumMarkets(): Promise<void> {
  if (!state.enabled) return;
  if (scanInProgress) {
    console.log("[SCAN] Previous scan still running — skipping tick");
    return;
  }
  scanInProgress = true;

  try {
    if (Date.now() < startupHoldUntilMs) {
      const secsLeft = Math.ceil((startupHoldUntilMs - Date.now()) / 1000);
      console.log(`[SCAN] Startup hold — ${secsLeft}s remaining`);
      return;
    }

    if (!state.simulatorMode && !recoveryReady) {
      console.log("[SCAN] Recovery latch active — waiting for DB recovery before live entries");
      return;
    }

    if (checkRiskPause()) { state.status = "PAUSED"; return; }

    // FIX #6 + #10: Capture simulatorMode once so it can't flip mid-scan.
    // Always use openPositions.length directly as the entry gate — never state.openTradeCount.
    const isSimMode = state.simulatorMode;
    const activePositions = isSimMode ? simPositions : openPositions;

    if (activePositions.length >= MAX_POSITIONS) {
      state.status = "IN_TRADE";
      return;
    }

    state.status = activePositions.length > 0 ? "IN_TRADE" : "WAITING_FOR_SETUP";

    if (Date.now() < globalCooldownUntilMs) {
      const secsLeft = Math.ceil((globalCooldownUntilMs - Date.now()) / 1000);
      console.log(`[SCAN] Global cooldown — ${secsLeft}s remaining`);
      return;
    }

    const markets = await fetchActiveMarkets();
    if (markets.length === 0) {
      log(`[SCAN] No markets available`);
      dbLog("warn", `[MOMENTUM] No markets`, "no-markets");
      return;
    }

    log(`[SCAN] ${markets.length} markets: ${markets.map(m => `${coinLabel(m.ticker)} ${m.minutesRemaining.toFixed(1)}min ask:${m.askCents}¢`).join(", ")}`);

    type Candidate = { market: typeof markets[0]; ob: { bid: number; ask: number; spread: number; mid: number }; decision: MomentumDecision; side: "YES" | "NO"; score: number; };
    const candidates: Candidate[] = [];
    const plannedCoins = new Set(activePositions.map(p => coinLabel(p.marketId)));
    let inRangeCount = 0;

    for (const market of markets) {
      if (activePositions.some(p => p.marketId === market.ticker)) continue;
      const cooldown = marketCooldowns.get(coinLabel(market.ticker));
      if (cooldown && Date.now() < cooldown) {
        console.log(`[SCAN] ${coinLabel(market.ticker)} — cooldown active (${Math.ceil((cooldown - Date.now()) / 1000)}s left)`);
        continue;
      }
      const marketCoin = coinLabel(market.ticker);
      if (!state.allowedCoins.includes(marketCoin)) continue;

      const minRequired = isSimMode ? MIN_MINUTES_REMAINING_SIM : MIN_MINUTES_REMAINING;
      if (market.closeTs <= 0) continue;
      const actualMinutesLeft = (market.closeTs - Date.now()) / 60_000;
      if (actualMinutesLeft < minRequired) continue;

      const ob = await fetchMarketOrderBook(market.ticker, market.askCents, market.bidCents);
      if (!ob) continue;
      const { bid, ask, spread, mid } = ob;
      if (ask <= 0 || bid <= 0) continue;

      const pMin = state.priceMin, pMax = state.priceMax;
      if (mid < pMin - ENTRY_BUFFER_CENTS || mid > pMax + ENTRY_BUFFER_CENTS) continue;
      const scanSpreadLimit = isSimMode ? SPREAD_MAX_SIM : SPREAD_MAX;
      if (spread > scanSpreadLimit) continue;
      if (mid >= pMin && mid <= pMax) inRangeCount++;

      const decision = evaluateMomentum(market.ticker, mid);
      log(`[MOMENTUM CHECK] ${coinLabel(market.ticker)} | price:${mid}¢ spread:${spread}¢ | ${decision.action} — ${decision.reason}`);
      if (decision.action === "SKIP") continue;

      const tradeSpreadLimit = isSimMode ? TRADE_SPREAD_MAX_SIM : TRADE_SPREAD_MAX;
      if (spread > tradeSpreadLimit) continue;
      if (decision.action === "BUY_YES" && (mid < pMin || mid > pMax)) continue;
      if (decision.action === "BUY_NO"  && (mid > pMax || mid < pMin)) continue;

      const side = decision.action === "BUY_YES" ? "YES" : "NO";
      if (plannedCoins.has(marketCoin)) continue;

      const momentumScore  = Math.min(decision.centsPerSec * 25, 60);
      const signalBonus    = decision.moveCents >= 4 ? 15 : decision.moveCents >= 3 ? 10 : 5;
      const spreadScore    = (SPREAD_MAX - spread) * 3;
      const timeScore      = Math.min(market.minutesRemaining, 10);
      const score = momentumScore + signalBonus + spreadScore + timeScore;

      log(`[SIGNAL] 🎯 ${coinLabel(market.ticker)} ${decision.action} | price:${mid}¢ score:${score.toFixed(0)}`);
      dbLog("info", `[MOMENTUM] 🎯 SIGNAL: ${coinLabel(market.ticker)} ${decision.action} | price:${mid}¢ score:${score.toFixed(0)}`);
      candidates.push({ market, ob, decision, side, score });
      plannedCoins.add(marketCoin);
    }

    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length > 0) {
      state.lastDecision = `${coinLabel(candidates[0].market.ticker)}: ${candidates[0].decision.action} — score:${candidates[0].score.toFixed(0)}`;
      state.lastDecisionAt = new Date().toISOString();
    }

    let reservedBetCents = 0;
    for (const candidate of candidates) {
      // FIX #6: Check activePositions.length again inside execute loop —
      // with MAX_POSITIONS=1 this is now just a belt-and-suspenders check
      if (activePositions.length >= MAX_POSITIONS) break;
      if (!state.enabled) { console.log(`[EXECUTE ABORTED] Bot disabled`); return; }

      const { market, ob, side, decision } = candidate;
      const marketCoin = coinLabel(market.ticker);
      if (activePositions.some(p => coinLabel(p.marketId) === marketCoin)) continue;

      const signalMult = decision.centsPerSec >= 0.20 ? 1.0 : 0.70;
      const health     = state.healthScore?.label;
      const healthMult = health === "Fragile" ? 0.70 : 1.0;
      let effectiveBet = Math.round(state.betCostCents * signalMult * healthMult);
      effectiveBet = Math.min(Math.max(1, effectiveBet), state.betCostCents);

      if (health === "Broken" && !isSimMode) {
        console.log(`[HEALTH GATE] Skipping live trade — bot health is Broken`);
        continue;
      }

      if (isSimMode) {
        enterSimPosition(market.ticker, market.title, side, ob.bid, ob.ask, market.closeTs, effectiveBet);
      } else {
        {
          const effectiveFloor = Math.max(state.balanceFloorCents, effectiveBet);
          let balanceOk = false;
          try {
            await refreshBalance();
            const rawBalance = getBotState().balanceCents;
            const balance = rawBalance - reservedBetCents;
            const maxBetFromBalance = Math.max(1, Math.floor(balance * 0.33));
            if (effectiveBet > maxBetFromBalance) {
              console.warn(`[BET CAP] ${coinLabel(market.ticker)} — effectiveBet ${effectiveBet}¢ → ${maxBetFromBalance}¢ (33% cap)`);
              effectiveBet = maxBetFromBalance;
            }
            const cappedFloor = Math.max(state.balanceFloorCents, effectiveBet);
            console.log(`[BALANCE CHECK] available:${balance}¢ floor:${cappedFloor}¢ bet:${effectiveBet}¢`);
            if (balance > 0 && balance >= cappedFloor) {
              balanceOk = true;
            } else if (balance > 0 && balance < cappedFloor) {
              stopMomentumBot(`Balance too low: ${balance}¢ < ${cappedFloor}¢`);
              return;
            }
          } catch (err) {
            console.error(`[BALANCE CHECK] Failed — skipping: ${String(err)}`);
          }
          if (!balanceOk) continue;
        }

        console.log(`[EXECUTE ATTEMPT] ${coinLabel(market.ticker)} ${side} | price:${ob.mid}¢ score:${candidate.score.toFixed(0)} | openPositions:${openPositions.length}`);
        const executeResult = await executeMomentumTrade(
          market.ticker, market.title, side, ob.bid, ob.ask, market.closeTs, effectiveBet,
        );
        console.log(`[EXECUTE RESULT] ${marketCoin} ${side} -> ${executeResult.status} (${executeResult.reason})`);
        if (executeResult.status === "trade_opened") reservedBetCents += effectiveBet;
      }
    }

    if (inRangeCount === 0) { _marketCache = null; }
    state.openTradeCount    = openPositions.length;
    state.simOpenTradeCount = simPositions.length;
    if (activePositions.length > 0) state.status = "IN_TRADE";

  } finally {
    scanInProgress = false;
  }
}

// ─── Config Persistence ─────────────────────────────────────────────────────
export function saveMomentumConfig(): void {
  const row = {
    id: 1, enabled: state.enabled,
    balanceFloorCents: state.balanceFloorCents, maxSessionLossCents: state.maxSessionLossCents,
    consecutiveLossLimit: state.consecutiveLossLimit, betCostCents: state.betCostCents,
    simulatorMode: state.simulatorMode, priceMin: state.priceMin, priceMax: state.priceMax,
    simWins: state.simWins, simLosses: state.simLosses, simPnlCents: state.simPnlCents,
    totalWins: state.totalWins, totalLosses: state.totalLosses, totalPnlCents: state.totalPnlCents,
    sessionWins: state.sessionWins, sessionLosses: state.sessionLosses,
    startingBalanceCents: state.startingBalanceCents,
    tpCents: state.tpCents, slCents: state.slCents, staleMs: state.staleMs,
    tpAbsoluteCents: state.tpAbsoluteCents, sessionProfitTargetCents: state.sessionProfitTargetCents,
    allowedCoins: state.allowedCoins.join(","),
  };
  db.insert(momentumSettingsTable).values(row)
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set: row })
    .catch(err => console.error("[momentumBot] saveMomentumConfig failed:", String(err)));
}

function saveEnabledFlag(enabled: boolean): void {
  db.insert(momentumSettingsTable).values({ id: 1, enabled })
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set: { enabled } })
    .catch(err => console.error("[momentumBot] saveEnabledFlag failed:", String(err)));
}

async function saveConfigFieldsOnly(): Promise<void> {
  const set = {
    balanceFloorCents: state.balanceFloorCents, maxSessionLossCents: state.maxSessionLossCents,
    consecutiveLossLimit: state.consecutiveLossLimit, betCostCents: state.betCostCents,
    simulatorMode: state.simulatorMode, priceMin: state.priceMin, priceMax: state.priceMax,
    tpCents: state.tpCents, slCents: state.slCents, staleMs: state.staleMs,
    tpAbsoluteCents: state.tpAbsoluteCents, sessionProfitTargetCents: state.sessionProfitTargetCents,
    allowedCoins: state.allowedCoins.join(","),
  };
  await db.insert(momentumSettingsTable).values({ id: 1, ...set })
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set });
}

export async function loadMomentumConfig(autoStartFallback = false): Promise<void> {
  const MAX_ATTEMPTS = 10;
  const DELAYS_MS    = [2000, 3000, 5000, 5000, 8000, 8000, 10000, 10000, 15000, 15000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const rows = await db.select().from(momentumSettingsTable).where(eq(momentumSettingsTable.id, 1)).limit(1);
      if (rows.length === 0) {
        if (autoStartFallback) { state.simulatorMode = true; startMomentumBot(); }
        return;
      }
      const r = rows[0];
      state.balanceFloorCents    = r.balanceFloorCents;
      state.maxSessionLossCents  = r.maxSessionLossCents;
      state.consecutiveLossLimit = r.consecutiveLossLimit;
      const rawBetCostCents = r.betCostCents ?? 100;
      state.betCostCents = rawBetCostCents > 2000 ? 100 : rawBetCostCents;
      state.simulatorMode        = r.simulatorMode ?? true;
      state.priceMin             = r.priceMin ?? 20;
      state.priceMax             = r.priceMax ?? 80;
      state.simWins     = r.simWins    ?? 0;
      state.simLosses   = r.simLosses  ?? 0;
      state.simPnlCents = r.simPnlCents ?? 0;
      state.totalWins     = r.totalWins    ?? 0;
      state.totalLosses   = r.totalLosses  ?? 0;
      state.totalPnlCents = r.totalPnlCents ?? 0;
      state.startingBalanceCents = r.startingBalanceCents ?? null;
      state.tpCents    = r.tpCents    ?? 5;
      state.slCents    = r.slCents    ?? 2;
      state.staleMs    = r.staleMs    ?? 65_000;
      state.tpAbsoluteCents          = r.tpAbsoluteCents          ?? 0;
      state.sessionProfitTargetCents = r.sessionProfitTargetCents ?? 0;
      if (r.allowedCoins && r.allowedCoins.trim().length > 0) {
        state.allowedCoins = r.allowedCoins.split(",").map(c => c.trim()).filter(Boolean);
      }
      if (r.enabled || autoStartFallback) startMomentumBot();
      return;
    } catch (err) {
      const delay = DELAYS_MS[attempt - 1] ?? 15000;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, delay));
      } else {
        if (autoStartFallback) { state.simulatorMode = true; startMomentumBot(); }
      }
    }
  }
}

// ─── Bot Health Score ────────────────────────────────────────────────────────
function parseExitReason(reason: string): "TP" | "SL" | "STALE" {
  const first = reason.split(" ")[0].toUpperCase();
  if (first === "TP") return "TP";
  if (first === "SL") return "SL";
  return "STALE";
}

function recordTradeForHealth(pnlCents: number, exitReason: "TP" | "SL" | "STALE", slippageCents = 0): void {
  healthBuffer.push({ pnlCents, isWin: pnlCents > 0, exitReason, slippageCents, timestamp: Date.now() });
  if (healthBuffer.length > 100) healthBuffer.shift();
  healthTradeCount++;
  if (healthBuffer.length >= 20) {
    const s = calculateHealthScore();
    state.healthScore = {
      total: s.total, label: s.label as "Healthy" | "Fragile" | "Broken",
      tradesInBuffer: healthBuffer.length,
      winRate: s.winRate, netEV: s.netEV, avgWin: s.avgWin, avgLoss: s.avgLoss,
      staleRate: s.staleRate,
      evScore: s.evScore, stabilityScore: s.stabilityScore, ratioScore: s.ratioScore,
      staleScore: s.staleScore, execScore: s.execScore,
    };
  }
  if (healthTradeCount % 20 === 0 && healthBuffer.length >= 20) logHealthScore(calculateHealthScore());
}

function calculateHealthScore(): { total: number; label: string; evScore: number; stabilityScore: number; ratioScore: number; staleScore: number; execScore: number; netEV: number; winRate: number; avgWin: number; avgLoss: number; staleRate: number; avgSlippage: number; } {
  const current = healthBuffer.slice(-50);
  const prev    = healthBuffer.slice(-100, -50);
  const wins   = current.filter(t => t.isWin);
  const losses = current.filter(t => !t.isWin);
  const winRate  = wins.length / current.length;
  const lossRate = losses.length / current.length;
  const avgWin  = wins.length   > 0 ? wins.reduce((s,t) => s + t.pnlCents, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s,t) => s + t.pnlCents, 0) / losses.length) : 0;
  const netEV   = (avgWin * winRate) - (avgLoss * lossRate);
  const evScore = netEV > 0.1 ? 2 : netEV >= -0.1 ? 1 : 0;
  let stabilityScore = 1;
  if (prev.length >= 50) {
    const prevWinRate = prev.filter(t => t.isWin).length / prev.length;
    const change = Math.abs(winRate - prevWinRate) * 100;
    stabilityScore = change <= 5 ? 2 : change <= 10 ? 1 : 0;
  }
  const ratio = avgLoss === 0 ? Infinity : avgWin / avgLoss;
  const ratioScore = ratio >= 1.0 ? 2 : ratio >= 0.75 ? 1 : 0;
  const staleCount = current.filter(t => t.exitReason === "STALE").length;
  const staleRate  = staleCount / current.length;
  const staleScore = staleRate < 0.25 ? 2 : staleRate <= 0.40 ? 1 : 0;
  const avgSlippage = current.reduce((s,t) => s + t.slippageCents, 0) / current.length;
  const execScore   = avgSlippage < 0.5 ? 2 : avgSlippage <= 1.0 ? 1 : 0;
  const total = evScore + stabilityScore + ratioScore + staleScore + execScore;
  const label = total >= 8 ? "Healthy" : total >= 5 ? "Fragile" : "Broken";
  return { total, label, evScore, stabilityScore, ratioScore, staleScore, execScore, netEV, winRate, avgWin, avgLoss, staleRate, avgSlippage };
}

function logHealthScore(s: ReturnType<typeof calculateHealthScore>): void {
  const icon  = s.label === "Healthy" ? "✅" : s.label === "Fragile" ? "⚠️" : "🔴";
  const ratio = s.avgLoss > 0 ? (s.avgWin / s.avgLoss).toFixed(2) : "∞";
  const msg = [``, `🏥 ══════ BOT HEALTH SCORE (trade #${healthTradeCount}, rolling 50) ══════`,
    `${icon}  ${s.label.toUpperCase()}  —  ${s.total}/10`,
    `  [1] Net EV:          ${s.evScore}/2  (EV=${s.netEV.toFixed(3)}¢  WR=${(s.winRate*100).toFixed(1)}%)`,
    `  [2] WR Stability:    ${s.stabilityScore}/2`, `  [3] Win/Loss Ratio:  ${s.ratioScore}/2  (${ratio})`,
    `  [4] Stale Rate:      ${s.staleScore}/2  (${(s.staleRate*100).toFixed(1)}%)`,
    `  [5] Execution:       ${s.execScore}/2  (avg slippage=${s.avgSlippage.toFixed(3)}¢)`, ``].join("\n");
  console.log(msg);
  dbLog("info", msg);
}

// ─── Public API ─────────────────────────────────────────────────────────────
export function getMomentumBotState(): MomentumBotState { return { ...state }; }

export async function debugMomentumMarkets() {
  const now = Date.now();
  const maxCloseTs = Math.floor((now + 20 * 60_000) / 1000);
  let rawCount = 0, rawSample: string[] = [];
  try {
    const resp = await kalshiFetch("GET", `/markets?status=open&limit=100&max_close_ts=${maxCloseTs}`) as { markets?: Array<{ ticker?: string; close_time?: string; yes_ask_dollars?: number; yes_bid_dollars?: number }>; };
    rawCount = resp?.markets?.length ?? 0;
    rawSample = (resp?.markets ?? []).slice(0, 20).map(m => {
      const closeMs = m.close_time ? new Date(m.close_time).getTime() : now;
      return `${m.ticker} (${((closeMs - now) / 60000).toFixed(1)}min, ask:${m.yes_ask_dollars})`;
    });
  } catch (e) { rawSample = [`Error: ${String(e)}`]; }
  const filtered = await fetchActiveMarkets();
  return {
    rawMarketsInWindow: rawCount, rawSample,
    filteredMarkets: filtered.map(m => ({ ticker: m.ticker, minutesRemaining: m.minutesRemaining, askCents: m.askCents })),
    botState: getMomentumBotState(),
    maxPositions: MAX_POSITIONS,
    openPositionsCount: openPositions.length,
  };
}

export async function updateMomentumConfig(cfg: Partial<MomentumBotConfig>): Promise<void> {
  if (cfg.balanceFloorCents !== undefined) state.balanceFloorCents = cfg.balanceFloorCents;
  if (cfg.maxSessionLossCents !== undefined) state.maxSessionLossCents = cfg.maxSessionLossCents;
  if (cfg.consecutiveLossLimit !== undefined) state.consecutiveLossLimit = cfg.consecutiveLossLimit;
  if (cfg.betCostCents !== undefined) state.betCostCents = cfg.betCostCents;
  if (cfg.simulatorMode !== undefined) state.simulatorMode = cfg.simulatorMode;
  if (cfg.priceMin !== undefined) state.priceMin = Math.max(1, Math.min(cfg.priceMin, 99));
  if (cfg.priceMax !== undefined) state.priceMax = Math.max(1, Math.min(cfg.priceMax, 99));
  if (cfg.tpCents !== undefined) state.tpCents = Math.max(1, cfg.tpCents);
  if (cfg.slCents !== undefined) state.slCents = Math.max(1, cfg.slCents);
  if (cfg.staleMs !== undefined) state.staleMs = Math.max(10_000, cfg.staleMs);
  if (cfg.tpAbsoluteCents !== undefined) state.tpAbsoluteCents = Math.max(0, cfg.tpAbsoluteCents);
  if (cfg.sessionProfitTargetCents !== undefined) state.sessionProfitTargetCents = Math.max(0, cfg.sessionProfitTargetCents);
  if (cfg.allowedCoins !== undefined && cfg.allowedCoins.length > 0) {
    state.allowedCoins = cfg.allowedCoins.filter(c => ALLOWED_COINS.includes(c));
    if (state.allowedCoins.length === 0) state.allowedCoins = [...ALLOWED_COINS];
  }
  await saveConfigFieldsOnly();
}

// ─── Start / Stop ────────────────────────────────────────────────────────────
export function startMomentumBot(): MomentumBotState {
  if (state.enabled) return getMomentumBotState();

  state.enabled = true;
  state.autoMode = true;
  state.status = "WAITING_FOR_SETUP";
  recoveryReady = false;

  // FIX #2 + #3: Kill ALL existing timers and reset lock BEFORE creating new ones.
  // This is the core fix for the zombie setTimeout / double-loop stacking bug.
  // Without this, stop→start within 5s leaves a pending setTimeout that fires
  // later and spawns a second setInterval — two loops both passing MAX_POSITIONS check.
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }
  scanInProgress = false; // reset lock — could be stuck if previous scan crashed

  setTradeClosedHook(recordTradeResult);
  state.sessionPnlCents = 0;
  state.sessionWins = 0;
  state.sessionLosses = 0;
  state.consecutiveLosses = 0;
  state.pausedUntilMs = null;
  state.pauseReason = null;

  startupHoldUntilMs = Date.now() + 60_000;
  console.log(`[STARTUP] All timers cleared, lock reset. 60s hold before new trades.`);

  if (state.simulatorMode) {
    simPositions.length = 0;
    state.simOpenTradeCount = 0;
    log(`🎮 [SIM] Paper trading active | W:${state.simWins} L:${state.simLosses} pnl:${state.simPnlCents}¢`);
  }

  // FIX #3: Sell monitor — direct setInterval, no setTimeout wrapper
  sellTimer = setInterval(() => {
    runSellMonitor().catch(err => warn(`Sell monitor error: ${String(err)}`));
    monitorSimPositions().catch(err => warn(`Sim monitor error: ${String(err)}`));
  }, SELL_INTERVAL_MS);

  // FIX #2: Scan loop — direct setInterval, NO setTimeout delay.
  // The startupHoldUntilMs check inside scanMomentumMarkets handles the 60s hold.
  // NO setTimeout here = NO zombie timer risk on rapid stop/start.
  scanTimer = setInterval(() => {
    if (!state.enabled) return;
    console.log("[SCAN LOOP START]", Date.now()); // diagnostic — one per 15s = healthy, two = bug
    scanMomentumMarkets().catch(err => warn(`Scan error: ${String(err)}`));
  }, SCAN_INTERVAL_MS);

  // FIX #8: Recover open positions from DB before allowing any new live entries
  if (!state.simulatorMode) {
    db.select().from(tradesTable).where(eq(tradesTable.status, "open"))
      .then(openTrades => {
        let recovered = 0;
        for (const t of openTrades) {
          if (openPositions.some(p => p.tradeId === t.id)) continue;
          const entryYesEquiv = t.side === "YES" ? t.buyPriceCents : 100 - t.buyPriceCents;
          openPositions.push({
            tradeId: t.id, marketId: t.marketId, marketTitle: t.marketTitle ?? t.marketId,
            side: t.side as "YES" | "NO", entryPriceCents: t.buyPriceCents,
            entrySlippageCents: 0, contractCount: t.contractCount,
            enteredAt: t.createdAt.getTime(), lastSeenPriceCents: entryYesEquiv,
            lastMovedAt: Date.now(), buyOrderId: t.kalshiBuyOrderId ?? null, closeTs: 0,
          });
          recovered++;
        }
        if (recovered > 0) {
          state.openTradeCount = openPositions.length;
          state.status = "IN_TRADE";
          log(`🔄 [RECOVERY] Restored ${recovered} open position(s) — sell monitor now managing them`);
          dbLog("warn", `[MOMENTUM] Recovered ${recovered} open position(s) after restart`);
        }
        recoveryReady = true;
        console.log(`[RECOVERY] Complete — ${recovered} position(s) restored, live entries unlocked. openPositions:${openPositions.length}`);
      })
      .catch(err => {
        warn(`[RECOVERY] Failed: ${String(err)} — live entries remain locked`);
        // recoveryReady stays false — safe-side failure, bot won't trade blindly
      });
  } else {
    recoveryReady = true;
  }

  log(`▶️  Momentum Bot STARTED | MAX_POSITIONS:${MAX_POSITIONS} bet=$${(state.betCostCents/100).toFixed(2)}/trade | range:${state.priceMin}-${state.priceMax}¢ | sim:${state.simulatorMode}`);
  dbLog("info", `[MOMENTUM] ▶️ STARTED — MAX_POSITIONS:${MAX_POSITIONS} bet=$${(state.betCostCents/100).toFixed(2)}/trade sim:${state.simulatorMode}`);
  saveEnabledFlag(true);
  return getMomentumBotState();
}

export function resetSimStats(): MomentumBotState {
  state.simWins = 0; state.simLosses = 0; state.simPnlCents = 0;
  simPositions.length = 0; state.simOpenTradeCount = 0;
  log("🎮 [SIM] Scoreboard reset by user");
  saveMomentumConfig();
  db.delete(paperTradesTable).where(eq(paperTradesTable.botType, "momentum"))
    .catch(err => console.error("[momentumBot] paperTrades delete failed:", String(err)));
  return getMomentumBotState();
}

export async function resetAllStats(): Promise<MomentumBotState> {
  const liveBalance = getBotState().balanceCents;
  if (liveBalance != null && liveBalance > 0) state.startingBalanceCents = liveBalance;
  state.simWins = 0; state.simLosses = 0; state.simPnlCents = 0; state.simOpenTradeCount = 0;
  simPositions.length = 0;
  state.totalWins = 0; state.totalLosses = 0; state.totalPnlCents = 0;
  state.sessionPnlCents = 0; state.consecutiveLosses = 0;
  log("🗑️ All stats reset by user");
  saveMomentumConfig();
  await db.delete(tradesTable).catch(err => console.error("[momentumBot] trades delete failed:", String(err)));
  await db.delete(paperTradesTable).where(eq(paperTradesTable.botType, "momentum"))
    .catch(err => console.error("[momentumBot] paperTrades delete failed:", String(err)));
  return getMomentumBotState();
}

export function stopMomentumBot(reason = "Manually stopped via dashboard"): MomentumBotState {
  state.enabled = false;
  state.autoMode = false;
  state.status = "DISABLED";
  state.stopReason = reason;

  // FIX #8: Always clear both timers on stop — prevents zombie timers surviving into next start
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }
  scanInProgress = false; // reset lock so next start is clean

  if (openPositions.length > 0) {
    console.log(`🛑 BOT STOP — ${openPositions.length} open position(s) abandoned, recording as losses`);
    for (const pos of [...openPositions]) {
      const abandonedLoss = -state.slCents * pos.contractCount;
      recordTradeResult(pos.entryPriceCents, pos.entryPriceCents - state.slCents, abandonedLoss);
      dbLog("warn", `[MOMENTUM] ABANDONED position ${pos.tradeId} (${coinLabel(pos.marketId)}) on stop — counted as loss`);
      if (pos.tradeId > 0) {
        db.update(tradesTable).set({ status: "closed", pnlCents: abandonedLoss, closedAt: new Date() })
          .where(eq(tradesTable.id, pos.tradeId))
          .catch(err => console.error(`[STOP] DB update failed: ${String(err)}`));
      }
    }
    openPositions.length = 0;
    state.openTradeCount = 0;
  }

  const stack = new Error().stack?.split("\n").slice(1, 5).join(" | ") ?? "no stack";
  console.log(`🛑 BOT STOPPED — reason: ${reason}`);
  console.log(`🛑 STOP CALLER: ${stack}`);
  dbLog("info", `[MOMENTUM] ⏹️ Momentum Bot STOPPED — ${reason}`);
  log(`⏹️  Momentum Bot STOPPED — ${reason}`);
  saveEnabledFlag(false);
  return getMomentumBotState();
}
