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
  exitWindowMins: number;       // place limit sell when this many minutes remain
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
  exitWindowMins: 7,
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
// Full names for each coin — matched against ticker AND title for resilience
const COIN_ALIASES: Record<string, string[]> = {
  BTC:   ["BTC", "BITCOIN", "KXBTC"],
  ETH:   ["ETH", "ETHEREUM", "KXETH"],
  SOL:   ["SOL", "SOLANA", "KXSOL"],
  DOGE:  ["DOGE", "DOGECOIN", "KXDOGE"],
  XRP:   ["XRP", "RIPPLE", "KXXRP"],
  ADA:   ["ADA", "CARDANO", "KXADA"],
  MATIC: ["MATIC", "POLYGON", "KXMATIC"],
};

// Does the ticker or title explicitly say it's a 15-minute market?
function is15MinMarket(ticker: string, title: string): boolean {
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  return upper.includes("15M") || upper.includes("15 MIN") || upper.includes("15MIN");
}

function isCryptoMarket(ticker: string, title: string): boolean {
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  // Match by known 15-min series prefix (most precise — these already imply 15M)
  for (const [, prefixes] of Object.entries(CRYPTO_COIN_SERIES)) {
    if (prefixes.some(p => upper.includes(p.toUpperCase()))) return true;
  }
  // Fallback: match by coin name/alias — but ONLY if the market is explicitly a 15-min market
  // This prevents hourly/daily BTC markets from being matched
  if (!is15MinMarket(ticker, title)) return false;
  for (const aliases of Object.values(COIN_ALIASES)) {
    if (aliases.some(a => upper.includes(a))) return true;
  }
  return false;
}

