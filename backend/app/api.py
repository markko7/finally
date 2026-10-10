"""REST API routes for portfolio, watchlist, chat and health."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app import chat, portfolio, watchlist

router = APIRouter(prefix="/api")


class TradeRequest(BaseModel):
    ticker: str
    quantity: float = Field(gt=0)
    side: Literal["buy", "sell"]


class TickerRequest(BaseModel):
    ticker: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/portfolio")
def get_portfolio(request: Request) -> dict:
    return portfolio.get_portfolio(request.app.state.cache)


@router.post("/portfolio/trade")
def trade(body: TradeRequest, request: Request) -> dict:
    try:
        return portfolio.execute_trade(request.app.state.cache, body.ticker, body.side, body.quantity)
    except portfolio.TradeError as e:
        raise HTTPException(400, str(e)) from None


@router.get("/portfolio/history")
def history() -> list[dict]:
    return portfolio.get_history()


@router.get("/watchlist")
def get_watchlist(request: Request) -> list[dict]:
    return watchlist.get_watchlist(request.app.state.cache)


@router.post("/watchlist", status_code=201)
async def add_to_watchlist(body: TickerRequest, request: Request) -> dict:
    try:
        ticker = await watchlist.add_ticker(request.app.state.source, body.ticker)
    except watchlist.WatchlistError as e:
        raise HTTPException(400, str(e)) from None
    return {"ticker": ticker}


@router.delete("/watchlist/{ticker}")
async def remove_from_watchlist(ticker: str, request: Request) -> dict:
    try:
        ticker = await watchlist.remove_ticker(request.app.state.source, ticker)
    except watchlist.WatchlistError as e:
        raise HTTPException(404, str(e)) from None
    return {"ticker": ticker}


@router.post("/chat")
async def send_chat(body: ChatRequest, request: Request) -> dict:
    return await chat.handle_chat(request.app.state.cache, request.app.state.source, body.message)


@router.get("/chat")
def chat_history() -> list[dict]:
    return chat.get_chat_history()
