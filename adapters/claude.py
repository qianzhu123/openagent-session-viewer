"""Claude Code adapter: 扫描 .claude/projects 下的 JSONL。

路径形如 ~/.claude/projects/C--Users-Light/<uuid>.jsonl
每行一条 event(u/assistant 消息块含 message.content,tool_use/tool_result 成对)。
"""
from __future__ import annotations
import json, os, glob
from .base import BaseAdapter, Session, Message, Part

PROJ_DIR = os.path.expanduser("~/.claude/projects")


def _decode_project(path_or_dir: str) -> str:
    # Claude 把 cwd 编码进目录名:C--Users-Light 表示 C:\Users\Light
    # 规则(官方 decode): "--" -> ":\",其他 "-" -> "\"
    # 入参若是文件路径,取其所在目录名再解码
    if os.path.isfile(path_or_dir):
        base = os.path.basename(os.path.dirname(path_or_dir))
    else:
        base = os.path.basename(path_or_dir.rstrip("/\\"))
    return base.replace("--", ":\\").replace("-", "\\")


def _to_ms(ts) -> int:
    if ts is None:
        return 0
    if isinstance(ts, (int, float)):
        return int(ts)
    s = str(ts).strip()
    if s.isdigit():
        return int(s)
    z = s.replace("Z", "+00:00")
    try:
        import datetime, calendar
        return int(calendar.timegm(datetime.datetime.fromisoformat(z).timetuple()) * 1000)
    except Exception:
        return 0


class ClaudeAdapter(BaseAdapter):
    source = "claude"

    def __init__(self, root: str = PROJ_DIR):
        self.root = root

    def _files(self):
        if not os.path.isdir(self.root):
            return []
        return glob.glob(os.path.join(self.root, "*", "*.jsonl"))

    def _session_title(self, path: str) -> str:
        """优先 ai-title,退回首条 user 文本。"""
        first_user = ""
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
                if t == "ai-title":
                    return ev.get("aiTitle", "") or ""
                if t == "user" and not first_user:
                    msg = ev.get("message", {})
                    for c in msg.get("content", []):
                        if isinstance(c, dict) and c.get("type") == "text":
                            first_user = (c.get("text", "") or "")[:80]
                            break
        return first_user

    def list_sessions(self, q="", project="", limit=100, offset=0):
        files = self._files()
        sessions = []
        projects = set()
        for p in files:
            proj = _decode_project(p)
            projects.add(proj)
            sid = os.path.splitext(os.path.basename(p))[0]
            title = self._session_title(p) or "(无标题)"
            mtime = int(os.path.getmtime(p) * 1000)
            sessions.append(Session(id=sid, source=self.source, title=title,
                                    project=proj, time_created=mtime,
                                    time_updated=mtime).to_dict())
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
        # 在所有 project 目录里找匹配文件名
        path = None
        for p in self._files():
            if os.path.splitext(os.path.basename(p))[0] == session_id:
                path = p
                break
        if not path:
            raise KeyError(session_id)
        sess = Session(id=session_id, source=self.source,
                       project=_decode_project(path), title=self._session_title(path),
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
                role = ev.get("type")
                if role not in ("user", "assistant"):
                    continue
                msg = ev.get("message", {})
                cur = Message(role=role, time=_to_ms(ev.get("timestamp", 0)))
                content = msg.get("content", [])
                # message.content 可能是 list(正常),也可能是 str(纯文本 user 消息)。
                # 顶层是 str 时整体作一条 text,不能逐字符迭代,否则会拆成单字符 parts。
                if isinstance(content, str):
                    cur.parts.append(Part(type="text", text=content).__dict__)
                else:
                    for c in content:
                        if isinstance(c, str):
                            cur.parts.append(Part(type="text", text=c).__dict__)
                        elif isinstance(c, dict):
                            ct = c.get("type")
                            if ct == "text":
                                cur.parts.append(Part(type="text", text=c.get("text", "")).__dict__)
                            elif ct == "thinking":
                                cur.parts.append(Part(type="reasoning", text=c.get("thinking", "")).__dict__)
                            elif ct == "tool_use":
                                cur.parts.append(Part(type="tool", tool=c.get("name", ""),
                                                      call_id=c.get("id", ""),
                                                      state={"status": "pending",
                                                             "input": c.get("input", {})}).__dict__)
                            elif ct == "tool_result":
                                cur.parts.append(Part(type="tool", tool="result",
                                                      call_id=c.get("tool_use_id", ""),
                                                      state={"status": "completed",
                                                             "output": c.get("content", "")}).__dict__)
                # 把思考打头的部分按 assistant 归类文本
                messages.append(cur.__dict__)
        return {"session": sess, "messages": messages}

    def get_raw(self, session_id: str) -> bytes:
        for p in self._files():
            if os.path.splitext(os.path.basename(p))[0] == session_id:
                with open(p, "rb") as f:
                    return f.read()
        raise KeyError(session_id)

    def find_session_path(self, session_id: str):
        for p in self._files():
            if os.path.splitext(os.path.basename(p))[0] == session_id:
                return p
        return None