function matchesCryptoCoin(ticker: string, title: string, coins: string[]): boolean {
  if (coins.length === 0) return true;
  const upper = ticker.toUpperCase() + " " + title.toUpperCase();
  return coins.some(coin => {
    const prefixes = CRYPTO_COIN_SERIES[coin.toUpperCase()] ?? [];
    if (prefixes.some(p => upper.includes(p.toUpperCase()))) return true;
    // Fallback alias match — only for confirmed 15-min markets
    if (!is15MinMarket(ticker, title)) return false;
    const aliases = COIN_ALIASES[coin.toUpperCase()] ?? [coin];
    return aliases.some(a => upper.includes(a));
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
export async function refreshBalance(): Promise<void> {
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
// Full check — used by main bot: stops the bot if a limit is hit
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

// Lightweight check for coin flip — same limits but never stops the main bot
async function checkSafetyLimitsPassive(): Promise<{ ok: boolean; reason?: string }> {
  await refreshBalance();
  await refreshDailyPnl();

  const { balanceFloorCents, dailyProfitTargetCents, dailyLossLimitCents } = botConfig;

  if (balanceFloorCents > 0 && state.balanceCents > 0 && state.balanceCents <= balanceFloorCents) {
    return { ok: false, reason: `Balance floor hit ($${(state.balanceCents / 100).toFixed(2)} ≤ $${(balanceFloorCents / 100).toFixed(2)})` };
  }
  if (dailyProfitTargetCents > 0 && state.dailyPnlCents >= dailyProfitTargetCents) {
    return { ok: false, reason: `Daily profit target already reached` };
  }
  if (dailyLossLimitCents > 0 && state.dailyPnlCents <= -dailyLossLimitCents) {
    return { ok: false, reason: `Daily loss limit hit` };
  }
  return { ok: true };
}

// ─── Market types ────────────────────────────────────────────────────────────
interface KalshiMarket {
  ticker: string;
  title: string;
  close_time: string;
  status?: string;         // "open" | "closed" | "settled" | "finalized"
  result?: string;         // "yes" | "no" (once settled)
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
  // Prefer explicit _dollars field (decimal 0.0–1.0) → multiply by 100 to get cents
  const rawDollars = (m as any)[`${field}_dollars`];
  if (rawDollars !== undefined && rawDollars !== null) {
    const v = typeof rawDollars === "number" ? rawDollars : parseFloat(String(rawDollars));
    if (!isNaN(v) && v > 0) return Math.round(v * 100);
  }
  // Fallback to non-dollars field — handle both decimal (0.47) and integer (47) formats
  const raw = (m as any)[field];
  if (raw !== undefined && raw !== null) {
    const v = typeof raw === "number" ? raw : parseFloat(String(raw));
    if (!isNaN(v) && v > 0) {
      // If <= 1.0 it's already a decimal probability (0.47 = 47¢); if > 1 it's integer cents (47)
      return v <= 1.0 ? Math.round(v * 100) : Math.round(v);
    }
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
      ...(side === "YES" ? { yes_price: buyPriceCents / 100 } : { no_price: buyPriceCents / 100 }),
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
  _buyPriceCents: number,
  sellPriceCents: number,
  contracts: number,
): Promise<void> {
  try {
    const sellResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `scalp-sell-${tradeId}-${Date.now()}`,
      type: "limit",
      action: "sell",
      side: side.toLowerCase(),
      count: contracts,
      ...(side === "YES" ? { yes_price: sellPriceCents / 100 } : { no_price: sellPriceCents / 100 }),
    }) as { order?: { order_id?: string } };

    const sellOrderId = sellResp?.order?.order_id;
    if (!sellOrderId) {
      await botLog("warn", `Trade ${tradeId}: sell order accepted but no order ID returned — will retry next cycle`);
      return;
    }

    // Save sell order ID only — keep trade "open" until fill is confirmed by the monitor loop
    await db.update(tradesTable)
      .set({ kalshiSellOrderId: sellOrderId })
      .where(eq(tradesTable.id, tradeId));

    sellOrderPlacedAt.set(tradeId, Date.now());
    await botLog("info",
      `📋 Trade ${tradeId}: limit sell @ ${sellPriceCents}¢ placed (order ${sellOrderId}) — waiting for fill`,
      { tradeId, sellPriceCents, sellOrderId },
    );
  } catch (err) {
    await botLog("warn", `Failed to place limit sell for trade ${tradeId}`, String(err));
  }
}

// Aggressive market sell — fills immediately at whatever the market will pay
// Trade stays "open" until fill is confirmed on the next monitor tick
async function placeAggressiveSell(
  tradeId: number,
  ticker: string,
  side: string,
  buyPriceCents: number,
  currentBidCents: number,
  contracts: number,
): Promise<void> {
  try {
    const sellResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `scalp-mkt-${tradeId}-${Date.now()}`,
      type: "market",
      action: "sell",
      side: side.toLowerCase(),
      count: contracts,
    }) as { order?: { order_id?: string } };

    const sellOrderId = sellResp?.order?.order_id;
    if (!sellOrderId) {
      // Market order might have filled immediately without returning an ID — fall back to limit at bid-1
      await botLog("warn", `Trade ${tradeId}: market sell accepted but no order ID — falling back to limit at bid-1`);
      await placeLimitSell(tradeId, ticker, side, buyPriceCents, Math.max(1, currentBidCents - 1), contracts);
      return;
    }

    await db.update(tradesTable).set({ kalshiSellOrderId: sellOrderId }).where(eq(tradesTable.id, tradeId));
    sellOrderPlacedAt.set(tradeId, Date.now());
    await botLog("info",
      `📋 Trade ${tradeId}: market sell placed (order ${sellOrderId}) — waiting for fill`,
      { tradeId, sellOrderId },
    );
  } catch (err) {
    // Market order failed (e.g. no liquidity) — fall back to limit sell at bid
    await botLog("warn", `Trade ${tradeId}: market sell failed (${String(err)}) — falling back to limit at bid`);
    await placeLimitSell(tradeId, ticker, side, buyPriceCents, currentBidCents, contracts);
  }
}

// Track when each sell order was placed (tradeId → timestamp) for stale-order repricing
const sellOrderPlacedAt = new Map<number, number>();

// ─── Startup portfolio sync ──────────────────────────────────────────────────
// Queries Kalshi for any open positions not in the DB (e.g. after a DB reset or
// migration to a new database) and creates synthetic trade records so the monitor
// can track and auto-sell them.
export async function syncPortfolioFromKalshi(): Promise<void> {
  try {
    const posResp = await kalshiFetch("GET", "/portfolio/positions") as {
      positions?: Array<{ ticker_name?: string; position?: number; market_exposure?: number }>
    };
    const positions = (posResp.positions ?? []).filter(p => (p.position ?? 0) > 0);
    if (positions.length === 0) {
      await botLog("info", "🔄 Portfolio sync: no open Kalshi positions found");
      return;
    }

    // Get all open trades currently in DB
    const dbOpen = await db.select({ marketId: tradesTable.marketId })
      .from(tradesTable).where(eq(tradesTable.status, "open"));
    const dbOpenIds = new Set(dbOpen.map(r => r.marketId));

    let imported = 0;
    for (const pos of positions) {
      const ticker = pos.ticker_name ?? "";
      if (!ticker || dbOpenIds.has(ticker)) continue; // already tracked

      // Fetch market details so we know the side and price
      try {
        const mResp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
        const m = mResp.market;
        if (!m) continue;

        // Try to determine side and buy price from fill history
        let side: "YES" | "NO" = "YES";
        let buyPriceCents = 50; // fallback mid-point
        try {
          const fillsResp = await kalshiFetch("GET", `/portfolio/fills?ticker=${ticker}&limit=10`) as {
            fills?: Array<{ action?: string; side?: string; yes_price?: number; no_price?: number }>
          };
          const buyFill = (fillsResp.fills ?? []).find(f => f.action === "buy");
          if (buyFill) {
            side = (buyFill.side?.toUpperCase() ?? "YES") as "YES" | "NO";
            buyPriceCents = side === "YES"
              ? Math.round((buyFill.yes_price ?? 0.5) * 100)
              : Math.round((buyFill.no_price ?? 0.5) * 100);
          }
        } catch (_) { /* use fallback */ }

        await db.insert(tradesTable).values({
          marketId: ticker,
          marketTitle: m.title ?? ticker,
          side,
          buyPriceCents,
          contractCount: pos.position ?? 1,
          feeCents: 0,
          status: "open",
          minutesRemaining: m.close_time
            ? (new Date(m.close_time).getTime() - Date.now()) / 60_000
            : null,
        });
        openMarkets.add(ticker);
        imported++;
        await botLog("warn",
          `🔄 Portfolio sync: imported orphaned position — ${ticker} (${side} @${buyPriceCents}¢)`,
          { ticker, side, buyPriceCents },
        );
      } catch (err) {
        await botLog("warn", `🔄 Portfolio sync: failed to import ${ticker} — ${String(err)}`);
      }
    }

    await botLog("info", `🔄 Portfolio sync complete — ${imported} position(s) imported, ${positions.length - imported} already tracked`);
  } catch (err) {
    await botLog("warn", `🔄 Portfolio sync failed — ${String(err)}`);
  }
}

// ─── Retry open positions ─────────────────────────────────────────────────────
let sellMonitorRunning = false;
let positionsInitialized = false; // false until first DB check after startup
export async function retryOpenPositions(): Promise<void> {
  if (sellMonitorRunning) return; // prevent overlapping runs
  // Fast in-memory check — but ALWAYS run DB check on the first tick after startup
  // (openMarkets and openPositionCount are 0 after a restart even if DB has open trades)
  if (positionsInitialized && openMarkets.size === 0 && state.openPositionCount === 0) return;
  sellMonitorRunning = true;
  try {
    const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    positionsInitialized = true; // DB has been checked at least once — fast path now safe
    state.openPositionCount = openTrades.length;
    // Sync in-memory set with DB (recovers any open trades after a server restart)
    for (const t of openTrades) openMarkets.add(t.marketId);
    if (openTrades.length === 0) { openMarkets.clear(); return; }

    // Fetch live portfolio positions once — used below to detect manual sells
    let livePositions: Array<{ ticker_name?: string; position?: number }> = [];
    try {
      const posResp = await kalshiFetch("GET", "/portfolio/positions") as {
        positions?: Array<{ ticker_name?: string; position?: number }>
      };
      livePositions = posResp.positions ?? [];
    } catch (_) { /* non-fatal — will skip position check this cycle */ }

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
          const status = order?.status ?? "";
          // Consider filled if: filled_count > 0 OR status is a terminal fill state
          const filled = (order?.filled_count ?? 0) > 0
            || status === "filled"
            || status === "settled"
            || status === "executed";
          // Only cancel if we are CERTAIN it is still resting/open and not filled
          const definitelyUnfilled = !filled && (status === "resting" || status === "open" || status === "pending");
          if (definitelyUnfilled) {
            // Cancel the unfilled order and clean up
            try { await kalshiFetch("DELETE", `/portfolio/orders/${trade.kalshiBuyOrderId}`); } catch (_) {}
            await db.update(tradesTable).set({ status: "cancelled", closedAt: new Date() })
              .where(eq(tradesTable.id, trade.id));
            openMarkets.delete(trade.marketId);
            state.openPositionCount = openMarkets.size;
            await botLog("warn",
              `🚫 Trade ${trade.id} cancelled — buy order still ${status} after 60s (not filled)`, { tradeId: trade.id }
            );
            continue;
          } else if (!filled) {
            // Unknown status — log and keep holding rather than cancelling
            await botLog("info",
              `Trade ${trade.id}: buy order status="${status}" filled_count=${order?.filled_count ?? 0} — keeping position open`, { tradeId: trade.id }
            );
          }
        } catch (_) {
          // Can't verify — continue holding the position
        }
      }

      // ── Detect manual sells / external position closure ───────────────────
      // If we've been open > 30s and Kalshi shows 0 contracts remaining, the position was closed externally
      if (livePositions.length > 0 && tradeAgeMs > 30_000) {
        const livePos = livePositions.find(p => p.ticker_name === trade.marketId);
        const remaining = livePos?.position ?? 0;
        if (remaining === 0) {
          // Position gone on Kalshi — try to get actual sell price from fill history
          let pnlCents = 0;
          let sellPriceCents: number | undefined;
          try {
            const fillsResp = await kalshiFetch("GET", `/portfolio/fills?ticker=${trade.marketId}&limit=20`) as {
              fills?: Array<{ action?: string; side?: string; yes_price?: number; no_price?: number; count?: number }>
            };
            const sells = (fillsResp.fills ?? []).filter(f => f.action === "sell");
            if (sells.length > 0) {
              const f = sells[0];
              const rawFp = trade.side === "YES" ? (f.yes_price ?? 0) : (f.no_price ?? 0);
              const fp = rawFp > 0
                ? Math.round(rawFp * 100)
                : currentBid > 0 ? currentBid : 0;
              if (fp > 0) {
                sellPriceCents = fp;
                const gross = fp - trade.buyPriceCents;
                const fee = Math.floor(botConfig.feeRate * Math.max(0, gross));
                pnlCents = gross - fee;
              }
            }
          } catch (_) { /* non-fatal — fall back to 0 */ }

          await db.update(tradesTable).set({
            status: "closed",
            pnlCents,
            sellPriceCents,
            closedAt: new Date(),
          }).where(eq(tradesTable.id, trade.id));
          openMarkets.delete(trade.marketId);
          sellOrderPlacedAt.delete(trade.id);
          state.openPositionCount = openMarkets.size;
          await botLog("warn",
            `🖐 Trade ${trade.id}: manually closed — sell ~${sellPriceCents ?? "?"}¢, net ${pnlCents >= 0 ? "+" : ""}${pnlCents}¢`,
            { tradeId: trade.id, pnlCents },
          );
          continue;
        }
      }

      try {
        const resp = await kalshiFetch("GET", `/markets/${trade.marketId}`) as { market?: KalshiMarket };
        const m = resp.market;

        // ── Market settled/closed — record actual outcome ───────────────────
        // Kalshi returns "active" for live markets and "open" in some contexts — treat both as live
        const isLive = !m?.status || m.status === "open" || m.status === "active";
        if (!m || !isLive) {
          const settled = m?.status === "settled" || m?.status === "finalized";
          const ourSideWon = settled && m?.result?.toLowerCase() === trade.side.toLowerCase();

          let pnlCents: number;
          let logMsg: string;

          if (ourSideWon) {
            // We won — contract pays out 100¢
            const gross = 100 - trade.buyPriceCents;
            const fee = Math.floor(botConfig.feeRate * gross);
            pnlCents = gross - fee;
            logMsg = `🏆 Trade ${trade.id} settled YES — won! Net +${pnlCents}¢ (fee: ${fee}¢)`;
          } else if (settled) {
            // Settled but our side lost
            pnlCents = -trade.buyPriceCents;
            logMsg = `💸 Trade ${trade.id} settled — lost ${trade.buyPriceCents}¢`;
          } else {
            // Market closed but not yet settled — use a neutral expiry
            pnlCents = -trade.buyPriceCents;
            logMsg = `⚠️ Trade ${trade.id} market closed (status: ${m?.status ?? "unknown"}) — marking expired`;
          }

          await db.update(tradesTable).set({
            status: settled && ourSideWon ? "closed" : "expired",
            pnlCents,
            closedAt: new Date(),
          }).where(eq(tradesTable.id, trade.id));

          openMarkets.delete(trade.marketId);
          state.openPositionCount = openMarkets.size;
          await botLog(ourSideWon ? "info" : "warn", logMsg, { tradeId: trade.id });
          continue;
        }

        const currentBid = trade.side === "YES" ? priceCents(m, "yes_bid") : priceCents(m, "no_bid");
        const ageMins = (tradeAgeMs / 60_000).toFixed(1);
        const minsLeft = (new Date(m.close_time).getTime() - now) / 60_000;
        const targetSellPrice = calcTargetSellPrice(trade.buyPriceCents);

        // Debug: log when approaching exit window
        if (minsLeft > 0 && minsLeft <= (botConfig.exitWindowMins + 1)) {
          await botLog("debug", `Trade ${trade.id}: minsLeft=${minsLeft.toFixed(1)}, exitWindow=${botConfig.exitWindowMins}, hasOrderId=${!!trade.kalshiSellOrderId}`);
        }

        // ── Sell order already placed on Kalshi — check fill status ──────────
        if (trade.kalshiSellOrderId) {
          if (minsLeft <= 2) {
            // Panic window: cancel resting sell and re-place at current bid
            try { await kalshiFetch("DELETE", `/portfolio/orders/${trade.kalshiSellOrderId}`); } catch (_) {}
            await db.update(tradesTable).set({ kalshiSellOrderId: null }).where(eq(tradesTable.id, trade.id));
            if (currentBid > 0) {
              await botLog("warn", `⏰ Trade ${trade.id} panic — cancelled resting sell, re-placing at bid ${currentBid}¢`, { tradeId: trade.id });
              await placeLimitSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, currentBid, trade.contractCount);
            }
          } else {
            // Check if the resting sell order was filled
            try {
              const sellOrderResp = await kalshiFetch("GET", `/portfolio/orders/${trade.kalshiSellOrderId}`) as {
                order?: { status?: string; filled_count?: number; yes_price?: number; no_price?: number }
              };
              const sellOrder = sellOrderResp.order;
              const filled = (sellOrder?.filled_count ?? 0) > 0;
              if (filled) {
                // Fill confirmed — record P&L
                // Market sell orders return yes_price=0 (no fixed price); use currentBid as proxy.
                // Limit sell orders return the actual limit price — use that directly.
                const rawPrice = trade.side === "YES" ? (sellOrder?.yes_price ?? 0) : (sellOrder?.no_price ?? 0);
                const fillPrice = rawPrice > 0
                  ? Math.round(rawPrice * 100)
                  : currentBid > 0 ? currentBid : targetSellPrice;
                const gross = fillPrice - trade.buyPriceCents;
                const fee = Math.floor(botConfig.feeRate * Math.max(0, gross));
                const netPnl = gross - fee;
                await db.update(tradesTable).set({
                  status: "closed", sellPriceCents: fillPrice, pnlCents: netPnl, feeCents: fee, closedAt: new Date(),
                }).where(eq(tradesTable.id, trade.id));
                openMarkets.delete(trade.marketId);
                sellOrderPlacedAt.delete(trade.id);
                state.openPositionCount = openMarkets.size;
                await botLog("info", `✅ Sell order filled — trade ${trade.id} closed at ${fillPrice}¢, net ${netPnl >= 0 ? "+" : ""}${netPnl}¢`, { tradeId: trade.id });
              } else {
                // Not filled yet — check if stale (> 20s old) and reprice if bid is still profitable
                const placedAt = sellOrderPlacedAt.get(trade.id) ?? 0;
                const sellOrderAgeMs = Date.now() - placedAt;
                const grossProfit = currentBid - trade.buyPriceCents;
                const currentNet = grossToNet(grossProfit);
                if (sellOrderAgeMs > 20_000 && currentNet >= botConfig.minNetProfitCents && currentBid > 0) {
                  // Cancel stale sell and re-place at current bid
                  try { await kalshiFetch("DELETE", `/portfolio/orders/${trade.kalshiSellOrderId}`); } catch (_) {}
                  await db.update(tradesTable).set({ kalshiSellOrderId: null }).where(eq(tradesTable.id, trade.id));
                  sellOrderPlacedAt.delete(trade.id);
                  await botLog("warn", `🔄 Trade ${trade.id}: stale sell repriced — cancelling @ ${targetSellPrice}¢, re-placing at bid ${currentBid}¢`);
                  await placeAggressiveSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, currentBid, trade.contractCount);
                } else {
                  await botLog("info", `📋 Trade ${trade.id}: resting sell @ ${targetSellPrice}¢ pending | bid ${currentBid}¢ | ${minsLeft.toFixed(1)}min left`);
                }
              }
            } catch (_) {
              await botLog("info", `📋 Trade ${trade.id}: sell order pending | ${minsLeft.toFixed(1)}min left`);
            }
          }

        // ── Exit window reached — place resting limit sell on Kalshi ─────────
        } else if (minsLeft <= botConfig.exitWindowMins) {
          if (targetSellPrice >= 100) {
            // Target unreachable (e.g. bought at 96¢ trying for 5¢ net) — exit at bid
            const fallbackPrice = Math.max(currentBid, trade.buyPriceCents + 1);
            await botLog("warn", `⚠️ Trade ${trade.id} target ${targetSellPrice}¢ unreachable — placing sell at ${fallbackPrice}¢`);
            await placeLimitSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, fallbackPrice, trade.contractCount);
          } else {
            // Place resting limit sell at target — don't mark trade closed yet
            try {
              const priceField = trade.side === "YES" ? "yes_price" : "no_price";
              const sellResp = await kalshiFetch("POST", "/portfolio/orders", {
                ticker: trade.marketId,
                client_order_id: `sell-${trade.id}-${Date.now()}`,
                type: "limit",
                action: "sell",
                side: trade.side.toLowerCase(),
                [priceField]: targetSellPrice / 100,
                count: trade.contractCount,
              }) as { order?: { order_id?: string } };
              const sellOrderId = sellResp.order?.order_id;
              if (sellOrderId) {
                await db.update(tradesTable).set({ kalshiSellOrderId: sellOrderId }).where(eq(tradesTable.id, trade.id));
                await botLog("info",
                  `📋 Trade ${trade.id}: placed limit sell @ ${targetSellPrice}¢ (net +${botConfig.minNetProfitCents}¢) | ${minsLeft.toFixed(1)}min left`,
                  { tradeId: trade.id, targetSellPrice },
                );
              } else {
                await botLog("warn", `Trade ${trade.id}: sell order placed but no order ID returned`);
              }
            } catch (sellErr) {
              await botLog("warn", `Trade ${trade.id}: failed to place limit sell — ${String(sellErr)}`);
            }
          }

        // ── Still holding — exit window not yet open ──────────────────────────
        } else {
          const grossProfit = currentBid - trade.buyPriceCents;
          const netProfit = grossToNet(grossProfit);
          if (netProfit >= botConfig.minNetProfitCents && currentBid > 0) {
            // Price already at target — place aggressive limit sell at bid (fills against existing buy orders)
            await botLog("info",
              `🎯 Trade ${trade.id}: price hit target early (bid ${currentBid}¢, net +${netProfit}¢) — selling now`,
              { tradeId: trade.id, currentBid, netProfit },
            );
            await placeAggressiveSell(trade.id, trade.marketId, trade.side, trade.buyPriceCents, currentBid, trade.contractCount);
          } else {
            await botLog("info",
              `⏸ Trade ${trade.id} (${trade.side} @${trade.buyPriceCents}¢) holding | bid ${currentBid}¢ | net ${netProfit >= 0 ? "+" : ""}${netProfit}¢ | ${minsLeft.toFixed(1)}min left | sell window opens at ${botConfig.exitWindowMins}min`,
            );
          }
        }
      } catch (err) {
        await botLog("warn", `Failed to check position ${trade.id}`, String(err));

        // Fallback expiry if we can't reach the API and trade is very old
        if (tradeAgeMs > 20 * 60_000) {
          await db.update(tradesTable).set({
            status: "expired",
            pnlCents: -trade.buyPriceCents,
            closedAt: new Date(),
          }).where(eq(tradesTable.id, trade.id));
          openMarkets.delete(trade.marketId);
          state.openPositionCount = openMarkets.size;
          await botLog("warn", `⚠️ Trade ${trade.id} force-expired after 20min (API unreachable)`, { tradeId: trade.id });
        }
      }
    }
    // Refresh daily P&L from DB after processing all trades — single source of truth
    await refreshDailyPnl();
  } catch (err) {
    logger.error({ err }, "retryOpenPositions failed");
  } finally {
    sellMonitorRunning = false;
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

  retryOpenPositions(); // immediate pass — clears any stale open trades from before restart
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
      ...(side === "YES" ? { yes_price: limitCents / 100 } : { no_price: limitCents / 100 }),
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
  lastResult: { success: boolean; message: string; side?: "YES" | "NO" } | null;
}

