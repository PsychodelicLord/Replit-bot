import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  valueClassName?: string;
}

export function StatsCard({ title, value, icon: Icon, trend, valueClassName }: StatsCardProps) {
  return (
    <Card className="overflow-hidden relative group hover:border-white/10">
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.03] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      <CardContent className="p-6">
        <div className="flex items-center justify-between space-x-4">
          <div className="flex flex-col space-y-2">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{title}</span>
            <div className="flex items-baseline space-x-3">
              <span className={cn("text-3xl font-display font-semibold", valueClassName || "text-white")}>
                {value}
              </span>
              {trend && (
                <span className={cn("text-xs font-medium", trend.isPositive ? "text-success" : "text-destructive")}>
                  {trend.isPositive ? "+" : "-"}{Math.abs(trend.value)}%
                </span>
              )}
            </div>
          </div>
          <div className="p-3 bg-white/5 rounded-xl text-muted-foreground group-hover:text-primary group-hover:scale-110 transition-all duration-300">
            <Icon className="w-6 h-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
