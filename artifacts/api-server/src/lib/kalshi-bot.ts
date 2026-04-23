import crypto from "crypto";
import { db, tradesTable, botLogsTable, botSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import { and, eq, gte, ne, sql } from "drizzle-orm";

// ─── DB keepalive ─────────────────────────────────────────────────────────────
// Pings the database every 15 s from the moment the server starts.
// This prevents Neon/Railway PostgreSQL from suspending the endpoint between
// bot ticks, which was the root cause of the "endpoint has been disabled" errors.
setInterval(() => { db.execute(sql`SELECT 1`).catch(() => {}); }, 15_000);

// ─── Trade-closed callback (injected by momentumBot to avoid circular import) ──
let _onTradeClosed: ((entry: number, exit: number, pnl: number) => void) | null = null;
export function setTradeClosedHook(fn: (entry: number, exit: number, pnl: number) => void) {
  _onTradeClosed = fn;
}
function fireTradeClosedHook(entry: number, exit: number, pnl: number) {
  try { _onTradeClosed?.(entry, exit, pnl); } catch (_) {}
}

// ─── Position-removal cooldown hook (injected by other bot modules) ───────────
type PositionRemovalReason =
  | "pending_sell_filled"
  | "buy_order_cancelled"
  | "manual_sell_detected"
  | "market_closed_or_settled";

let _onPositionRemovedForCooldown:
  ((marketId: string, reason: PositionRemovalReason, tradeId: number) => void) | null = null;

export function setPositionRemovedCooldownHook(
  fn: (marketId: string, reason: PositionRemovalReason, tradeId: number) => void,
) {
  _onPositionRemovedForCooldown = fn;
}

function firePositionRemovedCooldownHook(
  marketId: string,
  reason: PositionRemovalReason,
  tradeId: number,
) {
  setMarketReentryCooldown(marketId, reason, tradeId);
  try { _onPositionRemovedForCooldown?.(marketId, reason, tradeId); } catch (_) {}
}

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
  exitWindowMins: 2,
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

/** Load saved settings from DB into botConfig. Fire-and-forget safe. */
export async function loadBotConfigFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, 1)).limit(1);
    if (rows.length > 0) {
      const r = rows[0];
      Object.assign(botConfig, {
        maxEntryPriceCents:      r.maxEntryPriceCents,
        minNetProfitCents:       r.minNetProfitCents,
        maxNetProfitCents:       r.maxNetProfitCents,
        minMinutesRemaining:     r.minMinutesRemaining,
        exitWindowMins:          r.exitWindowMins,
        maxOpenPositions:        r.maxOpenPositions,
        balanceFloorCents:       r.balanceFloorCents,
        dailyProfitTargetCents:  r.dailyProfitTargetCents,
        dailyLossLimitCents:     r.dailyLossLimitCents,
        feeRate:                 r.feeRate,
        pollIntervalSecs:        r.pollIntervalSecs,
        marketCategories:        (r.marketCategories as string[]) ?? ["crypto"],
        cryptoCoins:             (r.cryptoCoins as string[]) ?? ["BTC", "ETH", "SOL", "DOGE"],
      });
      logger.info({ maxEntryPriceCents: botConfig.maxEntryPriceCents }, "startup: bot config loaded from DB");
    } else {
      logger.info("startup: no saved bot config in DB — using defaults");
    }
  } catch (err) {
    logger.warn({ err }, "startup: failed to load bot config from DB — using defaults");
  }
}

