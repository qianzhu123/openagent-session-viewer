"""会话正文全文搜索(只读,按需扫描,不落缓存)。

各 source 的扫描方式:
- claude: 逐行扫 .jsonl,提取 user/assistant 消息文本。
- codex: 明文 .jsonl + 压缩 .jsonl.zst(新版 codex 自动归档旧会话;zstandard 可选依赖)。
- opencode/zcode: sqlite part 表 json LIKE 定位,再解析片段。

限额(防大库拖死请求):
- 每 source 最多扫 MAX_FILES 个最近修改的文件(opencode/zcode 无文件粒度,以 LIMIT 替代)。
- 每会话最多 HITS_PER_SESSION 条片段,整体最多 MAX_RESULTS 条。
片段只回传命中位置前后 CONTEXT 个字符,配合前端 <mark> 高亮。
"""
from __future__ import annotations
import glob, json, os, re, sqlite3

MAX_FILES = 600
MAX_RESULTS = 200
HITS_PER_SESSION = 3
CONTEXT = 60
# sqlite LIKE 一次粗筛的每库行数上限(粗筛后仍需 python 精查,超限截断)
SQLITE_SCAN_CAP = 20000


def _clip(text: str, start: int, end: int):
    """截取 [start,end) 命中点附近片段,返回 (片段文本, 命中起点在片段中的下标)。"""
    s = max(0, start - CONTEXT)
    e = min(len(text), end + CONTEXT)
    frag = text[s:e].replace("\n", " ").replace("\t", " ")
    lead = "…" if s > 0 else ""
    trail = "…" if e < len(text) else ""
    return lead + frag + trail, (start - s) + len(lead)


def _extract_claude_texts(path: str):
    """产出 (offset, text)。只取 user/assistant 的 text/reasoning 内容。"""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("type") not in ("user", "assistant") or ev.get("isMeta"):
                    continue
                msg = ev.get("message", {})
                content = msg.get("content", [])
                if isinstance(content, str):
                    yield content
                elif isinstance(content, list):
                    for c in content:
                        if isinstance(c, str):
                            yield c
                        elif isinstance(c, dict) and c.get("type") in ("text", "thinking"):
                            yield c.get("text", "") or c.get("thinking", "") or ""
    except Exception:
        return


def _read_maybe_zst(path: str):
    """明文 jsonl 直接逐行; .jsonl.zst 解压后逐行(zstandard 缺失则跳过)。"""
    if path.endswith(".zst"):
        try:
            import zstandard
        except ImportError:
            return
        try:
            with open(path, "rb") as f:
                dctx = zstandard.ZstdDecompressor()
                with dctx.stream_reader(f) as r:
                    data = r.read()
            for line in data.decode("utf-8", errors="replace").splitlines():
                yield line
        except Exception:
            return
    else:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                yield line


def _extract_codex_texts(path: str):
    for line in _read_maybe_zst(path):
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t, pl = ev.get("type"), ev.get("payload", {}) or {}
        if t == "event_msg" and pl.get("type") in ("user_message", "agent_message"):
            yield pl.get("message", "") or ""
        elif t == "response_item" and pl.get("type") == "message":
            for c in pl.get("content", []) or []:
                if isinstance(c, dict) and c.get("type") in ("input_text", "output_text", "text"):
                    yield c.get("text", "") or ""


def search_jsonl_dir(root: str, extractor, needle: str, limit: int = MAX_RESULTS):
    """扫 root 下所有 .jsonl / .jsonl.zst(按 mtime 取最近的 MAX_FILES 个),返回命中会话列表。"""
    files = glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)
    files += glob.glob(os.path.join(root, "**", "*.jsonl.zst"), recursive=True)
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    files = files[:MAX_FILES]
    by_session = {}
    for p in files:
        sid = os.path.splitext(os.path.splitext(os.path.basename(p))[0])[0]
        hits = by_session.setdefault(sid, {"sessionId": sid, "filePath": p, "matches": []})
        for text in extractor(p):
            if not text or needle not in text:
                continue
            for m in re.finditer(re.escape(needle), text):
                if len(hits["matches"]) >= HITS_PER_SESSION:
                    break
                frag, pos = _clip(text, m.start(), m.end())
                hits["matches"].append({"snippet": frag, "hitStart": pos, "hitEnd": pos + len(needle)})
        if len(hits["matches"]) == 0:
            by_session.pop(sid, None)
        if len(by_session) >= limit:
            break
    # 按文件修改时间排序(与列表一致)
    out = sorted(by_session.values(), key=lambda h: os.path.getmtime(h["filePath"]), reverse=True)
    return out[:limit]


def _search_sqlite_parts(db_path: str, tables: dict, needle: str, limit: int,
                         sid_col: str = "session_id", data_col: str = "data"):
    """opencode/zcode 共用:part 表 data JSON LIKE 粗筛 -> python 精查。"""
    if not os.path.exists(db_path):
        return []
    con = sqlite3.connect(f"file:{db_path.replace(os.sep, '/')}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        cur = con.cursor()
        sql = (f"SELECT p.{sid_col} AS sid, p.{data_col} AS data "
               f"FROM {tables['part']} p WHERE p.{data_col} LIKE ? LIMIT ?")
        rows = cur.execute(sql, (f"%{needle}%", SQLITE_SCAN_CAP)).fetchall()
        by_session = {}
        for r in rows:
            try:
                d = json.loads(r["data"])
            except Exception:
                continue
            if d.get("type") not in ("text", None):
                continue
            text = d.get("text", "") or ""
            if needle not in text:
                continue
            sid = r["sid"]
            hits = by_session.setdefault(sid, {"sessionId": sid, "filePath": None, "matches": []})
            if len(hits["matches"]) >= HITS_PER_SESSION:
                continue
            for m in re.finditer(re.escape(needle), text):
                if len(hits["matches"]) >= HITS_PER_SESSION:
                    break
                frag, pos = _clip(text, m.start(), m.end())
                hits["matches"].append({"snippet": frag, "hitStart": pos, "hitEnd": pos + len(needle)})
        out = list(by_session.values())[:limit]
        return out
    finally:
        con.close()


def search(source: str, needle: str, limit: int = 50):
    """统一入口。返回 [{sessionId, filePath, matches:[{snippet,hitStart,hitEnd}]}]。"""
    needle = (needle or "").strip()
    if not needle:
        return []
    if source == "claude":
        return search_jsonl_dir(os.path.expanduser("~/.claude/projects"),
                                _extract_claude_texts, needle, limit)
    if source == "codex":
        from .codex import ROOT
        return search_jsonl_dir(ROOT, _extract_codex_texts, needle, limit)
    if source == "opencode":
        from .opencode import DB_PATH
        return _search_sqlite_parts(
            DB_PATH, {"part": "part"}, needle, limit)
    if source == "zcode":
        from .zcode import DB_PATH as ZDB
        return _search_sqlite_parts(
            ZDB, {"part": "part"}, needle, limit)
    return []
