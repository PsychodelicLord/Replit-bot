/**
 * Outcome Bot — structure-based trend-following scalper
 *
 * Strategy:
 *  - Watches BTC/ETH/SOL/DOGE/XRP/BNB on 15-min Kalshi markets (paper only)
 *  - Maintains a rolling 120-second price history per market (no cross-market memory)
 *  - Classifies each market every scan cycle into: TRENDING, BREAKOUT, EMERGING, or NO_TRADE
 *    - TRENDING:  ≥2¢ net directional move over 60-120s, ≤3 reversals
 *    - BREAKOUT:  ≥4¢ shift from 30-90s baseline, now holding at new level (last 15s)
 *    - EMERGING:  ≥1¢ move over 10-20s, continuing in same direction, ≤1 reversal
 *    - NO_TRADE:  choppy, insufficient movement, or repeated back-and-forth
 *  - Entry only on TRENDING, BREAKOUT, or EMERGING signals outside extreme price zones (85-95¢ YES)
 *  - No fixed take-profit; once +5¢ profit → trailing stop (exit if -3¢ from peak)
 *  - Wide structure-based stop loss: 12¢ default
 *  - Late market (last 3 min): slightly relaxed entry (shorter confirmation window)
 *  - Logs "no edge" if no trade taken during a full market
 *  - Always paper/simulator mode — never places real orders
 */

import { kalshiFetch } from "./kalshi-bot";
import { fetchActiveMarkets } from "./momentumBot";
import { logger } from "./logger";
import { db, botLogsTable, outcomeSettingsTable } from "@workspace/db";

// ─── Constants ──────────────────────────────────────────────────────────────
const ALLOWED_COINS          = ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB"];
const ALLOWED_TICKER_PREFIXES = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXDOGE15M", "KXXRP15M", "KXBNB15M"];

const SCAN_INTERVAL_MS         = 10_000;  // scan every 10s — faster than momentum for finer trend tracking
const MONITOR_INTERVAL_MS      = 3_000;   // position monitor every 3s
const PRICE_HISTORY_MAX_MS     = 120_000; // keep 2 min of price samples per market

// Market state classification thresholds
const TREND_MIN_CENTS          = 2;       // min net move (¢) for TRENDING state
const TREND_MIN_WINDOW_MS      = 60_000;  // need at least 60s of history to call it trending
const TREND_MAX_REVERSALS      = 3;       // max direction changes allowed in trending state
const BREAKOUT_MIN_CENTS       = 4;       // min shift (¢) from 30-90s baseline for BREAKOUT
const EMERGING_MIN_CENTS       = 1;       // min net move (¢) for EMERGING state
const EMERGING_MIN_WINDOW_MS   = 10_000;  // need at least 10s for emerging
const EMERGING_MAX_REVERSALS   = 1;       // max direction changes in emerging state

// Entry filters
const EXTREME_ZONE_HIGH        = 85;      // avoid YES > 85¢ (insufficient upside)
const EXTREME_ZONE_LOW         = 15;      // avoid YES < 15¢ (equiv. avoid NO > 85¢)
const MIN_MINUTES_REMAINING    = 4;       // don't enter within 4 min of expiry (normal)
const MIN_MINUTES_LATE         = 2;       // late-market mode: enter down to 2 min remaining
const LATE_MARKET_WINDOW_MS    = 3 * 60_000; // last 3 min = late market
const LATE_EMERGING_MIN_CENTS  = 1.0;    // relaxed emerging threshold in late market
const SPREAD_MAX               = 8;       // max spread to enter

// Risk parameters
const SL_CENTS                 = 12;      // structure stop-loss: 12¢
const TRAIL_ACTIVATE_CENTS     = 5;       // activate trailing stop at +5¢ profit
const TRAIL_RETRACE_CENTS      = 3;       // trail: exit if retraces 3¢ from peak
const EXPIRY_BUFFER_MS         = 30_000;  // close sim position 30s before market expiry

const FEE_RATE = 0.07;

// ─── Types ───────────────────────────────────────────────────────────────────
type MarketState = "TRENDING" | "BREAKOUT" | "EMERGING" | "NO_TRADE";

interface PriceSample {
  price: number; // YES price in cents
  ts:    number; // epoch ms
}