/** Persist current botConfig to DB (upsert row id=1). Fire-and-forget safe. */
export async function saveBotConfigToDb(config: BotConfig): Promise<void> {
  try {
    await db.insert(botSettingsTable).values({
      id: 1,
      maxEntryPriceCents:      config.maxEntryPriceCents,
      minNetProfitCents:       config.minNetProfitCents,
      maxNetProfitCents:       config.maxNetProfitCents,
      minMinutesRemaining:     config.minMinutesRemaining,
      exitWindowMins:          config.exitWindowMins,
      maxOpenPositions:        config.maxOpenPositions,
      balanceFloorCents:       config.balanceFloorCents,
      dailyProfitTargetCents:  config.dailyProfitTargetCents,
      dailyLossLimitCents:     config.dailyLossLimitCents,
      feeRate:                 config.feeRate,
      pollIntervalSecs:        config.pollIntervalSecs,
      marketCategories:        config.marketCategories,
      cryptoCoins:             config.cryptoCoins,
    }).onConflictDoUpdate({
      target: botSettingsTable.id,
      set: {
        maxEntryPriceCents:      config.maxEntryPriceCents,
        minNetProfitCents:       config.minNetProfitCents,
        maxNetProfitCents:       config.maxNetProfitCents,
        minMinutesRemaining:     config.minMinutesRemaining,
        exitWindowMins:          config.exitWindowMins,
        maxOpenPositions:        config.maxOpenPositions,
        balanceFloorCents:       config.balanceFloorCents,
        dailyProfitTargetCents:  config.dailyProfitTargetCents,
        dailyLossLimitCents:     config.dailyLossLimitCents,
        feeRate:                 config.feeRate,
        pollIntervalSecs:        config.pollIntervalSecs,
        marketCategories:        config.marketCategories,
        cryptoCoins:             config.cryptoCoins,
      },
    });
    logger.info({ maxEntryPriceCents: config.maxEntryPriceCents }, "bot config saved to DB");
  } catch (err) {
    logger.warn({ err }, "failed to save bot config to DB");
  }
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
const MARKET_REENTRY_COOLDOWN_MS = 75_000;
const marketReentryCooldowns = new Map<string, number>();
const BALANCE_STALE_MS = 90_000;
let lastBalanceRefreshOkAt = 0;
let lastBalanceRefreshError: string | null = null;

function setMarketReentryCooldown(
  marketId: string,
  reason: string,
  tradeId?: number,
  baseTimeMs = Date.now(),
): void {
  const untilMs = baseTimeMs + MARKET_REENTRY_COOLDOWN_MS;
  const existing = marketReentryCooldowns.get(marketId) ?? 0;
  if (untilMs <= existing) return;
  marketReentryCooldowns.set(marketId, untilMs);
  logger.info({ marketId, reason, tradeId, untilMs }, "market re-entry cooldown set");
}

function getMarketReentryCooldownRemainingMs(marketId: string): number {
  const untilMs = marketReentryCooldowns.get(marketId);
  if (!untilMs) return 0;
  const remainingMs = untilMs - Date.now();
  if (remainingMs <= 0) {
    marketReentryCooldowns.delete(marketId);
    return 0;
  }
  return remainingMs;
}

function isMarketInReentryCooldown(marketId: string): boolean {
  return getMarketReentryCooldownRemainingMs(marketId) > 0;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

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

export async function kalshiFetch(method: string, path: string, body?: unknown): Promise<unknown> {
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

// ─── Order price helper ───────────────────────────────────────────────────────
// Kalshi expects YES/NO prices as INTEGERS (cents), e.g. 36 not 0.36.
// This function validates, clamps, and returns the integer value.
function toKalshiPrice(cents: number): number {
  const p = Math.round(cents);
  if (p < 1 || p > 99) {
    logger.warn({ cents, clamped: Math.min(99, Math.max(1, p)) }, "kalshi price out of 1-99 range — clamping");
  }
  return Math.min(99, Math.max(1, p));
}

function buildOrderPayload(
  ticker: string,
  clientOrderId: string,
  type: "limit" | "market",
  action: "buy" | "sell",
  side: "YES" | "NO",
  count: number,
  priceCentsOrNull?: number,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ticker,
    client_order_id: clientOrderId,
    type,
    action,
    side: side.toLowerCase(),
    count,
  };

  if (type === "limit" && priceCentsOrNull !== undefined) {
    const price = toKalshiPrice(priceCentsOrNull);
    base[side === "YES" ? "yes_price" : "no_price"] = price;
  }

  logger.info({ payload: base }, `kalshi-order-payload`);

  // Validate no decimal price fields were accidentally added
  for (const [k, v] of Object.entries(base)) {
    if ((k === "yes_price" || k === "no_price") && typeof v === "number" && !Number.isInteger(v)) {
      throw new Error(`PRICE FORMAT BUG: ${k}=${v} is not an integer — refusing to send`);
    }
  }

  return base;
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
function parseMoneyFieldToCents(value: unknown, forceCents: boolean): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    if (forceCents) return Math.round(value);
    // If decimal is present, treat as dollars; integer values are treated as cents.
    return Number.isInteger(value) ? Math.round(value) : Math.round(value * 100);
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    if (forceCents) return Math.round(parsed);
    return value.includes(".") ? Math.round(parsed * 100) : Math.round(parsed);
  }
  return null;
}

export async function refreshBalance(): Promise<void> {
  try {
    const resp = await kalshiFetch("GET", "/portfolio/balance");
    console.log(`[BALANCE RAW] ${JSON.stringify(resp)}`);
    const r = resp as Record<string, unknown>;

    // Prefer explicit cents fields first; fallback to generic fields.
    const candidates: Array<{ key: string; forceCents: boolean }> = [
      { key: "balance_cents", forceCents: true },
      { key: "available_balance_cents", forceCents: true },
      { key: "cash_balance_cents", forceCents: true },
      { key: "balance", forceCents: false },
      { key: "available_balance", forceCents: false },
      { key: "cash_balance", forceCents: false },
    ];

    let parsedCents: number | null = null;
    let usedKey = "none";
    for (const candidate of candidates) {
      parsedCents = parseMoneyFieldToCents(r[candidate.key], candidate.forceCents);
      if (parsedCents !== null) {
        usedKey = candidate.key;
        break;
      }
    }

    if (parsedCents === null) {
      throw new Error("balance response missing parseable balance field");
    }

    state.balanceCents = parsedCents;
    lastBalanceRefreshOkAt = Date.now();
    lastBalanceRefreshError = null;
    console.log(
      `[BALANCE PARSED] key:${usedKey} cents:${state.balanceCents} ($${(state.balanceCents / 100).toFixed(2)})`,
    );
  } catch (err) {
    console.log(`[BALANCE ERROR] ${String(err)}`);
    lastBalanceRefreshError = String(err);
    // non-fatal; keep last known value
  }
}

async function forceStopForUnsafeBalance(reason: string): Promise<void> {
  await botLog("warn", `🛑 Auto-stop: ${reason}`);
  await stopBot(reason);
}

async function assertSafeToEnterTrade(
  opts: { stopBotOnFloorHit: boolean; context: string },
): Promise<{ ok: boolean; reason?: string }> {
  await refreshBalance();

  if (botConfig.balanceFloorCents <= 0) {
    return { ok: true };
  }

  const balanceFresh = lastBalanceRefreshOkAt > 0 && (Date.now() - lastBalanceRefreshOkAt) <= BALANCE_STALE_MS;
  if (!balanceFresh) {
    const reason = `Balance refresh stale/unavailable before ${opts.context}; last error: ${lastBalanceRefreshError ?? "none"}`;
    return { ok: false, reason };
  }

  if (state.balanceCents <= botConfig.balanceFloorCents) {
    const reason = `Balance floor hit — balance ${formatUsd(state.balanceCents)} ≤ floor ${formatUsd(botConfig.balanceFloorCents)}`;
    if (opts.stopBotOnFloorHit && state.running) {
      await forceStopForUnsafeBalance(reason);
    }
    return { ok: false, reason };
  }

  return { ok: true };
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
  const balanceCheck = await assertSafeToEnterTrade({
    stopBotOnFloorHit: true,
    context: "scan cycle",
  });
  if (!balanceCheck.ok) return false;

  await refreshDailyPnl();

  const { balanceFloorCents, dailyProfitTargetCents, dailyLossLimitCents } = botConfig;

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
  if (isMarketInReentryCooldown(ticker)) return;

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
  if (isMarketInReentryCooldown(ticker)) {
    return;
  }

  const balanceGate = await assertSafeToEnterTrade({
    stopBotOnFloorHit: true,
    context: `entry ${ticker}`,
  });
  if (!balanceGate.ok) {
    await botLog("warn", `⛔ Entry blocked: ${balanceGate.reason}`, { ticker, side });
    return;
  }

  if (tradeMutex) {
    await botLog("info", `⏳ Trade skipped (another trade in progress): ${ticker}`);
    return;
  }
  tradeMutex = true;
  try {
    const buyResp = await kalshiFetch("POST", "/portfolio/orders",
      buildOrderPayload(ticker, `scalp-buy-${Date.now()}`, "limit", "buy", side, 1, buyPriceCents),
    ) as { order?: { order_id?: string } };

    const buyOrderId = buyResp?.order?.order_id ?? null;
    const now        = Date.now();
    const provisId   = -now; // negative provisional ID until DB write completes

    // ── Register IMMEDIATELY in memory — sell monitor works even if DB is down ─
    openMarkets.add(ticker);
    state.openPositionCount = openMarkets.size;
    state.tradesSucceeded++;
    const posRef = registerOpenPosition({
      tradeId:         provisId,
      marketId:        ticker,
      side:            side as "YES" | "NO",
      entryPriceCents: buyPriceCents,
      contractCount:   1,
      enteredAt:       now,
      buyOrderId,
    });

    await botLog("info",
      `✅ Bought 1x ${side} on "${title}" at ${buyPriceCents}¢ — monitoring for ≥${botConfig.minNetProfitCents}¢ net (no cap)`,
      { buyOrderId },
    );

    // ── DB write is fire-and-forget — swap provisional ID when it completes ────
    db.insert(tradesTable).values({
      marketId: ticker, marketTitle: title, side, buyPriceCents,
      contractCount: 1, feeCents: 0, status: "open",
      kalshiBuyOrderId: buyOrderId, minutesRemaining,
    }).returning().then(([trade]) => {
      posRef.tradeId = trade.id; // direct ref — works even if removed from openPositions
    }).catch(err => logger.warn({ err }, "enterTrade: DB write failed — position tracked in memory only"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await botLog("error", `Failed to enter trade on ${ticker}: ${msg}`);
    state.tradesAttempted = Math.max(0, state.tradesAttempted - 1);
  } finally {
    tradeMutex = false;
  }
}

// ─── Open positions ───────────────────────────────────────────────────────────
// In-memory list of all active trades — synced from DB on every sell-monitor tick
// so restarts / crashes never lose track of open positions.
interface OpenPosition {
  tradeId:             number;
  marketId:            string;
  side:                "YES" | "NO";
  entryPriceCents:     number;
  contractCount:       number;
  enteredAt:           number;   // ms timestamp
  buyOrderId:          string | null;
  pendingSellOrderId?: string | null;  // set when a sell order has been placed but not yet confirmed filled
  pendingSellAt?:      number | null;  // timestamp of pending sell placement
}

const openPositions: OpenPosition[] = [];

// Called immediately after a trade is inserted to DB so the monitor picks it up.
export function registerOpenPosition(pos: OpenPosition): OpenPosition {
  if (!openPositions.some(p => p.tradeId === pos.tradeId)) {
    openPositions.push(pos);
  }
  openMarkets.add(pos.marketId);
  state.openPositionCount = openPositions.length;
  return pos;
}

// ─── Execute a sell immediately via market order ──────────────────────────────
async function executeSell(
  pos: OpenPosition,
  currentBidCents: number,
  reason: string,
): Promise<boolean> {
  await botLog("info",
    `🔔 SELL TRIGGERED — Trade ${pos.tradeId} (${pos.side} @${pos.entryPriceCents}¢) | reason: ${reason} | bid: ${currentBidCents}¢`,
    { tradeId: pos.tradeId },
  );

  // ── Place the sell on Kalshi — limit at 1¢ guarantees fill (market orders not supported) ──
  // Near-settled markets (bid ≥90¢): only 1¢ below bid — tighter spread, faster fill
  const limitSellCents = currentBidCents >= 90
    ? Math.max(1, currentBidCents - 1)
    : Math.max(1, currentBidCents - 2);
  const payload = buildOrderPayload(
    pos.marketId, `sell-${Math.abs(pos.tradeId)}-${Date.now()}`, "limit", "sell", pos.side, pos.contractCount, limitSellCents,
  );

  let sellResp: { order?: { order_id?: string; status?: string; filled_count?: number; remaining_count?: number; yes_price?: number; no_price?: number } };
  try {
    sellResp = await kalshiFetch("POST", "/portfolio/orders", payload) as typeof sellResp;
  } catch (err) {
    await botLog("warn",
      `❌ SELL FAILED (Kalshi rejected) — Trade ${pos.tradeId}: ${String(err)}`,
      { tradeId: pos.tradeId, error: String(err) },
    );
    return false;
  }

  const sellOrderId   = sellResp?.order?.order_id ?? null;
  const orderStatus   = sellResp?.order?.status ?? "";
  const remainingQty  = sellResp?.order?.remaining_count ?? -1;
  const isFilledNow   = orderStatus === "filled" || remainingQty === 0;

  // ── Sell placed but not yet filled (resting limit order) ─────────────────
  // CRITICAL: do NOT remove from openPositions/openMarkets yet — the next scan
  // would otherwise re-enter this market, resulting in a double-buy.
  if (!isFilledNow && sellOrderId) {
    pos.pendingSellOrderId = sellOrderId;
    pos.pendingSellAt      = Date.now();
    await botLog("info",
      `⏳ SELL PENDING — Trade ${pos.tradeId} | order ${sellOrderId} is resting (not yet filled)`,
      { tradeId: pos.tradeId, sellOrderId },
    );
    return true;
  }

  // ── Immediately filled — commit removal ───────────────────────────────────
  const rawPrice  = pos.side === "YES"
    ? (sellResp?.order?.yes_price ?? 0)
    : (sellResp?.order?.no_price  ?? 0);
  const fillPrice = rawPrice > 0 ? Math.round(rawPrice * 100) : currentBidCents;
  // P&L is per-contract delta multiplied by contract count.
  const grossPerContract = fillPrice - pos.entryPriceCents;
  const grossTotal       = grossPerContract * pos.contractCount;
  const fee              = Math.floor(botConfig.feeRate * Math.max(0, grossTotal));
  const netPnl           = grossTotal - fee;

  const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
  if (idx >= 0) openPositions.splice(idx, 1);
  openMarkets.delete(pos.marketId);
  state.openPositionCount = openPositions.length;
  setMarketReentryCooldown(pos.marketId, "sell_filled_immediate", pos.tradeId);

  await botLog("info",
    `✅ SELL EXECUTED — Trade ${pos.tradeId} | fill ~${fillPrice}¢ | net ${netPnl >= 0 ? "+" : ""}${netPnl}¢`,
    { tradeId: pos.tradeId, fillPrice, netPnl },
  );

  // ── Update W/L counter in momentumBot state ───────────────────────────────
  fireTradeClosedHook(pos.entryPriceCents, fillPrice, netPnl);

  // ── DB update — fully fire-and-forget, never blocks ───────────────────────
  // pos.tradeId may still be a provisional negative ID if the buy DB write
  // hasn't completed yet. We try by real ID first; fall back to buyOrderId.
  const sellFields = {
    status: "closed" as const, sellPriceCents: fillPrice,
    pnlCents: netPnl, feeCents: fee,
    kalshiSellOrderId: sellOrderId, closedAt: new Date(),
  };

  const persistSell = () => {
    if (pos.tradeId > 0) {
      // Normal path: update by primary key
      db.update(tradesTable).set(sellFields)
        .where(eq(tradesTable.id, pos.tradeId))
        .catch(err => logger.warn({ err, tradeId: pos.tradeId }, "sell: DB update failed"));
    } else if (pos.buyOrderId) {
      // Fallback: buy DB write never resolved — update by Kalshi buy order ID
      logger.warn({ buyOrderId: pos.buyOrderId }, "sell: using buyOrderId fallback for DB update");
      db.update(tradesTable).set(sellFields)
        .where(eq(tradesTable.kalshiBuyOrderId, pos.buyOrderId))
        .catch(err => logger.warn({ err, buyOrderId: pos.buyOrderId }, "sell: buyOrderId fallback DB update failed"));
    } else {
      logger.warn({ provisId: pos.tradeId }, "sell: DB write skipped — no ID or buyOrderId available");
    }
  };

  if (pos.tradeId > 0) {
    persistSell();
  } else {
    // Wait 5 s for the async buy DB write to swap in the real ID, then persist
    setTimeout(persistSell, 5_000);
  }

  refreshDailyPnl().catch(() => {});
  return true;
}

// ─── Startup portfolio sync ──────────────────────────────────────────────────
// Queries Kalshi for any open positions not in the DB (e.g. after a DB reset or
// migration to a new database) and creates synthetic trade records so the monitor
// can track and auto-sell them.
export async function syncPortfolioFromKalshi(): Promise<void> {
  try {
    const posResp = await kalshiFetch("GET", "/portfolio/positions") as {
      positions?: Array<{ ticker_name?: string; position?: number; market_exposure?: number }>
    };
    // Treat ANY non-zero exposure as an open position.
    // Some APIs encode NO exposure as negative quantity; filtering only >0 can miss it.
    const positions = (posResp.positions ?? []).filter(p => (p.position ?? 0) !== 0);

    logger.info({ count: positions.length }, "syncPortfolioFromKalshi: Kalshi positions found");

    if (positions.length === 0) {
      await botLog("info", "🔄 Portfolio sync: no open Kalshi positions found");
      return;
    }

    // Use IN-MEMORY openPositions to detect duplicates — no DB read needed.
    // This works even when Neon is suspended.
    const trackedMarkets = new Set(openPositions.map(p => p.marketId));

    let imported = 0;
    for (const pos of positions) {
      const ticker = pos.ticker_name ?? "";
      if (!ticker || trackedMarkets.has(ticker)) continue; // already in memory

      try {
        const mResp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
        const m = mResp.market;
        if (!m) continue;

        let side: "YES" | "NO" = "YES";
        let buyPriceCents = 50;
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
        } catch (_) { /* use fallback 50¢ */ }

        // Register in memory IMMEDIATELY — no DB required
        // closeTs is critical: without it the expiry force-exit never fires after a restart.
        const closeTs = m.close_time ? new Date(m.close_time).getTime() : 0;
        const provisId = -(Date.now() + imported);
        registerOpenPosition({
          tradeId:         provisId,
          marketId:        ticker,
          side,
          entryPriceCents: buyPriceCents,
          contractCount:   pos.position ?? 1,
          enteredAt:       Date.now(),
          buyOrderId:      null,
        }, closeTs);
        imported++;

        logger.info({ ticker, side, buyPriceCents, provisId }, "syncPortfolioFromKalshi: registered orphaned position");
        await botLog("warn",
          `🔄 Portfolio sync: imported orphaned position — ${ticker} (${side} @${buyPriceCents}¢)`,
          { ticker, side, buyPriceCents },
        );

        // DB write fire-and-forget — swap provisional ID when it completes
        db.insert(tradesTable).values({
          marketId: ticker, marketTitle: m.title ?? ticker, side, buyPriceCents,
          contractCount: pos.position ?? 1, feeCents: 0, status: "open",
          minutesRemaining: m.close_time
            ? (new Date(m.close_time).getTime() - Date.now()) / 60_000 : null,
        }).returning().then(([trade]) => {
          const memPos = openPositions.find(p => p.tradeId === provisId);
          if (memPos) memPos.tradeId = trade.id;
        }).catch(err => logger.warn({ err, ticker }, "syncPortfolio: DB insert failed — position tracked in memory only"));

      } catch (err) {
        logger.warn({ err, ticker }, "syncPortfolioFromKalshi: failed to import position");
        await botLog("warn", `🔄 Portfolio sync: failed to import ${ticker} — ${String(err)}`);
      }
    }

    logger.info({ imported, total: positions.length }, "syncPortfolioFromKalshi: complete");
    await botLog("info", `🔄 Portfolio sync complete — ${imported} position(s) imported, ${positions.length - imported} already tracked`);
  } catch (err) {
    logger.warn({ err }, "syncPortfolioFromKalshi: failed");
    await botLog("warn", `🔄 Portfolio sync failed — ${String(err)}`);
  }
}

// ─── Sell monitor — runs every 2s ────────────────────────────────────────────
// DB-INDEPENDENT: openPositions[] is the ONLY source of truth.
// No DB reads ever. All DB writes are fire-and-forget. One position failing
// never stops the others. Bot continues even if DB is completely offline.
let sellMonitorRunning = false;
let sellMonitorTick    = 0;

export async function retryOpenPositions(): Promise<void> {
  // ── Single-instance lock ─────────────────────────────────────────────────
  if (sellMonitorRunning) return;
  sellMonitorRunning = true;
  sellMonitorTick++;

  try {
    state.openPositionCount = openPositions.length;

    // ── Heartbeat every tick (goes to Railway stdout) ────────────────────────
    logger.info(
      { tick: sellMonitorTick, openPositions: openPositions.length },
      "sell-monitor running",
    );

    if (openPositions.length === 0) return;

    // ── One portfolio-positions call for manual-sell detection (non-fatal) ───
    let livePositions: Array<{ ticker_name?: string; position?: number }> = [];
    try {
      const pr = await kalshiFetch("GET", "/portfolio/positions") as {
        positions?: Array<{ ticker_name?: string; position?: number }>
      };
      livePositions = pr.positions ?? [];
    } catch (_) { /* non-fatal — skip manual-sell detection this tick */ }

    const now = Date.now();

    for (const pos of [...openPositions]) {
      // ── Per-position try/catch: one bad position never kills the others ────
      try {
        const tradeAgeMs = now - pos.enteredAt;

        // ── Pending sell: poll fill status, cancel+retry if stuck >10s ─────────
        if (pos.pendingSellOrderId) {
          try {
            const or = await kalshiFetch("GET", `/portfolio/orders/${pos.pendingSellOrderId}`) as {
              order?: { status?: string; filled_count?: number; remaining_count?: number; yes_price?: number; no_price?: number }
            };
            const status    = or.order?.status ?? "";
            const filledQty = or.order?.filled_count ?? 0;
            const filled    = filledQty > 0 || ["filled", "settled", "executed"].includes(status);

            if (filled) {
              // Sell confirmed filled — commit removal
              const rawPrice  = pos.side === "YES" ? (or.order?.yes_price ?? 0) : (or.order?.no_price ?? 0);
              const fillPrice = rawPrice > 0 ? Math.round(rawPrice * 100) : pos.entryPriceCents;
              const grossPerContract = fillPrice - pos.entryPriceCents;
              const grossTotal       = grossPerContract * pos.contractCount;
              const fee              = Math.floor(botConfig.feeRate * Math.max(0, grossTotal));
              const netPnl           = grossTotal - fee;
              const idxP = openPositions.findIndex(p => p.tradeId === pos.tradeId);
              if (idxP >= 0) openPositions.splice(idxP, 1);
              openMarkets.delete(pos.marketId);
              state.openPositionCount = openPositions.length;
              firePositionRemovedCooldownHook(pos.marketId, "pending_sell_filled", pos.tradeId);
              fireTradeClosedHook(pos.entryPriceCents, fillPrice, netPnl);
              refreshDailyPnl().catch(() => {});
              if (pos.tradeId > 0) {
                db.update(tradesTable).set({ status: "closed", sellPriceCents: fillPrice, pnlCents: netPnl, feeCents: fee, closedAt: new Date() })
                  .where(eq(tradesTable.id, pos.tradeId)).catch(() => {});
              }
              await botLog("info", `✅ SELL CONFIRMED (pending→filled) — Trade ${pos.tradeId} | fill ~${fillPrice}¢ | net ${netPnl >= 0 ? "+" : ""}${netPnl}¢`, { tradeId: pos.tradeId });
              continue;
            }

            // Still resting — cancel and retry if stuck >10s
            const pendingAge = Date.now() - (pos.pendingSellAt ?? Date.now());
            if (pendingAge > 10_000) {
              try { await kalshiFetch("DELETE", `/portfolio/orders/${pos.pendingSellOrderId}`); } catch (_) {}
              pos.pendingSellOrderId = null;
              pos.pendingSellAt      = null;
              await botLog("warn", `🔁 SELL TIMED OUT — Trade ${pos.tradeId} — cancelling resting order, will retry`, { tradeId: pos.tradeId });
              // Fall through to TP/SL logic which will re-fire executeSell
            } else {
              continue; // Still within 10s window — keep waiting
            }
          } catch (_) {
            continue; // Can't check order status — keep waiting
          }
        }

        // ── Cancel if buy never filled (60–90s window) ──────────────────────
        if (tradeAgeMs >= 60_000 && tradeAgeMs < 90_000 && pos.buyOrderId) {
          try {
            const or = await kalshiFetch("GET", `/portfolio/orders/${pos.buyOrderId}`) as {
              order?: { status?: string; filled_count?: number }
            };
            const status  = or.order?.status ?? "";
            const filled  = (or.order?.filled_count ?? 0) > 0 ||
              ["filled", "settled", "executed"].includes(status);
            const resting = !filled && ["resting", "open", "pending"].includes(status);

            if (resting) {
              try { await kalshiFetch("DELETE", `/portfolio/orders/${pos.buyOrderId}`); } catch (_) {}
              const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
              if (idx >= 0) openPositions.splice(idx, 1);
              openMarkets.delete(pos.marketId);
              state.openPositionCount = openPositions.length;
              firePositionRemovedCooldownHook(pos.marketId, "buy_order_cancelled", pos.tradeId);
              // DB write — fire-and-forget, non-blocking
              if (pos.tradeId > 0) {
                db.update(tradesTable)
                  .set({ status: "cancelled", closedAt: new Date() })
                  .where(eq(tradesTable.id, pos.tradeId))
                  .catch(e => logger.warn({ err: e }, "sell-monitor: cancel DB write failed"));
              }
              botLog("warn",
                `🚫 Trade ${pos.tradeId} cancelled — buy order still resting after 60s`,
                { tradeId: pos.tradeId },
              ).catch(() => {});
              continue;
            }
          } catch (_) { /* can't verify fill status — keep holding */ }
        }

        // ── Detect manual sell (position gone from Kalshi) ──────────────────
        if (livePositions.length > 0 && tradeAgeMs > 30_000) {
          const remaining = (livePositions.find(p => p.ticker_name === pos.marketId)?.position) ?? 0;
          if (remaining === 0) {
            let sellPriceCents = 0;
            let pnlCents       = 0;
            try {
              const fr = await kalshiFetch("GET", `/portfolio/fills?ticker=${pos.marketId}&limit=20`) as {
                fills?: Array<{ action?: string; yes_price?: number; no_price?: number }>
              };
              const sellFill = (fr.fills ?? []).find(f => f.action === "sell");
              if (sellFill) {
                const rawFp = pos.side === "YES" ? (sellFill.yes_price ?? 0) : (sellFill.no_price ?? 0);
                if (rawFp > 0) {
                  sellPriceCents = Math.round(rawFp * 100);
                  const grossPerContract = sellPriceCents - pos.entryPriceCents;
                  const grossTotal       = grossPerContract * pos.contractCount;
                  const fee              = Math.floor(botConfig.feeRate * Math.max(0, grossTotal));
                  pnlCents               = grossTotal - fee;
                }
              }
            } catch (_) { /* fill lookup failed — use zero */ }

            const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
            if (idx >= 0) openPositions.splice(idx, 1);
            // NOTE: intentionally NOT deleting from openMarkets — keeps this market period
            // locked so the bot cannot immediately re-buy the same market after a manual sell.
            // The lock expires naturally when a new 15-min period begins (different market ID).
            state.openPositionCount = openPositions.length;
            firePositionRemovedCooldownHook(pos.marketId, "manual_sell_detected", pos.tradeId);
            // DB write — fire-and-forget
            if (pos.tradeId > 0) {
              db.update(tradesTable).set({
                status: "closed", pnlCents,
                sellPriceCents: sellPriceCents || undefined,
                closedAt: new Date(),
              }).where(eq(tradesTable.id, pos.tradeId))
                .catch(e => logger.warn({ err: e }, "sell-monitor: manual-sell DB write failed"));
            }
            botLog("info",
              `🖐 Trade ${pos.tradeId} manually closed | sell ~${sellPriceCents}¢ | net ${pnlCents >= 0 ? "+" : ""}${pnlCents}¢ | market locked until period ends`,
              { tradeId: pos.tradeId },
            ).catch(() => {});
            fireTradeClosedHook(pos.entryPriceCents, sellPriceCents || pos.entryPriceCents, pnlCents);
            refreshDailyPnl().catch(() => {});
            continue;
          }
        }

        // ── Fetch current market from Kalshi (only Kalshi API, no DB) ────────
        const mResp  = await kalshiFetch("GET", `/markets/${pos.marketId}`) as { market?: KalshiMarket };
        const m      = mResp.market;
        const isLive = !m?.status || m.status === "open" || m.status === "active";

        // ── Market settled / expired ─────────────────────────────────────────
        if (!m || !isLive) {
          const settled    = m?.status === "settled" || m?.status === "finalized";
          const ourSideWon = settled && m?.result?.toLowerCase() === pos.side.toLowerCase();
          const pnlCents   = ourSideWon
            ? (() => {
                const grossTotal = (100 - pos.entryPriceCents) * pos.contractCount;
                return grossTotal - Math.floor(botConfig.feeRate * grossTotal);
              })()
            : -(pos.entryPriceCents * pos.contractCount);

          const idx = openPositions.findIndex(p => p.tradeId === pos.tradeId);
          if (idx >= 0) openPositions.splice(idx, 1);
          openMarkets.delete(pos.marketId);
          state.openPositionCount = openPositions.length;
          firePositionRemovedCooldownHook(pos.marketId, "market_closed_or_settled", pos.tradeId);
          // DB write — fire-and-forget
          if (pos.tradeId > 0) {
            db.update(tradesTable).set({
              status:   settled && ourSideWon ? "closed" : "expired",
              pnlCents, closedAt: new Date(),
            }).where(eq(tradesTable.id, pos.tradeId))
              .catch(e => logger.warn({ err: e }, "sell-monitor: settlement DB write failed"));
          }
          botLog(ourSideWon ? "info" : "warn",
            ourSideWon
              ? `🏆 Trade ${pos.tradeId} settled — WON +${pnlCents}¢`
              : `💸 Trade ${pos.tradeId} settled — lost ${pos.entryPriceCents}¢`,
            { tradeId: pos.tradeId },
          ).catch(() => {});
          fireTradeClosedHook(pos.entryPriceCents, ourSideWon ? 100 : 0, pnlCents);
          refreshDailyPnl().catch(() => {});
          continue;
        }

        // ── Live market — evaluate sell conditions (no DB) ───────────────────
        const currentBid  = pos.side === "YES" ? priceCents(m, "yes_bid") : priceCents(m, "no_bid");
        const minsLeft    = (new Date(m.close_time).getTime() - now) / 60_000;
        const grossProfit = currentBid - pos.entryPriceCents;

        await botLog("info",
          `🔍 Trade ${pos.tradeId} (${pos.side} @${pos.entryPriceCents}¢) | bid: ${currentBid}¢ | profit: ${grossProfit >= 0 ? "+" : ""}${grossProfit}¢ | ${minsLeft.toFixed(1)}min left`,
          { tradeId: pos.tradeId },
        );

        // Near-settled exit — bid ≥90¢ means market is basically decided, grab profit now
        // at 90¢+ there's almost no liquidity and waiting risks holding to expiry
        if (currentBid >= 90 && grossProfit > 0) {
          await executeSell(pos, currentBid, `near-settled bid:${currentBid}¢ (+${grossProfit}¢)`);
          continue;
        }

        // Stop-loss — cut losses when down ≥3¢ (mirrors sim SL).
        // If bid is 0, treat executable exit as 1¢ to avoid getting stuck unprotected.
        const slExecutablePrice = currentBid > 0 ? currentBid : 1;
        const slGrossProfit = slExecutablePrice - pos.entryPriceCents;
        if (slGrossProfit <= -3) {
          await executeSell(pos, slExecutablePrice, `stop-loss (${slGrossProfit}¢)`);
          continue;
        }

        // Take-profit
        if (currentBid > 0 && grossProfit >= botConfig.minNetProfitCents) {
          await executeSell(pos, currentBid, `take-profit (+${grossProfit}¢)`);
          continue;
        }

        // Exit-window — force sell before expiry
        if (minsLeft > 0 && minsLeft <= botConfig.exitWindowMins) {
          await executeSell(pos, Math.max(currentBid, 1), `exit-window (${minsLeft.toFixed(1)}min left)`);
          continue;
        }

        // Safety net — force exit if held >20 min
        if (tradeAgeMs > 20 * 60_000) {
          await executeSell(pos, Math.max(currentBid, 1), "force-expiry (>20min held)");
          continue;
        }

      } catch (posErr) {
        // One position erroring never stops the others
        logger.warn({ err: posErr, tradeId: pos.tradeId }, "sell-monitor: position check failed — continuing");
        botLog("warn",
          `❌ Sell monitor error — Trade ${pos.tradeId}: ${String(posErr)}`,
          { tradeId: pos.tradeId },
        ).catch(() => {});
      }
    }

  } catch (err) {
    logger.error({ err }, "sell-monitor: unexpected top-level error");
  } finally {
    sellMonitorRunning = false;
  }
}

// ─── Public bot controls ─────────────────────────────────────────────────────
export function getBotState(): BotState {
  return { ...state };
}

export async function startBot(): Promise<BotState> {
  // Legacy bot pipeline is intentionally retired.
  // Single active execution path is momentumBot: signal -> gate -> execute -> update state.
  logger.warn("legacy startBot() invocation blocked; use momentum bot controls");
  return getBotState();

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
  marketReentryCooldowns.clear();
  lastIdleScanLogMs = 0;   // always show first scan result

  // Re-hydrate openPositions + openMarkets from DB so the sell monitor
  // picks up any trades that were open before this restart.
  // Non-fatal: if the DB is unavailable, sells won't fire for pre-restart trades
  // but any NEW trades placed after restart will be tracked via registerOpenPosition().
  try {
    const existingOpen = await db.select().from(tradesTable).where(eq(tradesTable.status, "open"));
    openMarkets.clear();
    openPositions.length = 0;
    for (const t of existingOpen) {
      openMarkets.add(t.marketId);
      openPositions.push({
        tradeId:         t.id,
        marketId:        t.marketId,
        side:            t.side as "YES" | "NO",
        entryPriceCents: t.buyPriceCents,
        contractCount:   t.contractCount,
        enteredAt:       t.createdAt.getTime(),
        buyOrderId:      t.kalshiBuyOrderId ?? null,
      });
    }

    // Restore recent closed/cancelled/expired trades into cooldown map so restarts
    // do not immediately re-enter the same ticker while the old market is still live.
    const cutoff = new Date(Date.now() - MARKET_REENTRY_COOLDOWN_MS);
    const recentlyClosed = await db
      .select({
        tradeId: tradesTable.id,
        marketId: tradesTable.marketId,
        closedAt: tradesTable.closedAt,
      })
      .from(tradesTable)
      .where(and(ne(tradesTable.status, "open"), gte(tradesTable.closedAt, cutoff)));

    let restoredCooldowns = 0;
    for (const t of recentlyClosed) {
      if (!t.closedAt) continue;
      const untilMs = t.closedAt.getTime() + MARKET_REENTRY_COOLDOWN_MS;
      if (untilMs <= Date.now()) continue;
      const prev = marketReentryCooldowns.get(t.marketId) ?? 0;
      if (untilMs > prev) {
        marketReentryCooldowns.set(t.marketId, untilMs);
        restoredCooldowns++;
      }
    }

    state.openPositionCount = openPositions.length;
    if (openPositions.length > 0) {
      logger.info({ count: openPositions.length }, "startBot: hydrated open positions from DB");
    }
    if (restoredCooldowns > 0) {
      logger.info({ restoredCooldowns }, "startBot: restored market re-entry cooldowns");
    }
  } catch (dbErr) {
    logger.warn({ err: dbErr }, "startBot: DB hydration failed — new trades will still be monitored via registerOpenPosition()");
  }

  await refreshBalance();
  await refreshDailyPnl();

  const cats = botConfig.marketCategories.join("+");
  await botLog("info",
    `🤖 Instinct Scalper started — trading ${cats} | entry ≤${botConfig.maxEntryPriceCents}¢ | target ${botConfig.minNetProfitCents}–${botConfig.maxNetProfitCents}¢ net | max ${botConfig.maxOpenPositions} positions`,
  );

  retryOpenPositions(); // immediate pass — clears any stale open trades from before restart
  scanMarkets();
  scanTimer    = setInterval(scanMarkets,           botConfig.pollIntervalSecs * 1000);
  sellTimer    = setInterval(retryOpenPositions,    2_000);   // sell monitor: every 2s
  balanceTimer = setInterval(refreshBalance,        60_000);

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
  logger.warn({ ticker, side, limitCents, quantity }, "legacy manualTrade() invocation blocked");
  return {
    success: false,
    message: "Manual trade path disabled. ACTIVE TRADE PATHS: 1 (signal -> gate -> execute -> update state).",
  };

  let gateLocked = false;
  try {
    const lock = await acquireTradeEntryGate(ticker, "manual_trade");
    if (!lock.allowed) {
      return { success: false, message: lock.reason ?? `Trade gate blocked ${ticker}` };
    }
    gateLocked = true;
    const balanceGate = await assertSafeToEnterTrade({
      stopBotOnFloorHit: true,
      context: `manual trade ${ticker}`,
    });
    if (!balanceGate.ok) {
      gateLocked = false;
      releaseTradeEntryGate(ticker, "manual_trade_balance_blocked");
      return { success: false, message: balanceGate.reason ?? "Balance safety gate blocked manual trade" };
    }

    const cooldownRemainingMs = getMarketReentryCooldownRemainingMs(ticker);
    if (cooldownRemainingMs > 0) {
      gateLocked = false;
      releaseTradeEntryGate(ticker, "manual_trade_cooldown_blocked");
      return {
        success: false,
        message: `Cooldown active for ${ticker} (${Math.ceil(cooldownRemainingMs / 1000)}s remaining)`,
      };
    }

    const resp = await kalshiFetch("GET", `/markets/${ticker}`) as { market?: KalshiMarket };
    if (!resp.market) {
      gateLocked = false;
      releaseTradeEntryGate(ticker, "manual_trade_market_not_found");
      return { success: false, message: `Market not found: ${ticker}` };
    }
    const { title, close_time } = resp.market;
    const minutesLeft = (new Date(close_time).getTime() - Date.now()) / 60_000;

    const buyResp = await kalshiFetch("POST", "/portfolio/orders",
      buildOrderPayload(ticker, `manual-${Date.now()}`, "limit", "buy", side as "YES" | "NO", quantity, limitCents),
    ) as { order?: { order_id?: string } };

    const buyOrderId = buyResp?.order?.order_id ?? null;
    const now        = Date.now();
    const provisId   = -now;

    // ── Register IMMEDIATELY in memory ────────────────────────────────────────
    openMarkets.add(ticker);
    state.openPositionCount = openMarkets.size;
    const posRef = registerOpenPosition({
      tradeId:         provisId,
      marketId:        ticker,
      side,
      entryPriceCents: limitCents,
      contractCount:   quantity,
      enteredAt:       now,
      buyOrderId,
    });

    await botLog("info",
      `🎯 Manual: bought ${quantity}x ${side} on "${title}" at ${limitCents}¢ — order ${buyOrderId ?? "(no id)"}`,
      { buyOrderId },
    );

    // ── DB write fire-and-forget ───────────────────────────────────────────────
    db.insert(tradesTable).values({
      marketId: ticker, marketTitle: title ?? ticker, side,
      buyPriceCents: limitCents, contractCount: quantity, feeCents: 0,
      status: "open", kalshiBuyOrderId: buyOrderId, minutesRemaining: minutesLeft,
    }).returning().then(([trade]) => {
      posRef.tradeId = trade.id; // direct ref — works even if removed from openPositions
    }).catch(err => logger.warn({ err }, "manualTrade: DB write failed — position tracked in memory only"));

    return {
      success: true,
      tradeId: provisId,
      orderId: buyOrderId,
      message: `Order placed: ${quantity}x ${side} @ ${limitCents}¢ on ${ticker}`,
    };
  } catch (err) {
    const msg = String(err);
    await botLog("error", `🎯 Manual trade failed on ${ticker}: ${msg}`);
    return { success: false, message: msg };
  } finally {
    if (gateLocked) {
      releaseTradeEntryGate(ticker, "manual_trade_done");
    }
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
    const idx = openPositions.findIndex(p => p.tradeId === trade.id);
    if (idx >= 0) openPositions.splice(idx, 1);
    setMarketReentryCooldown(trade.marketId, "force_clear", trade.id);
    await botLog("warn", `🧹 Trade ${trade.id} force-cleared via dashboard reset`, { tradeId: trade.id });
  }
  state.openPositionCount = 0;
  return { cleared: openTrades.length };
}

// ─── Shared position gate (exchange-backed) for all bots ──────────────────────
const POSITION_SYNC_MS = 5_000;
let lastPositionSyncAt = 0;
let lastPositionSyncOkAt = 0;
let lastPositionSyncError: string | null = null;
const exchangeOpenAssets = new Set<string>(); // asset labels, e.g. BTC/ETH/SOL
const ENTRY_LOCK_TTL_MS = 45_000;
const GLOBAL_MAX_OPEN_POSITIONS = 2;
const ENTRY_LOCK_OWNER_ID = `${process.pid}-${crypto.randomUUID()}`;
const INTENT_WINDOW_MS = 30_000;
const ENTRY_CONFIRM_WINDOW_MS = 20_000;

function assetLabel(ticker: string): string {
  const up = ticker.toUpperCase();
  const aliases: Array<{ asset: string; keys: string[] }> = [
    { asset: "BTC", keys: ["BTC", "BITCOIN", "KXBTC"] },
    { asset: "ETH", keys: ["ETH", "ETHEREUM", "KXETH"] },
    { asset: "SOL", keys: ["SOL", "SOLANA", "KXSOL"] },
    { asset: "DOGE", keys: ["DOGE", "DOGECOIN", "KXDOGE"] },
    { asset: "XRP", keys: ["XRP", "RIPPLE", "KXXRP"] },
    { asset: "ADA", keys: ["ADA", "CARDANO", "KXADA"] },
    { asset: "MATIC", keys: ["MATIC", "POLYGON", "KXMATIC"] },
    { asset: "BNB", keys: ["BNB", "KXBNB"] },
  ];
  for (const a of aliases) {
    if (a.keys.some(k => up.includes(k))) return a.asset;
  }
  return up;
}

export function canonicalizeAssetLabel(assetOrTicker: string): string {
  return assetLabel(assetOrTicker);
}

interface ParsedExchangePositionRow {
  ticker: string;
  asset: string;
  hasExposure: boolean;
}

interface ParsedExchangePositions {
  rows: ParsedExchangePositionRow[];
  rawCount: number;
  openCount: number;
  suspiciousCount: number;
  suspicious: boolean;
}

function parseMaybeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseExchangePositionsPayload(positionsPayload: unknown): ParsedExchangePositions {
  const rows = Array.isArray(positionsPayload) ? positionsPayload : [];
  const parsedRows: ParsedExchangePositionRow[] = [];
  let openCount = 0;
  let suspiciousCount = 0;

  for (const rowRaw of rows) {
    if (!rowRaw || typeof rowRaw !== "object") {
      suspiciousCount++;
      continue;
    }
    const row = rowRaw as Record<string, unknown>;
    const tickerRaw = row.ticker_name ?? row.ticker;
    const ticker = typeof tickerRaw === "string" ? tickerRaw.trim() : "";
    const rawNumbers = [
      row.position,
      row.position_fp,
      row.market_exposure,
      row.market_exposure_cents,
    ];
    const parsedNumbers = rawNumbers
      .map(parseMaybeNumber)
      .filter((v): v is number => v !== null);
    const hasKnownNumericField =
      hasOwn(row, "position") ||
      hasOwn(row, "position_fp") ||
      hasOwn(row, "market_exposure") ||
      hasOwn(row, "market_exposure_cents");
    const hasUnparseableNumeric =
      rawNumbers.some((v) => v !== undefined && v !== null && String(v).trim() !== "" && parseMaybeNumber(v) === null);
    const hasNonZeroExposure = parsedNumbers.some((v) => v !== 0);

    if (hasNonZeroExposure && ticker) {
      openCount++;
      parsedRows.push({ ticker, asset: assetLabel(ticker), hasExposure: true });
    }

    const suspiciousRow =
      hasUnparseableNumeric ||
      (ticker && !hasKnownNumericField) ||
      (ticker && hasKnownNumericField && parsedNumbers.length === 0) ||
      (hasNonZeroExposure && !ticker);

    if (suspiciousRow) suspiciousCount++;
  }

  return {
    rows: parsedRows,
    rawCount: rows.length,
    openCount,
    suspiciousCount,
    suspicious: rows.length > 0 && suspiciousCount > 0,
  };
}

export function parseExchangePositionRows(positionsPayload: unknown): {
  ok: boolean;
  reason?: string;
  rows: ParsedExchangePositionRow[];
} {
  const parsed = parseExchangePositionsPayload(positionsPayload);
  if (parsed.suspicious) {
    return {
      ok: false,
      reason: `rows=${parsed.rawCount} suspicious=${parsed.suspiciousCount}`,
      rows: [],
    };
  }
  return { ok: true, rows: parsed.rows };
}

function hasFreshPositionSnapshot(): boolean {
  if (lastPositionSyncOkAt <= 0) return false;
  return Date.now() - lastPositionSyncOkAt <= POSITION_SYNC_MS * 3;
}

async function refreshExchangeOpenAssets(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && now - lastPositionSyncAt < POSITION_SYNC_MS) {
    return hasFreshPositionSnapshot();
  }
  lastPositionSyncAt = now;
  try {
    const pr = await kalshiFetch("GET", "/portfolio/positions") as {
      positions?: unknown;
    };
    const parsed = parseExchangePositionsPayload(pr.positions);
    if (parsed.suspicious) {
      lastPositionSyncError = `positions payload parse anomaly: rows=${parsed.rawCount} suspicious=${parsed.suspiciousCount}`;
      logger.warn(
        { rawCount: parsed.rawCount, suspiciousCount: parsed.suspiciousCount, openCount: parsed.openCount },
        "position gate: refusing to trust unparseable positions payload",
      );
      return false;
    }
    exchangeOpenAssets.clear();
    for (const row of parsed.rows) {
      if (row.hasExposure) {
        exchangeOpenAssets.add(row.asset);
      }
    }
    lastPositionSyncOkAt = Date.now();
    lastPositionSyncError = null;
    return true;
  } catch (err) {
    lastPositionSyncError = String(err);
    logger.warn({ err }, "position gate: exchange sync failed");
    return false;
  }
}

type QueryRows<T extends Record<string, unknown>> = { rows?: T[] };

function extractQueryRows<T extends Record<string, unknown>>(result: unknown): T[] {
  const maybeRows = (result as QueryRows<T> | null)?.rows;
  return Array.isArray(maybeRows) ? maybeRows : [];
}

async function getTradeLockRow(asset: string): Promise<{
  ok: boolean;
  exists: boolean;
  ownerId: string | null;
  intentStartedAt: Date | null;
  state: string | null;
  error: string | null;
}> {
  try {
    const result = await db.execute(
      sql`
        SELECT owner_id, intent_created_at, state
        FROM trade_locks
        WHERE asset = ${asset}
        LIMIT 1
      `,
    );
    const rows = extractQueryRows<{
      owner_id: string | null;
      intent_created_at: Date | string | null;
      state: string | null;
    }>(result);
    if (rows.length === 0) {
      return { ok: true, exists: false, ownerId: null, intentStartedAt: null, state: null, error: null };
    }
    const row = rows[0]!;
    const startedAt = row.intent_created_at
      ? (row.intent_created_at instanceof Date ? row.intent_created_at : new Date(row.intent_created_at))
      : null;
    return {
      ok: true,
      exists: true,
      ownerId: row.owner_id ?? null,
      intentStartedAt: startedAt,
      state: row.state ?? null,
      error: null,
    };
  } catch (err) {
    const message = String(err);
    logger.warn({ err, asset }, "trade lock: failed reading lock row");
    return { ok: false, exists: true, ownerId: null, intentStartedAt: null, state: null, error: message };
  }
}

async function acquireAtomicTradeLock(asset: string): Promise<{ ok: boolean; acquired: boolean; error: string | null }> {
  try {
    await db.execute(
      sql`
        INSERT INTO trade_locks (asset, owner_id, state, intent_created_at, expires_at, created_at, updated_at)
        VALUES (
          ${asset},
          ${ENTRY_LOCK_OWNER_ID},
          'locked',
          NOW(),
          NOW() + (${ENTRY_LOCK_TTL_MS} * INTERVAL '1 millisecond'),
          NOW(),
          NOW()
        )
      `,
    );
    return { ok: true, acquired: true, error: null };
  } catch (err) {
    const message = String(err);
    const conflict = message.includes("duplicate key value");
    if (conflict) {
      return { ok: true, acquired: false, error: null };
    }
    logger.warn({ err, asset }, "trade lock: acquisition failed");
    return { ok: false, acquired: false, error: message };
  }
}

async function markTradeIntent(asset: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    await db.execute(
      sql`
        UPDATE trade_locks
        SET state = 'intent',
            intent_created_at = NOW(),
            expires_at = NOW() + (${INTENT_WINDOW_MS} * INTERVAL '1 millisecond'),
            updated_at = NOW()
        WHERE asset = ${asset}
          AND owner_id = ${ENTRY_LOCK_OWNER_ID}
      `,
    );
    return { ok: true, error: null };
  } catch (err) {
    const message = String(err);
    logger.warn({ err, asset }, "trade lock: intent marker update failed");
    return { ok: false, error: message };
  }
}

