# PLAN.md Review - 2026-09-15

Reviewed `planning/PLAN.md` against the current repository state. The market data backend exists and is tested; the FastAPI app shell, database layer, portfolio routes, chat routes, frontend, Docker packaging, and E2E harness are not present yet.

The plan is strong on product vision and high-level architecture. The main risk is that it is still too ambiguous as an implementation contract for parallel agents: several places allow frontend, backend, and test work to make different assumptions.

## Findings

### 1. Blocker: no owner or contract for the FastAPI application shell

`backend/app/market/stream.py` exposes `create_stream_router()`, but there is no `backend/app/main.py` yet and the plan does not assign who wires the app together. The missing shell needs to own:

- Creating the shared `PriceCache`
- Initializing and seeding SQLite
- Reading the startup watchlist
- Starting and stopping the market data source in lifespan hooks
- Mounting API routers
- Serving the static Next.js export
- Ensuring `/api/*` routes are not swallowed by static file serving

Recommendation: add `backend/app/main.py` and the static output directory to the directory structure, and make the Backend agent responsible for this before portfolio/chat/frontend integration work begins.

### 2. Blocker: lazy database initialization conflicts with market startup

Section 7 says the DB initializes "on startup (or first request)." The market source needs the seeded watchlist at startup so it can call `source.start(tickers)` and seed the price cache. If DB creation waits until first request, startup has no reliable ticker list.

Recommendation: remove the "or first request" option. Initialize and seed the database in the FastAPI lifespan startup handler, then start market data from the watchlist plus any held-position tickers.

### 3. Blocker: API request/response shapes are underspecified

Section 8 lists endpoints, but not concrete JSON bodies, response fields, or error semantics. This will cause frontend, backend, and E2E tests to drift.

Add exact contracts for:

- `GET /api/portfolio`: cash, positions, latest prices, total value, unrealized P&L
- `POST /api/portfolio/trade`: request body, fill price source, success body, and validation failures
- `GET /api/portfolio/history`: item shape, ordering, and bounds
- `GET/POST/DELETE /api/watchlist`: success shape, duplicate handling, invalid ticker handling
- `POST /api/chat`: request shape, response shape, executed actions, failed actions
- Error body and status codes for insufficient cash, insufficient shares, unknown ticker, invalid quantity, malformed input, and missing price

Recommendation: define one common error shape, for example `{"error": "insufficient_cash", "detail": "..."}`, and use it consistently.

### 4. Blocker: chat and trade history are write-only

The schema stores `chat_messages` and `trades`, but Section 8 exposes no endpoint to read either. After a refresh, the frontend cannot reload the chat panel even though messages are persisted. Trade history is similarly recorded but unavailable.

Recommendation: add `GET /api/chat/history`. Either add `GET /api/portfolio/trades` or explicitly state that `trades` is a v1 audit log with no read endpoint.

### 5. High: "daily change %" is not supported by available data

The watchlist asks for daily change %, but `PriceUpdate.change_percent` is tick-over-tick, calculated against `previous_price`. The simulator has no session open or previous close. Rendering the existing field as daily change would be misleading and mostly show tiny near-zero values.

Recommendation: rename the UI requirement to "change since session start" and store the first price seen per ticker, or add an `open_price` / `change_from_open_percent` concept to the backend.

### 6. High: removing a watched ticker can break portfolio valuation

Section 13 already raises this, and the existing simulator confirms the risk: `SimulatorDataSource.remove_ticker()` removes the ticker from `PriceCache`. If the user removes a ticker from the watchlist while still holding a position, the app loses the price needed for P&L and trade fills.

Recommendation: define the tracked ticker set as `watchlist union tickers with non-zero positions`. `DELETE /api/watchlist/{ticker}` should remove only the display watchlist row when a position still exists, and should call `source.remove_ticker()` only when the ticker is neither watched nor held.

### 7. High: SSE contract in the plan does not match the implementation

The plan implies each SSE event contains one ticker update. The implemented endpoint emits one snapshot object keyed by ticker:

```text
data: {"AAPL": {"ticker": "AAPL", "price": 190.5, "previous_price": 190.48, "timestamp": 1757894400.12, "change": 0.02, "change_percent": 0.0105, "direction": "up"}, ...}
```

The stream checks the cache version every 500ms and emits only when the version changes. Because each emitted event includes all current prices, the frontend still needs to diff each ticker against its last rendered value before flashing or appending sparkline points.

