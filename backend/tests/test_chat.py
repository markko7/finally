"""Tests for the chat service (mock LLM mode and action execution)."""

import pytest

from app import chat
from app.chat import LLMResponse, get_chat_history, handle_chat, mock_response
from app.market import PriceCache
from app.market.simulator import SimulatorDataSource
from app.portfolio import get_portfolio
from app.watchlist import get_tickers


@pytest.fixture
async def source(monkeypatch):
    monkeypatch.setenv("LLM_MOCK", "true")
    src = SimulatorDataSource(price_cache=PriceCache())
    await src.start(["AAPL"])
    yield src
    await src.stop()


def test_mock_parses_commands():
    reply = mock_response("Please buy 5 shares of aapl, sell 2 MSFT and add PYPL")
    assert [(t.ticker, t.side, t.quantity) for t in reply.trades] == [
        ("AAPL", "buy", 5.0),
        ("MSFT", "sell", 2.0),
    ]
    assert [(c.ticker, c.action) for c in reply.watchlist_changes] == [("PYPL", "add")]


def test_llm_response_schema_rejects_bad_side():
    with pytest.raises(ValueError):
        LLMResponse.model_validate_json(
            '{"message": "x", "trades": [{"ticker": "A", "side": "hold", "quantity": 1}],'
            ' "watchlist_changes": []}'
        )


async def test_chat_executes_trade(temp_db, source):
    result = await handle_chat(source._cache, source, "buy 3 AAPL")
    assert result["trades"][0]["status"] == "ok"
    assert get_portfolio(source._cache)["positions"][0]["quantity"] == 3


async def test_chat_reports_failed_trade(temp_db, source):
    result = await handle_chat(source._cache, source, "sell 3 AAPL")
    assert result["trades"][0]["status"] == "error"
    assert "Insufficient shares" in result["trades"][0]["error"]


async def test_chat_adds_watchlist_then_trades(temp_db, source):
    result = await handle_chat(source._cache, source, "add PYPL and buy 1 PYPL")
    assert result["watchlist_changes"][0]["status"] == "ok"
    assert result["trades"][0]["status"] == "ok"
    assert "PYPL" in get_tickers()


async def test_chat_persists_history(temp_db, source):
    await handle_chat(source._cache, source, "hello")
    history = get_chat_history()
    assert [m["role"] for m in history] == ["user", "assistant"]
    assert history[1]["actions"] == {"trades": [], "watchlist_changes": []}


async def test_llm_failure_returns_apology(temp_db, source, monkeypatch):
    monkeypatch.setenv("LLM_MOCK", "false")

    async def boom(messages):
        raise RuntimeError("network down")

    monkeypatch.setattr(chat, "call_llm", boom)
    result = await handle_chat(source._cache, source, "hi")
    assert "couldn't reach" in result["message"]


async def test_prompt_includes_context_and_history(temp_db, source):
    await handle_chat(source._cache, source, "hello")
    messages = chat.build_messages(source._cache, chat.load_history(), "next")
    assert "cash_balance" in messages[1]["content"]
    assert [m["role"] for m in messages[2:]] == ["user", "assistant", "user"]