async function releaseAtomicTradeLock(asset: string): Promise<void> {
  try {
    await db.execute(
      sql`
        DELETE FROM trade_locks
        WHERE asset = ${asset}
          AND owner_id = ${ENTRY_LOCK_OWNER_ID}
      `,
    );
  } catch (err) {
    logger.warn({ err, asset }, "trade lock: release failed");
  }
}

async function finalizeTradeIntent(asset: string, state: "confirmed" | "rolled_back"): Promise<void> {
  try {
    await db.execute(
      sql`
        UPDATE trade_locks
        SET state = ${state}, updated_at = NOW()
        WHERE asset = ${asset}
          AND owner_id = ${ENTRY_LOCK_OWNER_ID}
      `,
    );
  } catch (err) {
    logger.warn({ err, asset, state }, "trade lock: finalize state update failed");
  }
}

async function cleanupStaleTradeLock(asset: string, lock: {
  ownerId: string | null;
  intentStartedAt: Date | null;
  state: string | null;
}): Promise<void> {
  const startedMs = lock.intentStartedAt ? lock.intentStartedAt.getTime() : 0;
  const staleIntent = startedMs > 0 && Date.now() - startedMs > INTENT_WINDOW_MS;
  const staleUnknown = !lock.intentStartedAt && lock.state !== "confirmed";
  if (!staleIntent && !staleUnknown) return;
  try {
    await db.execute(
      sql`
        DELETE FROM trade_locks
        WHERE asset = ${asset}
          AND owner_id = ${lock.ownerId ?? ""}
      `,
    );
    logger.warn(
      { asset, ownerId: lock.ownerId, state: lock.state, startedAt: lock.intentStartedAt?.toISOString() ?? null },
      "trade lock: cleaned stale lock",
    );
  } catch (err) {
    logger.warn({ err, asset }, "trade lock: stale cleanup failed");
  }
}

