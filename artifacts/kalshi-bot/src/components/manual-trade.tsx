import { useState } from "react";
import { useManualTrade } from "@workspace/api-client-react";
import { Crosshair, ChevronDown, AlertCircle, CheckCircle2 } from "lucide-react";

export function ManualTrade() {
  const [ticker, setTicker]     = useState("");
  const [side, setSide]         = useState<"YES" | "NO">("YES");
  const [limitCents, setLimit]  = useState<number>(50);
  const [quantity, setQty]      = useState<number>(1);
  const [result, setResult]     = useState<{ success: boolean; message: string } | null>(null);

  const { mutate, isPending } = useManualTrade({
    mutation: {
      onSuccess: (data) => setResult(data),
      onError: (err: unknown) => setResult({ success: false, message: String(err) }),
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    mutate({ data: { ticker: ticker.trim().toUpperCase(), side, limitCents, quantity } });
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <Crosshair className="w-4 h-4 text-sky-400" />
        <h2 className="text-sm font-semibold tracking-widest uppercase text-sky-400">
          Manual Trade
        </h2>
      </div>

      <form onSubmit={submit} className="space-y-3">
        {/* Ticker */}
        <div className="space-y-1">
          <label className="text-xs text-slate-400 uppercase tracking-wider">Market Ticker</label>
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            placeholder="e.g. KXBTC15M-26MAR300930-30"
            required
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/30 font-mono"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          {/* Side */}
          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase tracking-wider">Side</label>
            <div className="flex rounded-lg overflow-hidden border border-white/10">
              <button
                type="button"
                onClick={() => setSide("YES")}
                className={`flex-1 py-2 text-xs font-bold tracking-wider transition-colors ${
                  side === "YES"
                    ? "bg-emerald-500/30 text-emerald-300 border-r border-white/10"
                    : "bg-white/5 text-slate-400 hover:bg-white/10 border-r border-white/10"
                }`}
              >
                YES
              </button>
              <button
                type="button"
                onClick={() => setSide("NO")}
                className={`flex-1 py-2 text-xs font-bold tracking-wider transition-colors ${
                  side === "NO"
                    ? "bg-red-500/30 text-red-300"
                    : "bg-white/5 text-slate-400 hover:bg-white/10"
                }`}
              >
                NO
              </button>
            </div>
          </div>

          {/* Limit Price */}
          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase tracking-wider">Limit Price (¢)</label>
            <input
              type="number"
              min={1}
              max={99}
              value={limitCents}
              onChange={(e) => setLimit(Number(e.target.value))}
              required
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/30"
            />
          </div>

          {/* Quantity */}
          <div className="space-y-1">
            <label className="text-xs text-slate-400 uppercase tracking-wider">Qty</label>
            <input
              type="number"
              min={1}
              max={500}
              value={quantity}
              onChange={(e) => setQty(Number(e.target.value))}
              required
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/30"
            />
          </div>
        </div>

        {/* Cost estimate */}
        <p className="text-xs text-slate-500">
          Est. cost: <span className="text-slate-300">${((limitCents * quantity) / 100).toFixed(2)}</span>
          {" · "}limit buy {quantity}x {side} @ {limitCents}¢
        </p>

        <button
          type="submit"
          disabled={isPending || !ticker.trim()}
          className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold tracking-wider transition-colors"
        >
          {isPending ? "Placing Order…" : "Place Order"}
        </button>
      </form>

      {/* Result */}
      {result && (
        <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
          result.success
            ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
            : "bg-red-500/10 border border-red-500/20 text-red-300"
        }`}>
          {result.success
            ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <span className="font-mono break-all">{result.message}</span>
        </div>
      )}
    </div>
  );
}
