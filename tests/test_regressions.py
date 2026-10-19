import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from adapters import cache


class RegressionTests(unittest.TestCase):
    def test_extract_model_ids_supports_multiple_gateway_shapes(self):
        self.assertEqual(
            server.extract_model_ids({"data": [{"id": "gpt-a"}, {"id": "gpt-b"}, {"id": "gpt-a"}]}),
            ["gpt-a", "gpt-b"],
        )
        self.assertEqual(
            server.extract_model_ids({"models": [{"model": "claude-a"}, {"name": "claude-b"}]}),
            ["claude-a", "claude-b"],
        )
        self.assertEqual(
            server.extract_model_ids({"data": {"models": ["one", "two"]}}),
            ["one", "two"],
        )

    def test_catalog_refresh_rebuilds_and_overwrites_project_cache(self):
        old_data_dir = cache.DATA_DIR
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cache.DATA_DIR = Path(tmp)
                calls = []

                def builder():
                    calls.append(1)
                    return {"counts": {"tools": len(calls)}, "tools": list(range(len(calls)))}

                first = cache.catalog("codex", builder, refresh=False, project_root="D:/demo")
                cached = cache.catalog("codex", builder, refresh=False, project_root="D:/demo")
                refreshed = cache.catalog("codex", builder, refresh=True, project_root="D:/demo")

                self.assertEqual(first["counts"]["tools"], 1)
                self.assertEqual(cached["counts"]["tools"], 1)
                self.assertEqual(refreshed["counts"]["tools"], 2)
                self.assertEqual(len(calls), 2)
        finally:
            cache.DATA_DIR = old_data_dir

    def test_frontend_uses_explicit_refresh_and_input_suggestion_list(self):
        root = Path(__file__).resolve().parents[1]
        js = (root / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("'&refresh=1'", js)
        self.assertIn("loadCatalog(true);", js)
        self.assertNotIn("input.setAttribute('list', dlId)", js)
        self.assertNotIn("combo-toggle", js)
        self.assertNotIn("combo-del", js)
        self.assertIn("combo-input-list", js)
        self.assertIn("document.addEventListener('scroll', onDocumentScroll, true)", js)

    def test_zcode_adapter_normalizes_sqlite_and_stays_readonly(self):
        import json as _j
        import sqlite3
        from adapters.zcode import ZCodeAdapter
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "db.sqlite"
            conn = sqlite3.connect(db)
            conn.executescript("""
                CREATE TABLE session (id text primary key, project_id text, directory text,
                    title text, version text, task_type text default 'interactive',
                    time_created integer, time_updated integer,
                    title_source text default 'first_input');
                CREATE TABLE message (id text primary key, session_id text,
                    time_created integer, time_updated integer, data text, sequence integer);
                CREATE TABLE part (id text primary key, message_id text, session_id text,
                    time_created integer, time_updated integer, data text, sequence integer);
                CREATE TABLE model_usage (id text primary key, session_id text, model_id text,
                    input_tokens integer, output_tokens integer, reasoning_tokens integer,
                    cache_read_input_tokens integer, cache_creation_input_tokens integer,
                    status text, started_at integer, query_source text, provider_id text);
            """)
            conn.execute("INSERT INTO session VALUES "
                         "('sess_t1','proj_x','C:\\tmp\\demo','标题T','0.16.5',"
                         "'interactive',1000,2000,'first_input')")
            long_out = "x" * 9000
            msgs = [
                ("m1", 100, {"role": "user", "cost": 0},
                 [("p1", 10, {"type": "text", "text": "你好"})]),
                ("m2", 200, {"role": "assistant", "cost": 0},
                 [("p2", 20, {"type": "reasoning", "text": "想一下"}),
                  ("p3", 21, {"type": "tool", "tool": "Bash", "callID": "call_1",
                              "state": {"status": "completed", "input": {},
                                        "output": long_out}}),
                  ("p4", 22, {"type": "step-start"}),
                  ("p5", 23, {"type": "step-finish", "tokens": {}})]),
                ("m3", 300, {"role": "assistant", "error": {"name": "RateLimit"}},
                 [("p6", 30, {"type": "step-start"})]),
            ]
            for mid, ts, data, parts in msgs:
                conn.execute("INSERT INTO message VALUES (?,?,?,?,?,?)",
                             (mid, "sess_t1", ts, ts, _j.dumps(data), ts))
                for pid, pts, pdata in parts:
                    conn.execute("INSERT INTO part VALUES (?,?,?,?,?,?,?)",
                                 (pid, mid, "sess_t1", pts, pts, _j.dumps(pdata), pts))
            conn.execute("INSERT INTO model_usage VALUES "
                         "('u1','sess_t1','GLM-Test',100,50,5,10,2,"
                         "'completed',0,'chat','p')")
            conn.commit()
            conn.close()

            a = ZCodeAdapter(db_path=str(db), rollout_dir=str(Path(tmp) / "none"))
            res = a.list_sessions()
            self.assertEqual(res["total"], 1)
            s = res["sessions"][0]
            self.assertEqual(s["title"], "标题T")
            self.assertEqual(s["project"], "C:\\tmp\\demo")
            self.assertEqual(s["model"], "GLM-Test")
            self.assertEqual(s["message_count"], 3)
            self.assertEqual(s["tokens"]["input"], 100)

            d = a.get_session("sess_t1")
            roles = [m["role"] for m in d["messages"]]
            self.assertEqual(roles, ["user", "assistant"])  # 错误占位消息被剔除
            parts2 = d["messages"][1]["parts"]
            self.assertEqual([p["type"] for p in parts2], ["reasoning", "tool"])  # step-* 不进时间线
            self.assertEqual(parts2[1]["tool"], "Bash")
            self.assertEqual(parts2[1]["call_id"], "call_1")
            self.assertLessEqual(len(parts2[1]["state"]["output"]), 8100)  # 超长输出被截断

            raw = a.get_raw("sess_t1").decode("utf-8")
            self.assertIn('"role": "user"', raw)

            self.assertFalse(a.delete_session_rows("sess_t1"))  # 永不删除
            ro = a._conn()  # 只读连接:写入必须被 SQLite 拒绝
            with self.assertRaises(sqlite3.Error):
                ro.execute("DELETE FROM session")
            ro.close()

    def test_zcode_is_registered_readonly_source(self):
        self.assertIn("zcode", server.ADAPTERS)
        self.assertIn("zcode", server.READONLY_SOURCES)
        self.assertIn("zcode", server.CATALOG_BUILDERS)

    def test_content_search_engine_finds_claude_text(self):
        import tempfile, os
        from adapters import content_search
        q = content_search.compile_query("HomeArt")
        self.assertEqual(q["literal"], "HomeArt")  # 字面模式走快路径
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "abc123.jsonl")
            with open(p, "w", encoding="utf-8") as f:
                f.write(json.dumps({"type": "user", "message": {"content": [
                    {"type": "text", "text": "帮我修复 HomeArt 的登录 bug"}]}}) + "\n")
                f.write(json.dumps({"type": "assistant", "message": {"content": [
                    {"type": "text", "text": "好的,我来看看登录逻辑。"}]}}) + "\n")
            res = content_search.search_jsonl_dir(tmp, content_search._extract_claude_texts, q, 10)
            self.assertEqual(len(res), 1)
            self.assertEqual(res[0]["sessionId"], "abc123")
            m = res[0]["matches"][0]
            self.assertIn("HomeArt", m["snippet"])
            self.assertEqual(
                m["snippet"][m["hitStart"]:m["hitEnd"]], "HomeArt")
            # 未命中关键词返回空
            self.assertEqual(
                content_search.search_jsonl_dir(
                    tmp, content_search._extract_claude_texts,
                    content_search.compile_query("不存在的词"), 10), [])

    def test_compile_query_modes(self):
        from adapters import content_search as cs
        # 1) 字面串
        q = cs.compile_query("HomeArt")
        self.assertIsNone(q["regex"]); self.assertEqual(q["literal"], "HomeArt")
        # 2) /.../ 显式正则
        q = cs.compile_query("/sk-\\w{16,}/")
        self.assertIsNotNone(q["regex"]); self.assertIsNone(q["literal"])
        self.assertEqual(q["regex"].pattern, r"sk-\w{16,}")
        # 3) re: 描述
        q = cs.compile_query("re:手机号")
        self.assertIsNotNone(q["regex"])
        self.assertIsNotNone(q["regex"].search("联系电话13663883357收尾"))
        self.assertIsNone(q["regex"].search("12345"))
        # 4) 自动探测:像正则且能编译
        q = cs.compile_query("sk-[A-Za-z0-9]{16,}")
        self.assertIsNotNone(q["regex"])
        # 有正则特征但编不过 -> 回退字面(如普通文件名)
        q = cs.compile_query("文件(1).txt")
        self.assertIsNone(q["regex"]); self.assertEqual(q["literal"], "文件(1).txt")
        # 5) 无效正则/未知描述 -> InvalidQuery(ValueError)
        with self.assertRaises(cs.InvalidQuery):
            cs.compile_query("/[invalid(/")
        with self.assertRaises(cs.InvalidQuery):
            cs.compile_query("re:不存在的模式")
        with self.assertRaises(cs.InvalidQuery):
            cs.compile_query("  ")
        # search() 透传 regexSource/mode
        out = cs.search("claude", "/HomeArt/", limit=5)
        self.assertEqual(out["regexSource"], "HomeArt")
        self.assertIn("正则", out["mode"])

    def test_regex_mode_hits_via_engine(self):
        import tempfile, os
        from adapters import content_search as cs
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "reg123.jsonl")
            with open(p, "w", encoding="utf-8") as f:
                f.write(json.dumps({"type": "user", "message": {"content": [
                    {"type": "text", "text": "key: sk-abcdef1234567890abcd 结束"}]}}) + "\n")
            q = cs.compile_query("re:密钥")
            res = cs.search_jsonl_dir(tmp, cs._extract_claude_texts, q, 10)
            self.assertEqual(len(res), 1)
            m = res[0]["matches"][0]
            self.assertEqual(
                m["snippet"][m["hitStart"]:m["hitEnd"]], "sk-abcdef1234567890abcd")

    def test_frontend_search_is_client_side_and_fulltext_ui_exists(self):
        root = Path(__file__).resolve().parents[1]
        js = (root / "static" / "app.js").read_text(encoding="utf-8")
        html = (root / "static" / "index.html").read_text(encoding="utf-8")
        # 元数据过滤走客户端 DOM(不再经服务端缓存吞 q)
        self.assertIn("filterSessionsClient", js)
        self.assertNotIn("/api/sessions?source=${state.source}&limit=300&q=", js)
        # 全文搜索 UI + API 已接上
        self.assertIn("search-full-chk", js)
        self.assertIn("/api/search?source=", js)
        self.assertIn('id="search-full-chk"', html)
        # 会话列表存进 state 供全文结果复用标题
        self.assertIn("state.lastSessions", js)


if __name__ == "__main__":
    unittest.main()
