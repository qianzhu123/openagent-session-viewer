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


if __name__ == "__main__":
    unittest.main()
