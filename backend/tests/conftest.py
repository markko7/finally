"""Pytest configuration and fixtures."""

import pytest


@pytest.fixture
def event_loop_policy():
    """Use the default event loop policy for all async tests."""
    import asyncio

    return asyncio.DefaultEventLoopPolicy()


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """Point the app at a fresh, initialized SQLite file."""
    from app.db import init_db

    monkeypatch.setenv("FINALLY_DB_PATH", str(tmp_path / "test.db"))
    init_db()
    return tmp_path / "test.db"
