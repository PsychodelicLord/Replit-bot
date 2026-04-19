/**
 * Momentum Bot — selective trend-following scalper
 *
 * Rules:
 *  - Trades BTC, ETH, SOL, DOGE, XRP, BNB, HYPE (15-min crypto markets)
 *  - Entry: price 20-80¢, spread ≤5¢, >7 min remaining, momentum signal
 *  - Momentum = price moved ≥1¢ since previous scan (15s ago) in same direction
 *  - TP: +3¢, SL: -4¢, no-movement exit after 45s (price didn't move ≥1¢)
 *  - Max 2 simultaneous positions; no stacking same market or same direction
 *  - Per-market cooldown 75s after close
 *  - Risk: balance floor, session-loss limit, consecutive-loss streak pause
 *
 * API notes:
 *  - Kalshi now returns orderbook as `orderbook_fp` with `yes_dollars`/`no_dollars`
 *  - Market list endpoint includes `yes_ask_dollars`/`yes_bid_dollars` — used as fallback
 *  - Use max_close_ts to surface short-duration crypto markets
 */

import { kalshiFetch, getBotState, refreshBalance, setTradeClosedHook } from "./kalshi-bot";
import { logger } from "./logger";
import { db, tradesTable, botLogsTable, momentumSettingsTable, paperTradesTable } from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";

// ─── Constants ─────────────────────────────────────────────────────────────
const ALLOWED_COINS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB"];
const ALLOWED_TICKER_PREFIXES = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXDOGE15M", "KXXRP15M", "KXBNB15M"];

const PRICE_MIN  = 20;   // start tracking a market when price is in this range
const PRICE_MAX  = 80;
const ENTRY_BUFFER_CENTS = 5; // allow entry even if momentum has pushed price ±5¢ outside range
const SPREAD_MAX = 5;
const MIN_MINUTES_REMAINING = 5;
const MAX_POSITIONS = 2;

// TP_CENTS / SL_CENTS and STALE_MS are now configurable via state (default 5/2/65s)
const COOLDOWN_MS = 75_000;  // per-market cooldown after close
// Contract count cap: treat price as ≥ MIN_PRICE_FOR_CONTRACTS when sizing.
// Prevents outsized losses at extreme prices (e.g. 5¢ entry → 20 contracts → -60¢ SL hit).
// At 20¢ baseline: 100¢ bet → max 5 contracts → worst-case SL = -3¢ × 5 = -15¢.
const MIN_PRICE_FOR_CONTRACTS = 20;

// Time-based fast-move detection (replaces tick-counting)
const MOMENTUM_WINDOW_MS    = 15_000; // rolling look-back window: detect moves within last 15s
const MIN_FAST_MOVE_CENTS   = 2;      // need ≥2¢ directional move within the window to signal
const MAX_ENTRY_PRICE_YES   = 87;     // hard cap: never buy YES above 87¢ (insufficient upside)
const MIN_ENTRY_PRICE_YES   = 13;     // hard cap: never buy NO when YES < 13¢ (equiv cap for NO)
const PRICE_HISTORY_MAX_MS  = 60_000; // keep 60s of price samples per market
const TRADE_SPREAD_MAX      = 4;      // spread required to actually execute a trade
const TRADE_SPREAD_MAX_SIM  = 5;      // sim mode: allow up to 5¢ spread (slightly looser)
const SPREAD_MAX_SIM        = 8;      // sim mode: scan-level spread filter (looser than 5)
const MIN_MINUTES_REMAINING_SIM = 2;  // sim mode: enter with 2 min left (vs 3)

const SCAN_INTERVAL_MS = 15_000; // scan every 15s — gives prices time to move
const SELL_INTERVAL_MS = 2_000;  // monitor every 2s

const FEE_RATE = 0.07;

// ─── Types ─────────────────────────────────────────────────────────────────
// Per-market rolling price history for time-based fast-move detection
interface MarketMomentumState {
  priceHistory: Array<{ price: number; ts: number }>; // timestamped price samples (last 60s)
}

interface MomentumPosition {
  tradeId: number;
  entrySlippageCents?: number;  // abs(actual fill − expected limit) — 0 in sim, real in live
  marketId: string;         // Kalshi ticker
  marketTitle: string;
  side: "YES" | "NO";
  entryPriceCents: number;
  contractCount: number;
  enteredAt: number;        // ms
  lastSeenPriceCents: number;
  lastMovedAt: number;      // ms — last time price moved ≥1¢
  buyOrderId: string | null;
  closeTs: number;          // contract expiry epoch ms — 0 if unknown
}

interface MomentumDecision {
  action: "BUY_YES" | "BUY_NO" | "SKIP";
  reason: string;
  moveCents: number;      // abs price move detected within the window (¢)
  moveMs: number;         // time span over which the move occurred (ms)
  centsPerSec: number;    // velocity: moveCents / (moveMs / 1000)
}

// ─── State ─────────────────────────────────────────────────────────────────
export interface MomentumBotState {
  enabled: boolean;
  autoMode: boolean;
  status: "DISABLED" | "WAITING_FOR_SETUP" | "IN_TRADE" | "PAUSED";
  openTradeCount: number;
  lastDecision: string | null;
  lastDecisionAt: string | null;

  // Trade tracking
  totalWins: number;
  totalLosses: number;
  totalPnlCents: number;
  sessionPnlCents: number;
  consecutiveLosses: number;

  // Risk management
  pausedUntilMs: number | null;
  pauseReason: string | null;
  stopReason: string | null;   // why the bot last stopped (deploy reset / loss limit / balance floor)
  startingBalanceCents: number | null;  // balance snapshot at last stats reset — null until first reset
  balanceFloorCents: number;
  maxSessionLossCents: number;
  consecutiveLossLimit: number;
  betCostCents: number;        // how many cents to spend per trade (fractional contract support)

  // Simulator (paper trading) state — uses real market data, zero real money
  simulatorMode: boolean;
  simPnlCents: number;         // paper P&L this session
  simWins: number;
  simLosses: number;
  simOpenTradeCount: number;

  // Entry price range (cents) — only enter trades within this price band
  priceMin: number;
  priceMax: number;

  // Exit thresholds (cents) — configurable from UI
  tpCents: number;   // take-profit: gain in cents above entry
  slCents: number;   // stop-loss: loss in cents below entry
  staleMs: number;   // exit if price flat for this long (ms)
  tpAbsoluteCents: number;          // 0 = use relative tpCents; >0 = exit when YES price hits this level
  sessionProfitTargetCents: number; // 0 = trade indefinitely; >0 = stop when session gain hits this

  // Bot Health Score — updated after every trade once buffer >= 20
  healthScore: {
    total: number;           // 0–10
    label: "Healthy" | "Fragile" | "Broken" | "Pending";
    tradesInBuffer: number;  // how many trades are in the rolling window
    winRate: number;         // 0–1
    netEV: number;           // expected value per trade in cents
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
  healthScore: null,
};

export interface MomentumBotConfig {
  balanceFloorCents: number;     // 0 = disabled
  maxSessionLossCents: number;   // 0 = disabled
  consecutiveLossLimit: number;  // 0 = disabled
  betCostCents: number;          // cents to spend per trade (min 1)
  simulatorMode?: boolean;       // paper trading — real data, fake money
  priceMin?: number;             // min entry price in cents (default 38)
  priceMax?: number;             // max entry price in cents (default 62)
  tpCents?: number;              // take-profit threshold in cents (default 5)
  slCents?: number;              // stop-loss threshold in cents (default 2)
  staleMs?: number;              // stale-exit timer in ms (default 65000)
  tpAbsoluteCents?: number;      // 0 = use relative; >0 = exit when YES price hits this
  sessionProfitTargetCents?: number; // 0 = unlimited; >0 = stop when session P&L hits this
  enabled?: boolean;
}

// Per-market momentum counter state
const marketMomentum = new Map<string, MarketMomentumState>();

// Open positions tracked in-memory (no DB read needed for sell decisions)
const openPositions: MomentumPosition[] = [];

// Paper positions for simulator mode — same structure, no real orders
const simPositions: MomentumPosition[] = [];

// Per-market cooldowns
const marketCooldowns = new Map<string, number>(); // marketId → cooldown-expiry ms

// Global post-trade cooldown — blocks ALL new entries for N seconds after any trade closes.
// Prevents back-to-back trade spam across different markets.
const POST_WIN_COOLDOWN_MS  = 60_000;  // 60s after a TP/STALE exit
const POST_LOSS_COOLDOWN_MS = 120_000; // 120s after an SL exit (losses need more breathing room)
let globalCooldownUntilMs = 0;

// Hardcoded minimum balance — always enforced even if user hasn't set a floor.
// Bot will stop itself if available cash drops below this regardless of floor setting.
const MIN_BALANCE_HARD_FLOOR_CENTS = 200; // $2 absolute minimum to keep trading

// Scan / sell timers
let scanTimer: NodeJS.Timeout | null = null;
let sellTimer: NodeJS.Timeout | null = null;

// ─── Bot Health Score rolling buffer ────────────────────────────────────────
interface TradeRecord {
  pnlCents:      number;
  isWin:         boolean;
  exitReason:    "TP" | "SL" | "STALE";
  slippageCents: number;  // entry slippage (always 0 in sim, real in live)
  timestamp:     number;
}

const healthBuffer: TradeRecord[] = [];  // last 100 closed trades
let   healthTradeCount = 0;             // lifetime total fed into buffer

// ─── Live Execution Observation Layer ────────────────────────────────────────
// Records every REAL-money trade with entry, expected vs actual fill, slippage.
// Purely observational — execution logic is never changed by these metrics.
export interface LiveTradeRecord {
  timestamp:          number;
  market:             string;
  side:               "YES" | "NO";
  exitReason:         "TP" | "SL" | "STALE";
  entryPriceCents:    number;   // what we paid to enter
  entrySlippage:      number;   // actual fill minus limit (entry)
  midAtTrigger:       number;   // mid price when TP/SL/STALE fired
  expectedExitCents:  number;   // bid we passed to placeSellOrder
  actualFillCents:    number;   // what Kalshi actually filled us at
  exitSlippage:       number;   // actualFill − expectedExit (negative = worse)
  pnlCents:           number;   // net P&L after fees
}

const liveTradeBuffer: LiveTradeRecord[] = [];  // rolling last 100 real trades
let   liveTradeCount = 0;                       // lifetime real trade count

export interface LivePerformanceReport {
  sampleSize:     number;
  winRate:        number;
  avgWinCents:    number;
  avgLossCents:   number;
  evPerTrade:     number;
  staleRate:      number;
  totalPnlCents:  number;
  avgEntrySlip:   number;   // average entry slippage cents
  avgExitSlip:    number;   // average exit slippage cents (expected vs actual fill)
  tpRate:         number;
  slRate:         number;
  recentTrades:   LiveTradeRecord[];  // last 20
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
  const avgWin     = wins.length  ? wins.reduce((s,t)  => s + t.pnlCents, 0) / wins.length  : 0;
  const avgLoss    = losses.length? losses.reduce((s,t) => s + t.pnlCents, 0) / losses.length: 0;
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
    `  Exit  slippage avg: ${avgExitSlip.toFixed(2)}¢  (negative = worse than expected)\n` +
    `  Total P&L:     ${totalPnl >= 0 ? "+" : ""}${totalPnl}¢\n` +
    `${"─".repeat(60)}`;

