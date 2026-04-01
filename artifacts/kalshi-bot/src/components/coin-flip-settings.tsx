import { useEffect, useState } from "react";
import { useGetBotConfig, useUpdateBotConfig, getGetBotConfigQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Settings2, Save, Shield } from "lucide-react";

const ALL_COINS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "ADA"] as const;

interface FormState {
  balanceFloor: string;
  maxBetCents: string;
  maxConcurrent: string;
  minProfitCents: string;
  minMinutesRemaining: string;
  cryptoCoins: string[];
}

export function CoinFlipSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useGetBotConfig();
  const updateConfig = useUpdateBotConfig();

  const [form, setForm] = useState<FormState>({
    balanceFloor: "0.00",
    maxBetCents: "59",
    maxConcurrent: "1",
    minProfitCents: "5",
    minMinutesRemaining: "4",
    cryptoCoins: ["BTC", "ETH", "SOL", "DOGE"],
  });

  useEffect(() => {
    if (!config) return;
    setForm({
      balanceFloor: ((config.balanceFloorCents ?? 0) / 100).toFixed(2),
      maxBetCents: String(config.maxEntryPriceCents ?? 59),
      maxConcurrent: String(config.maxOpenPositions ?? 1),
      minProfitCents: String(config.minNetProfitCents ?? 5),
      minMinutesRemaining: String(config.minMinutesRemaining ?? 4),
      cryptoCoins: config.cryptoCoins?.length ? config.cryptoCoins : ["BTC", "ETH", "SOL", "DOGE"],
    });
  }, [config]);

  function toggleCoin(coin: string) {
    setForm((p) => {
      const has = p.cryptoCoins.includes(coin);
      return { ...p, cryptoCoins: has ? p.cryptoCoins.filter((c) => c !== coin) : [...p.cryptoCoins, coin] };
    });
  }

  function handleSave() {
    const bf = Math.round(parseFloat(form.balanceFloor) * 100);
    updateConfig.mutate(
      {
        data: {
          balanceFloorCents: isNaN(bf) ? 0 : bf,
          maxEntryPriceCents: parseInt(form.maxBetCents) || 59,
          maxOpenPositions: parseInt(form.maxConcurrent) || 1,
          minNetProfitCents: parseInt(form.minProfitCents) || 5,
          minMinutesRemaining: parseInt(form.minMinutesRemaining) || 4,
          marketCategories: ["crypto"],
          cryptoCoins: form.cryptoCoins.length ? form.cryptoCoins : ["BTC", "ETH", "SOL", "DOGE"],
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Saved", description: "Settings updated." });
          queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to save settings.", variant: "destructive" });
        },
      }
    );
  }

  const set = (key: keyof Omit<FormState, "cryptoCoins">) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((p) => ({ ...p, [key]: e.target.value }));

  return (
    <Card className="instinct-border bg-card/60 backdrop-blur-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-sky-400" />
            <CardTitle className="text-base text-white/90">Settings</CardTitle>
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateConfig.isPending || isLoading}
            className="bg-sky-500/20 border border-sky-400/30 text-sky-300 hover:bg-sky-500/30 hover:text-sky-200 gap-2"
          >
            <Save className="w-3.5 h-3.5" />
            {updateConfig.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
          <Shield className="w-3.5 h-3.5" />
          Coin Flip Configuration
        </div>

        {/* Crypto coins */}
        <div className="space-y-1.5">
          <Label className="text-xs text-slate-400">Crypto Coins</Label>
          <div className="flex flex-wrap gap-2">
            {ALL_COINS.map((coin) => (
              <button
                key={coin}
                type="button"
                onClick={() => toggleCoin(coin)}
                className={`px-3 py-1 rounded-full text-xs font-bold border transition-all ${
                  form.cryptoCoins.includes(coin)
                    ? "bg-sky-500/20 border-sky-400/40 text-sky-300"
                    : "bg-white/[0.03] border-white/10 text-slate-500 hover:border-white/20"
                }`}
              >
                {coin}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-600">Toggle which coins to flip on. Select all to trade any crypto.</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-slate-400">Balance Floor ($)</Label>
          <Input
            type="number" step="0.01" min="0"
            value={form.balanceFloor} onChange={set("balanceFloor")}
            className="font-mono text-sm bg-white/[0.03] border-white/10 text-white h-9"
          />
          <p className="text-[10px] text-slate-600">Auto-stop if balance drops below this</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-slate-400">Max Bet (¢ per contract)</Label>
          <Input
            type="number" min="1" max="89"
            value={form.maxBetCents} onChange={set("maxBetCents")}
            className="font-mono text-sm bg-white/[0.03] border-white/10 text-white h-9"
          />
          <p className="text-[10px] text-slate-600">Skip contracts above this entry price (1–89¢)</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-slate-400">Auto-Sell Profit Target (¢)</Label>
          <Input
            type="number" min="1"
            value={form.minProfitCents} onChange={set("minProfitCents")}
            className="font-mono text-sm bg-white/[0.03] border-white/10 text-white h-9"
          />
          <p className="text-[10px] text-slate-600">Sell automatically when net profit hits this amount</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-slate-400">Min Time Remaining (min)</Label>
          <Input
            type="number" min="1" max="14"
            value={form.minMinutesRemaining} onChange={set("minMinutesRemaining")}
            className="font-mono text-sm bg-white/[0.03] border-white/10 text-white h-9"
          />
          <p className="text-[10px] text-slate-600">Only bet on markets with at least this many minutes left</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-slate-400">Max Bets at a Time</Label>
          <Input
            type="number" min="1" max="10"
            value={form.maxConcurrent} onChange={set("maxConcurrent")}
            className="font-mono text-sm bg-white/[0.03] border-white/10 text-white h-9"
          />
          <p className="text-[10px] text-slate-600">Max open positions at once (default: 1)</p>
        </div>
      </CardContent>
    </Card>
  );
}
