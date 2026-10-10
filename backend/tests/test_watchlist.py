"""Tests for the watchlist service."""

import pytest

from app.market import PriceCache
from app.market.simulator import SimulatorDataSource
from app.portfolio import execute_trade
from app.watchlist import WatchlistError, add_ticker, get_tickers, get_watchlist, remove_ticker


@pytest.fixture
async def source():
    cache = PriceCache()
    src = SimulatorDataSource(price_cache=cache)
    await src.start(get_tickers())
    yield src
    await src.stop()


async def test_add_ticker_starts_streaming(temp_db, source):
    assert await add_ticker(source, " pypl ") == "PYPL"
    assert get_tickers()[-1] == "PYPL"
    assert "PYPL" in source.get_tickers()


async def test_add_duplicate_fails(temp_db, source):
    with pytest.raises(WatchlistError, match="already"):
        await add_ticker(source, "AAPL")


async def test_add_invalid_fails(temp_db, source):
    with pytest.raises(WatchlistError, match="Invalid"):
        await add_ticker(source, "12$")


async def test_remove_ticker_stops_streaming(temp_db, source):
    await remove_ticker(source, "nflx")
    assert "NFLX" not in get_tickers()
    assert "NFLX" not in source.get_tickers()


async def test_remove_keeps_streaming_held_position(temp_db, source):
    execute_trade(source._cache, "AAPL", "buy", 1)
    await remove_ticker(source, "AAPL")
    assert "AAPL" not in get_tickers()
    assert "AAPL" in source.get_tickers()


async def test_remove_missing_fails(temp_db, source):
    with pytest.raises(WatchlistError, match="not on"):
        await remove_ticker(source, "ZZZ")


async def test_get_watchlist_includes_prices(temp_db, source):
    items = get_watchlist(source._cache)
    assert len(items) == 10
    assert items[0]["ticker"] == "AAPL"
    assert items[0]["price"] > 0