  log(report);
  dbLog("info", report, "live-perf-report");
}

function recordLiveTradeExecution(record: LiveTradeRecord): void {
  liveTradeBuffer.push(record);
  if (liveTradeBuffer.length > 100) liveTradeBuffer.shift();
  liveTradeCount++;

  // Detailed per-trade log
  const slipStr = record.exitSlippage >= 0
    ? `+${record.exitSlippage}¢ better than expected`
    : `${record.exitSlippage}¢ worse than expected`;
  log(
    `📋 LIVE EXEC | ${record.side} ${record.market} | ` +
    `entry:${record.entryPriceCents}¢ mid@trigger:${record.midAtTrigger}¢ ` +
    `expectedExit:${record.expectedExitCents}¢ actualFill:${record.actualFillCents}¢ (${slipStr}) | ` +
    `reason:${record.exitReason} pnl:${record.pnlCents >= 0 ? "+" : ""}${record.pnlCents}¢`,
  );

  // Rolling report every 50 real trades
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

// Throttle: only write to DB once per minute for high-frequency log types
const _dbLogThrottle = new Map<string, number>();
function dbLog(level: "info" | "warn" | "error", message: string, throttleKey?: string): void {
  if (throttleKey) {
    const last = _dbLogThrottle.get(throttleKey) ?? 0;
    if (Date.now() - last < 60_000) return;
    _dbLogThrottle.set(throttleKey, Date.now());
  }
  db.insert(botLogsTable).values({ level, message }).catch(() => {/* non-fatal */});
}

function isMomentumMarket(ticker: string): boolean {
  const up = ticker.toUpperCase();
  return ALLOWED_TICKER_PREFIXES.some(p => up.startsWith(p));
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
    // Cooldown expired — resume
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
  // ── In-memory tracking — always happens first, DB-independent ──
  state.sessionPnlCents += pnlCents;

  if (pnlCents > 0) {
    state.totalWins++;
    state.consecutiveLosses = 0;
  } else if (pnlCents < 0) {
    state.totalLosses++;
    state.consecutiveLosses++;
  }
  state.totalPnlCents = (state.totalPnlCents ?? 0) + pnlCents;

  // ── Persist real trade W/L to DB so restarts don't wipe the scoreboard ──
  db.insert(momentumSettingsTable)
    .values({ id: 1, totalWins: state.totalWins, totalLosses: state.totalLosses, totalPnlCents: state.totalPnlCents ?? 0 })
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set: { totalWins: state.totalWins, totalLosses: state.totalLosses, totalPnlCents: state.totalPnlCents ?? 0 } })
    .catch(err => console.error("[momentumBot] recordTradeResult DB save failed:", String(err)));

  log(
    `📊 TRADE CLOSED | entry: ${entryPriceCents}¢ → exit: ${exitPriceCents}¢ | P&L: ${pnlCents >= 0 ? "+" : ""}${pnlCents}¢ | W:${state.totalWins} L:${state.totalLosses} | session: ${state.sessionPnlCents >= 0 ? "+" : ""}${state.sessionPnlCents}¢`,
    { entryPriceCents, exitPriceCents, pnlCents, totalWins: state.totalWins, totalLosses: state.totalLosses, sessionPnlCents: state.sessionPnlCents },
  );

  // Check consecutive loss limit — hard stop, requires re-enable from dashboard
  if (state.consecutiveLossLimit > 0 && state.consecutiveLosses >= state.consecutiveLossLimit) {
    stopMomentumBot(`${state.consecutiveLosses} consecutive losses hit limit of ${state.consecutiveLossLimit}`);
    return;
  }

  // Check session loss limit — hard stop, requires re-enable from dashboard
  if (state.maxSessionLossCents > 0 && state.sessionPnlCents <= -state.maxSessionLossCents) {
    stopMomentumBot(`Session loss limit hit: ${state.sessionPnlCents}¢ ≤ -${state.maxSessionLossCents}¢`);
    return;
  }

  // Check session profit target — stop when we've made enough for the session
  if (state.sessionProfitTargetCents > 0 && state.sessionPnlCents >= state.sessionProfitTargetCents) {
    stopMomentumBot(`🎯 Session profit target reached: +${state.sessionPnlCents}¢ ≥ +${state.sessionProfitTargetCents}¢ — locking in gains`);
  }
}

// ─── Time-Based Fast-Move Detection ────────────────────────────────────────
/**
 * Detects directional price momentum by measuring how far the price has moved
 * within a short rolling time window (MOMENTUM_WINDOW_MS = 15s).
 *
 * Signal fires when:
 *   - Price moved ≥ MIN_FAST_MOVE_CENTS (2¢) within the last 15 seconds
 *   - Current price is within hard entry caps (13–87¢) for the relevant direction
 *
 * This approach catches fast moves EARLY — at the start of momentum rather than
 * after 3-5 confirmation ticks have already pushed price near the ceiling.
 */
export function evaluateMomentum(marketId: string, currentPriceCents: number): MomentumDecision {
  const now = Date.now();

  if (!marketMomentum.has(marketId)) {
    marketMomentum.set(marketId, { priceHistory: [] });
  }
  const ms = marketMomentum.get(marketId)!;

  // Record current sample
  ms.priceHistory.push({ price: currentPriceCents, ts: now });

  // Trim history to last PRICE_HISTORY_MAX_MS (60s)
  const cutoff = now - PRICE_HISTORY_MAX_MS;
  ms.priceHistory = ms.priceHistory.filter(p => p.ts >= cutoff);

  const skip = (reason: string): MomentumDecision => ({
    action: "SKIP", reason, moveCents: 0, moveMs: 0, centsPerSec: 0,
  });

  // Need at least 2 samples to measure movement
  if (ms.priceHistory.length < 2) {
    return skip("First sample — establishing baseline");
  }

  // Compare current price against the oldest previous sample within the window.
  // Excludes the current sample (last element) so we never compare price to itself.
  // Falls back to the most recent prior sample if nothing old enough is in the window.
  const prevHistory   = ms.priceHistory.slice(0, -1); // all except current
  const windowStart   = now - MOMENTUM_WINDOW_MS;
  const windowPrev    = prevHistory.filter(p => p.ts >= windowStart);
  const reference     = windowPrev.length >= 1
    ? windowPrev[0]                                   // oldest prior sample in window
    : prevHistory[prevHistory.length - 1];            // most recent prior sample (fallback)

  const rawMove     = currentPriceCents - reference.price;
  const moveMs      = Math.max(now - reference.ts, 1);
  const absMv       = Math.abs(rawMove);
  const centsPerSec = absMv / (moveMs / 1000);

  console.log(`[MOMENTUM] ${marketId} | ${currentPriceCents}¢ | move:${rawMove > 0 ? "+" : ""}${rawMove}¢ in ${Math.round(moveMs / 1000)}s (${centsPerSec.toFixed(2)}¢/s) | history:${ms.priceHistory.length} samples`);

  // Not enough movement yet
  if (absMv < MIN_FAST_MOVE_CENTS) {
    return skip(`Flat — ${absMv}¢ move in ${Math.round(moveMs / 1000)}s (need ≥${MIN_FAST_MOVE_CENTS}¢ within ${MOMENTUM_WINDOW_MS / 1000}s)`);
  }

  if (rawMove > 0) {
    // Price surging UP → buy YES (bet price continues up)
    if (currentPriceCents > MAX_ENTRY_PRICE_YES) {
      return skip(`BUY_YES blocked — ${currentPriceCents}¢ > hard cap ${MAX_ENTRY_PRICE_YES}¢ (insufficient upside)`);
    }
    return {
      action: "BUY_YES",
      reason: `Fast momentum ▲ +${rawMove}¢ in ${Math.round(moveMs / 1000)}s (${centsPerSec.toFixed(2)}¢/s)`,
      moveCents: absMv, moveMs, centsPerSec,
    };
  } else {
    // Price dropping DOWN → buy NO (bet price continues down)
    if (currentPriceCents < MIN_ENTRY_PRICE_YES) {
      return skip(`BUY_NO blocked — ${currentPriceCents}¢ < hard cap ${MIN_ENTRY_PRICE_YES}¢ (insufficient upside)`);
    }
    return {
      action: "BUY_NO",
      reason: `Fast momentum ▼ ${rawMove}¢ in ${Math.round(moveMs / 1000)}s (${centsPerSec.toFixed(2)}¢/s)`,
      moveCents: absMv, moveMs, centsPerSec,
    };
  }
}

// ─── Market scanning ───────────────────────────────────────────────────────
/** Convert a raw Kalshi price to integer cents.
 *  Kalshi now uses 0.0–1.0 dollar scale in orderbook_fp; legacy was integer cents. */
