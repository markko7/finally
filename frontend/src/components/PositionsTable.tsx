import { formatPct, formatPrice, formatSigned, pnlColor } from "@/lib/format";
import type { Position } from "@/lib/types";

interface Props {
  positions: Position[];
  onSelect: (ticker: string) => void;
}

/** Tabular view of positions valued at live prices. */
export default function PositionsTable({ positions, onSelect }: Props) {
  if (!positions.length) {
    return <div className="p-3 text-xs text-muted">No open positions yet.</div>;
  }
  return (
    <table className="w-full whitespace-nowrap text-sm [&_td]:px-2 [&_th]:px-2" data-testid="positions-table">
      <thead className="sticky top-0 bg-panel text-xs text-muted">
        <tr className="border-b border-border">
          <th className="py-1 pl-3 text-left font-normal">Ticker</th>
          <th className="text-right font-normal">Qty</th>
          <th className="text-right font-normal">Avg Cost</th>
          <th className="text-right font-normal">Price</th>
          <th className="text-right font-normal">P&amp;L</th>
          <th className="pr-3 text-right font-normal">%</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {positions.map((p) => (
          <tr
            key={p.ticker}
            data-testid={`position-${p.ticker}`}
            onClick={() => onSelect(p.ticker)}
            className="cursor-pointer border-b border-border/50 hover:bg-panel-2"
          >
            <td className="py-1 pl-3 font-sans font-semibold">{p.ticker}</td>
            <td className="text-right" data-testid={`position-qty-${p.ticker}`}>
              {p.quantity}
            </td>
            <td className="text-right">{formatPrice(p.avg_cost)}</td>
            <td className="text-right">{formatPrice(p.current_price)}</td>
            <td className={`text-right ${pnlColor(p.unrealized_pnl)}`}>
              {formatSigned(p.unrealized_pnl)}
            </td>
            <td className={`pr-3 text-right ${pnlColor(p.pnl_percent)}`}>
              {formatPct(p.pnl_percent)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
