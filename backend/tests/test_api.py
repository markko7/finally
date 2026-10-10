"""API route tests using the full app with a temp database and the simulator."""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(temp_db, monkeypatch):
    monkeypatch.setenv("LLM_MOCK", "true")
    monkeypatch.setenv("MASSIVE_API_KEY", "")
    with TestClient(create_app()) as c:
        yield c


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_portfolio_shape(client):
    body = client.get("/api/portfolio").json()
    assert body["cash_balance"] == 10000.0
    assert set(body) == {"cash_balance", "positions", "total_value", "unrealized_pnl"}


def test_trade_and_portfolio(client):
    r = client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 2, "side": "buy"})
    assert r.status_code == 200
    assert r.json()["ticker"] == "AAPL"
    positions = client.get("/api/portfolio").json()["positions"]
    assert positions[0]["quantity"] == 2


def test_trade_validation_errors(client):
    r = client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 5, "side": "sell"})
    assert r.status_code == 400
    assert "Insufficient shares" in r.json()["detail"]
    r = client.post("/api/portfolio/trade", json={"ticker": "AAPL", "quantity": 0, "side": "buy"})
    assert r.status_code == 422


def test_history_has_startup_snapshot(client):
    history = client.get("/api/portfolio/history").json()
    assert len(history) >= 1
    assert history[0]["total_value"] == 10000.0


def test_watchlist_crud(client):
    assert len(client.get("/api/watchlist").json()) == 10
    assert client.post("/api/watchlist", json={"ticker": "pypl"}).status_code == 201
    assert client.post("/api/watchlist", json={"ticker": "PYPL"}).status_code == 400
    items = client.get("/api/watchlist").json()
    assert items[-1]["ticker"] == "PYPL"
    assert items[-1]["price"] > 0
    assert client.delete("/api/watchlist/PYPL").status_code == 200
    assert client.delete("/api/watchlist/PYPL").status_code == 404


def test_chat_roundtrip(client):
    body = client.post("/api/chat", json={"message": "buy 1 AAPL"}).json()
    assert body["message"]
    assert body["trades"][0]["status"] == "ok"
    history = client.get("/api/chat").json()
    assert len(history) == 2


def test_chat_rejects_empty(client):
    assert client.post("/api/chat", json={"message": ""}).status_code == 422
