import { format } from "date-fns";
import { useListTrades } from "@workspace/api-client-react";
import { formatMoney } from "@/lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { History, ArrowRightLeft } from "lucide-react";

export function TradeTable() {
  const { data, isLoading } = useListTrades({ limit: 50 }, { query: { refetchInterval: 5000 } });

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="py-5 border-b border-white/5">
        <CardTitle className="flex items-center">
          <History className="w-5 h-5 mr-2 text-primary" />
          Recent Executions
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden">
        <div className="h-full overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10 backdrop-blur-xl">
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Contracts</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Exit</TableHead>
                <TableHead className="text-right">Net P&L</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-xs">
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                    <div className="flex items-center justify-center space-x-2">
                      <ArrowRightLeft className="w-4 h-4 animate-spin" />
                      <span>Syncing ledger...</span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : !data || data.trades.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10 text-muted-foreground font-sans">
                    No trades executed yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.trades.map((trade) => (
                  <TableRow key={trade.id} className="group">
                    <TableCell className="text-muted-foreground">
                      {format(new Date(trade.createdAt), "MM/dd HH:mm")}
                    </TableCell>
                    <TableCell className="font-sans font-medium text-white max-w-[200px] truncate" title={trade.marketTitle}>
                      {trade.marketTitle}
                    </TableCell>
                    <TableCell>
                      <Badge variant={trade.side.toUpperCase() === 'YES' ? 'success' : 'destructive'} className="rounded font-bold text-[10px] px-1.5 py-0 h-5">
                        {trade.side.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{trade.contractCount}</TableCell>
                    <TableCell className="text-right text-gray-300">{formatMoney(trade.buyPriceCents)}</TableCell>
                    <TableCell className="text-right text-gray-300">{trade.sellPriceCents ? formatMoney(trade.sellPriceCents) : '-'}</TableCell>
                    <TableCell className="text-right font-bold">
                      {trade.pnlCents === null ? (
                        <span className="text-muted-foreground">-</span>
                      ) : (
                        <span className={trade.pnlCents > 0 ? "text-success" : trade.pnlCents < 0 ? "text-destructive" : "text-gray-400"}>
                          {trade.pnlCents > 0 ? "+" : ""}{formatMoney(trade.pnlCents)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`rounded-sm text-[10px] uppercase border-white/10 ${trade.status === 'open' ? 'text-blue-400' : 'text-gray-400'}`}>
                        {trade.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
