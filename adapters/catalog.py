"""本地索引(catalog)扫描:三家 source 各自取各自的索引数据。

- claude: 扫 .mcp.json / ~/.claude/mcp.json / ~/.claude.json 的 mcpServers,
          扫 .claude/skills、.claude/agents、.claude/commands 目录(project+user 两层)。
- codex:  从会话 JSONL 的 dynamic_tools 聚合 MCP/tools 命名空间 + 固定 codex 启动命令。
- opencode: 读 ~/.config/opencode/opencode.jsonc 的 provider/models,
            再从 opencode.db 会话的 part 表聚合出现过的 tool 命名。

前端按 source 切换展示。只读,不改原始配置。
"""
from __future__ import annotations
import os, re, json, glob
from pathlib import Path

HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"
OPENCODE_CONFIG = HOME / ".config" / "opencode" / "opencode.jsonc"


def parse_frontmatter(text: str) -> dict:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end == -1:
        return {}
    meta = {}
    for line in text[4:end].splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


import re


def _strip_jsonc(text: str) -> str:
    # 只删除行注释(// ...)和块注释(/* ... */),保留字符串内的 // 与 /*
    src = text
    out = []
    i, n = 0, len(src)
    in_str = None  # " 或 '
    in_line = False
    in_block = False
    while i < n:
        ch = src[i]
        nxt = src[i+1] if i+1 < n else ''
        if in_line:
            if ch == '\n': in_line = False; out.append(ch); i += 1
            else: i += 1
            continue
        if in_block:
            if ch == '*' and nxt == '/': in_block = False; i += 2
            else: i += 1
            continue
        if in_str:
            out.append(ch)
            if ch == '\\' and nxt: out.append(nxt); i += 2; continue
            if ch == in_str: in_str = None
            i += 1; continue
        if ch in '"\'':
            in_str = ch; out.append(ch); i += 1; continue
        if ch == '/' and nxt == '/': in_line = True; i += 2; continue
        if ch == '/' and nxt == '*': in_block = True; i += 2; continue
        out.append(ch); i += 1
    return ''.join(out)


# ---------- Claude ----------

def _scan_mcp_file(path, scope):
    cfg = _read_json(path, {})
    servers = cfg.get("mcpServers", {}) if isinstance(cfg, dict) else {}
    if not isinstance(servers, dict):
        return []
    res = []
    for name, d in sorted(servers.items()):
        if not isinstance(d, dict):
            d = {"value": d}
        res.append({"name": name, "scope": scope, "path": str(path),
                    "transport": d.get("type") or ("http" if d.get("url") else "stdio"),
                    "command": d.get("command", ""), "url": d.get("url", ""),
                    "args": d.get("args", []), "disabled": False})
    return res


def _scan_skill_dir(base, scope):
    out = []
    base = Path(base)
    if not base.exists():
        return out
    for sk in sorted(base.glob("*/SKILL.md")):
        text = sk.read_text(encoding="utf-8", errors="replace")
        m = parse_frontmatter(text)
        out.append({"name": m.get("name") or sk.parent.name,
                    "description": m.get("description", ""), "scope": scope,
                    "path": str(sk.parent)})
    return out


def _scan_agent_dir(base, scope):
    out = []
    base = Path(base)
    if not base.exists():
        return out
    for f in sorted(base.glob("*.md")):
        m = parse_frontmatter(f.read_text(encoding="utf-8", errors="replace"))
        out.append({"name": m.get("name") or f.stem,
                    "description": m.get("description", ""),
                    "model": m.get("model", ""), "scope": scope, "path": str(f)})
    return out


def _scan_command_dir(base, scope):
    out = []
    base = Path(base)
    if not base.exists():
        return out
    for f in sorted(base.glob("*.md")):
        out.append({"name": f.stem, "scope": scope, "path": str(f)})
    return out


def build_claude_catalog(project_root: str = ""):
    root = Path(project_root or os.getcwd())
    home_cfg = HOME / ".claude.json"
    mcp = (_scan_mcp_file(root / ".mcp.json", "project") +
           _scan_mcp_file(CLAUDE_DIR / "mcp.json", "user") +
           _scan_mcp_file(home_cfg, "user"))
    skills = (_scan_skill_dir(root / ".claude" / "skills", "project") +
              _scan_skill_dir(CLAUDE_DIR / "skills", "user"))
    agents = (_scan_agent_dir(root / ".claude" / "agents", "project") +
              _scan_agent_dir(CLAUDE_DIR / "agents", "user"))
    commands = (_scan_command_dir(root / ".claude" / "commands", "project") +
                _scan_command_dir(CLAUDE_DIR / "commands", "user"))
    return {"projectRoot": str(root),
            "mcpServers": mcp, "skills": skills, "agents": agents, "commands": commands,
            "counts": {"mcpServers": len(mcp), "skills": len(skills),
                       "agents": len(agents), "commands": len(commands)}}


# ---------- Codex ----------