function rawToIntCents(raw: number): number {
  if (raw <= 0) return 0;
  // 0.0–1.0 → dollar scale → multiply by 100
  return raw <= 1.0 ? Math.round(raw * 100) : Math.round(raw);
}

async function fetchMarketOrderBook(
  ticker: string,
  hintAskCents?: number,
  hintBidCents?: number,
): Promise<{ bid: number; ask: number; spread: number; mid: number } | null> {
  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}/orderbook`) as {
      // New format (Kalshi API ≥ 2025): prices in 0.0–1.0 dollar scale
      orderbook_fp?: {
        yes_dollars?: Array<[number, number]>;
        no_dollars?: Array<[number, number]>;
        // some variants use yes/no without _dollars even under orderbook_fp
        yes?: Array<[number, number]>;
        no?: Array<[number, number]>;
      };
      // Legacy format
      orderbook?: {
        yes?: Array<[number, number]>;
        no?: Array<[number, number]>;
      };
    };

    // Prefer new format, fall back to legacy
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

    // Orderbook empty — use market-list price hints if provided
    if (hintAskCents && hintBidCents && hintAskCents > 0 && hintBidCents > 0) {
      const spread = hintAskCents - hintBidCents;
      const mid = Math.round((hintAskCents + hintBidCents) / 2);
      return { bid: hintBidCents, ask: hintAskCents, spread, mid };
    }

    // Last resort: individual market detail (has yes_ask_dollars / yes_bid_dollars)
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
  // If close_time is missing, use 0 — the scan will reject any market with closeTs=0
  // (old behaviour of assuming 30 min let markets bypass the time filter entirely)
  const closeTs = m.close_time ? new Date(m.close_time).getTime() : 0;
  const minutesRemaining = closeTs > 0 ? Math.max(0, (closeTs - now) / 60_000) : 0;
  const askCents = m.yes_ask_dollars != null && m.yes_ask_dollars > 0
    ? Math.round(m.yes_ask_dollars * 100) : 0;
  const bidCents = m.yes_bid_dollars != null && m.yes_bid_dollars > 0
    ? Math.round(m.yes_bid_dollars * 100) : 0;
  return { ticker: m.ticker!, title: m.title ?? m.ticker!, minutesRemaining, closeTs, status: m.status ?? "open", askCents, bidCents };
}

// ── Market list cache — refreshed every 2 min to avoid rate-limiting Kalshi ──
let _marketCache: {
  markets: Array<{ ticker: string; title: string; minutesRemaining: number; closeTs: number; status: string; askCents: number; bidCents: number }>;
  cachedAt: number;
} | null = null;
const MARKET_CACHE_TTL_MS = 2 * 60_000; // re-fetch market list every 2 minutes

export async function fetchActiveMarkets(): Promise<Array<{
  ticker: string; title: string; minutesRemaining: number; closeTs: number; status: string; askCents: number; bidCents: number;
}>> {
  const now = Date.now();

  // Return cached list if it's still fresh
  if (_marketCache && now - _marketCache.cachedAt < MARKET_CACHE_TTL_MS) {
    return _marketCache.markets;
  }

  console.log(`[FETCH] Market cache stale — refreshing from Kalshi API`);

  // Query each series_ticker sequentially (not parallel) to stay under rate limits
  const allRaw: RawMarket[] = [];
  for (const prefix of ALLOWED_TICKER_PREFIXES) {
    try {
      const resp = await kalshiFetch("GET", `/markets?series_ticker=${prefix}&status=open&limit=5`) as { markets?: RawMarket[] };
      const raw = resp?.markets ?? [];
      if (raw.length > 0) {
        const detail = raw.map(m => `${m.ticker} close:${m.close_time ?? "none"} ask:${m.yes_ask_dollars} bid:${m.yes_bid_dollars}`).join(" | ");
        console.log(`[FETCH] ${prefix} → ${detail}`);
        allRaw.push(...raw);
      } else {
        console.log(`[FETCH] ${prefix} → 0 markets (between cycles)`);
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("429")) {
        warn(`[FETCH] Rate-limited on ${prefix} — using stale cache`);
        // On 429, immediately return stale cache rather than keep hammering
        if (_marketCache) return _marketCache.markets;
        return [];
      }
      warn(`[FETCH] Error fetching ${prefix}: ${msg}`);
    }
    // Small delay between each series request to avoid bursting the rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  const markets = allRaw
    // Kalshi returns "active" or omits status on some markets even when queried
    // with ?status=open — treat null/undefined/"open"/"active" all as live
    .filter(m => m.ticker && (!m.status || m.status === "open" || m.status === "active"))
    .map(m => rawToMarket(m, now))
    .filter(m => m.minutesRemaining > (state.simulatorMode ? MIN_MINUTES_REMAINING_SIM : MIN_MINUTES_REMAINING));

  console.log(`[FETCH] Refresh complete — ${markets.length} eligible markets found`);

  if (markets.length > 0) {
    // Only cache when we actually found markets — empty results are never cached
    // so the next scan re-fetches immediately (handles gaps between 15-min cycles)
    _marketCache = { markets, cachedAt: now };
  } else {
    _marketCache = null;
    console.log(`[FETCH] No eligible markets — cache cleared, will retry next scan`);
  }
  return markets;
}

// ─── Order placement ────────────────────────────────────────────────────────
async function placeBuyOrder(
  ticker: string,
  side: "YES" | "NO",
  limitCents: number,
  betCostCents: number,
): Promise<{ orderId: string; fillPrice: number; contractCount: number } | null> {
  const clientOrderId = `momentum-${ticker}-${side}-${Date.now()}`;
  // Kalshi uses count-based ordering (number of contracts), not cost-based.
  // count = how many contracts to buy. Each YES contract costs limitCents.
  // If budget < price, we can't afford even 1 contract — skip the trade rather than overspend.
  const contractCount = Math.floor(betCostCents / limitCents);
  if (contractCount < 1) {
    console.log(`[ORDER SKIP] budget:${betCostCents}¢ < price:${limitCents}¢ — can't afford 1 contract, skipping entry`);
    return null;
  }
  const estimatedCost = contractCount * limitCents;
  console.log(`[ORDER SIZING] budget:${betCostCents}¢ price:${limitCents}¢ → count:${contractCount} estimatedCost:${estimatedCost}¢`);

  const payload: Record<string, unknown> = {
    ticker,
    client_order_id: clientOrderId,
    type:   "limit",
    action: "buy",
    side:   side.toLowerCase(),
    count:  contractCount,
    yes_price: side === "YES" ? limitCents : undefined,
    no_price:  side === "NO"  ? limitCents : undefined,
  };

  console.log(`[ORDER PAYLOAD] ${JSON.stringify(payload)}`);
  try {
    const resp = await kalshiFetch("POST", "/portfolio/orders", payload) as {
      order?: { order_id?: string; yes_price?: number; no_price?: number; count?: number }
    };
    console.log(`[ORDER RESPONSE] ${JSON.stringify(resp)}`);
    const orderId   = resp?.order?.order_id ?? clientOrderId;
    const rawPrice  = side === "YES" ? (resp?.order?.yes_price ?? 0) : (resp?.order?.no_price ?? 0);
    const fillPrice = rawPrice > 0 ? Math.round(rawPrice * 100) : limitCents;
    const filled    = resp?.order?.count ?? contractCount;
    console.log(`[ORDER SUCCESS] orderId:${orderId} fillPrice:${fillPrice}¢ contracts:${filled} cost:${betCostCents}¢`);
    return { orderId, fillPrice, contractCount: filled };
  } catch (err) {
    console.error(`[ORDER FAILED] ${String(err)}`);
    warn(`placeBuyOrder failed: ${String(err)}`, { ticker, side, limitCents });
    return null;
  }
}

