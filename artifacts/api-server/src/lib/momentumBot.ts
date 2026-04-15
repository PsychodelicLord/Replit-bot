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

import { kalshiFetch, getBotState, refreshBalance } from "./kalshi-bot";
import { logger } from "./logger";
import { db, tradesTable, botLogsTable, momentumSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─── Constants ─────────────────────────────────────────────────────────────
const ALLOWED_COINS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB", "HYPE"];
const ALLOWED_TICKER_PREFIXES = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXDOGE15M", "KXXRP15M", "KXBNB15M", "KXHYPE15M"];

const PRICE_MIN  = 20;   // start tracking a market when price is in this range
const PRICE_MAX  = 80;
const ENTRY_BUFFER_CENTS = 5; // allow entry even if momentum has pushed price ±5¢ outside range
const SPREAD_MAX = 5;
const MIN_MINUTES_REMAINING = 3;
const MAX_POSITIONS = 2;

const TP_CENTS    = 3;   // take-profit: exit when gain ≥ +3¢
const SL_CENTS    = 4;   // stop-loss: exit when loss ≥ -4¢
const STALE_MS    = 45_000;  // exit if price hasn't moved ≥1¢ in 45s
const COOLDOWN_MS = 75_000;  // per-market cooldown after close

const TICK_WINDOW_SIZE      = 5;      // track last N ticks (including flat)
const DOMINANCE_REQUIRED    = 3;      // need 3+ of last 5 ticks in same direction to enter
const DOMINANCE_REQUIRED_SIM = 2;    // sim mode: only need 2+ (looser)
const MIN_TICK_DELTA        = 1;      // min ¢ change to count as a directional move
const MIN_TOTAL_MOVE_CENTS  = 2;      // require ≥2¢ total price move before trading
const MIN_TOTAL_MOVE_SIM    = 1;      // sim mode: only 1¢ move needed (looser)
const TRADE_SPREAD_MAX      = 3;      // tighter spread required to actually execute a trade
const TRADE_SPREAD_MAX_SIM  = 4;     // sim mode: allow up to 4¢ spread (looser)
const SPREAD_MAX_SIM        = 6;     // sim mode: scan-level spread filter (looser than 5)
const MIN_MINUTES_REMAINING_SIM = 2; // sim mode: enter with 2 min left (vs 3)
const MOMENTUM_EXPIRY_MS    = 30_000; // if no tick for 30s, reset window — avoids stale setups

const SCAN_INTERVAL_MS = 15_000; // scan every 15s — gives prices time to move
const SELL_INTERVAL_MS = 2_000;  // monitor every 2s

const FEE_RATE = 0.07;

// ─── Types ─────────────────────────────────────────────────────────────────
// Per-market sliding-window state for directional dominance
interface MarketMomentumState {
  lastPrice: number | null;  // price at last real (non-flat) tick — anchor for delta
  firstTickPrice: number | null; // price at first tick in window — for totalMove calc
  tickWindow: Array<{ direction: "up" | "down" | "flat"; ts: number }>; // last TICK_WINDOW_SIZE ticks
}

interface MomentumPosition {
  tradeId: number;
  marketId: string;         // Kalshi ticker
  marketTitle: string;
  side: "YES" | "NO";
  entryPriceCents: number;
  contractCount: number;
  enteredAt: number;        // ms
  lastSeenPriceCents: number;
  lastMovedAt: number;      // ms — last time price moved ≥1¢
  buyOrderId: string | null;
}

interface MomentumDecision {
  action: "BUY_YES" | "BUY_NO" | "SKIP";
  reason: string;
  upMoves: number;
  downMoves: number;
  range: number;
  ticks: number[];
  totalMove: number;   // total ¢ moved since direction run started
  timeDiff: number;    // ms between first and last directional tick in run
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
  sessionPnlCents: number;
  consecutiveLosses: number;

  // Risk management
  pausedUntilMs: number | null;
  pauseReason: string | null;
  stopReason: string | null;   // why the bot last stopped (deploy reset / loss limit / balance floor)
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
  sessionPnlCents: 0,
  consecutiveLosses: 0,
  pausedUntilMs: null,
  pauseReason: null,
  stopReason: "Server started — not yet enabled",
  balanceFloorCents: 0,
  maxSessionLossCents: 0,
  consecutiveLossLimit: 0,
  betCostCents: 30,
  simulatorMode: false,
  simPnlCents: 0,
  simWins: 0,
  simLosses: 0,
  simOpenTradeCount: 0,
  priceMin: 20,
  priceMax: 80,
};

export interface MomentumBotConfig {
  balanceFloorCents: number;     // 0 = disabled
  maxSessionLossCents: number;   // 0 = disabled
  consecutiveLossLimit: number;  // 0 = disabled
  betCostCents: number;          // cents to spend per trade (min 1)
  simulatorMode?: boolean;       // paper trading — real data, fake money
  priceMin?: number;             // min entry price in cents (default 20)
  priceMax?: number;             // max entry price in cents (default 80)
}

// Per-market momentum counter state
const marketMomentum = new Map<string, MarketMomentumState>();

// Open positions tracked in-memory (no DB read needed for sell decisions)
const openPositions: MomentumPosition[] = [];

// Paper positions for simulator mode — same structure, no real orders
const simPositions: MomentumPosition[] = [];

// Per-market cooldowns
const marketCooldowns = new Map<string, number>(); // marketId → cooldown-expiry ms

// Scan / sell timers
let scanTimer: NodeJS.Timeout | null = null;
let sellTimer: NodeJS.Timeout | null = null;

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
  }
}

