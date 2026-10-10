"""SQLite connection management, lazy schema creation and seeding."""

from __future__ import annotations

import os
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

USER_ID = "default"
DEFAULT_CASH = 10000.0
DEFAULT_TICKERS = ["AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "JPM", "V", "NFLX"]
SCHEMA_PATH = Path(__file__).with_name("schema.sql")
DEFAULT_DB_PATH = Path(__file__).resolve().parents[3] / "db" / "finally.db"


def db_path() -> Path:
    """Database file location; overridable with FINALLY_DB_PATH."""
    return Path(os.environ.get("FINALLY_DB_PATH", DEFAULT_DB_PATH))


def now_iso() -> str:
    """Current UTC time as an ISO-8601 string."""
    return datetime.now(UTC).isoformat()


def new_id() -> str:
    """Random UUID string for primary keys."""
    return str(uuid.uuid4())


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    """Yield a connection with dict-like rows; commit on success, always close."""
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db() -> None:
    """Create tables if missing and seed default data on an empty database."""
    db_path().parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA_PATH.read_text())
        if conn.execute("SELECT 1 FROM users_profile WHERE id = ?", (USER_ID,)).fetchone():
            return
        conn.execute(
            "INSERT INTO users_profile (id, cash_balance, created_at) VALUES (?, ?, ?)",
            (USER_ID, DEFAULT_CASH, now_iso()),
        )
        conn.executemany(
            "INSERT INTO watchlist (id, user_id, ticker, added_at) VALUES (?, ?, ?, ?)",
            [(new_id(), USER_ID, t, now_iso()) for t in DEFAULT_TICKERS],
        )
