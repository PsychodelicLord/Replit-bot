import { useState, useEffect, useRef, useCallback } from "react";
import { useGetMomentumBotStatus, useSetMomentumBotAuto, getGetMomentumBotStatusQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Activity, Zap, Shield, AlertTriangle, Clock, RefreshCw } from "lucide-react";

const BASE_URL = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : import.meta.env.BASE_URL + "/";

type DebugMarket = { ticker: string; minutesRemaining: number; askCents: number; bidCents: number };
type DebugCounter = { lastPrice: number | null; upMoves: number; downMoves: number; flatMoves: number; windowSize: number };
type DebugData = {
  filteredMarkets: DebugMarket[];
  momentumCounters: Record<string, DebugCounter>;
  config: { DOMINANCE_REQUIRED: number; TICK_WINDOW_SIZE: number };
};

type LiveTradeRecord = {
  timestamp: number; market: string; side: "YES" | "NO"; exitReason: "TP" | "SL" | "STALE";
  entryPriceCents: number; entrySlippage: number; midAtTrigger: number;
  expectedExitCents: number; actualFillCents: number; exitSlippage: number; pnlCents: number;
};
type LivePerfReport = {
  sampleSize: number; winRate: number; avgWinCents: number; avgLossCents: number;
  evPerTrade: number; staleRate: number; totalPnlCents: number;
  avgEntrySlip: number; avgExitSlip: number; tpRate: number; slRate: number;
  recentTrades: LiveTradeRecord[];
};

const COIN_LABELS: Record<string, string> = {
  KXBTC: "BTC", KXETH: "ETH", KXSOL: "SOL", KXDOGE: "DOGE",
  KXXRP: "XRP", KXBNB: "BNB", KXHYPE: "HYPE",
};
function coinLabel(ticker: string) {
  for (const [prefix, label] of Object.entries(COIN_LABELS)) {
    if (ticker.startsWith(prefix)) return label;
  }
  return ticker.slice(0, 6);
}

// ── Lightning animation styles ────────────────────────────────────────────────
const LIGHTNING_STYLES = `
@keyframes bolt-strike {
  0%   { opacity: 0; transform: translateY(-120%) rotate(var(--rot)) scale(0.6); }
  15%  { opacity: 1; transform: translateY(-30%)  rotate(var(--rot)) scale(1.3); }
  35%  { opacity: 1; transform: translateY(10%)   rotate(var(--rot)) scale(1); }
  70%  { opacity: 0.6; transform: translateY(60%) rotate(var(--rot)) scale(0.9); }
  100% { opacity: 0; transform: translateY(130%)  rotate(var(--rot)) scale(0.7); }
}
@keyframes aura-pulse {
  0%   { box-shadow: 0 0 0px 0px rgba(139,92,246,0), 0 0 0px 0px rgba(59,130,246,0); }
  20%  { box-shadow: 0 0 30px 8px rgba(139,92,246,0.55), 0 0 60px 16px rgba(59,130,246,0.35); }
  50%  { box-shadow: 0 0 50px 14px rgba(139,92,246,0.45), 0 0 90px 28px rgba(59,130,246,0.25); }
  80%  { box-shadow: 0 0 30px 8px rgba(139,92,246,0.3),  0 0 60px 16px rgba(59,130,246,0.15); }
  100% { box-shadow: 0 0 0px 0px rgba(139,92,246,0), 0 0 0px 0px rgba(59,130,246,0); }
}
@keyframes border-flash {
  0%,100% { border-color: rgba(255,255,255,0.1); }
  25%,75%  { border-color: rgba(139,92,246,0.8); }
  50%      { border-color: rgba(59,130,246,0.9); }
}
@keyframes bolt-fade {
  0%   { opacity: 0; }
  10%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes crackle {
  0%,100% { opacity: 0; transform: scaleX(1); }
  20%     { opacity: 1; transform: scaleX(1.05); }
  40%     { opacity: 0.7; transform: scaleX(0.98); }
  60%     { opacity: 1; transform: scaleX(1.02); }
  80%     { opacity: 0.5; transform: scaleX(1); }
}
`;

// Bolt positions: [left%, top%, rotation, size, delay]
const BOLT_CONFIGS = [
  { left: "12%",  top: "5%",  rot: "-15deg", size: 28, delay: 0 },
  { left: "35%",  top: "2%",  rot: "8deg",   size: 22, delay: 80 },
  { left: "60%",  top: "4%",  rot: "-5deg",  size: 32, delay: 40 },
  { left: "82%",  top: "3%",  rot: "12deg",  size: 24, delay: 120 },
  { left: "22%",  top: "85%", rot: "170deg", size: 20, delay: 60 },
  { left: "50%",  top: "88%", rot: "185deg", size: 26, delay: 100 },
  { left: "75%",  top: "86%", rot: "172deg", size: 22, delay: 20 },
];

type StatusBadgeProps = {
  status: "DISABLED" | "WAITING_FOR_SETUP" | "IN_TRADE" | "PAUSED" | undefined;
};

