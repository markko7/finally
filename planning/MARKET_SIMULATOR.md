# Market Simulator — Design

This documents the built-in price simulator used when `MASSIVE_API_KEY` is unset (the
default). It is implemented in `backend/app/market/simulator.py` and
`backend/app/market/seed_prices.py`, and plugs into the shared interface described in
`planning/MARKET_INTERFACE.md`. This is documentation of an existing, working
implementation, not a proposal.

## 1. Why a Simulator

PLAN.md §6: no external dependency, no API key required, runs entirely in-process. It has
to look plausible — smooth, correlated, realistic starting prices, with the occasional
dramatic move — without needing real market data. Two building blocks achieve this:
Geometric Brownian Motion (GBM) for the base price path, plus a correlation structure and
random shock events layered on top.

## 2. Geometric Brownian Motion — the Math

`GBMSimulator`'s docstring states the model directly:

```
S(t+dt) = S(t) * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z)

Where:
    S(t)   = current price
    mu     = annualized drift (expected return)
    sigma  = annualized volatility
    dt     = time step as fraction of a trading year
    Z      = correlated standard normal random variable
```

This is the standard discretized solution to the GBM stochastic differential equation
`dS = mu*S*dt + sigma*S*dW`, used because it guarantees `S(t) > 0` always (a real stock
price can drift and jump but never goes negative under this model — additive random walks
don't have that property).

### 2.1 Time step (`dt`)

```python
TRADING_SECONDS_PER_YEAR = 252 * 6.5 * 3600  # 5,896,800
DEFAULT_DT = 0.5 / TRADING_SECONDS_PER_YEAR  # ~8.48e-8
```

252 trading days/year, 6.5 trading hours/day (US market hours), 3600 seconds/hour. The
simulator ticks every 500ms wall-clock, so each tick represents `0.5` seconds of simulated
trading time expressed as a fraction of a trading year: ~8.48e-8. This tiny `dt` is what
keeps individual ticks sub-cent while still compounding into realistic-looking multi-minute
price action — it's the same math a real intraday simulation would use, just calibrated so
"one tick" means "half a second of market time," not "half a second of wall-clock time
scaled arbitrarily."

### 2.2 Per-tick update (`step()`)

```python
drift = (mu - 0.5 * sigma**2) * self._dt
diffusion = sigma * math.sqrt(self._dt) * z_correlated[i]
self._prices[ticker] *= math.exp(drift + diffusion)
```

Directly implements the formula in §2 — `drift` is the deterministic `(mu - sigma²/2)*dt`
term (the Itô correction keeping the *expected* price path centered on `mu`, since
`exp()` of a normal variable is log-normal and has an upward bias that the `-sigma²/2` term
cancels), `diffusion` is the random shock scaled by `sigma*sqrt(dt)`, and the price updates
multiplicatively via `exp()`.

### 2.3 Per-ticker parameters

`seed_prices.py` — `sigma` (annualized volatility) and `mu` (annualized drift) per ticker,
calibrated to be directionally realistic (not literal current-market values):

```python
TICKER_PARAMS: dict[str, dict[str, float]] = {
    "AAPL":  {"sigma": 0.22, "mu": 0.05},
    "GOOGL": {"sigma": 0.25, "mu": 0.05},
    "MSFT":  {"sigma": 0.20, "mu": 0.05},
    "AMZN":  {"sigma": 0.28, "mu": 0.05},
    "TSLA":  {"sigma": 0.50, "mu": 0.03},  # High volatility
    "NVDA":  {"sigma": 0.40, "mu": 0.08},  # High volatility, strong drift
    "META":  {"sigma": 0.30, "mu": 0.05},
    "JPM":   {"sigma": 0.18, "mu": 0.04},  # Low volatility (bank)
    "V":     {"sigma": 0.17, "mu": 0.04},  # Low volatility (payments)
    "NFLX":  {"sigma": 0.35, "mu": 0.05},
}
DEFAULT_PARAMS: dict[str, float] = {"sigma": 0.25, "mu": 0.05}
```

A ticker added dynamically at runtime (via watchlist add) that isn't in `TICKER_PARAMS`
falls back to `DEFAULT_PARAMS` — every ticker the simulator tracks has *some* volatility/
drift, there's no unhandled case.

## 3. Correlated Moves — Cholesky Decomposition

Real markets don't move independently: tech stocks tend to rise and fall together, finance
stocks together, and so on. The simulator reproduces this by correlating the random shocks
`Z` across tickers on every tick, rather than drawing each ticker's shock independently.

### 3.1 Correlation groups

```python
CORRELATION_GROUPS: dict[str, set[str]] = {
    "tech": {"AAPL", "GOOGL", "MSFT", "AMZN", "META", "NVDA", "NFLX"},
    "finance": {"JPM", "V"},
}

INTRA_TECH_CORR = 0.6      # Tech stocks move together
INTRA_FINANCE_CORR = 0.5   # Finance stocks move together
CROSS_GROUP_CORR = 0.3     # Between sectors / unknown tickers
TSLA_CORR = 0.3            # TSLA does its own thing
```

Pairwise correlation lookup:

```python
@staticmethod
def _pairwise_correlation(t1: str, t2: str) -> float:
    if t1 == "TSLA" or t2 == "TSLA":
        return TSLA_CORR
    if t1 in tech and t2 in tech:
        return INTRA_TECH_CORR
    if t1 in finance and t2 in finance:
        return INTRA_FINANCE_CORR
    return CROSS_GROUP_CORR
```

TSLA sits in the `tech` set but is special-cased to correlate like a cross-sector ticker
(0.3) with *everything*, including other tech names — modeling it as the idiosyncratic,
narrative-driven mover it tends to be in reality rather than tracking the broader tech
basket tightly.

### 3.2 Building and applying the correlation matrix

```python
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
```

An `n x n` symmetric correlation matrix (1s on the diagonal, pairwise `rho` off-diagonal)
is Cholesky-decomposed once whenever the ticker set changes (add/remove), not on every
tick — `step()` is the hot path (called every 500ms) and reuses the cached decomposition.
Cholesky factorization is the standard technique for turning independent normal draws into
correlated ones: if `L` is the lower-triangular Cholesky factor of correlation matrix `C`
(`C = L @ L.T`), then `L @ z_independent` produces a vector of standard normals whose
pairwise correlations match `C`.

```python
z_independent = np.random.standard_normal(n)
z_correlated = self._cholesky @ z_independent if self._cholesky is not None else z_independent
```

Every tick draws `n` fresh independent standard normals, then applies the fixed Cholesky
factor to correlate them across tickers before feeding each `z_correlated[i]` into that
ticker's GBM diffusion term (§2.2). The result: on a tick where the shared "market factor"
draws negative, tech names tend to dip together; finance names have their own weaker
tendency to move together; TSLA and other cross-group pairs move more independently.

Rebuilding is `O(n²)` for matrix construction plus `O(n³)` for Cholesky — acceptable
because `n` (tracked tickers) stays well under 50 in this project's use case (comment in
code: `"O(n^2) but n < 50"`), and it only happens on ticker add/remove, not per tick.

