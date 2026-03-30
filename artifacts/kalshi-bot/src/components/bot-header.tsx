import { useGetBotStatus, useStartBot, useStopBot } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Zap, Power, TrendingUp, Wallet } from "lucide-react";

export function BotHeader() {
  const queryClient = useQueryClient();
  const { data: status } = useGetBotStatus({ query: { refetchInterval: 3000 } });

  const startMutation = useStartBot({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] }) },
  });
  const stopMutation = useStopBot({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] }) },
  });

  const isRunning = status?.running || false;
  const isPending = startMutation.isPending || stopMutation.isPending;

  const dailyPnl = status?.dailyPnlCents ?? 0;
  const balanceCents = status?.balanceCents ?? 0;

  const handleToggle = (checked: boolean) => {
    if (checked) startMutation.mutate();
    else stopMutation.mutate();
  };

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-black/60 backdrop-blur-xl">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-8 py-4 flex flex-wrap items-center gap-4 justify-between">
        
        {/* Logo / Name */}
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center border transition-all duration-500 ${
              isRunning
                ? "border-sky-400/50 bg-sky-400/10 ui-glow-active animate-aura"
                : "border-white/10 bg-white/5"
            }`}>
              <Zap className={`w-6 h-6 transition-colors duration-300 ${isRunning ? "text-sky-300" : "text-slate-500"}`} />
            </div>
            {isRunning && (
              <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-sky-400 animate-instinct-pulse shadow-[0_0_8px_rgba(56,189,248,0.8)]" />
            )}
          </div>
          <div>
            <h1 className="text-2xl font-display font-bold text-gradient leading-none">
              Instinct Scalper
            </h1>
            <p className="text-xs font-mono text-slate-500 mt-1">
              15-min markets · RSA-signed · Kalshi
            </p>
          </div>
        </div>

        {/* Live stats pill row */}
        <div className="flex items-center flex-wrap gap-3">

          {/* Balance */}
          {balanceCents > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.03] border border-white/5">
              <Wallet className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-xs text-slate-400 font-mono">Balance</span>
              <span className="text-sm font-bold font-mono text-white">
                ${(balanceCents / 100).toFixed(2)}
              </span>
            </div>
          )}

          {/* Daily P&L */}
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.03] border border-white/5">
            <TrendingUp className="w-3.5 h-3.5 text-slate-500" />
            <span className="text-xs text-slate-400 font-mono">Today</span>
            <span className={`text-sm font-bold font-mono ${dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {dailyPnl >= 0 ? "+" : ""}${(dailyPnl / 100).toFixed(2)}
            </span>
          </div>

          {/* Power toggle */}
          <div className={`flex items-center gap-3 px-5 py-2.5 rounded-xl border transition-all duration-300 ${
            isRunning
              ? "bg-sky-400/5 border-sky-400/30 ui-glow"
              : "bg-white/[0.02] border-white/5"
          }`}>
            <div className="flex items-center gap-2">
              <div className="relative flex h-2.5 w-2.5">
                {isRunning && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
                )}
                <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                  isRunning ? "bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.8)]" : "bg-slate-600"
                }`} />
              </div>
              <span className={`text-xs font-semibold uppercase tracking-widest ${
                isRunning ? "text-sky-300" : "text-slate-500"
              }`}>
                {isRunning ? "Active" : "Offline"}
              </span>
            </div>
            <div className="w-px h-5 bg-white/8" />
            <div className="flex items-center gap-2">
              <Power className={`w-3.5 h-3.5 ${isRunning ? "text-sky-400" : "text-slate-600"}`} />
              <Switch checked={isRunning} onCheckedChange={handleToggle} disabled={isPending} />
            </div>
          </div>

        </div>
      </div>

      {/* Stopped reason banner */}
      {!isRunning && status?.stoppedReason && (
        <div className="bg-amber-500/10 border-t border-amber-500/20 px-8 py-2 text-xs font-mono text-amber-300 flex items-center gap-2">
          <span className="text-amber-500">⚠</span>
          Auto-stopped: {status.stoppedReason}
        </div>
      )}
    </header>
  );
}
