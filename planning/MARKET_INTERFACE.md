# Market Data Interface — Design

This documents the unified Python interface this project uses to retrieve stock prices,
regardless of whether the underlying source is the Massive API or the in-process simulator.
It reflects the actual implementation in `backend/app/market/`, not a proposal — see
`planning/MARKET_DATA_SUMMARY.md` for the build status and `planning/MASSIVE_API.md` for the
external API this interface wraps.

## 1. Goal

PLAN.md §6 requires: "Both the simulator and the Massive client implement the same abstract
interface... All downstream code (SSE streaming, price cache, frontend) is agnostic to the
source." Concretely, that means:

- One env-var switch (`MASSIVE_API_KEY`) selects real vs. simulated data at startup.
- Every consumer of prices — the SSE endpoint, portfolio valuation, trade execution — reads
  from one shared object and never needs to know or care which source is active.
- Tests can substitute the simulator for the real API with zero code changes elsewhere.

## 2. The Four Pieces

```
MarketDataSource (ABC)              interface.py
├── SimulatorDataSource              simulator.py    — GBM, no external dependency
└── MassiveDataSource                massive_client.py — polls Massive REST API
        │
        ▼  writes
   PriceCache                        cache.py         — shared, thread-safe state
        │
        ▼  reads
   SSE stream router                 stream.py        — /api/stream/prices
   (+ future: portfolio valuation, trade execution)
```

`create_market_data_source()` in `factory.py` is the only place that knows about the env
var and picks a concrete class. Everything downstream of that call only ever sees the
`MarketDataSource` ABC or the `PriceCache`.

## 3. The Abstract Interface

`backend/app/market/interface.py`:

```python
class MarketDataSource(ABC):
    """Contract for market data providers.

    Implementations push price updates into a shared PriceCache on their own
    schedule. Downstream code never calls the data source directly for prices —
    it reads from the cache.
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
        """Add a ticker to the active set. No-op if already present."""

    @abstractmethod
    async def remove_ticker(self, ticker: str) -> None:
        """Remove a ticker from the active set. No-op if not present.

        Also removes the ticker from the PriceCache.
        """

    @abstractmethod
    def get_tickers(self) -> list[str]:
        """Return the current list of actively tracked tickers."""
```

Five methods, all present-tense imperative, no return value carrying price data — prices
never come back from these calls. That's deliberate: the interface is about *lifecycle and
membership* (what tickers are being tracked, when tracking starts/stops), not about *data
retrieval*. Data retrieval is the cache's job (§4). This keeps the ABC narrow: an
implementation only has to answer "which tickers, and are you running," not "give me a
price" in twelve different shapes.

Lifecycle contract, from the docstring:

```python
source = create_market_data_source(cache)
await source.start(["AAPL", "GOOGL", ...])
# ... app runs ...
await source.add_ticker("TSLA")
await source.remove_ticker("GOOGL")
# ... app shutting down ...
await source.stop()
```

`start()` is called once; `stop()` is idempotent (safe to call more than once, e.g. from
both a signal handler and a normal shutdown path).

## 4. PriceCache — the Single Source of Truth

`backend/app/market/cache.py`. Thread-safe (protected by a `threading.Lock`, not an asyncio
lock — see §6) in-memory dict of `ticker -> PriceUpdate`, plus a monotonic version counter:

```python
class PriceCache:
    def __init__(self) -> None:
        self._prices: dict[str, PriceUpdate] = {}
        self._lock = Lock()
        self._version: int = 0

    def update(self, ticker: str, price: float, timestamp: float | None = None) -> PriceUpdate:
        with self._lock:
            ts = timestamp or time.time()
            prev = self._prices.get(ticker)
            previous_price = prev.price if prev else price
            update = PriceUpdate(
                ticker=ticker, price=round(price, 2),
                previous_price=round(previous_price, 2), timestamp=ts,
            )
            self._prices[ticker] = update
            self._version += 1
            return update

    def get(self, ticker: str) -> PriceUpdate | None: ...
    def get_all(self) -> dict[str, PriceUpdate]: ...       # shallow copy, safe to iterate
    def get_price(self, ticker: str) -> float | None: ...  # convenience: just the float
    def remove(self, ticker: str) -> None: ...

    @property
    def version(self) -> int: ...  # bumped on every update() call
```

