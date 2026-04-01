import { useState, useEffect, useRef } from "react";
import { useCoinFlipTrade, useGetCoinFlipAuto, useSetCoinFlipAuto, getGetCoinFlipAutoQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, AlertCircle, Coins, RefreshCw } from "lucide-react";

type FlipResult = {
  success: boolean;
  message: string;
  ticker?: string;
  title?: string;
  side?: "YES" | "NO";
  priceCents?: number;
};

export function CoinFlip() {
  const queryClient = useQueryClient();
  const [flipping, setFlipping] = useState(false);
  const [landed, setLanded]     = useState<"YES" | "NO" | null>(null);
  const [result, setResult]     = useState<FlipResult | null>(null);
  const [animKey, setAnimKey]   = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: autoState } = useGetCoinFlipAuto({
    query: { refetchInterval: 3000 },
  });

  const setAuto = useSetCoinFlipAuto({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetCoinFlipAutoQueryKey() }),
    },
  });

  const autoEnabled = autoState?.enabled ?? false;
  const lastResult = autoState?.lastResult ?? null;

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!autoEnabled || !autoState?.nextFlipAt) { setCountdown(null); return; }
    function tick() {
      const secs = Math.max(0, Math.round((autoState!.nextFlipAt! - Date.now()) / 1000));
      setCountdown(secs);
    }
    tick();
    timerRef.current = setInterval(tick, 500);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoEnabled, autoState?.nextFlipAt]);

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

  function toggleAuto() {
    setAuto.mutate({ data: { enabled: !autoEnabled, intervalSecs: 900 } });
  }

  function fmtCountdown(secs: number) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
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
        Picks a random open 15-min market, flips YES or NO (any price under 90¢), and cashes out at profit.
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
            <span className={`coin-label ${landed === "NO" ? "coin-label-no" : "coin-label-yes"}`}>
              {landed === "NO" ? "NO" : "YES"}
            </span>
          </div>
          <div className="coin-face coin-back">
            <span className={`coin-label ${landed === "NO" ? "coin-label-no" : "coin-label-yes"}`}>
              {landed === "NO" ? "NO" : "YES"}
            </span>
          </div>
        </div>
      </div>

      {/* Last result info */}
      {result?.success && result.ticker && (
        <div className="text-center space-y-0.5">
          <p className={`text-lg font-bold tracking-wider ${result.side === "YES" ? "text-emerald-400" : "text-orange-400"}`}>
            {result.side}
          </p>
          <p className="text-xs text-slate-400 font-mono truncate">{result.ticker}</p>
          <p className="text-xs text-slate-500">Entry: {result.priceCents}¢</p>
        </div>
      )}

      {/* Manual flip button */}
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

      {/* Auto mode toggle */}
      <div className="border-t border-white/5 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-300">Auto Flip</p>
            <p className="text-[10px] text-slate-600 mt-0.5">
              {autoEnabled && countdown !== null
                ? `Next flip in ${fmtCountdown(countdown)}`
                : "1 flip per 15-min market cycle"}
            </p>
          </div>
          <button
            onClick={toggleAuto}
            disabled={setAuto.isPending}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
              autoEnabled ? "bg-yellow-500/70" : "bg-white/10"
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              autoEnabled ? "translate-x-6" : "translate-x-1"
            }`} />
          </button>
        </div>
        {autoEnabled && (
          <div className="flex items-center gap-1.5 mt-2 text-[10px] text-yellow-400/70">
            <RefreshCw className="w-3 h-3 animate-spin" style={{ animationDuration: "3s" }} />
            <span>Auto flip active — fires each 15-min cycle</span>
          </div>
        )}
        {autoEnabled && lastResult && (
          <div className={`mt-2 flex items-start gap-1.5 p-2 rounded-lg text-[10px] ${
            lastResult.success
              ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
              : "bg-white/[0.03] border border-white/5 text-slate-400"
          }`}>
            {lastResult.success
              ? <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" />
              : <AlertCircle className="w-3 h-3 mt-0.5 shrink-0 text-slate-500" />}
            <span className="break-all">{lastResult.message}</span>
          </div>
        )}
      </div>

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