async function getGlobalOpenPositionCount(): Promise<{ ok: boolean; count: number; error: string | null }> {
  try {
    const rows = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(tradesTable)
      .where(eq(tradesTable.status, "open"));
    return { ok: true, count: rows[0]?.count ?? 0, error: null };
  } catch (err) {
    const message = String(err);
    logger.warn({ err }, "position gate: global open position count query failed");
    return { ok: false, count: 0, error: message };
  }
}

export interface SharedTradeGateStatus {
  asset: string;
  openPosition: boolean;
  entryLocked: boolean;
  lockState: string | null;
  lockOwnerId: string | null;
  intentMarked: boolean;
  exchangeSyncOk: boolean;
  lastError: string | null;
}

function readTradeGateStatus(assetOrTicker: string, lockState: string | null, lockOwnerId: string | null): SharedTradeGateStatus {
  const asset = assetLabel(assetOrTicker);
  const intentMarked =
    lockState === "intent" ||
    lockState === "confirmed";
  return {
    asset,
    openPosition: exchangeOpenAssets.has(asset),
    entryLocked: lockOwnerId !== null,
    lockState,
    lockOwnerId,
    intentMarked,
    exchangeSyncOk: hasFreshPositionSnapshot(),
    lastError: lastPositionSyncError,
  };
}

