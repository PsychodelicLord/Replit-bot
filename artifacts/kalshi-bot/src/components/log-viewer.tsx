import { useEffect, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Terminal } from "lucide-react";
import { format } from "date-fns";
import { useGetBotLogs } from "@workspace/api-client-react";

export function LogViewer() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data } = useGetBotLogs({ limit: 100 }, { query: { refetchInterval: 3000 } });

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data?.logs]);

  return (
    <Card className="flex flex-col h-[500px] border-white/5 shadow-none bg-black/40">
      <CardHeader className="py-4 border-b border-white/5 bg-white/[0.01]">
        <CardTitle className="flex items-center text-sm">
          <Terminal className="w-4 h-4 mr-2 text-primary" />
          System Logs
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto p-4 space-y-2 font-mono text-[11px] leading-relaxed">
          {!data || data.logs.length === 0 ? (
            <div className="text-muted-foreground text-center mt-10 italic">Awaiting telemetry...</div>
          ) : (
            data.logs.map((log) => (
              <div key={log.id} className="flex gap-3 hover:bg-white/[0.02] p-1 rounded transition-colors">
                <span className="text-muted-foreground/50 whitespace-nowrap">
                  {format(new Date(log.createdAt), "HH:mm:ss.SSS")}
                </span>
                <Badge 
                  variant={log.level === 'error' ? 'destructive' : log.level === 'warn' ? 'warning' : 'outline'}
                  className="px-1.5 py-0 h-4 text-[9px] uppercase rounded-sm border-0 bg-transparent font-bold w-12 justify-center"
                >
                  <span className={log.level === 'info' ? 'text-primary' : ''}>{log.level}</span>
                </Badge>
                <span className="text-gray-300 break-words flex-1">
                  {log.message}
                  {log.data && (
                    <span className="text-muted-foreground ml-2 opacity-60">{log.data}</span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