## 4. Random Shock Events

Beyond smooth correlated GBM drift, the simulator injects occasional discrete jumps to
produce visually dramatic moves — something a pure GBM path rarely does within a short
demo window:

```python
if random.random() < self._event_prob:  # default 0.001 (0.1%) per ticker per tick
    shock_magnitude = random.uniform(0.02, 0.05)  # 2-5%
    shock_sign = random.choice([-1, 1])
    self._prices[ticker] *= 1 + shock_magnitude * shock_sign
```

Checked independently for every ticker on every tick, after the GBM update has already been
applied. At the default `event_probability=0.001` with 10 tickers ticking twice a second
(500ms interval), the expected event rate is `10 * 0.001 * 2 = 0.02` events/second, i.e.
roughly one shock event somewhere in the watchlist every ~50 seconds — frequent enough to
be visible during a live demo session, rare enough not to dominate normal price action.
Direction (up/down) and magnitude (uniformly 2-5%) are both randomized independently per
event.

## 5. Seed Prices

`seed_prices.py`:

```python
SEED_PRICES: dict[str, float] = {
    "AAPL": 190.00, "GOOGL": 175.00, "MSFT": 420.00, "AMZN": 185.00,
    "TSLA": 250.00, "NVDA": 800.00, "META": 500.00, "JPM": 195.00,
    "V": 280.00, "NFLX": 600.00,
}
```

Directionally realistic starting prices for the ten default watchlist tickers (per PLAN.md
§7's seed data), chosen "as of project creation" (per the module's own comment) rather than
pinned to any live feed — the simulator has no dependency on real market data, including at
startup. A ticker not in `SEED_PRICES` (dynamically added later) starts at
`random.uniform(50.0, 300.0)` — an arbitrary but plausible single-stock price range.

## 6. Code Structure

`GBMSimulator` — pure simulation state machine, no I/O, no asyncio:

```python
class GBMSimulator:
    def __init__(self, tickers, dt=DEFAULT_DT, event_probability=0.001) -> None: ...
    def step(self) -> dict[str, float]: ...       # advance all tickers one tick
    def add_ticker(self, ticker: str) -> None: ... # rebuilds Cholesky
    def remove_ticker(self, ticker: str) -> None: ... # rebuilds Cholesky
    def get_price(self, ticker: str) -> float | None: ...
    def get_tickers(self) -> list[str]: ...
```

`SimulatorDataSource(MarketDataSource)` — the async adapter that wraps `GBMSimulator` to
satisfy the shared interface (`planning/MARKET_INTERFACE.md` §3) and drives it on a
background asyncio task:

```python
async def start(self, tickers: list[str]) -> None:
    self._sim = GBMSimulator(tickers=tickers, event_probability=self._event_prob)
    for ticker in tickers:                       # seed cache immediately, no blank frame
        price = self._sim.get_price(ticker)
        if price is not None:
            self._cache.update(ticker=ticker, price=price)
    self._task = asyncio.create_task(self._run_loop(), name="simulator-loop")

async def _run_loop(self) -> None:
    while True:
        try:
            if self._sim:
                for ticker, price in self._sim.step().items():
                    self._cache.update(ticker=ticker, price=price)
        except Exception:
            logger.exception("Simulator step failed")
        await asyncio.sleep(self._interval)  # default 0.5s
```

The separation matters: `GBMSimulator` is trivially unit-testable (call `step()`
repeatedly, assert on the returned dict, no event loop needed), while
`SimulatorDataSource` is the thin, mostly-untested-by-unit-tests glue that fits it into the
asyncio/`MarketDataSource` world. A step failure is caught and logged without killing the
background loop — one bad tick (e.g. a numeric edge case) doesn't take down price streaming
for the rest of the session.

## 7. Parameters Summary

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
