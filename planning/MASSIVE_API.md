# Massive API — Research Notes

Research date: 2026-09-16. Sources cited inline; anything not directly verified from an
official source is flagged rather than guessed.

## 1. What Massive Is

Massive (massive.com) is the rebrand of Polygon.io — the company renamed on 2025-10-30.
[[Polygon.io is Now Massive](https://massive.com/blog/polygon-is-now-massive)] It is the
same market-data platform, same underlying REST/WebSocket API surface, same accounts and
API keys. The Python client package was renamed from `polygon-api-client` to `massive` on
PyPI. Per the official client README:

> "Existing API keys, accounts, and integrations continue to work exactly as before, with
> the SDK now defaulting to `api.massive.com`, while `api.polygon.io` remains supported for
> an extended period."
> [[massive-com/client-python README](https://github.com/massive-com/client-python/blob/master/README.md)]

So: Massive = Polygon.io, renamed. `pip install massive` replaces `pip install
polygon-api-client`. Old Polygon.io documentation and blog posts are still largely accurate
for the underlying REST endpoints; new docs live at massive.com/docs.

This project already depends on `massive>=1.0.0` in `backend/pyproject.toml`; the locked
version is **2.2.0** (`backend/uv.lock`).

## 2. Installation and Authentication

```bash
uv add massive   # this project already has it; for reference elsewhere: pip install -U massive
```

Requires Python 3.9+. Get an API key from the Massive dashboard
(massive.com/dashboard/api-keys), then:

```python
from massive import RESTClient

client = RESTClient(api_key="<API_KEY>")
```

The key can also be supplied via the `POLYGON_API_KEY` or (per the rebrand) `MASSIVE_API_KEY`
environment variable in some SDK versions — this project does not rely on that; it passes
`api_key` explicitly (see `backend/app/market/massive_client.py`), which is the documented
and unambiguous approach.

Auth on raw REST calls (if bypassing the SDK) is via an `apiKey` query parameter or an
`Authorization: Bearer <API_KEY>` header.

## 3. Key Endpoints

| Purpose | Method + Path | Multi-ticker in one call? |
|---|---|---|
| Snapshot (last trade/quote/day OHLC) for one or more named tickers | `GET /v2/snapshot/locale/us/markets/stocks/tickers` | Yes — `tickers` query param, comma-separated |
| Snapshot for the entire market | same endpoint, omit `tickers` | Yes — all 10,000+ US tickers |
| Grouped daily bars (EOD OHLC for every ticker on one date) | `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` | Yes — every ticker, one call |
| Daily open/close for one ticker | `GET /v1/open-close/{stocksTicker}/{date}` | No — one ticker per call |
| Aggregate bars (custom timespan/multiplier) for one ticker | `GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}` | No — one ticker per call |
| Last trade for one ticker | `GET /v2/last/trade/{ticker}` | No |
| Last quote for one ticker | `GET /v2/last/nbbo/{ticker}` | No |

The **snapshot endpoint is the one this project uses** — it is the only endpoint that
returns last-trade price for an arbitrary, caller-specified *list* of tickers in a single
request, which is exactly the ~10-ticker watchlist shape this project has.

### 3.1 Snapshot — multi-ticker (used by this project)

```
GET /v2/snapshot/locale/us/markets/stocks/tickers?tickers=AAPL,TSLA,GOOGL
```

Query parameters:
- `tickers` (optional) — case-insensitive comma-separated list. Empty string / omitted =
  every ticker in the market.
- `include_otc` (optional, boolean) — include OTC securities. Default `false`.

Example response (field names verbatim from Massive's docs page for this endpoint;
[[Full Market Snapshot](https://massive.com/docs/rest/stocks/snapshots/full-market-snapshot)]):

```json
{
  "count": 1,
  "status": "OK",
  "tickers": [
    {
      "ticker": "BCAT",
      "todaysChange": -0.124,
      "todaysChangePerc": -0.601,
      "updated": 1605192894630916600,
      "day": {"c": 20.506, "dv": "37216.0", "h": 20.64, "l": 20.506, "o": 20.64, "v": 37216, "vw": 20.616},
      "lastTrade": {"c": [14, 41], "ds": "2416.0", "i": "71675577320245", "p": 20.506, "s": 2416, "t": 1605192894630916600, "x": 4},
      "lastQuote": {"P": 20.6, "S": 22, "p": 20.5, "s": 13, "t": 1605192959994246100},
      "min": {"av": 37216, "c": 20.506, "h": 20.506, "l": 20.506, "n": 1, "o": 20.506, "t": 1684428600000, "v": 5000, "vw": 20.5105},
      "prevDay": {"c": 20.63, "h": 21, "l": 20.5, "o": 20.79, "v": 292738, "vw": 20.6939}
    }
  ]
}
```

Fields relevant to a live-price watchlist:
- `ticker` — symbol
- `lastTrade.p` — last trade price (what this project reads)
- `lastTrade.t` — trade timestamp, **Unix nanoseconds** in this sample (note: the field is
  documented inconsistently across Massive/Polygon pages as milliseconds in some places and
  nanoseconds in others — see §6 caveat)
- `todaysChange` / `todaysChangePerc` — change vs. previous close
- `day.c` / `day.o` / `day.h` / `day.l` / `day.v` — running intraday OHLCV
- `prevDay.c` — previous close

### 3.2 Grouped daily bars (EOD, all tickers, one call)

```
GET /v2/aggs/grouped/locale/us/market/stocks/{date}
```

Path: `date` (YYYY-MM-DD). Query: `adjusted` (default `true`), `include_otc` (default
`false`).
[[Daily Market Summary](https://massive.com/docs/rest/stocks/aggregates/daily-market-summary)]

```json
{
  "adjusted": true,
  "queryCount": 3,
  "results": [
    {"T": "KIMpL", "c": 25.9102, "h": 26.25, "l": 25.91, "n": 74, "o": 26.07, "t": 1602705600000, "v": 4369, "vw": 26.0407}
  ],
  "resultsCount": 3,
  "status": "OK"
}
```

`results[]` fields: `T` ticker, `o`/`h`/`l`/`c` OHLC, `v` volume, `vw` VWAP, `n` transaction
count, `t` timestamp (Unix **milliseconds** here — confirmed consistent in this endpoint's
docs). This is the efficient path for "give me EOD closes for every ticker on the exchange
in one request" — overkill for a 10-ticker watchlist (better to filter client-side or use
the per-ticker open-close endpoint for just the watched names), but worth knowing it exists
if the watchlist ever grows large.

### 3.3 Daily open/close, single ticker

```
GET /v1/open-close/{stocksTicker}/{date}
```

```json
{
  "afterHours": 322.1,
  "close": 325.12,
  "from": "2023-01-09",
  "high": 326.2,
  "low": 322.3,
  "open": 324.66,
  "preMarket": 324.5,
  "status": "OK",
  "symbol": "AAPL",
  "volume": 26122646
}
```

One request per ticker — for a 10-ticker watchlist that's 10 calls, which matters against
the free-tier rate limit (§5).

## 4. Python Client Usage (`massive` package)

The client wraps all of the above. Quickstart, verbatim pattern from the official README:

```python
from massive import RESTClient

client = RESTClient(api_key="<API_KEY>")

# Aggregate bars (intraday or daily), one ticker, paginated automatically
aggs = []
for a in client.list_aggs(
    ticker="AAPL", multiplier=1, timespan="minute",
    from_="2023-01-01", to="2023-06-13", limit=50000,
):
    aggs.append(a)

# Last trade, one ticker
trade = client.get_last_trade(ticker="AAPL")

# Last quote, one ticker
quote = client.get_last_quote(ticker="AAPL")

# Trades / quotes for a given day, one ticker (generator, paginated)
for t in client.list_trades(ticker="AAPL", timestamp="2022-01-04"):
    ...
```

[[client-python README](https://github.com/massive-com/client-python/blob/master/README.md)]

### 4.1 Multi-ticker snapshot (what this project calls)

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

This matches `backend/app/market/massive_client.py:125` exactly — `get_snapshot_all` is
the typed-model equivalent of the raw `/v2/snapshot/locale/us/markets/stocks/tickers`
endpoint in §3.1; the SDK converts the raw `lastTrade.p` / `lastTrade.t` JSON keys into
`snap.last_trade.price` / `snap.last_trade.timestamp` attributes on a `TickerSnapshot`
model instance.

### 4.2 Pagination

Enabled by default for list-returning methods (`list_aggs`, `list_trades`, `list_quotes`).
`limit` controls page size, not total results returned — the generator keeps fetching pages
until exhausted. Disable with `RESTClient(api_key=..., pagination=False)` to get a single
page.

### 4.3 WebSocket client (not used by this project)

```python
from massive import WebSocketClient
from massive.websocket.models import WebSocketMessage

ws = WebSocketClient(api_key="<API_KEY>", subscriptions=["T.AAPL"])

def handle_msg(msgs: list[WebSocketMessage]):
    for m in msgs:
        print(m)

ws.run(handle_msg=handle_msg)
```

Mentioned for completeness. PLAN.md §6 explicitly chose REST polling over WebSocket
streaming for the market-data layer ("simpler, works on all tiers"), and the free/low tiers
of Massive gate WebSocket access more restrictively than REST snapshot polling, so this
project does not use `WebSocketClient`.

## 5. Rate Limits

Per Massive's own knowledge-base FAQ
[[What is the request limit for Massive's RESTful APIs?](https://massive.com/knowledge-base/article/what-is-the-request-limit-for-massives-restful-apis)]:

- **Free tier: 5 API requests per minute.**
- **Paid tiers: unlimited API requests** (no fixed number given), with a general
  recommendation to stay under ~100 requests/second to avoid throttling regardless of plan.

This is stated without breaking out separate numeric caps for Starter/Developer/Advanced/
Business — those paid tiers differ in *data recency* (see below), not in request-rate
ceiling, per the documentation available at research time.

**Caveat:** search results also surfaced third-party summaries (not massive.com itself)
claiming specific paid-tier prices (Starter ~$29/mo, Developer ~$79/mo, Advanced ~$199/mo).
Those numbers are **not verified against an official Massive pricing page fetch** in this
research pass — treat them as indicative only, confirm at massive.com/pricing before
budgeting.

### 5.1 Data recency by tier

The Full Market Snapshot docs page states plainly: **Starter and Developer tiers receive
15-minute-delayed data; Advanced and Business tiers get real-time data.**
[[Full Market Snapshot](https://massive.com/docs/rest/stocks/snapshots/full-market-snapshot)]
The free tier is not named explicitly on that page but is understood (consistent with
historical Polygon.io behavior) to also be delayed, not real-time.

This matters for this project: on a free key, the snapshot endpoint's `lastTrade.p` is
**not** live-live — it can lag the actual market by up to 15 minutes. That's an acceptable
tradeoff for a course-capstone paper-trading app, but worth stating rather than assuming.

## 6. Timestamp Field Caveat

The snapshot endpoint's `lastTrade.t` appeared as a 19-digit number in Massive's own
documented example (`1605192894630916600`), which is Unix **nanoseconds**. The grouped
daily endpoint's `t` field, by contrast, is a 13-digit number in its documented example
(`1602705600000`), which is Unix **milliseconds**. These are two different fields on two
different endpoints with different units — do not assume they match.

`backend/app/market/massive_client.py:103` currently divides `snap.last_trade.timestamp` by
`1000.0` and comments "Massive timestamps are Unix milliseconds → convert to seconds." Based
on the nanosecond example above, this may be off by a factor of 1,000,000 for the snapshot
endpoint specifically. This is flagged here as a finding for the implementation owner to
verify against a live API response (or the `massive` package's typed model, which may
already normalize units before exposing `.timestamp`) — not fixed in this research pass,
since it requires a live key or reading the SDK's internal conversion code to confirm, and
this doc is scoped to API research, not a code fix.

## 7. Error Handling

Not exhaustively documented in the pages fetched during this research pass. Standard REST
conventions apply based on the SDK's own error-handling pattern already present in this
codebase (`massive_client.py:118`, catching broad `Exception` around the poll and logging):
- `401` — invalid/missing API key
- `429` — rate limit exceeded (relevant at 5 req/min on the free tier)
- Network/timeout errors from the underlying HTTP client

The existing implementation does not re-raise on poll failure; it logs and retries on the
next interval, which is a reasonable default for a background poller and requires no
change.

## 8. Relevance to This Project's Needs

The project needs: live-ish prices for a ~10-ticker watchlist, refreshed periodically, plus
(optionally) EOD data. Given a free-tier key (5 req/min):

- **Use the multi-ticker snapshot endpoint** (§3.1 / §4.1), one call per poll cycle,
  covering all watched tickers regardless of watchlist size (up to the whole market). This
  is what `MassiveDataSource` already does.
- **Poll interval must respect 5 req/min → minimum 12s between calls; the implementation
  uses 15s**, leaving headroom. This is already correct in
  `backend/app/market/massive_client.py:32`.
- **Do not** use the per-ticker open-close or last-trade endpoints in a loop over the
  watchlist — that would burn 10 requests per cycle against a 5-req/min budget and be rate
  limited almost immediately.
- **EOD data**, if ever needed (e.g., for a daily chart baseline), should use the grouped
  daily endpoint (§3.2) filtered client-side to watched tickers, or the per-ticker
  open-close endpoint (§3.3) called sparingly (once per ticker per day, not on a polling
  loop).
- **Expect 15-minute-delayed prices on free/low tiers** (§5.1) — this should be treated as
  "real but delayed" data, not real-time, unless the account is upgraded to Advanced/
  Business.

## Sources

- [Polygon.io is Now Massive](https://massive.com/blog/polygon-is-now-massive)
- [massive-com/client-python README](https://github.com/massive-com/client-python/blob/master/README.md)
- [Full Market Snapshot — Stocks REST API](https://massive.com/docs/rest/stocks/snapshots/full-market-snapshot)
- [Daily Market Summary (OHLC) — Stocks REST API](https://massive.com/docs/rest/stocks/aggregates/daily-market-summary)
- [Daily Ticker Summary (OHLC) — Stocks REST API](https://massive.com/docs/rest/stocks/aggregates/daily-ticker-summary)
- [What is the request limit for Massive's RESTful APIs?](https://massive.com/knowledge-base/article/what-is-the-request-limit-for-massives-restful-apis)
- [massive · PyPI](https://pypi.org/project/massive/)
- `backend/uv.lock` (locked `massive` version 2.2.0)
