"""Watchlist service: persisted tickers kept in sync with the market data source."""

from __future__ import annotations

import re
import sqlite3

from app.db import USER_ID, get_conn, new_id, now_iso
from app.market import MarketDataSource, PriceCache
from app.portfolio import held_tickers

TICKER_PATTERN = re.compile(r"^[A-Z][A-Z.]{0,9}$")


class WatchlistError(ValueError):
    """Raised when a watchlist change is invalid."""


def normalize_ticker(ticker: str) -> str:
    """Uppercase and validate a ticker symbol."""
    ticker = ticker.strip().upper()
    if not TICKER_PATTERN.match(ticker):
        raise WatchlistError(f"Invalid ticker '{ticker}'")
    return ticker


def get_tickers() -> list[str]:
    """Watched tickers in the order they were added."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT ticker FROM watchlist WHERE user_id = ? ORDER BY added_at, rowid", (USER_ID,)
        )
        return [r[0] for r in rows]


def get_watchlist(cache: PriceCache) -> list[dict]:
    """Watched tickers with their latest prices (None if not yet priced)."""
    items = []
    for ticker in get_tickers():
        update = cache.get(ticker)
        items.append(update.to_dict() if update else {"ticker": ticker, "price": None})
    return items


async def add_ticker(source: MarketDataSource, ticker: str) -> str:
    """Add a ticker to the watchlist and start streaming it."""
    ticker = normalize_ticker(ticker)
    try:
        with get_conn() as conn:
            conn.execute(
                "INSERT INTO watchlist (id, user_id, ticker, added_at) VALUES (?, ?, ?, ?)",
                (new_id(), USER_ID, ticker, now_iso()),
            )
    except sqlite3.IntegrityError:
        raise WatchlistError(f"{ticker} is already on the watchlist") from None
    await source.add_ticker(ticker)
    return ticker


async def remove_ticker(source: MarketDataSource, ticker: str) -> str:
    """Remove a ticker; keep streaming it if a position is still held."""
    ticker = normalize_ticker(ticker)
    with get_conn() as conn:
        deleted = conn.execute(
            "DELETE FROM watchlist WHERE user_id = ? AND ticker = ?", (USER_ID, ticker)
        ).rowcount
    if not deleted:
        raise WatchlistError(f"{ticker} is not on the watchlist")
    if ticker not in held_tickers():
        await source.remove_ticker(ticker)
    return ticker