function StatusBadge({ status }: StatusBadgeProps) {
  if (!status || status === "DISABLED") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider bg-white/5 text-slate-500 border border-white/5">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-600" />
        OFF
      </span>
    );
  }
  if (status === "PAUSED") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
        PAUSED
      </span>
    );
  }
  if (status === "IN_TRADE") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        IN TRADE
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider bg-sky-500/10 text-sky-400 border border-sky-500/20">
      <RefreshCw className="w-2.5 h-2.5 animate-spin" style={{ animationDuration: "3s" }} />
      SCANNING
    </span>
  );
}

function DecisionChip({ decision }: { decision: string | null | undefined }) {
  if (!decision) return null;
  const isBuyYes = decision.includes("BUY_YES");
  const isBuyNo  = decision.includes("BUY_NO");
  const isSkip   = !isBuyYes && !isBuyNo;

  return (
    <div className={`flex items-start gap-1.5 p-2 rounded-lg text-[10px] leading-relaxed border ${
      isBuyYes ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300"
      : isBuyNo ? "bg-orange-500/10 border-orange-500/20 text-orange-300"
      : "bg-white/[0.03] border-white/5 text-slate-500"
    }`}>
      {isBuyYes && <TrendingUp  className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" />}
      {isBuyNo  && <TrendingDown className="w-3 h-3 mt-0.5 shrink-0 text-orange-400" />}
      {isSkip   && <Activity     className="w-3 h-3 mt-0.5 shrink-0 text-slate-500" />}
      <span className="break-all">{decision}</span>
    </div>
  );
}

export function MomentumBot() {
  const queryClient = useQueryClient();

  const { data, isError, dataUpdatedAt } = useGetMomentumBotStatus({
    query: { refetchInterval: 2000, retry: 3 },
  });

  // True only when we genuinely have no data (API unreachable / first load)
  const isConnected = dataUpdatedAt > 0;
  const isReconnecting = !isConnected || (isError && data === undefined);

  const setAuto = useSetMomentumBotAuto({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetMomentumBotStatusQueryKey() }),
    },
  });

  // ── Live scan debug data ─────────────────────────────────────────────────
  const [debugData, setDebugData] = useState<DebugData | null>(null);
  const fetchDebug = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/momentum/debug");
      if (res.ok) setDebugData(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    fetchDebug();
    const id = setInterval(fetchDebug, 15_000);
    return () => clearInterval(id);
  }, [fetchDebug]);

  // ── Live execution performance report (real trades only) ──────────────────
  const [livePerf, setLivePerf] = useState<LivePerfReport | null>(null);
  const fetchLivePerf = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}api/bot/momentum/live-performance`);
      if (res.ok) setLivePerf(await res.json());
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    fetchLivePerf();
    const id = setInterval(fetchLivePerf, 30_000);
    return () => clearInterval(id);
  }, [fetchLivePerf]);

  // ── Signal flash state ───────────────────────────────────────────────────
  const [signalFlash, setSignalFlash] = useState(false);
  const prevDecision = useRef<string | null>(null);

  useEffect(() => {
    if (!data?.lastDecision) return;
    const isBuy = data.lastDecision.includes("BUY_YES") || data.lastDecision.includes("BUY_NO");
    if (isBuy && data.lastDecision !== prevDecision.current) {
      setSignalFlash(true);
      const t = setTimeout(() => setSignalFlash(false), 2600);
      return () => clearTimeout(t);
    }
    prevDecision.current = data.lastDecision;
  }, [data?.lastDecision]);

  // Settings state
  const [balanceFloor, setBalanceFloor]       = useState("0");
  const [maxSessionLoss, setMaxSessionLoss]   = useState("0");
  const [consecutiveLossLimit, setConsecutiveLossLimit] = useState("3");
  const [betCostCents, setBetCostCents]       = useState("30");
  const [priceMin, setPriceMin]               = useState("20");
  const [priceMax, setPriceMax]               = useState("80");
  const [showSettings, setShowSettings]       = useState(false);
  const [simulatorMode, setSimulatorMode]     = useState(false);
  const [simModeSynced, setSimModeSynced]     = useState(false);

  // Sync local simulatorMode from server on first load — prevents accidentally
  // sending simulatorMode:false when toggling Auto Mode while server is in sim mode.
  useEffect(() => {
    if (!simModeSynced && data?.simulatorMode !== undefined) {
      setSimulatorMode(data.simulatorMode);
      setSimModeSynced(true);
    }
  }, [data?.simulatorMode, simModeSynced]);

  const enabled  = data?.enabled ?? false;
  const status   = data?.status;
  const isPaused = status === "PAUSED";
  // Use server value as source of truth; local state is only for pending changes
  const isSimMode = data?.simulatorMode ?? simulatorMode;
  // What the toggle should show: server value when bot is running (locked), local when stopped
  const toggleDisplayMode = enabled ? isSimMode : simulatorMode;

  function toggleAuto() {
    const pMin = parseInt(priceMin || "20", 10);
    const pMax = parseInt(priceMax || "80", 10);
    setAuto.mutate({
      data: {
        enabled: !enabled,
        balanceFloorCents:    Math.round(parseFloat(balanceFloor  || "0") * 100),
        maxSessionLossCents:  Math.round(parseFloat(maxSessionLoss || "0") * 100),
        consecutiveLossLimit: parseInt(consecutiveLossLimit || "3", 10),
        betCostCents:         Math.max(1, parseInt(betCostCents || "30", 10)),
        simulatorMode,
        priceMin:             Math.min(pMin, pMax - 1),
        priceMax:             Math.max(pMax, pMin + 1),
      },
    });
  }

  function toggleSimMode() {
    const newSim = !isSimMode;
    if (!newSim && enabled) {
      if (!window.confirm("Switch to REAL MONEY mode? The bot will start placing real Kalshi orders immediately.")) return;
    }
    const pMin = parseInt(priceMin || "20", 10);
    const pMax = parseInt(priceMax || "80", 10);
    setSimulatorMode(newSim);
    setAuto.mutate({
      data: {
        enabled,
        balanceFloorCents:    Math.round(parseFloat(balanceFloor  || "0") * 100),
        maxSessionLossCents:  Math.round(parseFloat(maxSessionLoss || "0") * 100),
        consecutiveLossLimit: parseInt(consecutiveLossLimit || "3", 10),
        betCostCents:         Math.max(1, parseInt(betCostCents || "30", 10)),
        simulatorMode:        newSim,
        priceMin:             Math.min(pMin, pMax - 1),
        priceMax:             Math.max(pMax, pMin + 1),
      },
    });
  }

  const sessionPnl = data?.sessionPnlCents ?? 0;
  const simPnl     = data?.simPnlCents ?? 0;
  const pausedMins = data?.pausedUntilMs
    ? Math.max(0, Math.ceil((data.pausedUntilMs - Date.now()) / 60_000))
    : null;

  return (
    <>
      {/* Inject keyframe animations once */}
      <style>{LIGHTNING_STYLES}</style>

      <div
        className="rounded-2xl border p-5 space-y-4 relative overflow-hidden transition-colors"
        style={{
          background: signalFlash
            ? "linear-gradient(135deg, rgba(139,92,246,0.08) 0%, rgba(59,130,246,0.06) 50%, rgba(255,255,255,0.03) 100%)"
            : "rgba(255,255,255,0.03)",
          animation: signalFlash ? "aura-pulse 2.6s ease-out forwards, border-flash 2.6s ease-out forwards" : "none",
          borderColor: signalFlash ? undefined : "rgba(255,255,255,0.1)",
        }}
      >
        {/* ── Lightning bolts overlay ─────────────────────────────────────── */}
        {signalFlash && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 10 }}>
            {BOLT_CONFIGS.map((b, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: b.left,
                  top: b.top,
                  ["--rot" as string]: b.rot,
                  animation: `bolt-strike 2.6s ease-in-out ${b.delay}ms forwards`,
                  zIndex: 20,
                }}
              >
                <Zap
                  style={{
                    width: b.size,
                    height: b.size,
                    color: i % 2 === 0 ? "#60a5fa" : "#a78bfa",
                    filter: `drop-shadow(0 0 6px ${i % 2 === 0 ? "#3b82f6" : "#8b5cf6"}) drop-shadow(0 0 12px ${i % 2 === 0 ? "#2563eb" : "#7c3aed"})`,
                  }}
                  fill="currentColor"
                />
              </div>
            ))}

            {/* Top crackle bar */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: "2px",
                background: "linear-gradient(90deg, transparent, #818cf8, #60a5fa, #a78bfa, transparent)",
                animation: "crackle 2.6s ease-out forwards",
              }}
            />
            {/* Bottom crackle bar */}
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                height: "2px",
                background: "linear-gradient(90deg, transparent, #a78bfa, #60a5fa, #818cf8, transparent)",
                animation: "crackle 2.6s ease-out 150ms forwards",
              }}
            />

            {/* Center glow burst */}
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: 120,
                height: 120,
                borderRadius: "50%",
                background: "radial-gradient(circle, rgba(139,92,246,0.3) 0%, rgba(59,130,246,0.15) 50%, transparent 70%)",
                animation: "bolt-fade 2.6s ease-out forwards",
                pointerEvents: "none",
              }}
            />
          </div>
        )}

        {/* ── Card content (z-index above overlay) ──────────────────────── */}
        <div className="relative" style={{ zIndex: 1 }}>

          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Zap
                className="w-4 h-4"
                style={{
                  color: signalFlash ? "#a78bfa" : "#38bdf8",
                  filter: signalFlash ? "drop-shadow(0 0 6px #8b5cf6)" : "none",
                  transition: "color 0.3s, filter 0.3s",
                }}
              />
              <h2
                className="text-sm font-semibold tracking-widest uppercase"
                style={{
                  color: signalFlash ? "#c4b5fd" : "#38bdf8",
                  textShadow: signalFlash ? "0 0 12px rgba(167,139,250,0.7)" : "none",
                  transition: "color 0.3s, text-shadow 0.3s",
                }}
              >
                Momentum Bot
              </h2>
            </div>
            <StatusBadge status={status} />
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            Scans BTC, ETH & SOL 15-min markets every 3s. Enters only when 4 of 5 recent price ticks
            move the same direction, spread ≤3¢, price 30–60¢, and &gt;7 min left.
            TP: +3¢ · SL: -4¢ · Stale exit: 45s.
          </p>

          {/* Stats row — session */}
          <div className="grid grid-cols-4 gap-2 mt-4">
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5 text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest">Open</p>
              <p className="text-lg font-bold text-white mt-0.5">{data?.openTradeCount ?? 0}</p>
              <p className="text-[9px] text-slate-600">max 2</p>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5 text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest">W / L</p>
              <div className="flex items-baseline justify-center gap-1 mt-0.5">
                <span className="text-base font-bold text-emerald-400">{data?.totalWins ?? 0}</span>
                <span className="text-slate-600 text-xs">/</span>
                <span className="text-base font-bold text-red-400">{data?.totalLosses ?? 0}</span>
              </div>
              <p className="text-[9px] text-slate-600">this session</p>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5 text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest">P&L</p>
              <p className={`text-base font-bold mt-0.5 ${sessionPnl > 0 ? "text-emerald-400" : sessionPnl < 0 ? "text-red-400" : "text-slate-400"}`}>
                {sessionPnl >= 0 ? "+" : ""}{(sessionPnl / 100).toFixed(2)}¢
              </p>
              <p className="text-[9px] text-slate-600">session</p>
            </div>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5 text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest">Streak</p>
              <p className={`text-lg font-bold mt-0.5 ${(data?.consecutiveLosses ?? 0) >= 2 ? "text-red-400" : "text-slate-300"}`}>
                {data?.consecutiveLosses ?? 0}
              </p>
              <p className="text-[9px] text-slate-600">losses/row</p>
            </div>
          </div>

          {/* Simulator mode banner + stats */}
          {isSimMode && (
            <div className="mt-4 rounded-lg border border-violet-500/30 bg-violet-500/10 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold tracking-widest uppercase text-violet-300 bg-violet-500/20 px-2 py-0.5 rounded-full">Paper Trading</span>
                <span className="text-[10px] text-violet-400">No real money — real market data</span>
              </div>
              {enabled && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg border border-violet-500/20 bg-black/20 p-2 text-center">
                      <p className="text-[9px] text-violet-400 uppercase tracking-widest">Open</p>
                      <p className="text-base font-bold text-violet-300 mt-0.5">{data?.simOpenTradeCount ?? 0}</p>
                    </div>
                    <div className="rounded-lg border border-violet-500/20 bg-black/20 p-2 text-center">
                      <p className="text-[9px] text-violet-400 uppercase tracking-widest">Lifetime W / L</p>
                      <div className="flex items-baseline justify-center gap-1 mt-0.5">
                        <span className="text-sm font-bold text-emerald-400">{data?.simWins ?? 0}</span>
                        <span className="text-slate-600 text-xs">/</span>
                        <span className="text-sm font-bold text-red-400">{data?.simLosses ?? 0}</span>
                      </div>
                    </div>
                    <div className="rounded-lg border border-violet-500/20 bg-black/20 p-2 text-center">
                      <p className="text-[9px] text-violet-400 uppercase tracking-widest">Lifetime P&L</p>
                      <p className={`text-sm font-bold mt-0.5 ${simPnl > 0 ? "text-emerald-400" : simPnl < 0 ? "text-red-400" : "text-violet-300"}`}>
                        {simPnl >= 0 ? "+" : ""}{(simPnl / 100).toFixed(2)}¢
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      if (!confirm("Reset lifetime sim scoreboard to 0?")) return;
                      await fetch(`${BASE_URL}api/bot/momentum/reset-sim`, { method: "POST" });
                    }}
                    className="mt-1.5 w-full text-[9px] text-slate-600 hover:text-slate-400 transition-colors text-center py-0.5"
                  >
                    reset scoreboard
                  </button>

                  {/* ── Bot Health Score ── */}
                  {(() => {
                    const hs = data?.healthScore;
                    const bufferCount = hs?.tradesInBuffer ?? 0;
                    const needed = Math.max(0, 20 - bufferCount);

                    if (!hs) {
                      return (
                        <div className="mt-3 rounded-lg border border-white/5 bg-black/20 p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-base">🏥</span>
                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Bot Health</span>
                          </div>
                          <div className="w-full bg-white/5 rounded-full h-1.5 mb-1.5">
                            <div
                              className="bg-violet-500 h-1.5 rounded-full transition-all"
                              style={{ width: `${Math.min(100, (bufferCount / 20) * 100)}%` }}
                            />
                          </div>
                          <p className="text-[9px] text-slate-500 text-center">
                            {needed > 0 ? `${needed} more trades to unlock health report` : "Calculating..."}
                          </p>
                        </div>
                      );
                    }

                    const color = hs.label === "Healthy"
                      ? { dot: "bg-emerald-400", border: "border-emerald-500/30", bg: "bg-emerald-500/5", text: "text-emerald-400" }
                      : hs.label === "Fragile"
                      ? { dot: "bg-yellow-400", border: "border-yellow-500/30", bg: "bg-yellow-500/5", text: "text-yellow-400" }
                      : { dot: "bg-red-500", border: "border-red-500/30", bg: "bg-red-500/5", text: "text-red-400" };

                    const advice = hs.label === "Healthy"
                      ? "Strategy is working — safe to scale up bet size"
                      : hs.label === "Fragile"
                      ? "Borderline — keep sim mode running, watch closely"
                      : "Not ready for real money — stay in paper mode";

                    return (
                      <div className={`mt-3 rounded-lg border ${color.border} ${color.bg} p-3`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`w-2.5 h-2.5 rounded-full ${color.dot} shadow-lg`} style={{ boxShadow: `0 0 6px currentColor` }} />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Bot Health</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`text-sm font-bold ${color.text}`}>{hs.total}/10</span>
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${color.text} border ${color.border}`}>{hs.label}</span>
                          </div>
                        </div>

                        <p className={`text-[9px] ${color.text} mb-2.5`}>{advice}</p>

                        <div className="grid grid-cols-5 gap-1 mb-2">
                          {[
                            { label: "EV", val: hs.evScore },
                            { label: "Stab", val: hs.stabilityScore },
                            { label: "W/L", val: hs.ratioScore },
                            { label: "Stale", val: hs.staleScore },
                            { label: "Exec", val: hs.execScore },
                          ].map(({ label, val }) => (
                            <div key={label} className="text-center">
                              <div className="flex justify-center gap-0.5 mb-0.5">
                                {[0,1].map(i => (
                                  <div key={i} className={`w-1.5 h-1.5 rounded-sm ${i < val ? color.dot : "bg-white/10"}`} />
                                ))}
                              </div>
                              <span className="text-[8px] text-slate-500">{label}</span>
                            </div>
                          ))}
                        </div>

                        <div className="flex justify-between text-[9px] text-slate-500">
                          <span>WR {(hs.winRate * 100).toFixed(0)}%</span>
                          <span>EV {hs.netEV >= 0 ? "+" : ""}{hs.netEV.toFixed(1)}¢</span>
                          <span>Stale {(hs.staleRate * 100).toFixed(0)}%</span>
                          <span>{hs.tradesInBuffer} trades</span>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}

          {/* All-time stats from DB */}
          {!isSimMode && ((data?.allTimeWins ?? 0) + (data?.allTimeLosses ?? 0)) > 0 && (
            <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 flex items-center justify-between mt-4">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest">All-Time</p>
              <div className="flex items-center gap-3 text-xs">
                <span>
                  <span className="text-emerald-400 font-bold">{data?.allTimeWins ?? 0}W</span>
                  <span className="text-slate-600 mx-1">/</span>
                  <span className="text-red-400 font-bold">{data?.allTimeLosses ?? 0}L</span>
                </span>
                <span className={`font-bold ${(data?.allTimePnlCents ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {(data?.allTimePnlCents ?? 0) >= 0 ? "+$" : "-$"}{(Math.abs(data?.allTimePnlCents ?? 0) / 100).toFixed(2)}
                </span>
              </div>
            </div>
          )}

          {/* Live Execution Performance Card — real money mode only */}
          {!isSimMode && (
            <div className="mt-4 rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5 text-sky-400" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Live Execution Quality</span>
                </div>
                {livePerf && livePerf.sampleSize > 0 && (
                  <span className="text-[9px] text-slate-600">{livePerf.sampleSize} real trades</span>
                )}
              </div>

              {(!livePerf || livePerf.sampleSize === 0) ? (
                <p className="text-[9px] text-slate-600 text-center py-2">No real trades recorded yet this session</p>
              ) : (
                <>
                  {/* Rolling metrics */}
                  <div className="grid grid-cols-3 gap-1.5 mb-2.5">
                    {[
                      { label: "Win Rate", val: `${(livePerf.winRate * 100).toFixed(0)}%`,
                        color: livePerf.winRate >= 0.6 ? "text-emerald-400" : livePerf.winRate >= 0.45 ? "text-yellow-400" : "text-red-400" },
                      { label: "EV / Trade", val: `${livePerf.evPerTrade >= 0 ? "+" : ""}${livePerf.evPerTrade.toFixed(1)}¢`,
                        color: livePerf.evPerTrade > 0 ? "text-emerald-400" : livePerf.evPerTrade > -1 ? "text-yellow-400" : "text-red-400" },
                      { label: "Total P&L", val: `${livePerf.totalPnlCents >= 0 ? "+" : ""}${livePerf.totalPnlCents}¢`,
                        color: livePerf.totalPnlCents >= 0 ? "text-emerald-400" : "text-red-400" },
                      { label: "Avg Win", val: `+${livePerf.avgWinCents.toFixed(1)}¢`, color: "text-emerald-400" },
                      { label: "Avg Loss", val: `${livePerf.avgLossCents.toFixed(1)}¢`, color: "text-red-400" },
                      { label: "Stale Rate", val: `${(livePerf.staleRate * 100).toFixed(0)}%`,
                        color: livePerf.staleRate < 0.2 ? "text-slate-400" : livePerf.staleRate < 0.4 ? "text-yellow-400" : "text-red-400" },
                    ].map(({ label, val, color }) => (
                      <div key={label} className="rounded bg-black/20 p-1.5 text-center">
                        <p className="text-[8px] text-slate-600 uppercase tracking-widest">{label}</p>
                        <p className={`text-xs font-bold mt-0.5 ${color}`}>{val}</p>
                      </div>
                    ))}
                  </div>

                  {/* Slippage row */}
                  <div className="flex justify-between text-[9px] px-0.5 mb-2.5">
                    <span className="text-slate-600">TP {(livePerf.tpRate * 100).toFixed(0)}% · SL {(livePerf.slRate * 100).toFixed(0)}%</span>
                    <span className={livePerf.avgExitSlip >= 0 ? "text-emerald-400/70" : "text-red-400/70"}>
                      Exit slip avg: {livePerf.avgExitSlip >= 0 ? "+" : ""}{livePerf.avgExitSlip.toFixed(1)}¢
                    </span>
                    <span className={livePerf.avgEntrySlip === 0 ? "text-slate-600" : "text-yellow-400/70"}>
                      Entry slip: {livePerf.avgEntrySlip.toFixed(1)}¢
                    </span>
                  </div>

                  {/* Recent trades mini-table */}
                  {livePerf.recentTrades.length > 0 && (
                    <div className="border-t border-white/5 pt-2">
                      <p className="text-[8px] text-slate-600 uppercase tracking-widest mb-1.5">Recent real trades</p>
                      <div className="space-y-1">
                        {livePerf.recentTrades.slice(0, 5).map((t, i) => {
                          const coin = t.market.replace(/15M.*$/, "").replace("KX", "");
                          const slipColor = t.exitSlippage >= 0 ? "text-emerald-400/60" : "text-red-400/60";
                          return (
                            <div key={i} className="flex items-center justify-between text-[9px]">
                              <span className="text-slate-500 w-10">{coin} {t.side}</span>
                              <span className="text-slate-600">entry:{t.entryPriceCents}¢ → fill:{t.actualFillCents}¢</span>
                              <span className={`w-12 text-right ${slipColor}`}>
                                slip:{t.exitSlippage >= 0 ? "+" : ""}{t.exitSlippage}¢
                              </span>
                              <span className={`w-10 text-right font-bold ${t.pnlCents > 0 ? "text-emerald-400" : "text-red-400"}`}>
                                {t.pnlCents >= 0 ? "+" : ""}{t.pnlCents}¢
                              </span>
                              <span className={`w-8 text-right text-[8px] ${
                                t.exitReason === "TP" ? "text-emerald-400/70"
                                : t.exitReason === "SL" ? "text-red-400/70"
                                : "text-slate-500"
                              }`}>{t.exitReason}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Pause notice */}
          {isPaused && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-300 mt-4">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-yellow-400" />
              <div>
                <p className="font-semibold">{data?.pauseReason ?? "Risk pause active"}</p>
                {pausedMins !== null && pausedMins > 0 && (
                  <p className="text-[10px] text-yellow-400/70 mt-0.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Resumes in ~{pausedMins} min
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Stop reason — shown when bot is disabled and stopped for a known reason */}
          {!enabled && data?.stopReason && !data.stopReason.startsWith("Server started") && data.stopReason !== "Manually stopped via dashboard" && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300 mt-4">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-400" />
              <div>
                <p className="font-semibold text-red-200">Bot stopped automatically</p>
                <p className="text-[10px] text-red-400/80 mt-0.5">{data.stopReason}</p>
              </div>
            </div>
          )}

          {/* Last decision */}
          {data?.lastDecision && (
            <div className="space-y-1 mt-4">
              <p className="text-[10px] text-slate-600 uppercase tracking-widest">Last Decision</p>
              <DecisionChip decision={data.lastDecision} />
            </div>
          )}

          {/* Live Scan Panel */}
          {debugData && debugData.filteredMarkets.length > 0 && (
            <div className="mt-4 space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-slate-600 uppercase tracking-widest">Live Markets</p>
                <span className="text-[9px] text-slate-700">need {isSimMode ? 2 : (debugData.config?.DOMINANCE_REQUIRED ?? 3)} price moves same dir</span>
              </div>
              {debugData.filteredMarkets.map(m => {
                const mid = Math.round((m.askCents + m.bidCents) / 2);
                const spread = m.askCents - m.bidCents;
                const counter = debugData.momentumCounters[m.ticker];
                const up   = counter?.upMoves   ?? 0;
                const down = counter?.downMoves  ?? 0;
                const flat = counter?.flatMoves  ?? 0;
                const total = counter?.windowSize ?? 0;
                const needed = isSimMode ? 2 : (debugData.config?.DOMINANCE_REQUIRED ?? 3);
                const hasSignal = up >= needed || down >= needed;
                const isFlat = total > 0 && up === 0 && down === 0;
                const coin = coinLabel(m.ticker);

                return (
                  <div
                    key={m.ticker}
                    className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 border text-[10px] ${
                      hasSignal
                        ? "bg-emerald-500/10 border-emerald-500/25"
                        : "bg-white/[0.02] border-white/5"
                    }`}
                  >
                    <span className="font-bold text-slate-300 w-9 shrink-0">{coin}</span>
                    <span className="text-slate-500 w-8 shrink-0">{mid}¢</span>
                    <span className="text-slate-700 w-10 shrink-0">±{spread}¢</span>
                    <div className="flex gap-0.5 items-center flex-1">
                      {total === 0 ? (
                        <span className="text-slate-700">waiting…</span>
                      ) : (
                        <>
                          {Array.from({ length: up }).map((_, i) => (
                            <span key={`u${i}`} className="w-2 h-2 rounded-sm bg-emerald-500/70" title="up" />
                          ))}
                          {Array.from({ length: down }).map((_, i) => (
                            <span key={`d${i}`} className="w-2 h-2 rounded-sm bg-red-500/70" title="down" />
                          ))}
                          {Array.from({ length: flat }).map((_, i) => (
                            <span key={`f${i}`} className="w-2 h-2 rounded-sm bg-white/10" title="flat" />
                          ))}
                        </>
                      )}
                    </div>
                    <span className={`shrink-0 font-bold ${
                      hasSignal ? "text-emerald-400" : isFlat ? "text-slate-700" : "text-slate-600"
                    }`}>
                      {hasSignal ? (up >= needed ? "▲ FIRE" : "▼ FIRE") : isFlat ? "flat" : `${Math.max(up,down)}/${needed}`}
                    </span>
                    <span className="text-slate-700 shrink-0">{m.minutesRemaining.toFixed(0)}m</span>
                  </div>
                );
              })}
              <p className="text-[9px] text-slate-700 pl-1">
                <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500/70 mr-1 align-middle" />up move
                <span className="inline-block w-2 h-2 rounded-sm bg-red-500/70 mx-1 ml-2 align-middle" />down move
              </p>
            </div>
          )}
          {debugData && debugData.filteredMarkets.length === 0 && (
            <div className="mt-4 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[10px] text-slate-600">
              No tradeable markets right now (spreads too wide or price out of range) — re-scanning shortly
            </div>
          )}

          {/* Simulator toggle — visible above Auto Mode */}
          <div className="border-t border-white/5 pt-4 mt-4">
            <div className={`flex items-center justify-between rounded-xl px-3 py-2.5 transition-colors ${toggleDisplayMode ? "bg-violet-500/15 border border-violet-500/30" : "bg-white/[0.03] border border-white/5"}`}>
              <div>
                <p className="text-xs font-semibold text-violet-300">🎮 Paper Trading</p>
                <p className="text-[10px] mt-0.5" style={{ color: toggleDisplayMode ? "#a78bfa99" : "#475569" }}>
                  {enabled
                    ? toggleDisplayMode
                      ? "✅ Active — real markets, fake money"
                      : "⚠️ LIVE mode — real money at risk"
                    : toggleDisplayMode
                      ? "Real markets, fake money — no real orders placed"
                      : "Enable to test strategy without spending money"}
                </p>
              </div>
              <button
                onClick={toggleSimMode}
                disabled={setAuto.isPending}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none shrink-0 ml-3 ${
                  toggleDisplayMode ? "bg-violet-500" : "bg-white/10"
                } ${setAuto.isPending ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  toggleDisplayMode ? "translate-x-6" : "translate-x-1"
                }`} />
              </button>
            </div>
            {enabled && (
              <p className="text-[9px] text-slate-500 mt-1 pl-1">
                {toggleDisplayMode ? "🟣 Paper mode — tap to switch to live immediately" : "🔴 Live mode — tap to switch to paper immediately"}
              </p>
            )}
          </div>

          {/* Auto toggle */}
          <div className="border-t border-white/5 pt-4 mt-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-slate-300">Auto Mode</p>
                <p className="text-[10px] mt-0.5 text-slate-600">
                  {isReconnecting
                    ? "⟳ Reconnecting to server..."
                    : enabled
                      ? isSimMode ? "🎮 Paper scanning — no real money" : "Scanning every 15s for clean setups"
                      : "Tap to start momentum trading"}
                </p>
              </div>
              {isReconnecting ? (
                <div className="relative inline-flex h-6 w-11 items-center rounded-full bg-amber-500/30 animate-pulse">
                  <span className="inline-block h-4 w-4 transform rounded-full bg-amber-400/70 shadow translate-x-3" />
                </div>
              ) : (
              <button
                onClick={toggleAuto}
                disabled={setAuto.isPending}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                  enabled
                    ? simulatorMode ? "bg-violet-500/70" : "bg-sky-500/70"
                    : "bg-white/10"
                }`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  enabled ? "translate-x-6" : "translate-x-1"
                }`} />
              </button>
              )}
            </div>

            {enabled && !isPaused && (
              <div className={`flex items-center gap-1.5 mt-2 text-[10px] ${simulatorMode ? "text-violet-400/70" : "text-sky-400/70"}`}>
                <RefreshCw className="w-3 h-3 animate-spin" style={{ animationDuration: "3s" }} />
                <span>{simulatorMode ? "🎮 Paper trading — tracking imaginary P&L" : "Scanning BTC · ETH · SOL — waiting for strong signal"}</span>
              </div>
            )}
          </div>

          {/* Risk Settings */}
          <div className="border-t border-white/5 pt-3 mt-0">
            <button
              onClick={() => setShowSettings(s => !s)}
              className="flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
            >
              <Shield className="w-3 h-3" />
              Risk Controls {showSettings ? "▲" : "▼"}
            </button>

            {showSettings && (
              <div className="mt-3 space-y-3">
                <p className="text-[10px] text-slate-600">
                  Settings apply when you toggle Auto Mode. Changes while running take effect on next start.
                </p>

                <div className="space-y-2">

                  {/* Spend per trade */}
                  <label className="block">
                    <span className="text-[10px] text-slate-400 block mb-1">Spend per trade (¢)</span>
                    <input
                      type="number"
                      min="1"
                      max="500"
                      step="1"
                      value={betCostCents}
                      onChange={e => setBetCostCents(e.target.value)}
                      placeholder="30"
                      className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50"
                    />
                    <p className="text-[9px] text-slate-600 mt-0.5">
                      How many cents to bet per trade. e.g. <strong className="text-slate-500">30</strong> = spend 30¢ to buy a YES at 60¢ → you get 0.5 contracts
                    </p>
                  </label>

                  {/* Entry price range */}
                  <div>
                    <span className="text-[10px] text-slate-400 block mb-1">Entry price range (¢)</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="1"
                        max="99"
                        step="1"
                        value={priceMin}
                        onChange={e => setPriceMin(e.target.value)}
                        placeholder="20"
                        className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50"
                      />
                      <span className="text-[10px] text-slate-600 shrink-0">to</span>
                      <input
                        type="number"
                        min="1"
                        max="99"
                        step="1"
                        value={priceMax}
                        onChange={e => setPriceMax(e.target.value)}
                        placeholder="80"
                        className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50"
                      />
                    </div>
                    <p className="text-[9px] text-slate-600 mt-0.5">
                      Only enter when market price is in this range. e.g. <strong className="text-slate-500">30 to 70</strong> = buy YES only when it's between 30¢ and 70¢
                    </p>
                  </div>

                  {/* Risk guards */}
                  <label className="block">
                    <span className="text-[10px] text-slate-400 block mb-1">Balance floor ($) — stop if balance drops below</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={balanceFloor}
                      onChange={e => setBalanceFloor(e.target.value)}
                      placeholder="0"
                      className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] text-slate-400 block mb-1">Max session loss ($) — stop if this is lost today</span>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={maxSessionLoss}
                      onChange={e => setMaxSessionLoss(e.target.value)}
                      placeholder="0"
                      className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[10px] text-slate-400 block mb-1">Max losses in a row — stop after N consecutive losses</span>
                    <input
                      type="number"
                      min="0"
                      max="10"
                      step="1"
                      value={consecutiveLossLimit}
                      onChange={e => setConsecutiveLossLimit(e.target.value)}
                      placeholder="3"
                      className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50"
                    />
                  </label>
                </div>

                <div className="rounded-lg bg-white/[0.02] border border-white/5 p-2.5 space-y-1 text-[9px] text-slate-600">
                  <p className="flex items-center gap-1"><Shield className="w-2.5 h-2.5 text-sky-500/50" /> <span className="text-slate-500">Current active settings:</span></p>
                  <p>· Spend: {data?.betCostCents ?? 30}¢ per trade</p>
                  <p>· Entry range: {data?.priceMin ?? 20}¢ – {data?.priceMax ?? 80}¢</p>
                  <p>· Balance floor: {data?.balanceFloorCents ? `$${(data.balanceFloorCents / 100).toFixed(2)}` : "OFF"}</p>
                  <p>· Session loss: {data?.maxSessionLossCents ? `$${(data.maxSessionLossCents / 100).toFixed(2)}` : "OFF"}</p>
                  <p>· Losses in a row: {data?.consecutiveLossLimit || "OFF"}</p>
                </div>
              </div>
            )}
          </div>

        </div>{/* end relative content wrapper */}
      </div>
    </>
  );
}
