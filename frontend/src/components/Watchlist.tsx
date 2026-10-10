"use client";

import { useState } from "react";
import WatchlistRow from "./WatchlistRow";
import type { PriceStream } from "@/hooks/usePriceStream";

interface Props {
  tickers: string[];
  stream: PriceStream;
  selected: string;
  onSelect: (ticker: string) => void;
  onAdd: (ticker: string) => Promise<void>;
  onRemove: (ticker: string) => void;
}

/** Watchlist table with live prices, change since load, sparklines and add/remove. */
export default function Watchlist({ tickers, stream, selected, onSelect, onAdd, onRemove }: Props) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    try {
      await onAdd(input.trim().toUpperCase());
      setInput("");
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <form onSubmit={submit} className="flex gap-1 border-b border-border p-2">
        <input
          data-testid="watchlist-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Add ticker"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm uppercase outline-none focus:border-primary"
        />
        <button
          data-testid="watchlist-add"
          className="rounded bg-primary px-3 text-sm font-semibold text-bg hover:brightness-110"
        >
          Add
        </button>
      </form>
      {error && <div className="px-3 py-1 text-xs text-down">{error}</div>}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm" data-testid="watchlist">
          <tbody>
            {tickers.map((t) => (
              <WatchlistRow
                key={t}
                ticker={t}
                price={stream.prices[t]?.price}
                openPrice={stream.openPrices[t]}
                points={stream.history[t] ?? []}
                selected={t === selected}
                onSelect={() => onSelect(t)}
                onRemove={() => onRemove(t)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