interface MarketPriceHistory {
  samples: PriceSample[];
  tradedThisMarket: boolean; // track if we placed a trade in this market cycle
}

interface OutcomePosition {
  posId:          string;
  marketId:       string;
  marketTitle:    string;
  side:           "YES" | "NO";
  entryYesPrice:  number;  // YES price at entry (¢)
  entryPriceCents: number; // what we paid per contract (¢) — YES price for YES, (100-YES) for NO
  contractCount:  number;
  betCostCents:   number;
  enteredAt:      number;
  closeTs:        number;  // market expiry epoch ms

  // Trailing stop tracking
  peakPnlCents:   number;
  trailingActive: boolean;

  // Last seen prices
  lastYesPrice:   number;
}

interface StateClassification {
  state:      MarketState;
  direction?: "UP" | "DOWN";
  moveCents?: number;
  reason:     string;
}

export interface OutcomeBotState {
  enabled:     boolean;
  status:      "DISABLED" | "SCANNING" | "IN_TRADE";
  lastDecision: string | null;
  lastDecisionAt: string | null;
  openTradeCount: number;

  // Sim stats
  simWins:      number;
  simLosses:    number;
  simPnlCents:  number;
  noEdgeCount:  number;

  // Config
  betCostCents: number;
}

// ─── State ───────────────────────────────────────────────────────────────────
const state: OutcomeBotState = {
  enabled:        false,
  status:         "DISABLED",
  lastDecision:   null,
  lastDecisionAt: null,
  openTradeCount: 0,
  simWins:        0,
  simLosses:      0,
  simPnlCents:    0,
  noEdgeCount:    0,
  betCostCents:   100,
};

// Per-market rolling price history: ticker → history
const priceHistories = new Map<string, MarketPriceHistory>();

// Active sim positions
const simPositions: OutcomePosition[] = [];

// Interval handles
let scanInterval:    ReturnType<typeof setInterval> | null = null;
let monitorInterval: ReturnType<typeof setInterval> | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg: string) {
  logger.info({}, `[OUTCOME BOT] ${msg}`);
}

function warn(msg: string) {
  logger.warn({}, `[OUTCOME BOT] ${msg}`);
}

function dbLog(level: "info" | "warn" | "error", message: string): void {
  db.insert(botLogsTable).values({ level, message }).catch(() => {});
}

function coin(ticker: string): string {
  for (const c of ALLOWED_COINS) {
    if (ticker.toUpperCase().includes(c)) return c;
  }
  return ticker;
}

function isOutcomeMarket(ticker: string): boolean {
  const up = ticker.toUpperCase();
  return ALLOWED_TICKER_PREFIXES.some(p => up.startsWith(p));
}

function now(): number { return Date.now(); }

function fmtPnl(c: number): string {
  return `${c >= 0 ? "+" : ""}${c}¢`;
}

// ─── Price History ────────────────────────────────────────────────────────────
function pruneHistory(hist: PriceSample[]): PriceSample[] {
  const cutoff = now() - PRICE_HISTORY_MAX_MS;
  return hist.filter(s => s.ts >= cutoff);
}

function recordPrice(ticker: string, yesPrice: number): void {
  if (!priceHistories.has(ticker)) {
    priceHistories.set(ticker, { samples: [], tradedThisMarket: false });
  }
  const entry = priceHistories.get(ticker)!;
  entry.samples.push({ price: yesPrice, ts: now() });
  entry.samples = pruneHistory(entry.samples);
}

// ─── Market State Classification ──────────────────────────────────────────────
function countReversals(samples: PriceSample[]): number {
  if (samples.length < 3) return 0;
  let reversals = 0;
  let prevDir: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i].price - samples[i - 1].price;
    if (Math.abs(delta) < 0.3) continue; // ignore micro-fluctuations < 0.3¢
    const dir = delta > 0 ? 1 : -1;
    if (prevDir !== null && dir !== prevDir) reversals++;
    prevDir = dir;
  }
  return reversals;
}

