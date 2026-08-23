#!/usr/bin/env bash
set -Eeuo pipefail

WORK_DIR=""

cleanup() {
  local status=$1
  trap - EXIT INT TERM
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf -- "$WORK_DIR" || true
  fi
  exit "$status"
}
trap 'cleanup "$?"' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

if [[ "${BASH_SOURCE[0]}" == */* ]]; then
  SCRIPT_BASE="${BASH_SOURCE[0]%/*}"
else
  SCRIPT_BASE="."
fi
SCRIPT_DIR="$(cd -- "$SCRIPT_BASE" && pwd -P)"
PARSER="$SCRIPT_DIR/extract-assets.py"

if [[ $# -ne 1 ]]; then
  printf '用法：check-site.sh URL\n' >&2
  exit 2
fi
MONITOR_URL=$1

for required_command in curl python3 mktemp sed tr rm; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf '缺少必需命令：%s\n' "$required_command" >&2
    exit 2
  fi
done

if [[ ! -f "$PARSER" || -L "$PARSER" ]]; then
  printf 'HTML 资源解析器无效：%s\n' "$PARSER" >&2
  exit 2
fi

if ! python3 "$PARSER" --validate-url "$MONITOR_URL"; then
  exit 2
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sweet-memories-monitor.XXXXXX")"
INDEX_FILE="$WORK_DIR/index.html"
ASSETS_FILE="$WORK_DIR/assets.txt"

CURL_OPTIONS=(
  --disable
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

if ! HOME_METADATA="$(
  curl "${CURL_OPTIONS[@]}" \
    --fail \
    --output "$INDEX_FILE" \
    --write-out $'%{url_effective}\n%{content_type}\n%{http_code}\n' \
    -- "$MONITOR_URL"
)"; then
  printf '首页请求失败：%s\n' "$MONITOR_URL" >&2
  exit 1
fi

EFFECTIVE_URL="$(printf '%s\n' "$HOME_METADATA" | sed -n '1p')"
CONTENT_TYPE="$(printf '%s\n' "$HOME_METADATA" | sed -n '2p')"
HTTP_CODE="$(printf '%s\n' "$HOME_METADATA" | sed -n '3p')"
MEDIA_TYPE="$(
  printf '%s\n' "$CONTENT_TYPE" \
    | sed 's/;.*$//' \
    | tr '[:upper:]' '[:lower:]' \
    | tr -d '[:space:]'
)"

if [[ ! "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
  printf '首页 HTTP 状态不是 2xx：%s\n' "$HTTP_CODE" >&2
  exit 1
fi

if [[ "$MEDIA_TYPE" != "text/html" ]]; then
  printf '首页 Content-Type 不是 text/html：%s\n' "$CONTENT_TYPE" >&2
  exit 1
fi

if ! python3 "$PARSER" "$EFFECTIVE_URL" "$INDEX_FILE" >"$ASSETS_FILE"; then
  exit 1
fi

ASSET_COUNT=0
while IFS= read -r ASSET_URL || [[ -n "$ASSET_URL" ]]; do
  [[ -n "$ASSET_URL" ]] || continue
  ((ASSET_COUNT += 1))
  ASSET_HTTP_CODE=""
  if ! ASSET_HTTP_CODE="$(
    curl "${CURL_OPTIONS[@]}" \
      --max-redirs 0 \
      --fail \
      --output /dev/null \
      --write-out '%{http_code}' \
      -- "$ASSET_URL"
  )"; then
    ASSET_HTTP_CODE=""
  fi
  if [[ ! "$ASSET_HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
    printf '静态资源请求失败：%s\n' "$ASSET_URL" >&2
    exit 1
  fi
done <"$ASSETS_FILE"

printf '生产站点巡检通过：首页 %s，静态资源 %s 个。\n' "$HTTP_CODE" "$ASSET_COUNT"
printf '最终地址：%s\n' "$EFFECTIVE_URL"
