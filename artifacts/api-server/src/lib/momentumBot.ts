/**
 * Momentum Bot — selective trend-following scalper
 *
 * Rules:
 *  - Trades BTC, ETH, SOL, DOGE, XRP, BNB, HYPE (15-min crypto markets)
 *  - Entry: price 30-70¢, spread ≤5¢, >7 min remaining, STRONG momentum
 *  - Momentum = 4/5 ticks same direction, range ≥2¢, all ticks within 20s
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

import { kalshiFetch } from "./kalshi-bot";
import { logger } from "./logger";
import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─── Constants ─────────────────────────────────────────────────────────────
const ALLOWED_COINS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB", "HYPE"];
const ALLOWED_TICKER_PREFIXES = ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXDOGE15M", "KXXRP15M", "KXBNB15M", "KXHYPE15M"];

const PRICE_MIN  = 20;
const PRICE_MAX  = 80;
const SPREAD_MAX = 5;
const MIN_MINUTES_REMAINING = 7;
const MAX_POSITIONS = 2;

const TP_CENTS    = 3;   // take-profit: exit when gain ≥ +3¢
const SL_CENTS    = 4;   // stop-loss: exit when loss ≥ -4¢
const STALE_MS    = 45_000;  // exit if price hasn't moved ≥1¢ in 45s
const COOLDOWN_MS = 75_000;  // per-market cooldown after close

const TICK_WINDOW      = 5;   // number of ticks to evaluate
const TICKS_REQUIRED   = 4;   // min ticks in same direction (out of TICK_WINDOW)
const RANGE_MIN_CENTS  = 2;   // min price range over last N ticks
const TICK_MAX_AGE_MS  = 20_000; // all N ticks must fit in this window

const SCAN_INTERVAL_MS = 3_000;  // scan every 3s
const SELL_INTERVAL_MS = 2_000;  // monitor every 2s

const FEE_RATE = 0.07;

// ─── Types ─────────────────────────────────────────────────────────────────
interface PriceTick {
  priceCents: number;
  timestampMs: number;
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
  balanceFloorCents: number;
  maxSessionLossCents: number;
  consecutiveLossLimit: number;
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
  balanceFloorCents: 0,
  maxSessionLossCents: 0,
  consecutiveLossLimit: 3,
};

export interface MomentumBotConfig {
  balanceFloorCents: number;     // 0 = disabled
  maxSessionLossCents: number;   // 0 = disabled
  consecutiveLossLimit: number;  // 0 = disabled
}

// Per-market tick history
const tickHistory = new Map<string, PriceTick[]>();

// Open positions tracked in-memory (no DB read needed for sell decisions)
const openPositions: MomentumPosition[] = [];

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

  // Check consecutive loss limit
  if (state.consecutiveLossLimit > 0 && state.consecutiveLosses >= state.consecutiveLossLimit) {
    triggerPause(15 * 60_000, `${state.consecutiveLosses} CONSECUTIVE LOSSES — PAUSING`);
    state.consecutiveLosses = 0;
    return;
  }

  // Check session loss limit
  if (state.maxSessionLossCents > 0 && state.sessionPnlCents <= -state.maxSessionLossCents) {
    triggerPause(15 * 60_000, `SESSION LOSS LIMIT HIT — PAUSING`);
  }
}

// ─── Tick history ──────────────────────────────────────────────────────────
function addTick(marketId: string, priceCents: number) {
  if (!tickHistory.has(marketId)) tickHistory.set(marketId, []);
  const ticks = tickHistory.get(marketId)!;
  ticks.push({ priceCents, timestampMs: Date.now() });
  // Keep only the last 20 ticks
  if (ticks.length > 20) ticks.splice(0, ticks.length - 20);
}

// ─── Momentum Evaluation ───────────────────────────────────────────────────
export function evaluateMomentum(marketId: string, currentPriceCents: number): MomentumDecision {
  addTick(marketId, currentPriceCents);

  const allTicks = tickHistory.get(marketId) ?? [];
  if (allTicks.length < TICK_WINDOW) {
    return { action: "SKIP", reason: `Only ${allTicks.length}/${TICK_WINDOW} ticks collected`, upMoves: 0, downMoves: 0, range: 0, ticks: [] };
  }

  const recent = allTicks.slice(-TICK_WINDOW);
  const prices = recent.map(t => t.priceCents);
  const oldest = recent[0].timestampMs;
  const newest = recent[recent.length - 1].timestampMs;
  const windowMs = newest - oldest;

  // Speed filter: all TICK_WINDOW ticks must be within TICK_MAX_AGE_MS
  if (windowMs > TICK_MAX_AGE_MS) {
    return {
      action: "SKIP",
      reason: `Movement too slow (${Math.round(windowMs / 1000)}s > ${TICK_MAX_AGE_MS / 1000}s)`,
      upMoves: 0, downMoves: 0, range: 0, ticks: prices,
    };
  }

  // Count direction changes
  let upMoves = 0;
  let downMoves = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i - 1]) upMoves++;
    else if (prices[i] < prices[i - 1]) downMoves++;
  }

  const range = Math.max(...prices) - Math.min(...prices);

  // Flat market filter
  if (range < RANGE_MIN_CENTS) {
    return {
      action: "SKIP",
      reason: `Market flat — range ${range}¢ < ${RANGE_MIN_CENTS}¢`,
      upMoves, downMoves, range, ticks: prices,
    };
  }

  const maxMoves = TICK_WINDOW - 1; // e.g. 4 possible moves for 5 ticks

  if (upMoves >= TICKS_REQUIRED) {
    return {
      action: "BUY_YES",
      reason: `Bullish momentum: ${upMoves}/${maxMoves} ticks UP, range ${range}¢`,
      upMoves, downMoves, range, ticks: prices,
    };
  }

  if (downMoves >= TICKS_REQUIRED) {
    return {
      action: "BUY_NO",
      reason: `Bearish momentum: ${downMoves}/${maxMoves} ticks DOWN, range ${range}¢`,
      upMoves, downMoves, range, ticks: prices,
    };
  }

  return {
    action: "SKIP",
    reason: `Choppy — UP:${upMoves} DOWN:${downMoves} (need ${TICKS_REQUIRED}/${maxMoves})`,
    upMoves, downMoves, range, ticks: prices,
  };
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

async function fetchActiveMarkets(): Promise<Array<{
  ticker: string;
  title: string;
  minutesRemaining: number;
  status: string;
  askCents: number;
  bidCents: number;
}>> {
  try {
    const now = Date.now();
    // Use max_close_ts to surface short-duration markets — the general endpoint
    // paginates by something other than close time and buries 15-min crypto markets.
    const maxCloseTs = Math.floor((now + 20 * 60_000) / 1000);
    const resp = await kalshiFetch("GET", `/markets?status=open&limit=100&max_close_ts=${maxCloseTs}`) as {
      markets?: Array<{
        ticker?: string;
        title?: string;
        close_time?: string;
        status?: string;
        yes_ask_dollars?: number;
        yes_bid_dollars?: number;
      }>
    };

    return (resp?.markets ?? [])
      .filter(m => m.ticker && isMomentumMarket(m.ticker))
      .map(m => {
        const closeMs = m.close_time ? new Date(m.close_time).getTime() : now;
        const minutesRemaining = Math.max(0, (closeMs - now) / 60_000);
        const askCents = m.yes_ask_dollars != null && m.yes_ask_dollars > 0
          ? Math.round(m.yes_ask_dollars * 100) : 0;
        const bidCents = m.yes_bid_dollars != null && m.yes_bid_dollars > 0
          ? Math.round(m.yes_bid_dollars * 100) : 0;
        return {
          ticker: m.ticker!,
          title: m.title ?? m.ticker!,
          minutesRemaining,
          status: m.status ?? "open",
          askCents,
          bidCents,
        };
      })
      .filter(m => m.status === "open" && m.minutesRemaining > MIN_MINUTES_REMAINING);
  } catch (err) {
    warn(`fetchActiveMarkets failed: ${String(err)}`);
    return [];
  }
}

// ─── Order placement ────────────────────────────────────────────────────────
async function placeBuyOrder(
  ticker: string,
  side: "YES" | "NO",
  limitCents: number,
): Promise<{ orderId: string; fillPrice: number } | null> {
  const clientOrderId = `momentum-${ticker}-${side}-${Date.now()}`;
  const payload = {
    ticker,
    client_order_id: clientOrderId,
    type: "limit",
    action: "buy",
    side,
    count: 1,
    yes_price: side === "YES" ? limitCents : undefined,
    no_price:  side === "NO"  ? limitCents : undefined,
  };

  try {
    const resp = await kalshiFetch("POST", "/portfolio/orders", payload) as {
      order?: { order_id?: string; yes_price?: number; no_price?: number }
    };
    const orderId = resp?.order?.order_id ?? clientOrderId;
    const rawPrice = side === "YES" ? (resp?.order?.yes_price ?? 0) : (resp?.order?.no_price ?? 0);
    const fillPrice = rawPrice > 0 ? Math.round(rawPrice * 100) : limitCents;
    return { orderId, fillPrice };
  } catch (err) {
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
    side: pos.side,
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
  // For YES: bid. For NO: same principle (100 - yes_ask is the no_bid effectively)
  const limitCents = Math.min(askCents, bidCents + 1);

  const result = await placeBuyOrder(ticker, side, limitCents);
  if (!result) return;

  // Insert trade row to DB (fire-and-forget)
  let tradeId = -(Date.now()); // provisional negative ID
  db.insert(tradesTable).values({
    marketId:       ticker,
    marketTitle:    title,
    side,
    buyPriceCents:  result.fillPrice,
    contractCount:  1,
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
    contractCount: 1,
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

  if (openPositions.length >= MAX_POSITIONS) {
    state.status = "IN_TRADE";
    return;
  }

  state.status = openPositions.length > 0 ? "IN_TRADE" : "WAITING_FOR_SETUP";

  const markets = await fetchActiveMarkets();
  if (markets.length === 0) return;

  for (const market of markets) {
    // Already have position in this market?
    const alreadyInMarket = openPositions.some(p => p.marketId === market.ticker);
    if (alreadyInMarket) continue;

    // Per-market cooldown active?
    const cooldown = marketCooldowns.get(market.ticker);
    if (cooldown && Date.now() < cooldown) continue;

    // Max positions reached?
    if (openPositions.length >= MAX_POSITIONS) break;

    // Fetch orderbook — pass market-list prices as hints for empty-book fallback
    const ob = await fetchMarketOrderBook(market.ticker, market.askCents, market.bidCents);
    if (!ob) continue;

    const { bid, ask, spread, mid } = ob;

    // Entry conditions
    if (mid < PRICE_MIN || mid > PRICE_MAX) continue;
    if (spread > SPREAD_MAX) continue;
    if (ask <= 0 || bid <= 0) continue;

    // Evaluate momentum (feeds in current mid price as tick)
    const decision = evaluateMomentum(market.ticker, mid);

    const logData = {
      ticks: decision.ticks,
      upMoves: decision.upMoves,
      downMoves: decision.downMoves,
      range: decision.range,
      decision: decision.action,
    };

    log(
      `[MOMENTUM CHECK] ${coinLabel(market.ticker)} | price:${mid}¢ spread:${spread}¢ | ${decision.action} — ${decision.reason}`,
      logData,
    );

    state.lastDecision = `${coinLabel(market.ticker)}: ${decision.action} — ${decision.reason}`;
    state.lastDecisionAt = new Date().toISOString();

    if (decision.action === "SKIP") continue;

    // Check for same-direction stacking
    const side = decision.action === "BUY_YES" ? "YES" : "NO";
    const sameDirExists = openPositions.some(p => p.side === side && p.marketId === market.ticker);
    if (sameDirExists) continue;

    // Balance floor check — fetch balance lazily if floor enabled
    if (state.balanceFloorCents > 0) {
      try {
        const balResp = await kalshiFetch("GET", "/portfolio/balance") as { balance?: { available_balance?: number } };
        const balance = Math.round((balResp?.balance?.available_balance ?? 0) * 100);
        if (balance <= state.balanceFloorCents) {
          const msg = `BALANCE FLOOR HIT (${balance}¢ ≤ ${state.balanceFloorCents}¢) — STOPPING BOT`;
          log(`🚨 ${msg}`);
          stopMomentumBot();
          return;
        }
      } catch { /* non-blocking */ }
    }

    log(
      `[MOMENTUM BOT] Market: ${coinLabel(market.ticker)} | Price: ${mid} | Spread: ${spread} | Momentum: ${decision.action === "BUY_YES" ? "UP" : "DOWN"} | Decision: ${decision.action}`,
      { market: market.ticker, price: mid, spread, momentum: decision.action },
    );

    await executeMomentumTrade(market.ticker, market.title, side, bid, ask);

    // Respect max positions — check again after trade
    if (openPositions.length >= MAX_POSITIONS) break;
  }

  state.openTradeCount = openPositions.length;
  if (openPositions.length > 0) state.status = "IN_TRADE";
}