// ─── Sliding-window Directional Dominance Evaluation ───────────────────────
/**
 * Tracks the last TICK_WINDOW_SIZE price scans (including flat ticks).
 * Enters when 3+ of the last 5 ticks moved in the same direction.
 * Flat ticks are recorded but do NOT block or reset momentum.
 * Only resets the window if the market has gone completely stale (no scan for 30s).
 */
export function evaluateMomentum(marketId: string, currentPriceCents: number): MomentumDecision {
  const now = Date.now();

  if (!marketMomentum.has(marketId)) {
    marketMomentum.set(marketId, { lastPrice: null, firstTickPrice: null, tickWindow: [] });
  }
  const ms = marketMomentum.get(marketId)!;

  // First ever tick — establish baseline, no signal yet
  if (ms.lastPrice === null) {
    ms.lastPrice = currentPriceCents;
    ms.firstTickPrice = currentPriceCents;
    console.log(`[MOMENTUM] ${marketId} | Price: ${currentPriceCents}¢ first-tick`);
    return { action: "SKIP", reason: "First tick — establishing baseline", upMoves: 0, downMoves: 0, range: 0, ticks: [], totalMove: 0, timeDiff: 0 };
  }

  // Stale check — if last recorded tick was > MOMENTUM_EXPIRY_MS ago, reset window
  if (ms.tickWindow.length > 0) {
    const lastTs = ms.tickWindow[ms.tickWindow.length - 1].ts;
    if (now - lastTs > MOMENTUM_EXPIRY_MS) {
      console.log(`[MOMENTUM EXPIRED] ${marketId} — stale for ${Math.round((now - lastTs) / 1000)}s, window reset`);
      ms.tickWindow = [];
      ms.firstTickPrice = currentPriceCents;
    }
  }

  // Classify this tick vs last REAL (non-flat) anchor price
  const delta = currentPriceCents - ms.lastPrice;
  let direction: "up" | "down" | "flat";
  if (delta >= MIN_TICK_DELTA)       direction = "up";
  else if (delta <= -MIN_TICK_DELTA) direction = "down";
  else                               direction = "flat";

  // Advance anchor price on directional ticks only
  if (direction !== "flat") {
    ms.lastPrice = currentPriceCents;
    if (ms.firstTickPrice === null) ms.firstTickPrice = currentPriceCents;
  }

  // Add tick to sliding window (cap at TICK_WINDOW_SIZE)
  ms.tickWindow.push({ direction, ts: now });
  if (ms.tickWindow.length > TICK_WINDOW_SIZE) ms.tickWindow.shift();

  // Count directions in window
  const upMoves   = ms.tickWindow.filter(t => t.direction === "up").length;
  const downMoves = ms.tickWindow.filter(t => t.direction === "down").length;
  const dirMoves  = upMoves + downMoves;
  const flatMoves = ms.tickWindow.length - dirMoves;

  const totalMove = ms.firstTickPrice !== null ? Math.abs(currentPriceCents - ms.firstTickPrice) : 0;
  const dirTicks  = ms.tickWindow.filter(t => t.direction !== "flat");
  const timeDiff  = dirTicks.length >= 2 ? dirTicks[dirTicks.length - 1].ts - dirTicks[0].ts : 0;

  console.log(`[MOMENTUM] ${marketId} | ${currentPriceCents}¢ dir:${direction} | window up:${upMoves} dn:${downMoves} flat:${flatMoves}/${TICK_WINDOW_SIZE} | totalMove:${totalMove}¢`);

  const decide = (action: "BUY_YES" | "BUY_NO" | "SKIP", reason: string): MomentumDecision => ({
    action, reason, upMoves, downMoves,
    range: Math.abs(delta), ticks: [], totalMove, timeDiff,
  });

  // Fully flat window — market not moving at all
  if (dirMoves === 0) {
    return decide("SKIP", `Flat market — no directional ticks in last ${ms.tickWindow.length} scans`);
  }

  // Directional dominance — 3+ of last 5 ticks in same direction (flat ticks allowed between)
  // In sim mode: only 2+ needed (looser)
  const dominanceThreshold = state.simulatorMode ? DOMINANCE_REQUIRED_SIM : DOMINANCE_REQUIRED;
  if (upMoves >= dominanceThreshold) {
    console.log(`[DOMINANCE ▲] ${marketId} | up:${upMoves} dn:${downMoves} flat:${flatMoves} in last ${ms.tickWindow.length} scans${state.simulatorMode ? " [SIM]" : ""}`);
    return decide("BUY_YES", `Bullish dominance: ${upMoves}/${ms.tickWindow.length} UP ticks`);
  }
  if (downMoves >= dominanceThreshold) {
    console.log(`[DOMINANCE ▼] ${marketId} | up:${upMoves} dn:${downMoves} flat:${flatMoves} in last ${ms.tickWindow.length} scans${state.simulatorMode ? " [SIM]" : ""}`);
    return decide("BUY_NO", `Bearish dominance: ${downMoves}/${ms.tickWindow.length} DOWN ticks`);
  }

  // Mixed or still accumulating
  return decide("SKIP", `Accumulating — up:${upMoves} dn:${downMoves} flat:${flatMoves} (need ${dominanceThreshold}/${TICK_WINDOW_SIZE})`);
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
  // If close_time is missing, assume plenty of time remaining so the market isn't silently filtered
  const closeMs = m.close_time ? new Date(m.close_time).getTime() : now + 30 * 60_000;
  const minutesRemaining = Math.max(0, (closeMs - now) / 60_000);
  const askCents = m.yes_ask_dollars != null && m.yes_ask_dollars > 0
    ? Math.round(m.yes_ask_dollars * 100) : 0;
  const bidCents = m.yes_bid_dollars != null && m.yes_bid_dollars > 0
    ? Math.round(m.yes_bid_dollars * 100) : 0;
  return { ticker: m.ticker!, title: m.title ?? m.ticker!, minutesRemaining, status: m.status ?? "open", askCents, bidCents };
}

