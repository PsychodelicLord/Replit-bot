import { useEffect, useState } from "react";
import { useGetBotConfig, useUpdateBotConfig, getGetBotConfigQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Settings2, Save, ChevronDown, ChevronUp,
  Shield, SlidersHorizontal, Layers,
} from "lucide-react";

const ALL_COINS = ["BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "MATIC"] as const;
const ALL_CATS  = ["crypto", "sports"] as const;

interface FormState {
  maxEntryPriceCents: string;
  minNetProfitCents: string;
  maxNetProfitCents: string;
  minMinutesRemaining: string;
  feeRateDisplay: string;
  pollIntervalSecs: string;
  maxOpenPositions: string;
  balanceFloorCents: string;
  dailyProfitTargetCents: string;
  dailyLossLimitCents: string;
  marketCategories: string[];
  cryptoCoins: string[];
}

const defaults: FormState = {
  maxEntryPriceCents: "59",
  minNetProfitCents: "5",
  maxNetProfitCents: "99",
  minMinutesRemaining: "10",
  feeRateDisplay: "7",
  pollIntervalSecs: "5",
  maxOpenPositions: "3",
  balanceFloorCents: "0",
  dailyProfitTargetCents: "0",
  dailyLossLimitCents: "0",
  marketCategories: ["crypto", "sports"],
  cryptoCoins: ["BTC", "ETH", "SOL", "DOGE"],
};

export function BotSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useGetBotConfig();
  const updateConfig = useUpdateBotConfig();
  const [open, setOpen] = useState(true);
  const [form, setForm] = useState<FormState>(defaults);

  useEffect(() => {
    if (!config) return;
    setForm({
      maxEntryPriceCents: String(config.maxEntryPriceCents ?? 59),
      minNetProfitCents: String(config.minNetProfitCents ?? 5),
      maxNetProfitCents: String(config.maxNetProfitCents ?? 25),
      minMinutesRemaining: String(config.minMinutesRemaining ?? 10),
      feeRateDisplay: config.feeRate ? String(Math.round(config.feeRate * 10000) / 100) : "7",
      pollIntervalSecs: String(config.pollIntervalSecs ?? 20),
      maxOpenPositions: String(config.maxOpenPositions ?? 3),
      balanceFloorCents: String(config.balanceFloorCents ?? 0),
      dailyProfitTargetCents: String(config.dailyProfitTargetCents ?? 0),
      dailyLossLimitCents: String(config.dailyLossLimitCents ?? 0),
      marketCategories: config.marketCategories ?? ["crypto", "sports"],
      cryptoCoins: config.cryptoCoins ?? ["BTC", "ETH", "SOL", "DOGE"],
    });
  }, [config]);

  const field = (name: keyof FormState) => ({
    value: form[name] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((p) => ({ ...p, [name]: e.target.value })),
  });

  function toggleCategory(cat: string) {
    setForm((p) => {
      const has = p.marketCategories.includes(cat);
      const next = has ? p.marketCategories.filter((c) => c !== cat) : [...p.marketCategories, cat];
      return { ...p, marketCategories: next.length ? next : p.marketCategories };
    });
  }

  function toggleCoin(coin: string) {
    setForm((p) => {
      const has = p.cryptoCoins.includes(coin);
      const next = has ? p.cryptoCoins.filter((c) => c !== coin) : [...p.cryptoCoins, coin];
      return { ...p, cryptoCoins: next };
    });
  }

  function handleSave() {
    updateConfig.mutate(
      {
        data: {
          maxEntryPriceCents: parseInt(form.maxEntryPriceCents),
          minNetProfitCents: parseInt(form.minNetProfitCents),
          maxNetProfitCents: parseInt(form.maxNetProfitCents),
          minMinutesRemaining: parseInt(form.minMinutesRemaining),
          feeRate: parseFloat(form.feeRateDisplay) / 100,
          pollIntervalSecs: parseInt(form.pollIntervalSecs),
          maxOpenPositions: parseInt(form.maxOpenPositions),
          balanceFloorCents: parseInt(form.balanceFloorCents) || 0,
          dailyProfitTargetCents: parseInt(form.dailyProfitTargetCents) || 0,
          dailyLossLimitCents: parseInt(form.dailyLossLimitCents) || 0,
          marketCategories: form.marketCategories,
          cryptoCoins: form.cryptoCoins,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Settings saved", description: "Bot configuration updated." });
          queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to update configuration.", variant: "destructive" });
        },
      }
    );
  }

  const showCoins = form.marketCategories.includes("crypto");

  return (
    <Card className="instinct-border bg-card/60 backdrop-blur-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 group text-left"
          >
            <Settings2 className="w-4 h-4 text-sky-400" />
            <CardTitle className="text-base text-white/90 group-hover:text-white transition-colors">
              Configuration
            </CardTitle>
            {open
              ? <ChevronUp className="w-4 h-4 text-slate-500" />
              : <ChevronDown className="w-4 h-4 text-slate-500" />}
          </button>
          {open && (
            <Button
              size="sm"
              onClick={handleSave}
              disabled={updateConfig.isPending || isLoading}
              className="bg-sky-500/20 border border-sky-400/30 text-sky-300 hover:bg-sky-500/30 hover:text-sky-200 gap-2"
            >
              <Save className="w-3.5 h-3.5" />
              {updateConfig.isPending ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </CardHeader>

      {open && (
        <CardContent className="space-y-8 pt-2">

          {/* ── Section 1: Market Selection ─────────────────────── */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
              <Layers className="w-3.5 h-3.5" />
              Market Selection
            </div>

            <div className="space-y-3">
              <div>
                <Label className="text-xs text-slate-400 mb-2 block">Categories to trade</Label>
                <div className="flex gap-2">
                  {ALL_CATS.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => toggleCategory(cat)}
                      className={`pill-toggle ${form.marketCategories.includes(cat) ? "pill-toggle-active" : ""}`}
                    >
                      {cat === "crypto" ? "₿ Crypto" : "🏟 Sports"}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-600 mt-1.5">Select one or both. Sports markets tend to be shorter events.</p>
              </div>

              {showCoins && (
                <div>
                  <Label className="text-xs text-slate-400 mb-2 block">Crypto coins</Label>
                  <div className="flex flex-wrap gap-2">
                    {ALL_COINS.map((coin) => (
                      <button
                        key={coin}
                        onClick={() => toggleCoin(coin)}
                        className={`coin-chip ${form.cryptoCoins.includes(coin) ? "coin-chip-active" : ""}`}
                      >
                        {coin}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-600 mt-1.5">Deselect all to trade any crypto market Kalshi has open.</p>
                </div>
              )}
            </div>
          </section>

          <div className="border-t border-white/5" />

          {/* ── Section 2: Trading Parameters ──────────────────── */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Trading Parameters
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <SettingField label="Max Entry (¢)" hint="Skip if ask > this" {...field("maxEntryPriceCents")} type="number" />
              <SettingField label="Min Profit (¢)" hint="Exit when net ≥ this — no upper cap" {...field("minNetProfitCents")} type="number" />
              <SettingField label="Min Time Left (min)" hint="Skip if ≤ this left" {...field("minMinutesRemaining")} type="number" />
              <SettingField label="Fee Rate (%)" hint="Kalshi fee on profit" {...field("feeRateDisplay")} type="number" step="0.01" />
              <SettingField label="Scan Every (sec)" hint="Lower = faster, more API calls" {...field("pollIntervalSecs")} type="number" />
            </div>
          </section>

          <div className="border-t border-white/5" />

          {/* ── Section 3: Safety Guards ────────────────────────── */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
              <Shield className="w-3.5 h-3.5" />
              Safety Guards
              <span className="text-slate-600 normal-case font-normal tracking-normal">— set to 0 to disable</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SettingField
                label="Max Open Trades"
                hint="Stop entering if this many open"
                {...field("maxOpenPositions")}
                type="number"
              />
              <SettingField
                label="Balance Floor ($)"
                hint="Auto-stop if balance drops below"
                value={(parseInt(form.balanceFloorCents) / 100).toFixed(2)}
                onChange={(e) => setForm((p) => ({ ...p, balanceFloorCents: String(Math.round(parseFloat(e.target.value) * 100) || 0) }))}
                type="number"
                step="0.01"
              />
              <SettingField
                label="Daily Profit Target ($)"
                hint="Auto-stop when daily gain hits"
                value={(parseInt(form.dailyProfitTargetCents) / 100).toFixed(2)}
                onChange={(e) => setForm((p) => ({ ...p, dailyProfitTargetCents: String(Math.round(parseFloat(e.target.value) * 100) || 0) }))}
                type="number"
                step="0.01"
              />
              <SettingField
                label="Daily Loss Limit ($)"
                hint="Auto-stop when daily loss hits"
                value={(parseInt(form.dailyLossLimitCents) / 100).toFixed(2)}
                onChange={(e) => setForm((p) => ({ ...p, dailyLossLimitCents: String(Math.round(parseFloat(e.target.value) * 100) || 0) }))}
                type="number"
                step="0.01"
              />
            </div>
          </section>

        </CardContent>
      )}
    </Card>
  );
}

function SettingField({
  label, hint, value, onChange, type = "text", step,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  step?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-slate-400">{label}</Label>
      <Input
        type={type}
        step={step}
        value={value}
        onChange={onChange}
        className="font-mono text-sm bg-white/[0.03] border-white/10 text-white focus:border-sky-400/50 focus:ring-sky-400/20 h-9"
      />
      <p className="text-[10px] text-slate-600">{hint}</p>
    </div>
  );
}
