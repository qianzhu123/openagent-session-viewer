# API

所有接口返回 JSON。`source` 参数: `claude | codex | opencode`。

- `GET /api/health` — `{ok, sources, port}`
- `GET /api/sources` — 各 source 可用性与会话总数
- `GET /api/sessions?source=&q=&project=&limit=&offset=` — 列出会话与项目分组
  - 返回 `{sessions:[Session], projects:[str], total:int}`
- `GET /api/session?source=&id=` — 单会话时间线 `{session, messages:[Message]}`
- `GET /api/raw?source=&id=` — 原始 JSONL/数据
- 浏览器路由 `GET /session/<source>/<id>` 与 `/`、`/index.html`、`/app.js`、`/style.css`

## Source 命名

| source | 字面 | 后端 adapter |
|---|---|---|
| claude | Claude Code | `adapters/claude.py` |
| codex | Codex CLI | `adapters/codex.py` |
| opencode | OpenCode | `adapters/opencode.py` |

数据模型见 `docs/data-model.md`。