Key properties:

- **Writers are exclusive.** Exactly one `MarketDataSource` implementation is active at a
  time (picked once at startup by the factory), so there's never write contention between
  a simulator and a real feed — the lock exists for safe concurrent *reads* during a write,
  not to arbitrate between multiple producers.
- **`version` enables cheap change detection.** Every `update()` call increments it. The
  SSE endpoint (§5) polls `version` instead of diffing price dicts — an O(1) integer
  comparison instead of an O(n) dict comparison, every 500ms, for as many connected
  clients as there are.
- **First update seeds `previous_price` with itself.** A ticker's very first `PriceUpdate`
  has `previous_price == price`, so `direction` (see `models.py`) comes out `"flat"` rather
  than spuriously `"up"` or `"down"` on the initial tick.
- **Prices are rounded to 2 decimal places on write**, once, in the cache — not
  independently by each data source. Both `SimulatorDataSource` and `MassiveDataSource`
  hand raw floats to `cache.update()`; rounding happens in exactly one place.

## 5. Factory — Where the Env Var Is Read

`backend/app/market/factory.py`, in full:

```python
def create_market_data_source(price_cache: PriceCache) -> MarketDataSource:
    """Create the appropriate market data source based on environment variables.

    - MASSIVE_API_KEY set and non-empty -> MassiveDataSource (real market data)
    - Otherwise -> SimulatorDataSource (GBM simulation)

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

This is the *only* function in the codebase that branches on `MASSIVE_API_KEY`. Everything
else — app startup, the SSE router, tests — depends only on the `MarketDataSource` ABC and
`PriceCache`. `.strip()` on the env var means a key set to whitespace-only is treated as
absent, falling back to the simulator rather than constructing a `MassiveDataSource` with a
blank key that would fail on first request.

Typical startup wiring (app lifespan):

```python
cache = PriceCache()
source = create_market_data_source(cache)
await source.start(DEFAULT_TICKERS)
```

## 6. The Two Implementations

Both implement the five-method ABC identically in shape; they differ in what happens
inside `start()`/`stop()` and how the background task produces prices.

| | `SimulatorDataSource` | `MassiveDataSource` |
|---|---|---|
| Background task | `asyncio.create_task` running a 500ms loop | `asyncio.create_task` running a 15s poll loop |
| Data origin | `GBMSimulator.step()` (see `MARKET_SIMULATOR.md`) | Massive REST snapshot endpoint, one call for all tickers |
| Blocking I/O | None — pure CPU/numpy | Yes — `massive.RESTClient` is synchronous, wrapped in `asyncio.to_thread` |
| Failure mode | Exception in one step is caught and logged; loop continues | Exception in one poll is caught and logged; loop continues, retries next interval |
| `add_ticker` | Adds to simulator, immediately seeds cache with a synthesized price, rebuilds Cholesky correlation matrix | Appends to tracked list; ticker gets a real price on the *next* poll cycle (no synthetic value in between) |
| `remove_ticker` | Removes from simulator, rebuilds correlation matrix, removes from cache | Removes from tracked list, removes from cache |

Both share the pattern of an immediate first update in `start()` so the cache is non-empty
before the first background tick — `SimulatorDataSource` seeds every ticker synchronously;
`MassiveDataSource` does an eager `await self._poll_once()` before spawning the loop task
(`massive_client.py:46`).

The Massive implementation ties directly to the API researched in `MASSIVE_API.md` §4.1 —
`get_snapshot_all(market_type=SnapshotMarketType.STOCKS, tickers=self._tickers)`, one call
per poll, reading `snap.last_trade.price` and `snap.last_trade.timestamp` off each returned
`TickerSnapshot`.

## 7. `PriceUpdate` — the Value Type Both Sides Agree On

`backend/app/market/models.py`. An immutable, slotted dataclass — both data sources produce
these (indirectly, via `PriceCache.update()`), and every consumer reads them:

```python
@dataclass(frozen=True, slots=True)
class PriceUpdate:
    ticker: str
    price: float
    previous_price: float
    timestamp: float = field(default_factory=time.time)

    @property
    def change(self) -> float: ...          # price - previous_price
    @property
    def change_percent(self) -> float: ...  # % form, 0.0 if previous_price == 0
    @property
    def direction(self) -> str: ...          # "up" / "down" / "flat"

    def to_dict(self) -> dict: ...  # JSON-serializable, used directly for SSE payloads
