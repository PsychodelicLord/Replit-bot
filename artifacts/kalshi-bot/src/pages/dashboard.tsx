import { useGetTradeStats, useGetBotStatus } from "@workspace/api-client-react";
import { formatMoney } from "@/lib/utils";
import { BotHeader } from "@/components/bot-header";
import { StatsCard } from "@/components/stats-card";
import { TradeTable } from "@/components/trade-table";
import { LogViewer } from "@/components/log-viewer";
import { BotSettings } from "@/components/bot-settings";
import { Wallet, Target, ActivitySquare, Crosshair, BarChart3 } from "lucide-react";

export function Dashboard() {
  const { data: stats } = useGetTradeStats({ query: { refetchInterval: 5000 } });
  const { data: botStatus } = useGetBotStatus({ query: { refetchInterval: 5000 } });

  const totalPnl = stats?.totalPnlCents || 0;
  const winRate = stats?.winRate ? (stats.winRate * 100).toFixed(1) : "0.0";
  
  return (
    <div className="min-h-screen flex flex-col bg-background pb-12">
      <BotHeader />
      
      <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-8">
        
        {/* Stats Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 lg:gap-6">
          <StatsCard 
            title="Net Profit" 
            value={formatMoney(totalPnl)}
            valueClassName={totalPnl >= 0 ? "text-success" : "text-destructive"}
            icon={Wallet} 
          />
          <StatsCard 
            title="Win Rate" 
            value={`${winRate}%`} 
            icon={Target}
          />
          <StatsCard 
            title="Total Trades" 
            value={stats?.totalTrades || 0} 
            icon={ActivitySquare}
          />
          <StatsCard 
            title="Open Positions" 
            value={stats?.openTrades || 0} 
            icon={Crosshair}
          />
          <StatsCard 
            title="Markets Scanned" 
            value={botStatus?.marketsScanned || 0} 
            icon={BarChart3}
          />
        </div>

        {/* Settings Panel */}
        <BotSettings />

        {/* Main Content Split */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8 items-start">
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