async function placeSellOrder(
  pos: MomentumPosition,
  currentBidCents: number,
  midAtTrigger = currentBidCents,  // YES-space mid price when TP/SL fired — for P&L and execution tracking
): Promise<boolean> {
  // For YES sell: limit in YES-space = bid - 2
  // For NO sell:  limit in NO-space = (100 - YESbid) - 2  (flip to NO-space first, then add slack)
  const limitCents = pos.side === "YES"
    ? Math.max(1, currentBidCents - 2)
    : Math.max(1, (100 - currentBidCents) - 2);
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
    await kalshiFetch("POST", "/portfolio/orders", payload);

    // P&L is computed from market mid at trigger time (YES-space), NOT the order response
    // price — Kalshi's order API returns the limit we submitted, not the actual fill price.
    //   YES gain: midAtTrigger (YES exit) - entryPriceCents (YES entry)
    //   NO gain:  (100 - midAtTrigger) (NO exit equiv) - entryPriceCents (NO entry)
    const exitPriceForPnl = pos.side === "YES"
      ? midAtTrigger
      : 100 - midAtTrigger;
    const gross  = exitPriceForPnl - pos.entryPriceCents;
    const fee    = Math.floor(FEE_RATE * Math.max(0, gross));
    const netPnl = gross - fee;

    // ── Remove from in-memory FIRST — always, regardless of DB status ──
    const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
    if (idx >= 0) openPositions.splice(idx, 1);
    state.openTradeCount = openPositions.length;

    // Per-market cooldown
    marketCooldowns.set(pos.marketId, Date.now() + COOLDOWN_MS);

    // ── Record win/loss in-memory immediately — DB-independent ──
    recordTradeResult(pos.entryPriceCents, exitPriceForPnl, netPnl);

    // Global cooldown — longer after a loss so bot doesn't immediately revenge-trade
    const cooldownMs = netPnl < 0 ? POST_LOSS_COOLDOWN_MS : POST_WIN_COOLDOWN_MS;
    globalCooldownUntilMs = Date.now() + cooldownMs;
    console.log(`[COOLDOWN] ${netPnl < 0 ? "LOSS" : "WIN"} — global cooldown set: ${cooldownMs / 1000}s`);

    // ── Health score tracking ──
    const liveGain = exitPriceForPnl - pos.entryPriceCents;
    const liveReason: "TP" | "SL" | "STALE" = liveGain >= state.tpCents ? "TP" : liveGain <= -state.slCents ? "SL" : "STALE";
    recordTradeForHealth(netPnl, liveReason, pos.entrySlippageCents ?? 0);

    // ── Live execution observation (purely observational, never changes logic) ──
    recordLiveTradeExecution({
      timestamp:         Date.now(),
      market:            pos.marketId,
      side:              pos.side,
      exitReason:        liveReason,
      entryPriceCents:   pos.entryPriceCents,
      entrySlippage:     pos.entrySlippageCents ?? 0,
      midAtTrigger,
      expectedExitCents: currentBidCents,
      actualFillCents:   exitPriceForPnl,
      exitSlippage:      exitPriceForPnl - currentBidCents,
      pnlCents:          netPnl,
    });

    // ── Async DB update — fire-and-forget, never blocks ──
    const sellFields = {
      status: "closed" as const,
      sellPriceCents: exitPriceForPnl,
      pnlCents: netPnl,
      feeCents: fee,
      closedAt: new Date(),
    };

    const persistSell = (id: number) => {
      db.update(tradesTable).set(sellFields)
        .where(eq(tradesTable.id, id))
        .catch(err => warn(`DB sell update failed for id=${id}: ${String(err)}`));
    };

    if (pos.tradeId > 0) {
      // Real DB id already resolved — update immediately
      persistSell(pos.tradeId);
    } else if (pos.buyOrderId) {
      // DB insert may still be in-flight — wait 6s for it to resolve,
      // then find the row by buyOrderId since we can't use the provisional negative id
      setTimeout(() => {
        db.update(tradesTable).set(sellFields)
          .where(eq(tradesTable.kalshiBuyOrderId, pos.buyOrderId!))
          .catch(err => warn(`DB sell update (by buyOrderId) failed: ${String(err)}`));
      }, 6_000);
    } else {
      warn(`DB sell skipped — no real tradeId or buyOrderId`, { provisId: pos.tradeId });
    }

    return true;
  } catch (err) {
    warn(`placeSellOrder failed: ${String(err)}`, { tradeId: pos.tradeId, market: pos.marketId });

    // Even if Kalshi rejected the sell, still remove from in-memory so we don't loop forever
    const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
    if (idx >= 0) {
      warn(`Removing position ${pos.tradeId} from memory after failed sell attempt`);
      openPositions.splice(idx, 1);
      state.openTradeCount = openPositions.length;
      marketCooldowns.set(pos.marketId, Date.now() + COOLDOWN_MS);
    }

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
): Promise<void> {
  // Buy near bid (not ask) to avoid instant drawdown
  const limitCents = Math.min(askCents, bidCents + 1);
  const budget = betCents ?? state.betCostCents;

  const result = await placeBuyOrder(ticker, side, limitCents, budget);
  if (!result) return;

  // Insert trade row to DB (fire-and-forget)
  let tradeId = -(Date.now()); // provisional negative ID
  db.insert(tradesTable).values({
    marketId:       ticker,
    marketTitle:    title,
    side,
    buyPriceCents:  result.fillPrice,
    contractCount:  result.contractCount,
    feeCents:       0,
    pnlCents:       null,
    status:         "open",
    minutesRemaining: null,
    kalshiBuyOrderId: result.orderId,
  }).returning({ id: tradesTable.id }).then(rows => {
    if (rows[0]) {
      const realId = rows[0].id;
      const pos = openPositions.find(p => p.tradeId === tradeId);
      if (pos) pos.tradeId = realId;
      tradeId = realId;
    }
  }).catch(err => warn(`DB insert failed: ${String(err)}`));

  // lastSeenPriceCents must be in YES-space (sell monitor always compares against currentMid=YES).
  // For YES: fill price IS the YES price.
  // For NO:  fill price is the NO price; convert to YES-equivalent (100 - noPrice).
  const entryYesEquiv = side === "YES" ? result.fillPrice : 100 - result.fillPrice;

  const pos: MomentumPosition = {
    tradeId,
    marketId: ticker,
    marketTitle: title,
    side,
    entryPriceCents:   result.fillPrice,
    entrySlippageCents: Math.abs(result.fillPrice - limitCents), // actual vs expected
    contractCount: result.contractCount,
    enteredAt: Date.now(),
    lastSeenPriceCents: entryYesEquiv,  // YES-space so stale-tracker comparisons are valid
    lastMovedAt: Date.now(),
    buyOrderId: result.orderId,
    closeTs,
  };

  openPositions.push(pos);
  state.openTradeCount = openPositions.length;
  state.status = "IN_TRADE";

  log(
    `🟢 BUY ${side} — ${coinLabel(ticker)} @${result.fillPrice}¢ | tradeId: ${tradeId}`,
    { ticker, side, fillPrice: result.fillPrice, tradeId },
  );

  dbLog("info", `[MOMENTUM] 🟢 TRADE OPENED: BUY ${side} ${coinLabel(ticker)} @${result.fillPrice}¢ | tradeId:${tradeId}`);
}

// ─── Simulator (Paper Trading) ───────────────────────────────────────────────
/** Create a paper position — identical logic to executeMomentumTrade but no Kalshi API call */
function enterSimPosition(
  ticker: string,
  title: string,
  side: "YES" | "NO",
  bidCents: number,
  askCents: number,
  closeTs: number = 0,
  betCents?: number,
): void {
  const limitCents    = Math.min(askCents, bidCents + 1);
  const budget        = betCents ?? state.betCostCents;
  // Cap contract count: use at least MIN_PRICE_FOR_CONTRACTS as the divisor.
  // Without this cap, a 5¢-priced entry with 100¢ bet = 20 contracts,
  // so a -3¢ SL hit becomes -60¢ total. At 20¢ baseline, max loss = -3¢ × 5 = -15¢.
  const contractCount = budget / Math.max(limitCents, MIN_PRICE_FOR_CONTRACTS);
  const tradeId       = -(Date.now());

  const pos: MomentumPosition = {
    tradeId,
    marketId: ticker,
    marketTitle: title,
    side,
    entryPriceCents: limitCents,
    contractCount,
    enteredAt: Date.now(),
    lastSeenPriceCents: limitCents,
    lastMovedAt: Date.now(),
    buyOrderId: null,
    closeTs,
  };

  simPositions.push(pos);
  state.simOpenTradeCount = simPositions.length;
  state.status = "IN_TRADE";

  log(`🎮 [SIM] ENTER ${side} ${coinLabel(ticker)} @${limitCents}¢ | contracts:${contractCount.toFixed(3)} cost:${budget}¢`);
  dbLog("info", `[SIM] ENTER ${side} ${coinLabel(ticker)} @${limitCents}¢`);
}

/** Close a paper position at current price — no Kalshi API call */
function closeSimPosition(pos: MomentumPosition, exitPriceCents: number, reason: string): void {
  const rawGain  = pos.side === "YES"
    ? exitPriceCents - pos.entryPriceCents
    : pos.entryPriceCents - exitPriceCents;
  const pnlCents = Math.round(rawGain * pos.contractCount);

  const idx = simPositions.findIndex(p => p.tradeId === pos.tradeId);
  if (idx >= 0) simPositions.splice(idx, 1);

  state.simPnlCents      += pnlCents;
  state.simOpenTradeCount = simPositions.length;
  if (pnlCents > 0) state.simWins++; else state.simLosses++;

  recordTradeForHealth(pnlCents, parseExitReason(reason), 0); // slippage always 0 in sim
  marketCooldowns.set(pos.marketId, Date.now() + COOLDOWN_MS);

  const pnlSign = pnlCents >= 0 ? "+" : "";
  log(`🎮 [SIM] CLOSE ${pos.side} ${coinLabel(pos.marketId)} | entry:${pos.entryPriceCents}¢ exit:${exitPriceCents}¢ pnl:${pnlSign}${pnlCents}¢ | ${reason}`);
  log(`🎮 [SIM] Lifetime: ${state.simPnlCents >= 0 ? "+" : ""}${state.simPnlCents}¢ | W:${state.simWins} L:${state.simLosses}`);
  dbLog("info", `[SIM] CLOSE ${pos.side} ${coinLabel(pos.marketId)} pnl:${pnlSign}${pnlCents}¢ | lifetime:${state.simPnlCents >= 0 ? "+" : ""}${state.simPnlCents}¢ W:${state.simWins} L:${state.simLosses}`);
  saveMomentumConfig(); // persist sim stats after every trade so restarts never lose them

  // Persist individual trade record for lifetime history & advanced stats
  db.insert(paperTradesTable).values({
    botType:    "momentum",
    marketId:   pos.marketId,
    coin:       coinLabel(pos.marketId),
    side:       pos.side,
    entryPrice: pos.entryPriceCents,
    exitPrice:  exitPriceCents,
    pnlCents,
    exitReason: reason.split(" ")[0] ?? reason,
    enteredAt:  new Date(pos.enteredAt),
    closedAt:   new Date(),
  }).catch(err => console.error("[momentumBot] paperTrade insert failed:", String(err)));
}

// ─── Persistent Paper Trade Stats ─────────────────────────────────────────────
export interface TimeOfDayBucket {
  label: string;   // e.g. "12-16"
  wins:  number;
  losses: number;
  pnlCents: number;
}

export interface PaperTradeRecord {
  id:         number;
  coin:       string;
  side:       string;
  entryPrice: number;
  exitPrice:  number;
  pnlCents:   number;
  exitReason: string;
  closedAt:   string; // ISO string
}

export interface PaperStats {
  totalTrades:    number;
  wins:           number;
  losses:         number;
  winRatePct:     number;
  totalPnlCents:  number;
  evPerTradeCents: number;
  maxDrawdownCents: number;
  timeOfDay:      TimeOfDayBucket[];
  recentTrades:   PaperTradeRecord[];
}

