import crypto from "crypto";
import { db, tradesTable, botLogsTable } from "@workspace/db";
import { logger } from "./logger";
import { eq, gte, sql } from "drizzle-orm";

// ─── Kalshi API config ───────────────────────────────────────────────────────
const KALSHI_BASE = "https://trading-api.kalshi.com/trade-api/v2";
const API_KEY_ID = process.env.KALSHI_API_KEY ?? "";
const PRIVATE_KEY_PEM = (process.env.KALSHI_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

// ─── Crypto series ticker prefixes ───────────────────────────────────────────
const CRYPTO_COIN_SERIES: Record<string, string[]> = {
  BTC:  ["KXBTC", "BTCUSD"],
  ETH:  ["KXETH", "ETHUSD"],
  SOL:  ["KXSOL", "SOLUSD"],
  DOGE: ["KXDOGE", "DOGEUSD"],
  XRP:  ["KXXRP", "XRPUSD"],
  ADA:  ["KXADA", "ADAUSD"],
  MATIC:["KXMATIC","MATICUSD"],
};

const SPORTS_KEYWORDS = ["NFL", "NBA", "MLB", "NHL", "NCAAB", "NCAAF", "MLS", "EPL", "FIFA", "UEFA", "tennis", "golf"];

// ─── Live-editable bot config ────────────────────────────────────────────────
export interface BotConfig {
  maxEntryPriceCents: number;
  minNetProfitCents: number;
  maxNetProfitCents: number;
  minMinutesRemaining: number;
  feeRate: number;
  pollIntervalSecs: number;
  marketCategories: string[];   // ["crypto"], ["sports"], ["crypto","sports"] = all
  cryptoCoins: string[];        // ["BTC","ETH","SOL",...]
  maxOpenPositions: number;
  balanceFloorCents: number;    // 0 = disabled
  dailyProfitTargetCents: number; // 0 = disabled
  dailyLossLimitCents: number;    // 0 = disabled
}

export const botConfig: BotConfig = {
  maxEntryPriceCents: 59,
  minNetProfitCents: 5,
  maxNetProfitCents: 25,
  minMinutesRemaining: 10,
  feeRate: 0.07,
  pollIntervalSecs: 20,
  marketCategories: ["crypto", "sports"],
  cryptoCoins: ["BTC", "ETH", "SOL", "DOGE"],
  maxOpenPositions: 3,
  balanceFloorCents: 0,
  dailyProfitTargetCents: 0,
  dailyLossLimitCents: 0,
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
  dailyPnlCents: number;
  openPositionCount: number;
  balanceCents: number;
  stoppedReason: string | null;
}

const state: BotState = {
  running: false,
  startedAt: null,
  marketsScanned: 0,
  tradesAttempted: 0,
  tradesSucceeded: 0,
  totalPnlCents: 0,
  dailyPnlCents: 0,
  openPositionCount: 0,
  balanceCents: 0,
  stoppedReason: null,
};

const openMarkets = new Set<string>();

let scanTimer: NodeJS.Timeout | null = null;
let sellTimer: NodeJS.Timeout | null = null;
let balanceTimer: NodeJS.Timeout | null = null;

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

// ─── Market category detection ───────────────────────────────────────────────
function isCryptoMarket(ticker: string, title: string): boolean {
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  for (const [, prefixes] of Object.entries(CRYPTO_COIN_SERIES)) {
    if (prefixes.some(p => upper.includes(p.toUpperCase()))) return true;
  }
  return false;
}

function matchesCryptoCoin(ticker: string, title: string, coins: string[]): boolean {
  if (coins.length === 0) return true;
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  return coins.some(coin => {
    const prefixes = CRYPTO_COIN_SERIES[coin.toUpperCase()] ?? [coin];
    return prefixes.some(p => upper.includes(p.toUpperCase()));
  });
}

function isSportsMarket(ticker: string, title: string): boolean {
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  return SPORTS_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()));
}

function marketPassesCategoryFilter(ticker: string, title: string): boolean {
  const cats = botConfig.marketCategories;
  if (cats.length === 0) return true;

  const wantsCrypto = cats.includes("crypto");
  const wantsSports = cats.includes("sports");

  if (wantsCrypto && isCryptoMarket(ticker, title)) {
    return matchesCryptoCoin(ticker, title, botConfig.cryptoCoins);
  }
  if (wantsSports && isSportsMarket(ticker, title)) return true;

  // If neither crypto nor sports, allow non-categorized if both are selected (treat as "all")
  if (wantsCrypto && wantsSports && !isCryptoMarket(ticker, title) && !isSportsMarket(ticker, title)) {
    return true;
  }

  return false;
}

// ─── Fee & profit helpers ────────────────────────────────────────────────────
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

