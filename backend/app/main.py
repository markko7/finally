"""FastAPI application: wires market data, database, API routes and static frontend."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import portfolio, watchlist
from app.api import router as api_router
from app.db import init_db
from app.market import PriceCache, create_market_data_source, create_stream_router

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
logging.basicConfig(level=logging.INFO)

SNAPSHOT_INTERVAL = 30
STATIC_DIR = Path(os.environ.get("FINALLY_STATIC_DIR", Path(__file__).resolve().parents[1] / "static"))


async def snapshot_loop(cache: PriceCache) -> None:
    """Record the portfolio value every SNAPSHOT_INTERVAL seconds."""
    while True:
        await asyncio.sleep(SNAPSHOT_INTERVAL)
        portfolio.record_snapshot(cache)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    cache = app.state.cache
    source = create_market_data_source(cache)
    tickers = list(dict.fromkeys(watchlist.get_tickers() + portfolio.held_tickers()))
    await source.start(tickers)
    portfolio.record_snapshot(cache)
    task = asyncio.create_task(snapshot_loop(cache))
    app.state.source = source
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    await source.stop()


def create_app() -> FastAPI:
    """Build the app; static files are mounted last so /api routes take priority."""
    app = FastAPI(title="FinAlly", lifespan=lifespan)
    app.state.cache = PriceCache()
    app.include_router(api_router)
    app.include_router(create_stream_router(app.state.cache))
    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


app = create_app()
