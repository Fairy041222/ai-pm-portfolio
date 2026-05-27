# AIPM Bench Backend (MVP)

FastAPI + SQLAlchemy (async) + SQLite + OpenAI

## Quick Start

```bash
cd aipm-backend
python -m venv .venv

# Windows
.venv\Scripts\activate

pip install -r requirements.txt
copy .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-...

python -m scripts.init_db
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API docs: http://127.0.0.1:8000/docs

## Frontend Proxy

In project root `vite.config.ts`:

```ts
server: {
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:8000',
      changeOrigin: true,
    },
  },
},
```

Then use `src/api/client.ts` from the React app.

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/conversations | List conversations with messages |
| POST | /api/conversations | Create empty conversation |
| DELETE | /api/conversations | Batch delete `{ "ids": [] }` |
| POST | /api/conversations/{id}/messages | Send message (chat or mock report) |
| GET | /api/reports/{conversation_id} | Get report by conversation |
| POST | /api/reports/{id}/export | Export markdown/json |
| GET | /api/models | List models |
| POST | /api/models | Add custom model |

## Notes

- Without `OPENAI_API_KEY`, chat returns a demo placeholder message.
- Report mode (≥2 `model_ids` or trigger keywords) returns mock `ReportData`.
- File upload: `POST .../messages/upload` returns 501.
