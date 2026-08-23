# Production Site Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only GitHub Actions monitor that checks the production homepage and its directly referenced JavaScript/CSS every 30 minutes and on manual request.

**Architecture:** A Bash script owns bounded HTTP requests and failure reporting. A dependency-free Python helper uses standard HTML and URL parsers to extract same-origin assets. A separate GitHub Actions workflow only checks script syntax and runs the real monitor, while local integration and YAML contract tests cover failure behavior without touching production.

**Tech Stack:** Bash 3.2-compatible shell, Python 3 standard library, curl, GitHub Actions, Vitest, yaml

---

## File Map

- Create `scripts/monitor/extract-assets.py`: validate page URLs and extract same-origin module/CSS asset URLs from production HTML.
- Create `scripts/monitor/test_extract_assets.py`: subprocess-level unit tests for the parser CLI.
- Create `scripts/monitor/test-server.py`: deterministic local HTTP fixture used only by monitor integration tests.
- Create `scripts/monitor/check-site.sh`: perform bounded homepage and asset requests and clean temporary state.
- Create `scripts/monitor/check-site.test.sh`: exercise successful, retry, content, resource, validation, and cleanup paths.
- Create `scripts/monitor/workflow.test.ts`: parser-based contract tests for the monitor workflow.
- Create `.github/workflows/monitor.yml`: schedule and manually run the read-only monitor.
- Modify `package.json`: expose the monitor integration suite as `pnpm test:monitor`.
- Create `docs/monitoring.md`: beginner-oriented GitHub Variable setup, manual verification, and failure interpretation.

### Task 1: Structured HTML Asset Parser

**Files:**
- Create: `scripts/monitor/test_extract_assets.py`
- Create: `scripts/monitor/extract-assets.py`

- [ ] **Step 1: Write the failing parser CLI tests**

Create `scripts/monitor/test_extract_assets.py`:

```python
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
        self.assertEqual(self.run_validate("http://8.163.27.231").returncode, 0)
        self.assertEqual(
            self.run_validate("https://example.com/site?check=1").returncode,
            0,
        )

        for invalid_url in (
            "",
            "ftp://example.com",
            "http://",
            "http://user:pass@example.com",
            "http://example.com/path with space",
            "http://example.com/path\nnext",
            "http://example.com/#fragment",
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
    <link rel="stylesheet" href="assets/app.css">
    <link rel="stylesheet preload" href="assets/app.css">
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
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
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run:

```bash
python3 scripts/monitor/test_extract_assets.py
```

Expected: FAIL because `scripts/monitor/extract-assets.py` does not exist.

- [ ] **Step 3: Implement the dependency-free parser CLI**

Create `scripts/monitor/extract-assets.py`:

```python
#!/usr/bin/env python3

import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import List, Optional, Set, Tuple
from urllib.parse import SplitResult, urldefrag, urljoin, urlsplit


class MonitorInputError(ValueError):
    pass


def validate_page_url(value: str) -> SplitResult:
    if not value or any(character.isspace() for character in value):
        raise MonitorInputError("URL 无效：地址为空或包含空白字符。")

    parsed = urlsplit(value)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise MonitorInputError("URL 无效：只允许完整的 HTTP(S) 地址。")
    if parsed.username is not None or parsed.password is not None:
        raise MonitorInputError("URL 无效：地址不能包含用户名或密码。")
    if parsed.fragment:
        raise MonitorInputError("URL 无效：地址不能包含 fragment。")
    try:
        parsed.port
    except ValueError as error:
        raise MonitorInputError("URL 无效：端口不合法。") from error
    return parsed


def origin(parsed: SplitResult) -> Tuple[str, str, int]:
    default_port = 443 if parsed.scheme.lower() == "https" else 80
    return (
        parsed.scheme.lower(),
        (parsed.hostname or "").lower(),
        parsed.port or default_port,
    )


class AssetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.has_app_mount = False
        self.module_sources: List[str] = []
        self.stylesheet_sources: List[str] = []

    def handle_starttag(
        self, tag: str, attributes: List[Tuple[str, Optional[str]]]
    ) -> None:
        values = {name.lower(): value for name, value in attributes}
        if values.get("id") == "app":
            self.has_app_mount = True
        if tag.lower() == "script":
            script_type = (values.get("type") or "").strip().lower()
            source = values.get("src")
            if script_type == "module" and source:
                self.module_sources.append(source)
        if tag.lower() == "link":
            relations = {
                item.lower()
                for item in (values.get("rel") or "").split()
            }
            source = values.get("href")
            if "stylesheet" in relations and source:
                self.stylesheet_sources.append(source)


def resolve_asset(
    page_url: str, page_origin: Tuple[str, str, int], value: str
) -> str:
    if any(character.isspace() for character in value):
        raise MonitorInputError("资源不是同源 HTTP(S) URL：包含空白字符。")
    resolved, _fragment = urldefrag(urljoin(page_url, value))
    try:
        parsed = validate_page_url(resolved)
    except MonitorInputError as error:
        raise MonitorInputError(
            f"资源不是同源 HTTP(S) URL：{resolved}"
        ) from error
    if origin(parsed) != page_origin:
        raise MonitorInputError(f"资源不是同源 HTTP(S) URL：{resolved}")
    return resolved


def extract_assets(page_url: str, html_path: Path) -> List[str]:
    parsed_page = validate_page_url(page_url)
    parser = AssetParser()
    parser.feed(html_path.read_text(encoding="utf-8"))
    parser.close()

    if not parser.has_app_mount:
        raise MonitorInputError('HTML 缺少 Vue 挂载点 id="app"。')
    if not parser.module_sources:
        raise MonitorInputError("HTML 没有可巡检的模块脚本。")
    if not parser.stylesheet_sources:
        raise MonitorInputError("HTML 没有可巡检的样式表。")

    page_origin = origin(parsed_page)
    ordered_sources = parser.stylesheet_sources + parser.module_sources
    assets: List[str] = []
    seen: Set[str] = set()
    for source in ordered_sources:
        resolved = resolve_asset(page_url, page_origin, source)
        if resolved not in seen:
            seen.add(resolved)
            assets.append(resolved)
    return assets