const coinFlipAuto: CoinFlipAutoState = {
  enabled: false,
  intervalSecs: 900,
  nextFlipAt: null,
  lastResult: null,
};

let coinFlipTimer: ReturnType<typeof setTimeout> | null = null;

/** Returns ms until 30s into the next :00/:15/:30/:45 UTC cycle boundary. */
function msToNextCycleStart(): number {
  const now = Date.now();
  const CYCLE_MS = 15 * 60_000;
  const remainder = now % CYCLE_MS;
  const msToNextBoundary = CYCLE_MS - remainder;
  // Fire 30s after the boundary — Kalshi has new markets live by then
  return msToNextBoundary + 30_000;
}

function scheduleCoinFlip(retryDelaySecs?: number) {
  if (coinFlipTimer) clearTimeout(coinFlipTimer);
  if (!coinFlipAuto.enabled) return;

  let delay: number;
  if (retryDelaySecs !== undefined) {
    delay = retryDelaySecs * 1000;
  } else {
    // If we're early enough in the current cycle, fire right away (2s grace)
    const CYCLE_MS = 15 * 60_000;
    const minsUntilCycleEnd = (CYCLE_MS - (Date.now() % CYCLE_MS)) / 60_000;
    if (minsUntilCycleEnd > botConfig.minMinutesRemaining + 1) {
      delay = 2_000; // fire in 2 seconds
    } else {
      delay = msToNextCycleStart(); // wait for the next cycle
    }
  }

  coinFlipAuto.nextFlipAt = Date.now() + delay;
  coinFlipTimer = setTimeout(async () => {
    if (!coinFlipAuto.enabled) return;
    try {
      const result = await coinFlipTrade();
      coinFlipAuto.lastResult = { success: result.success, message: result.message, side: result.side };
      await botLog("info", `🪙 Auto-flip: ${result.message}`);
      if (!result.success && result.message.includes("No markets")) {
        // Retry mid-cycle if there's still enough time, otherwise wait for next cycle
        const CYCLE_MS = 15 * 60_000;
        const minsLeft = (CYCLE_MS - (Date.now() % CYCLE_MS)) / 60_000;
        if (minsLeft > botConfig.minMinutesRemaining + 2) {
          scheduleCoinFlip(120); // retry in 2 min — still enough time
        } else {
          scheduleCoinFlip(); // too late in cycle — wait for next cycle start
        }
      } else {
        scheduleCoinFlip();
      }
    } catch (err) {
      coinFlipAuto.lastResult = { success: false, message: String(err) };
      scheduleCoinFlip();
    }
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
    // Check safety limits without stopping the main bot
    const safety = await checkSafetyLimitsPassive();
    if (!safety.ok) {
      return { success: false, message: `Coin flip blocked — ${safety.reason}` };
    }

    // Respect max open positions — query DB directly so this is always accurate after restarts
    const openRows = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    const effectiveOpen = Math.max(openMarkets.size, openRows.length);
    if (effectiveOpen >= botConfig.maxOpenPositions) {
      return { success: false, message: `Max open positions (${botConfig.maxOpenPositions}) already reached — coin flip blocked.` };
    }

    // Build set of market tickers already occupied — skip these when selecting a new market
    const occupiedTickers = new Set<string>([
      ...openMarkets,
      ...openRows.map(t => t.marketId),
    ]);

    const now = Date.now();

    // Query each enabled coin's series directly — avoids pagination/ordering issues with the
    // general /markets endpoint that can return 200 non-crypto results before reaching BTC/ETH
    const enabledCoins = botConfig.cryptoCoins.length > 0
      ? botConfig.cryptoCoins
      : ["BTC", "ETH", "SOL", "DOGE"];

    const allMarkets: KalshiMarket[] = [];
    for (const coin of enabledCoins) {
      const seriesPrefixes = CRYPTO_COIN_SERIES[coin.toUpperCase()] ?? [];
      for (const series of seriesPrefixes) {
        try {
          const resp = await kalshiFetch("GET", `/markets?status=open&series_ticker=${series}&limit=50`) as { markets?: KalshiMarket[] };
          allMarkets.push(...(resp.markets ?? []));
        } catch (_) { /* skip if series not found */ }
      }
    }

    // Coin flip only enters markets with >minMinutesRemaining left — no upper cap since we queried
    // the series directly so we know they're 15-min markets
    let timeOk = 0;
    const eligible = allMarkets.filter((m) => {
      if (!m.close_time) return false;
      const mins = (new Date(m.close_time).getTime() - now) / 60_000;
      if (mins <= botConfig.minMinutesRemaining) return false;
      timeOk++;
      return true;
    });

    // Deduplicate by ticker (same market may appear from multiple series queries)
    const seen = new Set<string>();
    const uniqueEligible = eligible.filter(m => {
      if (seen.has(m.ticker)) return false;
      seen.add(m.ticker);
      return true;
    });

    const sample = allMarkets.slice(0, 3).map(m =>
      `${m.ticker}(${((new Date(m.close_time).getTime() - now) / 60_000).toFixed(1)}min)`
    ).join(", ");
    await botLog("info",
      `🔍 Coin flip scan: ${allMarkets.length} series markets fetched, ${timeOk} in time window, ${uniqueEligible.length} eligible | sample: ${sample || "none"}`,
    );

    if (uniqueEligible.length === 0) {
      return { success: false, message: `No markets found — fetched ${allMarkets.length} from ${enabledCoins.join("/")} series, ${timeOk} in time window` };
    }

    // Shuffle eligible markets and try each in turn until one has live prices
    const shuffled = [...uniqueEligible].sort(() => Math.random() - 0.5);
    const maxAsk = Math.min(botConfig.maxEntryPriceCents, 90);

    let market!: KalshiMarket;
    let side!: "YES" | "NO";
    let ask!: number;
    let minutesLeft!: number;

    let triedAll = 0;
    for (const candidate of shuffled) {
      // Skip markets already held — each open position must be on a different market
      if (occupiedTickers.has(candidate.ticker)) continue;

      triedAll++;
      const detailResp = await kalshiFetch("GET", `/markets/${candidate.ticker}`) as { market?: KalshiMarket };
      const m = detailResp.market ?? candidate;

      const freshMins = (new Date(m.close_time).getTime() - Date.now()) / 60_000;
      if (freshMins <= botConfig.minMinutesRemaining) continue; // stale — expired

      const yesAsk = priceCents(m, "yes_ask");
      const noAsk  = priceCents(m, "no_ask");

      // Flip the coin — strictly follow the result, no fallback to other side
      const coinYes = Math.random() < 0.5;
      const trySide: "YES" | "NO" = coinYes ? "YES" : "NO";
      const tryAsk = coinYes ? yesAsk : noAsk;

      if (tryAsk <= 0 || tryAsk > maxAsk) {
        await botLog("info", `Coin flip: landed ${trySide} on ${candidate.ticker} but ask ${tryAsk}¢ exceeds limit ${maxAsk}¢ — trying next market`);
        continue;
      }

      market = m;
      side = trySide;
      ask = tryAsk;
      minutesLeft = freshMins;
      break;
    }

    if (!market) {
      return { success: false, message: `No tradeable markets — checked ${triedAll} markets, none had valid ask ≤ ${maxAsk}¢` };
    }

    const { ticker, title } = market;

    // Add 1¢ buffer above ask to cross the spread and ensure fill even if price ticks up
    // Cap at maxAsk so we never overpay beyond the user's limit
    const orderPriceCents = Math.min(ask + 1, maxAsk);

    const buyResp = await kalshiFetch("POST", "/portfolio/orders", {
      ticker,
      client_order_id: `coinflip-${Date.now()}`,
      type: "limit",
      action: "buy",
      side: side.toLowerCase(),
      count: 1,
      ...(side === "YES" ? { yes_price: orderPriceCents / 100 } : { no_price: orderPriceCents / 100 }),
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
      `🪙 Coin flip: landed ${side} — bought 1x ${side} on "${title}" at ${ask}¢`,
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

// ─── Force-clear stuck open positions ────────────────────────────────────────
export async function clearStuckPositions(): Promise<{ cleared: number }> {
  const openTrades = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
  for (const trade of openTrades) {
    await db.update(tradesTable)
      .set({ status: "closed", pnlCents: 0, closedAt: new Date() })
      .where(eq(tradesTable.id, trade.id));
    openMarkets.delete(trade.marketId);
    sellOrderPlacedAt.delete(trade.id);
    await botLog("warn", `🧹 Trade ${trade.id} force-cleared via dashboard reset`, { tradeId: trade.id });
  }
  state.openPositionCount = 0;
  // Reset last result and retry immediately so the button disappears and next flip fires in 5s
  coinFlipAuto.lastResult = null;
  if (coinFlipAuto.enabled) scheduleCoinFlip(5);
  return { cleared: openTrades.length };
}
