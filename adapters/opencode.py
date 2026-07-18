"""OpenCode adapter: 读取 opencode.db SQLite。

数据模型(已实测):
  session(id, project_id, directory, title, model, agent, cost,
          tokens_*, time_created, time_updated, ...)
  message(id, session_id, time_created, data)   -- data = {role, model, agent, summary}
  part(id, message_id, session_id, time_created, data)
       part.data.type in {text, tool, reasoning, step-start, step-finish}

归一化规则见 docs/data-model.md。
"""
from __future__ import annotations
import json, sqlite3, os
from .base import BaseAdapter, Session, Message, Part

DB_PATH = os.path.expanduser(r"~/.local/share/opencode/opencode.db")


class OpenCodeAdapter(BaseAdapter):
    source = "opencode"

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path

    def _conn(self):
        if not os.path.exists(self.db_path):
            raise FileNotFoundError(self.db_path)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _model_str(raw: str) -> str:
        if not raw:
            return ""
        try:
            j = json.loads(raw)
            return j.get("modelID") or j.get("id") or ""
        except Exception:
            return raw

    def list_sessions(self, q="", project="", limit=100, offset=0):
        conn = self._conn()
        cur = conn.cursor()
        sql = ("SELECT id, directory, title, model, agent, cost, "
               "tokens_input, tokens_output, tokens_reasoning, "
               "tokens_cache_read, tokens_cache_write, "
               "time_created, time_updated "
               "FROM session WHERE 1=1")
        params = []
        if project:
            sql += " AND directory = ?"
            params.append(project)
        if q:
            sql += " AND (title LIKE ? OR directory LIKE ? OR id LIKE ?)"
            params += [f"%{q}%"] * 3
        sql += " ORDER BY time_created DESC LIMIT ? OFFSET ?"
        params += [limit, offset]
        cur.execute(sql, params)
        sessions = []
        projects = set()
        for r in cur.fetchall():
            projects.add(r["directory"] or "")
            sessions.append(Session(
                id=r["id"], source=self.source, title=r["title"] or "",
                project=r["directory"] or "", model=self._model_str(r["model"]),
                agent=r["agent"] or "", cost=r["cost"] or 0.0,
                tokens={"input": r["tokens_input"], "output": r["tokens_output"],
                        "reasoning": r["tokens_reasoning"],
                        "cache_read": r["tokens_cache_read"],
                        "cache_write": r["tokens_cache_write"]},
                time_created=r["time_created"], time_updated=r["time_updated"],
            ).to_dict())
            sessions[-1]["filePath"] = f"sqlite://{self.db_path}#session/{r['id']}"
        cur.execute("SELECT COUNT(*) FROM session WHERE 1=1" +
                    (" AND directory = ?" if project else ""), [project] if project else [])
        total = cur.fetchone()[0]
        conn.close()
        return {"sessions": sessions, "projects": sorted(p for p in projects if p),
                "total": total}

    def get_session(self, session_id: str):
        conn = self._conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM session WHERE id=?", (session_id,))
        s = cur.fetchone()
        if not s:
            conn.close()
            raise KeyError(session_id)
        sess = Session(id=s["id"], source=self.source, title=s["title"] or "",
                       project=s["directory"] or "", model=self._model_str(s["model"]),
                       agent=s["agent"] or "", cost=s["cost"] or 0.0,
                       time_created=s["time_created"], time_updated=s["time_updated"]).to_dict()

        cur.execute("SELECT id, time_created, data FROM message "
                    "WHERE session_id=? ORDER BY time_created, id", (session_id,))
        messages = []
        for m in cur.fetchall():
            data = json.loads(m["data"])
            parts = self._parts(conn, m["id"])
            messages.append(Message(role=data.get("role", "assistant"),
                                    time=m["time_created"],
                                    parts=[p.__dict__ for p in parts]).__dict__)
        conn.close()
        return {"session": sess, "messages": messages}

    def find_session_path(self, session_id: str):
        """opencode 无单文件会话,指向所在 sqlite db + session id。"""
        return f"sqlite://{self.db_path}#session/{session_id}"

    def _parts(self, conn, message_id: str):
        cur = conn.cursor()
        cur.execute("SELECT data FROM part WHERE message_id=? "
                    "ORDER BY time_created, id", (message_id,))
        out = []
        for (raw,) in cur.fetchall():
            d = json.loads(raw)
            t = d.get("type")
            if t in ("step-start", "step-finish"):
                continue
            if t == "text":
                out.append(Part(type="text", text=d.get("text", "")))
            elif t == "reasoning":
                out.append(Part(type="reasoning", text=d.get("text", "")))
            elif t == "tool":
                st = d.get("state", {})
                out.append(Part(type="tool", tool=d.get("tool", ""),
                                call_id=d.get("callID", ""), state=st))
        return out

    def get_raw(self, session_id: str) -> bytes:
        # 导出该 session 的 message+part 原始 JSON
        conn = self._conn()
        cur = conn.cursor()
        cur.execute("SELECT data FROM message WHERE session_id=?", (session_id,))
        rows = [r[0] for r in cur.fetchall()]
        conn.close()
        return ("\n".join(rows)).encode("utf-8")

    def delete_session_rows(self, session_id: str) -> bool:
        """从 opencode.db 删除该会话(session/message/part 连带删除)。"""
        conn = None
        try:
            conn = self._conn()
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM session WHERE id=?", (session_id,))
            if not cur.fetchone():
                return False
            # SQLite 外键一般未开,显式按 session_id 删 message 与 part
            msg_ids = [r[0] for r in cur.execute(
                "SELECT id FROM message WHERE session_id=?", (session_id,)).fetchall()]
            if msg_ids:
                placeholders = ",".join("?" * len(msg_ids))
                cur.execute(f"DELETE FROM part WHERE message_id IN ({placeholders})", msg_ids)
                cur.execute(f"DELETE FROM part WHERE session_id=?", (session_id,))
            cur.execute("DELETE FROM message WHERE session_id=?", (session_id,))
            cur.execute("DELETE FROM session WHERE id=?", (session_id,))
            conn.commit()
            return True
        except Exception:
            if conn:
                conn.rollback()
            raise
        finally:
            if conn:
                conn.close()