// ── Market list cache — refreshed every 2 min to avoid rate-limiting Kalshi ──
let _marketCache: {
  markets: Array<{ ticker: string; title: string; minutesRemaining: number; status: string; askCents: number; bidCents: number }>;
  cachedAt: number;
} | null = null;
const MARKET_CACHE_TTL_MS = 2 * 60_000; // re-fetch market list every 2 minutes

async function fetchActiveMarkets(): Promise<Array<{
  ticker: string; title: string; minutesRemaining: number; status: string; askCents: number; bidCents: number;
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
  // Use cost-based ordering: specify how many cents to spend.
  // Kalshi returns the actual fractional contract count filled.
  const payload = {
    ticker,
    client_order_id: clientOrderId,
    type:   "limit",
    action: "buy",
    side:   side.toLowerCase(),
    cost:   betCostCents,   // cents to spend — Kalshi resolves fractional count
    yes_price: side === "YES" ? limitCents : undefined,
    no_price:  side === "NO"  ? limitCents : undefined,
  };

  console.log(`[ORDER PAYLOAD] ${JSON.stringify(payload)}`);
  try {
    const resp = await kalshiFetch("POST", "/portfolio/orders", payload) as {
      order?: { order_id?: string; yes_price?: number; no_price?: number; count?: number }
    };
    console.log(`[ORDER RESPONSE] ${JSON.stringify(resp)}`);
    const orderId        = resp?.order?.order_id ?? clientOrderId;
    const rawPrice       = side === "YES" ? (resp?.order?.yes_price ?? 0) : (resp?.order?.no_price ?? 0);
    const fillPrice      = rawPrice > 0 ? Math.round(rawPrice * 100) : limitCents;
    const contractCount  = resp?.order?.count ?? Math.round(betCostCents / limitCents);
    console.log(`[ORDER SUCCESS] orderId:${orderId} fillPrice:${fillPrice}¢ contracts:${contractCount} cost:${betCostCents}¢`);
    return { orderId, fillPrice, contractCount };
  } catch (err) {
    console.error(`[ORDER FAILED] ${String(err)}`);
    warn(`placeBuyOrder failed: ${String(err)}`, { ticker, side, limitCents });
    return null;
  }
}

