import crypto from "crypto";
import { db, tradesTable, botLogsTable } from "@workspace/db";
import { logger } from "./logger";
import { eq, isNull } from "drizzle-orm";

// ─── Kalshi API config ───────────────────────────────────────────────────────
const KALSHI_BASE = "https://trading-api.kalshi.com/trade-api/v2";
const API_KEY_ID = process.env.KALSHI_API_KEY ?? "";
const PRIVATE_KEY_PEM = (process.env.KALSHI_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

// ─── Bot parameters ──────────────────────────────────────────────────────────
const MAX_BET_CENTS = 59;          // never risk more than 59 cents per trade
const MIN_EDGE_CENTS = 5;          // min profit after fees (cents)
const MAX_EDGE_CENTS = 25;         // max spread to look for (cents)
const MIN_MINUTES_REMAINING = 10;  // skip market if 10 min or less remaining
const POLL_INTERVAL_MS = 20_000;   // scan markets every 20 seconds
const SELL_RETRY_MS = 8_000;       // retry selling open positions every 8s
const KALSHI_FEE_RATE = 0.07;      // 7% fee on winnings

// ─── In-memory bot state ─────────────────────────────────────────────────────
export interface BotState {
  running: boolean;
  startedAt: string | null;
  marketsScanned: number;
  tradesAttempted: number;
  tradesSucceeded: number;
  totalPnlCents: number;
}

const state: BotState = {
  running: false,
  startedAt: null,
  marketsScanned: 0,
  tradesAttempted: 0,
  tradesSucceeded: 0,
  totalPnlCents: 0,
};

let scanTimer: NodeJS.Timeout | null = null;
let sellTimer: NodeJS.Timeout | null = null;

// ─── Kalshi signing helper ───────────────────────────────────────────────────
function signRequest(method: string, path: string, timestampMs: number): string {
  const msgParts = [String(timestampMs), method.toUpperCase(), path];
  const msg = msgParts.join("");
  const key = crypto.createPrivateKey({ key: PRIVATE_KEY_PEM, format: "pem" });
  const sig = crypto.sign("sha256", Buffer.from(msg), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString("base64");
}

async function kalshiFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const ts = Date.now();
  const sig = signRequest(method, path, ts);
  const url = `${KALSHI_BASE}${path}`;
  const headers: Record<string, string> = {
    "KALSHI-ACCESS-KEY": API_KEY_ID,
    "KALSHI-ACCESS-SIGNATURE": sig,
    "KALSHI-ACCESS-TIMESTAMP": String(ts),
    "Content-Type": "application/json",
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Fee calculation ─────────────────────────────────────────────────────────
// Kalshi charges a fee on winnings. For a YES contract bought at P cents:
//   Cost = P cents per contract
//   Payout if wins = 100 cents
//   Gross profit = (100 - P)
//   Fee = floor(KALSHI_FEE_RATE * gross_profit) cents
//   Net profit = gross_profit - fee
function calcNetProfitCents(buyPriceCents: number, contracts: number): number {
  const grossProfit = (100 - buyPriceCents) * contracts;
  const fee = Math.floor(KALSHI_FEE_RATE * grossProfit);
  return grossProfit - fee;
}

function calcFeeCents(buyPriceCents: number, contracts: number): number {
  const grossProfit = (100 - buyPriceCents) * contracts;
  return Math.floor(KALSHI_FEE_RATE * grossProfit);
}

// ─── Logging helpers ─────────────────────────────────────────────────────────
async function botLog(level: string, message: string, data?: unknown): Promise<void> {
  logger.info({ level, message, data }, "bot");
  try {
    await db.insert(botLogsTable).values({
      level,
      message,
      data: data ? JSON.stringify(data) : null,
    });
  } catch (_) {
    // non-fatal
  }
}

// ─── Core scanning logic ─────────────────────────────────────────────────────
async function scanMarkets(): Promise<void> {
  try {
    // Fetch active 15-minute markets
    const resp = await kalshiFetch("GET", "/markets?status=open&series_ticker=KXBTC&limit=100") as Record<string, unknown>;
    // Try a broader search for short-duration markets
    const markets15 = await fetchActiveShortMarkets();
    state.marketsScanned += markets15.length;

    for (const market of markets15) {
      await evaluateMarket(market);
    }
  } catch (err) {
    await botLog("error", "Market scan failed", String(err));
  }
}

async function fetchActiveShortMarkets(): Promise<KalshiMarket[]> {
  // Fetch open markets and filter for ~15 min duration
  const resp = await kalshiFetch("GET", "/markets?status=open&limit=200") as { markets?: KalshiMarket[] };
  const markets = resp.markets ?? [];

  const now = Date.now();
  return markets.filter((m) => {
    if (!m.close_time) return false;
    const closeMs = new Date(m.close_time).getTime();
    const minutesLeft = (closeMs - now) / 60_000;
    // Only trade markets with > 10 min remaining
    if (minutesLeft <= MIN_MINUTES_REMAINING) return false;
    // Only trade markets closing within 15 min (15-min markets with time left)
    if (minutesLeft > 16) return false;
    return true;
  });
}

interface KalshiMarket {
  ticker: string;
  title: string;
  close_time: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  volume?: number;
}

async function evaluateMarket(market: KalshiMarket): Promise<void> {
  const { ticker, title, close_time } = market;

  const now = Date.now();
  const closeMs = new Date(close_time).getTime();
  const minutesLeft = (closeMs - now) / 60_000;

  // Hard gate: skip if 10 minutes or less remain
  if (minutesLeft <= MIN_MINUTES_REMAINING) {
    return;
  }

  // Get live orderbook
  let book: { yes?: { bid?: number; ask?: number } } = {};
  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    const m = resp.market ?? market;

    const yesBid = (m.yes_bid ?? 0);
    const yesAsk = (m.yes_ask ?? 0);

    if (!yesBid || !yesAsk || yesAsk >= 99) return;

    const spreadCents = yesAsk - yesBid;

    // Spread must be within our target range
    if (spreadCents < MIN_EDGE_CENTS || spreadCents > MAX_EDGE_CENTS) return;

    // How many contracts can we buy for <= MAX_BET_CENTS?
    const contracts = Math.floor(MAX_BET_CENTS / yesAsk);
    if (contracts < 1) return;

    const buyCost = yesAsk * contracts;
    const netProfit = calcNetProfitCents(yesAsk, contracts);
    const feeCents = calcFeeCents(yesAsk, contracts);

    // Only enter if net profit after fees is positive
    if (netProfit <= 0) return;

    await botLog("info", `Opportunity: ${title} — buy YES at ${yesAsk}¢, spread ${spreadCents}¢, net profit ${netProfit}¢ after fees`, {
      ticker, yesAsk, yesBid, spreadCents, contracts, buyCost, netProfit, feeCents, minutesLeft,
    });

    state.tradesAttempted++;
    await placeTrade(ticker, title, "YES", yesAsk, contracts, feeCents, minutesLeft);
  } catch (err) {
    await botLog("warn", `Failed to evaluate ${ticker}`, String(err));
  }
}

async function placeTrade(
  ticker: string,
  title: string,
  side: string,
  buyPriceCents: number,
  contracts: number,
  feeCents: number,
  minutesRemaining: number,
): Promise<void> {
  try {
    // Place limit buy order
    const order = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `scalp-${Date.now()}`,
      type: "limit",
      action: "buy",
      side: side.toLowerCase(),
      count: contracts,
      yes_price: side === "YES" ? buyPriceCents : undefined,
      no_price: side === "NO" ? buyPriceCents : undefined,
    }) as { order?: { order_id?: string } };

    const orderId = order?.order?.order_id;

    const [trade] = await db.insert(tradesTable).values({
      marketId: ticker,
      marketTitle: title,
      side,
      buyPriceCents,
      contractCount: contracts,
      feeCents,
      status: "open",
      kalshiBuyOrderId: orderId,
      minutesRemaining,
    }).returning();

    state.tradesSucceeded++;
    await botLog("info", `Buy order placed: ${contracts}x YES on ${title} at ${buyPriceCents}¢ (order: ${orderId})`, { tradeId: trade.id });

    // Immediately try to place a sell order at ask price to scalp
    setTimeout(() => trySellPosition(trade.id, ticker, side, buyPriceCents, contracts), 3000);
  } catch (err) {
    await botLog("error", `Failed to place buy order for ${ticker}`, String(err));
    state.tradesAttempted = Math.max(0, state.tradesAttempted - 1);
  }
}