export async function getPaperStats(): Promise<PaperStats> {
  const rows = await db
    .select()
    .from(paperTradesTable)
    .where(eq(paperTradesTable.botType, "momentum"))
    .orderBy(asc(paperTradesTable.closedAt));

  const totalTrades = rows.length;
  const wins    = rows.filter(r => r.pnlCents > 0).length;
  const losses  = rows.filter(r => r.pnlCents <= 0).length;
  const totalPnlCents = rows.reduce((s, r) => s + r.pnlCents, 0);
  const winRatePct = totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : 0;
  const evPerTradeCents = totalTrades > 0 ? Math.round(totalPnlCents / totalTrades) : 0;

  // Max drawdown: largest peak-to-trough decline in cumulative P&L
  let peak = 0;
  let runPnl = 0;
  let maxDrawdownCents = 0;
  for (const r of rows) {
    runPnl += r.pnlCents;
    if (runPnl > peak) peak = runPnl;
    const drawdown = peak - runPnl;
    if (drawdown > maxDrawdownCents) maxDrawdownCents = drawdown;
  }

  // Time-of-day buckets (4-hour windows, UTC)
  const buckets: Record<string, TimeOfDayBucket> = {};
  const bucketDefs: [string, number, number][] = [
    ["00-06", 0, 5], ["06-12", 6, 11], ["12-18", 12, 17], ["18-24", 18, 23],
  ];
  for (const [label] of bucketDefs) {
    buckets[label] = { label, wins: 0, losses: 0, pnlCents: 0 };
  }
  for (const r of rows) {
    const hour = new Date(r.closedAt).getUTCHours();
    const def  = bucketDefs.find(([, lo, hi]) => hour >= lo && hour <= hi);
    if (!def) continue;
    const b = buckets[def[0]]!;
    b.pnlCents += r.pnlCents;
    if (r.pnlCents > 0) b.wins++; else b.losses++;
  }

  // Most recent 20 trades (newest first)
  const recentTrades: PaperTradeRecord[] = rows.slice(-20).reverse().map(r => ({
    id:         r.id,
    coin:       r.coin,
    side:       r.side,
    entryPrice: r.entryPrice,
    exitPrice:  r.exitPrice,
    pnlCents:   r.pnlCents,
    exitReason: r.exitReason,
    closedAt:   r.closedAt instanceof Date ? r.closedAt.toISOString() : String(r.closedAt),
  }));

  return {
    totalTrades,
    wins,
    losses,
    winRatePct,
    totalPnlCents,
    evPerTradeCents,
    maxDrawdownCents,
    timeOfDay: Object.values(buckets),
    recentTrades,
  };
}

/** Monitor open paper positions — mirrors real sell monitor exactly:
 *  - TP/SL trigger uses mid (same as real)
 *  - Exit price uses BID for YES, ASK for NO (same as placeSellOrder in real mode)
 *  - This means TP fires at mid≥threshold but you only bank the bid, not the mid
 */
async function monitorSimPositions(): Promise<void> {
  if (simPositions.length === 0) return;
  const now = Date.now();
  const toClose: { pos: MomentumPosition; exitPrice: number; reason: string }[] = [];

  for (const pos of [...simPositions]) {
    let currentBid = pos.lastSeenPriceCents;
    let currentAsk = pos.lastSeenPriceCents;
    let currentMid = pos.lastSeenPriceCents;
    try {
      const ob = await fetchMarketOrderBook(pos.marketId);
      if (ob) {
        currentBid = ob.bid;
        currentAsk = ob.ask;
        currentMid = ob.mid;
      }
    } catch { /* keep last known */ }

    // Trigger check uses mid — matches real sell monitor behaviour
    const gain = pos.side === "YES"
      ? currentMid - pos.entryPriceCents
      : pos.entryPriceCents - currentMid;

    if (Math.abs(currentMid - pos.lastSeenPriceCents) >= 1) pos.lastMovedAt = now;
    pos.lastSeenPriceCents = currentMid;

    // Exit price mirrors placeSellOrder: sell YES at bid, sell NO at ask
    // (selling NO contracts = buying back YES, so you pay the ask to close)
    const realisticExitPrice = pos.side === "YES"
      ? (currentBid > 0 ? currentBid : currentMid)
      : (currentAsk > 0 ? currentAsk : currentMid);

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

  for (const pos of [...openPositions]) {
    // Fetch current price
    let currentBid = 0;
    let currentAsk = 0;
    try {
      const ob = await fetchMarketOrderBook(pos.marketId);
      if (ob) {
        currentBid = ob.bid;
        currentAsk = ob.ask;
      }
    } catch {
      continue;
    }

    if (currentBid <= 0 && currentAsk <= 0) continue;
    const currentMid = currentAsk > 0 ? Math.round((currentBid + currentAsk) / 2) : currentBid;
    const now  = Date.now();

    // For YES: profit when YES mid rises above entry.
    // For NO:  entryPriceCents is the NO fill price (e.g. 35¢ when YES=65¢).
    //          Convert to YES-equivalent so gain math works in a consistent space.
    //          gain > 0 when YES mid drops (NO value rises) = winning NO trade.
    const gain = pos.side === "YES"
      ? currentMid - pos.entryPriceCents
      : (100 - pos.entryPriceCents) - currentMid;

    // Update last-moved tracker — always compared in YES-space (currentMid)
    if (Math.abs(currentMid - pos.lastSeenPriceCents) >= 1) {
      pos.lastMovedAt = now;
    }
    pos.lastSeenPriceCents = currentMid;

    // Expiry force-exit — if < 2 min left on contract, exit NOW regardless of TP/SL
    // Holding to expiry in thin markets means binary settlement, not a clean fill
    if (pos.closeTs > 0) {
      const minsLeft = (pos.closeTs - now) / 60_000;
      if (minsLeft < 2) {
        log(`⚠️ EXPIRY EXIT — ${minsLeft.toFixed(1)}min left on Trade ${pos.tradeId} (${coinLabel(pos.marketId)}) — force-closing`);
        dbLog("warn", `[MOMENTUM] EXPIRY EXIT: ${coinLabel(pos.marketId)} — ${minsLeft.toFixed(1)}min left, gain:${gain}¢`);
        await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid);
        continue;
      }
    }

    // Absolute price TP — exit when YES price reaches a target level (e.g. 80¢)
    if (state.tpAbsoluteCents > 0) {
      const absHit = pos.side === "YES"
        ? currentMid >= state.tpAbsoluteCents
        : currentMid <= (100 - state.tpAbsoluteCents);
      if (absHit) {
        log(`💰 ABS-TP hit — price ${currentMid}¢ reached target ${pos.side === "YES" ? ">=" : "<="} ${pos.side === "YES" ? state.tpAbsoluteCents : 100 - state.tpAbsoluteCents}¢ on Trade ${pos.tradeId}`);
        await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid);
        continue;
      }
    }

    // Relative take-profit (cents above entry)
    if (gain >= state.tpCents) {
      log(`💰 TP hit — gain ${gain}¢ on Trade ${pos.tradeId}`, { gain, tradeId: pos.tradeId });
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid);
      continue;
    }

    // Stop-loss
    if (gain <= -state.slCents) {
      log(`🛑 SL hit — loss ${gain}¢ on Trade ${pos.tradeId}`, { gain, tradeId: pos.tradeId });
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid);
      continue;
    }

    // Stale-position exit
    if (now - pos.lastMovedAt >= state.staleMs) {
      log(`⏳ STALE EXIT — price flat for ${Math.round((now - pos.lastMovedAt) / 1000)}s on Trade ${pos.tradeId}`);
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid, currentMid);
      continue;
    }
  }

  state.openTradeCount = openPositions.length;
  if (openPositions.length === 0 && state.status === "IN_TRADE") {
    state.status = state.enabled ? "WAITING_FOR_SETUP" : "DISABLED";
  }
}

// ─── Market Scanner ─────────────────────────────────────────────────────────
let scanInProgress = false; // single-instance lock — prevents overlapping scans causing double bets

