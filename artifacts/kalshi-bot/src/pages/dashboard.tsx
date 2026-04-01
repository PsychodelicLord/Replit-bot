import { useGetTradeStats, useGetBotStatus } from "@workspace/api-client-react";
import { CoinFlip } from "@/components/coin-flip";
import { CoinFlipSettings } from "@/components/coin-flip-settings";
import { TradeTable } from "@/components/trade-table";
import { Coins, Wallet, TrendingUp, TrendingDown, Trophy, Skull, BarChart2 } from "lucide-react";

function money(cents: number, sign = false) {
  const prefix = sign ? (cents > 0 ? "+" : cents < 0 ? "-" : "") : cents < 0 ? "-" : "";
  return `${prefix}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function StatPill({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5">
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className="text-xs text-slate-400">{label}</span>
      <span className={`text-sm font-bold font-mono ${color}`}>{value}</span>
    </div>
  );
}

export function Dashboard() {
  const { data: stats } = useGetTradeStats({ query: { refetchInterval: 5000 } });
  const { data: status } = useGetBotStatus({ query: { refetchInterval: 3000 } });

  const balance      = status?.balanceCents ?? 0;
  const todayPnl     = stats?.todayPnlCents ?? 0;
  const totalPnl     = stats?.totalPnlCents ?? 0;
  const wins         = stats?.winningTrades ?? 0;
  const losses       = stats?.losingTrades ?? 0;
  const winRate      = stats?.winRate ?? 0;
  const totalEarned  = stats?.totalWinCents ?? 0;
  const totalLost    = stats?.totalLossCents ?? 0;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-black/60 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center border border-yellow-400/30 bg-yellow-400/10">
              <Coins className="w-4 h-4 text-yellow-400" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white leading-none">Instinct Coin Flip</h1>
              <p className="text-[10px] text-slate-500 mt-0.5">Kalshi · 15-min markets · 24/7</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {balance > 0 && (
              <StatPill icon={Wallet} label="Balance" value={`$${(balance / 100).toFixed(2)}`} color="text-white" />
            )}
            <StatPill
              icon={TrendingUp}
              label="Today"
              value={money(todayPnl, true)}
              color={todayPnl >= 0 ? "text-emerald-400" : "text-red-400"}
            />
            <StatPill
              icon={todayPnl >= 0 ? TrendingUp : TrendingDown}
              label="All-time"
              value={money(totalPnl, true)}
              color={totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}
            />
          </div>
        </div>
      </header>

      {/* Stats Row */}
      <div className="max-w-4xl w-full mx-auto px-4 pt-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 flex flex-col gap-0.5">
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">Win / Loss</span>
            <div className="flex items-baseline gap-1.5 mt-1">
              <span className="text-lg font-bold text-emerald-400">{wins}</span>
              <span className="text-slate-600">/</span>
              <span className="text-lg font-bold text-red-400">{losses}</span>
            </div>
            <span className="text-[10px] text-slate-600">settled trades</span>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 flex flex-col gap-0.5">
            <span className="text-[10px] text-slate-500 uppercase tracking-widest">Win Rate</span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className={`text-lg font-bold ${winRate >= 0.5 ? "text-sky-300" : "text-slate-300"}`}>
                {(winRate * 100).toFixed(1)}%
              </span>
            </div>
            <span className="text-[10px] text-slate-600">of closed trades</span>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <Trophy className="w-3 h-3 text-emerald-500" />
              <span className="text-[10px] text-slate-500 uppercase tracking-widest">Earned</span>
            </div>
            <span className="text-lg font-bold text-emerald-400 mt-1">+${(totalEarned / 100).toFixed(2)}</span>
            <span className="text-[10px] text-slate-600">total from wins</span>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3 flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <Skull className="w-3 h-3 text-red-500" />
              <span className="text-[10px] text-slate-500 uppercase tracking-widest">Lost</span>
            </div>
            <span className="text-lg font-bold text-red-400 mt-1">-${(totalLost / 100).toFixed(2)}</span>
            <span className="text-[10px] text-slate-600">total from losses</span>
          </div>
        </div>
      </div>

      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 space-y-6 pb-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          <CoinFlip />
          <CoinFlipSettings />
        </div>
        <TradeTable />
      </main>
    </div>
  );
}