Recommendation: paste the actual SSE payload into Section 6 and state clearly that it is a full snapshot emitted on cache changes, not one event per ticker.

### 8. Medium: timestamp and money precision policies are unstated

SSE timestamps are Unix epoch floats, while DB timestamps are described as ISO strings. Prices are rounded to 2 decimals in `PriceCache`, but cash balances and average costs have no rounding policy. Fractional trades can otherwise produce ugly floating point balances and brittle tests.

Recommendation:

- State that SSE uses Unix epoch seconds and REST/DB timestamps use ISO 8601 UTC.
- Round persisted cash balances to 2 decimals.
- Define whether `avg_cost` is stored as full precision or rounded for display only.

### 9. Medium: trading math needs a precise spec

The plan says `avg_cost` exists but does not define how it changes. It also does not state whether shorting is allowed, whether `quantity` must be positive, or what happens when a sell reaches zero.

Recommendation: add:

```text
Buy avg_cost = (old_avg_cost * old_qty + fill_price * buy_qty) / (old_qty + buy_qty).
Sells leave avg_cost unchanged.
Selling the full position deletes the row.
Shorting is not allowed.
Quantity must be > 0 and is measured in shares; fractional shares are allowed.
```

### 10. Medium: LLM mock mode is too vague for E2E tests

`LLM_MOCK=true` is described as deterministic, but the deterministic behavior is not specified. E2E tests and backend implementation could easily choose different scripts.

Recommendation: define a simple rule. For example: parse "buy"/"sell" plus ticker and number into one trade, parse "add"/"remove" plus ticker into one watchlist change, and return a fixed analysis message with empty arrays for everything else.

### 11. Medium: ticker validation policy is missing

The plan allows manual and LLM watchlist changes, but does not define valid tickers. In simulator mode, unknown symbols can be assigned random prices; in Massive mode, unknown symbols may never produce usable prices.

Recommendation: choose one policy:

- Demo-friendly: accept any uppercase 1-5 letter ticker and document that simulator mode fabricates prices for unknown symbols.
- Strict: accept only seeded simulator tickers unless real market data confirms the ticker.

Whichever rule is chosen should apply to manual watchlist edits, LLM watchlist edits, and trades.

### 12. Medium: persisted snapshot growth is unbounded

`portfolio_snapshots` records every 30 seconds and after every trade, but `/api/portfolio/history` has no `limit` or `since` parameter. A persistent Docker volume can accumulate a lot of rows over repeated demos.

Recommendation: add `?limit=500` by default, optionally support `since`, and require the frontend to plot real timestamps because container downtime creates gaps.

### 13. Low: Section 13 should not remain inside the primary plan

The plan now contains open review questions in Section 13. If agents use `PLAN.md` as the shared contract, unresolved questions encourage each agent to resolve ambiguity privately.

Recommendation: fold resolved decisions into the relevant sections and then move or delete Section 13.

## Simplification Opportunities

- Move the optional Terraform/App Runner note out of `PLAN.md` until cloud deployment is actually in scope.
- Allow local Playwright runs against `npm run dev` plus local `uvicorn`, reserving Docker Compose for CI/final verification.
- Add a reset path for demos. The cheapest version is documenting `docker volume rm finally-data`; a nicer version is `POST /api/portfolio/reset`.
- Consider dropping the SSE reconnection E2E test unless the plan specifies a concrete mechanism for simulating disconnects.

## Suggested Plan Edits

1. Add `backend/app/main.py` and static export serving to the architecture/directory sections.
2. Make DB initialization a startup requirement, not a first-request option.
3. Define the tracked ticker set as `watchlist union held positions`.
4. Replace the SSE description with the actual full-snapshot payload and emit semantics.
5. Add exact JSON contracts and error shapes for every REST endpoint.
6. Add chat history and either trade history retrieval or an explicit audit-log-only note.
7. Resolve "daily change %" by defining session-start change or adding open/previous-close data.
8. Add trade math, rounding, timestamp, ticker validation, and LLM mock rules.
9. Move optional cloud deployment and unresolved review notes out of the main contract.

Evidence read: `planning/PLAN.md`, `planning/MARKET_DATA_SUMMARY.md`, `backend/app/market/stream.py`, `backend/app/market/models.py`, `backend/app/market/cache.py`, `backend/app/market/simulator.py`, `backend/README.md`, and `README.md`.
