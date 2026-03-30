import { useState, useEffect } from "react";
import { useCoinFlipTrade } from "@workspace/api-client-react";
import { CheckCircle2, AlertCircle, Coins } from "lucide-react";

type FlipResult = {
  success: boolean;
  message: string;
  ticker?: string;
  title?: string;
  side?: "YES" | "NO";
  priceCents?: number;
};

export function CoinFlip() {
  const [flipping, setFlipping] = useState(false);
  const [landed, setLanded] = useState<"YES" | "NO" | null>(null);
  const [result, setResult] = useState<FlipResult | null>(null);
  const [animKey, setAnimKey] = useState(0);

  const { mutate } = useCoinFlipTrade({
    mutation: {
      onSuccess: (data) => {
        setTimeout(() => {
          setFlipping(false);
          setLanded(data.side ?? null);
          setResult(data);
        }, 1400);
      },
      onError: (err: unknown) => {
        setTimeout(() => {
          setFlipping(false);
          setLanded(null);
          setResult({ success: false, message: String(err) });
        }, 1400);
      },
    },
  });

  function handleFlip() {
    setResult(null);
    setLanded(null);
    setFlipping(true);
    setAnimKey((k) => k + 1);
    mutate();
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Coins className="w-4 h-4 text-yellow-400" />
        <h2 className="text-sm font-semibold tracking-widest uppercase text-yellow-400">
          Coin Flip
        </h2>
      </div>

      <p className="text-xs text-slate-500 leading-relaxed">
        Picks a random eligible market, flips YES or NO, enters the trade, then watches for profit.
      </p>

      {/* Coin */}
      <div className="flex justify-center py-2">
        <div
          key={animKey}
          className={`coin ${flipping ? "coin-flipping" : ""} ${
            landed === "YES" ? "coin-yes" : landed === "NO" ? "coin-no" : ""
          }`}
        >
          <div className="coin-face coin-front">
            {landed === "NO" ? (
              <span className="coin-label coin-label-no">NO</span>
            ) : (
              <span className="coin-label coin-label-yes">YES</span>
            )}
          </div>
          <div className="coin-face coin-back">
            {landed === "NO" ? (
              <span className="coin-label coin-label-no">NO</span>
            ) : (
              <span className="coin-label coin-label-yes">YES</span>
            )}
          </div>
        </div>
      </div>

      {/* Result info */}
      {result && result.success && result.ticker && (
        <div className="text-center space-y-0.5">
          <p className={`text-lg font-bold tracking-wider ${result.side === "YES" ? "text-emerald-400" : "text-orange-400"}`}>
            {result.side}
          </p>
          <p className="text-xs text-slate-400 font-mono truncate">{result.ticker}</p>
          <p className="text-xs text-slate-500">Entry: {result.priceCents}¢</p>
        </div>
      )}

      {/* Flip button */}
      <button
        onClick={handleFlip}
        disabled={flipping}
        className={`w-full py-2.5 rounded-lg text-sm font-bold tracking-wider transition-all ${
          flipping
            ? "bg-yellow-500/10 text-yellow-500/50 border border-yellow-500/20 cursor-not-allowed"
            : "bg-yellow-500/20 border border-yellow-400/30 text-yellow-300 hover:bg-yellow-500/30 hover:text-yellow-200 active:scale-95"
        }`}
      >
        {flipping ? "Flipping…" : landed ? "Flip Again" : "Flip & Trade"}
      </button>

      {/* Status message */}
      {result && (
        <div className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
          result.success
            ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
            : "bg-red-500/10 border border-red-500/20 text-red-300"
        }`}>
          {result.success
            ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
          <span className="break-all">{result.message}</span>
        </div>
      )}
    </div>
  );
}
