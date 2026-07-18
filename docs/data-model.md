# Unified Data Model and Adapter Contract

All three adapters normalize their raw data into the structure below. The frontend recognizes only this model and is unaware of source differences.

## Session

```python
{
  "id": "ses_09648f4e",            # raw ID
  "source": "opencode",             # claude | codex | opencode
  "title": "Audit image-gen implementation",
  "project": "C:/Users/Light",      # equivalent cwd / working directory (used for project grouping)
  "model": "gpt-5.6-sol",          # normalized into a string where possible
  "agent": "build",                 # optional
  "time_created": 1784093030049,   # millisecond timestamp
  "time_updated": 1784182685479,
  "cost": 0.0,
  "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0},
  "message_count": 0,             # timeline length (backend estimate or frontend count)
}
```

## Timeline (single-session detail)

```python
{
  "session": {...Session above...},
  "messages": [
    {
      "role": "user" | "assistant",
      "time": 1784093030123,
      "parts": [
        {"type": "text", "text": "..."},
        {"type": "reasoning", "text": "..."},
        {"type": "tool", "tool": "read", "call_id": "...",
         "state": {"status": "completed", "input": {...}, "output": "..."}}
      ]
    }
  ]
}
```

### Rules

- `step-start` / `step-finish` (OpenCode) do not enter the timeline; they are used only to aggregate token/cost at the Session level.
- The `reasoning` part is collapsed by default (frontend-controlled) and rendered separately from text.
- When `tool.output` is very long, the backend truncates it to 8 KB; the full content is available via the raw endpoint.

## Normalization Mapping Across the Three Sources

| Field | Claude | Codex | OpenCode |
|---|---|---|---|
| id | file name uuid | session-id from rollout file name | `session.id` |
| project | decoded file path (`-` → `\`/`/`) | `session_meta.cwd` | `session.directory` |
| title | first user message or summary | session_index title | `session.title` |
| model | model within event | session_meta model | extract modelID from `session.model` JSON |
| messages | JSONL lines grouped by role | dedup turn/user_message/agent_message | `message` JOIN `part` |
| parts | tool_use / tool_result → tool | function_call / call → tool | `part.type` direct mapping |
| tokens | event usage | token_count rows | aggregate `step-finish.tokens` |

## Adapter Base Class Contract

Each adapter implements 4 methods:

```python
class BaseAdapter:
    source: str
    def list_sessions(self, q: str, project: str, limit, offset) -> dict
    def get_session(self, session_id: str) -> dict   # Timeline
    def get_raw(self, session_id: str) -> bytes
    def open_terminal(self, session_id: str) -> None  # optional
```

`list_sessions` returns `{"sessions":[...], "projects":[...], "total":N}`.
