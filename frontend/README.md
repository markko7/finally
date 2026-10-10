# FinAlly Frontend

Next.js (static export) + TypeScript + Tailwind. Served by the FastAPI backend from `backend/static`.

```bash
npm run build      # produces out/
npm test           # Vitest unit tests
```

For local development, build and copy `out/` to `backend/static`, then run the backend (`uv run uvicorn app.main:app`) since all API calls are same-origin.
