import { squarify } from "@/lib/treemap";
import { formatPct, formatUsd } from "@/lib/format";
import type { Position } from "@/lib/types";

const NEUTRAL = [48, 54, 61];
const GREEN = [35, 134, 54];
const RED = [218, 54, 51];
const FULL_SCALE_PCT = 5;

/** Diverging color: gray at 0% P&L, saturating to green/red at +/-5%. */
function pnlFill(pct: number): string {
  const t = Math.min(Math.abs(pct) / FULL_SCALE_PCT, 1);
  const target = pct >= 0 ? GREEN : RED;
  const c = NEUTRAL.map((n, i) => Math.round(n + (target[i] - n) * t));
  return `rgb(${c.join(",")})`;
}

/** Treemap of positions sized by market value, colored by unrealized P&L %. */
export default function Heatmap({ positions }: { positions: Position[] }) {
  if (!positions.length) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted">
        No positions yet
      </div>
    );
  }
  const byTicker = Object.fromEntries(positions.map((p) => [p.ticker, p]));
  const cells = squarify(
    positions
      .map((p) => ({ key: p.ticker, value: p.market_value }))
      .sort((a, b) => b.value - a.value),
    { x: 0, y: 0, w: 100, h: 100 },
  );
  return (
    <div className="relative h-full w-full" data-testid="heatmap">
      {cells.map((c) => {
        const p = byTicker[c.key];
        return (
          <div
            key={c.key}
            data-testid={`heatmap-cell-${c.key}`}
            title={`${p.ticker}  ${formatUsd(p.market_value)}  ${formatPct(p.pnl_percent)}`}
            className="absolute flex flex-col items-center justify-center overflow-hidden rounded-sm border-2 border-panel text-xs"
            style={{
              left: `${c.x}%`,
              top: `${c.y}%`,
              width: `${c.w}%`,
              height: `${c.h}%`,
              backgroundColor: pnlFill(p.pnl_percent),
            }}
          >
            <span className="font-semibold">{p.ticker}</span>
            <span className="font-mono text-[11px] text-text/80">{formatPct(p.pnl_percent)}</span>
          </div>
        );
      })}
    </div>
  );
}
