r"""会话正文全文搜索(只读,按需扫描,不落缓存)。

各 source 的扫描方式:
- claude: 逐行扫 .jsonl,提取 user/assistant 消息文本。
- codex: 明文 .jsonl + 压缩 .jsonl.zst(新版 codex 自动归档旧会话;zstandard 可选依赖)。
- opencode/zcode: sqlite part 表 json LIKE 定位,再解析片段。

查询模式(compile_query 统一解析):
- 字面串(默认): HomeArt           -> 子串匹配,sqlite 走 LIKE 快路径
- 显式正则:     /sk-\w{16,}/       -> /.../ 包裹按正则编译
- 描述转正则:   re:手机号          -> 查 COMMON_PATTERNS 内置模式表
- 自动探测:     sk-\w{16,}         -> 含正则特征且能编译就按正则,否则当字面
限额(防大库拖死请求):
- 每 source 最多扫 MAX_FILES 个最近修改的文件(opencode/zcode 无文件粒度,以 LIMIT 替代)。
- 每会话最多 HITS_PER_SESSION 条片段,整体最多 MAX_RESULTS 条。
- 单段文本最多 MAX_MATCHES_PER_TEXT 处命中(防灾难性回溯/超长文本卡死)。
片段只回传命中位置前后 CONTEXT 个字符,配合前端 <mark> 高亮。
"""
from __future__ import annotations
import glob, json, os, re, sqlite3

MAX_FILES = 600
MAX_RESULTS = 200
HITS_PER_SESSION = 3
CONTEXT = 60
MAX_MATCHES_PER_TEXT = 1000
# sqlite LIKE 一次粗筛的每库行数上限(粗筛后仍需 python 精查,超限截断)
SQLITE_SCAN_CAP = 20000

# ---------- 常用模式表(描述 -> 正则)。别名全小写匹配,中文别名原样。 ----------
COMMON_PATTERNS = {
    "手机号": r"(?<!\d)1[3-9]\d{9}(?!\d)",
    "手机": r"(?<!\d)1[3-9]\d{9}(?!\d)",
    "电话": r"(?<!\d)1[3-9]\d{9}(?!\d)",
    "身份证": r"(?<!\d)\d{17}[\dXx](?!\d)",
    "身份证号": r"(?<!\d)\d{17}[\dXx](?!\d)",
    "邮箱": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "ip": r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
    "ip地址": r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
    "url": r"https?://[^\s\"'<>]+",
    "网址": r"https?://[^\s\"'<>]+",
    "链接": r"https?://[^\s\"'<>]+",
    "密钥": r"sk-[A-Za-z0-9_-]{16,}",
    "api密钥": r"sk-[A-Za-z0-9_-]{16,}",
    "日期": r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?",
}


class InvalidQuery(ValueError):
    """无效查询(如正则编译失败/未知描述),路由层转 400。"""


# 自动探测:含这些"强正则特征"才当正则试编译(括号/点号太常见,不能算,
# 否则 "文件(1).txt" 这类普通名字会被误判)
_REGEX_HINT = re.compile(r'[\\\[\]{}|^$*+?]')


def compile_query(raw: str):
    """解析查询串 -> dict {regex: 编译后Pattern|None, literal: str|None, label: str}。

    regex 优先;literal 仅在纯字面模式返回(两者互斥)。
    抛 InvalidQuery(=ValueError) 当显式正则/描述模式无法解析。
    """
    raw = (raw or "").strip()
    if not raw:
        raise InvalidQuery("空查询")
    # 1) /.../ 显式正则
    if len(raw) >= 2 and raw.startswith("/") and raw.endswith("/"):
        pat = raw[1:-1]
        try:
            return {"regex": re.compile(pat), "literal": None, "label": f"正则 /{pat}/"}
        except re.error as e:
            raise InvalidQuery(f"无效正则 /{pat}/: {e}")
    # 2) re: 描述
    if raw.lower().startswith("re:"):
        desc = raw[3:].strip().lower()
        pat = COMMON_PATTERNS.get(desc)
        if not pat:
            known = "、".join(sorted(set(COMMON_PATTERNS)))
            raise InvalidQuery(f"未知模式「{desc}」,可用: {known}")
        return {"regex": re.compile(pat), "literal": None, "label": f"模式:{desc}"}
    # 3) 自动探测:像正则且能编译 -> 正则;否则字面
    if _REGEX_HINT.search(raw):
        try:
            return {"regex": re.compile(raw), "literal": None, "label": f"正则 /{raw}/"}
        except re.error:
            pass  # 有特征但编不过 -> 当字面串(如 "文件(1).txt")
    return {"regex": None, "literal": raw, "label": f"字面「{raw}」"}


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