// ─── Fetch and update account balance ────────────────────────────────────────
async function refreshBalance(): Promise<void> {
  try {
    const resp = await kalshiFetch("GET", "/portfolio/balance") as { balance?: { balance?: number } };
    const balanceDollars = resp?.balance?.balance ?? 0;
    state.balanceCents = Math.round(balanceDollars * 100);
  } catch (_) {
    // non-fatal; keep last known value
  }
}

// ─── Daily P&L from DB ───────────────────────────────────────────────────────
async function refreshDailyPnl(): Promise<void> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const result = await db
      .select({ total: sql<number>`coalesce(sum(${tradesTable.pnlCents}), 0)` })
      .from(tradesTable)
      .where(gte(tradesTable.closedAt, todayStart));
    state.dailyPnlCents = Number(result[0]?.total ?? 0);
  } catch (_) {
    // non-fatal
  }
}

// ─── Safety checks ───────────────────────────────────────────────────────────
async function checkSafetyLimits(): Promise<boolean> {
  await refreshBalance();
  await refreshDailyPnl();

  const { balanceFloorCents, dailyProfitTargetCents, dailyLossLimitCents } = botConfig;

  if (balanceFloorCents > 0 && state.balanceCents > 0 && state.balanceCents <= balanceFloorCents) {
    const reason = `Balance floor hit — balance $${(state.balanceCents / 100).toFixed(2)} ≤ floor $${(balanceFloorCents / 100).toFixed(2)}`;
    await botLog("warn", `🛑 Auto-stop: ${reason}`);
    await stopBot(reason);
    return false;
  }

  if (dailyProfitTargetCents > 0 && state.dailyPnlCents >= dailyProfitTargetCents) {
    const reason = `Daily profit target reached — +$${(state.dailyPnlCents / 100).toFixed(2)}`;
    await botLog("info", `🎉 Auto-stop: ${reason}`);
    await stopBot(reason);
    return false;
  }

  if (dailyLossLimitCents > 0 && state.dailyPnlCents <= -dailyLossLimitCents) {
    const reason = `Daily loss limit hit — -$${(Math.abs(state.dailyPnlCents) / 100).toFixed(2)}`;
    await botLog("warn", `🛑 Auto-stop: ${reason}`);
    await stopBot(reason);
    return false;
  }

  return true;
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
  if (!state.running) return;

  const safe = await checkSafetyLimits();
  if (!safe) return;

  // Check max open positions
  state.openPositionCount = openMarkets.size;
  if (openMarkets.size >= botConfig.maxOpenPositions) {
    await botLog("info", `Max open positions reached (${openMarkets.size}/${botConfig.maxOpenPositions}) — skipping scan`);
    return;
  }

  try {
    const resp = await kalshiFetch("GET", "/markets?status=open&limit=200") as { markets?: KalshiMarket[] };
    const markets = resp.markets ?? [];

    const now = Date.now();
    const eligible = markets.filter((m) => {
      if (!m.close_time) return false;
      const minutesLeft = (new Date(m.close_time).getTime() - now) / 60_000;
      if (minutesLeft <= botConfig.minMinutesRemaining || minutesLeft > 16) return false;
      return marketPassesCategoryFilter(m.ticker, m.title);
    });

    state.marketsScanned += eligible.length;

    for (const market of eligible) {
      if (!state.running) break;
      if (openMarkets.size >= botConfig.maxOpenPositions) break;
      await evaluateMarket(market);
    }
  } catch (err) {
    await botLog("error", "Market scan failed", String(err));
  }
}