def build_codex_catalog(project_root: str = ""):
    from adapters.codex import CodexAdapter
    root = CodexAdapter().root
    mcp_map = {}
    tool_counter = {}
    files = glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True) if os.path.isdir(root) else []
    target_cwd = (project_root or "").replace("/", "\\").lower()
    for p in files[:400]:
        cwd = ""
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                # 先快速读 session_meta 拿 cwd,不匹配则跳过该文件的深度扫描
                if target_cwd:
                    head = ""
                    while len(head) < 4000:
                        ln = f.readline()
                        if not ln: break
                        head += ln
                        if '"session_meta"' in ln and '"cwd"' in head:
                            import json as _j
                            for hl in head.splitlines():
                                try: ev = _j.loads(hl)
                                except: continue
                                if ev.get("type") == "session_meta":
                                    cwd = (ev.get("payload", {}).get("cwd", "") or "")
                    if cwd.lower() != target_cwd:
                        continue
                    f.seek(0)
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try: ev = json.loads(line)
                    except Exception: continue
                    t = ev.get("type"); pl = ev.get("payload", {})
                    if t == "response_item" and pl.get("type") == "function_call":
                        nm = pl.get("name", "")
                        if nm: tool_counter[nm] = tool_counter.get(nm, 0) + 1
                    elif t == "event_msg" and pl.get("type") == "mcp_tool_call_end":
                        inv = pl.get("invocation", {}) or {}
                        srv = inv.get("server", ""); tool = inv.get("tool", "")
                        if srv:
                            bucket = mcp_map.setdefault(srv, {"name": srv, "tools": [], "kind": "mcp", "toolCount": 0})
                            if tool and tool not in bucket["tools"]: bucket["tools"].append(tool)
                            bucket["toolCount"] += 1
        except Exception:
            continue
    mcp_servers = list(mcp_map.values())
    tools = [{"name": n, "count": c, "kind": "tool"} for n, c in sorted(tool_counter.items(), key=lambda x: -x[1])]
    commands = [
        {"name": "codex", "description": "启动新的 Codex 本地会话"},
        {"name": "codex resume <session-id>", "description": "恢复指定会话"},
        {"name": "codex --model <model>", "description": "指定模型启动会话"},
        {"name": "codex -C <path>", "description": "指定工作目录启动会话"},
    ]
    return {"mcpServers": mcp_servers, "tools": tools, "commands": commands,
            "skills": [], "agents": [],
            "counts": {"mcpServers": len(mcp_servers), "tools": len(tools),
                       "commands": len(commands), "skills": 0, "agents": 0}}


def build_opencode_catalog(project_root: str = ""):
    # 1) config.jsonc 的 provider / models(全局,不经项目过滤)
    providers, models = [], []
    if OPENCODE_CONFIG.exists():
        try:
            text = _strip_jsonc(OPENCODE_CONFIG.read_text(encoding="utf-8"))
            cfg = json.loads(text)
            for pname, pv in (cfg.get("provider") or {}).items():
                if not isinstance(pv, dict): continue
                servers = pv.get("mcpServers") or {}
                if isinstance(servers, dict):
                    for sn, sd in servers.items():
                        providers.append({"name": sn, "scope": "provider:" + pname})
                mlist = pv.get("models") if isinstance(pv, dict) else None
                if isinstance(mlist, dict):
                    for mid, mv in mlist.items():
                        models.append({"name": mv.get("name", mid) if isinstance(mv, dict) else mid,
                                       "id": mid, "scope": "provider:" + pname})
        except Exception:
            pass
    # 2) 按 project_root 过滤会话里出现过的 tool 命名;不传则取全部
    tool_names = []
    try:
        import sqlite3
        db = os.path.expanduser("~/.local/share/opencode/opencode.db")
        if os.path.exists(db):
            conn = sqlite3.connect(db)
            cur = conn.cursor()
            if project_root:
                cur.execute("SELECT DISTINCT json_extract(data,'$.tool') FROM part p "
                            "JOIN session s ON p.session_id=s.id "
                            "WHERE json_extract(p.data,'$.type')='tool' AND LOWER(s.directory)=LOWER(?)",
                            (project_root.replace("/", "\\"),))
            else:
                cur.execute("SELECT DISTINCT json_extract(data,'$.tool') FROM part WHERE json_extract(data,'$.type')='tool'")
            tool_names = sorted({r[0] for r in cur.fetchall() if r[0]})
            conn.close()
    except Exception:
        pass
    tool_items = [{"name": n, "kind": "tool"} for n in tool_names]
    commands = [
        {"name": "opencode", "description": "启动新会话(在目标项目目录下)"},
        {"name": "opencode resume <session-id>", "description": "恢复指定会话"},
        {"name": "opencode auth login", "description": "登录 OpenCode"},
    ]
    return {"providers": providers, "models": models, "tools": tool_items, "commands": commands,
            "mcpServers": [], "skills": [], "agents": [],
            "counts": {"providers": len(providers), "models": len(models),
                       "tools": len(tool_items), "commands": len(commands),
                       "mcpServers": 0, "skills": 0, "agents": 0}}


def build_catalog(source: str, project_root: str = "") -> dict:
    if source == "claude":
        c = build_claude_catalog(project_root)
        c["generatedAt"] = _now()
        c["source"] = "claude"
        return c
    if source == "codex":
        c = build_codex_catalog(project_root)
        c["generatedAt"] = _now()
        c["source"] = "codex"
        return c
    c = build_opencode_catalog(project_root)
    c["generatedAt"] = _now()
    c["source"] = "opencode"
    return c


def _now() -> str:
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