// ─── Public API ─────────────────────────────────────────────────────────────
export function getMomentumBotState(): MomentumBotState {
  return { ...state };
}

export function updateMomentumConfig(cfg: Partial<MomentumBotConfig>): void {
  if (cfg.balanceFloorCents !== undefined) state.balanceFloorCents = cfg.balanceFloorCents;
  if (cfg.maxSessionLossCents !== undefined) state.maxSessionLossCents = cfg.maxSessionLossCents;
  if (cfg.consecutiveLossLimit !== undefined) state.consecutiveLossLimit = cfg.consecutiveLossLimit;
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

  // Kick off sell monitor
  if (!sellTimer) {
    sellTimer = setInterval(() => {
      runSellMonitor().catch(err => warn(`Sell monitor error: ${String(err)}`));
    }, SELL_INTERVAL_MS);
  }

  // Kick off scan loop
  if (!scanTimer) {
    scanTimer = setInterval(() => {
      scanMomentumMarkets().catch(err => warn(`Scan error: ${String(err)}`));
    }, SCAN_INTERVAL_MS);
  }

  log("▶️  Momentum Bot STARTED");
  return getMomentumBotState();
}

export function stopMomentumBot(): MomentumBotState {
  state.enabled = false;
  state.autoMode = false;
  state.status = "DISABLED";

  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }

  log("⏹️  Momentum Bot STOPPED");
  return getMomentumBotState();
}
