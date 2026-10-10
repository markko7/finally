"use client";

import { useCallback, useEffect, useState } from "react";
import ChatPanel from "@/components/ChatPanel";
import Header from "@/components/Header";
import Heatmap from "@/components/Heatmap";
import PositionsTable from "@/components/PositionsTable";
import TimeChart from "@/components/TimeChart";
import TradeBar from "@/components/TradeBar";
import Watchlist from "@/components/Watchlist";
import { usePriceStream } from "@/hooks/usePriceStream";
import { api } from "@/lib/api";
import { formatPct, formatPrice, pnlColor } from "@/lib/format";
import { revalue, snapshotPoints } from "@/lib/portfolio";
import type { Portfolio, Snapshot } from "@/lib/types";

const HISTORY_REFRESH_MS = 30_000;

function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`flex min-h-0 flex-col border border-border bg-panel ${className}`}>
      <h2 className="border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {title}
      </h2>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export default function Home() {
  const stream = usePriceStream();
  const [tickers, setTickers] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);

  const refresh = useCallback(async () => {
    const [w, p, h] = await Promise.all([api.watchlist(), api.portfolio(), api.history()]);
    setTickers(w.map((i) => i.ticker));
    setPortfolio(p);
    setSnapshots(h);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => api.history().then(setSnapshots), HISTORY_REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!selected && tickers.length) setSelected(tickers[0]);
  }, [tickers, selected]);

  const trade = async (ticker: string, quantity: number, side: "buy" | "sell") => {
    await api.trade(ticker, quantity, side);
    await refresh();
  };

  const addTicker = async (ticker: string) => {
    await api.addTicker(ticker);
    await refresh();
  };

  const removeTicker = async (ticker: string) => {
    await api.removeTicker(ticker);
    if (ticker === selected) setSelected("");
    await refresh();
  };

  const live = portfolio ? revalue(portfolio, stream.prices) : null;
  const current = stream.prices[selected];
  const open = stream.openPrices[selected];
  const changePct = current && open ? ((current.price - open) / open) * 100 : 0;
  const chartPoints = stream.history[selected] ?? [];
  const chartUp = chartPoints.length < 2 || chartPoints[chartPoints.length - 1].value >= chartPoints[0].value;

  return (
    <div className="flex h-screen flex-col">
      <Header
        totalValue={live?.totalValue ?? 0}
        cash={portfolio?.cash_balance ?? 0}
        pnl={live?.unrealizedPnl ?? 0}
        status={stream.status}
      />
      <div className="flex min-h-0 flex-1">
        <main className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-y-auto bg-border lg:grid-cols-[320px_1fr] lg:grid-rows-[minmax(280px,1.2fr)_minmax(220px,1fr)]">
          <Panel title="Watchlist" className="lg:row-span-2">
            <Watchlist
              tickers={tickers}
              stream={stream}
              selected={selected}
              onSelect={setSelected}
              onAdd={addTicker}
              onRemove={removeTicker}
            />
          </Panel>

          <section className="flex min-h-[280px] flex-col border border-border bg-panel">
            <div className="flex items-baseline gap-3 border-b border-border px-3 py-1.5">
              <span className="text-sm font-bold text-accent" data-testid="chart-ticker">
                {selected || "--"}
              </span>
              <span className="font-mono text-sm">{current ? formatPrice(current.price) : "--"}</span>
              <span className={`font-mono text-xs ${pnlColor(changePct)}`}>{formatPct(changePct)}</span>
              <span className="text-[11px] text-muted">since page load</span>
            </div>
            <TradeBar ticker={selected} onTickerChange={setSelected} onTrade={trade} />
            <div className="min-h-0 flex-1 p-1">
              <TimeChart
                data={chartPoints}
                color={chartUp ? "#3fb950" : "#f85149"}
                testId="price-chart"
              />
            </div>
          </section>

          <div className="grid min-h-[220px] grid-cols-1 gap-px md:grid-cols-[1.5fr_1fr_1fr]">
            <Panel title="Positions">
              <div className="h-full overflow-auto">
                <PositionsTable positions={live?.positions ?? []} onSelect={setSelected} />
              </div>
            </Panel>
            <Panel title="Portfolio Heatmap">
              <div className="h-full p-1">
                <Heatmap positions={live?.positions ?? []} />
              </div>
            </Panel>
            <Panel title="Portfolio Value">
              <div className="h-full p-1">
                <TimeChart data={snapshotPoints(snapshots)} color="#209dd7" testId="pnl-chart" />
              </div>
            </Panel>
          </div>
        </main>
        <ChatPanel onActions={refresh} />
      </div>
    </div>
  );
}