async function trySellPosition(tradeId: number, ticker: string, side: string, buyPriceCents: number, contracts: number): Promise<void> {
  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    const m = resp.market;
    if (!m) return;

    const yesBid = m.yes_bid ?? 0;
    const sellPriceCents = side === "YES" ? yesBid : (m.no_bid ?? 0);

    if (sellPriceCents <= buyPriceCents) {
      // Price hasn't moved, wait
      return;
    }

    // Place sell order
    const order = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `scalp-sell-${Date.now()}`,
      type: "limit",
      action: "sell",
      side: side.toLowerCase(),
      count: contracts,
      yes_price: side === "YES" ? sellPriceCents : undefined,
      no_price: side === "NO" ? sellPriceCents : undefined,
    }) as { order?: { order_id?: string } };

    const sellOrderId = order?.order?.order_id;

    // Calculate actual P&L: (sellPrice - buyPrice) * contracts - fees
    const grossProfit = (sellPriceCents - buyPriceCents) * contracts;
    // Selling back: seller pays no fee on sell, fee was on buy side
    const feeCents = calcFeeCents(buyPriceCents, contracts);
    const pnlCents = grossProfit - feeCents;

    await db.update(tradesTable).set({
      sellPriceCents,
      pnlCents,
      status: "closed",
      kalshiSellOrderId: sellOrderId,
      closedAt: new Date(),
    }).where(eq(tradesTable.id, tradeId));

    state.totalPnlCents += pnlCents;

    await botLog(
      pnlCents >= 0 ? "info" : "warn",
      `Sold ${contracts}x ${side} on ${ticker} at ${sellPriceCents}¢, P&L: ${pnlCents >= 0 ? "+" : ""}${pnlCents}¢`,
      { tradeId, sellPriceCents, pnlCents },
    );
  } catch (err) {
    await botLog("warn", `Failed to sell position ${tradeId}`, String(err));
  }
}