export async function getSharedTradeGateStatus(assetOrTicker: string): Promise<SharedTradeGateStatus> {
  const syncOk = await refreshExchangeOpenAssets();
  const asset = assetLabel(assetOrTicker);
  const lock = await getTradeLockRow(asset);
  if (lock.ok && lock.exists) {
    await cleanupStaleTradeLock(asset, {
      ownerId: lock.ownerId,
      intentStartedAt: lock.intentStartedAt,
      state: lock.state,
    });
  }
  const status = readTradeGateStatus(asset, lock.state, lock.ownerId);
  return {
    ...status,
    exchangeSyncOk: syncOk || status.exchangeSyncOk,
    lastError: lock.error ?? status.lastError,
  };
}

export async function canEnterAssetTrade(assetOrTicker: string): Promise<{ ok: boolean; reason?: string; status: SharedTradeGateStatus }> {
  const asset = assetLabel(assetOrTicker);
  const exchangeSyncOk = await refreshExchangeOpenAssets();
  const lock = await getTradeLockRow(asset);
  if (lock.ok && lock.exists) {
    await cleanupStaleTradeLock(asset, {
      ownerId: lock.ownerId,
      intentStartedAt: lock.intentStartedAt,
      state: lock.state,
    });
  }
  const lockAfterCleanup = await getTradeLockRow(asset);
  const globalCount = await getGlobalOpenPositionCount();
  const status = readTradeGateStatus(asset, lockAfterCleanup.state, lockAfterCleanup.ownerId);
  const effectiveExchangeSyncOk = exchangeSyncOk || status.exchangeSyncOk;
  const lastError = lockAfterCleanup.error ?? globalCount.error ?? status.lastError;
  logger.info(
    {
      asset: status.asset,
      openPosition: status.openPosition,
      entryLocked: status.entryLocked,
      lockState: status.lockState,
      lockOwnerId: status.lockOwnerId,
      globalOpenPositions: globalCount.count,
      exchangeSyncOk: effectiveExchangeSyncOk,
      lastError,
    },
    `[TRADE GATE] asset=${status.asset}, openPosition=${status.openPosition}, entryLocked=${status.entryLocked}`,
  );
  if (!effectiveExchangeSyncOk) {
    return { ok: false, reason: "exchange_sync_unavailable", status: { ...status, exchangeSyncOk: false, lastError } };
  }
  if (!lockAfterCleanup.ok) {
    return { ok: false, reason: "entry_lock_unavailable", status: { ...status, lastError } };
  }
  if (!globalCount.ok) {
    return { ok: false, reason: "position_count_unavailable", status: { ...status, lastError } };
  }
  if (globalCount.count >= GLOBAL_MAX_OPEN_POSITIONS) {
    return { ok: false, reason: "max_positions_reached", status };
  }
  if (status.openPosition) {
    return { ok: false, reason: "has_open_position", status };
  }
  if (status.entryLocked) {
    return { ok: false, reason: "entry_in_progress", status };
  }
  return { ok: true, status };
}

