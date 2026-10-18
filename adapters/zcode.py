"""ZCode adapter: 读取 ZCode 桌面客户端的本地会话库 ~/.zcode/cli/db/db.sqlite。

数据模型(实测, 与 opencode.db 同构):
  session(id, directory, title, task_type, parent_id, time_created, time_updated, ...)
  message(id, session_id, time_created, data, sequence)
       data = {role: user|assistant, agent, model:{providerID, modelID}, time, cost, error, ...}
  part(id, message_id, session_id, time_created, data, sequence)
       part.data.type in {text, reasoning, tool, step-start, step-finish, timeline}
  model_usage(session_id, model_id, input_tokens, output_tokens, ...)

清洗规则:step-start/step-finish/timeline 不进时间线;错误占位消息(仅有 step-start
的 assistant 消息, 如限流报错)整条跳过;tool 超长输出截断到 8KB(完整内容看 raw)。

严格只读:连接一律用 mode=ro URI(打不开再退 immutable 纯读), 不向 ZCode 数据目录
写任何字节;delete_session_rows 恒为 False,删除入口在 server 端也被禁用。
"""
from __future__ import annotations
import json, os, sqlite3
from .base import BaseAdapter, Session, Message, Part

DB_PATH = os.path.expanduser(r"~/.zcode/cli/db/db.sqlite")
ROLLOUT_DIR = os.path.expanduser(r"~/.zcode/cli/rollout")

# 不进时间线的 part 类型:step 事件(opencode 同款) + zcode 的 timeline 分隔事件
SKIP_PART_TYPES = {"step-start", "step-finish", "timeline"}
OUTPUT_TRUNC = 8000


def _ro_conn(db_path: str) -> sqlite3.Connection:
    """只读连接。mode=ro 失败(如 WAL 残留且无法建 shm)时退 immutable 纯读。"""
    p = db_path.replace(os.sep, "/")
    for suffix in ("?mode=ro", "?mode=ro&immutable=1"):
        conn = None
        try:
            conn = sqlite3.connect(f"file:{p}{suffix}", uri=True)
            conn.execute("SELECT 1").fetchone()  # 真实读一次,验证库确实可打开
            conn.row_factory = sqlite3.Row
            return conn
        except sqlite3.Error:
            if conn:
                conn.close()
    raise sqlite3.OperationalError(f"无法以只读方式打开 {db_path}")


def _top_model(model_counts: dict) -> str:
    """按用量取主力模型 id。model_counts: {model_id: 出现次数}"""
    if not model_counts:
        return ""
    return max(model_counts.items(), key=lambda kv: kv[1])[0]