export async function scanMomentumMarkets(): Promise<void> {
  if (!state.enabled) return;
  if (scanInProgress) {
    console.log("[SCAN] Previous scan still running — skipping this tick to prevent double bets");
    return;
  }
  scanInProgress = true;

  try {

  // Risk checks
  if (checkRiskPause()) {
    state.status = "PAUSED";
    return;
  }

  const activePositions = state.simulatorMode ? simPositions : openPositions;
  if (activePositions.length >= MAX_POSITIONS) {
    state.status = "IN_TRADE";
    return;
  }

  state.status = activePositions.length > 0 ? "IN_TRADE" : "WAITING_FOR_SETUP";

  // Global post-trade cooldown — blocks ALL new entries for 60s after any close
  if (Date.now() < globalCooldownUntilMs) {
    const secsLeft = Math.ceil((globalCooldownUntilMs - Date.now()) / 1000);
    console.log(`[SCAN] Global cooldown active — ${secsLeft}s remaining (post-trade spam guard)`);
    return;
  }

  const markets = await fetchActiveMarkets();
  if (markets.length === 0) {
    log(`[SCAN] fetchActiveMarkets returned 0 markets — check ticker prefixes or API`);
    dbLog("warn", `[MOMENTUM] fetchActiveMarkets returned 0 markets`, "no-markets");
    return;
  }

  log(
    `[SCAN] ${markets.length} markets: ${markets.map(m => `${coinLabel(m.ticker)} ${m.minutesRemaining.toFixed(1)}min ask:${m.askCents}¢`).join(", ")}`,
  );

  // ── Phase 1: Evaluate ALL markets, collect ranked signals ─────────────────
  // We evaluate every market before executing anything so we always trade
  // the BEST available setup, not just the first one encountered.
  type Candidate = {
    market: typeof markets[0];
    ob: { bid: number; ask: number; spread: number; mid: number };
    decision: MomentumDecision;
    side: "YES" | "NO";
    score: number;
  };
  const candidates: Candidate[] = [];
  let inRangeCount = 0;

  for (const market of markets) {
    if (activePositions.some(p => p.marketId === market.ticker)) continue;
    const cooldown = marketCooldowns.get(market.ticker);
    if (cooldown && Date.now() < cooldown) continue;

    // ── Real-time time guard — recomputed NOW, not from stale cache ──────────
    // Cache can be up to 2 min old; without this check the bot enters markets
    // with only 1–2 min left when the cache still says "6 min remaining".
    // Also blocks any market where close_time was missing (closeTs === 0).
    const minRequired = state.simulatorMode ? MIN_MINUTES_REMAINING_SIM : MIN_MINUTES_REMAINING;
    if (market.closeTs <= 0) {
      console.log(`[SCAN] ${coinLabel(market.ticker)} — no close_time on record, skipping to be safe`);
      continue;
    }
    const actualMinutesLeft = (market.closeTs - Date.now()) / 60_000;
    if (actualMinutesLeft < minRequired) {
      console.log(`[SCAN] ${coinLabel(market.ticker)} — only ${actualMinutesLeft.toFixed(1)}min left (< ${minRequired}min required) — SKIP (stale cache had ${market.minutesRemaining.toFixed(1)}min)`);
      continue;
    }

    const ob = await fetchMarketOrderBook(market.ticker, market.askCents, market.bidCents);
    if (!ob) {
      log(`[SCAN] ${coinLabel(market.ticker)} — no orderbook data, skipping`);
      continue;
    }

    const { bid, ask, spread, mid } = ob;
    if (ask <= 0 || bid <= 0) {
      console.log(`[SCAN] ${coinLabel(market.ticker)} — zero prices (ask:${ask} bid:${bid}), skipping`);
      continue;
    }
    // Hard skip only if price is well outside configurable range (with ±5¢ buffer for momentum continuation)
    const pMin = state.priceMin;
    const pMax = state.priceMax;
    if (mid < pMin - ENTRY_BUFFER_CENTS || mid > pMax + ENTRY_BUFFER_CENTS) {
      console.log(`[SCAN] ${coinLabel(market.ticker)} — price ${mid}¢ outside ${pMin - ENTRY_BUFFER_CENTS}-${pMax + ENTRY_BUFFER_CENTS}¢ hard limit, skipping`);
      continue;
    }
    const scanSpreadLimit = state.simulatorMode ? SPREAD_MAX_SIM : SPREAD_MAX;
    if (spread > scanSpreadLimit) {
      console.log(`[SCAN] ${coinLabel(market.ticker)} — spread ${spread}¢ > ${scanSpreadLimit}¢ max, skipping${state.simulatorMode ? " [SIM]" : ""}`);
      continue;
    }
    // Count as "in range" only within core range — used to detect stale market cache
    if (mid >= pMin && mid <= pMax) inRangeCount++;
    if (mid < pMin || mid > pMax) {
      console.log(`[SCAN] ${coinLabel(market.ticker)} — price ${mid}¢ in buffer zone (${pMin - ENTRY_BUFFER_CENTS}-${pMin} or ${pMax}-${pMax + ENTRY_BUFFER_CENTS}¢) — momentum continuation allowed`);
    }

    const decision = evaluateMomentum(market.ticker, mid);

    log(
      `[MOMENTUM CHECK] ${coinLabel(market.ticker)} | price:${mid}¢ spread:${spread}¢ | ${decision.action} — ${decision.reason}`,
      { moveCents: decision.moveCents, moveMs: decision.moveMs, centsPerSec: decision.centsPerSec, decision: decision.action },
    );

    if (decision.action === "SKIP") {
      log(`[SKIP] ${coinLabel(market.ticker)} | price:${mid}¢ spread:${spread}¢ | ${decision.reason}`);
      continue;
    }

    // ── Quality filters — each rejected candidate explains WHY ────────────
    let filtered = false;

    // Filter 1: Spread must be ≤ TRADE_SPREAD_MAX (tighter than scan filter)
    // Sim mode uses a looser threshold (4¢ vs 3¢)
    const tradeSpreadLimit = state.simulatorMode ? TRADE_SPREAD_MAX_SIM : TRADE_SPREAD_MAX;
    if (spread > tradeSpreadLimit) {
      console.log(`[FILTER:SPREAD] ${coinLabel(market.ticker)} REJECTED — spread ${spread}¢ > ${tradeSpreadLimit}¢ trade threshold${state.simulatorMode ? " [SIM]" : ""}`);
      filtered = true;
    }

    if (filtered) continue;

    // Entry-time price guard: even if momentum pushed price into the buffer zone,
    // don't enter if the contract we'd buy has no room to profit.
    // BUY_NO when mid < pMin → NO contract already near 100¢, TP impossible
    // BUY_YES when mid > pMax → YES contract already near 100¢, TP impossible
    if (decision.action === "BUY_NO" && mid < pMin) {
      console.log(`[FILTER:ENTRY_PRICE] ${coinLabel(market.ticker)} REJECTED — BUY_NO at ${mid}¢ < priceMin ${pMin}¢ (NO contract already maxed out)`);
      continue;
    }
    if (decision.action === "BUY_YES" && mid > pMax) {
      console.log(`[FILTER:ENTRY_PRICE] ${coinLabel(market.ticker)} REJECTED — BUY_YES at ${mid}¢ > priceMax ${pMax}¢ (YES contract already maxed out)`);
      continue;
    }

    console.log(`[FILTER:PASS] ${coinLabel(market.ticker)} | spread:${spread}¢ move:${decision.moveCents}¢ in ${Math.round(decision.moveMs / 1000)}s (${decision.centsPerSec.toFixed(2)}¢/s) — all filters passed`);

    const side = decision.action === "BUY_YES" ? "YES" : "NO";
    if (activePositions.some(p => p.side === side && p.marketId === market.ticker)) continue;

    // ── Signal scoring: higher = better setup ─────────────────────────────
    // Scalping mode: score only on momentum strength, spread, and time — NOT payout ratio.
    // We're targeting 3-5¢ price movement, not holding to expiration.

    // Momentum strength: velocity (¢/s) is the primary driver — faster moves = stronger signal
    const momentumScore  = Math.min(decision.centsPerSec * 25, 60); // cap at 60 pts
    // Bonus for larger absolute moves (≥3¢ = high conviction)
    const signalBonus    = decision.moveCents >= 4 ? 15 : decision.moveCents >= 3 ? 10 : 5;
    // Tighter spread = cheaper round-trip
    const spreadScore    = (SPREAD_MAX - spread) * 3;
    // More time left = more room to TP before expiry
    const timeScore      = Math.min(market.minutesRemaining, 10);
    // NOTE: priceScore (distance from 50¢) intentionally removed — payout ratio is irrelevant for scalping
    const score = momentumScore + signalBonus + spreadScore + timeScore;

    log(`[SIGNAL] 🎯 ${coinLabel(market.ticker)} ${decision.action} | price:${mid}¢ spread:${spread}¢ score:${score.toFixed(0)} | ${decision.reason}`);
    dbLog("info", `[MOMENTUM] 🎯 SIGNAL: ${coinLabel(market.ticker)} ${decision.action} | price:${mid}¢ spread:${spread}¢ score:${score.toFixed(0)}`);
    candidates.push({ market, ob, decision, side, score });
  }

  // ── Phase 2: Rank signals and log leaderboard ─────────────────────────────
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    const board = candidates.slice(0, 5)
      .map(c => `${coinLabel(c.market.ticker)}(${c.score.toFixed(0)} ${c.side})`)
      .join(" > ");
    console.log(`[RANKING] ${candidates.length} signals → best: ${board}`);
    state.lastDecision = `${coinLabel(candidates[0].market.ticker)}: ${candidates[0].decision.action} — score:${candidates[0].score.toFixed(0)}`;
    state.lastDecisionAt = new Date().toISOString();
  }

  // ── Phase 3: Execute top-ranked signals up to MAX_POSITIONS ──────────────
  for (const candidate of candidates) {
    if (activePositions.length >= MAX_POSITIONS) break;

    // Safety guard — if bot was stopped between Phase 1 and Phase 3, abort
    if (!state.enabled) {
      console.log(`[EXECUTE ABORTED] Bot disabled before trade could fire — enabled:${state.enabled} stopReason:${state.stopReason}`);
      return;
    }

    const { market, ob, side, decision } = candidate;

    // ── Signal-strength variable sizing ──────────────────────────────────────
    // Velocity-based sizing: fast moves (≥0.2¢/s) = full bet; slower = 70%; health gates on top
    const signalMult    = decision.centsPerSec >= 0.20 ? 1.0 : 0.70;
    const health        = state.healthScore?.label;
    const healthMult    = health === "Fragile" ? 0.70 : 1.0;
    let effectiveBet = Math.round(state.betCostCents * signalMult * healthMult);
    effectiveBet = Math.max(1, effectiveBet);
    console.log(`[SIZING] ${coinLabel(market.ticker)} ${side} | base:${state.betCostCents}¢ velocity:${decision.centsPerSec.toFixed(2)}¢/s signalMult:${signalMult} health:${health ?? "Pending"} → bet:${effectiveBet}¢`);

    // Health gate: if Broken, skip real trades entirely — paper only
    if (health === "Broken" && !state.simulatorMode) {
      console.log(`[HEALTH GATE] Skipping live trade — bot health is Broken. Switch to sim or wait for recovery.`);
      continue;
    }

    if (state.simulatorMode) {
      // ── Simulator: paper position, no real money ──────────────────────────
      console.log(`[SIM EXECUTE] ${coinLabel(market.ticker)} ${side} @${ob.mid}¢ spread:${ob.spread}¢ score:${candidate.score.toFixed(0)} bet:${effectiveBet}¢`);
      enterSimPosition(market.ticker, market.title, side, ob.bid, ob.ask, market.closeTs, effectiveBet);
    } else {
      // ── Live mode: real Kalshi order ─────────────────────────────────────
      // Balance guard — always runs, even if no floor is configured.
      // Uses the higher of: user-set floor, $2 hard minimum, or (bet + 50¢ buffer).
      {
        const effectiveFloor = Math.max(
          state.balanceFloorCents,
          MIN_BALANCE_HARD_FLOOR_CENTS,
          effectiveBet + 50,
        );
        let balanceOk = false;
        try {
          await refreshBalance();
          const balance = getBotState().balanceCents;
          console.log(`[BALANCE CHECK] fetched:${balance}¢ floor:${effectiveFloor}¢ (user:${state.balanceFloorCents}¢ hard:${MIN_BALANCE_HARD_FLOOR_CENTS}¢ bet+50:${effectiveBet + 50}¢)`);
          if (balance > 0 && balance >= effectiveFloor) {
            balanceOk = true;
          } else if (balance > 0 && balance < effectiveFloor) {
            stopMomentumBot(`Balance too low: ${balance}¢ < ${effectiveFloor}¢ floor — stopping bot`);
            return;
          } else {
            // balance came back as 0 — API problem, block trade as precaution
            console.warn(`[BALANCE CHECK] Balance returned 0 — skipping trade as precaution (floor: ${effectiveFloor}¢)`);
          }
        } catch (err) {
          // fetch failed — block trade rather than risk breaching floor
          console.error(`[BALANCE CHECK] Failed to fetch balance — skipping trade: ${String(err)}`);
        }
        if (!balanceOk) return;
      }

      console.log(`[EXECUTE ATTEMPT] ${coinLabel(market.ticker)} ${side} | price:${ob.mid}¢ spread:${ob.spread}¢ score:${candidate.score.toFixed(0)} | positions:${openPositions.length}`);
      log(
        `[EXECUTE] ${coinLabel(market.ticker)} ${side} | price:${ob.mid}¢ spread:${ob.spread}¢ score:${candidate.score.toFixed(0)}`,
        { market: market.ticker, price: ob.mid, spread: ob.spread },
      );
      await executeMomentumTrade(market.ticker, market.title, side, ob.bid, ob.ask, market.closeTs, effectiveBet);
      console.log(`[EXECUTE DONE] ${coinLabel(market.ticker)} ${side} | positions now:${openPositions.length}`);
    }
  }

  // If no markets were in tradeable range, cache is likely stale (end-of-cycle)
  if (inRangeCount === 0) {
    console.log(`[SCAN] All ${markets.length} markets out of tradeable range — expiring cache for fresh fetch`);
    _marketCache = null;
  }

  state.openTradeCount    = openPositions.length;
  state.simOpenTradeCount = simPositions.length;
  if (activePositions.length > 0) state.status = "IN_TRADE";

  } finally {
    scanInProgress = false;
  }
}

