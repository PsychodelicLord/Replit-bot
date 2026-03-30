import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Terminal, Trash2, ListRestart } from "lucide-react";
import { format } from "date-fns";
import { useGetBotLogs } from "@workspace/api-client-react";

export function LogViewer() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [clearedAt, setClearedAt] = useState<Date | null>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  const { data } = useGetBotLogs({ limit: 200 }, { query: { refetchInterval: 3000 } });

  const visibleLogs = (data?.logs ?? []).filter((log) =>
    clearedAt ? new Date(log.createdAt) > clearedAt : true,
  );

  // Auto-scroll to bottom only when user hasn't manually scrolled up
  useEffect(() => {
    if (!userScrolled && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleLogs, userScrolled]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setUserScrolled(!atBottom);
  }

  function clearLogs() {
    setClearedAt(new Date());
    setUserScrolled(false);
  }

  function showAll() {
    setClearedAt(null);
    setUserScrolled(false);
  }

  return (
    <Card className="flex flex-col h-[500px] border-white/5 shadow-none bg-black/40">
      <CardHeader className="py-3 border-b border-white/5 bg-white/[0.01]">
        <CardTitle className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-primary" />
            System Logs
            {clearedAt && (
              <span className="text-[10px] text-slate-600 font-normal">
                (showing since {format(clearedAt, "HH:mm:ss")})
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {clearedAt && (
              <Button
                size="sm"
                variant="ghost"
                onClick={showAll}
                className="h-6 px-2 text-[10px] text-slate-400 hover:text-sky-300 gap-1"
              >
                <ListRestart className="w-3 h-3" />
                All
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={clearLogs}
              className="h-6 px-2 text-[10px] text-slate-400 hover:text-red-400 gap-1"
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto p-4 space-y-2 font-mono text-[11px] leading-relaxed"
        >
          {visibleLogs.length === 0 ? (
            <div className="text-muted-foreground text-center mt-10 italic">
              {clearedAt ? "No new logs since cleared." : "Awaiting telemetry..."}
            </div>
          ) : (
            visibleLogs.map((log) => (
              <div key={log.id} className="flex gap-3 hover:bg-white/[0.02] p-1 rounded transition-colors">
                <span className="text-muted-foreground/50 whitespace-nowrap">
                  {format(new Date(log.createdAt), "HH:mm:ss.SSS")}
                </span>
                <Badge
                  variant={log.level === "error" ? "destructive" : log.level === "warn" ? "warning" : "outline"}
                  className="px-1.5 py-0 h-4 text-[9px] uppercase rounded-sm border-0 bg-transparent font-bold w-12 justify-center"
                >
                  <span className={log.level === "info" ? "text-primary" : ""}>{log.level}</span>
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
