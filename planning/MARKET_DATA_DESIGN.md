# Market Data Backend — Detailed Design

Implementation-ready, as-built design for the FinAlly market data subsystem: the unified
`MarketDataSource` interface, the thread-safe `PriceCache`, the GBM simulator, the Massive
(Polygon.io) REST client, the SSE streaming endpoint, and how the not-yet-built
`backend/app/main.py` should wire all of it into the FastAPI app lifecycle.

**Status:** everything in §§1–9 below is already implemented in `backend/app/market/` (8
modules, ~500 lines, 73 passing tests, 84% coverage — see `planning/MARKET_DATA_SUMMARY.md`).
Code blocks in those sections are copied verbatim from the real source, not a proposal.
§§10–13 (lifecycle wiring, watchlist coordination, testing patterns, error handling) describe
how the rest of the backend — `main.py`, portfolio routes, watchlist routes, chat routes,
none of which exist yet — should consume this subsystem. Where the plan and the build
disagree, this document follows the build and notes the correction; see
`planning/PLAN.md` §13 and `planning/REVIEW.md`/`planning/archive/MARKET_DATA_REVIEW.md` for
the discrepancies that were found and resolved this way.

Everything under §§1–9 lives in `backend/app/market/`.

---

## Table of Contents

1. [Architecture at a Glance](#1-architecture-at-a-glance)
2. [Data Model — `models.py`](#2-data-model--modelspy)
3. [Price Cache — `cache.py`](#3-price-cache--cachepy)
4. [Abstract Interface — `interface.py`](#4-abstract-interface--interfacepy)
5. [Seed Prices & Ticker Parameters — `seed_prices.py`](#5-seed-prices--ticker-parameters--seed_pricespy)
6. [GBM Simulator — `simulator.py`](#6-gbm-simulator--simulatorpy)
7. [Massive API Client — `massive_client.py`](#7-massive-api-client--massive_clientpy)
8. [Factory — `factory.py`](#8-factory--factorypy)
9. [SSE Streaming Endpoint — `stream.py`](#9-sse-streaming-endpoint--streampy)
10. [FastAPI Lifecycle Integration (`main.py`, not yet built)](#10-fastapi-lifecycle-integration)
11. [Watchlist Coordination](#11-watchlist-coordination)
12. [Testing Strategy](#12-testing-strategy)
13. [Error Handling & Edge Cases](#13-error-handling--edge-cases)
14. [Configuration Summary](#14-configuration-summary)

---

## 1. Architecture at a Glance

```
backend/app/market/
  __init__.py          Re-exports: PriceUpdate, PriceCache, MarketDataSource,
                        create_market_data_source, create_stream_router
  models.py             PriceUpdate — frozen dataclass, the value type both sides agree on
  cache.py               PriceCache — thread-safe in-memory store, single source of truth
  interface.py           MarketDataSource — ABC (lifecycle + membership, not data retrieval)
  seed_prices.py          SEED_PRICES, TICKER_PARAMS, DEFAULT_PARAMS, CORRELATION_GROUPS
  simulator.py            GBMSimulator + SimulatorDataSource(MarketDataSource)
  massive_client.py       MassiveDataSource(MarketDataSource)
  factory.py               create_market_data_source() — reads MASSIVE_API_KEY, picks one
  stream.py                 create_stream_router() — GET /api/stream/prices (SSE)
```

```
MarketDataSource (ABC)                    interface.py
├── SimulatorDataSource                    simulator.py     — GBM, no external dependency
└── MassiveDataSource                      massive_client.py — polls Massive REST API
        │
        ▼  writes
   PriceCache                              cache.py          — shared, thread-safe state
        │
        ▼  reads
   SSE stream router                       stream.py         — GET /api/stream/prices
   (+ portfolio valuation, trade execution — not yet built, see §11)
```

`create_market_data_source()` in `factory.py` is the *only* place in the codebase that
branches on `MASSIVE_API_KEY`. Every consumer — the SSE endpoint, and eventually portfolio
valuation and trade execution — depends only on `PriceCache` and never imports
`SimulatorDataSource` or `MassiveDataSource` directly. This is a textbook Strategy pattern:
the two data sources are interchangeable strategies selected once at process startup.

Minimal end-to-end usage (see §10 for the full FastAPI wiring):

```python
from app.market import PriceCache, create_market_data_source

cache = PriceCache()
source = create_market_data_source(cache)     # reads MASSIVE_API_KEY
await source.start(["AAPL", "GOOGL", "MSFT", ...])

price = cache.get_price("AAPL")               # float | None
update = cache.get("AAPL")                    # PriceUpdate | None
all_prices = cache.get_all()                  # dict[str, PriceUpdate]

await source.add_ticker("TSLA")
await source.remove_ticker("GOOGL")

await source.stop()
```

---

## 2. Data Model — `models.py`

One immutable, slotted dataclass. Both data sources produce these (indirectly, via
`PriceCache.update()`), and every consumer — SSE serialization, eventually portfolio math —
reads them.

```python
"""Data models for market data."""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class PriceUpdate:
    """Immutable snapshot of a single ticker's price at a point in time."""

    ticker: str
    price: float
    previous_price: float
    timestamp: float = field(default_factory=time.time)  # Unix seconds

    @property
    def change(self) -> float:
        """Absolute price change from previous update."""
        return round(self.price - self.previous_price, 4)

    @property
    def change_percent(self) -> float:
        """Percentage change from previous update."""
        if self.previous_price == 0:
            return 0.0
        return round((self.price - self.previous_price) / self.previous_price * 100, 4)

    @property
    def direction(self) -> str:
        """'up', 'down', or 'flat'."""
        if self.price > self.previous_price:
            return "up"
        elif self.price < self.previous_price:
            return "down"
        return "flat"

    def to_dict(self) -> dict:
        """Serialize for JSON / SSE transmission."""
        return {
            "ticker": self.ticker,
            "price": self.price,
            "previous_price": self.previous_price,
            "timestamp": self.timestamp,
            "change": self.change,
            "change_percent": self.change_percent,
            "direction": self.direction,
        }
```

Design notes:

- **`frozen=True, slots=True`** — no consumer can mutate a cached update in place (a
  `PriceUpdate` handed to an SSE generator can't be corrupted by another coroutine before
  it's serialized), and there's no per-instance `__dict__` overhead. Relevant because these
  are allocated fresh on every tick for every ticker.
- **`change`/`change_percent`/`direction` are tick-over-tick**, computed against
  `previous_price` (the price one update ago), *not* against a session open or previous
  close. There is no "daily change %" concept anywhere in this subsystem — the simulator has
  no notion of a trading session, only a continuous price path. If the product needs a
  daily-change display, it must be built on top of this (e.g. the frontend records the first
  price it sees per ticker after page load and computes against that), not inside
  `PriceUpdate`. See `planning/PLAN.md` §13 item 5 / §1.5 in the review docs.
- **`timestamp` is a Unix epoch float (seconds)**, set by whichever data source wrote the
  update (or `time.time()` if none given). This differs from every database column in the
  eventual schema (`planning/PLAN.md` §7), which is ISO 8601 text — downstream code that
  reads both SSE and DB timestamps must not assume one format.
- **`change`/`change_percent` are `round()`ed to 4 decimal places**; `price`/`previous_price`
  are rounded to 2 decimal places, but *by `PriceCache.update()`*, not here — see §3.

---

## 3. Price Cache — `cache.py`

Thread-safe (a plain `threading.Lock`, not an `asyncio.Lock` — see below) in-memory
`dict[str, PriceUpdate]`, plus a monotonic version counter used for cheap SSE change
detection.

```python
"""Thread-safe in-memory price cache."""

from __future__ import annotations

import time
from threading import Lock

from .models import PriceUpdate


class PriceCache:
    """Thread-safe in-memory cache of the latest price for each ticker.

    Writers: SimulatorDataSource or MassiveDataSource (one at a time).
    Readers: SSE streaming endpoint, portfolio valuation, trade execution.
    """

    def __init__(self) -> None:
        self._prices: dict[str, PriceUpdate] = {}
        self._lock = Lock()
        self._version: int = 0  # Monotonically increasing; bumped on every update

    def update(self, ticker: str, price: float, timestamp: float | None = None) -> PriceUpdate:
        """Record a new price for a ticker. Returns the created PriceUpdate.

        Automatically computes direction and change from the previous price.
        If this is the first update for the ticker, previous_price == price (direction='flat').
        """
        with self._lock:
            ts = timestamp or time.time()
            prev = self._prices.get(ticker)
            previous_price = prev.price if prev else price

            update = PriceUpdate(
                ticker=ticker,
                price=round(price, 2),
                previous_price=round(previous_price, 2),
                timestamp=ts,
            )
            self._prices[ticker] = update
            self._version += 1
            return update

    def get(self, ticker: str) -> PriceUpdate | None:
        """Get the latest price for a single ticker, or None if unknown."""
        with self._lock:
            return self._prices.get(ticker)

    def get_all(self) -> dict[str, PriceUpdate]:
        """Snapshot of all current prices. Returns a shallow copy."""
        with self._lock:
            return dict(self._prices)

    def get_price(self, ticker: str) -> float | None:
        """Convenience: get just the price float, or None."""
        update = self.get(ticker)
        return update.price if update else None

    def remove(self, ticker: str) -> None:
        """Remove a ticker from the cache (e.g., when removed from watchlist)."""
        with self._lock:
            self._prices.pop(ticker, None)

    @property
    def version(self) -> int:
        """Current version counter. Useful for SSE change detection."""
        return self._version

    def __len__(self) -> int:
        with self._lock:
            return len(self._prices)

    def __contains__(self, ticker: str) -> bool:
        with self._lock:
            return ticker in self._prices
```

Key properties:

- **Writers are exclusive.** Exactly one `MarketDataSource` implementation is active at a
  time (chosen once at startup by the factory, §8), so there is never write contention
  between a simulator and a real feed. The lock exists to make concurrent *reads* safe during
  a write, not to arbitrate between multiple producers — a `threading.Lock` (not an asyncio
  primitive) is deliberate, because `Massive`'s poll runs inside `asyncio.to_thread` (§7),
  putting a real OS thread in the picture alongside the event loop.
- **`version` enables O(1) change detection.** Every `update()` call increments it once. The
  SSE endpoint (§9) polls `version` instead of diffing price dicts — an integer comparison
  every 500ms, regardless of how many tickers or connected clients there are.
- **First update seeds `previous_price` with itself.** A ticker's very first `PriceUpdate`
  has `previous_price == price`, so `direction` comes out `"flat"` rather than spuriously
  `"up"`/`"down"` on the initial tick.
- **Prices are rounded to 2 decimal places exactly once, in the cache.** Both
  `SimulatorDataSource` and `MassiveDataSource` hand raw floats to `cache.update()`; neither
  data source rounds independently.
- **`timestamp or time.time()`** — passing `timestamp=0.0` would fall through to
  `time.time()` (falsy), which is never actually hit in practice (epoch 0 is not a real
  price time) but is worth knowing if a test ever tries to assert on it.

---

## 4. Abstract Interface — `interface.py`

Five methods, all lifecycle/membership, no method returns a price. That split is
deliberate: the ABC answers "which tickers, and are you running," not "give me a price in
twelve different shapes" — data retrieval is the cache's job (§3), not the source's.

```python
"""Abstract interface for market data sources."""

from __future__ import annotations

from abc import ABC, abstractmethod


class MarketDataSource(ABC):
    """Contract for market data providers.

    Implementations push price updates into a shared PriceCache on their own
    schedule. Downstream code never calls the data source directly for prices —
    it reads from the cache.

    Lifecycle:
        source = create_market_data_source(cache)
        await source.start(["AAPL", "GOOGL", ...])
        # ... app runs ...
        await source.add_ticker("TSLA")
        await source.remove_ticker("GOOGL")
        # ... app shutting down ...
        await source.stop()
    """

    @abstractmethod
    async def start(self, tickers: list[str]) -> None:
        """Begin producing price updates for the given tickers.

        Starts a background task that periodically writes to the PriceCache.
        Must be called exactly once. Calling start() twice is undefined behavior.
        """

    @abstractmethod
    async def stop(self) -> None:
        """Stop the background task and release resources.

        Safe to call multiple times. After stop(), the source will not write
        to the cache again.
        """

    @abstractmethod
    async def add_ticker(self, ticker: str) -> None:
        """Add a ticker to the active set. No-op if already present.

        The next update cycle will include this ticker.
        """

    @abstractmethod
    async def remove_ticker(self, ticker: str) -> None:
        """Remove a ticker from the active set. No-op if not present.

        Also removes the ticker from the PriceCache.
        """

    @abstractmethod
    def get_tickers(self) -> list[str]:
        """Return the current list of actively tracked tickers."""
```

- `start()` is called exactly once, from the FastAPI lifespan startup handler (§10).
- `stop()` is idempotent — safe from both a normal shutdown path and, if one is ever added, a
  signal handler.
- `add_ticker`/`remove_ticker` are coroutines even though `SimulatorDataSource`'s
  implementation does no I/O, purely so callers never need to know which implementation is
  active (`MassiveDataSource` genuinely mutates async-relevant state — see §7).
- Adding a third source later (a different vendor, a websocket-based Massive variant) means
  writing one new class against this ABC — zero changes to `cache.py`, `stream.py`, or any
  future portfolio/trade code.

---

## 5. Seed Prices & Ticker Parameters — `seed_prices.py`

Pure data — no logic. Consumed by `simulator.py` (§6) for starting prices, per-ticker
volatility/drift, and sector correlation grouping.

```python
"""Seed prices and per-ticker parameters for the market simulator."""

# Realistic starting prices for the default watchlist (as of project creation)
SEED_PRICES: dict[str, float] = {
    "AAPL": 190.00,
    "GOOGL": 175.00,
    "MSFT": 420.00,
    "AMZN": 185.00,
    "TSLA": 250.00,
    "NVDA": 800.00,
    "META": 500.00,
    "JPM": 195.00,
    "V": 280.00,
    "NFLX": 600.00,
}

# Per-ticker GBM parameters
# sigma: annualized volatility (higher = more price movement)
# mu: annualized drift / expected return
TICKER_PARAMS: dict[str, dict[str, float]] = {
    "AAPL": {"sigma": 0.22, "mu": 0.05},
    "GOOGL": {"sigma": 0.25, "mu": 0.05},
    "MSFT": {"sigma": 0.20, "mu": 0.05},
    "AMZN": {"sigma": 0.28, "mu": 0.05},
    "TSLA": {"sigma": 0.50, "mu": 0.03},  # High volatility
    "NVDA": {"sigma": 0.40, "mu": 0.08},  # High volatility, strong drift
    "META": {"sigma": 0.30, "mu": 0.05},
    "JPM": {"sigma": 0.18, "mu": 0.04},  # Low volatility (bank)
    "V": {"sigma": 0.17, "mu": 0.04},  # Low volatility (payments)
    "NFLX": {"sigma": 0.35, "mu": 0.05},
}

# Default parameters for tickers not in the list above (dynamically added)
DEFAULT_PARAMS: dict[str, float] = {"sigma": 0.25, "mu": 0.05}

# Correlation groups for the simulator's Cholesky decomposition
# Tickers in the same group have higher intra-group correlation
CORRELATION_GROUPS: dict[str, set[str]] = {
    "tech": {"AAPL", "GOOGL", "MSFT", "AMZN", "META", "NVDA", "NFLX"},
    "finance": {"JPM", "V"},
}

# Correlation coefficients
INTRA_TECH_CORR = 0.6  # Tech stocks move together
INTRA_FINANCE_CORR = 0.5  # Finance stocks move together
CROSS_GROUP_CORR = 0.3  # Between sectors / unknown tickers
TSLA_CORR = 0.3  # TSLA does its own thing
```

- A ticker dynamically added at runtime (via watchlist add, LLM watchlist action, or a
  position ticker that outlived its watchlist entry — see §11) that isn't in
  `TICKER_PARAMS`/`SEED_PRICES` falls back to `DEFAULT_PARAMS` and a
  `random.uniform(50.0, 300.0)` seed price (in `simulator.py`, not here) — every ticker the
  simulator ever tracks has *some* volatility/drift/price; there's no unhandled case. This is
  a deliberate fabrication for unknown symbols, worth calling out explicitly in whatever
  ticker-validation policy the watchlist routes adopt (`planning/PLAN.md` §13 item 4 /
  review §2.4).
- These numbers are directionally realistic, calibrated "as of project creation," not pinned
  to any live feed — the simulator has zero dependency on real market data, including at
  startup.

---

## 6. GBM Simulator — `simulator.py`

The default data source (used whenever `MASSIVE_API_KEY` is unset). No external dependency
beyond `numpy`; runs entirely in-process.

### 6.1 The math

```
S(t+dt) = S(t) * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z)

Where:
    S(t)   = current price
    mu     = annualized drift (expected return)
    sigma  = annualized volatility
    dt     = time step as fraction of a trading year
    Z      = correlated standard normal random variable
```

Standard discretized solution of the GBM SDE `dS = mu*S*dt + sigma*S*dW`. Chosen because it
guarantees `S(t) > 0` always — a real stock price can drift and jump but never goes
negative under this model, unlike an additive random walk.

`dt` is calibrated so "one tick" means "half a second of simulated trading time," not "half
a second of wall-clock time scaled arbitrarily":

```python
TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600  # 5,896,800 (252 days * 6.5h * 3600s)
DEFAULT_DT = 0.5 / TRADING_SECONDS_PER_YEAR  # ~8.48e-8
```

### 6.2 Correlated moves via Cholesky decomposition

Real markets don't move independently — tech stocks tend to rise and fall together, finance
stocks together. The simulator reproduces this by correlating the random shocks `Z` across
tickers every tick, rather than drawing each ticker's shock independently:

```python
def _rebuild_cholesky(self) -> None:
    """Rebuild the Cholesky decomposition of the ticker correlation matrix.

    Called whenever tickers are added or removed. O(n^2) but n < 50.
    """
    n = len(self._tickers)
    if n <= 1:
        self._cholesky = None
        return

    # Build the correlation matrix
    corr = np.eye(n)
    for i in range(n):
        for j in range(i + 1, n):
            rho = self._pairwise_correlation(self._tickers[i], self._tickers[j])
            corr[i, j] = rho
            corr[j, i] = rho

    self._cholesky = np.linalg.cholesky(corr)
```

If `L` is the lower-triangular Cholesky factor of correlation matrix `C` (`C = L @ L.T`),
then `L @ z_independent` produces a vector of standard normals whose pairwise correlations
match `C`. Rebuilding is `O(n²)` for matrix construction plus `O(n³)` for the Cholesky
factorization itself — acceptable because tracked tickers stay well under 50, and it only
happens on ticker add/remove, never per tick (the hot path).

Pairwise correlation lookup — TSLA is special-cased to correlate like a cross-sector ticker
(0.3) with *everything*, including other tech names, modeling it as the idiosyncratic mover
it tends to be rather than tracking the broader tech basket tightly:

```python
@staticmethod
def _pairwise_correlation(t1: str, t2: str) -> float:
    """Determine correlation between two tickers based on sector grouping.

    Correlation structure:
      - Same tech sector:   0.6
      - Same finance sector: 0.5
      - TSLA with anything: 0.3 (it does its own thing)
      - Cross-sector:       0.3
      - Unknown tickers:    0.3
    """
    tech = CORRELATION_GROUPS["tech"]
    finance = CORRELATION_GROUPS["finance"]

    if t1 == "TSLA" or t2 == "TSLA":
        return TSLA_CORR
    if t1 in tech and t2 in tech:
        return INTRA_TECH_CORR
    if t1 in finance and t2 in finance:
        return INTRA_FINANCE_CORR

    return CROSS_GROUP_CORR
```

### 6.3 `GBMSimulator` — the full class

Pure simulation state machine — no I/O, no asyncio, trivially unit-testable by calling
`step()` repeatedly and asserting on the returned dict.

```python
"""GBM-based market simulator."""

from __future__ import annotations

import asyncio
import logging
import math
import random

import numpy as np

from .cache import PriceCache
from .interface import MarketDataSource
from .seed_prices import (
    CORRELATION_GROUPS,
    CROSS_GROUP_CORR,
    DEFAULT_PARAMS,
    INTRA_FINANCE_CORR,
    INTRA_TECH_CORR,
    SEED_PRICES,
    TICKER_PARAMS,
    TSLA_CORR,
)

logger = logging.getLogger(__name__)


class GBMSimulator:
    """Geometric Brownian Motion simulator for correlated stock prices.

    Math:
        S(t+dt) = S(t) * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z)

    The tiny dt (~8.5e-8 for 500ms ticks over 252 trading days * 6.5h/day)
    produces sub-cent moves per tick that accumulate naturally over time.
    """

    TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600  # 5,896,800
    DEFAULT_DT = 0.5 / TRADING_SECONDS_PER_YEAR  # ~8.48e-8

    def __init__(
        self,
        tickers: list[str],
        dt: float = DEFAULT_DT,
        event_probability: float = 0.001,
    ) -> None:
        self._dt = dt
        self._event_prob = event_probability

        self._tickers: list[str] = []
        self._prices: dict[str, float] = {}
        self._params: dict[str, dict[str, float]] = {}
        self._cholesky: np.ndarray | None = None

        for ticker in tickers:
            self._add_ticker_internal(ticker)
        self._rebuild_cholesky()

    # --- Public API ---

    def step(self) -> dict[str, float]:
        """Advance all tickers by one time step. Returns {ticker: new_price}.

        This is the hot path — called every 500ms. Keep it fast.
        """
        n = len(self._tickers)
        if n == 0:
            return {}

        z_independent = np.random.standard_normal(n)
        z_correlated = self._cholesky @ z_independent if self._cholesky is not None else z_independent

        result: dict[str, float] = {}
        for i, ticker in enumerate(self._tickers):
            params = self._params[ticker]
            mu = params["mu"]
            sigma = params["sigma"]

            drift = (mu - 0.5 * sigma**2) * self._dt
            diffusion = sigma * math.sqrt(self._dt) * z_correlated[i]
            self._prices[ticker] *= math.exp(drift + diffusion)

            # Random event: ~0.1% chance per tick per ticker
            # With 10 tickers at 2 ticks/sec, expect an event ~every 50 seconds
            if random.random() < self._event_prob:
                shock_magnitude = random.uniform(0.02, 0.05)
                shock_sign = random.choice([-1, 1])
                self._prices[ticker] *= 1 + shock_magnitude * shock_sign
                logger.debug(
                    "Random event on %s: %.1f%% %s",
                    ticker, shock_magnitude * 100, "up" if shock_sign > 0 else "down",
                )

            result[ticker] = round(self._prices[ticker], 2)

        return result

    def add_ticker(self, ticker: str) -> None:
        """Add a ticker to the simulation. Rebuilds the correlation matrix."""
        if ticker in self._prices:
            return
        self._add_ticker_internal(ticker)
        self._rebuild_cholesky()

    def remove_ticker(self, ticker: str) -> None:
        """Remove a ticker from the simulation. Rebuilds the correlation matrix."""
        if ticker not in self._prices:
            return
        self._tickers.remove(ticker)
        del self._prices[ticker]
        del self._params[ticker]
        self._rebuild_cholesky()

    def get_price(self, ticker: str) -> float | None:
        return self._prices.get(ticker)

    def get_tickers(self) -> list[str]:
        return list(self._tickers)

    # --- Internals ---

    def _add_ticker_internal(self, ticker: str) -> None:
        """Add a ticker without rebuilding Cholesky (for batch initialization)."""
        if ticker in self._prices:
            return
        self._tickers.append(ticker)
        self._prices[ticker] = SEED_PRICES.get(ticker, random.uniform(50.0, 300.0))
        self._params[ticker] = TICKER_PARAMS.get(ticker, dict(DEFAULT_PARAMS))

    def _rebuild_cholesky(self) -> None:
        n = len(self._tickers)
        if n <= 1:
            self._cholesky = None
            return
        corr = np.eye(n)
        for i in range(n):
            for j in range(i + 1, n):
                rho = self._pairwise_correlation(self._tickers[i], self._tickers[j])
                corr[i, j] = rho
                corr[j, i] = rho
        self._cholesky = np.linalg.cholesky(corr)

    @staticmethod
    def _pairwise_correlation(t1: str, t2: str) -> float:
        tech = CORRELATION_GROUPS["tech"]
        finance = CORRELATION_GROUPS["finance"]
        if t1 == "TSLA" or t2 == "TSLA":
            return TSLA_CORR
        if t1 in tech and t2 in tech:
            return INTRA_TECH_CORR
        if t1 in finance and t2 in finance:
            return INTRA_FINANCE_CORR
        return CROSS_GROUP_CORR
```

### 6.4 `SimulatorDataSource` — the async adapter

Wraps `GBMSimulator` to satisfy `MarketDataSource` (§4) and drives it on a background
asyncio task. This is the thin, mostly-integration-tested glue that fits the pure simulator
into the asyncio world — the simulator itself has no idea it's being driven by a loop.

```python
class SimulatorDataSource(MarketDataSource):
    """MarketDataSource backed by the GBM simulator.

    Runs a background asyncio task that calls GBMSimulator.step() every
    `update_interval` seconds and writes results to the PriceCache.
    """

    def __init__(
        self,
        price_cache: PriceCache,
        update_interval: float = 0.5,
        event_probability: float = 0.001,
    ) -> None:
        self._cache = price_cache
        self._interval = update_interval
        self._event_prob = event_probability
        self._sim: GBMSimulator | None = None
        self._task: asyncio.Task | None = None

    async def start(self, tickers: list[str]) -> None:
        self._sim = GBMSimulator(tickers=tickers, event_probability=self._event_prob)
        # Seed the cache with initial prices so SSE has data immediately
        for ticker in tickers:
            price = self._sim.get_price(ticker)
            if price is not None:
                self._cache.update(ticker=ticker, price=price)
        self._task = asyncio.create_task(self._run_loop(), name="simulator-loop")
        logger.info("Simulator started with %d tickers", len(tickers))

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        logger.info("Simulator stopped")

    async def add_ticker(self, ticker: str) -> None:
        if self._sim:
            self._sim.add_ticker(ticker)
            # Seed cache immediately so the ticker has a price right away
            price = self._sim.get_price(ticker)
            if price is not None:
                self._cache.update(ticker=ticker, price=price)
            logger.info("Simulator: added ticker %s", ticker)

    async def remove_ticker(self, ticker: str) -> None:
        if self._sim:
            self._sim.remove_ticker(ticker)
        self._cache.remove(ticker)
        logger.info("Simulator: removed ticker %s", ticker)

    def get_tickers(self) -> list[str]:
        return self._sim.get_tickers() if self._sim else []

    async def _run_loop(self) -> None:
        """Core loop: step the simulation, write to cache, sleep."""
        while True:
            try:
                if self._sim:
                    prices = self._sim.step()
                    for ticker, price in prices.items():
                        self._cache.update(ticker=ticker, price=price)
            except Exception:
                logger.exception("Simulator step failed")
            await asyncio.sleep(self._interval)
```

A step failure is caught and logged without killing the background loop — one bad tick
(e.g. a numeric edge case) doesn't take down price streaming for the rest of the session.

### 6.5 Parameters summary

| Parameter | Value | Where |
|---|---|---|
| Tick interval | 500ms | `SimulatorDataSource(update_interval=0.5)` |
| `dt` per tick | ~8.48e-8 (fraction of trading year) | `GBMSimulator.DEFAULT_DT` |
| Event probability | 0.1% per ticker per tick | `event_probability=0.001` |
| Event magnitude | 2-5%, random sign | `random.uniform(0.02, 0.05)` |
| Tech correlation | 0.6 | `INTRA_TECH_CORR` |
| Finance correlation | 0.5 | `INTRA_FINANCE_CORR` |
| Cross-sector / TSLA correlation | 0.3 | `CROSS_GROUP_CORR` / `TSLA_CORR` |
| Default volatility (unknown ticker) | 0.25 annualized | `DEFAULT_PARAMS` |
| Default drift (unknown ticker) | 0.05 annualized | `DEFAULT_PARAMS` |

---

## 7. Massive API Client — `massive_client.py`

`MassiveDataSource`, used when `MASSIVE_API_KEY` is set and non-empty. Massive is the 2025
rebrand of Polygon.io — same API, same accounts, `pip install massive` replaces
`pip install polygon-api-client`. Full research notes and endpoint reference:
`planning/MASSIVE_API.md`.

### 7.1 What it calls

The multi-ticker snapshot endpoint is the only Massive endpoint that returns last-trade
price for an arbitrary caller-specified list of tickers in one request — exactly this
project's ~10-ticker watchlist shape:

```
GET /v2/snapshot/locale/us/markets/stocks/tickers?tickers=AAPL,TSLA,GOOGL
```

Via the SDK's typed model:

```python
from massive import RESTClient
from massive.rest.models import SnapshotMarketType

client = RESTClient(api_key="<API_KEY>")
snapshots = client.get_snapshot_all(
    market_type=SnapshotMarketType.STOCKS,
    tickers=["AAPL", "GOOGL", "MSFT"],
)
for snap in snapshots:
    print(snap.ticker, snap.last_trade.price, snap.last_trade.timestamp)
```

### 7.2 Rate limits and polling interval

Free tier: **5 requests/minute → minimum 12s between calls.** This project polls every
**15s**, leaving headroom. One call per poll covers the whole watchlist regardless of size
(up to the whole market), so the poll interval doesn't scale with ticker count. Free/low
tiers also receive **15-minute-delayed** data, not real-time — Advanced/Business tiers get
real-time (`planning/MASSIVE_API.md` §5.1). Do not loop the per-ticker `open-close` or
`last-trade` endpoints over the watchlist — that burns 10 requests/cycle against a 5 req/min
budget and gets rate-limited almost immediately.

### 7.3 The full class

```python
"""Massive (Polygon.io) API client for real market data."""

from __future__ import annotations

import asyncio
import logging

from massive import RESTClient
from massive.rest.models import SnapshotMarketType

from .cache import PriceCache
from .interface import MarketDataSource

logger = logging.getLogger(__name__)


class MassiveDataSource(MarketDataSource):
    """MarketDataSource backed by the Massive (Polygon.io) REST API.

    Polls GET /v2/snapshot/locale/us/markets/stocks/tickers for all watched
    tickers in a single API call, then writes results to the PriceCache.

    Rate limits:
      - Free tier: 5 req/min → poll every 15s (default)
      - Paid tiers: higher limits → poll every 2-5s
    """

    def __init__(
        self,
        api_key: str,
        price_cache: PriceCache,
        poll_interval: float = 15.0,
    ) -> None:
        self._api_key = api_key
        self._cache = price_cache
        self._interval = poll_interval
        self._tickers: list[str] = []
        self._task: asyncio.Task | None = None
        self._client: RESTClient | None = None

    async def start(self, tickers: list[str]) -> None:
        self._client = RESTClient(api_key=self._api_key)
        self._tickers = list(tickers)

        # Do an immediate first poll so the cache has data right away
        await self._poll_once()

        self._task = asyncio.create_task(self._poll_loop(), name="massive-poller")
        logger.info(
            "Massive poller started: %d tickers, %.1fs interval",
            len(tickers), self._interval,
        )

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._client = None
        logger.info("Massive poller stopped")

    async def add_ticker(self, ticker: str) -> None:
        ticker = ticker.upper().strip()
        if ticker not in self._tickers:
            self._tickers.append(ticker)
            logger.info("Massive: added ticker %s (will appear on next poll)", ticker)

    async def remove_ticker(self, ticker: str) -> None:
        ticker = ticker.upper().strip()
        self._tickers = [t for t in self._tickers if t != ticker]
        self._cache.remove(ticker)
        logger.info("Massive: removed ticker %s", ticker)

    def get_tickers(self) -> list[str]:
        return list(self._tickers)

    # --- Internal ---

    async def _poll_loop(self) -> None:
        """Poll on interval. First poll already happened in start()."""
        while True:
            await asyncio.sleep(self._interval)
            await self._poll_once()

    async def _poll_once(self) -> None:
        """Execute one poll cycle: fetch snapshots, update cache."""
        if not self._tickers or not self._client:
            return

        try:
            # The Massive RESTClient is synchronous — run in a thread to
            # avoid blocking the event loop.
            snapshots = await asyncio.to_thread(self._fetch_snapshots)
            processed = 0
            for snap in snapshots:
                try:
                    price = snap.last_trade.price
                    # Massive timestamps are Unix milliseconds → convert to seconds
                    timestamp = snap.last_trade.timestamp / 1000.0
                    self._cache.update(ticker=snap.ticker, price=price, timestamp=timestamp)
                    processed += 1
                except (AttributeError, TypeError) as e:
                    logger.warning(
                        "Skipping snapshot for %s: %s", getattr(snap, "ticker", "???"), e,
                    )
            logger.debug("Massive poll: updated %d/%d tickers", processed, len(self._tickers))

        except Exception as e:
            logger.error("Massive poll failed: %s", e)
            # Don't re-raise — the loop will retry on the next interval.
            # Common failures: 401 (bad key), 429 (rate limit), network errors.

    def _fetch_snapshots(self) -> list:
        """Synchronous call to the Massive REST API. Runs in a thread."""
        return self._client.get_snapshot_all(
            market_type=SnapshotMarketType.STOCKS,
            tickers=self._tickers,
        )
```

**`massive` is a top-level import, not a lazy one.** An earlier draft of this design lazily
imported `massive` inside `start()`/`factory.py` so students without a Massive key wouldn't
need the package installed. The actual implementation imports `massive` at module load time
instead — it's a core dependency in `backend/pyproject.toml` regardless of whether
`MASSIVE_API_KEY` is set, which is simpler and was the fix applied during code review (see
`planning/MARKET_DATA_SUMMARY.md`, review item 2). Practical effect: `uv sync` always
installs `massive`; only *using* `MassiveDataSource` requires a real key.

**Timestamp unit caveat (unresolved, flagged for whoever next touches this file):**
`_poll_once()` divides `snap.last_trade.timestamp` by `1000.0`, assuming milliseconds.
Massive's own documented example response for this exact snapshot endpoint shows a 19-digit
`lastTrade.t` value (`1605192894630916600`), which is Unix **nanoseconds**, not
milliseconds — see `planning/MASSIVE_API.md` §6. This may be off by a factor of 1,000,000
for real Massive responses (either producing timestamps in 1970, or the SDK may already
normalize units before exposing `.timestamp`, in which case the current `/1000.0` is
correct). This has not been verified against a live API response or the SDK's internal
conversion code — verify with a real `MASSIVE_API_KEY` before relying on Massive mode's
displayed timestamps for anything beyond ordering.

### 7.4 Error handling philosophy

The Massive poller is intentionally resilient — a bad poll should never take down price
streaming, only leave it stale until the next successful poll:

| Error | Behavior |
|-------|----------|
| **401 Unauthorized** | Logged as error. Poller keeps running (user might fix `.env` and restart). |
| **429 Rate Limited** | Logged as error. Next poll retries after `poll_interval` seconds. |
| **Network timeout** | Logged as error. Retries automatically on next cycle. |
| **Malformed snapshot** | Individual ticker skipped with warning. Other tickers still processed. |
| **All tickers fail** | Cache retains last-known prices. SSE keeps streaming stale data (better than no data). |

---

## 8. Factory — `factory.py`

The single switch. Everything else in the backend depends only on `MarketDataSource` and
`PriceCache`.

```python
"""Factory for creating market data sources."""

from __future__ import annotations

import logging
import os

from .cache import PriceCache
from .interface import MarketDataSource
from .massive_client import MassiveDataSource
from .simulator import SimulatorDataSource

logger = logging.getLogger(__name__)


def create_market_data_source(price_cache: PriceCache) -> MarketDataSource:
    """Create the appropriate market data source based on environment variables.

    - MASSIVE_API_KEY set and non-empty → MassiveDataSource (real market data)
    - Otherwise → SimulatorDataSource (GBM simulation)

    Returns an unstarted source. Caller must await source.start(tickers).
    """
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()

    if api_key:
        logger.info("Market data source: Massive API (real data)")
        return MassiveDataSource(api_key=api_key, price_cache=price_cache)
    else:
        logger.info("Market data source: GBM Simulator")
        return SimulatorDataSource(price_cache=price_cache)
```

`.strip()` on the env var means a key set to whitespace-only is treated as absent, falling
back to the simulator rather than constructing a `MassiveDataSource` with a blank key that
would fail on first request.

Usage at app startup:

```python
price_cache = PriceCache()
source = create_market_data_source(price_cache)
await source.start(initial_tickers)  # e.g., ["AAPL", "GOOGL", ...]
```

---

## 9. SSE Streaming Endpoint — `stream.py`

A FastAPI route that holds a long-lived HTTP connection open and pushes price updates as
`text/event-stream`. Built via a factory that closes over the `PriceCache` — not a global —
so the router has zero dependency on which `MarketDataSource` is feeding that cache.

```python
"""SSE streaming endpoint for live price updates."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .cache import PriceCache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stream", tags=["streaming"])


def create_stream_router(price_cache: PriceCache) -> APIRouter:
    """Create the SSE streaming router with a reference to the price cache.

    This factory pattern lets us inject the PriceCache without globals.
    """

    @router.get("/prices")
    async def stream_prices(request: Request) -> StreamingResponse:
        """SSE endpoint for live price updates.

        Streams all tracked ticker prices every ~500ms. The client connects
        with EventSource and receives events in the format:

            data: {"AAPL": {"ticker": "AAPL", "price": 190.50, ...}, ...}

        Includes a retry directive so the browser auto-reconnects on
        disconnection (EventSource built-in behavior).
        """
        return StreamingResponse(
            _generate_events(price_cache, request),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # Disable nginx buffering if proxied
            },
        )

    return router


async def _generate_events(
    price_cache: PriceCache,
    request: Request,
    interval: float = 0.5,
) -> AsyncGenerator[str, None]:
    """Async generator that yields SSE-formatted price events.

    Sends all prices every `interval` seconds. Stops when the client
    disconnects (detected via request.is_disconnected()).
    """
    # Tell the client to retry after 1 second if the connection drops
    yield "retry: 1000\n\n"

    last_version = -1
    client_ip = request.client.host if request.client else "unknown"
    logger.info("SSE client connected: %s", client_ip)

    try:
        while True:
            if await request.is_disconnected():
                logger.info("SSE client disconnected: %s", client_ip)
                break

            current_version = price_cache.version
            if current_version != last_version:
                last_version = current_version
                prices = price_cache.get_all()

                if prices:
                    data = {ticker: update.to_dict() for ticker, update in prices.items()}
                    payload = json.dumps(data)
                    yield f"data: {payload}\n\n"

            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        logger.info("SSE stream cancelled for: %s", client_ip)
```

### 9.1 Wire format — read this before building the frontend

Each SSE event is **one JSON object keyed by ticker, containing every currently tracked
ticker** — not one event per ticker per change. This differs from `planning/PLAN.md` §6's
prose ("Each SSE event contains ticker, price, previous price, timestamp, and change
direction"), which reads as one-event-per-ticker; the actual payload is the full snapshot,
verbatim:

```
data: {"AAPL":{"ticker":"AAPL","price":190.50,"previous_price":190.42,"timestamp":1707580800.5,"change":0.08,"change_percent":0.042,"direction":"up"},"GOOGL":{"ticker":"GOOGL","price":175.12,"previous_price":175.12,"timestamp":1707580800.5,"change":0.0,"change_percent":0.0,"direction":"flat"}}

```

Client-side parsing:

```javascript
const eventSource = new EventSource('/api/stream/prices');
eventSource.onmessage = (event) => {
    const prices = JSON.parse(event.data);
    // prices is { "AAPL": { ticker, price, previous_price, change, change_percent, direction, timestamp }, ... }
};
```

**Practical consequence for the frontend:** because *every* event carries *every* tracked
ticker, a ticker whose price didn't move this cycle still shows up with an unchanged value
in the payload. The frontend must diff each ticker against the last price it rendered before
triggering a flash animation or appending a sparkline point — it cannot assume "present in
this event" means "changed."

### 9.2 Emission semantics — poll-and-check, not blind broadcast

The generator polls `price_cache.version` every 500ms but **only serializes and sends when
the version has changed** since the last check — an O(1) integer comparison, not a dict
diff. Against the simulator (which ticks every 500ms) this is nearly indistinguishable from
"broadcast every 500ms." Against Massive (polling every 15s), most of those 500ms checks are
no-ops that send nothing at all — correct, bandwidth-efficient behavior for a slower source
using the exact same SSE code path, and the reason the version counter exists on
`PriceCache` in the first place (§3). This corrects `planning/PLAN.md` §6's description of
the cadence as a blind ~500ms broadcast.

### 9.3 Why poll-and-push instead of event-driven?

The SSE endpoint polls the cache on a fixed interval rather than being notified synchronously
by the data source. Simpler, and it produces predictable, evenly-spaced updates — useful
since the frontend accumulates ticks into sparkline charts, where regular spacing matters for
a clean visualization.

---

## 10. FastAPI Lifecycle Integration

**Not yet built.** `backend/app/` currently contains only `market/`; there is no
`backend/app/main.py`. This section is forward design for whoever builds it — it is the
missing piece flagged as a blocker in both `planning/REVIEW.md`-style review passes
(`planning/archive/MARKET_DATA_REVIEW.md` §1, `planning/PLAN.md` §13 item 1).

The market data system starts and stops with the FastAPI application via the `lifespan`
async context manager:

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.market import PriceCache, MarketDataSource, create_market_data_source, create_stream_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage startup and shutdown of background services."""

    # --- STARTUP ---

    # 1. Create the shared price cache
    price_cache = PriceCache()
    app.state.price_cache = price_cache

    # 2. Create the market data source (reads MASSIVE_API_KEY)
    source = create_market_data_source(price_cache)
    app.state.market_source = source

    # 3. Initialize/seed the database, then load the tracked ticker set.
    #    Must happen HERE, synchronously, before source.start() — NOT deferred
    #    to first request. The market source needs the ticker list at startup;
    #    a lazy "init on first request" DB (as an earlier plan draft allowed)
    #    would leave source.start() with nothing to track.
    await db.init_and_seed()
    tracked_tickers = await db.get_tracked_tickers()  # watchlist ∪ held positions — see §11
    await source.start(tracked_tickers)

    # 4. Register the SSE streaming router
    app.include_router(create_stream_router(price_cache))

    yield  # App is running

    # --- SHUTDOWN ---
    await source.stop()


app = FastAPI(title="FinAlly", lifespan=lifespan)


def get_price_cache() -> PriceCache:
    return app.state.price_cache


def get_market_source() -> MarketDataSource:
    return app.state.market_source
```

Other routers (portfolio, watchlist, chat) access the cache and source via FastAPI
dependency injection — none of them import `SimulatorDataSource`/`MassiveDataSource`
directly:

```python
from fastapi import APIRouter, Depends, HTTPException

router = APIRouter(prefix="/api")


@router.post("/portfolio/trade")
async def execute_trade(
    trade: TradeRequest,
    price_cache: PriceCache = Depends(get_price_cache),
):
    current_price = price_cache.get_price(trade.ticker)
    if current_price is None:
        raise HTTPException(400, f"Price not yet available for {trade.ticker}")
    # ... execute the fill at current_price — this is the trade's fill price,
    # not whatever the client last rendered; SSE delivery has inherent lag ...


@router.post("/watchlist")
async def add_to_watchlist(
    payload: WatchlistAdd,
    source: MarketDataSource = Depends(get_market_source),
):
    await db.insert_watchlist_entry(payload.ticker)
    await source.add_ticker(payload.ticker)
    # ...


@router.delete("/watchlist/{ticker}")
async def remove_from_watchlist(
    ticker: str,
    source: MarketDataSource = Depends(get_market_source),
):
    await db.delete_watchlist_entry(ticker)
    # See §11 — only stop tracking if there's no open position in it.
    position = await db.get_position(ticker)
    if position is None or position.quantity == 0:
        await source.remove_ticker(ticker)
    # ...
```

Static file serving for the Next.js export (`planning/PLAN.md` §11) is mounted on the same
`app` after the API routers, so `/api/*` takes precedence and isn't swallowed by the
catch-all static mount — not shown here since it has no interaction with the market data
subsystem beyond sharing the same `FastAPI` instance.

---

## 11. Watchlist Coordination

When the watchlist changes — via the REST API or an LLM-issued `watchlist_changes` action
(`planning/PLAN.md` §9) — the market data source must be told, so it tracks the right ticker
set. This is the other missing piece flagged by review: `planning/archive/MARKET_DATA_REVIEW.md`
§1.6 and `planning/PLAN.md` §13 item 6.

### 11.1 Flow: adding a ticker

```
User (or LLM) → POST /api/watchlist {ticker: "PYPL"}
  → Insert into watchlist table (SQLite)
  → await source.add_ticker("PYPL")
      Simulator: adds to GBMSimulator, rebuilds Cholesky, seeds cache synchronously
      Massive:   appends to tracked list; ticker gets a real price on the *next* poll
                 cycle — no synthetic value in between
  → Return success (ticker + current price if the cache already has one)
```

### 11.2 Flow: removing a ticker

```
User (or LLM) → DELETE /api/watchlist/PYPL
  → Delete from watchlist table (SQLite)
  → await source.remove_ticker("PYPL")   [only if no open position — see 11.3]
      Simulator: removes from GBMSimulator, rebuilds Cholesky, removes from cache
      Massive:   removes from tracked list, removes from cache
  → Return success
```

### 11.3 The tracked-ticker-set rule (resolves a real defect)

`SimulatorDataSource.remove_ticker()` unconditionally calls `self._cache.remove(ticker)`.
If the watchlist route called `source.remove_ticker()` on every `DELETE /api/watchlist/{t}`
unconditionally, a user who removes a ticker from their watchlist while still holding
shares in it would freeze that ticker's price in the cache forever: portfolio valuation gets
`None` for it, P&L math breaks, and there is no UI path left to sell the position (it's not
on the watchlist, so it's not clickable/tradeable through the normal flow).

**Rule:** the tracked ticker set is `watchlist ∪ tickers with a non-zero position`, not just
the watchlist. `DELETE /api/watchlist/{ticker}` removes only the *display* row; it calls
`source.remove_ticker()` only when the ticker is neither on the watchlist nor held:

```python
@router.delete("/watchlist/{ticker}")
async def remove_from_watchlist(
    ticker: str,
    source: MarketDataSource = Depends(get_market_source),
):
    await db.delete_watchlist_entry(ticker)

    position = await db.get_position(ticker)
    if position is None or position.quantity == 0:
        await source.remove_ticker(ticker)
    # else: keep tracking it — it's still held, just no longer displayed
    # on the watchlist panel. The frontend needs a way to show/sell
    # held-but-unwatched positions (e.g. the positions table, independent
    # of the watchlist panel).

    return {"status": "ok"}
```

The same union rule builds the *startup* ticker list passed to `source.start()` in §10 step
3 — `db.get_tracked_tickers()` should return `watchlist ∪ positions`, not just the
watchlist table.

### 11.4 Ticker validation is not enforced anywhere in this subsystem

Nothing in `market/` validates that a ticker symbol is "real." In simulator mode, an unknown
symbol added via `add_ticker()` gets a `random.uniform(50.0, 300.0)` seed price and
thereafter its own independent GBM path (§5) — the simulator will happily fabricate a
plausible-looking stock for `ZZZZ`. In Massive mode, an unknown/invalid symbol simply never
produces a snapshot, so it never appears in the cache and any trade against it will hit the
`price is None` 400 path in §10. Whichever ticker-validation policy the watchlist/chat routes
adopt (accept any 1-5 char uppercase symbol and document the simulator's fabrication, or
validate against `SEED_PRICES` in simulator mode) is a decision for those routes, not for
`market/` — this subsystem tracks whatever tickers it's told to track, no more, no less.

---

## 12. Testing Strategy

The actual suite: `backend/tests/market/`, 6 modules, 73 tests, 84% overall coverage
(`planning/MARKET_DATA_SUMMARY.md`). Patterns below are drawn directly from the real test
files — accurate to what's checked in, not aspirational.

### 12.1 `PriceCache` — pure unit tests, no asyncio needed

`backend/tests/market/test_cache.py` (13 tests):

```python
"""Tests for PriceCache."""

from app.market.cache import PriceCache


class TestPriceCache:

    def test_update_and_get(self):
        cache = PriceCache()
        update = cache.update("AAPL", 190.50)
        assert update.ticker == "AAPL"
        assert update.price == 190.50
        assert cache.get("AAPL") == update

    def test_first_update_is_flat(self):
        cache = PriceCache()
        update = cache.update("AAPL", 190.50)
        assert update.direction == "flat"
        assert update.previous_price == 190.50

    def test_direction_up(self):
        cache = PriceCache()
        cache.update("AAPL", 190.00)
        update = cache.update("AAPL", 191.00)
        assert update.direction == "up"
        assert update.change == 1.00

    def test_version_increments(self):
        cache = PriceCache()
        v0 = cache.version
        cache.update("AAPL", 190.00)
        assert cache.version == v0 + 1
        cache.update("AAPL", 191.00)
        assert cache.version == v0 + 2

    def test_price_rounding(self):
        cache = PriceCache()
        update = cache.update("AAPL", 190.12345)
        assert update.price == 190.12
```

(Also covered in the full file: `remove`, `remove_nonexistent`, `get_all`,
`get_price_convenience`, `__len__`, `__contains__`, `custom_timestamp` — 100% coverage of
`cache.py`.)

### 12.2 `GBMSimulator` — deterministic-shape assertions on a stochastic process

`backend/tests/market/test_simulator.py` (17 tests, 98% coverage). Since the process is
random, tests assert on *shape and invariants* (always positive, correct ticker set,
Cholesky present/absent) rather than exact values:

```python
class TestGBMSimulator:

    def test_step_returns_all_tickers(self):
        sim = GBMSimulator(tickers=["AAPL", "GOOGL"])
        result = sim.step()
        assert set(result.keys()) == {"AAPL", "GOOGL"}

    def test_prices_are_positive(self):
        """GBM prices can never go negative (exp() is always positive)."""
        sim = GBMSimulator(tickers=["AAPL"])
        for _ in range(10_000):
            prices = sim.step()
            assert prices["AAPL"] > 0

    def test_unknown_ticker_gets_random_seed_price(self):
        sim = GBMSimulator(tickers=["ZZZZ"])
        price = sim.get_price("ZZZZ")
        assert 50.0 <= price <= 300.0

    def test_cholesky_rebuilds_on_add(self):
        sim = GBMSimulator(tickers=["AAPL"])
        assert sim._cholesky is None  # Only 1 ticker, no correlation matrix
        sim.add_ticker("GOOGL")
        assert sim._cholesky is not None  # Now 2 tickers, matrix exists
```

### 12.3 `SimulatorDataSource` — asyncio integration tests

`backend/tests/market/test_simulator_source.py` (10 tests), using `pytest.mark.asyncio`,
against a short `update_interval` so tests stay fast:

```python
@pytest.mark.asyncio
class TestSimulatorDataSource:

    async def test_start_populates_cache(self):
        cache = PriceCache()
        source = SimulatorDataSource(price_cache=cache, update_interval=0.1)
        await source.start(["AAPL", "GOOGL"])

        # Cache has seed prices immediately, before the first background tick
        assert cache.get("AAPL") is not None
        assert cache.get("GOOGL") is not None

        await source.stop()

    async def test_add_and_remove_ticker(self):
        cache = PriceCache()
        source = SimulatorDataSource(price_cache=cache, update_interval=0.1)
        await source.start(["AAPL"])

        await source.add_ticker("TSLA")
        assert "TSLA" in source.get_tickers()
        assert cache.get("TSLA") is not None

        await source.remove_ticker("TSLA")
        assert "TSLA" not in source.get_tickers()
        assert cache.get("TSLA") is None

        await source.stop()

    async def test_stop_is_clean(self):
        cache = PriceCache()
        source = SimulatorDataSource(price_cache=cache, update_interval=0.1)
        await source.start(["AAPL"])
        await source.stop()
        await source.stop()  # Double stop should not raise
```

### 12.4 `MassiveDataSource` — mocked, no network/API key required

`backend/tests/market/test_massive.py` (13 tests, 56% coverage of `massive_client.py` —
expected, since the real SDK call is mocked out). The pattern: mock a Massive `TickerSnapshot`
shape, patch `_fetch_snapshots`, call `_poll_once()` directly instead of running the loop:

```python
def _make_snapshot(ticker: str, price: float, timestamp_ms: int) -> MagicMock:
    snap = MagicMock()
    snap.ticker = ticker
    snap.last_trade.price = price
    snap.last_trade.timestamp = timestamp_ms
    return snap


@pytest.mark.asyncio
class TestMassiveDataSource:

    async def test_poll_updates_cache(self):
        cache = PriceCache()
        source = MassiveDataSource(api_key="test-key", price_cache=cache, poll_interval=60.0)
        source._client = MagicMock()  # tests construct/attach a fake client directly

        mock_snapshots = [
            _make_snapshot("AAPL", 190.50, 1707580800000),
            _make_snapshot("GOOGL", 175.25, 1707580800000),
        ]
        with patch.object(source, "_fetch_snapshots", return_value=mock_snapshots):
            source._tickers = ["AAPL", "GOOGL"]
            await source._poll_once()

        assert cache.get_price("AAPL") == 190.50
        assert cache.get_price("GOOGL") == 175.25

    async def test_malformed_snapshot_skipped(self):
        cache = PriceCache()
        source = MassiveDataSource(api_key="test-key", price_cache=cache, poll_interval=60.0)
        source._client = MagicMock()
        source._tickers = ["AAPL", "BAD"]

        good_snap = _make_snapshot("AAPL", 190.50, 1707580800000)
        bad_snap = MagicMock()
        bad_snap.ticker = "BAD"
        bad_snap.last_trade = None  # triggers AttributeError, caught and skipped

        with patch.object(source, "_fetch_snapshots", return_value=[good_snap, bad_snap]):
            await source._poll_once()

        assert cache.get_price("AAPL") == 190.50
        assert cache.get_price("BAD") is None

    async def test_api_error_does_not_crash(self):
        cache = PriceCache()
        source = MassiveDataSource(api_key="test-key", price_cache=cache, poll_interval=60.0)
        source._client = MagicMock()
        source._tickers = ["AAPL"]

        with patch.object(source, "_fetch_snapshots", side_effect=Exception("network error")):
            await source._poll_once()  # must not raise

        assert cache.get_price("AAPL") is None  # no update happened
```

### 12.5 `create_market_data_source` — env var branching

`backend/tests/market/test_factory.py` (7 tests), using `unittest.mock.patch.dict` on
`os.environ` so tests never depend on (or leak into) real environment state:

```python
class TestFactory:

    def test_creates_simulator_when_no_api_key(self):
        cache = PriceCache()
        with patch.dict(os.environ, {}, clear=True):
            source = create_market_data_source(cache)
        assert isinstance(source, SimulatorDataSource)

    def test_creates_simulator_when_api_key_whitespace(self):
        cache = PriceCache()
        with patch.dict(os.environ, {"MASSIVE_API_KEY": "   "}, clear=True):
            source = create_market_data_source(cache)
        assert isinstance(source, SimulatorDataSource)

    def test_creates_massive_when_api_key_set(self):
        cache = PriceCache()
        with patch.dict(os.environ, {"MASSIVE_API_KEY": "test-key"}, clear=True):
            source = create_market_data_source(cache)
        assert isinstance(source, MassiveDataSource)
```

### 12.6 `PriceUpdate` — model tests

`backend/tests/market/test_models.py` (11 tests, 100% coverage) — direction/`change`/
`change_percent` arithmetic, the `previous_price == 0` guard, `to_dict()` shape, and
immutability (`dataclasses.FrozenInstanceError` on attempted mutation).

### 12.7 What's *not* covered yet, and belongs to future work, not this subsystem

- No test exercises `main.py`'s lifespan wiring (§10) or the watchlist union rule (§11) —
  both don't exist yet. Whoever builds them should add integration tests that start a real
  `TestClient`, hit `/api/watchlist`, and assert on `PriceCache` state and
  `source.get_tickers()`, plus a regression test for the position-holds-a-removed-ticker
  case in §11.3.
- No load/concurrency test exercises `PriceCache` under many simultaneous SSE readers; not
  needed at this project's scale (§13.4 below explains why).

---

## 13. Error Handling & Edge Cases

### 13.1 Startup: empty watchlist

If the database has no tracked tickers (e.g. a fresh volume before seeding, or a user who
deleted everything), `start()` receives an empty list. Both data sources handle this
gracefully — the simulator produces no prices (`GBMSimulator.step()` returns `{}` for `n ==
0`), the Massive poller's `_poll_once()` returns immediately (`if not self._tickers: return`).
The SSE endpoint sends nothing (`if prices:` guards the yield). When a ticker is later added,
the source starts tracking it immediately per §11.

### 13.2 Price cache miss during trade

If a user (or the LLM) tries to trade a ticker with no cached price yet — just added,
Massive hasn't polled it — `price_cache.get_price(ticker)` returns `None`:

```python
price = price_cache.get_price(ticker)
if price is None:
    raise HTTPException(
        status_code=400,
        detail=f"Price not yet available for {ticker}. Please wait a moment and try again.",
    )
```

The simulator largely avoids this case by seeding the cache synchronously inside
`add_ticker()` (§6.4). Massive has a real gap — up to `poll_interval` (15s default) between
`add_ticker()` returning and the ticker's first price appearing — so a 400 with a clear
message is the correct response in Massive mode, not a silent hang.

### 13.3 Massive API key invalid or expired

If the key is set but wrong, the first poll fails with a 401. The poller logs the error and
keeps retrying every `poll_interval` — it does not crash or stop the app. The SSE endpoint
keeps streaming (connection stays open, connection-status dot can show "connected") but with
no data, since the cache is never populated. The fix is operator action: correct
`MASSIVE_API_KEY` and restart the container — nothing in this subsystem self-heals a bad key.

### 13.4 Thread safety under load

`PriceCache` uses `threading.Lock`, a plain mutex — one thread holds it at a time. Under this
project's actual load (≤10-ish tickers, 2 updates/sec from the simulator, or one write per 15s
from Massive, against however many SSE readers a single-user demo app has), lock contention
is negligible; the critical section is a dict lookup plus assignment. If this ever became a
bottleneck (hundreds of tickers, many concurrent SSE readers) the fix would be a
read-write lock, but that's unneeded optimization for this project's scale.

### 13.5 Simulator numerical stability

GBM with the tiny `dt` (~8.5e-8) produces very small per-tick moves. Floating-point precision
is not a concern because: prices are `round()`ed to 2 decimals in `GBMSimulator.step()`
itself (and again, redundantly but harmlessly, in `PriceCache.update()`); the exponential
formulation (`exp(drift + diffusion)`) is numerically stable across the tiny magnitudes
involved; and prices are always strictly positive by construction (§6.1) — there is no
"price went to zero or negative" case to guard against.

### 13.6 Background task crash isolation

Both `_run_loop()` (simulator) and `_poll_loop()`/`_poll_once()` (Massive) wrap their core
work in `try/except Exception` and log rather than propagate. This means a single bad tick or
poll — a numeric edge case, a malformed API response, a transient network error — degrades to
stale-but-present data rather than killing the background `asyncio.Task` and silently
freezing the entire price stream for the rest of the process's life. There is currently no
alerting or health-check surface for "the background task died anyway" (e.g. from a bug
outside the try/except) beyond application logs — acceptable for a course capstone, worth
knowing if this were ever hardened for production.

---

## 14. Configuration Summary

All tunable parameters and their defaults:

| Parameter | Location | Default | Description |
|-----------|----------|---------|-------------|
| `MASSIVE_API_KEY` | Environment variable | `""` (empty) | If set (non-whitespace), use Massive API; otherwise use simulator |
| `update_interval` | `SimulatorDataSource.__init__` | `0.5` (seconds) | Time between simulator ticks |
| `poll_interval` | `MassiveDataSource.__init__` | `15.0` (seconds) | Time between Massive API polls |
| `event_probability` | `GBMSimulator.__init__` | `0.001` | Chance of a random shock event per ticker per tick |
| `dt` | `GBMSimulator.__init__` | `~8.48e-8` | GBM time step (fraction of a trading year) |
| SSE check interval | `_generate_events()` | `0.5` (seconds) | How often the endpoint polls `PriceCache.version` |
| SSE retry directive | `_generate_events()` | `1000` (ms) | Browser `EventSource` reconnection delay |

### Package `__init__.py`

The public surface downstream code should import from — never reach into
`simulator.py`/`massive_client.py` directly:

```python
"""Market data subsystem for FinAlly.

Public API:
    PriceUpdate         - Immutable price snapshot dataclass
    PriceCache          - Thread-safe in-memory price store
    MarketDataSource    - Abstract interface for data providers
    create_market_data_source - Factory that selects simulator or Massive
    create_stream_router - FastAPI router factory for SSE endpoint
"""

from .cache import PriceCache
from .factory import create_market_data_source
from .interface import MarketDataSource
from .models import PriceUpdate
from .stream import create_stream_router

__all__ = [
    "PriceUpdate",
    "PriceCache",
    "MarketDataSource",
    "create_market_data_source",
    "create_stream_router",
]
```

---

## References

- `planning/PLAN.md` §§6–7, §13 — product spec and the open questions this document resolves
  against the actual build.
- `planning/MARKET_DATA_SUMMARY.md` — build/test status, coverage, code review fixes applied.
- `planning/MARKET_INTERFACE.md`, `planning/MARKET_SIMULATOR.md` — prose walkthroughs this
  document consolidates and supersedes as the single detailed reference.
- `planning/MASSIVE_API.md` — full Massive/Polygon.io API research, endpoint catalogue,
  rate limits, and the unresolved timestamp-unit caveat (§7.3 above).
- `planning/archive/MARKET_DATA_DESIGN.md` — the pre-implementation version of this document;
  kept for history. This document reflects the actual shipped code where the two differ (see
  §7.3's note on lazy imports, and §9's SSE payload/cadence corrections).
- `backend/app/market/` — the source of truth for every code block above.
- `backend/CLAUDE.md` — quick-reference for backend developers using this subsystem.
