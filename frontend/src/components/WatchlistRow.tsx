"use client";

import { useEffect, useRef, useState } from "react";
import Sparkline from "./Sparkline";
import { formatPct, formatPrice, pnlColor } from "@/lib/format";
import type { PricePoint } from "@/hooks/usePriceStream";

interface Props {
  ticker: string;
  price?: number;
  openPrice?: number;
  points: PricePoint[];
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

/** One watchlist row; the price cell flashes green/red when the price changes. */
export default function WatchlistRow(props: Props) {
  const { ticker, price, openPrice, points, selected, onSelect, onRemove } = props;
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prev = useRef(price);

  useEffect(() => {
    const last = prev.current;
    prev.current = price;
    if (price === undefined || last === undefined || price === last) return;
    setFlash(price > last ? "up" : "down");
    const id = setTimeout(() => setFlash(null), 500);
    return () => clearTimeout(id);
  }, [price]);

  const changePct = price !== undefined && openPrice ? ((price - openPrice) / openPrice) * 100 : 0;

  return (
    <tr
      data-testid={`watchlist-row-${ticker}`}
      onClick={onSelect}
      className={`group cursor-pointer border-b border-border/50 hover:bg-panel-2 ${
        selected ? "bg-panel-2" : ""
      }`}
    >
      <td className={`py-1.5 pl-3 font-semibold ${selected ? "text-accent" : ""}`}>{ticker}</td>
      <td
        data-testid={`price-${ticker}`}
        className={`px-1 text-right font-mono ${flash ? `flash-${flash}` : "flash-fade"}`}
      >
        {price === undefined ? "--" : formatPrice(price)}
      </td>
      <td className={`px-1 text-right font-mono text-xs ${pnlColor(changePct)}`}>
        {formatPct(changePct)}
      </td>
      <td className="px-1">
        <Sparkline points={points} />
      </td>
      <td className="pr-2 text-right">
        <button
          aria-label={`Remove ${ticker}`}
          data-testid={`remove-${ticker}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="text-muted opacity-0 group-hover:opacity-100 hover:text-down"
        >
          x
        </button>
      </td>
    </tr>
  );
}
