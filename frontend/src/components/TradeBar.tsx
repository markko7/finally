"use client";

import { useState } from "react";

type Side = "buy" | "sell";

interface Props {
  ticker: string;
  onTickerChange: (ticker: string) => void;
  onTrade: (ticker: string, quantity: number, side: Side) => Promise<void>;
}

/** Market order entry: ticker, quantity, buy and sell. */
export default function TradeBar({ ticker, onTickerChange, onTrade }: Props) {
  const [quantity, setQuantity] = useState("1");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const trade = async (side: Side) => {
    const qty = Number(quantity);
    const symbol = ticker.trim().toUpperCase();
    if (!symbol || !(qty > 0)) {
      setStatus({ ok: false, text: "Enter a ticker and a positive quantity" });
      return;
    }
    try {
      await onTrade(symbol, qty, side);
      setStatus({ ok: true, text: `${side === "buy" ? "Bought" : "Sold"} ${qty} ${symbol}` });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
      <span className="text-xs uppercase tracking-wider text-muted">Trade</span>
      <input
        data-testid="trade-ticker"
        value={ticker}
        onChange={(e) => onTickerChange(e.target.value.toUpperCase())}
        placeholder="Ticker"
        className="w-24 rounded border border-border bg-bg px-2 py-1 uppercase outline-none focus:border-primary"
      />
      <input
        data-testid="trade-quantity"
        type="number"
        min="0"
        step="any"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="w-24 rounded border border-border bg-bg px-2 py-1 font-mono outline-none focus:border-primary"
      />
      <button
        data-testid="buy-button"
        onClick={() => trade("buy")}
        className="rounded bg-up px-4 py-1 font-semibold text-bg hover:brightness-110"
      >
        Buy
      </button>
      <button
        data-testid="sell-button"
        onClick={() => trade("sell")}
        className="rounded bg-down px-4 py-1 font-semibold text-bg hover:brightness-110"
      >
        Sell
      </button>
      {status && (
        <span data-testid="trade-status" className={`text-xs ${status.ok ? "text-up" : "text-down"}`}>
          {status.text}
        </span>
      )}
    </div>
  );
}
