"""AI chat: prompt construction, LLM call (or mock), and auto-execution of actions."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Literal

from litellm import acompletion
from pydantic import BaseModel

from app.db import USER_ID, get_conn, new_id, now_iso
from app.market import MarketDataSource, PriceCache
from app.portfolio import TradeError, execute_trade, get_portfolio
from app.watchlist import WatchlistError, add_ticker, get_watchlist, remove_ticker

logger = logging.getLogger(__name__)

MODEL = "openrouter/openai/gpt-oss-120b"
# No fallbacks: other providers produce unreliable structured output for this model.
EXTRA_BODY = {"provider": {"order": ["cerebras"], "allow_fallbacks": False}}
MAX_TOKENS = 4000
HISTORY_LIMIT = 20

SYSTEM_PROMPT = """You are FinAlly, an AI trading assistant inside a simulated trading workstation.
You help the user by:
- Analyzing portfolio composition, risk concentration and P&L
- Suggesting trades with clear reasoning
- Executing trades when the user asks or agrees (market orders, instant fill at the current price)
- Managing the watchlist proactively (add or remove tickers)
Be concise and data-driven. Use numbers from the portfolio context.
Only include trades the user asked for or agreed to. To trade a ticker that is not on the
watchlist or held, also add it to the watchlist in the same response.
Always respond with valid JSON matching the schema: a message, a list of trades and a list
of watchlist_changes (use empty lists when there are none)."""


class TradeAction(BaseModel):
    ticker: str
    side: Literal["buy", "sell"]
    quantity: float


class WatchlistChange(BaseModel):
    ticker: str
    action: Literal["add", "remove"]


class LLMResponse(BaseModel):
    message: str
    trades: list[TradeAction]
    watchlist_changes: list[WatchlistChange]


def is_mock() -> bool:
    return os.environ.get("LLM_MOCK", "").strip().lower() == "true"


def portfolio_context(cache: PriceCache) -> str:
    """Current portfolio and watchlist as JSON text for the prompt."""
    return json.dumps(
        {"portfolio": get_portfolio(cache), "watchlist": get_watchlist(cache)}, default=str
    )


def load_history() -> list[dict]:
    """Recent chat messages, oldest first, in LLM message format."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT role, content FROM chat_messages WHERE user_id = ?"
            " ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (USER_ID, HISTORY_LIMIT),
        ).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def build_messages(cache: PriceCache, history: list[dict], user_message: str) -> list[dict]:
    """System prompt, portfolio context, history and the new user message."""
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": f"Current portfolio context: {portfolio_context(cache)}"},
        *history,
        {"role": "user", "content": user_message},
    ]


async def call_llm(messages: list[dict]) -> LLMResponse:
    """Call the model via LiteLLM/OpenRouter (Cerebras) with structured output."""
    response = await acompletion(
        model=MODEL,
        messages=messages,
        response_format=LLMResponse,
        reasoning_effort="low",
        extra_body=EXTRA_BODY,
        max_tokens=MAX_TOKENS,
    )
    return LLMResponse.model_validate_json(response.choices[0].message.content)


MOCK_TRADE = re.compile(r"\b(buy|sell)\s+(\d+(?:\.\d+)?)\s+(?:shares?\s+of\s+)?([A-Za-z.]+)", re.I)
MOCK_WATCH = re.compile(r"\b(add|remove)\s+([A-Za-z.]+)", re.I)


def mock_response(user_message: str) -> LLMResponse:
    """Deterministic response for tests: parses 'buy 5 AAPL' / 'add PYPL' commands."""
    trades = [
        TradeAction(ticker=t.upper(), side=s.lower(), quantity=float(q))
        for s, q, t in MOCK_TRADE.findall(user_message)
    ]
    changes = [
        WatchlistChange(ticker=t.upper(), action=a.lower())
        for a, t in MOCK_WATCH.findall(user_message)
    ]
    return LLMResponse(
        message="Mock response: request processed.", trades=trades, watchlist_changes=changes
    )


async def apply_actions(
    cache: PriceCache, source: MarketDataSource, reply: LLMResponse
) -> dict:
    """Execute watchlist changes then trades, recording success or error for each."""
    changes = []
    for c in reply.watchlist_changes:
        result = {"ticker": c.ticker.upper(), "action": c.action}
        try:
            if c.action == "add":
                await add_ticker(source, c.ticker)
            else:
                await remove_ticker(source, c.ticker)
            result["status"] = "ok"
        except WatchlistError as e:
            result |= {"status": "error", "error": str(e)}
        changes.append(result)

    trades = []
    for t in reply.trades:
        try:
            trades.append({**execute_trade(cache, t.ticker, t.side, t.quantity), "status": "ok"})
        except TradeError as e:
            trades.append({**t.model_dump(), "status": "error", "error": str(e)})
    return {"trades": trades, "watchlist_changes": changes}


def save_message(role: str, content: str, actions: dict | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO chat_messages (id, user_id, role, content, actions, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (new_id(), USER_ID, role, content, json.dumps(actions) if actions else None, now_iso()),
        )


async def handle_chat(cache: PriceCache, source: MarketDataSource, user_message: str) -> dict:
    """Run one chat turn end to end and return the message plus executed actions."""
    messages = build_messages(cache, load_history(), user_message)
    save_message("user", user_message)
    try:
        reply = mock_response(user_message) if is_mock() else await call_llm(messages)
    except Exception:
        logger.exception("LLM call failed")
        reply = LLMResponse(
            message="Sorry, I couldn't reach the AI service. Please try again.",
            trades=[],
            watchlist_changes=[],
        )
    actions = await apply_actions(cache, source, reply)
    save_message("assistant", reply.message, actions)
    return {"message": reply.message, **actions}


def get_chat_history() -> list[dict]:
    """Full conversation for display, oldest first."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT role, content, actions, created_at FROM chat_messages"
            " WHERE user_id = ? ORDER BY created_at, rowid",
            (USER_ID,),
        ).fetchall()
    return [
        {**dict(r), "actions": json.loads(r["actions"]) if r["actions"] else None} for r in rows
    ]
