import crypto from "crypto";
import { db, tradesTable, botLogsTable } from "@workspace/db";
import { logger } from "./logger";
import { eq, gte, sql } from "drizzle-orm";

// ─── Kalshi API config ───────────────────────────────────────────────────────
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const API_KEY_ID = process.env.KALSHI_API_KEY ?? "";

function normalizePrivateKey(raw: string): string {
  // Replace literal \n sequences with real newlines
  let pem = raw.replace(/\\n/g, "\n");

  // If it looks like it has no newlines at all and contains PEM markers,
  // split the base64 body into 64-char lines
  if (!pem.includes("\n") && pem.includes("-----")) {
    const beginMatch = pem.match(/(-----BEGIN [^-]+-----)/);
    const endMatch   = pem.match(/(-----END [^-]+-----)/);
    if (beginMatch && endMatch) {
      const begin = beginMatch[1];
      const end   = endMatch[1];
      const b64   = pem.slice(begin.length, pem.indexOf(end)).replace(/\s/g, "");
      const lines = b64.match(/.{1,64}/g) ?? [];
      pem = `${begin}\n${lines.join("\n")}\n${end}`;
    }
  }

  // If the secret is raw base64 (no PEM headers), wrap it as PKCS8
  if (!pem.includes("-----BEGIN")) {
    const b64    = pem.replace(/\s/g, "");
    const lines  = b64.match(/.{1,64}/g) ?? [];
    pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }

  return pem.trim();
}

const PRIVATE_KEY_PEM = normalizePrivateKey(process.env.KALSHI_PRIVATE_KEY ?? "");

function loadPrivateKey(): crypto.KeyObject {
  // Try PKCS8 first (-----BEGIN PRIVATE KEY-----), then PKCS1 (-----BEGIN RSA PRIVATE KEY-----)
  const types: Array<"pkcs8" | "pkcs1"> = ["pkcs8", "pkcs1"];
  for (const type of types) {
    try {
      return crypto.createPrivateKey({ key: PRIVATE_KEY_PEM, format: "pem", type });
    } catch (_) {
      // try next type
    }
  }
  // Final fallback — let Node auto-detect
  return crypto.createPrivateKey({ key: PRIVATE_KEY_PEM, format: "pem" });
}