export interface TradeEntryGateResult {
  allowed: boolean;
  asset: string;
  openPosition: boolean;
  entryLocked: boolean;
  lockState: string | null;
  lockOwnerId: string | null;
  intentMarked: boolean;
  reason?: string;
}

export async function acquireTradeEntryGate(assetOrTicker: string, _context?: string): Promise<TradeEntryGateResult> {
  const asset = assetLabel(assetOrTicker);
  // Acquire DB atomic lock FIRST, before any async checks.
  const lock = await acquireAtomicTradeLock(asset);
  if (!lock.ok) {
    return {
      allowed: false,
      asset,
      openPosition: false,
      entryLocked: true,
      lockState: null,
      lockOwnerId: null,
      intentMarked: false,
      reason: "entry_lock_unavailable",
    };
  }
  if (!lock.acquired) {
    const current = await getTradeLockRow(asset);
    return {
      allowed: false,
      asset,
      openPosition: false,
      entryLocked: true,
      lockState: current.state,
      lockOwnerId: current.ownerId,
      intentMarked: false,
      reason: "entry_in_progress",
    };
  }
  const intent = await markTradeIntent(asset);
  if (!intent.ok) {
    await releaseAtomicTradeLock(asset);
    return {
      allowed: false,
      asset,
      openPosition: false,
      entryLocked: false,
      lockState: null,
      lockOwnerId: null,
      intentMarked: false,
      reason: "intent_marker_failed",
    };
  }

  const check = await canEnterAssetTrade(asset);
  if (!check.ok) {
    await finalizeTradeIntent(asset, "rolled_back");
    await releaseAtomicTradeLock(asset);
    return {
      allowed: false,
      asset,
      openPosition: check.status.openPosition,
      entryLocked: check.status.entryLocked,
      lockState: check.status.lockState,
      lockOwnerId: check.status.lockOwnerId,
      intentMarked: true,
      reason: check.reason,
    };
  }

  const postAcquireSyncOk = await refreshExchangeOpenAssets(true);
  const postAcquireOpen = exchangeOpenAssets.has(asset);
  if (!postAcquireSyncOk && !hasFreshPositionSnapshot()) {
    await finalizeTradeIntent(asset, "rolled_back");
    await releaseAtomicTradeLock(asset);
    return {
      allowed: false,
      asset,
      openPosition: postAcquireOpen,
      entryLocked: false,
      lockState: null,
      lockOwnerId: null,
      intentMarked: true,
      reason: "exchange_sync_unavailable",
    };
  }
  if (postAcquireOpen) {
    await finalizeTradeIntent(asset, "rolled_back");
    await releaseAtomicTradeLock(asset);
    return {
      allowed: false,
      asset,
      openPosition: true,
      entryLocked: false,
      lockState: null,
      lockOwnerId: null,
      intentMarked: true,
      reason: "has_open_position",
    };
  }

  logger.info(
    { asset, openPosition: false, entryLocked: true, lockState: "intent", lockOwnerId: ENTRY_LOCK_OWNER_ID },
    `[TRADE GATE] asset=${asset}, openPosition=false, entryLocked=true`,
  );
  return {
    allowed: true,
    asset,
    openPosition: false,
    entryLocked: true,
    lockState: "intent",
    lockOwnerId: ENTRY_LOCK_OWNER_ID,
    intentMarked: true,
  };
}

