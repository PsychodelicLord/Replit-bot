import crypto from "crypto";
import { db, tradesTable, botLogsTable } from "@workspace/db";
import { logger } from "./logger";
import { eq } from "drizzle-orm";

// ─── Kalshi API config ───────────────────────────────────────────────────────
const KALSHI_BASE = "https://trading-api.kalshi.com/trade-api/v2";
const API_KEY_ID = process.env.KALSHI_API_KEY ?? "";
const PRIVATE_KEY_PEM = (process.env.KALSHI_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

// ─── Live-editable bot config ────────────────────────────────────────────────
export interface BotConfig {
  maxEntryPriceCents: number;   // Enter if ask ≤ this value (cents)
  minNetProfitCents: number;    // Exit when net profit ≥ this (cents, after fees)
  maxNetProfitCents: number;    // Upper bound for target profit range (cents)
  minMinutesRemaining: number;  // Skip market if ≤ this many minutes left
  feeRate: number;              // Kalshi fee rate on profit (0.07 = 7%)
  pollIntervalSecs: number;     // How often to scan markets (seconds)
}

export const botConfig: BotConfig = {
  maxEntryPriceCents: 59,
  minNetProfitCents: 5,
  maxNetProfitCents: 25,
  minMinutesRemaining: 10,
  feeRate: 0.07,
  pollIntervalSecs: 20,
};

export function updateBotConfig(updates: Partial<BotConfig>): BotConfig {
  Object.assign(botConfig, updates);
  return { ...botConfig };
}

export function getBotConfig(): BotConfig {
  return { ...botConfig };
}

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

// Track markets we already have an open position in to avoid doubling up
const openMarkets = new Set<string>();

let scanTimer: NodeJS.Timeout | null = null;
let sellTimer: NodeJS.Timeout | null = null;

// ─── Kalshi signing helper ───────────────────────────────────────────────────
function signRequest(method: string, path: string, timestampMs: number): string {
  const msg = `${timestampMs}${method.toUpperCase()}${path}`;
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
  const res = await fetch(`${KALSHI_BASE}${path}`, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": API_KEY_ID,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": String(ts),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Fee & profit helpers ────────────────────────────────────────────────────
// When you buy a YES contract at buyPrice and sell at sellPrice:
//   Gross profit = sellPrice - buyPrice (per contract)
//   Kalshi fee   = floor(KALSHI_FEE_RATE * gross_profit)
//   Net profit   = gross_profit - fee

function grossToNet(grossProfitCents: number): number {
  const fee = Math.floor(botConfig.feeRate * grossProfitCents);
  return grossProfitCents - fee;
}

function netToRequiredGross(netTargetCents: number): number {
  return Math.ceil(netTargetCents / (1 - botConfig.feeRate));
}

function calcTargetSellPrice(buyPriceCents: number): number {
  return buyPriceCents + netToRequiredGross(botConfig.minNetProfitCents);
}

// ─── Logging helper ──────────────────────────────────────────────────────────
async function botLog(level: string, message: string, data?: unknown): Promise<void> {
  logger.info({ level, botMessage: message }, "bot-log");
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

// ─── Market types ────────────────────────────────────────────────────────────
interface KalshiMarket {
  ticker: string;
  title: string;
  close_time: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
}

// ─── Scan markets for entry opportunities ────────────────────────────────────
async function scanMarkets(): Promise<void> {
  try {
    const resp = await kalshiFetch("GET", "/markets?status=open&limit=200") as { markets?: KalshiMarket[] };
    const markets = resp.markets ?? [];

    const now = Date.now();
    // Filter to 15-minute markets with > 10 min remaining
    const eligible = markets.filter((m) => {
      if (!m.close_time) return false;
      const minutesLeft = (new Date(m.close_time).getTime() - now) / 60_000;
      return minutesLeft > botConfig.minMinutesRemaining && minutesLeft <= 16;
    });

    state.marketsScanned += eligible.length;

    for (const market of eligible) {
      if (!state.running) break;
      await evaluateMarket(market);
    }
  } catch (err) {
    await botLog("error", "Market scan failed", String(err));
  }
}

async function evaluateMarket(market: KalshiMarket): Promise<void> {
  const { ticker, title, close_time } = market;

  // Double-check time gate
  const minutesLeft = (new Date(close_time).getTime() - Date.now()) / 60_000;
  if (minutesLeft <= botConfig.minMinutesRemaining) return;

  // Skip if we already have an open position in this market
  if (openMarkets.has(ticker)) return;

  try {
    // Fetch latest market data for fresh prices
    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    const m = resp.market ?? market;

    const yesAsk = m.yes_ask ?? 0;
    const noAsk = m.no_ask ?? 0;
    const { maxEntryPriceCents, minNetProfitCents } = botConfig;

    // Check YES side: enter if ask ≤ maxEntryPriceCents
    if (yesAsk > 0 && yesAsk <= maxEntryPriceCents) {
      const targetSell = calcTargetSellPrice(yesAsk);
      const maxNet = grossToNet((maxEntryPriceCents + 1) - yesAsk);
      if (targetSell < 100 && maxNet >= minNetProfitCents) {
        await botLog("info", `Entry signal: ${title} — buy YES at ${yesAsk}¢, target sell ${targetSell}¢ (≥${minNetProfitCents}¢ net)`, {
          ticker, yesAsk, targetSell, minutesLeft: minutesLeft.toFixed(1),
        });
        state.tradesAttempted++;
        await enterTrade(ticker, title, "YES", yesAsk, targetSell, minutesLeft);
        return; // one trade per market per scan
      }
    }

    // Check NO side: enter if no_ask ≤ maxEntryPriceCents
    if (noAsk > 0 && noAsk <= maxEntryPriceCents) {
      const targetSell = calcTargetSellPrice(noAsk);
      const maxNet = grossToNet((maxEntryPriceCents + 1) - noAsk);
      if (targetSell < 100 && maxNet >= minNetProfitCents) {
        await botLog("info", `Entry signal: ${title} — buy NO at ${noAsk}¢, target sell ${targetSell}¢ (≥${minNetProfitCents}¢ net)`, {
          ticker, noAsk, targetSell, minutesLeft: minutesLeft.toFixed(1),
        });
        state.tradesAttempted++;
        await enterTrade(ticker, title, "NO", noAsk, targetSell, minutesLeft);
      }
    }
  } catch (err) {
    await botLog("warn", `Failed to evaluate ${ticker}`, String(err));
  }
}

// ─── Enter a trade (buy 1 contract, immediately place limit sell) ─────────────
async function enterTrade(
  ticker: string,
  title: string,
  side: string,
  buyPriceCents: number,
  targetSellPrice: number,
  minutesRemaining: number,
): Promise<void> {
  const feeCents = Math.floor(KALSHI_FEE_RATE * (targetSellPrice - buyPriceCents));

  try {
    // Place limit buy for 1 contract
    const buyResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `scalp-buy-${Date.now()}`,
      type: "limit",
      action: "buy",
      side: side.toLowerCase(),
      count: 1,
      ...(side === "YES" ? { yes_price: buyPriceCents } : { no_price: buyPriceCents }),
    }) as { order?: { order_id?: string } };

    const buyOrderId = buyResp?.order?.order_id;

    // Save trade record
    const [trade] = await db.insert(tradesTable).values({
      marketId: ticker,
      marketTitle: title,
      side,
      buyPriceCents,
      contractCount: 1,
      feeCents,
      status: "open",
      kalshiBuyOrderId: buyOrderId,
      minutesRemaining,
    }).returning();

    openMarkets.add(ticker);
    state.tradesSucceeded++;

    await botLog("info",
      `✅ Bought 1x ${side} on "${title}" at ${buyPriceCents}¢ — sell target: ${targetSellPrice}¢ → net profit ≥${MIN_NET_PROFIT_CENTS}¢`,
      { tradeId: trade.id, buyOrderId, targetSellPrice },
    );

    // Place limit sell immediately at target price
    setTimeout(() => placeLimitSell(trade.id, ticker, side, buyPriceCents, targetSellPrice, 1), 2000);
  } catch (err) {
    await botLog("error", `Failed to enter trade on ${ticker}`, String(err));
    state.tradesAttempted = Math.max(0, state.tradesAttempted - 1);
  }
}

// ─── Place a limit sell order at the target price ────────────────────────────
async function placeLimitSell(
  tradeId: number,
  ticker: string,
  side: string,
  buyPriceCents: number,
  sellPriceCents: number,
  contracts: number,
): Promise<void> {
  try {
    const sellResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `scalp-sell-${Date.now()}`,
      type: "limit",
      action: "sell",
      side: side.toLowerCase(),
      count: contracts,
      ...(side === "YES" ? { yes_price: sellPriceCents } : { no_price: sellPriceCents }),
    }) as { order?: { order_id?: string } };

    const sellOrderId = sellResp?.order?.order_id;
    const grossProfit = (sellPriceCents - buyPriceCents) * contracts;
    const fee = Math.floor(KALSHI_FEE_RATE * grossProfit);
    const netPnl = grossProfit - fee;

    await db.update(tradesTable).set({
      sellPriceCents,
      pnlCents: netPnl,
      feeCents: fee,
      status: "closed",
      kalshiSellOrderId: sellOrderId,
      closedAt: new Date(),
    }).where(eq(tradesTable.id, tradeId));

    openMarkets.delete(ticker);
    state.totalPnlCents += netPnl;

    await botLog(
      netPnl > 0 ? "info" : "warn",
      `📤 Sold 1x ${side} on ${ticker} at ${sellPriceCents}¢ — net P&L: ${netPnl > 0 ? "+" : ""}${netPnl}¢ (fee: ${fee}¢)`,
      { tradeId, sellPriceCents, grossProfit, fee, netPnl },
    );
  } catch (err) {
    await botLog("warn", `Failed to place limit sell for trade ${tradeId}`, String(err));
    // Will retry via the open-position poller
  }
}

