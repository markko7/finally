"""Tests for the portfolio service."""

import pytest

from app.market import PriceCache
from app.portfolio import TradeError, execute_trade, get_history, get_portfolio


@pytest.fixture
def cache():
    c = PriceCache()
    c.update("AAPL", 100.0)
    return c


def test_fresh_portfolio(temp_db, cache):
    p = get_portfolio(cache)
    assert p["cash_balance"] == 10000.0
    assert p["positions"] == []
    assert p["total_value"] == 10000.0


def test_buy_reduces_cash_and_creates_position(temp_db, cache):
    execute_trade(cache, "aapl", "buy", 10)
    p = get_portfolio(cache)
    assert p["cash_balance"] == 9000.0
    assert p["positions"][0]["ticker"] == "AAPL"
    assert p["positions"][0]["quantity"] == 10


def test_buy_averages_cost(temp_db, cache):
    execute_trade(cache, "AAPL", "buy", 10)
    cache.update("AAPL", 200.0)
    execute_trade(cache, "AAPL", "buy", 10)
    pos = get_portfolio(cache)["positions"][0]
    assert pos["avg_cost"] == 150.0
    assert pos["unrealized_pnl"] == 1000.0


def test_sell_at_loss(temp_db, cache):
    execute_trade(cache, "AAPL", "buy", 10)
    cache.update("AAPL", 80.0)
    execute_trade(cache, "AAPL", "sell", 4)
    p = get_portfolio(cache)
    assert p["cash_balance"] == 9320.0
    assert p["positions"][0]["quantity"] == 6
    assert p["positions"][0]["unrealized_pnl"] == -120.0


def test_sell_all_removes_position(temp_db, cache):
    execute_trade(cache, "AAPL", "buy", 2.5)
    execute_trade(cache, "AAPL", "sell", 2.5)
    assert get_portfolio(cache)["positions"] == []


def test_insufficient_cash(temp_db, cache):
    with pytest.raises(TradeError, match="Insufficient cash"):
        execute_trade(cache, "AAPL", "buy", 101)


def test_sell_more_than_owned(temp_db, cache):
    execute_trade(cache, "AAPL", "buy", 1)
    with pytest.raises(TradeError, match="Insufficient shares"):
        execute_trade(cache, "AAPL", "sell", 2)


def test_unknown_ticker(temp_db, cache):
    with pytest.raises(TradeError, match="No price"):
        execute_trade(cache, "ZZZZ", "buy", 1)


@pytest.mark.parametrize("side,qty", [("hold", 1), ("buy", 0), ("sell", -1)])
def test_invalid_inputs(temp_db, cache, side, qty):
    with pytest.raises(TradeError):
        execute_trade(cache, "AAPL", side, qty)


def test_trade_records_snapshot(temp_db, cache):
    execute_trade(cache, "AAPL", "buy", 1)
    history = get_history()
    assert len(history) == 1
    assert history[0]["total_value"] == 10000.0