```

`frozen=True, slots=True` means: no consumer can mutate a cached update in place (a
`PriceUpdate` handed to an SSE generator can't be corrupted by another coroutine before
it's serialized), and no per-instance `__dict__` overhead — relevant since these are
allocated on every tick for every ticker.

## 8. How SSE Streaming Consumes This (Fully Source-Agnostic)

`backend/app/market/stream.py`. The router is built via a factory that closes over the
`PriceCache` — not a global — so it has zero dependency on which `MarketDataSource` is
feeding that cache:

```python
def create_stream_router(price_cache: PriceCache) -> APIRouter:
    @router.get("/prices")
    async def stream_prices(request: Request) -> StreamingResponse:
        return StreamingResponse(
            _generate_events(price_cache, request),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        )
    return router
```

The generator polls `price_cache.version` every 500ms and only serializes+sends when it has
changed since the last check:

```python
current_version = price_cache.version
if current_version != last_version:
    last_version = current_version
    prices = price_cache.get_all()
    if prices:
        yield f"data: {json.dumps({t: u.to_dict() for t, u in prices.items()})}\n\n"
await asyncio.sleep(interval)
```

This is why PLAN.md §6's description of the SSE cadence needed a correction (see
`PLAN.md` §13 doc review note 2): the server does not blindly broadcast every 500ms
regardless of change — it broadcasts on a 500ms *check* cadence but only *sends* when
`version` moved. Against a simulator ticking every 500ms this is nearly the same thing;
against a Massive poller updating every 15s, most of those 500ms checks are no-ops that
send nothing, which is the correct and bandwidth-efficient behavior for a slower real-data
source using the identical SSE code path.

## 9. Why This Design

- **Strategy pattern.** `MarketDataSource` is the strategy interface;
  `SimulatorDataSource`/`MassiveDataSource` are interchangeable strategies selected once at
  startup. Adding a third source later (e.g., a different vendor, or a websocket-based
  Massive variant) means writing one new class against the existing ABC — no changes to
  `cache.py`, `stream.py`, or any future portfolio/trade code that reads the cache.
- **Testability.** Tests exercise `SimulatorDataSource` (deterministic-enough, no network,
  no API key) as a stand-in for real market behavior, and can construct a `PriceCache`
  directly and call `.update()` to simulate either source without touching either
  implementation. `backend/tests/market/` (73 tests) does exactly this — see
  `MARKET_DATA_SUMMARY.md`.
- **Single point of truth avoids fan-out coupling.** Without `PriceCache` as an
  intermediary, the SSE endpoint (and eventually portfolio valuation, trade execution)
  would each need to know how to pull a price from *either* a simulator object or a Massive
  client object, doubling every call site's branching logic. Producers write, consumers
  read; the cache is the only thing both sides depend on.
- **Env-var selection, not config-file or runtime toggle.** Matches PLAN.md §5's
  environment-variable-driven design — `MASSIVE_API_KEY` presence is the single switch,
  decided once at process startup, consistent with this being a single-user, single-process
  app with no need for runtime source-switching.
- **Async lifecycle matches FastAPI's own lifespan model.** `start()`/`stop()` are
  coroutines so they can be awaited directly from a FastAPI `lifespan` context manager
  alongside other async startup/shutdown work, with no thread or event-loop bridging
  needed at the call site (the bridging that *is* needed, for Massive's synchronous REST
  client, is contained entirely inside `MassiveDataSource` via `asyncio.to_thread` — it
  doesn't leak out to the interface).

This satisfies PLAN.md §6's requirement directly: SSE streaming, and any future portfolio
valuation or trade-execution code, read `PriceCache.get_price(ticker)` /
`PriceCache.get_all()` and never import `SimulatorDataSource` or `MassiveDataSource` at
all.
