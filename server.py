"""本地 HTTP 服务器:聚合三家 adapter,提供统一 API 与 SPA 前端。

端口默认 8092。只读所有数据来源。
"""
from __future__ import annotations
import os, sys, json, argparse, traceback, shutil, urllib.request, urllib.error, atexit, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from adapters.claude import ClaudeAdapter
from adapters.codex import CodexAdapter
from adapters.opencode import OpenCodeAdapter
from adapters.zcode import ZCodeAdapter
from adapters.catalog import (build_claude_catalog, build_codex_catalog,
                              build_opencode_catalog, build_zcode_catalog)
from adapters import cache as cache_mod
from adapters import session_meta as meta

ADAPTERS = {
    "claude": ClaudeAdapter(),
    "codex": CodexAdapter(),
    "opencode": OpenCodeAdapter(),
    "zcode": ZCodeAdapter(),
}
CATALOG_BUILDERS = {
    "claude": build_claude_catalog,
    "codex": build_codex_catalog,
    "opencode": build_opencode_catalog,
    "zcode": build_zcode_catalog,
}
# 只读源:数据文件不允许被本工具增删改(zcode 会话在 ZCode 客户端自有库中)。
# 标题别名等仍走 session_meta.json,不触碰源数据。
READONLY_SOURCES = {"zcode"}

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
HOST = "127.0.0.1"
PORT = 8092
PID_FILE = os.path.join(os.path.dirname(__file__), "data", "server.pid")


def extract_model_ids(payload) -> list[str]:
    """兼容常见 OpenAI/Anthropic 网关模型响应，并保留全部模型。"""
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = None
        for key in ("data", "models", "items", "results"):
            value = payload.get(key)
            if isinstance(value, list):
                rows = value
                break
            if isinstance(value, dict):
                for nested_key in ("data", "models", "items", "results"):
                    nested = value.get(nested_key)
                    if isinstance(nested, list):
                        rows = nested
                        break
            if rows is not None:
                break
        rows = rows or []
    else:
        rows = []
    result = []
    seen = set()
    for item in rows:
        if isinstance(item, dict):
            mid = item.get("id") or item.get("model") or item.get("model_id") or item.get("name")
        else:
            mid = item
        mid = str(mid or "").strip()
        if mid and mid not in seen:
            seen.add(mid)
            result.append(mid)
    return result


def apply_meta(source: str, res: dict) -> dict:
    """给 list_sessions 的结果套上标题别名 + 隐藏已软删会话。"""
    sessions = res.get("sessions", []) or []
    kept = []
    for s in sessions:
        rec = meta.get_record(source, s.get("id", ""))
        if rec.get("hidden"):
            continue
        if rec.get("titleAlias"):
            s = dict(s)
            s["titleAlias"] = rec["titleAlias"]
            s["title"] = rec["titleAlias"]
            s["titleOriginal"] = s.get("title", "")
        kept.append(s)
    res = dict(res)
    res["sessions"] = kept
    res["total"] = len(kept)
    return res