function classifyState(
  samples: PriceSample[],
  isLateMarket: boolean,
): StateClassification {
  if (samples.length < 2) {
    return { state: "NO_TRADE", reason: "insufficient samples" };
  }

  const t = now();

  // ── TRENDING check: 60-120s window ───────────────────────────────────────
  const trendSamples = samples.filter(s => t - s.ts <= 120_000);
  if (trendSamples.length >= 4) {
    const span = trendSamples[trendSamples.length - 1].ts - trendSamples[0].ts;
    if (span >= TREND_MIN_WINDOW_MS) {
      const netMove = trendSamples[trendSamples.length - 1].price - trendSamples[0].price;
      const reversals = countReversals(trendSamples);
      if (Math.abs(netMove) >= TREND_MIN_CENTS && reversals <= TREND_MAX_REVERSALS) {
        return {
          state:     "TRENDING",
          direction: netMove > 0 ? "UP" : "DOWN",
          moveCents: Math.abs(netMove),
          reason:    `${netMove > 0 ? "+" : ""}${netMove.toFixed(1)}¢ over ${Math.round(span / 1000)}s, ${reversals} reversals`,
        };
      }
    }
  }

  // ── BREAKOUT check: large shift from 30-90s baseline, now holding ────────
  const baselineSamples = samples.filter(s => t - s.ts >= 30_000 && t - s.ts <= 90_000);
  const recentSamples15  = samples.filter(s => t - s.ts <= 15_000);
  if (baselineSamples.length >= 3 && recentSamples15.length >= 2) {
    const baselineAvg = baselineSamples.reduce((a, s) => a + s.price, 0) / baselineSamples.length;
    const recentAvg   = recentSamples15.reduce((a, s) => a + s.price, 0) / recentSamples15.length;
    const shift = recentAvg - baselineAvg;
    if (Math.abs(shift) >= BREAKOUT_MIN_CENTS) {
      return {
        state:     "BREAKOUT",
        direction: shift > 0 ? "UP" : "DOWN",
        moveCents: Math.abs(shift),
        reason:    `${shift > 0 ? "+" : ""}${shift.toFixed(1)}¢ shift (base:${Math.round(baselineAvg)}¢ → now:${Math.round(recentAvg)}¢)`,
      };
    }
  }

  // ── EMERGING check: 10-20s window (or relaxed in late market) ────────────
  const emergingWindowMs = isLateMarket ? 15_000 : 20_000;
  const emergingMinCents = isLateMarket ? LATE_EMERGING_MIN_CENTS : EMERGING_MIN_CENTS;
  const emergingSamples  = samples.filter(s => t - s.ts <= emergingWindowMs);
  if (emergingSamples.length >= 2) {
    const span = emergingSamples[emergingSamples.length - 1].ts - emergingSamples[0].ts;
    const minSpanMs = isLateMarket ? 8_000 : EMERGING_MIN_WINDOW_MS;
    if (span >= minSpanMs) {
      const netMove = emergingSamples[emergingSamples.length - 1].price - emergingSamples[0].price;
      const reversals = countReversals(emergingSamples);
      if (Math.abs(netMove) >= emergingMinCents && reversals <= EMERGING_MAX_REVERSALS) {
        return {
          state:     "EMERGING",
          direction: netMove > 0 ? "UP" : "DOWN",
          moveCents: Math.abs(netMove),
          reason:    `${netMove > 0 ? "+" : ""}${netMove.toFixed(1)}¢ over ${Math.round(span / 1000)}s${isLateMarket ? " [late]" : ""}, ${reversals} reversals`,
        };
      }
    }
  }

  return { state: "NO_TRADE", reason: "choppy or insufficient movement" };
}

// ─── Sim Position Entry ───────────────────────────────────────────────────────
function enterSimPosition(
  ticker: string,
  title:  string,
  side:   "YES" | "NO",
  yesPrice: number,
  closeTs:  number,
  betCostCents: number,
): void {
  const entryPriceCents = side === "YES" ? yesPrice : 100 - yesPrice;
  if (entryPriceCents <= 0) return;

  const contractCount = Math.max(1, Math.floor(betCostCents / entryPriceCents));
  const posId = `${ticker}-${now()}`;

  simPositions.push({
    posId,
    marketId:       ticker,
    marketTitle:    title,
    side,
    entryYesPrice:  yesPrice,
    entryPriceCents,
    contractCount,
    betCostCents,
    enteredAt:      now(),
    closeTs,
    peakPnlCents:   0,
    trailingActive: false,
    lastYesPrice:   yesPrice,
  });

  state.openTradeCount = simPositions.length;
  state.status = "IN_TRADE";

  const cost = entryPriceCents * contractCount;
  log(`📥 SIM ENTRY | ${coin(ticker)} ${side} @${yesPrice}¢ | ${contractCount} contracts | cost:${cost}¢ | closes:${new Date(closeTs).toLocaleTimeString()}`);
  dbLog("info", `[OUTCOME] SIM ENTRY ${coin(ticker)} ${side} @${yesPrice}¢ × ${contractCount}c`);
}

