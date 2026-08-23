#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CHECK_SCRIPT="$SCRIPT_DIR/check-site.sh"
SERVER_SCRIPT="$SCRIPT_DIR/test-server.py"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/check-site-test.XXXXXX")"
PORT_FILE="$TEST_ROOT/port"
SERVER_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TEST_ROOT"
  exit "$status"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local output=$1
  local expected=$2
  local context=$3
  [[ "$output" == *"$expected"* ]] || fail "$context: missing '$expected' in: $output"
}

assert_no_monitor_dirs() {
  local directory=$1
  local leaked
  leaked="$(find "$directory" -type d -name 'sweet-memories-monitor.*' -print -quit)"
  [[ -z "$leaked" ]] || fail "monitor temp directory leaked: $leaked"
}

run_success() {
  local name=$1
  local url=$2
  local case_dir="$TEST_ROOT/$name"
  local output
  local status
  mkdir -p "$case_dir"

  set +e
  output="$(TMPDIR="$case_dir" bash "$CHECK_SCRIPT" "$url" 2>&1)"
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || fail "$name: expected success, got $status: $output"
  assert_contains "$output" "生产站点巡检通过" "$name"
  assert_no_monitor_dirs "$case_dir"
}

run_failure() {
  local name=$1
  local url=$2
  local expected=$3
  local case_dir="$TEST_ROOT/$name"
  local output
  local status
  mkdir -p "$case_dir"

  set +e
  output="$(TMPDIR="$case_dir" bash "$CHECK_SCRIPT" "$url" 2>&1)"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "$name: expected failure: $output"
  assert_contains "$output" "$expected" "$name"
  assert_no_monitor_dirs "$case_dir"
}

python3 "$SERVER_SCRIPT" "$PORT_FILE" >"$TEST_ROOT/server.out" 2>"$TEST_ROOT/server.err" &
SERVER_PID=$!

for _ in {1..50}; do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.1
done
[[ -s "$PORT_FILE" ]] || fail "test server did not publish a port"

PORT="$(sed -n '1p' "$PORT_FILE")"
BASE_URL="http://127.0.0.1:$PORT"

run_success healthy "$BASE_URL/healthy/index.html"
run_success redirect "$BASE_URL/redirect"
run_success flaky "$BASE_URL/flaky"

run_failure status_500 "$BASE_URL/status-500" "首页请求失败"
run_failure not_html "$BASE_URL/not-html" "首页 Content-Type 不是 text/html"
run_failure missing_app "$BASE_URL/missing-app" "HTML 缺少 Vue 挂载点"
run_failure no_assets "$BASE_URL/no-assets" "HTML 没有可巡检的模块脚本"
run_failure bad_resource "$BASE_URL/bad-resource" "静态资源请求失败"

INVALID_DIR="$TEST_ROOT/invalid-url"
FAKE_BIN="$INVALID_DIR/bin"
FAKE_CURL_MARKER="$INVALID_DIR/curl-called"
mkdir -p "$FAKE_BIN"
printf '%s\n' '#!/usr/bin/env bash' 'touch "$FAKE_CURL_MARKER"' 'exit 99' >"$FAKE_BIN/curl"
chmod +x "$FAKE_BIN/curl"
set +e
INVALID_OUTPUT="$(FAKE_CURL_MARKER="$FAKE_CURL_MARKER" PATH="$FAKE_BIN:$PATH" TMPDIR="$INVALID_DIR" bash "$CHECK_SCRIPT" $'http://example.test/unsafe\npath' 2>&1)"
INVALID_STATUS=$?
set -e
[[ "$INVALID_STATUS" -ne 0 ]] || fail "invalid URL unexpectedly succeeded"
assert_contains "$INVALID_OUTPUT" "URL 无效" "invalid URL"
[[ ! -e "$FAKE_CURL_MARKER" ]] || fail "curl was called before URL validation"
assert_no_monitor_dirs "$INVALID_DIR"

SIGNAL_DIR="$TEST_ROOT/signal"
mkdir -p "$SIGNAL_DIR"
TMPDIR="$SIGNAL_DIR" bash "$CHECK_SCRIPT" "$BASE_URL/slow" >"$SIGNAL_DIR/output" 2>&1 &
SIGNAL_PID=$!
sleep 0.1
kill -TERM "$SIGNAL_PID"
set +e
wait "$SIGNAL_PID"
SIGNAL_STATUS=$?
set -e
[[ "$SIGNAL_STATUS" -eq 143 ]] || fail "TERM status was $SIGNAL_STATUS, expected 143"
assert_no_monitor_dirs "$SIGNAL_DIR"

printf 'check-site.sh: all tests passed\n'