async function evaluateMarket(market: KalshiMarket): Promise<void> {
  const { ticker, title, close_time } = market;

  const minutesLeft = (new Date(close_time).getTime() - Date.now()) / 60_000;
  if (minutesLeft <= botConfig.minMinutesRemaining) return;

  if (openMarkets.has(ticker)) return;

  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    const m = resp.market ?? market;

    const yesAsk = m.yes_ask ?? 0;
    const noAsk = m.no_ask ?? 0;
    const { maxEntryPriceCents, minNetProfitCents } = botConfig;

    if (yesAsk > 0 && yesAsk <= maxEntryPriceCents) {
      const targetSell = calcTargetSellPrice(yesAsk);
      const maxNet = grossToNet((maxEntryPriceCents + 1) - yesAsk);
      if (targetSell < 100 && maxNet >= minNetProfitCents) {
        await botLog("info", `Entry signal: ${title} — buy YES at ${yesAsk}¢, target sell ${targetSell}¢`, {
          ticker, yesAsk, targetSell, minutesLeft: minutesLeft.toFixed(1),
        });
        state.tradesAttempted++;
        await enterTrade(ticker, title, "YES", yesAsk, targetSell, minutesLeft);
        return;
      }
    }

    if (noAsk > 0 && noAsk <= maxEntryPriceCents) {
      const targetSell = calcTargetSellPrice(noAsk);
      const maxNet = grossToNet((maxEntryPriceCents + 1) - noAsk);
      if (targetSell < 100 && maxNet >= minNetProfitCents) {
        await botLog("info", `Entry signal: ${title} — buy NO at ${noAsk}¢, target sell ${targetSell}¢`, {
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

// ─── Enter a trade ────────────────────────────────────────────────────────────
async function enterTrade(
  ticker: string,
  title: string,
  side: string,
  buyPriceCents: number,
  targetSellPrice: number,
  minutesRemaining: number,
): Promise<void> {
  const feeCents = Math.floor(botConfig.feeRate * (targetSellPrice - buyPriceCents));

  try {
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
    state.openPositionCount = openMarkets.size;
    state.tradesSucceeded++;

    await botLog("info",
      `✅ Bought 1x ${side} on "${title}" at ${buyPriceCents}¢ — target sell: ${targetSellPrice}¢`,
      { tradeId: trade.id, buyOrderId, targetSellPrice },
    );

    setTimeout(() => placeLimitSell(trade.id, ticker, side, buyPriceCents, targetSellPrice, 1), 2000);
  } catch (err) {
    await botLog("error", `Failed to enter trade on ${ticker}`, String(err));
    state.tradesAttempted = Math.max(0, state.tradesAttempted - 1);
  }
}

// ─── Place a limit sell ───────────────────────────────────────────────────────
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
    const fee = Math.floor(botConfig.feeRate * grossProfit);
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
    state.openPositionCount = openMarkets.size;
    state.totalPnlCents += netPnl;
    state.dailyPnlCents += netPnl;

    await botLog(
      netPnl > 0 ? "info" : "warn",
      `📤 Sold 1x ${side} on ${ticker} at ${sellPriceCents}¢ — net P&L: ${netPnl > 0 ? "+" : ""}${netPnl}¢ (fee: ${fee}¢)`,
      { tradeId, sellPriceCents, grossProfit, fee, netPnl },
    );
  } catch (err) {
    await botLog("warn", `Failed to place limit sell for trade ${tradeId}`, String(err));
  }
}

// ─── Retry open positions ─────────────────────────────────────────────────────
async function retryOpenPositions(): Promise<void> {
  try {
    const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    state.openPositionCount = openTrades.length;

    for (const trade of openTrades) {
      const tradeAgeMs = Date.now() - trade.createdAt.getTime();

      if (tradeAgeMs > 13 * 60_000) {
        await db.update(tradesTable).set({
          status: "expired",
          pnlCents: -trade.buyPriceCents,
          closedAt: new Date(),
        }).where(eq(tradesTable.id, trade.id));

        openMarkets.delete(trade.marketId);
        state.openPositionCount = openMarkets.size;
        state.totalPnlCents -= trade.buyPriceCents;
        state.dailyPnlCents -= trade.buyPriceCents;
        await botLog("warn",
          `⚠️ Trade ${trade.id} expired without exit — lost ${trade.buyPriceCents}¢`,
          { tradeId: trade.id },
        );
        continue;
      }

      try {
        const resp = await kalshiFetch("GET", `/markets/${trade.marketId}`) as { market?: KalshiMarket };
        const m = resp.market;
        if (!m) continue;

        const currentBid = trade.side === "YES" ? (m.yes_bid ?? 0) : (m.no_bid ?? 0);
        const grossProfit = currentBid - trade.buyPriceCents;
        const netProfit = grossToNet(grossProfit);

        if (netProfit >= botConfig.minNetProfitCents) {
          await botLog("info",
            `🎯 Target hit for trade ${trade.id}: bid ${currentBid}¢, net profit ${netProfit}¢ — exiting`,
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
  state.stoppedReason = null;

  await refreshBalance();
  await refreshDailyPnl();

  const cats = botConfig.marketCategories.join("+");
  await botLog("info",
    `🤖 Instinct Scalper started — trading ${cats} | entry ≤${botConfig.maxEntryPriceCents}¢ | target ${botConfig.minNetProfitCents}–${botConfig.maxNetProfitCents}¢ net | max ${botConfig.maxOpenPositions} positions`,
  );

  scanMarkets();
  scanTimer = setInterval(scanMarkets, botConfig.pollIntervalSecs * 1000);
  sellTimer = setInterval(retryOpenPositions, 8_000);
  balanceTimer = setInterval(refreshBalance, 60_000);

  return getBotState();
}

export async function stopBot(reason?: string): Promise<BotState> {
  if (!state.running) return getBotState();

  state.running = false;
  state.stoppedReason = reason ?? null;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }
  if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null; }

  await botLog("info", `🛑 Bot stopped${reason ? ": " + reason : ""}. Daily P&L: ${state.dailyPnlCents > 0 ? "+" : ""}${state.dailyPnlCents}¢`);
  return getBotState();
}