// ─── Sim Position Exit ────────────────────────────────────────────────────────
function closeSimPosition(pos: OutcomePosition, exitYesPrice: number, reason: string): void {
  const idx = simPositions.findIndex(p => p.posId === pos.posId);
  if (idx === -1) return;
  simPositions.splice(idx, 1);

  // P&L: if YES, profit when price rises; if NO, profit when YES price falls
  const pnlPerContract = pos.side === "YES"
    ? (exitYesPrice - pos.entryYesPrice)
    : (pos.entryYesPrice - exitYesPrice);
  const grossPnl  = Math.round(pnlPerContract * pos.contractCount);
  const fee       = Math.round(Math.max(grossPnl, 0) * FEE_RATE);
  const pnlCents  = grossPnl - fee;

  state.simPnlCents += pnlCents;
  if (pnlCents > 0) state.simWins++;
  else if (pnlCents < 0) state.simLosses++;

  state.openTradeCount = simPositions.length;
  if (simPositions.length === 0) state.status = state.enabled ? "SCANNING" : "DISABLED";

  // Persist stats
  db.insert(outcomeSettingsTable)
    .values({ id: 1, simWins: state.simWins, simLosses: state.simLosses, simPnlCents: state.simPnlCents, noEdgeCount: state.noEdgeCount })
    .onConflictDoUpdate({
      target: outcomeSettingsTable.id,
      set: { simWins: state.simWins, simLosses: state.simLosses, simPnlCents: state.simPnlCents, noEdgeCount: state.noEdgeCount },
    })
    .catch(e => console.error("[outcomeBot] stats persist failed:", e));

  const label = pnlCents >= 0 ? "✅ WIN" : "❌ LOSS";
  log(`${label} | ${coin(pos.marketId)} ${pos.side} | entry:${pos.entryYesPrice}¢ exit:${exitYesPrice}¢ | P&L:${fmtPnl(pnlCents)} | reason:${reason}`);
  dbLog("info", `[OUTCOME] ${label} ${coin(pos.marketId)} ${pos.side} ${fmtPnl(pnlCents)} [${reason}]`);
}

// ─── Position Monitor ─────────────────────────────────────────────────────────
async function monitorPositions(): Promise<void> {
  if (simPositions.length === 0) return;

  // Fetch current orderbooks for all open positions in parallel
  for (const pos of [...simPositions]) {
    try {
      // Check expiry first — close 30s before market end
      const msUntilClose = pos.closeTs - now();
      if (msUntilClose <= EXPIRY_BUFFER_MS) {
        // Force close at current mid price
        const ob = await fetchOrderbook(pos.marketId);
        const exitYes = ob?.mid ?? pos.lastYesPrice;
        closeSimPosition(pos, exitYes, "EXPIRY");
        continue;
      }

      const ob = await fetchOrderbook(pos.marketId);
      if (!ob) continue;

      const currentYes = ob.mid;
      pos.lastYesPrice = currentYes;

      // Calculate current P&L (¢ per contract × contracts, before fees)
      const pnlPerContract = pos.side === "YES"
        ? (currentYes - pos.entryYesPrice)
        : (pos.entryYesPrice - currentYes);
      const pnlCents = Math.round(pnlPerContract * pos.contractCount);

      // Update peak P&L for trailing stop
      if (pnlCents > pos.peakPnlCents) pos.peakPnlCents = pnlCents;

      // Activate trailing stop once profit threshold reached
      if (!pos.trailingActive && pnlCents >= TRAIL_ACTIVATE_CENTS) {
        pos.trailingActive = true;
        log(`🔔 Trailing stop ACTIVATED | ${coin(pos.marketId)} ${pos.side} | pnl:${fmtPnl(pnlCents)} peak:${fmtPnl(pos.peakPnlCents)}`);
      }

      // Check trailing stop
      if (pos.trailingActive && pnlCents <= pos.peakPnlCents - TRAIL_RETRACE_CENTS) {
        closeSimPosition(pos, currentYes, `TRAIL (peak:${fmtPnl(pos.peakPnlCents)} retrace:${fmtPnl(pnlCents)})`);
        continue;
      }

      // Check stop loss
      if (pnlCents <= -SL_CENTS) {
        closeSimPosition(pos, currentYes, `SL (-${SL_CENTS}¢)`);
        continue;
      }
    } catch (err) {
      warn(`Monitor error for ${pos.marketId}: ${String(err)}`);
    }
  }
}