def main(arguments: List[str]) -> int:
    try:
        if len(arguments) == 3 and arguments[1] == "--validate-url":
            validate_page_url(arguments[2])
            return 0
        if len(arguments) != 3:
            raise MonitorInputError(
                "用法：extract-assets.py --validate-url URL，"
                "或 extract-assets.py PAGE_URL HTML_FILE"
            )

        for asset in extract_assets(arguments[1], Path(arguments[2])):
            print(asset)
        return 0
    except (MonitorInputError, OSError, UnicodeError) as error:
        print(f"HTML 资源解析失败：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
```

- [ ] **Step 4: Run tests and syntax checks and verify GREEN**

Run:

```bash
python3 scripts/monitor/test_extract_assets.py
python3 -c 'compile(open("scripts/monitor/extract-assets.py", encoding="utf-8").read(), "scripts/monitor/extract-assets.py", "exec")'
```

Expected: `Ran 5 tests` followed by `OK`; the compile command exits `0` without output.

- [ ] **Step 5: Commit the parser**

```bash
git add scripts/monitor/extract-assets.py scripts/monitor/test_extract_assets.py
git commit -m "feat: parse production monitoring assets"
```

### Task 2: Bounded Site Check and Integration Tests

**Files:**
- Create: `scripts/monitor/test-server.py`
- Create: `scripts/monitor/check-site.test.sh`
- Create: `scripts/monitor/check-site.sh`

- [ ] **Step 1: Create the deterministic local HTTP fixture**

Create `scripts/monitor/test-server.py`:

```python
#!/usr/bin/env python3

import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urlsplit


HEALTHY_HTML = b"""<!doctype html>
<html><head>
  <link rel="stylesheet" href="assets/app.css">
  <script type="module" src="./assets/app.js"></script>
</head><body><div id="app"></div></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    flaky_requests = 0

    def send_content(
        self,
        status: int,
        content_type: str,
        body: bytes,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/redirect":
            self.send_content(
                302,
                "text/plain",
                b"redirect",
                {"Location": "/healthy/index.html"},
            )
        elif path == "/flaky":
            type(self).flaky_requests += 1
            if type(self).flaky_requests < 3:
                self.send_content(503, "text/plain", b"retry")
            else:
                self.send_content(200, "text/html; charset=utf-8", HEALTHY_HTML)
        elif path in {"/healthy/index.html", "/healthy/"}:
            self.send_content(200, "text/html; charset=utf-8", HEALTHY_HTML)
        elif path in {
            "/healthy/assets/app.js",
            "/assets/app.js",
        }:
            self.send_content(200, "text/javascript", b"export default true")
        elif path in {
            "/healthy/assets/app.css",
            "/assets/app.css",
        }:
            self.send_content(200, "text/css", b"body { color: black; }")
        elif path == "/status-500":
            self.send_content(500, "text/plain", b"failure")
        elif path == "/not-html":
            self.send_content(200, "application/json", b"{}")
        elif path == "/missing-app":
            self.send_content(
                200,
                "text/html",
                b'<link rel="stylesheet" href="/assets/app.css">'
                b'<script type="module" src="/assets/app.js"></script>',
            )
        elif path == "/no-assets":
            self.send_content(200, "text/html", b'<div id="app"></div>')
        elif path == "/bad-resource":
            self.send_content(
                200,
                "text/html",
                b'<link rel="stylesheet" href="/assets/app.css">'
                b'<script type="module" src="/assets/missing.js"></script>'
                b'<div id="app"></div>',
            )
        elif path == "/slow":
            time.sleep(1)
            self.send_content(200, "text/html", HEALTHY_HTML)
        else:
            self.send_content(404, "text/plain", b"not found")

    def log_message(self, _format: str, *_arguments: object) -> None:
        return


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: test-server.py PORT_FILE")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Path(sys.argv[1]).write_text(str(server.server_port), encoding="ascii")
    server.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write the failing monitor integration test**

Create `scripts/monitor/check-site.test.sh`:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
CHECK_SCRIPT="$SCRIPT_DIR/check-site.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sweet-memories-monitor-test.XXXXXX")"
PORT_FILE="$TEST_ROOT/port"
SERVER_PID=''

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TEST_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 "$SCRIPT_DIR/test-server.py" "$PORT_FILE" &
SERVER_PID=$!
for _attempt in {1..50}; do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.1
done
[[ -s "$PORT_FILE" ]] || {
  echo 'test server did not start' >&2
  exit 1
}

BASE_URL="http://127.0.0.1:$(cat "$PORT_FILE")"

assert_no_monitor_temp() {
  local directory=$1
  if find "$directory" -mindepth 1 -maxdepth 1 \
    -type d -name 'sweet-memories-monitor.*' -print -quit | grep -q .; then
    echo "monitor temp directory leaked under $directory" >&2
    exit 1
  fi
}

expect_success() {
  local name=$1 url=$2 case_root output
  case_root="$TEST_ROOT/$name"
  mkdir -p "$case_root"
  output="$case_root/output"
  TMPDIR="$case_root" bash "$CHECK_SCRIPT" "$url" >"$output" 2>&1
  grep -F '生产站点巡检通过' "$output" >/dev/null
  assert_no_monitor_temp "$case_root"
}

expect_failure() {
  local name=$1 url=$2 message=$3 case_root output
  case_root="$TEST_ROOT/$name"
  mkdir -p "$case_root"
  output="$case_root/output"
  if TMPDIR="$case_root" bash "$CHECK_SCRIPT" "$url" >"$output" 2>&1; then
    echo "$name unexpectedly succeeded" >&2
    exit 1
  fi
  grep -F "$message" "$output" >/dev/null
  assert_no_monitor_temp "$case_root"
}

expect_success healthy "$BASE_URL/healthy/index.html"
expect_success redirect "$BASE_URL/redirect"
expect_success flaky "$BASE_URL/flaky"
expect_failure status "$BASE_URL/status-500" '首页请求失败'
expect_failure content-type "$BASE_URL/not-html" '首页 Content-Type 不是 text/html'
expect_failure missing-app "$BASE_URL/missing-app" 'HTML 缺少 Vue 挂载点'
expect_failure no-assets "$BASE_URL/no-assets" 'HTML 没有可巡检的模块脚本'
expect_failure bad-resource "$BASE_URL/bad-resource" '静态资源请求失败'

FAKE_BIN="$TEST_ROOT/fake-bin"
CURL_MARKER="$TEST_ROOT/curl-called"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/curl" <<FAKE_CURL
#!/usr/bin/env bash
touch "$CURL_MARKER"
exit 99
FAKE_CURL
chmod +x "$FAKE_BIN/curl"
if PATH="$FAKE_BIN:$PATH" bash "$CHECK_SCRIPT" $'http://example.com/bad\nurl' \
  >"$TEST_ROOT/invalid-output" 2>&1; then
  echo 'invalid URL unexpectedly succeeded' >&2
  exit 1
fi
grep -F 'URL 无效' "$TEST_ROOT/invalid-output" >/dev/null
[[ ! -e "$CURL_MARKER" ]] || {
  echo 'invalid URL reached curl' >&2
  exit 1
}

SIGNAL_ROOT="$TEST_ROOT/signal"
mkdir -p "$SIGNAL_ROOT"
TMPDIR="$SIGNAL_ROOT" bash "$CHECK_SCRIPT" "$BASE_URL/slow" \
  >"$SIGNAL_ROOT/output" 2>&1 &
CHECK_PID=$!
sleep 0.1
kill -TERM "$CHECK_PID"
set +e
wait "$CHECK_PID"
SIGNAL_STATUS=$?
set -e
[[ "$SIGNAL_STATUS" -eq 143 ]] || {
  echo "signal status was $SIGNAL_STATUS, expected 143" >&2
  exit 1
}
assert_no_monitor_temp "$SIGNAL_ROOT"

echo 'check-site.sh: all tests passed'
```

- [ ] **Step 3: Run the integration test and verify RED**

Run:

```bash
bash scripts/monitor/check-site.test.sh
```

Expected: FAIL because `scripts/monitor/check-site.sh` does not exist.

- [ ] **Step 4: Implement the bounded monitor script**

Create `scripts/monitor/check-site.sh`:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
PARSER="$SCRIPT_DIR/extract-assets.py"
WORK_DIR=''

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $# -ne 1 ]]; then
  echo '用法：check-site.sh MONITOR_URL' >&2
  exit 2
fi

MONITOR_URL=$1
for command in curl python3 mktemp sed tr; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "缺少巡检命令：$command" >&2
    exit 2
  }
done
[[ -f "$PARSER" && ! -L "$PARSER" ]] || {
  echo "巡检解析器不存在或不是普通文件：$PARSER" >&2
  exit 2
}
python3 "$PARSER" --validate-url "$MONITOR_URL"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sweet-memories-monitor.XXXXXX")"
HTML_FILE="$WORK_DIR/index.html"
ASSET_FILE="$WORK_DIR/assets.txt"

CURL_OPTIONS=(
  --location
  --silent
  --show-error
  --proto '=http,https'
  --proto-redir '=http,https'
  --connect-timeout 10
  --max-time 30
  --max-filesize 10485760
  --retry 2
  --retry-delay 2
  --retry-max-time 90
  --retry-all-errors
)

if ! METADATA="$(
  curl "${CURL_OPTIONS[@]}" --fail \
    --output "$HTML_FILE" \
    --write-out '%{url_effective}\n%{content_type}\n%{http_code}\n' \
    "$MONITOR_URL"
)"; then
  echo "首页请求失败：$MONITOR_URL" >&2
  exit 1
fi

EFFECTIVE_URL="$(printf '%s\n' "$METADATA" | sed -n '1p')"
CONTENT_TYPE="$(printf '%s\n' "$METADATA" | sed -n '2p')"
HTTP_CODE="$(printf '%s\n' "$METADATA" | sed -n '3p')"
MEDIA_TYPE="$(
  printf '%s' "${CONTENT_TYPE%%;*}" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -d '[:space:]'
)"

[[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]] || {
  echo "首页最终 HTTP 状态不是 2xx：$HTTP_CODE" >&2
  exit 1
}
[[ "$MEDIA_TYPE" == 'text/html' ]] || {
  echo "首页 Content-Type 不是 text/html：$CONTENT_TYPE" >&2
  exit 1
}

python3 "$PARSER" "$EFFECTIVE_URL" "$HTML_FILE" >"$ASSET_FILE"

ASSET_COUNT=0
while IFS= read -r ASSET_URL; do
  [[ -n "$ASSET_URL" ]] || continue
  ((ASSET_COUNT += 1))
  if ! curl "${CURL_OPTIONS[@]}" --fail \
    --output /dev/null "$ASSET_URL"; then
    echo "静态资源请求失败：$ASSET_URL" >&2
    exit 1
  fi
done <"$ASSET_FILE"

echo "生产站点巡检通过：首页 $HTTP_CODE，静态资源 $ASSET_COUNT 个。"
echo "最终地址：$EFFECTIVE_URL"
```

- [ ] **Step 5: Run integration tests and verify GREEN**

Run:

```bash
bash -n scripts/monitor/check-site.sh
bash -n scripts/monitor/check-site.test.sh
python3 -c 'compile(open("scripts/monitor/test-server.py", encoding="utf-8").read(), "scripts/monitor/test-server.py", "exec")'
bash scripts/monitor/check-site.test.sh
```

Expected: syntax checks exit `0`; final line is `check-site.sh: all tests passed`.

- [ ] **Step 6: Commit the monitor and integration tests**

```bash
git add scripts/monitor/check-site.sh scripts/monitor/check-site.test.sh scripts/monitor/test-server.py
git commit -m "feat: check production site availability"
```

### Task 3: Scheduled GitHub Actions Workflow

**Files:**
- Create: `scripts/monitor/workflow.test.ts`
- Create: `.github/workflows/monitor.yml`

- [ ] **Step 1: Write the failing workflow contract test**

Create `scripts/monitor/workflow.test.ts`:

```typescript
// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface MonitorStep {
  id?: string
  run?: string
  'timeout-minutes'?: number
  uses?: string
}

interface MonitorWorkflow {
  concurrency: {
    'cancel-in-progress': boolean
    group: string
  }
  jobs: {
    monitor: {
      env: Record<string, string>
      environment?: unknown
      steps: MonitorStep[]
      'timeout-minutes': number
    }
  }
  on: {
    schedule: Array<{ cron: string }>
    workflow_dispatch: null
  }
  permissions: Record<string, string>
}

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/monitor.yml', import.meta.url),
)

function loadWorkflow(): MonitorWorkflow {
  expect(existsSync(workflowPath), 'monitor workflow must exist').toBe(true)
  return parse(readFileSync(workflowPath, 'utf8')) as MonitorWorkflow
}

function stepById(steps: MonitorStep[], id: string): MonitorStep {
  const step = steps.find((candidate) => candidate.id === id)
  expect(step, `monitor step "${id}" must exist`).toBeDefined()
  return step as MonitorStep
}

describe('production site monitor workflow', () => {
  it('runs every thirty minutes and supports manual checks', () => {
    expect(loadWorkflow().on).toEqual({
      schedule: [{ cron: '7,37 * * * *' }],
      workflow_dispatch: null,
    })
  })

  it('uses read-only access and an independent non-cancelling group', () => {
    const workflow = loadWorkflow()
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'sweet-memories-production-monitor',
      'cancel-in-progress': false,
    })
  })

  it('uses a repository variable without production secrets or environment', () => {
    const workflow = loadWorkflow()
    const serialized = JSON.stringify(workflow)
    expect(workflow.jobs.monitor.env).toEqual({
      MONITOR_URL: '${{ vars.MONITOR_URL }}',
    })
    expect(workflow.jobs.monitor.environment).toBeUndefined()
    expect(serialized).not.toContain('secrets.')
    expect(serialized).not.toContain('ALIYUN_')
  })

  it('pins the only executable action to a reviewed immutable commit', () => {
    const actionRefs = loadWorkflow()
      .jobs.monitor.steps.map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined)
    expect(actionRefs).toEqual([
      'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    ])
    expect(actionRefs[0]).toMatch(/^[^@]+@[0-9a-f]{40}$/)
  })

  it('bounds every step and leaves job timeout headroom', () => {
    const monitor = loadWorkflow().jobs.monitor
    const expected = new Map([
      ['checkout', 2],
      ['validate-config', 1],
      ['syntax', 1],
      ['monitor-site', 5],
    ])
    const total = monitor.steps.reduce(
      (sum, step) => sum + (step['timeout-minutes'] ?? 0),
      0,
    )
    expect(monitor.steps).toHaveLength(expected.size)
    for (const [id, timeout] of expected) {
      expect(stepById(monitor.steps, id)['timeout-minutes']).toBe(timeout)
    }
    expect(monitor['timeout-minutes']).toBe(12)
    expect(monitor['timeout-minutes']).toBeGreaterThan(total)
  })

  it('validates config and syntax before running the real monitor', () => {
    const steps = loadWorkflow().jobs.monitor.steps
    const configIndex = steps.findIndex((step) => step.id === 'validate-config')
    const syntaxIndex = steps.findIndex((step) => step.id === 'syntax')
    const monitorIndex = steps.findIndex((step) => step.id === 'monitor-site')

    expect(configIndex).toBeGreaterThanOrEqual(0)
    expect(syntaxIndex).toBeGreaterThan(configIndex)
    expect(monitorIndex).toBeGreaterThan(syntaxIndex)
    expect(stepById(steps, 'validate-config').run).toContain(
      'extract-assets.py --validate-url "$MONITOR_URL"',
    )
    expect(stepById(steps, 'syntax').run).toContain(
      'bash -n scripts/monitor/check-site.sh',
    )
    expect(stepById(steps, 'syntax').run).toContain('compile(')
    expect(stepById(steps, 'monitor-site').run).toBe(
      'bash scripts/monitor/check-site.sh "$MONITOR_URL"',
    )
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run scripts/monitor/workflow.test.ts
```

Expected: FAIL with `monitor workflow must exist` because `.github/workflows/monitor.yml` is absent.

- [ ] **Step 3: Implement the monitor workflow**

Create `.github/workflows/monitor.yml`:

```yaml
name: 生产站点巡检

on:
  schedule:
    - cron: '7,37 * * * *'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: sweet-memories-production-monitor
  cancel-in-progress: false

jobs:
  monitor:
    name: 检查公网首页和构建资源
    runs-on: ubuntu-latest
    timeout-minutes: 12
    env:
      MONITOR_URL: ${{ vars.MONITOR_URL }}
    steps:
      - name: 检出巡检脚本
        id: checkout
        timeout-minutes: 2
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: 校验巡检地址
        id: validate-config
        timeout-minutes: 1
        shell: bash
        run: |
          set -euo pipefail
          : "${MONITOR_URL:?缺少仓库级 Variable MONITOR_URL}"
          python3 scripts/monitor/extract-assets.py --validate-url "$MONITOR_URL"

      - name: 检查巡检脚本语法
        id: syntax
        timeout-minutes: 1
        shell: bash
        run: |
          set -euo pipefail
          bash -n scripts/monitor/check-site.sh
          python3 -c 'compile(open("scripts/monitor/extract-assets.py", encoding="utf-8").read(), "scripts/monitor/extract-assets.py", "exec")'

      - name: 检查生产站点
        id: monitor-site
        timeout-minutes: 5
        shell: bash
        run: bash scripts/monitor/check-site.sh "$MONITOR_URL"
```

- [ ] **Step 4: Run focused workflow checks and verify GREEN**

Run:

```bash
pnpm vitest run scripts/monitor/workflow.test.ts
node --input-type=module -e '
  import { readFileSync } from "node:fs"
  import { spawnSync } from "node:child_process"
  import { parse } from "yaml"
  const workflow = parse(readFileSync(".github/workflows/monitor.yml", "utf8"))
  for (const step of workflow.jobs.monitor.steps) {
    if (typeof step.run !== "string") continue
    const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" })
    if (result.status !== 0) {
      console.error(result.stderr)
      process.exit(result.status ?? 1)
    }
  }
  console.log("monitor workflow shell blocks passed")
'
```

Expected: Vitest reports all focused tests passed; shell extraction prints `monitor workflow shell blocks passed`.

- [ ] **Step 5: Commit the workflow and contract test**

```bash
git add .github/workflows/monitor.yml scripts/monitor/workflow.test.ts
git commit -m "ci: monitor production site availability"
```

### Task 4: Command, Beginner Guide, and Full Verification

**Files:**
- Modify: `package.json`
- Create: `docs/monitoring.md`

- [ ] **Step 1: Add the monitor test command**

Add this entry after `test:deploy` in `package.json`:

```json
"test:monitor": "python3 scripts/monitor/test_extract_assets.py && bash scripts/monitor/check-site.test.sh",
```

The resulting test section must be:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:deploy": "bash scripts/deploy/manage-release.test.sh",
"test:monitor": "python3 scripts/monitor/test_extract_assets.py && bash scripts/monitor/check-site.test.sh",
```

- [ ] **Step 2: Write the Chinese monitoring setup guide**

Create `docs/monitoring.md`:

````markdown
# 生产站点定时巡检

该工作流每 30 分钟从 GitHub 托管的执行器访问一次生产站点，也可以手动运行。它检查首页、HTML 类型、Vue 挂载点，以及首页直接引用的 JavaScript 和 CSS。

巡检只读取公网内容，不连接 SSH、不修改服务器、不重启 Nginx，也不会自动回退版本。

## 一次性配置

打开 GitHub 仓库：

`Settings -> Secrets and variables -> Actions -> Variables`

点击 `New repository variable`，填写：

```text
Name: MONITOR_URL
Value: http://8.163.27.231
```

点击 `Add variable` 保存。`MONITOR_URL` 是公开地址，应添加为 Repository variable，不要添加到 `production` Environment，也不需要创建 Secret。

## 第一次手动验证

代码推送到远端 `main` 后：

1. 打开仓库 `Actions`。
2. 在左侧选择 `生产站点巡检`。
3. 点击 `Run workflow`。
4. 分支选择 `main`。
5. 再点击绿色的 `Run workflow`。
6. 等待 `检查公网首页和构建资源` 变成绿色。

成功日志会显示首页 HTTP 状态、检查到的静态资源数量和最终地址。

## 定时规则

工作流计划在每小时的第 7 分钟和第 37 分钟运行，相邻两次间隔 30 分钟。GitHub 定时任务可能延迟，因此它不是严格实时监控。

## 失败时如何判断

- `缺少仓库级 Variable MONITOR_URL`：仓库 Variable 未添加或名称不正确。
- `首页请求失败`：公网地址超时、无法连接或返回错误状态。
- `首页 Content-Type 不是 text/html`：Nginx 返回的不是网页。
- `HTML 缺少 Vue 挂载点`：线上 `index.html` 内容不完整或不是本项目页面。
- `HTML 没有可巡检的模块脚本/样式表`：生产首页没有引用完整构建产物。
- `静态资源请求失败`：首页能打开，但某个 JavaScript 或 CSS 文件缺失。

巡检失败不会自动操作服务器。先在浏览器访问 `MONITOR_URL`，再检查本次 Actions 日志；不要因为一次失败就删除发布目录或关闭 SSH 主机校验。

## 本地验证

在项目目录执行：

```bash
pnpm test:monitor
bash scripts/monitor/check-site.sh http://8.163.27.231
```

第一条命令只访问本地测试服务器；第二条命令会读取真实生产站点。
````

- [ ] **Step 3: Run the new focused suites**

Run:

```bash
pnpm test:monitor
pnpm vitest run scripts/monitor/workflow.test.ts
```

Expected: parser unittest reports `OK`; shell suite prints `check-site.sh: all tests passed`; focused Vitest passes.

- [ ] **Step 4: Run the existing full regression suite**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:deploy
pnpm build
```

Expected: every command exits `0`; Vitest includes the new monitor workflow tests; deploy tests end with `manage-release.sh: all tests passed`; Vite produces `dist/index.html` and hashed assets.

- [ ] **Step 5: Run final static and security checks**

Run:

```bash
bash -n scripts/monitor/check-site.sh
bash -n scripts/monitor/check-site.test.sh
python3 -c 'compile(open("scripts/monitor/extract-assets.py", encoding="utf-8").read(), "scripts/monitor/extract-assets.py", "exec")'
python3 -c 'compile(open("scripts/monitor/test-server.py", encoding="utf-8").read(), "scripts/monitor/test-server.py", "exec")'
git diff --check
if rg -n -- 'secrets\.|ALIYUN_|StrictHostKeyChecking|ssh |scp |rm -rf /' \
  .github/workflows/monitor.yml scripts/monitor docs/monitoring.md; then
  echo 'monitoring scope contains forbidden deployment or secret access' >&2
  exit 1
else
  echo 'monitoring scope security scan passed'
fi
```

Expected: syntax and diff checks exit `0`; the scan prints `monitoring scope security scan passed`.

- [ ] **Step 6: Run one read-only production smoke check**

Run:

```bash
bash scripts/monitor/check-site.sh http://8.163.27.231
```

Expected: output starts with `生产站点巡检通过` and reports at least two static resources. This command is read-only and must not use SSH.

- [ ] **Step 7: Commit the command and guide**

```bash
git add package.json docs/monitoring.md
git commit -m "docs: add production monitoring guide"
```

- [ ] **Step 8: Verify the final branch state**

Run:

```bash
git status --short --branch
git log -4 --oneline
```

Expected: the feature worktree is clean and the latest four commits are the parser, monitor, workflow, and guide commits from this plan.

## Operational Handoff After Merge

These are user-controlled GitHub changes, not repository implementation steps:

1. Push the completed `main` branch or merge the completed feature branch.
2. Add repository-level Variable `MONITOR_URL=http://8.163.27.231` under `Settings -> Secrets and variables -> Actions -> Variables`.
3. Open `Actions -> 生产站点巡检`, manually run it on `main`, and wait for a green result.
4. Confirm a later scheduled run appears near minute 7 or 37 of an hour.
5. Do not create a production Tag for this monitoring-only change unless a site release is intentionally desired.
