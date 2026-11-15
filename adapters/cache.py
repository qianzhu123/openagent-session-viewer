"""会话列表与本地索引的本地缓存。

data/sessions_<source>.json   会话列表缓存(避免每次重扫)
data/catalog_<source>.json    本地索引缓存

策略:
- 首次访问:fresh 扫描 -> 写缓存 -> 返回。
- 之后访问:读缓存秒回。
- refresh=True 或缓存不存在:强制重扫写缓存。
- 缓存带 generatedAt,前端展示更新时间。
"""
from __future__ import annotations
import os, json, time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def _path(name: str) -> Path:
    return DATA_DIR / name


def read_cache(name: str):
    p = _path(name)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_cache(name: str, data: dict):
    # 原子写:先写 .tmp 再 replace,避免并发请求交错写坏缓存文件
    p = _path(name)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def title_index(source: str, files: list, reader) -> dict:
    """路径 -> 标题头信息缓存:只重读 mtime/size 变化过的文件。

    列表页只需要标题/项目等元数据,但 jsonl 会话文件动辄数百 MB,
    全量重读只为取标题要 10s+(claude 源 1.3GB 实测 13.5s)。
    本索引让刷新只 stat 全部文件、重读有变化的那几个,其余秒回。

    reader(path) 返回要缓存的字段 dict(如 {"title": ...});mtime/size 由本函数补记。
    """
    name = f"titleindex_{source}.json"
    idx = read_cache(name)
    if not isinstance(idx, dict):
        idx = {}
    changed = False
    for p in files:
        try:
            st = os.stat(p)
        except OSError:
            idx.pop(p, None)
            changed = True
            continue
        e = idx.get(p)
        if e and e.get("mtime") == st.st_mtime and e.get("size") == st.st_size:
            continue
        try:
            entry = reader(p) or {}
        except Exception:
            entry = {}
        entry["mtime"] = st.st_mtime
        entry["size"] = st.st_size
        idx[p] = entry
        changed = True
    alive = set(files)
    for p in [k for k in idx if k not in alive]:
        del idx[p]
        changed = True
    if changed:
        write_cache(name, idx)
    return idx


def _proj_key(project_root: str) -> str:
    """把项目路径转成安全的缓存文件名段。"""
    import re
    k = re.sub(r"[^A-Za-z0-9_.-]+", "_", (project_root or "").replace(":", "")).strip("_") or "default"
    return k[:80]


def catalog(source: str, builder, refresh: bool = False, project_root: str = "") -> dict:
    """builder() 返回 catalog dict(不含 generatedAt)。每个项目路径独立缓存。"""
    name = f"catalog_{source}__{_proj_key(project_root)}.json"
    if not refresh:
        cached = read_cache(name)
        if cached and cached.get("counts"):
            return cached
    data = builder()
    data["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    data["source"] = source
    data["projectRoot"] = project_root
    write_cache(name, data)
    return data


def sessions(source: str, lister, refresh: bool = False) -> dict:
    """lister() 返回 {sessions, projects, total}。仅缓存 sessions+projects,便于秒回。

    缓存策略:
    - refresh=True 或无缓存:重扫写缓存。
    - 有缓存:直接返回缓存(秒回)。
    刷新由调用方显式决定(前端"刷新会话"按钮,或浏览器 F5 触发)。
    """
    name = f"sessions_{source}.json"
    if refresh:
        res = lister()
        write_cache(name, {"sessions": res.get("sessions", []),
                           "projects": res.get("projects", []),
                           "total": res.get("total", 0),
                           "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
        return res
    cached = read_cache(name)
    return cached if cached else sessions(source, lister, refresh=True)
