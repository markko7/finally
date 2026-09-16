# PLAN.md Review — 2026-09-15

Reviewed `planning/PLAN.md` against the code that actually exists (`backend/app/market/` complete; no `main.py`, no db module, no frontend, no Docker). Findings ordered by damage-if-ignored. The plan is strong on vision, scope boundaries and rationale; the gaps are all about the *contract* between agents — places where two agents reading the same sentence build incompatible things.

---

## 1. Blocking — resolve before the next build phase

### 1.1 No owner for the FastAPI application itself
`backend/app/` contains `market/` and nothing else. `create_stream_router()` exists but nothing mounts it. The plan never says who builds `backend/app/main.py`, the lifespan wiring (create `PriceCache`, `create_market_data_source(cache)`, `await source.start(tickers)` from the DB watchlist, `await source.stop()`), static file mounting for the Next.js export, or route precedence vs `/api/*`. §4's tree omits both `backend/app/main.py` and the `static/` directory §11's Dockerfile copies into. Assign this explicitly (Backend agent, before portfolio/chat work).

### 1.2 Startup ordering contradicts lazy DB init
§7 says the DB initializes "on startup (or first request)". The market source needs the watchlist at startup for `source.start(tickers)`. If DB init defers to first request, there is no ticker list at startup. Delete the "or first request" option: init and seed in the lifespan startup handler, read watchlist, start market source.

### 1.3 API contract has no request/response shapes
§8 is paths plus prose, yet frontend and backend agents work in parallel against it. Every endpoint needs concrete JSON: `GET /api/portfolio` field names (`unrealized_pnl`, `total_value`, `cash_balance`), `POST /api/portfolio/trade` request and success body (does it return the fill price? updated portfolio?), `GET /api/portfolio/history` item shape, `POST /api/chat` request/response including per-action failure reporting. Error semantics are entirely unspecified — status code and body for insufficient cash, insufficient shares, unknown ticker, quantity <= 0. Pick one shape (e.g. `400` + `{"error": "insufficient_cash", "detail": "..."}`) and state it once.

### 1.4 Chat history is written but never readable
§7 defines `chat_messages` and §9 step 7 stores every message, but §8 exposes only `POST /api/chat`. The frontend cannot load the conversation on page load — after a refresh the panel is empty while history sits in SQLite. Add `GET /api/chat/history` (or have POST return the thread). The `trades` table has the same problem: written on every fill, never read by any endpoint. Either add `GET /api/portfolio/trades` or state in §7 that it is an append-only audit log with no v1 read path.

### 1.5 "Daily change %" is not derivable from any data the system holds
§2 and §10 both ask the watchlist to show "daily change %". The only percentage available is `PriceUpdate.change_percent`, which is tick-over-tick (`backend/app/market/models.py:24-28`) — the change since the last 500ms tick, typically thousandths of a percent. Nothing stores a daily open or previous close; the simulator starts from a seed price with no session concept. Options: (1) redefine as "change since session start", computed frontend-side from the first price seen over SSE (consistent with sparklines, which are already "since page load"); or (2) add `open_price` to `PriceCache` on first update and expose `change_from_open_percent` in the SSE payload. Leaving it as "daily change %" is not viable — the obvious implementation renders a column of `0.00%`.

### 1.6 Removing a watched ticker destroys the price for any position you hold in it
§13 item 1 raised this as a question; the code confirms it is a real defect. `SimulatorDataSource.remove_ticker()` (`backend/app/market/simulator.py:251-255`) calls `self._cache.remove(ticker)`, so after `DELETE /api/watchlist/AAPL` the cache has no AAPL price: portfolio valuation gets `None`, P&L breaks, and there is no UI path to sell. Record the decision in §6/§8: the tracked ticker set is **`watchlist ∪ tickers with a non-zero position`**. `DELETE /api/watchlist/{ticker}` removes the display row only; it calls `source.remove_ticker()` only when no position is held. Same rule builds the startup ticker list.

---

## 2. Spec vs. built code — mismatches to correct in the plan

### 2.1 SSE payload shape is wrong in §6
§6 says "Each SSE event contains ticker, price, previous price, timestamp, and change direction", implying one event per ticker. The built endpoint emits a map of every tracked ticker in a single event (`backend/app/market/stream.py:81-83`):
```
data: {"AAPL": {"ticker": "AAPL", "price": 190.5, "previous_price": 190.48,
                "timestamp": 1757894400.12, "change": 0.02,
                "change_percent": 0.0105, "direction": "up"}, ...}
```
`change_percent` is present and unmentioned in the plan. §6 should paste the actual payload verbatim as the contract. This matters: the frontend receives full snapshots, not per-ticker deltas.

### 2.2 SSE cadence description is wrong in §6
§13 item 2 flagged this and §6 is still uncorrected. The stream is version-gated (`stream.py:75-84`): it polls `price_cache.version` every 500ms and emits only on change. Corollary for §10: because one event carries all tickers, a ticker whose price did not move still appears with an unchanged value, so the frontend **does** need to diff against the last rendered price before flashing. This is the opposite of §13's "no de-dupe needed" simplification note, which assumed per-ticker change-only events — that note is wrong as written and should be replaced.

### 2.3 Timestamp units differ across the boundary
SSE/`PriceUpdate.timestamp` is a Unix epoch float (`models.py:16`); every DB column in §7 is ISO 8601. Both fine, but state it ("SSE uses epoch seconds; REST responses and DB columns use ISO 8601 UTC") so the frontend doesn't build one parser and meet two formats.