export function releaseTradeEntryGate(
  assetOrTicker: string,
  _context?: string,
  options?: { keepDistributedLockMs?: number; finalState?: "confirmed" | "rolled_back" },
): void {
  const asset = assetLabel(assetOrTicker);
  const finalState = options?.finalState ?? "rolled_back";
  const keepMs = Math.max(0, Math.floor(options?.keepDistributedLockMs ?? 0));
  if (keepMs > 0) {
    // Confirmation window: keep lock while waiting for external position propagation.
    void db.execute(
      sql`
        UPDATE trade_locks
        SET state = ${finalState},
            intent_created_at = NOW(),
            intent_expires_at = NOW() + (${keepMs} * INTERVAL '1 millisecond'),
            updated_at = NOW()
        WHERE asset = ${asset}
          AND owner_id = ${ENTRY_LOCK_OWNER_ID}
      `,
    ).then(() => {
      setTimeout(() => {
        void releaseAtomicTradeLock(asset);
      }, keepMs);
    }).catch((err) => {
      logger.warn({ err, asset }, "trade lock: delayed release scheduling failed");
      void releaseAtomicTradeLock(asset);
    });
    return;
  }
  void finalizeTradeIntent(asset, finalState).then(() => releaseAtomicTradeLock(asset));
}

export function hasOpenPositionFromExchange(assetOrTicker: string): boolean {
  return exchangeOpenAssets.has(assetLabel(assetOrTicker));
}

export function isAssetEntryLocked(assetOrTicker: string): boolean {
  return false;
}

export function acquireAssetEntryLock(assetOrTicker: string): boolean {
  return false;
}

export function releaseAssetEntryLock(assetOrTicker: string): void {
  return;
}

export interface TradeEntrySignal {
  assetOrTicker: string;
  context?: string;
}

export async function tryEnterTrade(asset: string, signal: TradeEntrySignal): Promise<TradeEntryGateResult> {
  return acquireTradeEntryGate(signal.assetOrTicker ?? asset, signal.context ?? "try_enter_trade");
}

export function setExchangeOpenPositionsSnapshot(assets: Set<string>): void {
  exchangeOpenAssets.clear();
  for (const a of assets) {
    exchangeOpenAssets.add(assetLabel(a));
  }
  lastPositionSyncOkAt = Date.now();
  lastPositionSyncError = null;
}

export function noteOpenedAssetPosition(assetOrTicker: string): void {
  exchangeOpenAssets.add(assetLabel(assetOrTicker));
}

export function noteClosedAssetPosition(assetOrTicker: string): void {
  exchangeOpenAssets.delete(assetLabel(assetOrTicker));
}