def _iter_matches(q: dict, text: str):
    """按查询类型产出 (start, end) 命中区间,单段文本封顶 MAX_MATCHES_PER_TEXT。"""
    if not text:
        return
    if q["regex"] is not None:
        n = 0
        for m in q["regex"].finditer(text):
            yield m.start(), m.end()
            n += 1
            if n >= MAX_MATCHES_PER_TEXT:
                break
    else:
        lit = q["literal"]
        start = 0
        n = 0
        while True:
            i = text.find(lit, start)
            if i == -1:
                break
            yield i, i + len(lit)
            start = i + max(1, len(lit))
            n += 1
            if n >= MAX_MATCHES_PER_TEXT:
                break


def _hit(q: dict, text: str) -> bool:
    """快检:该段文本是否至少命中一次。"""
    if not text:
        return False
    if q["regex"] is not None:
        return q["regex"].search(text) is not None
    return q["literal"] in text


def search_jsonl_dir(root: str, extractor, q: dict, limit: int = MAX_RESULTS):
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
            if not _hit(q, text):
                continue
            for start, end in _iter_matches(q, text):
                if len(hits["matches"]) >= HITS_PER_SESSION:
                    break
                frag, pos = _clip(text, start, end)
                hits["matches"].append({"snippet": frag, "hitStart": pos, "hitEnd": pos + (end - start)})
        if len(hits["matches"]) == 0:
            by_session.pop(sid, None)
        if len(by_session) >= limit:
            break
    # 按文件修改时间排序(与列表一致)
    out = sorted(by_session.values(), key=lambda h: os.path.getmtime(h["filePath"]), reverse=True)
    return out[:limit]


def _search_sqlite_parts(db_path: str, tables: dict, q: dict, limit: int,
                         sid_col: str = "session_id", data_col: str = "data"):
    """opencode/zcode 共用:part 表 data 粗筛 -> python 精查。

    字面模式走 LIKE 快路径;正则模式 LIKE 无法表达,分批全扫(CAP 限行数)。
    """
    if not os.path.exists(db_path):
        return []
    con = sqlite3.connect(f"file:{db_path.replace(os.sep, '/')}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        cur = con.cursor()
        if q["literal"] is not None:
            sql = (f"SELECT p.{sid_col} AS sid, p.{data_col} AS data "
                   f"FROM {tables['part']} p WHERE p.{data_col} LIKE ? LIMIT ?")
            rows = cur.execute(sql, (f"%{q['literal']}%", SQLITE_SCAN_CAP)).fetchall()
        else:
            # 正则模式:分批扫,总量仍受 SQLITE_SCAN_CAP 限制
            rows = cur.execute(
                f"SELECT p.{sid_col} AS sid, p.{data_col} AS data "
                f"FROM {tables['part']} p LIMIT ?", (SQLITE_SCAN_CAP,)).fetchall()
        by_session = {}
        for r in rows:
            try:
                d = json.loads(r["data"])
            except Exception:
                continue
            if d.get("type") not in ("text", None):
                continue
            text = d.get("text", "") or ""
            if not _hit(q, text):
                continue
            sid = r["sid"]
            hits = by_session.setdefault(sid, {"sessionId": sid, "filePath": None, "matches": []})
            if len(hits["matches"]) >= HITS_PER_SESSION:
                continue
            for start, end in _iter_matches(q, text):
                if len(hits["matches"]) >= HITS_PER_SESSION:
                    break
                frag, pos = _clip(text, start, end)
                hits["matches"].append({"snippet": frag, "hitStart": pos, "hitEnd": pos + (end - start)})
        out = list(by_session.values())[:limit]
        return out
    finally:
        con.close()


def search(source: str, raw_query: str, limit: int = 50):
    """统一入口。raw_query 支持字面/正则/描述模式(见 compile_query)。

    返回 {results: [...], query: 原始串, regexSource: 正则源|None, mode: label}。
    """
    q = compile_query(raw_query)
    if source == "claude":
        results = search_jsonl_dir(os.path.expanduser("~/.claude/projects"),
                                   _extract_claude_texts, q, limit)
    elif source == "codex":
        from .codex import ROOT
        results = search_jsonl_dir(ROOT, _extract_codex_texts, q, limit)
    elif source == "opencode":
        from .opencode import DB_PATH
        results = _search_sqlite_parts(DB_PATH, {"part": "part"}, q, limit)
    elif source == "zcode":
        from .zcode import DB_PATH as ZDB
        results = _search_sqlite_parts(ZDB, {"part": "part"}, q, limit)
    else:
        results = []
    return {"results": results, "query": (raw_query or "").strip(),
            "regexSource": q["regex"].pattern if q["regex"] is not None else None,
            "mode": q["label"]}
