# FinAlly — AI Trading Workstation

A visually stunning AI-powered trading workstation that streams live market data, simulates portfolio trading, and integrates an LLM chat assistant that can analyze positions and execute trades via natural language.

Built entirely by coding agents as a capstone project for an agentic AI coding course. See [`planning/PLAN.md`](planning/PLAN.md) for the full specification.

## Status

Market data subsystem (simulator, price cache, SSE streaming) is built and tested in `backend/`. Frontend, database layer, portfolio/trade API, chat/LLM integration, and Docker packaging are not yet built.

## Planned Architecture

Single Docker container serving everything on port 8000:

- **Frontend**: Next.js (static export) with TypeScript and Tailwind CSS
- **Backend**: FastAPI (Python/`uv`) with SSE streaming
- **Database**: SQLite with lazy initialization
- **AI**: LiteLLM → OpenRouter (Cerebras inference) with structured outputs
- **Market data**: Built-in GBM simulator (default) or Massive/Polygon.io API (optional)

## Backend Development

```bash
cd backend
uv sync --extra dev
uv run --extra dev pytest -v          # run tests
uv run market_data_demo.py            # live terminal dashboard of simulated prices
```

See [`backend/CLAUDE.md`](backend/CLAUDE.md) for the market data API.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for AI chat |
| `MASSIVE_API_KEY` | No | Massive (Polygon.io) key for real market data; omit to use simulator |
| `LLM_MOCK` | No | Set `true` for deterministic mock LLM responses (testing) |

## Project Structure

```
finally/
├── frontend/    # Next.js static export (not yet built)
├── backend/     # FastAPI uv project — market data subsystem complete
├── planning/    # Project documentation and agent contracts
├── test/        # Playwright E2E tests (not yet built)
└── scripts/     # Start/stop helpers (not yet built)
```

## License

See [LICENSE](LICENSE).