async function placeSellOrder(
  pos: MomentumPosition,
  currentBidCents: number,
): Promise<boolean> {
  const limitCents = Math.max(1, currentBidCents - 2);
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
    const resp = await kalshiFetch("POST", "/portfolio/orders", payload) as {
      order?: { order_id?: string; yes_price?: number; no_price?: number }
    };
    const rawPrice = pos.side === "YES"
      ? (resp?.order?.yes_price ?? 0)
      : (resp?.order?.no_price  ?? 0);
    const exitPrice = rawPrice > 0 ? Math.round(rawPrice * 100) : currentBidCents;
    const gross     = exitPrice - pos.entryPriceCents;
    const fee       = Math.floor(FEE_RATE * Math.max(0, gross));
    const netPnl    = gross - fee;

    // ── Remove from in-memory FIRST — always, regardless of DB status ──
    const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
    if (idx >= 0) openPositions.splice(idx, 1);
    state.openTradeCount = openPositions.length;

    // Per-market cooldown
    marketCooldowns.set(pos.marketId, Date.now() + COOLDOWN_MS);

    // ── Record win/loss in-memory immediately — DB-independent ──
    recordTradeResult(pos.entryPriceCents, exitPrice, netPnl);

    // ── Async DB update — fire-and-forget, never blocks ──
    const sellFields = {
      status: "closed" as const,
      sellPriceCents: exitPrice,
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
): Promise<void> {
  // Buy near bid (not ask) to avoid instant drawdown
  const limitCents = Math.min(askCents, bidCents + 1);

  const result = await placeBuyOrder(ticker, side, limitCents, state.betCostCents);
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

  const pos: MomentumPosition = {
    tradeId,
    marketId: ticker,
    marketTitle: title,
    side,
    entryPriceCents: result.fillPrice,
    contractCount: result.contractCount,
    enteredAt: Date.now(),
    lastSeenPriceCents: result.fillPrice,
    lastMovedAt: Date.now(),
    buyOrderId: result.orderId,
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
): void {
  const limitCents    = Math.min(askCents, bidCents + 1);
  const contractCount = state.betCostCents / Math.max(limitCents, 1);
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
  };

  simPositions.push(pos);
  state.simOpenTradeCount = simPositions.length;
  state.status = "IN_TRADE";

  log(`🎮 [SIM] ENTER ${side} ${coinLabel(ticker)} @${limitCents}¢ | contracts:${contractCount.toFixed(3)} cost:${state.betCostCents}¢`);
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

  marketCooldowns.set(pos.marketId, Date.now() + COOLDOWN_MS);

  const pnlSign = pnlCents >= 0 ? "+" : "";
  log(`🎮 [SIM] CLOSE ${pos.side} ${coinLabel(pos.marketId)} | entry:${pos.entryPriceCents}¢ exit:${exitPriceCents}¢ pnl:${pnlSign}${pnlCents}¢ | ${reason}`);
  log(`🎮 [SIM] Session: ${state.simPnlCents >= 0 ? "+" : ""}${state.simPnlCents}¢ | W:${state.simWins} L:${state.simLosses}`);
  dbLog("info", `[SIM] CLOSE ${pos.side} ${coinLabel(pos.marketId)} pnl:${pnlSign}${pnlCents}¢ | session:${state.simPnlCents >= 0 ? "+" : ""}${state.simPnlCents}¢`);
}

/** Monitor open paper positions — same TP/SL/stale logic as real monitor */
async function monitorSimPositions(): Promise<void> {
  if (simPositions.length === 0) return;
  const now = Date.now();
  const toClose: { pos: MomentumPosition; exitPrice: number; reason: string }[] = [];

  for (const pos of [...simPositions]) {
    let currentMid = pos.lastSeenPriceCents;
    try {
      const ob = await fetchMarketOrderBook(pos.marketId);
      if (ob) currentMid = ob.mid;
    } catch { /* keep last known */ }

    const gain = pos.side === "YES"
      ? currentMid - pos.entryPriceCents
      : pos.entryPriceCents - currentMid;

    if (Math.abs(currentMid - pos.lastSeenPriceCents) >= 1) pos.lastMovedAt = now;
    pos.lastSeenPriceCents = currentMid;

    if      (gain >= TP_CENTS)                  toClose.push({ pos, exitPrice: currentMid, reason: `TP +${gain}¢` });
    else if (gain <= -SL_CENTS)                 toClose.push({ pos, exitPrice: currentMid, reason: `SL ${gain}¢` });
    else if (now - pos.lastMovedAt >= STALE_MS) toClose.push({ pos, exitPrice: currentMid, reason: `STALE ${Math.round((now - pos.lastMovedAt) / 1000)}s` });
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
    const gain = currentMid - pos.entryPriceCents;
    const now  = Date.now();

    // Update last-moved tracker
    if (Math.abs(currentMid - pos.lastSeenPriceCents) >= 1) {
      pos.lastMovedAt = now;
    }
    pos.lastSeenPriceCents = currentMid;

    // Take-profit
    if (gain >= TP_CENTS) {
      log(`💰 TP hit — gain ${gain}¢ on Trade ${pos.tradeId}`, { gain, tradeId: pos.tradeId });
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid);
      continue;
    }

    // Stop-loss
    if (gain <= -SL_CENTS) {
      log(`🛑 SL hit — loss ${gain}¢ on Trade ${pos.tradeId}`, { gain, tradeId: pos.tradeId });
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid);
      continue;
    }

    // Stale-position exit
    if (now - pos.lastMovedAt >= STALE_MS) {
      log(`⏳ STALE EXIT — price flat for ${Math.round((now - pos.lastMovedAt) / 1000)}s on Trade ${pos.tradeId}`);
      await placeSellOrder(pos, currentBid > 0 ? currentBid : currentMid);
      continue;
    }
  }

  state.openTradeCount = openPositions.length;
  if (openPositions.length === 0 && state.status === "IN_TRADE") {
    state.status = state.enabled ? "WAITING_FOR_SETUP" : "DISABLED";
  }
}