// ─── Retry open positions: check current price and sell if profitable ─────────
async function retryOpenPositions(): Promise<void> {
  try {
    const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));

    for (const trade of openTrades) {
      const tradeAgeMs = Date.now() - trade.createdAt.getTime();

      // If older than 13 minutes, the market likely closed — record as expired
      if (tradeAgeMs > 13 * 60_000) {
        await db.update(tradesTable).set({
          status: "expired",
          pnlCents: -trade.buyPriceCents,
          closedAt: new Date(),
        }).where(eq(tradesTable.id, trade.id));

        openMarkets.delete(trade.marketId);
        state.totalPnlCents -= trade.buyPriceCents;
        await botLog("warn",
          `⚠️ Trade ${trade.id} expired without exit — lost ${trade.buyPriceCents}¢`,
          { tradeId: trade.id },
        );
        continue;
      }

      // Check current market price
      try {
        const resp = await kalshiFetch("GET", `/markets/${trade.marketId}`) as { market?: KalshiMarket };
        const m = resp.market;
        if (!m) continue;

        const currentBid = trade.side === "YES" ? (m.yes_bid ?? 0) : (m.no_bid ?? 0);
        const grossProfit = currentBid - trade.buyPriceCents;
        const netProfit = grossToNet(grossProfit);

        // Exit if net profit has reached the minimum target
        if (netProfit >= botConfig.minNetProfitCents) {
          await botLog("info",
            `🎯 Price hit target for trade ${trade.id}: bid ${currentBid}¢, net profit ${netProfit}¢ — exiting`,
            { tradeId: trade.id, currentBid, netProfit },
          );
          await placeLimitSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, currentBid, trade.contractCount);
        }
      } catch (err) {
        await botLog("warn", `Failed to check position ${trade.id}`, String(err));
      }
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

  await botLog("info",
    "🤖 Bot started — enter if YES/NO ask ≤59¢ with >10 min left; exit at 5–25¢ net profit after 7% fee",
  );

  scanMarkets();
  scanTimer = setInterval(scanMarkets, botConfig.pollIntervalSecs * 1000);
  sellTimer = setInterval(retryOpenPositions, 8_000);

  return getBotState();
}

export async function stopBot(): Promise<BotState> {
  if (!state.running) return getBotState();

  state.running = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }

  await botLog("info", `🛑 Bot stopped. Session P&L: ${state.totalPnlCents > 0 ? "+" : ""}${state.totalPnlCents}¢`);
  return getBotState();
}
