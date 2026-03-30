import { useGetBotStatus, useStartBot, useStopBot } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Activity, Power } from "lucide-react";

export function BotHeader() {
  const queryClient = useQueryClient();
  const { data: status } = useGetBotStatus({ query: { refetchInterval: 5000 } });
  
  const startMutation = useStartBot({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] })
    }
  });
  
  const stopMutation = useStopBot({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] })
    }
  });

  const isRunning = status?.running || false;
  const isPending = startMutation.isPending || stopMutation.isPending;

  const handleToggle = (checked: boolean) => {
    if (checked) startMutation.mutate();
    else stopMutation.mutate();
  };

  return (
    <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between py-6 px-8 border-b border-white/5 bg-card/40 backdrop-blur-md sticky top-0 z-50">
      <div className="flex items-center space-x-4 mb-4 sm:mb-0">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center border border-primary/20 shadow-lg shadow-primary/10">
          <Activity className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-display font-bold text-white tracking-tight">Kalshi Scalper</h1>
          <div className="flex items-center space-x-2 text-sm text-muted-foreground mt-0.5">
            <span className="font-mono text-xs">v1.0.0</span>
            <span>•</span>
            <span>15m Markets</span>
            <span>•</span>
            <span>Max Bet: $0.59</span>
          </div>
        </div>
      </div>

      <div className="flex items-center space-x-6 bg-white/[0.02] py-3 px-5 rounded-2xl border border-white/5">
        <div className="flex items-center space-x-3">
          <div className="relative flex h-3 w-3">
            {isRunning && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
            )}
            <span className={`relative inline-flex rounded-full h-3 w-3 ${isRunning ? 'bg-success shadow-[0_0_8px_rgba(34,197,94,0.8)]' : 'bg-destructive'}`}></span>
          </div>
          <span className="text-sm font-semibold tracking-wide uppercase text-white">
            {isRunning ? 'System Active' : 'System Offline'}
          </span>
        </div>
        
        <div className="w-px h-8 bg-white/10"></div>
        
        <div className="flex items-center space-x-3">
          <Power className={`w-4 h-4 ${isRunning ? 'text-success' : 'text-muted-foreground'}`} />
          <Switch 
            checked={isRunning} 
            onCheckedChange={handleToggle} 
            disabled={isPending}
          />
        </div>
      </div>
    </header>
  );
}
