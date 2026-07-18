"""Codex adapter: 扫描 .codex/sessions 下的 JSONL(新版 Codex / GPT-5 Codex)。

JSONL 事件结构(实测):
  type=session_meta  payload={ id, cwd, model_provider, cli_version, originator, ... }
  type=response_item payload.type in { message, reasoning, function_call,
                                       function_call_output, custom_tool_call,
                                       custom_tool_call_output, web_search_call }
    - message:           { role: assistant|user|developer, content:[{type,text}] }
    - function_call:     { name, arguments(JSON字符串) }
    - function_call_output: { output }
  type=event_msg     payload.type in { thread_name_updated(=title), agent_message,
                                       user_message, token_count, task_started, ... }

清洗规则:忽略 developer role 的 permissions/base_instructions 噪声消息、
忽略内部 executive 事件,只保留正常对话时间线。
"""
from __future__ import annotations
import json, os, glob
from .base import BaseAdapter, Session, Message, Part

ROOT = os.path.expanduser("~/.codex/sessions")

INTERNAL_EVENT_TYPES = {
    "token_count", "task_started", "task_complete", "exec_command_end",
    "patch_apply_end", "web_search_end", "error", "turn_aborted",
    "context_compacted", "thread_rolled_back", "dynamic_tool_call_request",
    "dynamic_tool_call_response", "agent_reasoning",
}

# developer role 的内置指令消息(prefix),不进时间线
NOISE_PREFIXES = ("<permissions instructions", "<custom_instructions", "<environment_context")


def _sid_from_path(path: str) -> str:
    """从文件名取 UUID 段(timestamp 在前,UUID 5 段在后)。"""
    base = os.path.splitext(os.path.basename(path))[0]
    body = base[len("rollout-"):] if base.startswith("rollout-") else base
    parts = body.split("-")
    # ['2026','07','16T13','05','32', <5 UUID segments>...]
    return "-".join(parts[5:]) if len(parts) >= 6 else body


def _read_meta_id(path: str) -> str:
    """读 session_meta.payload.id 作为真实 session id;失败回退文件名 UUID。"""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for _ in range(20):
                line = f.readline()
                if not line:
                    break
                try:
                    ev = json.loads(line.strip())
                except Exception:
                    continue
                if ev.get("type") == "session_meta":
                    rid = ev.get("payload", {}).get("id")
                    if rid:
                        return rid
    except Exception:
        pass
    return _sid_from_path(path)


def _is_noise(text: str) -> bool:
    return any(text.startswith(p) for p in NOISE_PREFIXES)


