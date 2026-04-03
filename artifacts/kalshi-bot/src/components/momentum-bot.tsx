import { useState } from "react";
import { useGetMomentumBotStatus, useSetMomentumBotAuto, getGetMomentumBotStatusQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Activity, Zap, Shield, AlertTriangle, Clock, RefreshCw } from "lucide-react";

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

  const { data } = useGetMomentumBotStatus({
    query: { refetchInterval: 2000 },
  });

  const setAuto = useSetMomentumBotAuto({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetMomentumBotStatusQueryKey() }),
    },
  });

  // Settings state
  const [balanceFloor, setBalanceFloor]       = useState("0");
  const [maxSessionLoss, setMaxSessionLoss]   = useState("0");
  const [consecutiveLossLimit, setConsecutiveLossLimit] = useState("3");
  const [showSettings, setShowSettings]       = useState(false);

  const enabled  = data?.enabled ?? false;
  const status   = data?.status;
  const isPaused = status === "PAUSED";

  function toggleAuto() {
    setAuto.mutate({
      data: {
        enabled: !enabled,
        balanceFloorCents:    Math.round(parseFloat(balanceFloor  || "0") * 100),
        maxSessionLossCents:  Math.round(parseFloat(maxSessionLoss || "0") * 100),
        consecutiveLossLimit: parseInt(consecutiveLossLimit || "3", 10),
      },
    });
  }

  const sessionPnl = data?.sessionPnlCents ?? 0;
  const pausedMins = data?.pausedUntilMs
    ? Math.max(0, Math.ceil((data.pausedUntilMs - Date.now()) / 60_000))
    : null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-sky-400" />
          <h2 className="text-sm font-semibold tracking-widest uppercase text-sky-400">
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
      <div className="grid grid-cols-4 gap-2">
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

      {/* All-time stats from DB */}
      {((data?.allTimeWins ?? 0) + (data?.allTimeLosses ?? 0)) > 0 && (
        <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 flex items-center justify-between">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">All-Time</p>
          <div className="flex items-center gap-3 text-xs">
            <span>
              <span className="text-emerald-400 font-bold">{data?.allTimeWins ?? 0}W</span>
              <span className="text-slate-600 mx-1">/</span>
              <span className="text-red-400 font-bold">{data?.allTimeLosses ?? 0}L</span>
            </span>
            <span className={`font-bold ${(data?.allTimePnlCents ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {(data?.allTimePnlCents ?? 0) >= 0 ? "+" : ""}{((data?.allTimePnlCents ?? 0) / 100).toFixed(2)}¢
            </span>
          </div>
        </div>
      )}

      {/* Pause notice */}
      {isPaused && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-300">
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
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-400" />
          <div>
            <p className="font-semibold text-red-200">Bot stopped automatically</p>
            <p className="text-[10px] text-red-400/80 mt-0.5">{data.stopReason}</p>
          </div>
        </div>
      )}

      {/* Last decision */}
      {data?.lastDecision && (
        <div className="space-y-1">
          <p className="text-[10px] text-slate-600 uppercase tracking-widest">Last Decision</p>
          <DecisionChip decision={data.lastDecision} />
        </div>
      )}

      {/* Auto toggle */}
      <div className="border-t border-white/5 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-300">Auto Mode</p>
            <p className="text-[10px] text-slate-600 mt-0.5">
              {enabled ? "Scanning every 3s for clean setups" : "Tap to start momentum trading"}
            </p>
          </div>
          <button
            onClick={toggleAuto}
            disabled={setAuto.isPending}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
              enabled ? "bg-sky-500/70" : "bg-white/10"
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"
            }`} />
          </button>
        </div>

        {enabled && !isPaused && (
          <div className="flex items-center gap-1.5 mt-2 text-[10px] text-sky-400/70">
            <RefreshCw className="w-3 h-3 animate-spin" style={{ animationDuration: "3s" }} />
            <span>Scanning BTC · ETH · SOL — waiting for strong signal</span>
          </div>
        )}
      </div>

      {/* Risk Settings */}
      <div className="border-t border-white/5 pt-3">
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
              Settings apply on next toggle. Set to 0 to disable that guard.
            </p>

            <div className="space-y-2">
              <label className="block">
                <span className="text-[10px] text-slate-400 block mb-1">Balance Floor ($)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={balanceFloor}
                  onChange={e => setBalanceFloor(e.target.value)}
                  placeholder="0"
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50"
                />
                <p className="text-[9px] text-slate-600 mt-0.5">Stop completely if balance falls below this</p>
              </label>

              <label className="block">
                <span className="text-[10px] text-slate-400 block mb-1">Max Session Loss ($)</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={maxSessionLoss}
                  onChange={e => setMaxSessionLoss(e.target.value)}
                  placeholder="0"
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-sky-500/50"
                />
                <p className="text-[9px] text-slate-600 mt-0.5">Stop bot for session if loss exceeds this</p>
              </label>

              <label className="block">
                <span className="text-[10px] text-slate-400 block mb-1">Max Consecutive Losses</span>
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
                <p className="text-[9px] text-slate-600 mt-0.5">Stop bot for session after N losses in a row</p>
              </label>
            </div>

            <div className="rounded-lg bg-white/[0.02] border border-white/5 p-2.5 space-y-1 text-[9px] text-slate-600">
              <p className="flex items-center gap-1"><Shield className="w-2.5 h-2.5 text-sky-500/50" /> <span className="text-slate-500">Active guards on this session:</span></p>
              <p>· Balance floor: {data?.balanceFloorCents ? `$${(data.balanceFloorCents / 100).toFixed(2)}` : "OFF"}</p>
              <p>· Session loss: {data?.maxSessionLossCents ? `$${(data.maxSessionLossCents / 100).toFixed(2)}` : "OFF"}</p>
              <p>· Consec. losses: {data?.consecutiveLossLimit ?? 3} in a row</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
