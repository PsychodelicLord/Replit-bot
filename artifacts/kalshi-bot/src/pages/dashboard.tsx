import { useGetTradeStats, useGetBotStatus } from "@workspace/api-client-react";
import { CoinFlip } from "@/components/coin-flip";
import { CoinFlipSettings } from "@/components/coin-flip-settings";
import { TradeTable } from "@/components/trade-table";
import { Coins, Wallet, TrendingUp, TrendingDown } from "lucide-react";

function fmt(cents: number) {
  const sign = cents < 0 ? "-" : cents > 0 ? "+" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function Dashboard() {
  const { data: stats } = useGetTradeStats({ query: { refetchInterval: 5000 } });
  const { data: status } = useGetBotStatus({ query: { refetchInterval: 3000 } });

  const totalPnl = stats?.totalPnlCents ?? 0;
  const dailyPnl = stats?.todayPnlCents ?? 0;
  const balance = status?.balanceCents ?? 0;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="sticky top-0 z-50 border-b border-white/5 bg-black/60 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center border border-yellow-400/30 bg-yellow-400/10">
              <Coins className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white leading-none">Instinct Coin Flip</h1>
              <p className="text-xs text-slate-500 mt-0.5">Kalshi · 15-min markets · 24/7</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {balance > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5">
                <Wallet className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-xs text-slate-400">Balance</span>
                <span className="text-sm font-bold font-mono text-white">${(balance / 100).toFixed(2)}</span>
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5">
              <TrendingUp className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-xs text-slate-400">Today</span>
              <span className={`text-sm font-bold font-mono ${dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(dailyPnl)}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/5">
              <TrendingDown className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-xs text-slate-400">All-time</span>
              <span className={`text-sm font-bold font-mono ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(totalPnl)}</span>
            </div>
          </div>
        </div>
      </header>

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
