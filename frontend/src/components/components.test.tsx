import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "./ChatPanel";
import Heatmap from "./Heatmap";
import PositionsTable from "./PositionsTable";
import Watchlist from "./Watchlist";
import WatchlistRow from "./WatchlistRow";
import { api } from "@/lib/api";
import type { PriceStream } from "@/hooks/usePriceStream";
import type { Position } from "@/lib/types";

const position = (ticker: string, pnl_percent: number): Position => ({
  ticker,
  quantity: 10,
  avg_cost: 100,
  current_price: 100 + pnl_percent,
  market_value: 1000 + pnl_percent * 10,
  unrealized_pnl: pnl_percent * 10,
  pnl_percent,
});

function renderRow(price: number) {
  return (
    <table>
      <tbody>
        <WatchlistRow
          ticker="AAPL"
          price={price}
          openPrice={100}
          points={[]}
          selected={false}
          onSelect={() => {}}
          onRemove={() => {}}
        />
      </tbody>
    </table>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WatchlistRow", () => {
  it("flashes green on uptick, red on downtick, then fades", () => {
    vi.useFakeTimers();
    const { rerender } = render(renderRow(100));
    const cell = screen.getByTestId("price-AAPL");
    expect(cell).toHaveClass("flash-fade");

    rerender(renderRow(101));
    expect(cell).toHaveClass("flash-up");
    act(() => vi.advanceTimersByTime(600));
    expect(cell).toHaveClass("flash-fade");

    rerender(renderRow(99));
    expect(cell).toHaveClass("flash-down");
  });

  it("shows change since page load", () => {
    render(renderRow(105));
    expect(screen.getByText("+5.00%")).toBeInTheDocument();
  });
});

describe("Watchlist", () => {
  const stream: PriceStream = { prices: {}, history: {}, openPrices: {}, status: "connected" };

  it("adds a ticker and removes another", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onRemove = vi.fn();
    render(
      <Watchlist tickers={["AAPL"]} stream={stream} selected="AAPL" onSelect={() => {}} onAdd={onAdd} onRemove={onRemove} />,
    );
    fireEvent.change(screen.getByTestId("watchlist-input"), { target: { value: "pypl" } });
    fireEvent.click(screen.getByTestId("watchlist-add"));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("PYPL"));
    fireEvent.click(screen.getByTestId("remove-AAPL"));
    expect(onRemove).toHaveBeenCalled();
  });

  it("shows add errors", async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error("AAPL is already on the watchlist"));
    render(
      <Watchlist tickers={[]} stream={stream} selected="" onSelect={() => {}} onAdd={onAdd} onRemove={() => {}} />,
    );
    fireEvent.change(screen.getByTestId("watchlist-input"), { target: { value: "AAPL" } });
    fireEvent.click(screen.getByTestId("watchlist-add"));
    expect(await screen.findByText("AAPL is already on the watchlist")).toBeInTheDocument();
  });
});

describe("PositionsTable", () => {
  it("renders positions with P&L", () => {
    render(<PositionsTable positions={[position("AAPL", 5)]} onSelect={() => {}} />);
    expect(screen.getByTestId("position-qty-AAPL")).toHaveTextContent("10");
    expect(screen.getByText("+$50.00")).toHaveClass("text-up");
  });

  it("shows an empty state", () => {
    render(<PositionsTable positions={[]} onSelect={() => {}} />);
    expect(screen.getByText(/No open positions/)).toBeInTheDocument();
  });
});

describe("Heatmap", () => {
  it("renders a cell per position colored by P&L", () => {
    render(<Heatmap positions={[position("WIN", 5), position("LOSE", -5)]} />);
    expect(screen.getByTestId("heatmap-cell-WIN").style.backgroundColor).toBe("rgb(35, 134, 54)");
    expect(screen.getByTestId("heatmap-cell-LOSE").style.backgroundColor).toBe("rgb(218, 54, 51)");
  });
});

describe("ChatPanel", () => {
  it("shows loading, then the reply with inline actions", async () => {
    vi.spyOn(api, "chatHistory").mockResolvedValue([]);
    let resolve!: (v: Awaited<ReturnType<typeof api.chat>>) => void;
    vi.spyOn(api, "chat").mockReturnValue(new Promise((r) => (resolve = r)));
    const onActions = vi.fn();
    render(<ChatPanel onActions={onActions} />);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "buy 5 AAPL" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    expect(await screen.findByTestId("chat-loading")).toBeInTheDocument();

    await act(async () =>
      resolve({
        message: "Done.",
        trades: [{ ticker: "AAPL", side: "buy", quantity: 5, price: 190, status: "ok" }],
        watchlist_changes: [],
      }),
    );
    expect(screen.queryByTestId("chat-loading")).not.toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.getByTestId("chat-action")).toHaveTextContent("Bought 5 AAPL @ $190.00");
    expect(onActions).toHaveBeenCalled();
  });
});