### 2.4 There is no ticker validation anywhere
§2 and §9 let the user or the LLM add arbitrary tickers (§9's example adds PYPL). In simulator mode an unknown ticker gets a **random price between $50 and $300** — `backend/app/market/simulator.py:151`: `self._prices[ticker] = SEED_PRICES.get(ticker, random.uniform(50.0, 300.0))`. So `POST /api/watchlist {"ticker": "ZZZZ"}` succeeds and invents a stock; in Massive mode the same call silently never ticks. Decide and record: accept any 1-5 char uppercase symbol (documenting the fabrication on purpose), or validate against `SEED_PRICES` in simulator mode and reject clearly. The LLM prompt needs the same rule.

---

## 3. Smaller issues

- **3.1 Average cost formula** (§13 item 8 — agreed): one line in §7 settles it — `avg_cost = (avg_cost*qty + fill_price*buy_qty) / (qty + buy_qty)` on buys, unchanged on sells, row deleted at zero quantity. Also state no shorting (sells capped at shares held) and quantity > 0.
- **3.2 Money rounding policy**: `PriceCache` rounds prices to 2dp, but cash and `avg_cost` have no stated policy. Fractional trades will drift `cash_balance` to `9999.999999999998`, which will surface in the header and break E2E assertions. State: round cash to 2dp on write.
- **3.3 Fill price source** (§13 item 6 — agreed): state in §8 that fills use `price_cache.get_price(ticker)` at request-handling time, and reject if it returns `None` (which also cleanly handles unknown tickers).
- **3.4 Portfolio snapshots grow unbounded**: 30s forever is ~2,880 rows/day in a persistent volume, and `/api/portfolio/history` has no bounds. Add `?limit` (default ~500, newest first) or `since`. Also note snapshots gap whenever the container is stopped, so the chart must plot real timestamps, not assume even spacing.
- **3.5 Header total value** (§13 item 10 — agreed): "computed client-side from SSE prices against positions from the last `/api/portfolio` fetch; re-fetch only after a trade or chat action."
- **3.6 `LLM_MOCK` behaviour** (§13 item 5 — genuinely blocks the E2E suite): suggest keyword matching on the user message — "buy"/"sell" + ticker + number returns a canned message plus that trade; "add"/"remove" + ticker returns the matching watchlist change; anything else returns a fixed analysis string with empty arrays. Write the rule into §9 so mock and tests are built from the same sentence.
- **3.7 Remaining §13 items, recommendation each**: item 3 — shares only, fractional allowed, LLM converts dollar requests using live prices in its context; item 4 — enum is `"add"`/`"remove"` only, removing a held ticker follows 1.6; item 7 — cash/shares validation is the only guardrail, say so explicitly and add "never propose an order larger than available cash" to the system prompt; item 9 — agreed, one line in §6.
- **3.8 Minor code note**: `stream.py:17` defines `router` at module scope and `create_stream_router()` decorates onto it, so calling the factory twice registers `/prices` twice. Harmless with one call from `main.py`, but a test building two apps will hit it. Note for whoever writes `main.py`; not a plan change.

---

## 4. Simplifications

- **Move §13 out of PLAN.md entirely.** `CLAUDE.md` injects PLAN.md in full into every agent's context, so ten unresolved open questions inside the shared contract means every agent reads the ambiguity and resolves it privately and differently. Fold decisions into §§6-10 and delete §13.
- **Drop the Terraform/App Runner paragraph** (§11) — explicitly out of scope; delete or move to `planning/stretch-goals.md`.
- **Allow non-Docker E2E runs locally** (§12): permit Playwright against `npm run dev` + `uv run uvicorn`, reserving `docker-compose.test.yml` for CI and final verification. A full image rebuild per loop will dominate frontend iteration time.
- **Drop "SSE resilience: disconnect and verify reconnection"** from the E2E list or specify the mechanism (CDP offline emulation). The `retry: 1000` directive at `stream.py:62` is browser-native; low value for the effort.
- **Add a reset path.** The volume persists, so a student who trades away their $10k cannot get a clean demo. Document `docker volume rm finally-data` in §11 (cheapest) or add `POST /api/portfolio/reset`.

---

## 5. Suggested edit list (concrete, in plan order)

1. §4 — add `backend/app/main.py` and `backend/app/static/` to the tree.
2. §6 — replace the SSE bullet with the verbatim payload from `stream.py`; state "emits on change"; define the tracked set as `watchlist ∪ held positions`; add "Massive = Polygon.io via the `massive` package"; state epoch-vs-ISO conventions.
3. §7 — replace "on startup (or first request)" with "in the lifespan startup handler"; add the `avg_cost` formula, no-shorting rule, cash rounding policy.
4. §8 — add request/response JSON for every endpoint; add error shape and status codes; add `GET /api/chat/history`; add `limit`/`since` to `/api/portfolio/history`; state fills use the server-side cache price.
5. §9 — specify quantity units (shares), the `action` enum, the "cash validation is the only guardrail" decision, and the concrete `LLM_MOCK` rule.
6. §10 — resolve "daily change %" (see 1.5); state header recomputes client-side from SSE; state the frontend must diff full snapshots to drive the flash animation.
7. §11 — delete Optional Cloud Deployment; document the volume reset command.
8. §12 — permit local non-Docker Playwright runs; drop or specify the SSE reconnection scenario.
9. Delete §13 once its items are folded in.

---

Files read as evidence: `planning/PLAN.md`, `planning/MARKET_DATA_SUMMARY.md`, `backend/app/market/stream.py`, `models.py`, `cache.py`, `simulator.py`, `seed_prices.py`, `factory.py`.