// ─── Crypto series ticker prefixes ───────────────────────────────────────────
const CRYPTO_COIN_SERIES: Record<string, string[]> = {
  BTC:  ["KXBTC15M"],
  ETH:  ["KXETH15M"],
  SOL:  ["KXSOL15M"],
  DOGE: ["KXDOGE15M"],
  XRP:  ["KXXRP15M"],
  ADA:  ["KXADA15M"],
  MATIC:["KXMATIC15M"],
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
  maxNetProfitCents: 99,
  minMinutesRemaining: 10,
  feeRate: 0.07,
  pollIntervalSecs: 5,
  marketCategories: ["crypto", "sports"],
  cryptoCoins: ["BTC", "ETH", "SOL", "DOGE"],
  maxOpenPositions: 1,
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

// Trade mutex — only one trade entry can execute at a time (prevents race conditions)
let tradeMutex = false;

// Cache of tickers that had zero liquidity — skip expensive API calls for 20 seconds
const zeroPriceTs = new Map<string, number>();
const ZERO_SKIP_MS = 20_000;

// Throttle scan logs when nothing is eligible — log at most once every 30s
let lastIdleScanLogMs = 0;
const IDLE_LOG_INTERVAL_MS = 30_000;

let scanTimer: NodeJS.Timeout | null = null;
let sellTimer: NodeJS.Timeout | null = null;
let balanceTimer: NodeJS.Timeout | null = null;

// ─── Kalshi signing helper ───────────────────────────────────────────────────
// elections.kalshi.com requires the FULL path (including /trade-api/v2 prefix)
// in the signing message, with RSA-PSS SHA-256 at max salt length.
const KALSHI_PATH_PREFIX = "/trade-api/v2";

function signRequest(method: string, path: string, timestampMs: number): string {
  // Use full path in the signing message
  const fullPath = path.startsWith(KALSHI_PATH_PREFIX) ? path : `${KALSHI_PATH_PREFIX}${path}`;
  const msg = `${timestampMs}${method.toUpperCase()}${fullPath}`;
  const key = loadPrivateKey();
  const keyType = key.asymmetricKeyType ?? "";

  let sig: Buffer;
  if (keyType === "ed25519" || keyType === "ed448") {
    sig = crypto.sign(null, Buffer.from(msg), key);
  } else if (keyType === "ec") {
    sig = crypto.sign("sha256", Buffer.from(msg), key);
  } else {
    // RSA-PSS SHA-256 with max salt length — confirmed working with elections.kalshi.com
    sig = crypto.sign("sha256", Buffer.from(msg), {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: -2,
    });
  }
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

  // Only allow explicitly matched categories — weather/misc markets are rejected
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
  // Legacy cent fields (may be absent — Kalshi now returns _dollars variants)
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  // Dollar-unit fields (0.0–1.0 scale); multiply by 100 to get cents
  yes_ask_dollars?: number;
  yes_bid_dollars?: number;
  no_ask_dollars?: number;
  no_bid_dollars?: number;
  last_price_dollars?: number;
}

/** Read a price field from a market object, always returning integer cents.
 *  Handles both number and string values — Kalshi sometimes returns prices as strings.
 */
function priceCents(m: KalshiMarket, field: "yes_ask" | "yes_bid" | "no_ask" | "no_bid" | "last_price"): number {
  const rawDollars = (m as any)[`${field}_dollars`];
  if (rawDollars !== undefined && rawDollars !== null) {
    const v = typeof rawDollars === "number" ? rawDollars : parseFloat(String(rawDollars));
    if (!isNaN(v) && v > 0) return Math.round(v * 100);
  }
  const rawCents = (m as any)[field];
  if (rawCents !== undefined && rawCents !== null) {
    const v = typeof rawCents === "number" ? rawCents : parseFloat(String(rawCents));
    if (!isNaN(v) && v > 0) return Math.round(v);
  }
  return 0;
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
    const now = Date.now();
    // Ask Kalshi for markets closing within the next 20 minutes specifically
    const maxCloseTs = Math.floor((now + 20 * 60_000) / 1000);
    const baseUrl = `/markets?status=open&limit=200&max_close_ts=${maxCloseTs}`;

    const resp1 = await kalshiFetch("GET", baseUrl) as { markets?: KalshiMarket[]; cursor?: string };
    let markets = resp1.markets ?? [];

    // Paginate: if exactly 200 results came back there may be more (BTC/ETH could be on page 2)
    if (resp1.cursor && markets.length === 200) {
      try {
        const resp2 = await kalshiFetch(
          "GET",
          `${baseUrl}&cursor=${encodeURIComponent(resp1.cursor)}`
        ) as { markets?: KalshiMarket[] };
        markets = [...markets, ...(resp2.markets ?? [])];
      } catch (_) {
        // page 2 failed — continue with page 1 only
      }
    }

    const eligible = markets.filter((m) => {
      if (!m.close_time) return false;
      const minutesLeft = (new Date(m.close_time).getTime() - now) / 60_000;
      if (minutesLeft <= botConfig.minMinutesRemaining || minutesLeft > 16) return false;
      return marketPassesCategoryFilter(m.ticker, m.title);
    });

    // Bucket markets by time remaining for diagnostics
    const under10 = markets.filter(m => {
      const mins = (new Date(m.close_time).getTime() - now) / 60_000;
      return mins > 0 && mins <= 10;
    }).length;
    const window1016 = markets.filter(m => {
      const mins = (new Date(m.close_time).getTime() - now) / 60_000;
      return mins > 10 && mins <= 16;
    }).length;
    const over16 = markets.filter(m => {
      const mins = (new Date(m.close_time).getTime() - now) / 60_000;
      return mins > 16;
    }).length;

    // Sample from eligible (filtered) markets, not the raw list
    const sample = eligible.slice(0, 5).map(m => {
      const mins = ((new Date(m.close_time).getTime() - now) / 60_000).toFixed(1);
      return `${m.ticker}(${mins}m)`;
    }).join(", ");

    // Calculate minutes to next 15-min ET boundary
    const etOffsetMs = 4 * 3600_000; // EDT = UTC-4
    const etMin = Math.floor((now - etOffsetMs) / 60_000) % 15;
    const minsToNext = ((15 - etMin) % 15) || 15;
    const batchHint = eligible.length === 0
      ? ` | 💤 next batch ~${minsToNext}min`
      : "";

    // If nothing eligible, throttle the scan log to avoid spamming DB & UI
    const shouldLog = eligible.length > 0 || (now - lastIdleScanLogMs) >= IDLE_LOG_INTERVAL_MS;
    if (shouldLog) {
      lastIdleScanLogMs = eligible.length === 0 ? now : lastIdleScanLogMs;
      await botLog("info",
        `🔍 Scanned ${markets.length} total — ${eligible.length} eligible | <10min:${under10} | 10-16min:${window1016} | >16min:${over16}${sample ? ` | ${sample}` : ""}${batchHint}`,
      );
    }

    state.marketsScanned += eligible.length;

    // Evaluate up to 50 per scan; zero-price cache means most cached ones return instantly
    const toEvaluate = eligible.slice(0, 50);
    for (const market of toEvaluate) {
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

  // Skip tickers we recently found to have zero liquidity
  const lastZero = zeroPriceTs.get(ticker);
  if (lastZero && Date.now() - lastZero < ZERO_SKIP_MS) return;

  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    const m = resp.market ?? market;

    const yesAsk = priceCents(m, "yes_ask");
    const noAsk  = priceCents(m, "no_ask");
    const yesBid = priceCents(m, "yes_bid");
    const noBid  = priceCents(m, "no_bid");
    const { maxEntryPriceCents } = botConfig;

    // If no liquidity, cache silently and skip
    if (yesAsk === 0 && noAsk === 0) {
      zeroPriceTs.set(ticker, Date.now());
      return;
    }

    // Only log markets that have actual prices
    await botLog("info",
      `📊 ${ticker} — YES ask:${yesAsk}¢ bid:${yesBid}¢ | NO ask:${noAsk}¢ bid:${noBid}¢ | limit:${maxEntryPriceCents}¢ | ${minutesLeft.toFixed(1)}min`,
    );

    if (yesAsk > 0 && yesAsk <= maxEntryPriceCents) {
      const minSellTarget = calcTargetSellPrice(yesAsk);
      if (minSellTarget < 100) {
        await botLog("info", `🟢 Entry signal: ${title} — buy YES at ${yesAsk}¢ | min exit: ${minSellTarget}¢ (no cap)`, {
          ticker, yesAsk, minSellTarget, minutesLeft: minutesLeft.toFixed(1),
        });
        state.tradesAttempted++;
        await enterTrade(ticker, title, "YES", yesAsk, minutesLeft);
        return;
      }
    }

    if (noAsk > 0 && noAsk <= maxEntryPriceCents) {
      const minSellTarget = calcTargetSellPrice(noAsk);
      if (minSellTarget < 100) {
        await botLog("info", `🟢 Entry signal: ${title} — buy NO at ${noAsk}¢ | min exit: ${minSellTarget}¢ (no cap)`, {
          ticker, noAsk, minSellTarget, minutesLeft: minutesLeft.toFixed(1),
        });
        state.tradesAttempted++;
        await enterTrade(ticker, title, "NO", noAsk, minutesLeft);
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
  minutesRemaining: number,
): Promise<void> {
  if (tradeMutex) {
    await botLog("info", `⏳ Trade skipped (another trade in progress): ${ticker}`);
    return;
  }
  tradeMutex = true;
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
      feeCents: 0,
      status: "open",
      kalshiBuyOrderId: buyOrderId,
      minutesRemaining,
    }).returning();

    openMarkets.add(ticker);
    state.openPositionCount = openMarkets.size;
    state.tradesSucceeded++;

    await botLog("info",
      `✅ Bought 1x ${side} on "${title}" at ${buyPriceCents}¢ — monitoring for ≥${botConfig.minNetProfitCents}¢ net (no cap)`,
      { tradeId: trade.id, buyOrderId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await botLog("error", `Failed to enter trade on ${ticker}: ${msg}`);
    state.tradesAttempted = Math.max(0, state.tradesAttempted - 1);
  } finally {
    tradeMutex = false;
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
      const now = Date.now();
      const tradeAgeMs = now - trade.createdAt.getTime();

      // Check if buy order was actually filled (after 60s of no exit opportunity)
      if (tradeAgeMs >= 60_000 && tradeAgeMs < 90_000 && trade.kalshiBuyOrderId) {
        try {
          const orderResp = await kalshiFetch("GET", `/portfolio/orders/${trade.kalshiBuyOrderId}`) as {
            order?: { status?: string; remaining_count?: number; filled_count?: number }
          };
          const order = orderResp.order;
          const filled = (order?.filled_count ?? 0) > 0;
          if (!filled) {
            // Cancel the unfilled order and clean up
            try { await kalshiFetch("DELETE", `/portfolio/orders/${trade.kalshiBuyOrderId}`); } catch (_) {}
            await db.update(tradesTable).set({ status: "cancelled", closedAt: new Date() })
              .where(eq(tradesTable.id, trade.id));
            openMarkets.delete(trade.marketId);
            state.openPositionCount = openMarkets.size;
            await botLog("warn",
              `🚫 Trade ${trade.id} cancelled — buy order never filled after 60s`, { tradeId: trade.id }
            );
            continue;
          }
        } catch (_) {
          // Can't verify — continue holding the position
        }
      }

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

        const currentBid = trade.side === "YES" ? priceCents(m, "yes_bid") : priceCents(m, "no_bid");
        const grossProfit = currentBid - trade.buyPriceCents;
        const netProfit = grossToNet(grossProfit);
        const ageMins = (tradeAgeMs / 60_000).toFixed(1);

        if (netProfit >= botConfig.minNetProfitCents) {
          await botLog("info",
            `🎯 Target hit trade ${trade.id}: bid ${currentBid}¢, net +${netProfit}¢ | held ${ageMins}min — exiting`,
            { tradeId: trade.id, currentBid, netProfit },
          );
          await placeLimitSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, currentBid, trade.contractCount);
        } else if (currentBid > 0) {
          // Log position status so user can see how close we are
          await botLog("info",
            `⏳ Trade ${trade.id} (${trade.side} @${trade.buyPriceCents}¢): bid now ${currentBid}¢, net ${netProfit >= 0 ? "+" : ""}${netProfit}¢ | need +${botConfig.minNetProfitCents}¢ | ${ageMins}min held`,
          );
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
  zeroPriceTs.clear();     // fresh start — re-evaluate all markets
  lastIdleScanLogMs = 0;   // always show first scan result

  // Re-hydrate openMarkets from DB so the in-memory set is accurate after a restart
  const existingOpen = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  openMarkets.clear();
  for (const t of existingOpen) openMarkets.add(t.marketId);
  state.openPositionCount = openMarkets.size;

  await refreshBalance();
  await refreshDailyPnl();

  const cats = botConfig.marketCategories.join("+");
  await botLog("info",
    `🤖 Instinct Scalper started — trading ${cats} | entry ≤${botConfig.maxEntryPriceCents}¢ | target ${botConfig.minNetProfitCents}–${botConfig.maxNetProfitCents}¢ net | max ${botConfig.maxOpenPositions} positions`,
  );

  scanMarkets();
  scanTimer = setInterval(scanMarkets, botConfig.pollIntervalSecs * 1000);
  sellTimer = setInterval(retryOpenPositions, botConfig.pollIntervalSecs * 1000);
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

// ─── Manual trade (user-initiated) ────────────────────────────────────────────
export async function manualTrade(
  ticker: string,
  side: "YES" | "NO",
  limitCents: number,
  quantity: number,
): Promise<{ success: boolean; tradeId?: number; orderId?: string; message: string }> {
  try {
    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    if (!resp.market) {
      return { success: false, message: `Market not found: ${ticker}` };
    }
    const { title, close_time } = resp.market;
    const minutesLeft = (new Date(close_time).getTime() - Date.now()) / 60_000;

    const buyResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `manual-${Date.now()}`,
      type: "limit",
      action: "buy",
      side: side.toLowerCase(),
      count: quantity,
      ...(side === "YES" ? { yes_price: limitCents } : { no_price: limitCents }),
    }) as { order?: { order_id?: string } };

    const buyOrderId = buyResp?.order?.order_id;

    const [trade] = await db.insert(tradesTable).values({
      marketId: ticker,
      marketTitle: title ?? ticker,
      side,
      buyPriceCents: limitCents,
      contractCount: quantity,
      feeCents: 0,
      status: "open",
      kalshiBuyOrderId: buyOrderId,
      minutesRemaining: minutesLeft,
    }).returning();

    openMarkets.add(ticker);
    state.openPositionCount = openMarkets.size;

    await botLog("info",
      `🎯 Manual: bought ${quantity}x ${side} on "${title}" at ${limitCents}¢ — order ${buyOrderId ?? "(no id)"}`,
      { tradeId: trade.id, buyOrderId },
    );

    return {
      success: true,
      tradeId: trade.id,
      orderId: buyOrderId,
      message: `Order placed: ${quantity}x ${side} @ ${limitCents}¢ on ${ticker}`,
    };
  } catch (err) {
    const msg = String(err);
    await botLog("error", `🎯 Manual trade failed on ${ticker}: ${msg}`);
    return { success: false, message: msg };
  }
}

// ─── Coin-flip auto mode ──────────────────────────────────────────────────────
interface CoinFlipAutoState {
  enabled: boolean;
  intervalSecs: number;
  nextFlipAt: number | null;
}

const coinFlipAuto: CoinFlipAutoState = {
  enabled: false,
  intervalSecs: 900,
  nextFlipAt: null,
};

let coinFlipTimer: ReturnType<typeof setTimeout> | null = null;

/** Returns ms until 90 seconds into the next :00/:15/:30/:45 UTC cycle boundary. */
function msToNextCycleStart(): number {
  const now = Date.now();
  const CYCLE_MS = 15 * 60_000;
  const remainder = now % CYCLE_MS;
  const msToNextBoundary = CYCLE_MS - remainder;
  // Fire 90s after the boundary so new markets are open and priced
  return msToNextBoundary + 90_000;
}

function scheduleCoinFlip() {
  if (coinFlipTimer) clearTimeout(coinFlipTimer);
  if (!coinFlipAuto.enabled) return;
  const delay = msToNextCycleStart();
  coinFlipAuto.nextFlipAt = Date.now() + delay;
  coinFlipTimer = setTimeout(async () => {
    if (!coinFlipAuto.enabled) return;
    // Don't fire when the main bot is stopped
    if (!state.running) {
      scheduleCoinFlip(); // reschedule for next cycle
      return;
    }
    try {
      const result = await coinFlipTrade();
      await botLog("info", `🪙 Auto-flip: ${result.message}`);
    } catch (_) {}
    scheduleCoinFlip();
  }, delay);
}

export function startCoinFlipAuto(intervalSecs: number): CoinFlipAutoState {
  coinFlipAuto.enabled = true;
  coinFlipAuto.intervalSecs = intervalSecs;
  scheduleCoinFlip();
  return { ...coinFlipAuto };
}

export function stopCoinFlipAuto(): CoinFlipAutoState {
  coinFlipAuto.enabled = false;
  coinFlipAuto.nextFlipAt = null;
  if (coinFlipTimer) { clearTimeout(coinFlipTimer); coinFlipTimer = null; }
  return { ...coinFlipAuto };
}

export function getCoinFlipAutoState(): CoinFlipAutoState {
  return { ...coinFlipAuto };
}

// ─── Coin-flip trade ──────────────────────────────────────────────────────────
export interface CoinFlipResult {
  success: boolean;
  message: string;
  ticker?: string;
  title?: string;
  side?: "YES" | "NO";
  priceCents?: number;
  tradeId?: number;
}

export async function coinFlipTrade(): Promise<CoinFlipResult> {
  if (tradeMutex) {
    return { success: false, message: "Another trade is in progress — coin flip blocked." };
  }
  tradeMutex = true;
  try {
    // Respect the same safety guards as the main bot
    const safe = await checkSafetyLimits();
    if (!safe) {
      return { success: false, message: "Safety limit reached (balance floor / daily limit) — coin flip blocked." };
    }

    // Respect max open positions — query DB directly so this is always accurate after restarts
    const openRows = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    const effectiveOpen = Math.max(openMarkets.size, openRows.length);
    if (effectiveOpen >= botConfig.maxOpenPositions) {
      return { success: false, message: `Max open positions (${botConfig.maxOpenPositions}) already reached — coin flip blocked.` };
    }

    const now = Date.now();
    const maxCloseTs = Math.floor((now + 20 * 60_000) / 1000);
    const resp = await kalshiFetch("GET", `/markets?status=open&limit=200&max_close_ts=${maxCloseTs}`) as { markets?: KalshiMarket[] };
    const markets = resp.markets ?? [];

    // Coin flip only enters 15-min crypto markets with >10 min remaining — same rules as main bot
    const eligible = markets.filter((m) => {
      if (!m.close_time) return false;
      const mins = (new Date(m.close_time).getTime() - now) / 60_000;
      if (mins <= botConfig.minMinutesRemaining || mins > 16) return false;
      return marketPassesCategoryFilter(m.ticker, m.title);
    });

    if (eligible.length === 0) {
      return { success: false, message: "No markets with >10 min remaining right now — try again shortly." };
    }

    // Pick a random market
    const market = eligible[Math.floor(Math.random() * eligible.length)];
    const { ticker, title } = market;

    // Get live prices
    const detailResp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    const m = detailResp.market ?? market;

    // Re-check time remaining with fresh data — list data can be stale
    const freshMinsLeft = (new Date(m.close_time).getTime() - Date.now()) / 60_000;
    if (freshMinsLeft <= botConfig.minMinutesRemaining) {
      return { success: false, message: `${ticker} now has only ${freshMinsLeft.toFixed(1)} min left — too close to expiry, skipping.` };
    }

    const yesAsk = priceCents(m, "yes_ask");
    const noAsk  = priceCents(m, "no_ask");

    // Flip the coin
    const coinYes = Math.random() < 0.5;
    const preferredSide: "YES" | "NO" = coinYes ? "YES" : "NO";
    const preferredAsk = coinYes ? yesAsk : noAsk;
    const fallbackSide: "YES" | "NO" = coinYes ? "NO" : "YES";
    const fallbackAsk  = coinYes ? noAsk : yesAsk;

    // Coin flip hard cap: never spend more than 60¢ per flip
    const COIN_FLIP_MAX_CENTS = 60;

    // Pick the flipped side if valid, otherwise try the other side
    let side: "YES" | "NO" | null = null;
    let ask = 0;
    if (preferredAsk > 0 && preferredAsk <= COIN_FLIP_MAX_CENTS) {
      side = preferredSide; ask = preferredAsk;
    } else if (fallbackAsk > 0 && fallbackAsk <= COIN_FLIP_MAX_CENTS) {
      side = fallbackSide; ask = fallbackAsk;
    }

    if (!side) {
      return { success: false, message: `Flipped ${preferredSide} on ${ticker} but no valid ask price under ${COIN_FLIP_MAX_CENTS}¢ (YES:${yesAsk}¢ NO:${noAsk}¢).` };
    }

    const minutesLeft = (new Date(m.close_time).getTime() - now) / 60_000;

    const buyResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `coinflip-${Date.now()}`,
      type: "limit",
      action: "buy",
      side: side.toLowerCase(),
      count: 1,
      ...(side === "YES" ? { yes_price: ask } : { no_price: ask }),
    }) as { order?: { order_id?: string } };

    const buyOrderId = buyResp?.order?.order_id;

    const [trade] = await db.insert(tradesTable).values({
      marketId: ticker,
      marketTitle: title ?? ticker,
      side,
      buyPriceCents: ask,
      contractCount: 1,
      feeCents: 0,
      status: "open",
      kalshiBuyOrderId: buyOrderId,
      minutesRemaining: minutesLeft,
    }).returning();

    openMarkets.add(ticker);
    state.openPositionCount = openMarkets.size;
    state.tradesAttempted++;
    state.tradesSucceeded++;

    await botLog("info",
      `🪙 Coin flip: ${side === preferredSide ? "called it!" : "landed " + side} — bought 1x ${side} on "${title}" at ${ask}¢`,
      { tradeId: trade.id, buyOrderId, ticker, side, ask },
    );

    return {
      success: true,
      message: `Flipped ${side}! Bought 1x ${side} on "${title}" at ${ask}¢ — watching for profit.`,
      ticker,
      title,
      side,
      priceCents: ask,
      tradeId: trade.id,
    };
  } catch (err) {
    const msg = String(err);
    await botLog("error", `🪙 Coin flip trade failed: ${msg}`);
    return { success: false, message: msg };
  } finally {
    tradeMutex = false;
  }
}
