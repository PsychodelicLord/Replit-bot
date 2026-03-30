import { useGetTradeStats, useGetBotStatus } from "@workspace/api-client-react";
import { BotHeader } from "@/components/bot-header";
import { StatsCard } from "@/components/stats-card";
import { TradeTable } from "@/components/trade-table";
import { LogViewer } from "@/components/log-viewer";
import { BotSettings } from "@/components/bot-settings";
import {
  Wallet, Target, ActivitySquare, Crosshair,
  BarChart3, TrendingUp, ShieldCheck,
} from "lucide-react";

function formatMoney(cents: number) {
  const sign = cents < 0 ? "-" : cents > 0 ? "+" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function Dashboard() {
  const { data: stats } = useGetTradeStats({ query: { refetchInterval: 5000 } });
  const { data: status } = useGetBotStatus({ query: { refetchInterval: 3000 } });

  const totalPnl  = stats?.totalPnlCents ?? 0;
  const dailyPnl  = status?.dailyPnlCents ?? 0;
  const winRate   = stats?.winRate ? (stats.winRate * 100).toFixed(1) : "0.0";
  const openCount = status?.openPositionCount ?? stats?.openTrades ?? 0;

  return (
    <div className="min-h-screen flex flex-col bg-background pb-12">
      <BotHeader />

      <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 lg:gap-4">
          <StatsCard
            title="All-Time P&L"
            value={formatMoney(totalPnl)}
            valueClassName={totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}
            icon={Wallet}
          />
          <StatsCard
            title="Today's P&L"
            value={formatMoney(dailyPnl)}
            valueClassName={dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}
            icon={TrendingUp}
          />
          <StatsCard
            title="Win Rate"
            value={`${winRate}%`}
            icon={Target}
            valueClassName={parseFloat(winRate) >= 50 ? "text-sky-300" : "text-slate-300"}
          />
          <StatsCard
            title="Total Trades"
            value={stats?.totalTrades ?? 0}
            icon={ActivitySquare}
          />
          <StatsCard
            title="Open Positions"
            value={openCount}
            icon={Crosshair}
            valueClassName={openCount > 0 ? "text-sky-300" : undefined}
          />
          <StatsCard
            title="Markets Scanned"
            value={status?.marketsScanned ?? 0}
            icon={BarChart3}
          />
        </div>

        {/* Settings */}
        <BotSettings />

        {/* Trade table + Logs */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 h-[600px]">
            <TradeTable />
          </div>
          <div className="lg:col-span-1">
            <LogViewer />
          </div>
        </div>

      </main>
    </div>
  );
}
