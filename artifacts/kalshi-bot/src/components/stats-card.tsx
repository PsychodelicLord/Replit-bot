import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  valueClassName?: string;
}

export function StatsCard({ title, value, icon: Icon, valueClassName }: StatsCardProps) {
  return (
    <Card className="overflow-hidden relative group bg-card/60 instinct-border hover:border-sky-400/20 transition-all duration-300 backdrop-blur-sm">
      <div className="absolute inset-0 bg-gradient-to-br from-sky-400/[0.03] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest truncate">{title}</span>
            <span className={cn("text-xl font-display font-bold tabular-nums", valueClassName ?? "text-white")}>
              {value}
            </span>
          </div>
          <div className="p-2 bg-white/[0.04] rounded-lg text-slate-600 group-hover:text-sky-400 group-hover:bg-sky-400/10 transition-all duration-300 shrink-0">
            <Icon className="w-4 h-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