// ─── Config Persistence ─────────────────────────────────────────────────────
/** Save current enabled+risk settings to DB (fire-and-forget). Called on every start/stop/config change. */
export function saveMomentumConfig(): void {
  const row = {
    id: 1,
    enabled:              state.enabled,
    balanceFloorCents:    state.balanceFloorCents,
    maxSessionLossCents:  state.maxSessionLossCents,
    consecutiveLossLimit: state.consecutiveLossLimit,
    betCostCents:         state.betCostCents,
    simulatorMode:        state.simulatorMode,
    priceMin:             state.priceMin,
    priceMax:             state.priceMax,
    simWins:              state.simWins,
    simLosses:            state.simLosses,
    simPnlCents:          state.simPnlCents,
    totalWins:            state.totalWins,
    totalLosses:          state.totalLosses,
    totalPnlCents:        state.totalPnlCents,
    startingBalanceCents: state.startingBalanceCents,
    // Exit thresholds — persisted so restarts keep your settings
    tpCents:    state.tpCents,
    slCents:    state.slCents,
    staleMs:    state.staleMs,
    tpAbsoluteCents:          state.tpAbsoluteCents,
    sessionProfitTargetCents: state.sessionProfitTargetCents,
  };
  db.insert(momentumSettingsTable).values(row)
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set: row })
    .catch(err => console.error("[momentumBot] saveMomentumConfig failed:", String(err)));
}

/**
 * Only persist the enabled flag — does NOT touch sim stats.
 * Use this in startMomentumBot / stopMomentumBot so that a Railway restart
 * cannot overwrite sim stats with zeros before loadMomentumConfig restores them.
 */
function saveEnabledFlag(enabled: boolean): void {
  db.insert(momentumSettingsTable)
    .values({ id: 1, enabled })
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set: { enabled } })
    .catch(err => console.error("[momentumBot] saveEnabledFlag failed:", String(err)));
}

/**
 * Only persist config/risk fields — does NOT touch simWins/simLosses/simPnlCents
 * or real-trade stats. Use this in updateMomentumConfig so that toggling settings
 * before loadMomentumConfig completes never overwrites the scoreboard with zeros.
 */
function saveConfigFieldsOnly(): void {
  const set = {
    balanceFloorCents:         state.balanceFloorCents,
    maxSessionLossCents:       state.maxSessionLossCents,
    consecutiveLossLimit:      state.consecutiveLossLimit,
    betCostCents:              state.betCostCents,
    simulatorMode:             state.simulatorMode,
    priceMin:                  state.priceMin,
    priceMax:                  state.priceMax,
    tpCents:                   state.tpCents,
    slCents:                   state.slCents,
    staleMs:                   state.staleMs,
    tpAbsoluteCents:           state.tpAbsoluteCents,
    sessionProfitTargetCents:  state.sessionProfitTargetCents,
  };
  db.insert(momentumSettingsTable)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set })
    .catch(err => console.error("[momentumBot] saveConfigFieldsOnly failed:", String(err)));
}

/**
 * Load persisted config from DB and optionally auto-start the bot.
 *
 * @param autoStartFallback - when true (MOMENTUM_AUTO_START=true), the bot
 *   starts even if Neon is unreachable after all retries — but always in
 *   PAPER (sim) mode so real money is never risked without DB confirmation.
 */
export async function loadMomentumConfig(autoStartFallback = false): Promise<void> {
  const MAX_ATTEMPTS = 10;
  const DELAYS_MS    = [2000, 3000, 5000, 5000, 8000, 8000, 10000, 10000, 15000, 15000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const rows = await db.select().from(momentumSettingsTable).where(eq(momentumSettingsTable.id, 1)).limit(1);
      if (rows.length === 0) {
        console.log("[momentumBot] No saved config — using defaults (bot starts disabled)");
        if (autoStartFallback) {
          state.simulatorMode = true; // always paper mode when no DB record
          console.log("[momentumBot] ⚠️  No DB record — starting in PAPER mode as safe default");
          startMomentumBot();
        }
        return;
      }
      const r = rows[0];
      state.balanceFloorCents    = r.balanceFloorCents;
      state.maxSessionLossCents  = r.maxSessionLossCents;
      state.consecutiveLossLimit = r.consecutiveLossLimit;
      state.betCostCents         = r.betCostCents ?? 30;
      state.simulatorMode        = r.simulatorMode ?? true;  // default to paper if null
      state.priceMin             = r.priceMin ?? 20;
      state.priceMax             = r.priceMax ?? 80;
      // Restore persisted sim stats so restarts don't wipe the scoreboard
      state.simWins     = r.simWins    ?? 0;
      state.simLosses   = r.simLosses  ?? 0;
      state.simPnlCents = r.simPnlCents ?? 0;
      // Restore real trade lifetime stats
      state.totalWins     = r.totalWins    ?? 0;
      state.totalLosses   = r.totalLosses  ?? 0;
      state.totalPnlCents = r.totalPnlCents ?? 0;
      state.startingBalanceCents = r.startingBalanceCents ?? null;
      // Restore exit thresholds so restarts keep the user's settings
      state.tpCents    = r.tpCents    ?? 5;
      state.slCents    = r.slCents    ?? 2;
      state.staleMs    = r.staleMs    ?? 65_000;
      state.tpAbsoluteCents          = r.tpAbsoluteCents          ?? 0;
      state.sessionProfitTargetCents = r.sessionProfitTargetCents ?? 0;

      if (r.enabled || autoStartFallback) {
        const reason = r.enabled ? "DB shows enabled=true" : "MOMENTUM_AUTO_START fallback";
        console.log(`[momentumBot] 🔄 Auto-starting bot (${reason}) | sim:${state.simulatorMode} | attempt ${attempt}`);
        startMomentumBot();
      } else {
        console.log(`[momentumBot] Saved config loaded (attempt ${attempt}) — bot was stopped, staying disabled`);
      }
      return;
    } catch (err) {
      const delay = DELAYS_MS[attempt - 1] ?? 15000;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[momentumBot] loadMomentumConfig attempt ${attempt}/${MAX_ATTEMPTS} failed — retrying in ${delay / 1000}s:`, String(err));
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[momentumBot] loadMomentumConfig failed after ${MAX_ATTEMPTS} attempts (~81s). Neon may be offline.`, String(err));
        if (autoStartFallback) {
          state.simulatorMode = true; // paper mode — never risk real money without DB
          console.log("[momentumBot] ⚠️  Neon unreachable — starting in PAPER mode as safe fallback");
          startMomentumBot();
        }
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
  // Update live health score after every trade once we have 20+ in the buffer
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
  // Log full report every 20 trades
  if (healthTradeCount % 20 === 0 && healthBuffer.length >= 20) {
    logHealthScore(calculateHealthScore());
  }
}

