import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { OutcomeBotStatus } from "@workspace/api-client-react";
import { Activity, TrendingUp, TrendingDown, Minus, Zap, ChevronDown, ChevronUp, AlertCircle, DollarSign } from "lucide-react";

const BASE_URL = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : import.meta.env.BASE_URL + "/";

function apiUrl(path: string) { return `${BASE_URL}api/${path}`; }

function fmtCents(c: number, sign = false): string {
  const prefix = sign ? (c > 0 ? "+" : c < 0 ? "-" : "") : c < 0 ? "-" : "";
  return `${prefix}$${(Math.abs(c) / 100).toFixed(2)}`;
}

function fmtPnlCents(c: number): string {
  return `${c >= 0 ? "+" : ""}${c}¢`;
}

function coinLabel(ticker: string): string {
  for (const c of ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB"]) {
    if (ticker.toUpperCase().includes(c)) return c;
  }
  return ticker;
}

function StateChip({ state, direction }: { state: string; direction?: string }) {
  if (state === "TRENDING") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/20 border border-sky-500/30 text-sky-300 text-[10px] font-semibold">
        {direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        TRENDING {direction}
      </span>
    );
  }
  if (state === "BREAKOUT") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/20 border border-violet-500/30 text-violet-300 text-[10px] font-semibold">
        {direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        BREAKOUT {direction}
      </span>
    );
  }
  if (state === "EMERGING") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-300 text-[10px] font-semibold">
        {direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        EMERGING {direction}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-500 text-[10px] font-medium">
      <Minus className="w-3 h-3" />
      NO TRADE
    </span>
  );
}