class ZCodeAdapter(BaseAdapter):
    source = "zcode"

    def __init__(self, db_path: str = DB_PATH, rollout_dir: str = ROLLOUT_DIR):
        self.db_path = db_path
        self.rollout_dir = rollout_dir

    def _conn(self):
        if not os.path.exists(self.db_path):
            raise FileNotFoundError(self.db_path)
        return _ro_conn(self.db_path)

    def _rollout_path(self, session_id: str):
        p = os.path.join(self.rollout_dir, f"model-io-{session_id}.jsonl")
        return p if os.path.isfile(p) else None

    # ---- 聚合辅助:整页一次查询,避免逐会话 N+1 ----

    def _page_stats(self, conn, ids: list):
        ph = ",".join("?" * len(ids))
        tokens, counts, models, costs = {}, {}, {}, {}
        if ids:
            cur = conn.cursor()
            for r in cur.execute(
                    f"SELECT session_id, SUM(input_tokens) i, SUM(output_tokens) o, "
                    f"SUM(reasoning_tokens) rt, SUM(cache_read_input_tokens) cr, "
                    f"SUM(cache_creation_input_tokens) cw FROM model_usage "
                    f"WHERE session_id IN ({ph}) GROUP BY session_id", ids):
                tokens[r["session_id"]] = {
                    "input": r["i"] or 0, "output": r["o"] or 0,
                    "reasoning": r["rt"] or 0, "cache_read": r["cr"] or 0,
                    "cache_write": r["cw"] or 0}
            for r in cur.execute(
                    f"SELECT session_id, COUNT(*) c FROM message "
                    f"WHERE session_id IN ({ph}) GROUP BY session_id", ids):
                counts[r["session_id"]] = r["c"]
            for r in cur.execute(
                    f"SELECT session_id, model_id, COUNT(*) c FROM model_usage "
                    f"WHERE session_id IN ({ph}) GROUP BY session_id, model_id", ids):
                bucket = models.setdefault(r["session_id"], {})
                bucket[r["model_id"]] = bucket.get(r["model_id"], 0) + r["c"]
            for r in cur.execute(
                    f"SELECT session_id, COALESCE(SUM(json_extract(data,'$.cost')),0) c "
                    f"FROM message WHERE session_id IN ({ph}) GROUP BY session_id", ids):
                costs[r["session_id"]] = float(r["c"] or 0)
        return tokens, counts, models, costs

    def list_sessions(self, q="", project="", limit=100, offset=0):
        conn = self._conn()
        try:
            cur = conn.cursor()
            where, params = "WHERE 1=1", []
            if project:
                where += " AND directory = ?"
                params.append(project)
            if q:
                where += " AND (title LIKE ? OR directory LIKE ? OR id LIKE ?)"
                params += [f"%{q}%"] * 3
            cur.execute(f"SELECT id, directory, title, task_type, "
                        f"time_created, time_updated FROM session {where} "
                        f"ORDER BY time_updated DESC LIMIT ? OFFSET ?",
                        params + [limit, offset])
            rows = cur.fetchall()
            tokens, counts, models, costs = self._page_stats(conn, [r["id"] for r in rows])
            sessions = []
            projects = set()
            for r in rows:
                projects.add(r["directory"] or "")
                sid = r["id"]
                sessions.append(Session(
                    id=sid, source=self.source, title=r["title"] or "",
                    project=r["directory"] or "",
                    model=_top_model(models.get(sid) or {}),
                    agent=r["task_type"] or "",
                    time_created=r["time_created"], time_updated=r["time_updated"],
                    cost=costs.get(sid, 0.0),
                    tokens=tokens.get(sid, {}),
                    message_count=counts.get(sid, 0),
                ).to_dict())
                sessions[-1]["filePath"] = self.find_session_path(sid)
            cur.execute("SELECT COUNT(*) FROM session WHERE 1=1" +
                        (" AND directory = ?" if project else ""),
                        [project] if project else [])
            total = cur.fetchone()[0]
            return {"sessions": sessions,
                    "projects": sorted(p for p in projects if p), "total": total}
        finally:
            conn.close()

    def get_session(self, session_id: str):
        conn = self._conn()
        try:
            cur = conn.cursor()
            r = cur.execute("SELECT * FROM session WHERE id=?", (session_id,)).fetchone()
            if not r:
                raise KeyError(session_id)
            tokens, counts, models, costs = self._page_stats(conn, [session_id])
            sess = Session(
                id=r["id"], source=self.source, title=r["title"] or "",
                project=r["directory"] or "", model=_top_model(models.get(session_id) or {}),
                agent=r["task_type"] or "",
                time_created=r["time_created"], time_updated=r["time_updated"],
                cost=costs.get(session_id, 0.0), tokens=tokens.get(session_id, {}),
                message_count=counts.get(session_id, 0)).to_dict()
            messages = []
            pcur = conn.cursor()  # 与外层消息游标分开,避免重入打断迭代
            for m in cur.execute(
                    "SELECT id, time_created, data FROM message WHERE session_id=? "
                    "ORDER BY time_created, sequence", (session_id,)):
                try:
                    data = json.loads(m["data"])
                except Exception:
                    continue
                parts = self._parts(pcur, m["id"])
                if not parts:
                    continue  # 错误占位消息(限流等)只有 step-start, 不进时间线
                messages.append(Message(role=data.get("role", "assistant"),
                                        time=m["time_created"],
                                        parts=parts).__dict__)
            return {"session": sess, "messages": messages}
        finally:
            conn.close()

    def _parts(self, cur, message_id: str) -> list:
        out = []
        for (raw,) in cur.execute(
                "SELECT data FROM part WHERE message_id=? ORDER BY time_created, sequence",
                (message_id,)).fetchall():
            try:
                d = json.loads(raw)
            except Exception:
                continue
            t = d.get("type")
            if t in SKIP_PART_TYPES:
                continue
            if t == "text":
                out.append(Part(type="text", text=d.get("text", "")).__dict__)
            elif t == "reasoning":
                out.append(Part(type="reasoning", text=d.get("text", "")).__dict__)
            elif t == "tool":
                st = dict(d.get("state") or {})
                outp = st.get("output")
                if isinstance(outp, str) and len(outp) > OUTPUT_TRUNC:
                    st["output"] = outp[:OUTPUT_TRUNC] + \
                        f"\n...[truncated {len(outp) - OUTPUT_TRUNC} chars]"
                out.append(Part(type="tool", tool=d.get("tool", ""),
                                call_id=d.get("callID", ""), state=st).__dict__)
        return out

    def get_raw(self, session_id: str) -> bytes:
        # 优先回放原始 model-io JSONL;无文件(如 subagent 会话)则导出 message 原始 JSON
        p = self._rollout_path(session_id)
        if p:
            with open(p, "rb") as f:
                return f.read()
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute("SELECT data FROM message WHERE session_id=? "
                        "ORDER BY time_created, sequence", (session_id,))
            return ("\n".join(r[0] for r in cur.fetchall())).encode("utf-8")
        finally:
            conn.close()

    def find_session_path(self, session_id: str):
        """有 model-io JSONL 时给真实文件路径,否则指向会话库定位。"""
        p = self._rollout_path(session_id)
        if p:
            return p
        return f"sqlite://{self.db_path}#session/{session_id}"

    def delete_session_rows(self, session_id: str) -> bool:
        """ZCode 源严格只读,永不删除任何数据。"""
        return False