class CodexAdapter(BaseAdapter):
    source = "codex"

    def __init__(self, root: str = ROOT):
        self.root = root

    def _files(self):
        if not os.path.isdir(self.root):
            return []
        return glob.glob(os.path.join(self.root, "**", "*.jsonl"), recursive=True)

    @staticmethod
    def _read_header(path: str):
        """只扫前若干行取 session_meta + 首条 user_message 标题,避免全文件解析。"""
        cwd, title, model, meta_id = "", "", "", ""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for _ in range(120):
                    line = f.readline()
                    if not line:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    t = ev.get("type")
                    p = ev.get("payload", {})
                    if t == "session_meta":
                        cwd = p.get("cwd", "") or cwd
                        model = (p.get("model_provider") or p.get("model") or "") or model
                        meta_id = p.get("id", "") or meta_id
                    elif t == "event_msg" and not title:
                        if p.get("type") in ("thread_name_updated", "thread_goal_updated"):
                            title = p.get("name") or p.get("title") or p.get("goal") or ""
                        elif p.get("type") == "user_message":
                            title = p.get("message", "")[:80]
        except Exception:
            pass
        sid = meta_id or _sid_from_path(path)
        return cwd, title, model, sid

    def list_sessions(self, q="", project="", limit=100, offset=0):
        files = self._files()
        sessions = []
        projects = set()
        for p in files:
            cwd, title, model, sid = self._read_header(p)
            if not title:
                title = "Codex " + os.path.basename(p)[:24]
            projects.add(cwd)
            mtime = int(os.path.getmtime(p) * 1000)
            sessions.append(Session(id=sid, source=self.source,
                                    title=title, project=cwd, model=model,
                                    time_created=mtime, time_updated=mtime).to_dict())
            sessions[-1]["filePath"] = p
        if project:
            sessions = [s for s in sessions if s["project"] == project]
        if q:
            q2 = q.lower()
            sessions = [s for s in sessions if q2 in s["title"].lower()
                        or q2 in s["id"].lower() or q2 in s["project"].lower()]
        sessions.sort(key=lambda s: s["time_updated"], reverse=True)
        total = len(sessions)
        sessions = sessions[offset:offset + limit]
        return {"sessions": sessions, "projects": sorted(p for p in projects if p),
                "total": total}

    def get_session(self, session_id: str):
        path = None
        for p in self._files():
            if _sid_from_path(p) == session_id or _read_meta_id(p) == session_id:
                path = p
                break
        if not path:
            raise KeyError(session_id)
        sess = Session(id=session_id, source=self.source,
                       time_created=int(os.path.getmtime(path) * 1000)).to_dict()
        messages = []
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                t = ev.get("type")
                p = ev.get("payload", {})
                if t == "session_meta":
                    sess["project"] = p.get("cwd", "")
                    sess["model"] = (p.get("model_provider") or p.get("model") or "")
                    continue
                if t == "event_msg":
                    if p.get("type") == "thread_name_updated":
                        sess["title"] = p.get("name") or sess.get("title") or ""
                    continue  # 其余 event_msg 不进时间线
                if t == "response_item":
                    pt = p.get("type")
                    if pt == "message":
                        role = p.get("role", "assistant")
                        parts = []
                        for c in p.get("content", []):
                            ct = c.get("type", "")
                            tx = c.get("text", "")
                            if ct in ("input_text", "output_text", "text"):
                                if role == "developer" and _is_noise(tx):
                                    continue
                                parts.append(Part(type="text", text=tx).__dict__)
                        if parts:
                            messages.append(Message(role=role, parts=parts,
                                                    time=int(ev.get("timestamp") and
                                                    _ts_ms(ev["timestamp"]) or 0)).__dict__)
                    elif pt == "reasoning":
                        txt = p.get("summary") or p.get("text") or ""
                        if txt:
                            messages.append(Message(role="assistant",
                                parts=[Part(type="reasoning", text=txt).__dict__]).__dict__)
                    elif pt == "function_call":
                        messages.append(Message(role="assistant",
                            parts=[Part(type="tool", tool=p.get("name", "shell"),
                                state={"status": "completed",
                                       "input": _safe_json(p.get("arguments", ""))}).__dict__]).__dict__)
                    elif pt == "function_call_output":
                        messages.append(Message(role="tool",
                            parts=[Part(type="tool", tool="result",
                                state={"status": "completed",
                                       "output": _trunc(p.get("output", ""))}).__dict__]).__dict__)
                    elif pt in ("custom_tool_call", "web_search_call"):
                        messages.append(Message(role="assistant",
                            parts=[Part(type="tool", tool=pt,
                                state={"status": "running",
                                       "input": p}).__dict__]).__dict__)
                    elif pt in ("custom_tool_call_output",):
                        messages.append(Message(role="tool",
                            parts=[Part(type="tool", tool="result",
                                state={"status": "completed",
                                       "output": _trunc(p.get("output", ""))}).__dict__]).__dict__)
        return {"session": sess, "messages": messages}

    def get_raw(self, session_id: str) -> bytes:
        path = self.find_session_path(session_id)
        if path:
            with open(path, "rb") as f:
                return f.read()
        raise KeyError(session_id)

    def find_session_path(self, session_id: str):
        for p in self._files():
            if _sid_from_path(p) == session_id or _read_meta_id(p) == session_id:
                return p
        return None


def _ts_ms(ts: str) -> int:
    # ISO zulu -> ms(粗略,够时间排序)
    try:
        import calendar
        return int(calendar.timegm(_parse_iso(ts)) * 1000) if ts else 0
    except Exception:
        return 0


def _parse_iso(ts: str):
    import datetime
    s = ts.replace("Z", "+00:00")
    return datetime.datetime.fromisoformat(s).timetuple()


def _safe_json(s):
    if isinstance(s, (dict, list)):
        return s
    if not s:
        return {}
    try:
        return json.loads(s)
    except Exception:
        return {"raw": s}


def _trunc(s, n=8000):
    if not isinstance(s, str):
        try:
            s = json.dumps(s, ensure_ascii=False)
        except Exception:
            s = str(s)
    return s if len(s) <= n else s[:n] + f"\n...[truncated {len(s)-n} chars]"