// ─── Market Scanner ─────────────────────────────────────────────────────────
export async function scanMomentumMarkets(): Promise<void> {
  if (!state.enabled) return;

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
      { upMoves: decision.upMoves, downMoves: decision.downMoves, range: decision.range, decision: decision.action },
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

    // Filter 2: Minimum total price movement
    // Sim mode: only 1¢ needed (vs 2¢ live)
    const totalMoveLimit = state.simulatorMode ? MIN_TOTAL_MOVE_SIM : MIN_TOTAL_MOVE_CENTS;
    if (!filtered && decision.totalMove < totalMoveLimit) {
      console.log(`[FILTER:MOVE] ${coinLabel(market.ticker)} REJECTED — totalMove ${decision.totalMove}¢ < ${totalMoveLimit}¢ minimum${state.simulatorMode ? " [SIM]" : ""}`);
      filtered = true;
    }

    if (filtered) continue;
    console.log(`[FILTER:PASS] ${coinLabel(market.ticker)} | spread:${spread}¢ move:${decision.totalMove}¢ timeDiff:${decision.timeDiff}ms — all filters passed`);

    const side = decision.action === "BUY_YES" ? "YES" : "NO";
    if (activePositions.some(p => p.side === side && p.marketId === market.ticker)) continue;

    // ── Signal scoring: higher = better setup ─────────────────────────────
    // Scalping mode: score only on momentum strength, spread, and time — NOT payout ratio.
    // We're targeting 3-5¢ price movement, not holding to expiration.

    // Momentum strength (primary driver)
    const momentumScore  = (decision.upMoves + decision.downMoves) * 15;
    // Bonus for fast signals (strong conviction)
    const signalBonus    = decision.reason.includes("Fast momentum") ? 10 : 0;
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

    const { market, ob, side } = candidate;

    if (state.simulatorMode) {
      // ── Simulator: paper position, no real money ──────────────────────────
      console.log(`[SIM EXECUTE] ${coinLabel(market.ticker)} ${side} @${ob.mid}¢ spread:${ob.spread}¢ score:${candidate.score.toFixed(0)}`);
      enterSimPosition(market.ticker, market.title, side, ob.bid, ob.ask);
    } else {
      // ── Live mode: real Kalshi order ─────────────────────────────────────
      // Balance floor check — use the already-refreshed balance from main bot state
      if (state.balanceFloorCents > 0) {
        try {
          await refreshBalance();
          const balance = getBotState().balanceCents;
          console.log(`[BALANCE CHECK] fetched:${balance}¢ floor:${state.balanceFloorCents}¢`);
          if (balance > 0 && balance < state.balanceFloorCents) {
            stopMomentumBot(`Balance floor hit: ${balance}¢ < ${state.balanceFloorCents}¢ floor`);
            return;
          }
        } catch { /* non-blocking */ }
      }

      console.log(`[EXECUTE ATTEMPT] ${coinLabel(market.ticker)} ${side} | price:${ob.mid}¢ spread:${ob.spread}¢ score:${candidate.score.toFixed(0)} | positions:${openPositions.length}`);
      log(
        `[EXECUTE] ${coinLabel(market.ticker)} ${side} | price:${ob.mid}¢ spread:${ob.spread}¢ score:${candidate.score.toFixed(0)}`,
        { market: market.ticker, price: ob.mid, spread: ob.spread },
      );
      await executeMomentumTrade(market.ticker, market.title, side, ob.bid, ob.ask);
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
  };
  db.insert(momentumSettingsTable).values(row)
    .onConflictDoUpdate({ target: momentumSettingsTable.id, set: row })
    .catch(err => console.error("[momentumBot] saveMomentumConfig failed:", String(err)));
}