// ─── Retry selling open positions ────────────────────────────────────────────
async function retryOpenPositions(): Promise<void> {
  try {
    const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    for (const trade of openTrades) {
      const now = Date.now();
      const tradeAge = now - trade.createdAt.getTime();

      // If trade is older than 12 minutes, mark expired (market closed on us)
      if (tradeAge > 12 * 60_000) {
        await db.update(tradesTable).set({
          status: "expired",
          pnlCents: -(trade.buyPriceCents * trade.contractCount),
          closedAt: new Date(),
        }).where(eq(tradesTable.id, trade.id));

        state.totalPnlCents -= trade.buyPriceCents * trade.contractCount;
        await botLog("warn", `Trade ${trade.id} expired without selling — loss of ${trade.buyPriceCents * trade.contractCount}¢`);
        continue;
      }

      await trySellPosition(trade.id, trade.marketId, trade.side, trade.buyPriceCents, trade.contractCount);
    }
  } catch (err) {
    logger.error({ err }, "retryOpenPositions failed");
  }
}

// ─── Public bot controls ─────────────────────────────────────────────────────
export function getBotState(): BotState {
  return { ...state };
}

export async function startBot(): Promise<BotState> {
  if (state.running) return getBotState();

  if (!API_KEY_ID || !PRIVATE_KEY_PEM) {
    throw new Error("KALSHI_API_KEY and KALSHI_PRIVATE_KEY must be set");
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.marketsScanned = 0;
  state.tradesAttempted = 0;
  state.tradesSucceeded = 0;

  await botLog("info", "Bot started — scanning 15-minute Kalshi markets (skip if ≤10 min remain, max bet 59¢)");

  // Immediate first scan
  scanMarkets();

  scanTimer = setInterval(scanMarkets, POLL_INTERVAL_MS);
  sellTimer = setInterval(retryOpenPositions, SELL_RETRY_MS);

  return getBotState();
}

export async function stopBot(): Promise<BotState> {
  if (!state.running) return getBotState();

  state.running = false;

  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }

  await botLog("info", `Bot stopped. Total P&L: ${state.totalPnlCents}¢`);

  return getBotState();
}