export function OutcomeBot() {
  const qc = useQueryClient();
  const [showMarkets, setShowMarkets] = useState(false);
  const [betCostCents, setBetCostCents] = useState(100);

  const { data: status } = useQuery<OutcomeBotStatus>({
    queryKey: ["outcome-status"],
    queryFn: () => fetch(apiUrl("bot/outcome/status")).then(r => r.json()),
    refetchInterval: 5000,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      fetch(apiUrl("bot/outcome/toggle"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, betCostCents }),
      }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["outcome-status"] }),
  });

  const reset = useMutation({
    mutationFn: () => fetch(apiUrl("bot/outcome/reset"), { method: "POST" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["outcome-status"] }),
  });

  const enabled   = status?.enabled ?? false;
  const botStatus = status?.status ?? "DISABLED";
  const simPnl    = status?.simPnlCents ?? 0;
  const simWins   = status?.simWins ?? 0;
  const simLosses = status?.simLosses ?? 0;
  const noEdge    = status?.noEdgeCount ?? 0;
  const openCount = status?.openTradeCount ?? 0;
  const settled   = simWins + simLosses;
  const winRate   = settled > 0 ? (simWins / settled) * 100 : 0;
  const openPositions = status?.openPositions ?? [];
  const marketStates  = status?.marketStates ?? {};

  const statusColor =
    botStatus === "IN_TRADE" ? "text-sky-400" :
    botStatus === "SCANNING" ? "text-emerald-400" :
    "text-slate-500";

  const statusDot =
    botStatus === "IN_TRADE" ? "bg-sky-400 animate-pulse" :
    botStatus === "SCANNING" ? "bg-emerald-400 animate-pulse" :
    "bg-slate-600";

  const handleToggle = useCallback(() => {
    toggle.mutate(!enabled);
  }, [enabled, toggle]);

  const activeMarkets = Object.entries(marketStates).filter(
    ([, ms]) => ms.state !== "NO_TRADE",
  );

  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center border border-violet-400/30 bg-violet-400/10">
            <Activity className="w-4 h-4 text-violet-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">Outcome Mode</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-medium uppercase tracking-wider">Paper</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5">Structure-based trending · trailing stop · no forced trades</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
            <span className={`text-xs font-semibold ${statusColor}`}>{botStatus}</span>
          </div>
          <button
            onClick={handleToggle}
            disabled={toggle.isPending}
            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
              enabled ? "bg-violet-600" : "bg-white/10"
            } ${toggle.isPending ? "opacity-50" : ""}`}
          >
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
              enabled ? "translate-x-[22px]" : "translate-x-0.5"
            }`} />
          </button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-4 divide-x divide-white/5 border-b border-white/5">
        <div className="px-4 py-3 flex flex-col gap-0.5">
          <span className="text-[9px] text-slate-600 uppercase tracking-widest">Paper P&amp;L</span>
          <span className={`text-base font-bold font-mono ${simPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {fmtCents(simPnl, true)}
          </span>
        </div>
        <div className="px-4 py-3 flex flex-col gap-0.5">
          <span className="text-[9px] text-slate-600 uppercase tracking-widest">Win / Loss</span>
          <div className="flex items-baseline gap-1">
            <span className="text-base font-bold text-emerald-400">{simWins}</span>
            <span className="text-slate-600 text-xs">/</span>
            <span className="text-base font-bold text-red-400">{simLosses}</span>
          </div>
        </div>
        <div className="px-4 py-3 flex flex-col gap-0.5">
          <span className="text-[9px] text-slate-600 uppercase tracking-widest">Win Rate</span>
          <span className={`text-base font-bold ${winRate >= 50 ? "text-sky-300" : "text-slate-300"}`}>
            {settled > 0 ? `${winRate.toFixed(0)}%` : "—"}
          </span>
        </div>
        <div className="px-4 py-3 flex flex-col gap-0.5">
          <span className="text-[9px] text-slate-600 uppercase tracking-widest">No-Edge</span>
          <span className="text-base font-bold text-slate-400">{noEdge}</span>
        </div>
      </div>

      {/* Config Row */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <DollarSign className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-[10px] text-slate-500">Bet size</span>
          <input
            type="number"
            value={betCostCents}
            onChange={e => setBetCostCents(Math.max(1, parseInt(e.target.value) || 1))}
            disabled={enabled}
            className="w-16 px-2 py-0.5 rounded bg-white/5 border border-white/10 text-xs text-white font-mono text-right disabled:opacity-40"
          />
          <span className="text-[10px] text-slate-600">¢</span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[10px] text-slate-600">SL: 12¢ · Trail: +5¢ → -3¢ · No fixed TP</span>
        </div>
      </div>

      {/* Open Positions */}
      {openPositions.length > 0 && (
        <div className="px-5 py-3 border-b border-white/5">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Open Positions ({openCount})</p>
          <div className="space-y-1.5">
            {openPositions.map(pos => {
              const pnlPerContract = pos.side === "YES"
                ? (pos.lastYesPrice - pos.entryYesPrice)
                : (pos.entryYesPrice - pos.lastYesPrice);
              const pnl = Math.round(pnlPerContract * pos.contractCount);
              const minsLeft = Math.max(0, Math.floor(pos.msRemaining / 60000));
              const secsLeft = Math.floor((pos.msRemaining % 60000) / 1000);
              return (
                <div key={pos.posId} className="flex items-center justify-between rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">{coinLabel(pos.marketId)}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${pos.side === "YES" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                      {pos.side}
                    </span>
                    <span className="text-[10px] text-slate-500">×{pos.contractCount}</span>
                    {pos.trailingActive && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">TRAILING</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-right">
                    <span className={`text-xs font-mono font-bold ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {fmtPnlCents(pnl)}
                    </span>
                    <span className="text-[10px] text-slate-600">{minsLeft}:{String(secsLeft).padStart(2, "0")}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Last Decision */}
      {status?.lastDecision && (
        <div className="px-5 py-2.5 border-b border-white/5 flex items-start gap-2">
          <Zap className="w-3 h-3 text-violet-400 mt-0.5 shrink-0" />
          <span className="text-[11px] text-slate-400 font-mono leading-relaxed">{status.lastDecision}</span>
        </div>
      )}

      {/* Market States Toggle */}
      <button
        onClick={() => setShowMarkets(v => !v)}
        className="w-full flex items-center justify-between px-5 py-2.5 text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
      >
        <span className="uppercase tracking-widest">Market States ({Object.keys(marketStates).length} tracked · {activeMarkets.length} active signals)</span>
        {showMarkets ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {showMarkets && (
        <div className="px-5 pb-4 space-y-1.5">
          {Object.keys(marketStates).length === 0 && (
            <div className="flex items-center gap-2 text-[11px] text-slate-600 py-2">
              <AlertCircle className="w-3.5 h-3.5" />
              No markets tracked yet — waiting for price data to accumulate
            </div>
          )}
          {Object.entries(marketStates)
            .sort(([, a], [, b]) => {
              const order = { TRENDING: 0, BREAKOUT: 1, EMERGING: 2, NO_TRADE: 3 };
              return order[a.state] - order[b.state];
            })
            .map(([ticker, ms]) => (
              <div key={ticker} className="flex items-center justify-between rounded-lg bg-white/[0.02] border border-white/5 px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-300 w-10">{coinLabel(ticker)}</span>
                  <StateChip state={ms.state} direction={ms.direction} />
                </div>
                <div className="flex items-center gap-3 text-right">
                  {ms.latestPrice !== undefined && (
                    <span className="text-[10px] font-mono text-slate-400">{ms.latestPrice}¢</span>
                  )}
                  {ms.moveCents !== undefined && (
                    <span className="text-[10px] text-slate-500">{ms.moveCents.toFixed(1)}¢ move</span>
                  )}
                  <span className="text-[10px] text-slate-600">{ms.samples}s</span>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-white/5 bg-white/[0.01]">
        <div className="text-[10px] text-slate-600 space-y-0.5">
          <p>Trend: ≥3¢ over 60-120s · Emerging: ≥1.5¢ over 10-20s · Avoid 85-95¢ zones</p>
          <p>Stop: 12¢ · Trail activates at +5¢ · Exits at -3¢ retrace from peak</p>
        </div>
        <button
          onClick={() => {
            if (!confirm("Reset all Outcome Mode paper stats?")) return;
            reset.mutate();
          }}
          className="px-2.5 py-1 rounded-lg border border-slate-700/60 bg-slate-900/40 text-[10px] text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