/** Load saved config from DB and restore state (including re-enabling the bot if it was on).
 *  Retries up to 3 times with 3s delays to handle Neon DB cold starts on Railway. */
export async function loadMomentumConfig(): Promise<void> {
  const MAX_ATTEMPTS = 10;
  const DELAYS_MS    = [2000, 3000, 5000, 5000, 8000, 8000, 10000, 10000, 15000, 15000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const rows = await db.select().from(momentumSettingsTable).where(eq(momentumSettingsTable.id, 1)).limit(1);
      if (rows.length === 0) {
        console.log("[momentumBot] No saved config — using defaults (bot starts disabled)");
        return;
      }
      const r = rows[0];
      state.balanceFloorCents    = r.balanceFloorCents;
      state.maxSessionLossCents  = r.maxSessionLossCents;
      state.consecutiveLossLimit = r.consecutiveLossLimit;
      state.betCostCents         = r.betCostCents ?? 30;
      state.simulatorMode        = r.simulatorMode ?? false;
      state.priceMin             = r.priceMin ?? 20;
      state.priceMax             = r.priceMax ?? 80;

      if (r.enabled) {
        console.log(`[momentumBot] 🔄 Restoring enabled state from DB (attempt ${attempt}) — auto-restarting bot | sim:${state.simulatorMode}`);
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
        console.error(`[momentumBot] loadMomentumConfig failed after ${MAX_ATTEMPTS} attempts (~81s) — bot stays disabled. Neon may be offline.`, String(err));
      }
    }
  }
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
  const momentumSnap: Record<string, { lastPrice: number | null; upMoves: number; downMoves: number; flatMoves: number; windowSize: number }> = {};
  for (const [marketId, ms] of marketMomentum.entries()) {
    const up   = ms.tickWindow.filter(t => t.direction === "up").length;
    const down = ms.tickWindow.filter(t => t.direction === "down").length;
    momentumSnap[marketId] = {
      lastPrice: ms.lastPrice,
      upMoves: up,
      downMoves: down,
      flatMoves: ms.tickWindow.length - up - down,
      windowSize: ms.tickWindow.length,
    };
  }

  return {
    rawMarketsInWindow: rawCount,
    rawSample,
    filteredMarkets: filtered.map(m => ({ ticker: m.ticker, minutesRemaining: m.minutesRemaining, askCents: m.askCents, bidCents: m.bidCents })),
    momentumCounters: momentumSnap,
    config: { TICK_WINDOW_SIZE, DOMINANCE_REQUIRED, MIN_TICK_DELTA, SCAN_INTERVAL_MS, PRICE_MIN, PRICE_MAX, ENTRY_BUFFER_CENTS, SPREAD_MAX, MIN_MINUTES_REMAINING },
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
  saveMomentumConfig();
}

export function startMomentumBot(): MomentumBotState {
  if (state.enabled) return getMomentumBotState();

  state.enabled = true;
  state.autoMode = true;
  state.status = "WAITING_FOR_SETUP";
  state.sessionPnlCents = 0;
  state.consecutiveLosses = 0;
  state.pausedUntilMs = null;
  state.pauseReason = null;

  // Reset sim stats on each start
  if (state.simulatorMode) {
    state.simPnlCents  = 0;
    state.simWins      = 0;
    state.simLosses    = 0;
    simPositions.length = 0;
    state.simOpenTradeCount = 0;
    log("🎮 [SIM] Simulator mode — paper trading active, no real orders will be placed");
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
  saveMomentumConfig(); // persist enabled=true to DB so Railway restarts restore state
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
  saveMomentumConfig(); // persist enabled=false to DB
  return getMomentumBotState();
}
