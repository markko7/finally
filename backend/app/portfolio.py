"""Portfolio service: valuation, trade execution and value snapshots."""

from __future__ import annotations

from app.db import USER_ID, get_conn, new_id, now_iso
from app.market import PriceCache

EPSILON = 1e-9


class TradeError(ValueError):
    """Raised when a trade fails validation."""


def get_portfolio(cache: PriceCache) -> dict:
    """Cash, positions valued at live prices, total value and unrealized P&L."""
    with get_conn() as conn:
        cash = _cash(conn)
        rows = conn.execute(
            "SELECT ticker, quantity, avg_cost FROM positions WHERE user_id = ? ORDER BY ticker",
            (USER_ID,),
        ).fetchall()
    positions = [_value_position(cache, r["ticker"], r["quantity"], r["avg_cost"]) for r in rows]
    market_value = sum(p["market_value"] for p in positions)
    return {
        "cash_balance": round(cash, 2),
        "positions": positions,
        "total_value": round(cash + market_value, 2),
        "unrealized_pnl": round(sum(p["unrealized_pnl"] for p in positions), 2),
    }


def _value_position(cache: PriceCache, ticker: str, quantity: float, avg_cost: float) -> dict:
    """Value one position at the latest cached price (avg cost if no price yet)."""
    price = cache.get_price(ticker) or avg_cost
    cost_basis = quantity * avg_cost
    pnl = quantity * price - cost_basis
    return {
        "ticker": ticker,
        "quantity": quantity,
        "avg_cost": round(avg_cost, 4),
        "current_price": price,
        "market_value": round(quantity * price, 2),
        "unrealized_pnl": round(pnl, 2),
        "pnl_percent": round(pnl / cost_basis * 100, 2) if cost_basis else 0.0,
    }


def _cash(conn) -> float:
    return conn.execute(
        "SELECT cash_balance FROM users_profile WHERE id = ?", (USER_ID,)
    ).fetchone()[0]


def execute_trade(cache: PriceCache, ticker: str, side: str, quantity: float) -> dict:
    """Fill a market order at the current cached price. Raises TradeError if invalid."""
    ticker = ticker.strip().upper()
    if side not in ("buy", "sell"):
        raise TradeError(f"Invalid side '{side}'")
    if quantity <= 0:
        raise TradeError("Quantity must be positive")
    price = cache.get_price(ticker)
    if price is None:
        raise TradeError(f"No price available for {ticker}; add it to the watchlist first")

    with get_conn() as conn:
        cash = _cash(conn)
        row = conn.execute(
            "SELECT quantity, avg_cost FROM positions WHERE user_id = ? AND ticker = ?",
            (USER_ID, ticker),
        ).fetchone()
        held, avg_cost = (row["quantity"], row["avg_cost"]) if row else (0.0, 0.0)
        cost = quantity * price

        if side == "buy":
            if cost > cash + EPSILON:
                raise TradeError(
                    f"Insufficient cash: need ${cost:,.2f}, have ${cash:,.2f}"
                )
            new_qty = held + quantity
            new_avg = (held * avg_cost + cost) / new_qty
            new_cash = cash - cost
        else:
            if quantity > held + EPSILON:
                raise TradeError(f"Insufficient shares: have {held:g} {ticker}, tried to sell {quantity:g}")
            new_qty = held - quantity
            new_avg = avg_cost
            new_cash = cash + cost

        conn.execute("UPDATE users_profile SET cash_balance = ? WHERE id = ?", (new_cash, USER_ID))
        _save_position(conn, ticker, new_qty, new_avg)
        executed_at = now_iso()
        conn.execute(
            "INSERT INTO trades (id, user_id, ticker, side, quantity, price, executed_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (new_id(), USER_ID, ticker, side, quantity, price, executed_at),
        )

    record_snapshot(cache)
    return {
        "ticker": ticker,
        "side": side,
        "quantity": quantity,
        "price": price,
        "executed_at": executed_at,
    }


def _save_position(conn, ticker: str, quantity: float, avg_cost: float) -> None:
    """Upsert a position, deleting it when the quantity reaches zero."""
    if quantity <= EPSILON:
        conn.execute("DELETE FROM positions WHERE user_id = ? AND ticker = ?", (USER_ID, ticker))
        return
    conn.execute(
        "INSERT INTO positions (id, user_id, ticker, quantity, avg_cost, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?)"
        " ON CONFLICT (user_id, ticker) DO UPDATE SET"
        " quantity = excluded.quantity, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at",
        (new_id(), USER_ID, ticker, quantity, avg_cost, now_iso()),
    )


def held_tickers() -> list[str]:
    """Tickers with an open position."""
    with get_conn() as conn:
        rows = conn.execute("SELECT ticker FROM positions WHERE user_id = ?", (USER_ID,))
        return [r[0] for r in rows]


def record_snapshot(cache: PriceCache) -> float:
    """Store the current total portfolio value and return it."""
    total = get_portfolio(cache)["total_value"]
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO portfolio_snapshots (id, user_id, total_value, recorded_at)"
            " VALUES (?, ?, ?, ?)",
            (new_id(), USER_ID, total, now_iso()),
        )
    return total


def get_history() -> list[dict]:
    """All portfolio value snapshots, oldest first."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT total_value, recorded_at FROM portfolio_snapshots"
            " WHERE user_id = ? ORDER BY recorded_at",
            (USER_ID,),
        ).fetchall()
    return [dict(r) for r in rows]
