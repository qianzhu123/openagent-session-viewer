# OpenAgent Session Viewer

A local web interface to uniformly browse the on-disk session records of three agentic CLIs:

- **Claude Code** — `~/.claude/projects/**\*.jsonl`
- **Codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- **OpenCode** — `~/.local/share/opencode/opencode.db` (SQLite)

## Design Goals

- **Read-only**: never deletes, modifies, or rewrites the original files of any source.
- **Unified entry**: a single home page with a source switcher (claude / codex / opencode) at the top, a session list on the left, and a timeline on the right.
- **Information architecture aligned** with `claude-session-viewer` and `codex-session-viewer`: a single-file Python `server.py` + `static/` (index.html / app.js / style.css) + `docs/`, with refresh-safe URLs `/session/<source>/<id>`.

## Quick Start

```bash
python server.py --open
# http://127.0.0.1:8092
```

## Relationship to the Other Two Viewers

This project is designed to live alongside `claude-session-viewer` and `codex-session-viewer` but **runs independently** and does not depend on them. Backend parsing logic is split into 3 adapters (see below); the Codex adapter's cleaning rules reference `codex-session-viewer`.

## Directory Structure

```text
openagent-session-viewer/
  server.py              Local HTTP/API server + adapter dispatch
  start.vbs              Double-click launcher
  adapters/
    base.py              Unified data model + Adapter base class
    claude.py            Scans .claude/projects JSONL
    codex.py             Scans .codex/sessions JSONL
    opencode.py          Reads opencode.db SQLite
  static/                Browser UI
    index.html
    app.js
    style.css
  docs/
    API.md
    data-model.md        Unified mapping across the three sources
  data/                  Local viewer cache (session_index.json)
  tests/
    smoke_test.py
```

## Comparison of the Three Sources

| Source | Path | Format | Title Source |
|---|---|---|---|
| Claude | `.claude/projects/<encoded-path>/*.jsonl` | JSONL | First user message / summary |
| Codex | `.codex/sessions/**/rollout-*.jsonl` | JSONL | `session_index.jsonl` / session_meta |
| OpenCode | `.local/share/opencode/opencode.db` | SQLite | `session.title` |

## UI & Interaction

- **Custom styled dialogs**: All native browser `alert()`/`confirm()` replaced with custom modals following Claude design system (warm canvas colors, serif titles, coral primary buttons)
- **Non-blocking deletion**: Deleting a session removes it from the UI immediately without reloading the entire session list
- **Smart context menu**: Right-click menu auto-closes on mouseleave, scroll, or ESC key; positioning prevents overflow at viewport edges
- **Cache-friendly refresh**: Full session list refresh only happens when explicitly requested (refresh button) or switching sources

## API

See `docs/API.md`.
