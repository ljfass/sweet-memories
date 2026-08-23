#!/usr/bin/env python3

import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("extract-assets.py")


class ExtractAssetsTest(unittest.TestCase):
    def run_validate(self, url: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["python3", str(SCRIPT), "--validate-url", url],
            capture_output=True,
            check=False,
            text=True,
        )

    def run_extract(
        self, page_url: str, html: str
    ) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as directory:
            html_path = Path(directory) / "index.html"
            html_path.write_text(html, encoding="utf-8")
            return subprocess.run(
                ["python3", str(SCRIPT), page_url, str(html_path)],
                capture_output=True,
                check=False,
                text=True,
            )

    def test_validates_monitor_urls(self) -> None:
        for valid_url in (
            "http://8.163.27.231",
            "https://example.com/site?check=1",
        ):
            with self.subTest(valid_url=valid_url):
                result = self.run_validate(valid_url)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, "")

        for invalid_url in (
            "",
            "ftp://example.com",
            "http://",
            "http://user:pass@example.com",
            "http://example.com/path with space",
            "http://example.com/path\nnext",
            "http://example.com/#fragment",
            "http://example.com:not-a-port",
        ):
            with self.subTest(invalid_url=invalid_url):
                result = self.run_validate(invalid_url)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("URL 无效", result.stderr)

    def test_extracts_resolves_and_deduplicates_assets(self) -> None:
        result = self.run_extract(
            "https://example.com/nested/index.html",
            """<!doctype html>
<html>
  <head>
    <script type=" Module " src="/assets/app.js"></script>
    <link rel="STYLESHEET" href="assets/app.css">
    <link rel="alternate stylesheet preload" href="assets/app.css">
  </head>
  <body><div id="app"></div></body>
</html>
""",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            [
                "https://example.com/nested/assets/app.css",
                "https://example.com/assets/app.js",
            ],
        )

    def test_requires_a_module_script_and_stylesheet(self) -> None:
        cases = (
            (
                '<div id="app"></div><link rel="stylesheet" href="/app.css">',
                "模块脚本",
            ),
            (
                '<div id="app"></div><script type="module" src="/app.js"></script>',
                "样式表",
            ),
        )
        for markup, message in cases:
            with self.subTest(message=message):
                result = self.run_extract(
                    "https://example.com/",
                    f"<!doctype html><html><head>{markup}</head></html>",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_rejects_cross_origin_and_non_http_assets(self) -> None:
        for asset in (
            "https://cdn.example.net/app.js",
            "data:text/javascript,alert(1)",
        ):
            with self.subTest(asset=asset):
                result = self.run_extract(
                    "https://example.com/",
                    f"""<!doctype html>
<html><head>
  <link rel="stylesheet" href="/app.css">
  <script type="module" src="{asset}"></script>
</head><body><div id="app"></div></body></html>
""",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("同源 HTTP(S) URL", result.stderr)

    def test_requires_the_vue_mount_point(self) -> None:
        result = self.run_extract(
            "https://example.com/",
            """<!doctype html>
<html><head>
  <link rel="stylesheet" href="/app.css">
  <script type="module" src="/app.js"></script>
</head><body><div data-id="app"></div></body></html>
""",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Vue 挂载点", result.stderr)


if __name__ == "__main__":
    unittest.main()