def _json(self, obj, status=200):
    body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
    self.end_headers()
    self.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    def _static(self, path):
        names = {"": "index.html", "/": "index.html",
                 "/index.html": "index.html", "/app.js": "app.js",
                 "/style.css": "style.css"}
        name = names.get(path)
        if not name:
            return False
        full = os.path.join(STATIC_DIR, name)
        if not os.path.exists(full):
            return False
        ctype = "text/html" if name.endswith(".html") else (
            "text/javascript" if name.endswith(".js") else "text/css")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)
        return True

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path
        # SPA 前端路由
        if path.startswith("/session/") or path in ("", "/", "/index.html",
                                                     "/app.js", "/style.css"):
            if not self._static(path):
                self._static("")
            return
        try:
            if path == "/api/health":
                return _json(self, {"ok": True, "sources": list(ADAPTERS),
                                     "port": PORT})
            if path == "/api/sources":
                out = {}
                for k, a in ADAPTERS.items():
                    try:
                        r = a.list_sessions(limit=1)
                        out[k] = {"available": True, "total": r["total"]}
                    except Exception as e:
                        out[k] = {"available": False, "error": str(e)}
                return _json(self, out)
            if path == "/api/catalog":
                source = q.get("source", ["claude"])[0]
                refresh = "refresh" in q
                project_root = q.get("projectRoot", [""])[0]
                builder = CATALOG_BUILDERS.get(source)
                if not builder:
                    return _json(self, {"error": "unknown source"}, 400)
                try:
                    data = cache_mod.catalog(source, lambda: builder(project_root),
                                            refresh=refresh, project_root=project_root)
                    return _json(self, data)
                except Exception as e:
                    traceback.print_exc()
                    return _json(self, {"error": str(e)}, 500)
            if path == "/api/sessions":
                source = q.get("source", ["claude"])[0]
                a = ADAPTERS.get(source)
                refresh = "refresh" in q
                if not a:
                    return _json(self, {"error": "unknown source"}, 400)
                res = cache_mod.sessions(source, lambda: apply_meta(source, a.list_sessions(
                    q=q.get("q", [""])[0], project=q.get("project", [""])[0],
                    limit=int(q.get("limit", ["200"])[0]),
                    offset=int(q.get("offset", ["0"])[0]))), refresh=refresh)
                return _json(self, res)
            if path == "/api/session":
                source = q.get("source", ["claude"])[0]
                sid = q.get("id", [""])[0]
                a = ADAPTERS.get(source)
                if not a or not sid:
                    return _json(self, {"error": "need source&id"}, 400)
                d = a.get_session(sid)
                rec = meta.get_record(source, sid)
                if rec.get("titleAlias") and d.get("session"):
                    d["session"] = dict(d["session"])
                    d["session"]["titleAlias"] = rec["titleAlias"]
                    d["session"]["title"] = rec["titleAlias"]
                # 注入具体磁盘文件路径,前端 meta 区展示+定位(Claude=.jsonl, Codex=.jsonl 目录, Opencode=db)
                try:
                    fp = a.find_session_path(sid)
                except Exception:
                    fp = None
                if fp and d.get("session") is not None:
                    d["session"] = dict(d["session"])
                    d["session"]["filePath"] = fp
                return _json(self, d)
            if path == "/api/raw":
                source = q.get("source", ["opencode"])[0]
                sid = q.get("id", [""])[0]
                a = ADAPTERS.get(source)
                if not a or not sid:
                    return _json(self, {"error": "need source&id"}, 400)
                body = a.get_raw(sid)
                self.send_response(200)
                self.send_header("Content-Type", "application/jsonl; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(404)
        except Exception as e:
            traceback.print_exc()
            _json(self, {"error": str(e)}, 500)

    def _read_body(self):
        ln = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(ln) if ln else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _invalidate_sessions_cache(self, source):
        cache_mod.write_cache(f"sessions_{source}.json", {"__force_invalid__": True})
        # 直接删缓存,下次请求会重扫(并套上新 meta)
        p = cache_mod._path(f"sessions_{source}.json")
        try:
            p.unlink()
        except Exception:
            pass

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_body()
            source = (body.get("source") or "").strip()
            sid = (body.get("sessionId") or body.get("id") or "").strip()
            if path in ("/api/sessions/delete", "/api/sessions/delete-local") \
                    and source in READONLY_SOURCES:
                return _json(self, {"error": f"{source} 源为只读,不允许删除会话"}, 403)
            a = ADAPTERS.get(source)
            if path == "/api/sessions/meta":
                if not source or not sid:
                    return _json(self, {"error": "need source&sessionId"}, 400)
                meta.set_title_alias(source, sid, body.get("titleAlias", ""))
                self._invalidate_sessions_cache(source)
                return _json(self, {"ok": True})
            if path == "/api/sessions/delete":
                if not source or not sid or not a:
                    return _json(self, {"error": "need source&sessionId"}, 400)
                fp = a.find_session_path(sid) if hasattr(a, "find_session_path") else None
                if fp:
                    r = meta.soft_delete_file(source, sid, fp)
                elif source == "opencode":
                    r = meta.soft_delete_db(source, sid)
                else:
                    return _json(self, {"error": "找不到会话文件"}, 404)
                self._invalidate_sessions_cache(source)
                return _json(self, r)
            if path == "/api/sessions/delete-local":
                if not source or not sid or not a:
                    return _json(self, {"error": "need source&sessionId"}, 400)
                fp = a.find_session_path(sid) if hasattr(a, "find_session_path") else None
                if fp:
                    r = meta.hard_delete_file(source, sid, fp)
                elif source == "opencode":
                    r = meta.hard_delete_db(source, sid, lambda s: a.delete_session_rows(s))
                else:
                    return _json(self, {"error": "找不到会话文件"}, 404)
                self._invalidate_sessions_cache(source)
                return _json(self, r)
            if path == "/api/sessions/restore":
                if not source or not sid:
                    return _json(self, {"error": "need source&sessionId"}, 400)
                meta.restore(source, sid)
                self._invalidate_sessions_cache(source)
                return _json(self, {"ok": True})
            if path == "/api/shutdown":
                # 仅监听 127.0.0.1；异步关闭，确保响应先成功写回。
                _json(self, {"ok": True, "message": "server stopping"})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if path == "/api/models":
                # 后端代理拉取 OpenAI 兼容 /v1/models,规避浏览器 CORS。
                # 临时会话命令生成器填 base+key 后用此接口拿模型下拉。
                base = (body.get("base") or "").strip()
                key = (body.get("key") or "").strip()
                if not base:
                    return _json(self, {"error": "need base"}, 400)
                url = base.rstrip("/")
                if url.endswith("/v1/models") or url.endswith("/models"):
                    pass
                elif "/v1" in url:
                    url = url + "/models"
                else:
                    url = url + "/v1/models"
                req = urllib.request.Request(url, headers={
                    "Authorization": f"Bearer {key}" if key else "",
                    "Accept": "application/json"})
                try:
                    with urllib.request.urlopen(req, timeout=20) as resp:
                        payload = json.loads(resp.read().decode("utf-8", "replace"))
                    models = extract_model_ids(payload)
                    return _json(self, {"models": models, "total": len(models)})
                except urllib.error.HTTPError as e:
                    return _json(self, {"error": f"HTTP {e.code}: {e.reason}"}, 502)
                except Exception as e:
                    return _json(self, {"error": str(e)}, 502)
            self.send_error(404)
        except Exception as e:
            traceback.print_exc()
            _json(self, {"error": str(e)}, 500)

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--open", action="store_true")
    args = ap.parse_args()
    # ThreadingHTTPServer:单个慢/大响应不阻塞其他请求(并发用)
    from http.server import ThreadingHTTPServer as _TS
    httpd = _TS((HOST, args.port), Handler)
    os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
    with open(PID_FILE, "w", encoding="ascii") as f:
        f.write(str(os.getpid()))
    def _remove_pid():
        try:
            with open(PID_FILE, "r", encoding="ascii") as f:
                if f.read().strip() != str(os.getpid()):
                    return
            os.remove(PID_FILE)
        except OSError:
            pass
    atexit.register(_remove_pid)
    url = f"http://{HOST}:{args.port}"
    print(f"OpenAgent Session Viewer -> {url}", flush=True)
    if args.open:
        # 在子线程里开浏览器,避免 Edge 进程僵死阻塞 serve_forever
        import threading, webbrowser
        def _open():
            try: webbrowser.open(url, new=2)
            except Exception: pass
        threading.Thread(target=_open, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        _remove_pid()


if __name__ == "__main__":
    main()