function calculateHealthScore(): {
  total: number; label: string;
  evScore: number; stabilityScore: number; ratioScore: number; staleScore: number; execScore: number;
  netEV: number; winRate: number; avgWin: number; avgLoss: number; staleRate: number; avgSlippage: number;
} {
  const current = healthBuffer.slice(-50);
  const prev    = healthBuffer.slice(-100, -50);

  const wins   = current.filter(t => t.isWin);
  const losses = current.filter(t => !t.isWin);
  const winRate  = wins.length / current.length;
  const lossRate = losses.length / current.length;
  const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnlCents, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlCents, 0) / losses.length) : 0;
  const netEV   = (avgWin * winRate) - (avgLoss * lossRate);

  // [1] Net EV per trade
  const evScore = netEV > 0.1 ? 2 : netEV >= -0.1 ? 1 : 0;

  // [2] Win rate stability vs previous 50-trade window
  let stabilityScore = 1; // benefit of doubt when < 100 trades seen
  if (prev.length >= 50) {
    const prevWinRate = prev.filter(t => t.isWin).length / prev.length;
    const change = Math.abs(winRate - prevWinRate) * 100;
    stabilityScore = change <= 5 ? 2 : change <= 10 ? 1 : 0;
  }

  // [3] Avg win vs avg loss ratio
  const ratio = avgLoss === 0 ? Infinity : avgWin / avgLoss;
  const ratioScore = ratio >= 1.0 ? 2 : ratio >= 0.75 ? 1 : 0;

  // [4] Stale exit rate
  const staleCount = current.filter(t => t.exitReason === "STALE").length;
  const staleRate  = staleCount / current.length;
  const staleScore = staleRate < 0.25 ? 2 : staleRate <= 0.40 ? 1 : 0;

  // [5] Execution quality (avg entry slippage)
  const avgSlippage = current.reduce((s, t) => s + t.slippageCents, 0) / current.length;
  const execScore   = avgSlippage < 0.5 ? 2 : avgSlippage <= 1.0 ? 1 : 0;

  const total = evScore + stabilityScore + ratioScore + staleScore + execScore;
  const label = total >= 8 ? "Healthy" : total >= 5 ? "Fragile" : "Broken";

  return { total, label, evScore, stabilityScore, ratioScore, staleScore, execScore,
           netEV, winRate, avgWin, avgLoss, staleRate, avgSlippage };
}

function logHealthScore(s: ReturnType<typeof calculateHealthScore>): void {
  const icon  = s.label === "Healthy" ? "✅" : s.label === "Fragile" ? "⚠️" : "🔴";
  const ratio = s.avgLoss > 0 ? (s.avgWin / s.avgLoss).toFixed(2) : "∞";
  const msg = [
    "",
    `🏥 ══════ BOT HEALTH SCORE (trade #${healthTradeCount}, rolling 50) ══════`,
    `${icon}  ${s.label.toUpperCase()}  —  ${s.total}/10`,
    `  [1] Net EV:          ${s.evScore}/2  (EV=${s.netEV.toFixed(3)}¢  WR=${(s.winRate*100).toFixed(1)}%  avgWin=${s.avgWin.toFixed(2)}¢  avgLoss=${s.avgLoss.toFixed(2)}¢)`,
    `  [2] WR Stability:    ${s.stabilityScore}/2  (vs previous 50-trade window)`,
    `  [3] Win/Loss Ratio:  ${s.ratioScore}/2  (avgWin÷avgLoss=${ratio})`,
    `  [4] Stale Rate:      ${s.staleScore}/2  (${(s.staleRate*100).toFixed(1)}% of exits were STALE)`,
    `  [5] Execution:       ${s.execScore}/2  (avg slippage=${s.avgSlippage.toFixed(3)}¢)`,
    "",
  ].join("\n");
  console.log(msg);
  dbLog("info", msg);
}

// ─── Public API ─────────────────────────────────────────────────────────────
export function getMomentumBotState(): MomentumBotState {
  return { ...state };
}

/** Debug: returns live market fetch + current tick history — for the /bot/momentum/debug endpoint */
export async function debugMomentumMarkets() {
  // Unfiltered fetch — same window but no ticker prefix filter, to see ALL markets
  const now = Date.now();
  const maxCloseTs = Math.floor((now + 20 * 60_000) / 1000);
  let rawCount = 0;
  let rawSample: string[] = [];
  try {
    const resp = await kalshiFetch("GET", `/markets?status=open&limit=100&max_close_ts=${maxCloseTs}`) as {
      markets?: Array<{ ticker?: string; close_time?: string; yes_ask_dollars?: number; yes_bid_dollars?: number }>;
    };
    rawCount = resp?.markets?.length ?? 0;
    rawSample = (resp?.markets ?? []).slice(0, 20).map(m => {
      const closeMs = m.close_time ? new Date(m.close_time).getTime() : now;
      const minsLeft = ((closeMs - now) / 60000).toFixed(1);
      return `${m.ticker} (${minsLeft}min, ask:${m.yes_ask_dollars} bid:${m.yes_bid_dollars})`;
    });
  } catch (e) {
    rawSample = [`Error: ${String(e)}`];
  }

  const filtered = await fetchActiveMarkets();
  const now2 = Date.now();
  const momentumSnap: Record<string, { samples: number; currentPrice: number | null; oldestSampleAgeMs: number; newestSampleAgeMs: number }> = {};
  for (const [marketId, ms] of marketMomentum.entries()) {
    const history = ms.priceHistory;
    momentumSnap[marketId] = {
      samples:           history.length,
      currentPrice:      history.length > 0 ? history[history.length - 1].price : null,
      oldestSampleAgeMs: history.length > 0 ? now2 - history[0].ts : 0,
      newestSampleAgeMs: history.length > 0 ? now2 - history[history.length - 1].ts : 0,
    };
  }

  return {
    rawMarketsInWindow: rawCount,
    rawSample,
    filteredMarkets: filtered.map(m => ({ ticker: m.ticker, minutesRemaining: m.minutesRemaining, askCents: m.askCents, bidCents: m.bidCents })),
    momentumCounters: momentumSnap,
    config: { MOMENTUM_WINDOW_MS, MIN_FAST_MOVE_CENTS, MAX_ENTRY_PRICE_YES, MIN_ENTRY_PRICE_YES, SCAN_INTERVAL_MS, PRICE_MIN, PRICE_MAX, ENTRY_BUFFER_CENTS, SPREAD_MAX, MIN_MINUTES_REMAINING },
    botState: getMomentumBotState(),
  };
}

export function updateMomentumConfig(cfg: Partial<MomentumBotConfig>): void {
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
  saveConfigFieldsOnly(); // never touches simWins/simLosses — safe before loadMomentumConfig completes
}

export function startMomentumBot(): MomentumBotState {
  if (state.enabled) return getMomentumBotState();

  state.enabled = true;
  state.autoMode = true;
  state.status = "WAITING_FOR_SETUP";

  // Wire up real-trade W/L counter (hook avoids circular import)
  setTradeClosedHook(recordTradeResult);
  state.sessionPnlCents = 0;
  state.consecutiveLosses = 0;
  state.pausedUntilMs = null;
  state.pauseReason = null;

  if (state.simulatorMode) {
    simPositions.length = 0;
    state.simOpenTradeCount = 0;
    log(`🎮 [SIM] Simulator mode — paper trading active, no real orders will be placed | lifetime: W:${state.simWins} L:${state.simLosses} pnl:${state.simPnlCents}¢`);
  }

  // Kick off sell monitor (handles both real and sim positions)
  if (!sellTimer) {
    sellTimer = setInterval(() => {
      runSellMonitor().catch(err => warn(`Sell monitor error: ${String(err)}`));
      monitorSimPositions().catch(err => warn(`Sim monitor error: ${String(err)}`));
    }, SELL_INTERVAL_MS);
  }

  // Kick off scan loop
  if (!scanTimer) {
    scanTimer = setInterval(() => {
      scanMomentumMarkets().catch(err => warn(`Scan error: ${String(err)}`));
    }, SCAN_INTERVAL_MS);
  }

  log("▶️  Momentum Bot STARTED");
  dbLog("info", `[MOMENTUM] ▶️ Momentum Bot STARTED — scanning every ${SCAN_INTERVAL_MS / 1000}s for ${ALLOWED_COINS.join(",")} 15-min markets`);
  saveEnabledFlag(true); // only persist enabled=true — never overwrites sim stats with zeros
  return getMomentumBotState();
}

/** Manually clear lifetime sim scoreboard and save to DB */
export function resetSimStats(): MomentumBotState {
  state.simWins     = 0;
  state.simLosses   = 0;
  state.simPnlCents = 0;
  simPositions.length = 0;
  state.simOpenTradeCount = 0;
  log("🎮 [SIM] Scoreboard reset by user");
  saveMomentumConfig();
  db.delete(paperTradesTable)
    .where(eq(paperTradesTable.botType, "momentum"))
    .catch(err => console.error("[momentumBot] paperTrades delete failed:", String(err)));
  return getMomentumBotState();
}

/** Reset ALL stats — sim + real trade W/L/PnL + clears trades table */
export async function resetAllStats(): Promise<MomentumBotState> {
  // Snapshot the current balance before wiping stats — persists until next reset
  const liveBalance = getBotState().balanceCents;
  if (liveBalance != null && liveBalance > 0) {
    state.startingBalanceCents = liveBalance;
  }
  // Reset in-memory state
  state.simWins       = 0;
  state.simLosses     = 0;
  state.simPnlCents   = 0;
  state.simOpenTradeCount = 0;
  simPositions.length = 0;
  state.totalWins     = 0;
  state.totalLosses   = 0;
  state.totalPnlCents = 0;
  state.sessionPnlCents = 0;
  state.consecutiveLosses = 0;
  log("🗑️ All stats reset by user");
  saveMomentumConfig();
  // Wipe trades table so allTimePnlCents DB query also returns 0
  await db.delete(tradesTable).catch(err => console.error("[momentumBot] resetAllStats: trades delete failed:", String(err)));
  await db.delete(paperTradesTable)
    .where(eq(paperTradesTable.botType, "momentum"))
    .catch(err => console.error("[momentumBot] resetAllStats: paperTrades delete failed:", String(err)));
  return getMomentumBotState();
}

export function stopMomentumBot(reason = "Manually stopped via dashboard"): MomentumBotState {
  state.enabled = false;
  state.autoMode = false;
  state.status = "DISABLED";
  state.stopReason = reason;

  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }

  // Capture call stack so Railway logs show exactly which line triggered the stop
  const stack = new Error().stack?.split("\n").slice(1, 5).join(" | ") ?? "no stack";
  console.log(`🛑 BOT STOPPED — reason: ${reason}`);
  console.log(`🛑 STOP CALLER: ${stack}`);
  dbLog("info", `[MOMENTUM] ⏹️ Momentum Bot STOPPED — ${reason}`);
  log(`⏹️  Momentum Bot STOPPED — ${reason}`);
  saveEnabledFlag(false); // only persist enabled=false — never overwrites sim stats with zeros
  return getMomentumBotState();
}
