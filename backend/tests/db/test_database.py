"""Tests for database initialization and seeding."""

from app.db import get_conn, init_db


def test_seeds_default_user_and_watchlist(temp_db):
    with get_conn() as conn:
        cash = conn.execute("SELECT cash_balance FROM users_profile").fetchone()[0]
        tickers = [r[0] for r in conn.execute("SELECT ticker FROM watchlist")]
    assert cash == 10000.0
    assert len(tickers) == 10
    assert "AAPL" in tickers


def test_init_is_idempotent(temp_db):
    init_db()
    init_db()
    with get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM users_profile").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0] == 10


def test_creates_all_tables(temp_db):
    with get_conn() as conn:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert names == {
        "users_profile", "watchlist", "positions", "trades", "portfolio_snapshots", "chat_messages"
    }