// ─── Orderbook Fetch ──────────────────────────────────────────────────────────
interface OrderbookSnap {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
}

/** Convert Kalshi raw price (0.0-1.0 dollar scale OR integer cents) to integer cents */
function rawToIntCents(raw: number): number {
  return raw <= 1.0 ? Math.round(raw * 100) : Math.round(raw);
}

async function fetchOrderbook(ticker: string): Promise<OrderbookSnap | null> {
  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}/orderbook`) as {
      orderbook_fp?: {
        yes_dollars?: Array<[number, number]>;
        no_dollars?:  Array<[number, number]>;
        yes?:         Array<[number, number]>;
        no?:          Array<[number, number]>;
      };
      orderbook?: {
        yes?: Array<[number, number]>;
        no?:  Array<[number, number]>;
      };
    };

    const ob      = resp?.orderbook_fp ?? resp?.orderbook;
    const yesSide = (ob as { yes_dollars?: Array<[number, number]>; yes?: Array<[number, number]> })?.yes_dollars
                 ?? (ob as { yes?: Array<[number, number]> })?.yes ?? [];
    const noSide  = (ob as { no_dollars?: Array<[number, number]>; no?: Array<[number, number]> })?.no_dollars
                 ?? (ob as { no?: Array<[number, number]> })?.no ?? [];

    if (yesSide.length > 0 || noSide.length > 0) {
      const bestYesAsk = rawToIntCents(yesSide[0]?.[0] ?? 0);
      const bestNoAsk  = rawToIntCents(noSide[0]?.[0] ?? 0);
      const bestYesBid = bestNoAsk > 0 ? 100 - bestNoAsk : 0;
      const ask    = bestYesAsk;
      const bid    = bestYesBid > 0 ? bestYesBid : Math.max(0, ask - 2);
      if (ask > 0 && bid > 0 && bid < ask) {
        return { bid, ask, mid: Math.round((bid + ask) / 2), spread: ask - bid };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Scan Markets ─────────────────────────────────────────────────────────────
// Uses the same shared fetchActiveMarkets() cache as the momentum bot —
// no duplicate API calls, no separate rate-limit concerns.
async function scanMarkets(): Promise<void> {
  if (!state.enabled) return;

  let marketsData: Array<{ ticker: string; title: string; minutesRemaining: number; closeTs: number; askCents: number; bidCents: number }> = [];
  try {
    const all = await fetchActiveMarkets();
    // Filter to only the coins this bot cares about
    marketsData = all.filter(m => isOutcomeMarket(m.ticker));
  } catch (err) {
    warn(`Failed to fetch market list: ${String(err)}`);
    return;
  }

  if (marketsData.length === 0) {
    log(`[SCAN] No eligible 15-min markets found — waiting for new cycle`);
    return;
  }

  log(`[SCAN] ${marketsData.length} markets: ${marketsData.map(m => `${coin(m.ticker)} ${m.minutesRemaining.toFixed(1)}min @${m.askCents}¢`).join(", ")}`);

  const t = now();

  for (const market of marketsData) {
    try {
      const msRemaining   = market.closeTs > 0 ? market.closeTs - t : market.minutesRemaining * 60_000;
      const minRemaining  = msRemaining / 60_000;
      const isLateMarket  = msRemaining <= LATE_MARKET_WINDOW_MS && msRemaining > 0;
      const minRequired   = isLateMarket ? MIN_MINUTES_LATE : MIN_MINUTES_REMAINING;

      // Always record price sample first (so market shows in state panel)
      const midCents = (market.askCents > 0 && market.bidCents > 0)
        ? Math.round((market.askCents + market.bidCents) / 2)
        : 0;
      if (midCents > 0 && midCents < 100) {
        recordPrice(market.ticker, midCents);
      }

      // Market ending soon — log "no edge" if we never traded it, then skip
      if (minRemaining < minRequired) {
        const hist = priceHistories.get(market.ticker);
        if (hist && !hist.tradedThisMarket && hist.samples.length > 5) {
          log(`📊 NO EDGE | ${coin(market.ticker)} — ${minRemaining.toFixed(1)}min left, no valid setup found`);
          dbLog("info", `[OUTCOME] NO_EDGE ${coin(market.ticker)}`);
          state.noEdgeCount++;
          hist.tradedThisMarket = true;
        }
        if (msRemaining < 0) priceHistories.delete(market.ticker);
        continue;
      }

      // Only one sim position per market
      if (simPositions.some(p => p.marketId === market.ticker)) continue;

      if (midCents <= 0 || midCents >= 100) continue;

      const hist = priceHistories.get(market.ticker)!;
      const classification = classifyState(hist.samples, isLateMarket);

      if (classification.state !== "NO_TRADE") {
        log(`[${classification.state}] ${coin(market.ticker)} @${midCents}¢ | ${classification.reason} | ${minRemaining.toFixed(1)}min left`);
      }

      if (classification.state === "NO_TRADE" || !classification.direction) {
        log(`[SKIP] ${coin(market.ticker)} — ${classification.reason} (${hist.samples.length} samples, ${minRemaining.toFixed(1)}min left)`);
        continue;
      }

      // Avoid extreme price zones
      if (midCents > EXTREME_ZONE_HIGH || midCents < EXTREME_ZONE_LOW) {
        log(`[ZONE FILTER] ${coin(market.ticker)} @${midCents}¢ — extreme zone, skipping`);
        continue;
      }

      // Fetch precise orderbook for spread check before entry
      const ob = await fetchOrderbook(market.ticker);
      if (!ob) {
        log(`[ORDERBOOK FAIL] ${coin(market.ticker)} — could not fetch orderbook, skipping`);
        continue;
      }
      if (ob.spread > SPREAD_MAX) {
        log(`[SPREAD FILTER] ${coin(market.ticker)} spread:${ob.spread}¢ > max:${SPREAD_MAX}¢, skipping`);
        continue;
      }

      const side: "YES" | "NO" = classification.direction === "UP" ? "YES" : "NO";
      state.lastDecision    = `${coin(market.ticker)}: ${side} [${classification.state}] ${classification.reason}`;
      state.lastDecisionAt  = new Date().toISOString();

      enterSimPosition(market.ticker, market.title, side, ob.mid, market.closeTs, state.betCostCents);
      hist.tradedThisMarket = true;

    } catch (err) {
      warn(`Scan error for ${market.ticker}: ${String(err)}`);
    }
  }
}

// ─── Bot Lifecycle ────────────────────────────────────────────────────────────
export function startOutcomeBot(): OutcomeBotState {
  if (scanInterval) return state; // already running

  state.enabled = true;
  state.status  = "SCANNING";
  log("▶ Started — paper mode, structure-based trending strategy");
  dbLog("info", "[OUTCOME BOT] Started");

  scanInterval = setInterval(() => {
    scanMarkets().catch(e => warn(`Scan loop error: ${String(e)}`));
  }, SCAN_INTERVAL_MS);

  monitorInterval = setInterval(() => {
    monitorPositions().catch(e => warn(`Monitor loop error: ${String(e)}`));
  }, MONITOR_INTERVAL_MS);

  // Initial scan immediately
  scanMarkets().catch(e => warn(`Initial scan error: ${String(e)}`));

  // Persist enabled flag
  db.insert(outcomeSettingsTable)
    .values({ id: 1, enabled: true })
    .onConflictDoUpdate({ target: outcomeSettingsTable.id, set: { enabled: true } })
    .catch(() => {});

  return state;
}

export function stopOutcomeBot(reason?: string): OutcomeBotState {
  if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }

  state.enabled = false;
  state.status  = "DISABLED";

  log(`⏹ Stopped${reason ? ` — ${reason}` : ""}`);
  dbLog("info", `[OUTCOME BOT] Stopped${reason ? ` — ${reason}` : ""}`);

  db.insert(outcomeSettingsTable)
    .values({ id: 1, enabled: false })
    .onConflictDoUpdate({ target: outcomeSettingsTable.id, set: { enabled: false } })
    .catch(() => {});

  return state;
}

export function getOutcomeBotState(): OutcomeBotState {
  return { ...state };
}

export function updateOutcomeBotConfig(cfg: { betCostCents?: number }): void {
  if (cfg.betCostCents !== undefined) state.betCostCents = cfg.betCostCents;

  db.insert(outcomeSettingsTable)
    .values({ id: 1, betCostCents: state.betCostCents })
    .onConflictDoUpdate({ target: outcomeSettingsTable.id, set: { betCostCents: state.betCostCents } })
    .catch(() => {});
}

export function resetOutcomeStats(): OutcomeBotState {
  state.simWins     = 0;
  state.simLosses   = 0;
  state.simPnlCents = 0;
  state.noEdgeCount = 0;
  state.lastDecision    = null;
  state.lastDecisionAt  = null;

  db.insert(outcomeSettingsTable)
    .values({ id: 1, simWins: 0, simLosses: 0, simPnlCents: 0, noEdgeCount: 0 })
    .onConflictDoUpdate({ target: outcomeSettingsTable.id, set: { simWins: 0, simLosses: 0, simPnlCents: 0, noEdgeCount: 0 } })
    .catch(() => {});

  log("📊 Stats reset");
  return { ...state };
}

export function getOutcomeMarketStates(): Record<string, { state: MarketState; direction?: "UP" | "DOWN"; moveCents?: number; reason: string; samples: number; latestPrice?: number }> {
  const result: Record<string, { state: MarketState; direction?: "UP" | "DOWN"; moveCents?: number; reason: string; samples: number; latestPrice?: number }> = {};
  for (const [ticker, hist] of priceHistories.entries()) {
    const classification = classifyState(hist.samples, false);
    const latestSample = hist.samples[hist.samples.length - 1];
    result[ticker] = {
      ...classification,
      samples:     hist.samples.length,
      latestPrice: latestSample?.price,
    };
  }
  return result;
}

export function getOutcomeOpenPositions(): Array<{
  posId: string; marketId: string; marketTitle: string; side: "YES" | "NO";
  entryPriceCents: number; entryYesPrice: number; contractCount: number;
  peakPnlCents: number; trailingActive: boolean; lastYesPrice: number;
  msRemaining: number; enteredAt: number;
}> {
  return simPositions.map(p => ({
    posId:           p.posId,
    marketId:        p.marketId,
    marketTitle:     p.marketTitle,
    side:            p.side,
    entryPriceCents: p.entryPriceCents,
    entryYesPrice:   p.entryYesPrice,
    contractCount:   p.contractCount,
    peakPnlCents:    p.peakPnlCents,
    trailingActive:  p.trailingActive,
    lastYesPrice:    p.lastYesPrice,
    msRemaining:     Math.max(0, p.closeTs - Date.now()),
    enteredAt:       p.enteredAt,
  }));
}

// ─── Auto-restore on server start ─────────────────────────────────────────────
export async function loadOutcomeConfig(forceStart = false): Promise<void> {
  try {
    const [row] = await db.select().from(outcomeSettingsTable).limit(1);
    if (row) {
      state.simWins      = row.simWins;
      state.simLosses    = row.simLosses;
      state.simPnlCents  = row.simPnlCents;
      state.noEdgeCount  = row.noEdgeCount;
      state.betCostCents = row.betCostCents;
    }

    const shouldStart = forceStart || row?.enabled;
    if (shouldStart) {
      log(`Auto-starting — ${forceStart ? "OUTCOME_AUTO_START env forced" : "was enabled before restart"}`);
      startOutcomeBot();
    } else {
      log("Not auto-starting — was disabled before restart (set OUTCOME_AUTO_START=true to force)");
    }
  } catch (err) {
    warn(`Failed to load saved config: ${String(err)}`);
    if (forceStart) {
      log("DB load failed but OUTCOME_AUTO_START=true — starting with defaults");
      startOutcomeBot();
    }
  }
}
