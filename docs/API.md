# API

All endpoints return JSON. The `source` parameter accepts: `claude | codex | opencode`.

- `GET /api/health` — `{ok, sources, port}`
- `GET /api/sources` — Availability and total session count per source
- `GET /api/sessions?source=&q=&project=&limit=&offset=` — List sessions and project grouping
  - Returns `{sessions:[Session], projects:[str], total:int}`
- `GET /api/session?source=&id=` — Single-session timeline `{session, messages:[Message]}`
- `GET /api/raw?source=&id=` — Raw JSONL/data
- Browser routes `GET /session/<source>/<id>` and `/`, `/index.html`, `/app.js`, `/style.css`

## Source Names

| source | label | backend adapter |
|---|---|---|
| claude | Claude Code | `adapters/claude.py` |
| codex | Codex CLI | `adapters/codex.py` |
| opencode | OpenCode | `adapters/opencode.py` |

See `docs/data-model.md` for the data model.
