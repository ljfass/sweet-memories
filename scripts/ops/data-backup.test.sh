#!/usr/bin/env bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BACKUP_SCRIPT="$ROOT/scripts/ops/backup-data.sh"
RESTORE_SCRIPT="$ROOT/scripts/ops/restore-data.sh"
MIGRATION_SQL="$ROOT/apps/api/migrations/001_initial.sql"

# Runtime and deploy use sweet-memories.sqlite3 and backups/; app.db in the plan is illustrative.

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$BACKUP_SCRIPT" ]] || fail 'backup-data.sh is missing'
[[ -f "$RESTORE_SCRIPT" ]] || fail 'restore-data.sh is missing'

TEST_ROOT="$(mktemp -d)"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
trap 'rm -rf "$TEST_ROOT"' EXIT
REAL_DF="$(command -v df)"
REAL_DATE="$(command -v date)"
REAL_TAR="$(command -v tar)"
REAL_MV="$(command -v mv)"
REAL_CP="$(command -v cp)"
REAL_LN="$(command -v ln)"
REAL_CAT="$(command -v cat)"
REAL_RM="$(command -v rm)"
REAL_SLEEP="$(command -v sleep)"
REAL_STAT="$(command -v stat)"
MOCK_BIN="$TEST_ROOT/bin"
EVENT_LOG="$TEST_ROOT/events.log"
SYSTEMCTL_STATE="$TEST_ROOT/systemctl.state"
CURL_COUNT="$TEST_ROOT/curl.count"
LOCK_DIR="$TEST_ROOT/maintenance-lock"
MV_HOOK_MARKER="$TEST_ROOT/mv-hook-fired"
CP_HOOK_MARKER="$TEST_ROOT/cp-hook-fired"
CAT_HOOK_MARKER="$TEST_ROOT/cat-hook-fired"
STOP_HOOK_MARKER="$TEST_ROOT/stop-hook-fired"
JOURNAL_HOOK_MARKER="$TEST_ROOT/journal-hook-fired"
RM_HOOK_MARKER="$TEST_ROOT/rm-hook-fired"
BACKUP_HOOK_MARKER="$TEST_ROOT/backup-hook-fired"
PREFLIGHT_HOOK_MARKER="$TEST_ROOT/preflight-hook-fired"
mkdir -p "$MOCK_BIN"
mkdir -p "$TEST_ROOT/tmp"
: >"$EVENT_LOG"
printf 'active\n' >"$SYSTEMCTL_STATE"
printf '0\n' >"$CURL_COUNT"

cat >"$MOCK_BIN/id" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == '-u' ]]
printf '0\n'
MOCK

cat >"$MOCK_BIN/chown" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'chown:%s\n' "$*" >>"$EVENT_LOG"
MOCK

cat >"$MOCK_BIN/df" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'capacity:%s\n' "$*" >>"$EVENT_LOG"
if [[ -n "${FAKE_DF_AVAILABLE_KB:-}" ]]; then
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
  printf 'fixture 999999999 1 %s 1%% /fixture\n' "$FAKE_DF_AVAILABLE_KB"
else
  exec "$REAL_DF" "$@"
fi
MOCK

cat >"$MOCK_BIN/date" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == '-u +%Y%m%dT%H%M%SZ' && -n "${FAKE_UTC_TIMESTAMP:-}" ]]; then
  printf '%s\n' "$FAKE_UTC_TIMESTAMP"
else
  exec "$REAL_DATE" "$@"
fi
MOCK

cat >"$MOCK_BIN/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl:%s\n' "$*" >>"$EVENT_LOG"
case "$1" in
  stop)
    [[ "$2" == 'sweet-memories-api.service' ]]
    [[ "${FAKE_STOP_FAIL:-0}" != '1' ]] || exit 1
    [[ "${FAKE_STOP_STUCK:-0}" == '1' ]] || printf 'inactive\n' >"$SYSTEMCTL_STATE"
    if [[ -n "${FAKE_STOP_DELAY:-}" ]]; then
      "$REAL_SLEEP" "$FAKE_STOP_DELAY"
    fi
    if [[ -n "${FAKE_SQLITE_WRITER_PIPE:-}" ]]; then
      printf '.quit\n' >"$FAKE_SQLITE_WRITER_PIPE"
      "$REAL_SLEEP" 0.1
    fi
    if [[ "${FAKE_KILL_AFTER_STOP:-0}" == '1' && ! -e "$STOP_HOOK_MARKER" ]]; then
      : >"$STOP_HOOK_MARKER"
      kill -KILL "$PPID"
    fi
    ;;
  start)
    [[ "$2" == 'sweet-memories-api.service' ]]
    [[ "${FAKE_START_FAIL:-0}" != '1' ]] || exit 1
    printf 'active\n' >"$SYSTEMCTL_STATE"
    ;;
  is-active)
    shift
    [[ "${1:-}" == '--quiet' ]] && shift
    [[ "$1" == 'sweet-memories-api.service' ]]
    [[ "$(cat "$SYSTEMCTL_STATE")" == 'active' ]]
    ;;
  *) exit 64 ;;
esac
MOCK

cat >"$MOCK_BIN/cp" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
"$REAL_CP" "$@"
if [[ -n "${FAKE_SWAP_SOURCE:-}" && -f "$FAKE_SWAP_SOURCE" &&
  ! -e "$CP_HOOK_MARKER" ]]; then
  : >"$CP_HOOK_MARKER"
  "$REAL_MV" "$FAKE_SWAP_SOURCE" "$FAKE_SWAP_SOURCE.operation-owned"
  printf 'attacker replacement\n' >"$FAKE_SWAP_SOURCE"
fi
MOCK

cat >"$MOCK_BIN/cat" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
"$REAL_CAT" "$@"
if [[ -n "${FAKE_REPLACE_INPUT_AFTER_COPY:-}" &&
  ! -e "$CAT_HOOK_MARKER" ]]; then
  : >"$CAT_HOOK_MARKER"
  "$REAL_MV" "$FAKE_REPLACE_INPUT_AFTER_COPY" \
    "$FAKE_REPLACE_INPUT_AFTER_COPY.operation-owned"
  printf 'attacker archive replacement\n' >"$FAKE_REPLACE_INPUT_AFTER_COPY"
fi
MOCK

cat >"$MOCK_BIN/ln" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
destination="${!#}"
"$REAL_LN" "$@"
if [[ -n "${FAKE_KILL_AFTER_LINK_TO:-}" && "$destination" == "$FAKE_KILL_AFTER_LINK_TO" &&
  ! -e "$MV_HOOK_MARKER" ]]; then
  : >"$MV_HOOK_MARKER"
  kill -KILL "$PPID"
fi
if [[ -n "${FAKE_REPLACE_AFTER_MOVE_TO:-}" && "$destination" == "$FAKE_REPLACE_AFTER_MOVE_TO" &&
  ! -e "$MV_HOOK_MARKER" ]]; then
  : >"$MV_HOOK_MARKER"
  "$REAL_MV" "$destination" "$destination.operation-owned"
  mkdir "$destination"
  printf 'third-party-live\n' >"$destination/${FAKE_THIRD_PARTY_SENTINEL:-sentinel}"
  kill -TERM "$PPID"
fi
if [[ -n "${FAKE_TERM_AFTER_LINK_TO:-}" && "$destination" == "$FAKE_TERM_AFTER_LINK_TO" &&
  ! -e "$MV_HOOK_MARKER" ]]; then
  : >"$MV_HOOK_MARKER"
  kill -TERM "$PPID"
fi
MOCK

cat >"$MOCK_BIN/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
count="$(( $(cat "$CURL_COUNT") + 1 ))"
printf '%s\n' "$count" >"$CURL_COUNT"
printf 'curl:%s\n' "$*" >>"$EVENT_LOG"
[[ "$count" -gt "${FAKE_HEALTH_FAILURES:-0}" ]] || exit 22
database="$HEALTH_DATA_ROOT/database/sweet-memories.sqlite3"
[[ -f "$database" && ! -L "$database" ]]
[[ "$(sqlite3 -batch -noheader "file:$database?mode=ro&immutable=1" \
  'PRAGMA quick_check;')" == 'ok' ]]
MOCK

cat >"$MOCK_BIN/flock" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  -x|--exclusive)
    while ! mkdir "$LOCK_DIR" 2>/dev/null; do
      "$REAL_SLEEP" 0.02
    done
    printf 'lock:acquire\n' >>"$EVENT_LOG"
    ;;
  -u|--unlock)
    rmdir "$LOCK_DIR"
    printf 'lock:release\n' >>"$EVENT_LOG"
    ;;
  *) exit 64 ;;
esac
MOCK

cat >"$MOCK_BIN/tar" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ " ${1:-} " == ' -czf ' ]]; then
  printf 'tar:create:%s\n' "$*" >>"$EVENT_LOG"
fi
case " ${1:-} " in
  ' -xzf ') printf 'tar:extract\n' >>"$EVENT_LOG" ;;
esac
if [[ "${FAKE_TAR_LIST_MODE:-}" == 'underdeclare' && "${1:-}" == '-tvPzf' ]]; then
  archive="${!#}"
  while IFS= read -r member; do
    if [[ "$member" == */ ]]; then
      printf 'drwx------ 0 0 0 0 Jan 01 00:00 %s\n' "$member"
    else
      printf '%s\n' "-rw------- 0 0 0 0 Jan 01 00:00 $member"
    fi
  done < <("$REAL_TAR" -tPzf "$archive")
  exit 0
fi
if [[ "${FAKE_TAR_CREATE_FAIL:-0}" == '1' && " $* " == *' -czf '* ]]; then
  printf 'tar:create-fail\n' >>"$EVENT_LOG"
  exit 1
fi
exec "$REAL_TAR" "$@"
MOCK

cat >"$MOCK_BIN/rm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
target=''
for argument in "$@"; do
  [[ "$argument" == -* ]] || target="$argument"
done
"$REAL_RM" "$@"
if [[ -n "${FAKE_KILL_AFTER_REMOVE_BASENAME:-}" && -n "$target" &&
  "$(basename "$target")" == "$FAKE_KILL_AFTER_REMOVE_BASENAME" &&
  "$target" == *'.sweet-memories-restore'* && ! -e "$RM_HOOK_MARKER" ]]; then
  : >"$RM_HOOK_MARKER"
  kill -KILL "$PPID"
fi
MOCK

cat >"$MOCK_BIN/stat" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAKE_GNU_STAT:-0}" != '1' ]]; then
  exec "$REAL_STAT" "$@"
fi

follow=0
case "${1:-}" in
  -L)
    follow=1
    shift
    ;;
  -Lc)
    follow=1
    set -- -c "${@:2}"
    ;;
esac
[[ "${1:-}" == '-c' && "$#" == '3' ]] || exit 64
format="$2"
target="$3"
if [[ "$target" == /dev/fd/* ]]; then
  if [[ "$follow" == '0' ]]; then
    printf 'stat:gnu-no-follow:%s:%s\n' "$format" "$target" >>"$EVENT_LOG"
    case "$format" in
      '%d:%i') printf '999:999\n' ;;
      '%s') printf '64\n' ;;
      '%i') printf '999\n' ;;
      '%h') printf '1\n' ;;
      '%F') printf 'symbolic link\n' ;;
      '%a') printf '777\n' ;;
      '%u') printf '0\n' ;;
      *) exit 64 ;;
    esac
    exit 0
  fi
  printf 'stat:gnu-follow:%s:%s\n' "$format" "$target" >>"$EVENT_LOG"
fi
node - "$target" "$format" "$follow" <<'NODE'
const fs = require('node:fs')
const target = process.argv[2]
const format = process.argv[3]
const follow = process.argv[4] === '1'
let value
if (target.startsWith('/dev/fd/') && follow) {
  value = fs.fstatSync(Number(target.slice('/dev/fd/'.length)))
} else {
  value = follow ? fs.statSync(target) : fs.lstatSync(target)
}
let output
switch (format) {
  case '%d:%i': output = `${value.dev}:${value.ino}`; break
  case '%s': output = String(value.size); break
  case '%i': output = String(value.ino); break
  case '%h': output = String(value.nlink); break
  case '%a': output = (value.mode & 0o7777).toString(8); break
  case '%u': output = String(value.uid); break
  case '%F':
    output = value.isFile() ? (value.size === 0 ? 'regular empty file' : 'regular file')
      : value.isDirectory() ? 'directory'
      : value.isSymbolicLink() ? 'symbolic link'
      : 'special file'
    break
  default: process.exit(64)
}
process.stdout.write(`${output}\n`)
NODE
MOCK

cat >"$MOCK_BIN/mv" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
source_path="$1"
destination="${!#}"
"$REAL_MV" "$@"
printf 'mv:%s:%s\n' "$source_path" "$destination" >>"$EVENT_LOG"
if [[ -n "${FAKE_KILL_AFTER_MOVE_TO:-}" && "$destination" == "$FAKE_KILL_AFTER_MOVE_TO" &&
  ! -e "$MV_HOOK_MARKER" ]]; then
  : >"$MV_HOOK_MARKER"
  kill -KILL "$PPID"
fi
if [[ -n "${FAKE_REPLACE_AFTER_MOVE_TO:-}" && "$destination" == "$FAKE_REPLACE_AFTER_MOVE_TO" &&
  ! -e "$MV_HOOK_MARKER" ]]; then
  : >"$MV_HOOK_MARKER"
  "$REAL_MV" "$destination" "$destination.operation-owned"
  mkdir "$destination"
  printf 'third-party-live\n' >"$destination/${FAKE_THIRD_PARTY_SENTINEL:-sentinel}"
  kill -TERM "$PPID"
fi
if [[ -n "${FAKE_TERM_AFTER_MOVE_TO:-}" && "$destination" == "$FAKE_TERM_AFTER_MOVE_TO" &&
  ! -e "$MV_HOOK_MARKER" ]]; then
  : >"$MV_HOOK_MARKER"
  kill -TERM "$PPID"
fi
MOCK

chmod +x "$MOCK_BIN"/*
export REAL_DF REAL_DATE REAL_TAR REAL_MV REAL_CP REAL_LN REAL_CAT REAL_RM REAL_SLEEP
export REAL_STAT
export EVENT_LOG SYSTEMCTL_STATE CURL_COUNT LOCK_DIR MV_HOOK_MARKER CP_HOOK_MARKER
export CAT_HOOK_MARKER STOP_HOOK_MARKER JOURNAL_HOOK_MARKER RM_HOOK_MARKER
export BACKUP_HOOK_MARKER
export PREFLIGHT_HOOK_MARKER

reset_fakes() {
  : >"$EVENT_LOG"
  printf 'active\n' >"$SYSTEMCTL_STATE"
  printf '0\n' >"$CURL_COUNT"
  rmdir "$LOCK_DIR" 2>/dev/null || true
  rm -f "$MV_HOOK_MARKER" "$CP_HOOK_MARKER" "$CAT_HOOK_MARKER" \
    "$STOP_HOOK_MARKER" "$JOURNAL_HOOK_MARKER" "$RM_HOOK_MARKER" \
    "$BACKUP_HOOK_MARKER" "$PREFLIGHT_HOOK_MARKER"
  unset FAKE_DF_AVAILABLE_KB FAKE_STOP_FAIL FAKE_STOP_STUCK FAKE_START_FAIL
  unset FAKE_HEALTH_FAILURES FAKE_TAR_CREATE_FAIL FAKE_KILL_AFTER_MOVE_TO
  unset FAKE_TERM_AFTER_MOVE_TO FAKE_REPLACE_AFTER_MOVE_TO FAKE_THIRD_PARTY_SENTINEL
  unset FAKE_TERM_AFTER_LINK_TO FAKE_KILL_AFTER_LINK_TO FAKE_SWAP_SOURCE
  unset FAKE_SQLITE_WRITER_PIPE FAKE_STOP_DELAY
  unset FAKE_REPLACE_INPUT_AFTER_COPY
  unset FAKE_KILL_AFTER_STOP FAKE_TAR_LIST_MODE TEST_MAX_ARCHIVE_BYTES
  unset TEST_MAX_ARCHIVE_MEMBERS TEST_MAX_EXPANDED_BYTES
  unset TEST_JOURNAL_COLLISION_STAGE
  unset FAKE_KILL_AFTER_REMOVE_BASENAME TEST_BACKUP_REPLACE_PUBLIC_ARCHIVE
  unset FAKE_GNU_STAT FAKE_KILL_AFTER_JOURNAL_CREATE FAKE_KILL_BEFORE_METADATA_LINK
  FAKE_UTC_TIMESTAMP='20260903T020304Z'
  export FAKE_UTC_TIMESTAMP
}

invoke_backup() {
  local data_root="$1"
  local target="$2"
  env PATH="$MOCK_BIN:$PATH" \
    REAL_DF="$REAL_DF" REAL_DATE="$REAL_DATE" REAL_TAR="$REAL_TAR" \
    REAL_MV="$REAL_MV" REAL_SLEEP="$REAL_SLEEP" \
    EVENT_LOG="$EVENT_LOG" SYSTEMCTL_STATE="$SYSTEMCTL_STATE" \
    CURL_COUNT="$CURL_COUNT" LOCK_DIR="$LOCK_DIR" \
    HEALTH_DATA_ROOT="$data_root" \
    FAKE_DF_AVAILABLE_KB="${FAKE_DF_AVAILABLE_KB:-999999999}" \
    FAKE_UTC_TIMESTAMP="$FAKE_UTC_TIMESTAMP" \
    FAKE_STOP_FAIL="${FAKE_STOP_FAIL:-0}" FAKE_STOP_STUCK="${FAKE_STOP_STUCK:-0}" \
    FAKE_START_FAIL="${FAKE_START_FAIL:-0}" \
    FAKE_HEALTH_FAILURES="${FAKE_HEALTH_FAILURES:-0}" \
    FAKE_TAR_CREATE_FAIL="${FAKE_TAR_CREATE_FAIL:-0}" \
    TEST_BACKUP_REPLACE_PUBLIC_ARCHIVE="${TEST_BACKUP_REPLACE_PUBLIC_ARCHIVE:-0}" \
    FAKE_GNU_STAT="${FAKE_GNU_STAT:-0}" REAL_STAT="$REAL_STAT" \
    BACKUP_HOOK_MARKER="$BACKUP_HOOK_MARKER" \
    bash -c '
      source "$1"
      DATA_ROOT="$2"
      LOCK_FILE="$3"
      if [[ "$TEST_BACKUP_REPLACE_PUBLIC_ARCHIVE" == '1' ]]; then
        backup_before_sidecar_commit() {
          local public_archive="$1"
          : >"$BACKUP_HOOK_MARKER"
          mv "$public_archive" "$public_archive.attacker-owned"
          printf "third-party-public\n" >"$public_archive"
        }
      fi
      backup_data "$4"
    ' _ "$BACKUP_SCRIPT" "$data_root" "$TEST_ROOT/shared.lock" "$target"
}

invoke_restore() {
  local data_root="$1"
  local action="$2"
  local archive="$3"
  env PATH="$MOCK_BIN:$PATH" \
    REAL_DF="$REAL_DF" REAL_DATE="$REAL_DATE" REAL_TAR="$REAL_TAR" \
    REAL_MV="$REAL_MV" REAL_SLEEP="$REAL_SLEEP" \
    EVENT_LOG="$EVENT_LOG" SYSTEMCTL_STATE="$SYSTEMCTL_STATE" \
    CURL_COUNT="$CURL_COUNT" LOCK_DIR="$LOCK_DIR" \
    HEALTH_DATA_ROOT="$data_root" \
    TMPDIR="$TEST_ROOT/tmp" \
    FAKE_UTC_TIMESTAMP="$FAKE_UTC_TIMESTAMP" \
    FAKE_STOP_FAIL="${FAKE_STOP_FAIL:-0}" FAKE_STOP_STUCK="${FAKE_STOP_STUCK:-0}" \
    FAKE_START_FAIL="${FAKE_START_FAIL:-0}" \
    FAKE_HEALTH_FAILURES="${FAKE_HEALTH_FAILURES:-0}" \
    FAKE_KILL_AFTER_MOVE_TO="${FAKE_KILL_AFTER_MOVE_TO:-}" \
    FAKE_TERM_AFTER_MOVE_TO="${FAKE_TERM_AFTER_MOVE_TO:-}" \
    FAKE_REPLACE_AFTER_MOVE_TO="${FAKE_REPLACE_AFTER_MOVE_TO:-}" \
    FAKE_THIRD_PARTY_SENTINEL="${FAKE_THIRD_PARTY_SENTINEL:-}" \
    FAKE_KILL_AFTER_LINK_TO="${FAKE_KILL_AFTER_LINK_TO:-}" \
    FAKE_KILL_AFTER_STOP="${FAKE_KILL_AFTER_STOP:-0}" \
    FAKE_TAR_LIST_MODE="${FAKE_TAR_LIST_MODE:-}" \
    TEST_MAX_ARCHIVE_BYTES="${TEST_MAX_ARCHIVE_BYTES:-}" \
    TEST_MAX_ARCHIVE_MEMBERS="${TEST_MAX_ARCHIVE_MEMBERS:-}" \
    TEST_MAX_EXPANDED_BYTES="${TEST_MAX_EXPANDED_BYTES:-}" \
    TEST_JOURNAL_COLLISION_STAGE="${TEST_JOURNAL_COLLISION_STAGE:-}" \
    FAKE_GNU_STAT="${FAKE_GNU_STAT:-0}" REAL_STAT="$REAL_STAT" \
    FAKE_KILL_AFTER_JOURNAL_CREATE="${FAKE_KILL_AFTER_JOURNAL_CREATE:-0}" \
    FAKE_KILL_BEFORE_METADATA_LINK="${FAKE_KILL_BEFORE_METADATA_LINK:-0}" \
    STOP_HOOK_MARKER="$STOP_HOOK_MARKER" JOURNAL_HOOK_MARKER="$JOURNAL_HOOK_MARKER" \
    PREFLIGHT_HOOK_MARKER="$PREFLIGHT_HOOK_MARKER" \
    bash -c '
      source "$1"
      DATA_ROOT="$2"
      LOCK_FILE="$3"
      RESTORE_JOURNAL="$(dirname "$2")/.sweet-memories-restore"
      [[ -z "$TEST_MAX_ARCHIVE_BYTES" ]] || MAX_ARCHIVE_BYTES="$TEST_MAX_ARCHIVE_BYTES"
      [[ -z "$TEST_MAX_ARCHIVE_MEMBERS" ]] || MAX_ARCHIVE_MEMBERS="$TEST_MAX_ARCHIVE_MEMBERS"
      [[ -z "$TEST_MAX_EXPANDED_BYTES" ]] || MAX_EXPANDED_BYTES="$TEST_MAX_EXPANDED_BYTES"
      if [[ "$FAKE_KILL_AFTER_JOURNAL_CREATE" == '1' ]]; then
        journal_after_create() {
          : >"$PREFLIGHT_HOOK_MARKER"
          kill -KILL "$$"
        }
      fi
      if [[ -n "$TEST_JOURNAL_COLLISION_STAGE" ||
        "$FAKE_KILL_BEFORE_METADATA_LINK" == '1' ]]; then
        journal_before_stage_publish() {
          local path="$1"
          local stage="$2"
          if [[ "$stage" == 'metadata' && "$FAKE_KILL_BEFORE_METADATA_LINK" == '1' &&
            ! -e "$PREFLIGHT_HOOK_MARKER" ]]; then
            : >"$PREFLIGHT_HOOK_MARKER"
            kill -KILL "$$"
          fi
          if [[ "$stage" == "$TEST_JOURNAL_COLLISION_STAGE" &&
            ! -e "$JOURNAL_HOOK_MARKER" ]]; then
            : >"$JOURNAL_HOOK_MARKER"
            printf "third-party-journal\n" >"$path"
          fi
        }
      fi
      restore_data "$4" "$5"
    ' _ "$RESTORE_SCRIPT" "$data_root" "$TEST_ROOT/shared.lock" "$action" "$archive"
}

assert_fails() {
  local label="$1"
  local expected="$2"
  shift 2
  local output

  if output="$($@ 2>&1)"; then
    fail "$label unexpectedly succeeded"
  fi
  if [[ "$output" != *"$expected"* ]]; then
    printf 'diagnostic events:\n%s\n' "$(cat "$EVENT_LOG")" >&2
    while IFS= read -r journal; do
      printf 'diagnostic journal %s:\n%s\n' "$journal" "$(cat "$journal")" >&2
    done < <(find "$TEST_ROOT" -name metadata -path '*/.sweet-memories-restore/metadata' -type f -print)
    fail "$label did not report '$expected': $output"
  fi
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

file_size() {
  stat -f '%z' "$1" 2>/dev/null || stat -c '%s' "$1"
}

file_link_count() {
  stat -f '%l' "$1" 2>/dev/null || stat -c '%h' "$1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fixture_photo_id() {
  local digest
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$1" | sha256sum | awk '{print $1}')"
  else
    digest="$(printf '%s' "$1" | shasum -a 256 | awk '{print $1}')"
  fi
  printf '%s-%s-4%s-8%s-%s\n' \
    "${digest:0:8}" "${digest:8:4}" "${digest:13:3}" \
    "${digest:17:3}" "${digest:20:12}"
}

write_sidecar() {
  local archive="$1"
  printf '%s  %s\n' "$(sha256_file "$archive")" "$(basename "$archive")" >"$archive.sha256"
}

create_data_fixture() {
  local data_root="$1"
  local label="$2"
  local photo_id
  local database="$data_root/database/sweet-memories.sqlite3"

  photo_id="$(fixture_photo_id "$label")"

  mkdir -p "$data_root/database" "$data_root/media/$photo_id" \
    "$data_root/staging" "$data_root/backups/manual"
  printf 'image-%s\n' "$label" >"$data_root/media/$photo_id/master.jpg"
  printf 'must-not-be-archived\n' >"$data_root/staging/private.tmp"
  printf 'must-not-be-recursive\n' >"$data_root/backups/manual/old.txt"
  sqlite3 "$database" <"$MIGRATION_SQL"
  sqlite3 "$database" >/dev/null <<SQL
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
INSERT INTO schema_migrations(version, applied_at)
VALUES ('001', '2026-09-03T02:03:04.000Z');
INSERT INTO photos(
  id, title, description, captured_date, status, rotation, offset_x, offset_y,
  request_id, version, created_at, updated_at
) VALUES (
  '$photo_id', '$label', NULL, '2026-09-03', 'published', 0, 0, 0,
  'request-$photo_id', 1, '2026-09-03T02:03:04.000Z', '2026-09-03T02:03:04.000Z'
);
INSERT INTO photo_assets(photo_id, kind, format, width, height, relative_path)
VALUES ('$photo_id', 'master', 'jpeg', 1, 1, '$photo_id/master.jpg');
SQL
  chmod 0750 "$data_root" "$data_root/media" "$data_root/media/$photo_id"
  chmod 0700 "$data_root/database" "$data_root/staging" "$data_root/backups" \
    "$data_root/backups/manual"
  chmod 0600 "$database"
  chmod 0640 "$data_root/media/$photo_id/master.jpg"
}

fixture_data_bytes() {
  local data_root="$1"
  local total entry
  total="$(file_size "$data_root/database/sweet-memories.sqlite3")"
  while IFS= read -r -d '' entry; do
    total=$((total + $(file_size "$entry")))
  done < <(find "$data_root/media" -type f -print0)
  printf '%s\n' "$total"
}

normalized_members() {
  "$REAL_TAR" -tzf "$1" | sed -e 's#^\./##' -e 's#/$##' | sed '/^$/d'
}

make_malicious_archive() {
  local archive="$1"
  local source="$TEST_ROOT/malicious-source"
  rm -rf "$source"
  mkdir -p "$source"
  printf 'escape\n' >"$source/member"
  if "$REAL_TAR" --version 2>/dev/null | grep -q 'GNU tar'; then
    "$REAL_TAR" -czf "$archive" -C "$source" --transform='s|^member$|../escape|' member
  else
    "$REAL_TAR" -czf "$archive" -C "$source" -s '|^member$|../escape|' member
  fi
  write_sidecar "$archive"
}

make_absolute_archive() {
  local archive="$1"
  local source="$TEST_ROOT/absolute-source"
  local plain="$TEST_ROOT/absolute.tar"

  rm -rf "$source"
  mkdir -p "$source"
  printf 'absolute\n' >"$source/member"
  if "$REAL_TAR" --version 2>/dev/null | grep -q 'GNU tar'; then
    "$REAL_TAR" -czPf "$archive" -C "$source" \
      --transform='s|^member$|/absolute|' member
  else
    command -v pax >/dev/null 2>&1 || fail 'pax is required for the BSD tar absolute fixture'
    pax -w -x ustar -f "$plain" "$source/member"
    gzip -c "$plain" >"$archive"
  fi
  "$REAL_TAR" -tPzf "$archive" | grep -q '^/' || fail 'absolute archive fixture is not absolute'
  write_sidecar "$archive"
}

make_internal_special_archive() {
  local kind="$1"
  local archive="$2"
  local tree="$TEST_ROOT/internal-$kind"
  local existing

  rm -rf "$tree"
  mkdir -m 0700 "$tree"
  "$REAL_TAR" -xzf "$ARCHIVE_A" -C "$tree"
  existing="$tree/media/$ORIGINAL_PHOTO_ID/master.jpg"
  case "$kind" in
    symlink) ln -s /etc/passwd "$tree/media/$ORIGINAL_PHOTO_ID/special" ;;
    hardlink) ln "$existing" "$tree/media/$ORIGINAL_PHOTO_ID/special" ;;
    fifo) mkfifo "$tree/media/$ORIGINAL_PHOTO_ID/special" ;;
    *) fail "unsupported internal special fixture $kind" ;;
  esac
  "$REAL_TAR" -czf "$archive" -C "$tree" database media SHA256SUMS MANIFEST.txt
  write_sidecar "$archive"
}

repack_tree() {
  local tree="$1"
  local archive="$2"
  "$REAL_TAR" -czf "$archive" -C "$tree" database media SHA256SUMS MANIFEST.txt
  write_sidecar "$archive"
}

regenerate_tree_metadata() {
  local tree="$1"
  local entry relative digest size
  local database="$tree/database/sweet-memories.sqlite3"
  local sha_unsorted="$tree/.sha.unsorted"
  local manifest_unsorted="$tree/.manifest.unsorted"

  sqlite3 "$database" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
  rm -f -- "$database-wal" "$database-shm"
  : >"$sha_unsorted"
  : >"$manifest_unsorted"
  while IFS= read -r -d '' entry; do
    relative="${entry#"$tree/"}"
    digest="$(sha256_file "$entry")"
    size="$(file_size "$entry")"
    printf '%s  %s\n' "$digest" "$relative" >>"$sha_unsorted"
    printf '%s\t%s\t%s\n' "$digest" "$size" "$relative" >>"$manifest_unsorted"
  done < <(find "$tree/database" "$tree/media" -type f -print0)
  LC_ALL=C sort -k2,2 "$sha_unsorted" >"$tree/SHA256SUMS"
  LC_ALL=C sort -t $'\t' -k3,3 "$manifest_unsorted" >"$tree/MANIFEST.txt"
  rm "$sha_unsorted" "$manifest_unsorted"
}

copy_valid_archive() {
  local directory="$1"
  local timestamp="$2"
  local archive="$directory/sweet-memories-data-$timestamp.tar.gz"
  mkdir -p "$directory"
  cp "$ARCHIVE_A" "$archive"
  write_sidecar "$archive"
  printf '%s\n' "$archive"
}

test_backup_publish_term() {
  local case_root case_archive case_status case_output

  reset_fakes
  case_root="$TEST_ROOT/var/lib/backup-term-publish"
  create_data_fixture "$case_root" 'backup-term-publish'
  case_archive="$case_root/backups/manual/sweet-memories-data-$FAKE_UTC_TIMESTAMP.tar.gz"
  FAKE_TERM_AFTER_LINK_TO="$case_archive"
  export FAKE_TERM_AFTER_LINK_TO
  set +e
  case_output="$(invoke_backup "$case_root" "$case_root/backups/manual" 2>&1)"
  case_status=$?
  set -e
  [[ "$case_status" -eq 143 && -e "$MV_HOOK_MARKER" ]] ||
    fail "backup publish TERM returned $case_status without executing the hook"
  [[ -f "$case_archive" && ! -L "$case_archive" && ! -e "$case_archive.sha256" ]] ||
    fail 'backup publish TERM did not retain exactly the incomplete archive'
  [[ "$case_output" == *'incomplete archive retained for manual recovery'* ]] ||
    fail 'backup publish TERM did not report the retained incomplete archive'
  [[ -z "$(find "$case_root/backups/manual" -maxdepth 1 \
    -name '.sweet-memories-*' -print -quit)" ]] ||
    fail 'backup publish TERM retained an owned temporary file'
  [[ "$(cat "$SYSTEMCTL_STATE")" == 'active' ]] ||
    fail 'backup publish TERM did not restore service health'
}

create_reference_archive() {
  local label="$1"
  local root="$TEST_ROOT/reference-$label/sweet-memories"

  reset_fakes
  create_data_fixture "$root" "$label"
  invoke_backup "$root" "$root/backups/manual" >/dev/null
  TEST_REFERENCE_ARCHIVE="$root/backups/manual/sweet-memories-data-$FAKE_UTC_TIMESTAMP.tar.gz"
}

create_minimal_schema_fixture() {
  local data_root="$1"
  local photo_id="$2"
  local database="$data_root/database/sweet-memories.sqlite3"

  mkdir -p "$data_root/database" "$data_root/media/$photo_id" \
    "$data_root/staging" "$data_root/backups/manual"
  printf 'minimal-schema\n' >"$data_root/media/$photo_id/master.jpg"
  sqlite3 "$database" >/dev/null <<SQL
PRAGMA journal_mode=WAL;
CREATE TABLE photos(id TEXT PRIMARY KEY);
CREATE TABLE photo_assets(photo_id TEXT, relative_path TEXT);
INSERT INTO photos(id) VALUES('$photo_id');
INSERT INTO photo_assets(photo_id, relative_path)
VALUES('$photo_id', '$photo_id/master.jpg');
SQL
}

mutate_schema_contract() {
  local database="$1"
  local variant="$2"

  case "$variant" in
    unconstrained)
      sqlite3 "$database" <<'SQL'
PRAGMA writable_schema=ON;
UPDATE sqlite_schema
SET sql=replace(
  sql,
  'title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120)',
  'title TEXT'
)
WHERE type='table' AND name='photos';
PRAGMA writable_schema=OFF;
SQL
      [[ "$(sqlite3 -batch -noheader "$database" \
        "SELECT instr(sql, 'title TEXT NOT NULL CHECK') FROM sqlite_schema WHERE name='photos';")" == '0' ]] ||
        fail 'unconstrained schema mutation did not apply'
      ;;
    wrong-index)
      sqlite3 "$database" <<'SQL'
DROP INDEX photos_public_order_idx;
CREATE INDEX photos_public_order_idx ON photos(id);
SQL
      ;;
    extra-table)
      sqlite3 "$database" 'CREATE TABLE unexpected_restore_data(value TEXT);'
      ;;
    *) fail "unknown schema mutation: $variant" ;;
  esac
}

canonical_schema_fingerprint() {
  local database="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sqlite3 -batch -noheader "$database" \
      "SELECT type || '|' || hex(name) || '|' || hex(tbl_name) || '|' || hex(sql)
       FROM sqlite_schema
       WHERE type IN ('table','index','view','trigger') AND name NOT GLOB 'sqlite_*'
       ORDER BY type,name,tbl_name;" | sha256sum | awk '{print $1}'
  else
    sqlite3 -batch -noheader "$database" \
      "SELECT type || '|' || hex(name) || '|' || hex(tbl_name) || '|' || hex(sql)
       FROM sqlite_schema
       WHERE type IN ('table','index','view','trigger') AND name NOT GLOB 'sqlite_*'
       ORDER BY type,name,tbl_name;" | shasum -a 256 | awk '{print $1}'
  fi
}

test_restore_resource_limits() {
  local live_root="$TEST_ROOT/limit-live/sweet-memories"

  create_reference_archive limits

  reset_fakes
  TEST_MAX_ARCHIVE_BYTES=1
  export TEST_MAX_ARCHIVE_BYTES
  assert_fails 'compressed archive limit' 'archive exceeds maximum size' \
    invoke_restore "$live_root" verify "$TEST_REFERENCE_ARCHIVE"
  ! grep -Fq 'tar:extract' "$EVENT_LOG" ||
    fail 'compressed archive limit called tar extraction'

  reset_fakes
  TEST_MAX_ARCHIVE_MEMBERS=3
  export TEST_MAX_ARCHIVE_MEMBERS
  assert_fails 'archive member limit' 'archive member limit exceeded' \
    invoke_restore "$live_root" verify "$TEST_REFERENCE_ARCHIVE"
  ! grep -Fq 'tar:extract' "$EVENT_LOG" ||
    fail 'archive member limit called tar extraction'

  reset_fakes
  TEST_MAX_EXPANDED_BYTES=1
  export TEST_MAX_EXPANDED_BYTES
  assert_fails 'declared expanded size limit' 'declared archive size exceeds maximum' \
    invoke_restore "$live_root" verify "$TEST_REFERENCE_ARCHIVE"
  ! grep -Fq 'tar:extract' "$EVENT_LOG" ||
    fail 'declared expanded size limit called tar extraction'

  reset_fakes
  FAKE_DF_AVAILABLE_KB=1
  export FAKE_DF_AVAILABLE_KB
  assert_fails 'verify extraction capacity' 'insufficient free space before archive extraction' \
    invoke_restore "$live_root" verify "$TEST_REFERENCE_ARCHIVE"
  ! grep -Fq 'tar:extract' "$EVENT_LOG" ||
    fail 'verify capacity failure called tar extraction'

  reset_fakes
  FAKE_TAR_LIST_MODE=underdeclare
  export FAKE_TAR_LIST_MODE
  assert_fails 'post-extract declared size' 'extracted archive does not match declared size' \
    invoke_restore "$live_root" verify "$TEST_REFERENCE_ARCHIVE"
}

test_complete_schema_and_uuid() {
  local minimal_root="$TEST_ROOT/minimal-schema/sweet-memories"
  local minimal_id

  reset_fakes
  minimal_id="$(fixture_photo_id minimal-schema)"
  create_minimal_schema_fixture "$minimal_root" "$minimal_id"
  assert_fails 'minimal two-table backup schema' 'copied database failed schema contract' \
    invoke_backup "$minimal_root" "$minimal_root/backups/manual"

  create_reference_archive schema
  local tree="$TEST_ROOT/minimal-restore-tree"
  local archive_dir="$TEST_ROOT/minimal-restore-archive"
  local archive="$archive_dir/sweet-memories-data-20260903T030001Z.tar.gz"
  mkdir -m 0700 "$tree" "$archive_dir"
  "$REAL_TAR" -xzf "$TEST_REFERENCE_ARCHIVE" -C "$tree"
  rm "$tree/database/sweet-memories.sqlite3"
  sqlite3 "$tree/database/sweet-memories.sqlite3" <<SQL
CREATE TABLE photos(id TEXT PRIMARY KEY);
CREATE TABLE photo_assets(photo_id TEXT, relative_path TEXT);
INSERT INTO photos(id) VALUES('$minimal_id');
INSERT INTO photo_assets(photo_id, relative_path)
VALUES('$minimal_id', '$minimal_id/master.jpg');
SQL
  rm -rf "$tree/media"
  mkdir -p "$tree/media/$minimal_id"
  printf 'minimal-restore\n' >"$tree/media/$minimal_id/master.jpg"
  regenerate_tree_metadata "$tree"
  repack_tree "$tree" "$archive"
  reset_fakes
  assert_fails 'minimal two-table restore schema' 'SQLite schema contract failed' \
    invoke_restore "$minimal_root" verify "$archive"

  local bad_uuid_root="$TEST_ROOT/bad-uuid/sweet-memories"
  create_data_fixture "$bad_uuid_root" bad-uuid
  local old_id
  old_id="$(fixture_photo_id bad-uuid)"
  sqlite3 "$bad_uuid_root/database/sweet-memories.sqlite3" <<SQL
PRAGMA foreign_keys=OFF;
UPDATE photos SET id='not-a-uuid';
UPDATE photo_assets SET photo_id='not-a-uuid', relative_path='not-a-uuid/master.jpg';
SQL
  mv "$bad_uuid_root/media/$old_id" "$bad_uuid_root/media/not-a-uuid"
  reset_fakes
  assert_fails 'non-canonical UUID backup' 'database photo ID is not a canonical UUID' \
    invoke_backup "$bad_uuid_root" "$bad_uuid_root/backups/manual"

  local bad_uuid_tree="$TEST_ROOT/bad-uuid-restore-tree"
  local bad_uuid_archive_dir="$TEST_ROOT/bad-uuid-restore-archive"
  local bad_uuid_archive="$bad_uuid_archive_dir/sweet-memories-data-20260903T030002Z.tar.gz"
  mkdir -m 0700 "$bad_uuid_tree" "$bad_uuid_archive_dir"
  "$REAL_TAR" -xzf "$TEST_REFERENCE_ARCHIVE" -C "$bad_uuid_tree"
  local reference_id
  reference_id="$(fixture_photo_id schema)"
  sqlite3 "$bad_uuid_tree/database/sweet-memories.sqlite3" <<SQL
PRAGMA foreign_keys=OFF;
UPDATE photos SET id='not-a-uuid';
UPDATE photo_assets SET photo_id='not-a-uuid', relative_path='not-a-uuid/master.jpg';
SQL
  mv "$bad_uuid_tree/media/$reference_id" "$bad_uuid_tree/media/not-a-uuid"
  regenerate_tree_metadata "$bad_uuid_tree"
  repack_tree "$bad_uuid_tree" "$bad_uuid_archive"
  reset_fakes
  assert_fails 'non-canonical UUID restore' 'database photo ID is not a canonical UUID' \
    invoke_restore "$minimal_root" verify "$bad_uuid_archive"
}

test_exact_schema_fingerprint() {
  local reference_root="$TEST_ROOT/schema-fingerprint-reference/sweet-memories"
  local variant root tree archive_dir archive timestamp index=0
  local expected backup_constant restore_constant migration_db

  create_reference_archive schema-fingerprint
  for variant in unconstrained wrong-index extra-table; do
    index=$((index + 1))
    root="$TEST_ROOT/schema-$variant-backup/sweet-memories"
    create_data_fixture "$root" "schema-$variant"
    mutate_schema_contract "$root/database/sweet-memories.sqlite3" "$variant"
    reset_fakes
    assert_fails "$variant backup schema" 'copied database schema fingerprint is unsupported' \
      invoke_backup "$root" "$root/backups/manual"

    tree="$TEST_ROOT/schema-$variant-restore-tree"
    archive_dir="$TEST_ROOT/schema-$variant-restore-archive"
    timestamp="20260903T03100${index}Z"
    archive="$archive_dir/sweet-memories-data-$timestamp.tar.gz"
    mkdir -m 0700 "$tree" "$archive_dir"
    "$REAL_TAR" -xzf "$TEST_REFERENCE_ARCHIVE" -C "$tree"
    mutate_schema_contract "$tree/database/sweet-memories.sqlite3" "$variant"
    regenerate_tree_metadata "$tree"
    repack_tree "$tree" "$archive"
    reset_fakes
    assert_fails "$variant restore schema" 'SQLite schema fingerprint is unsupported' \
      invoke_restore "$reference_root" verify "$archive"
  done

  migration_db="$TEST_ROOT/schema-fingerprint.sqlite3"
  sqlite3 "$migration_db" <"$MIGRATION_SQL"
  expected="$(canonical_schema_fingerprint "$migration_db")"
  backup_constant="$(sed -n 's/^SCHEMA_FINGERPRINT_001=//p' "$BACKUP_SCRIPT")"
  restore_constant="$(sed -n 's/^SCHEMA_FINGERPRINT_001=//p' "$RESTORE_SCRIPT")"
  [[ "$backup_constant" == "$expected" && "$restore_constant" == "$expected" ]] ||
    fail '001 schema fingerprint constants do not match the real migration'
}

test_journal_publish_collision() {
  local live_root="$TEST_ROOT/journal-collision/sweet-memories"
  local journal="$TEST_ROOT/journal-collision/.sweet-memories-restore"
  local before_hash output status

  create_reference_archive journal-collision
  create_data_fixture "$live_root" journal-live
  before_hash="$(sha256_file "$live_root/database/sweet-memories.sqlite3")"
  reset_fakes
  TEST_JOURNAL_COLLISION_STAGE=old-moved
  export TEST_JOURNAL_COLLISION_STAGE
  set +e
  output="$(invoke_restore "$live_root" apply "$TEST_REFERENCE_ARCHIVE" 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 && -e "$JOURNAL_HOOK_MARKER" ]] ||
    fail "journal stage collision hook did not fire (status $status): $output"
  [[ -f "$journal/old-moved" && "$(cat "$journal/old-moved")" == 'third-party-journal' ]] ||
    fail 'journal stage collision overwrote or removed the sentinel'
  [[ "$(sha256_file "$live_root/database/sweet-memories.sqlite3")" == "$before_hash" ]] ||
    fail 'journal stage collision did not preserve live data'
}

test_kill_after_stop_before_move() {
  local live_root="$TEST_ROOT/kill-after-stop/sweet-memories"
  local journal="$TEST_ROOT/kill-after-stop/.sweet-memories-restore"
  local before_hash status

  create_reference_archive kill-before-move
  create_data_fixture "$live_root" kill-live
  before_hash="$(sha256_file "$live_root/database/sweet-memories.sqlite3")"
  reset_fakes
  FAKE_KILL_AFTER_STOP=1
  export FAKE_KILL_AFTER_STOP
  set +e
  invoke_restore "$live_root" apply "$TEST_REFERENCE_ARCHIVE" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -eq 137 && -e "$STOP_HOOK_MARKER" ]] ||
    fail "post-stop KILL returned $status without executing the hook"
  [[ -d "$journal" ]] || fail 'post-stop KILL did not retain a prepared journal'
  ! grep -Fq '^mv:' "$EVENT_LOG" || fail 'post-stop KILL occurred after the first data move'
  [[ "$(cat "$SYSTEMCTL_STATE")" == 'inactive' ]] || fail 'post-stop KILL fixture did not stop service'

  unset FAKE_KILL_AFTER_STOP
  rmdir "$LOCK_DIR" || fail 'post-stop KILL fixture lock was not left for kernel-style release'
  : >"$EVENT_LOG"
  assert_fails 'post-stop KILL recovery' 'recovered interrupted restore; rerun apply' \
    invoke_restore "$live_root" apply "$TEST_REFERENCE_ARCHIVE"
  [[ "$(cat "$SYSTEMCTL_STATE")" == 'active' ]] ||
    fail 'post-stop KILL recovery did not restart the original service'
  [[ "$(sha256_file "$live_root/database/sweet-memories.sqlite3")" == "$before_hash" ]] ||
    fail 'post-stop KILL recovery changed original data'
  [[ ! -e "$journal" ]] || fail 'post-stop KILL recovery retained its journal'

  local link_root="$TEST_ROOT/kill-after-stage-link/sweet-memories"
  local link_journal="$TEST_ROOT/kill-after-stage-link/.sweet-memories-restore"
  local link_hash
  create_data_fixture "$link_root" kill-link-live
  link_hash="$(sha256_file "$link_root/database/sweet-memories.sqlite3")"
  reset_fakes
  FAKE_KILL_AFTER_LINK_TO="$link_journal/service-stopped"
  export FAKE_KILL_AFTER_LINK_TO
  set +e
  invoke_restore "$link_root" apply "$TEST_REFERENCE_ARCHIVE" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -eq 137 && -e "$MV_HOOK_MARKER" ]] ||
    fail "post-stop stage-link KILL returned $status without executing the hook"
  ! grep -Fq '^mv:' "$EVENT_LOG" || fail 'stage-link KILL occurred after the first data move'
  [[ "$(file_link_count "$link_journal/service-stopped")" == '2' ]] ||
    fail 'stage-link KILL did not retain the interrupted hard-link publication'
  unset FAKE_KILL_AFTER_LINK_TO
  rmdir "$LOCK_DIR" || fail 'stage-link KILL fixture lock was not left for kernel-style release'
  : >"$EVENT_LOG"
  assert_fails 'stage-link KILL recovery' 'recovered interrupted restore; rerun apply' \
    invoke_restore "$link_root" apply "$TEST_REFERENCE_ARCHIVE"
  [[ "$(cat "$SYSTEMCTL_STATE")" == 'active' && ! -e "$link_journal" &&
    "$(sha256_file "$link_root/database/sweet-memories.sqlite3")" == "$link_hash" ]] ||
    fail 'stage-link KILL recovery did not restore original data and service'
}

test_journal_atomic_cleanup() {
  local metadata_root="$TEST_ROOT/metadata-link-kill/sweet-memories"
  local metadata_journal="$TEST_ROOT/metadata-link-kill/.sweet-memories-restore"
  local metadata_hash status output retired point index root journal

  create_reference_archive journal-atomic
  create_data_fixture "$metadata_root" metadata-live
  metadata_hash="$(sha256_file "$metadata_root/database/sweet-memories.sqlite3")"
  reset_fakes
  FAKE_KILL_AFTER_LINK_TO="$metadata_journal/metadata"
  export FAKE_KILL_AFTER_LINK_TO
  set +e
  invoke_restore "$metadata_root" apply "$TEST_REFERENCE_ARCHIVE" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" -eq 137 && -e "$MV_HOOK_MARKER" &&
    "$(file_link_count "$metadata_journal/metadata")" == '2' ]] ||
    fail 'metadata hard-link KILL fixture did not hit the double-link window'
  ! grep -Fq 'systemctl:stop' "$EVENT_LOG" ||
    fail 'metadata hard-link KILL occurred after service stop'
  unset FAKE_KILL_AFTER_LINK_TO
  rmdir "$LOCK_DIR" || fail 'metadata hard-link KILL did not leave the fixture lock'
  : >"$EVENT_LOG"
  assert_fails 'metadata hard-link KILL recovery' 'recovered interrupted restore; rerun apply' \
    invoke_restore "$metadata_root" apply "$TEST_REFERENCE_ARCHIVE"
  [[ ! -e "$metadata_journal" && "$(cat "$SYSTEMCTL_STATE")" == 'active' &&
    "$(sha256_file "$metadata_root/database/sweet-memories.sqlite3")" == "$metadata_hash" ]] ||
    fail 'metadata hard-link KILL recovery did not preserve original state'

  index=0
  for point in committed healthy new-installed old-moved service-stopped prepared metadata; do
    index=$((index + 1))
    root="$TEST_ROOT/cleanup-kill-$point/sweet-memories"
    journal="$(dirname "$root")/.sweet-memories-restore"
    create_data_fixture "$root" "cleanup-$point"
    reset_fakes
    FAKE_KILL_AFTER_REMOVE_BASENAME="$point"
    export FAKE_KILL_AFTER_REMOVE_BASENAME
    set +e
    invoke_restore "$root" apply "$TEST_REFERENCE_ARCHIVE" >/dev/null 2>&1
    status=$?
    set -e
    [[ "$status" -eq 137 && -e "$RM_HOOK_MARKER" ]] ||
      fail "journal cleanup KILL did not hit $point"
    [[ ! -e "$journal" ]] ||
      fail "journal cleanup KILL left the fixed journal visible after $point"
    retired="$(find "$(dirname "$root")" -mindepth 1 -maxdepth 1 -type d \
      -name '.sweet-memories-restore.retired.*' -print -quit)"
    [[ -n "$retired" ]] || fail "journal cleanup KILL did not retain a retired transaction after $point"
    unset FAKE_KILL_AFTER_REMOVE_BASENAME
    rmdir "$LOCK_DIR" || fail "journal cleanup KILL did not leave the fixture lock after $point"
    : >"$EVENT_LOG"
    FAKE_UTC_TIMESTAMP="20260903T04$(printf '%02d' "$index")00Z"
    export FAKE_UTC_TIMESTAMP
    output="$(invoke_restore "$root" apply "$TEST_REFERENCE_ARCHIVE" 2>&1)" ||
      fail "journal cleanup orphan recovery failed after $point: $output"
    [[ -z "$(find "$(dirname "$root")" -mindepth 1 -maxdepth 1 -type d \
      -name '.sweet-memories-restore.retired.*' -print -quit)" ]] ||
      fail "journal cleanup orphan remained after $point"
  done
}

test_backup_transaction_races() {
  local replace_root="$TEST_ROOT/backup-public-replace/sweet-memories"
  local archive output status success_root create_event

  reset_fakes
  archive="$replace_root/backups/manual/sweet-memories-data-$FAKE_UTC_TIMESTAMP.tar.gz"
  create_data_fixture "$replace_root" backup-public-replace
  TEST_BACKUP_REPLACE_PUBLIC_ARCHIVE=1
  export TEST_BACKUP_REPLACE_PUBLIC_ARCHIVE
  set +e
  output="$(invoke_backup "$replace_root" "$replace_root/backups/manual" 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 && -e "$BACKUP_HOOK_MARKER" ]] ||
    fail "public archive replacement hook did not fail backup (status $status): $output"
  [[ -f "$archive" && "$(cat "$archive")" == 'third-party-public' &&
    ! -e "$archive.sha256" ]] ||
    fail 'public archive replacement was overwritten or received a commit sidecar'
  [[ "$output" != *'backup archive:'* ]] || fail 'replaced public archive was reported as successful'
  [[ "$(cat "$SYSTEMCTL_STATE")" == 'active' ]] ||
    fail 'public archive replacement did not restore service health'

  reset_fakes
  success_root="$TEST_ROOT/backup-private-transaction/sweet-memories"
  create_data_fixture "$success_root" backup-private-transaction
  invoke_backup "$success_root" "$success_root/backups/manual" >/dev/null
  create_event="$(grep '^tar:create:' "$EVENT_LOG" | tail -1)"
  [[ "$create_event" == *':-czf - '* && "$create_event" == *'/.sweet-memories-backup.'* ]] ||
    fail "backup archive was not streamed into its owned workspace: $create_event"
  [[ -z "$(find "$success_root/backups/manual" -mindepth 1 -maxdepth 1 \
    -name '.sweet-memories-*' -print -quit)" ]] ||
    fail 'successful backup retained a public temporary path'

  if [[ "${TASK20_TEST_CASE:-all}" != 'all' ]]; then
    test_backup_publish_term
  fi
}

test_gnu_stat_fd_semantics() {
  local reference_archive backup_root restore_root apply_root
  local backup_output restore_output apply_output backup_status restore_status apply_status
  local backup_events restore_events apply_events format

  create_reference_archive gnu-stat-reference
  reference_archive="$TEST_REFERENCE_ARCHIVE"

  reset_fakes
  backup_root="$TEST_ROOT/gnu-stat-backup/sweet-memories"
  create_data_fixture "$backup_root" gnu-stat-backup
  FAKE_GNU_STAT=1
  export FAKE_GNU_STAT
  set +e
  backup_output="$(invoke_backup "$backup_root" "$backup_root/backups/manual" 2>&1)"
  backup_status=$?
  set -e
  backup_events="$(cat "$EVENT_LOG")"

  reset_fakes
  FAKE_GNU_STAT=1
  export FAKE_GNU_STAT
  restore_root="$TEST_ROOT/gnu-stat-verify/sweet-memories"
  set +e
  restore_output="$(invoke_restore "$restore_root" verify "$reference_archive" 2>&1)"
  restore_status=$?
  set -e
  restore_events="$(cat "$EVENT_LOG")"

  reset_fakes
  FAKE_GNU_STAT=1
  export FAKE_GNU_STAT
  apply_root="$TEST_ROOT/gnu-stat-apply/sweet-memories"
  create_data_fixture "$apply_root" gnu-stat-current
  set +e
  apply_output="$(invoke_restore "$apply_root" apply "$reference_archive" 2>&1)"
  apply_status=$?
  set -e
  apply_events="$(cat "$EVENT_LOG")"

  [[ "$backup_status" == '0' && "$restore_status" == '0' && "$apply_status" == '0' ]] ||
    fail "GNU stat FD semantics rejected valid files: backup=$backup_status [$backup_output], verify=$restore_status [$restore_output], apply=$apply_status [$apply_output]"
  for format in '%d:%i' '%s' '%h'; do
    [[ "$backup_events" == *"stat:gnu-follow:$format:/dev/fd/8"* &&
      "$backup_events" == *"stat:gnu-follow:$format:/dev/fd/7"* &&
      "$restore_events" == *"stat:gnu-follow:$format:/dev/fd/7"* &&
      "$apply_events" == *"stat:gnu-follow:$format:/dev/fd/8"* ]] ||
      fail "GNU stat fixture did not observe followed $format metadata across archive creation/fingerprint, restore input, and journal FD paths"
  done
}

test_preflight_journal_window() {
  local window="$1"
  local root journal reference_id status output incoming entries

  create_reference_archive "preflight-$window-reference"
  reference_id="$(fixture_photo_id "preflight-$window-reference")"
  root="$TEST_ROOT/preflight-$window/sweet-memories"
  journal="$(dirname "$root")/.sweet-memories-restore"
  create_data_fixture "$root" "preflight-$window-current"
  reset_fakes
  if [[ "$window" == 'mkdir' ]]; then
    FAKE_KILL_AFTER_JOURNAL_CREATE=1
    export FAKE_KILL_AFTER_JOURNAL_CREATE
  else
    FAKE_KILL_BEFORE_METADATA_LINK=1
    export FAKE_KILL_BEFORE_METADATA_LINK
  fi
  set +e
  invoke_restore "$root" apply "$TEST_REFERENCE_ARCHIVE" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == '137' && -e "$PREFLIGHT_HOOK_MARKER" ]] ||
    fail "preflight $window KILL fixture returned $status without hitting its hook"
  ! grep -Fq 'systemctl:stop' "$EVENT_LOG" ||
    fail "preflight $window KILL occurred after the service stop"
  [[ -d "$journal" && ! -L "$journal" && "$(file_mode "$journal")" == '700' ]] ||
    fail "preflight $window KILL did not retain a private journal directory"
  entries="$(find "$journal" -mindepth 1 -maxdepth 1 -print)"
  if [[ "$window" == 'mkdir' ]]; then
    [[ -z "$entries" ]] || fail 'journal mkdir KILL retained an unexpected entry'
  else
    incoming="$(find "$journal" -mindepth 1 -maxdepth 1 -type f \
      -name '.metadata.*' -print -quit)"
    [[ -n "$incoming" && "$entries" == "$incoming" &&
      "$(file_mode "$incoming")" == '600' && "$(file_link_count "$incoming")" == '1' ]] ||
      fail 'metadata pre-link KILL did not retain exactly one private incoming metadata file'
  fi

  unset FAKE_KILL_AFTER_JOURNAL_CREATE FAKE_KILL_BEFORE_METADATA_LINK
  rmdir "$LOCK_DIR" || fail "preflight $window KILL did not leave the fixture lock"
  : >"$EVENT_LOG"
  output="$(invoke_restore "$root" apply "$TEST_REFERENCE_ARCHIVE" 2>&1)" ||
    fail "preflight $window journal recovery failed: $output"
  [[ ! -e "$journal" && "$(cat "$SYSTEMCTL_STATE")" == 'active' &&
    -f "$root/media/$reference_id/master.jpg" ]] ||
    fail "preflight $window recovery did not complete a fresh restore"
}

test_preflight_journal_rejects_unknown() {
  local root journal status output incoming sentinel

  create_reference_archive preflight-unknown-reference

  root="$TEST_ROOT/preflight-unknown-entry/sweet-memories"
  journal="$(dirname "$root")/.sweet-memories-restore"
  create_data_fixture "$root" preflight-unknown-current
  reset_fakes
  FAKE_KILL_AFTER_JOURNAL_CREATE=1
  export FAKE_KILL_AFTER_JOURNAL_CREATE
  set +e
  invoke_restore "$root" apply "$TEST_REFERENCE_ARCHIVE" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == '137' ]] || fail 'unknown preflight journal fixture did not stop after mkdir'
  unset FAKE_KILL_AFTER_JOURNAL_CREATE
  rmdir "$LOCK_DIR" || fail 'unknown preflight fixture lock remained'
  printf 'third-party-entry\n' >"$journal/unexpected"
  : >"$EVENT_LOG"
  assert_fails 'unknown preflight journal entry' 'restore journal metadata is unsafe' \
    invoke_restore "$root" apply "$TEST_REFERENCE_ARCHIVE"
  [[ "$(cat "$journal/unexpected")" == 'third-party-entry' ]] ||
    fail 'unknown preflight journal entry was removed or replaced'
  ! grep -Fq 'systemctl:stop' "$EVENT_LOG" ||
    fail 'unknown preflight journal entry stopped the service'

  root="$TEST_ROOT/preflight-replaced-metadata/sweet-memories"
  journal="$(dirname "$root")/.sweet-memories-restore"
  create_data_fixture "$root" preflight-replaced-current
  reset_fakes
  FAKE_KILL_BEFORE_METADATA_LINK=1
  export FAKE_KILL_BEFORE_METADATA_LINK
  set +e
  invoke_restore "$root" apply "$TEST_REFERENCE_ARCHIVE" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == '137' ]] || fail 'replaced metadata fixture did not stop before link'
  unset FAKE_KILL_BEFORE_METADATA_LINK
  rmdir "$LOCK_DIR" || fail 'replaced metadata fixture lock remained'
  incoming="$(find "$journal" -mindepth 1 -maxdepth 1 -type f \
    -name '.metadata.*' -print -quit)"
  [[ -n "$incoming" ]] || fail 'replaced metadata fixture lacks its incoming file'
  sentinel="$TEST_ROOT/operation-owned-metadata"
  "$REAL_MV" "$incoming" "$sentinel"
  printf 'third-party-metadata\n' >"$incoming"
  chmod 0600 "$incoming"
  : >"$EVENT_LOG"
  assert_fails 'replaced preflight metadata' 'restore journal metadata is unsafe' \
    invoke_restore "$root" apply "$TEST_REFERENCE_ARCHIVE"
  [[ "$(cat "$incoming")" == 'third-party-metadata' && -f "$sentinel" ]] ||
    fail 'replaced preflight metadata was removed or overwritten'
  ! grep -Fq 'systemctl:stop' "$EVENT_LOG" ||
    fail 'replaced preflight metadata stopped the service'
}

case "${TASK20_TEST_CASE:-all}" in
  backup-publish-term) test_backup_publish_term ;;
  restore-limits) test_restore_resource_limits ;;
  schema-contract) test_complete_schema_and_uuid ;;
  schema-fingerprint) test_exact_schema_fingerprint ;;
  journal-collision) test_journal_publish_collision ;;
  kill-before-move) test_kill_after_stop_before_move ;;
  journal-atomic) test_journal_atomic_cleanup ;;
  backup-transaction) test_backup_transaction_races ;;
  gnu-stat-fd) test_gnu_stat_fd_semantics ;;
  preflight-mkdir) test_preflight_journal_window mkdir ;;
  preflight-metadata)
    test_preflight_journal_window metadata
    test_preflight_journal_rejects_unknown
    ;;
  all)
    test_restore_resource_limits
    test_complete_schema_and_uuid
    test_journal_publish_collision
    test_kill_after_stop_before_move
    test_exact_schema_fingerprint
    test_journal_atomic_cleanup
    test_backup_transaction_races
    test_gnu_stat_fd_semantics
    test_preflight_journal_window mkdir
    test_preflight_journal_window metadata
    test_preflight_journal_rejects_unknown
    ;;
  *) fail "unknown TASK20_TEST_CASE: ${TASK20_TEST_CASE:-}" ;;
esac
if [[ "${TASK20_TEST_CASE:-all}" != 'all' ]]; then
  printf '%s test passed\n' "$TASK20_TEST_CASE"
  exit 0
fi

reset_fakes
DATA_ROOT_A="$TEST_ROOT/var/lib/sweet-memories-a"
TARGET_A="$DATA_ROOT_A/backups/manual"
create_data_fixture "$DATA_ROOT_A" 'original'
ORIGINAL_PHOTO_ID="$(fixture_photo_id original)"
mkdir "$DATA_ROOT_A/media/.deleting"
invoke_backup "$DATA_ROOT_A" "$TARGET_A"
ARCHIVE_A="$TARGET_A/sweet-memories-data-$FAKE_UTC_TIMESTAMP.tar.gz"
SIDECAR_A="$ARCHIVE_A.sha256"
[[ -f "$ARCHIVE_A" && ! -L "$ARCHIVE_A" ]] || fail 'backup archive was not published'
[[ -f "$SIDECAR_A" && ! -L "$SIDECAR_A" ]] || fail 'backup sidecar was not published'
[[ "$(file_mode "$ARCHIVE_A")" == '600' && "$(file_mode "$SIDECAR_A")" == '600' ]] ||
  fail 'backup archive and sidecar are not private'
EXPECTED_SIDECAR="$(sha256_file "$ARCHIVE_A")  $(basename "$ARCHIVE_A")"
[[ "$(cat "$SIDECAR_A")" == "$EXPECTED_SIDECAR" ]] ||
  fail 'archive sidecar is not basename-only SHA-256'
MEMBERS="$(normalized_members "$ARCHIVE_A")"
for required in database database/sweet-memories.sqlite3 media \
  "media/$ORIGINAL_PHOTO_ID" "media/$ORIGINAL_PHOTO_ID/master.jpg" SHA256SUMS MANIFEST.txt; do
  grep -Fxq "$required" <<<"$MEMBERS" || fail "backup archive is missing $required"
done
if grep -Eq '(^|/)(staging|backups)(/|$)' <<<"$MEMBERS"; then
  fail 'backup archive contains staging or backups'
fi
if grep -Fq 'media/.deleting' <<<"$MEMBERS"; then
  fail 'backup archive contains the private deleting area'
fi
for member in $MEMBERS; do
  case "$member" in
    database|database/sweet-memories.sqlite3|media|media/*|SHA256SUMS|MANIFEST.txt) ;;
    *) fail "backup archive contains unexpected member $member" ;;
  esac
done
grep -Fq 'LOCK_FILE=/run/lock/sweet-memories-api-release.lock' "$BACKUP_SCRIPT" ||
  fail 'backup does not share the Task18 release lock'
grep -Fq 'LOCK_FILE=/run/lock/sweet-memories-api-release.lock' "$RESTORE_SCRIPT" ||
  fail 'restore does not share the Task18 release lock'
BACKUP_EXTRACT="$TEST_ROOT/backup-extract"
mkdir -m 0700 "$BACKUP_EXTRACT"
"$REAL_TAR" -xzf "$ARCHIVE_A" -C "$BACKUP_EXTRACT"
[[ "$(LC_ALL=C sort -k2,2 "$BACKUP_EXTRACT/SHA256SUMS")" == "$(cat "$BACKUP_EXTRACT/SHA256SUMS")" ]] ||
  fail 'SHA256SUMS is not sorted'
[[ "$(LC_ALL=C sort -t $'\t' -k3,3 "$BACKUP_EXTRACT/MANIFEST.txt")" == \
  "$(cat "$BACKUP_EXTRACT/MANIFEST.txt")" ]] || fail 'MANIFEST.txt is not path-sorted'
grep -Eq "^[0-9a-f]{64}[[:space:]]+$(file_size "$BACKUP_EXTRACT/database/sweet-memories.sqlite3")[[:space:]]+database/sweet-memories.sqlite3$" \
  "$BACKUP_EXTRACT/MANIFEST.txt" || fail 'manifest lacks database hash, size, and production relative path'
EVENTS="$(tr '\n' ' ' <"$EVENT_LOG")"
[[ "$EVENTS" == *capacity:*systemctl:stop*systemctl:is-active*systemctl:start*curl:* ]] ||
  fail "backup did not check capacity before stop and restore service health: $EVENTS"

reset_fakes
BOUNDARY_ROOT="$TEST_ROOT/var/lib/capacity-boundary"
create_data_fixture "$BOUNDARY_ROOT" 'capacity-boundary'
BOUNDARY_BYTES="$(fixture_data_bytes "$BOUNDARY_ROOT")"
BOUNDARY_REQUIRED=$((BOUNDARY_BYTES * 2 + 1073741824))
FAKE_DF_AVAILABLE_KB=$(((BOUNDARY_REQUIRED + 1023) / 1024 - 1))
export FAKE_DF_AVAILABLE_KB
assert_fails 'one-block-low capacity' 'insufficient free space' \
  invoke_backup "$BOUNDARY_ROOT" "$BOUNDARY_ROOT/backups/manual"
if grep -Fq 'systemctl:stop' "$EVENT_LOG"; then
  fail 'one-block-low capacity stopped the service'
fi
reset_fakes
FAKE_DF_AVAILABLE_KB=$(((BOUNDARY_REQUIRED + 1023) / 1024))
export FAKE_DF_AVAILABLE_KB
invoke_backup "$BOUNDARY_ROOT" "$BOUNDARY_ROOT/backups/manual"

reset_fakes
WAL_ROOT="$TEST_ROOT/var/lib/wal-latest"
create_data_fixture "$WAL_ROOT" 'wal-base'
WAL_PHOTO_ID="$(fixture_photo_id wal-latest)"
mkdir "$WAL_ROOT/media/$WAL_PHOTO_ID"
printf 'latest-wal-image\n' >"$WAL_ROOT/media/$WAL_PHOTO_ID/master.jpg"
WAL_PIPE="$TEST_ROOT/sqlite-writer.pipe"
mkfifo "$WAL_PIPE"
sqlite3 "$WAL_ROOT/database/sweet-memories.sqlite3" <"$WAL_PIPE" >/dev/null &
WAL_WRITER_PID=$!
exec 8>"$WAL_PIPE"
printf '%s\n' \
  'PRAGMA wal_autocheckpoint=0;' \
  "INSERT INTO photos(id,title,status,rotation,offset_x,offset_y,request_id,version,created_at,updated_at) VALUES('$WAL_PHOTO_ID','latest WAL','published',0,0,0,'request-$WAL_PHOTO_ID',1,'2026-09-03T02:03:04.000Z','2026-09-03T02:03:04.000Z');" \
  "INSERT INTO photo_assets(photo_id,kind,format,width,height,relative_path) VALUES('$WAL_PHOTO_ID','master','jpeg',1,1,'$WAL_PHOTO_ID/master.jpg');" >&8
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if [[ "$(sqlite3 "$WAL_ROOT/database/sweet-memories.sqlite3" \
    "SELECT count(*) FROM photos WHERE id='$WAL_PHOTO_ID';" 2>/dev/null)" == '1' ]]; then
    break
  fi
  "$REAL_SLEEP" 0.02
done
[[ -s "$WAL_ROOT/database/sweet-memories.sqlite3-wal" ]] ||
  fail 'WAL fixture did not retain the latest committed row outside the main database'
FAKE_SQLITE_WRITER_PIPE="$WAL_PIPE"
export FAKE_SQLITE_WRITER_PIPE
invoke_backup "$WAL_ROOT" "$WAL_ROOT/backups/manual"
exec 8>&-
wait "$WAL_WRITER_PID" 2>/dev/null || true
WAL_ARCHIVE="$WAL_ROOT/backups/manual/sweet-memories-data-$FAKE_UTC_TIMESTAMP.tar.gz"
WAL_EXTRACT="$TEST_ROOT/wal-extract"
mkdir "$WAL_EXTRACT"
"$REAL_TAR" -xzf "$WAL_ARCHIVE" -C "$WAL_EXTRACT"
[[ ! -e "$WAL_EXTRACT/database/sweet-memories.sqlite3-wal" &&
  ! -e "$WAL_EXTRACT/database/sweet-memories.sqlite3-shm" ]] ||
  fail 'backup archive retained SQLite auxiliary files'
[[ "$(sqlite3 "$WAL_EXTRACT/database/sweet-memories.sqlite3" \
  "SELECT count(*) FROM photos WHERE id='$WAL_PHOTO_ID';")" == '1' &&
  "$(cat "$WAL_EXTRACT/media/$WAL_PHOTO_ID/master.jpg")" == 'latest-wal-image' ]] ||
  fail 'backup omitted a committed WAL row or its media'

reset_fakes
FAKE_DF_AVAILABLE_KB=1
export FAKE_DF_AVAILABLE_KB
CAPACITY_ROOT="$TEST_ROOT/var/lib/capacity"
create_data_fixture "$CAPACITY_ROOT" 'capacity'
assert_fails 'insufficient capacity' 'insufficient free space' \
  invoke_backup "$CAPACITY_ROOT" "$CAPACITY_ROOT/backups/manual"
if grep -Fq 'systemctl:stop' "$EVENT_LOG"; then
  fail 'capacity failure stopped the service'
fi
grep -Fq 'systemctl:start' "$EVENT_LOG" || fail 'capacity failure did not run the service recovery trap'

reset_fakes
UNSAFE_ROOT="$TEST_ROOT/var/lib/unsafe"
create_data_fixture "$UNSAFE_ROOT" 'unsafe'
UNSAFE_PHOTO_ID="$(fixture_photo_id unsafe)"
ln -s /etc/passwd "$UNSAFE_ROOT/media/$UNSAFE_PHOTO_ID/link"
assert_fails 'symlink media' 'unsupported data entry' \
  invoke_backup "$UNSAFE_ROOT" "$UNSAFE_ROOT/backups/manual"
rm "$UNSAFE_ROOT/media/$UNSAFE_PHOTO_ID/link"
mkfifo "$UNSAFE_ROOT/media/$UNSAFE_PHOTO_ID/pipe"
assert_fails 'special media' 'unsupported data entry' \
  invoke_backup "$UNSAFE_ROOT" "$UNSAFE_ROOT/backups/manual"

reset_fakes
HARDLINK_DB_ROOT="$TEST_ROOT/var/lib/hardlink-db"
create_data_fixture "$HARDLINK_DB_ROOT" 'hardlink-db'
ln "$HARDLINK_DB_ROOT/database/sweet-memories.sqlite3" "$TEST_ROOT/database-hardlink"
assert_fails 'hard-linked database' 'hard-linked data file' \
  invoke_backup "$HARDLINK_DB_ROOT" "$HARDLINK_DB_ROOT/backups/manual"

reset_fakes
HARDLINK_MEDIA_ROOT="$TEST_ROOT/var/lib/hardlink-media"
create_data_fixture "$HARDLINK_MEDIA_ROOT" 'hardlink-media'
HARDLINK_MEDIA_ID="$(fixture_photo_id hardlink-media)"
ln "$HARDLINK_MEDIA_ROOT/media/$HARDLINK_MEDIA_ID/master.jpg" "$TEST_ROOT/media-hardlink"
assert_fails 'hard-linked media' 'hard-linked data file' \
  invoke_backup "$HARDLINK_MEDIA_ROOT" "$HARDLINK_MEDIA_ROOT/backups/manual"

reset_fakes
SWAP_ROOT="$TEST_ROOT/var/lib/source-swap"
create_data_fixture "$SWAP_ROOT" 'source-swap'
SWAP_PHOTO_ID="$(fixture_photo_id source-swap)"
FAKE_SWAP_SOURCE="$SWAP_ROOT/media/$SWAP_PHOTO_ID/master.jpg"
export FAKE_SWAP_SOURCE
assert_fails 'source identity replacement' 'data source identity changed during copy' \
  invoke_backup "$SWAP_ROOT" "$SWAP_ROOT/backups/manual"
[[ -e "$CP_HOOK_MARKER" ]] || fail 'source identity replacement hook did not execute'
[[ "$(cat "$FAKE_SWAP_SOURCE")" == 'attacker replacement' ]] ||
  fail 'source identity test did not retain the third-party replacement'

reset_fakes
DELETING_ROOT="$TEST_ROOT/var/lib/deleting"
create_data_fixture "$DELETING_ROOT" 'deleting'
mkdir -p "$DELETING_ROOT/media/.deleting/retained"
printf 'private-deleted-data\n' >"$DELETING_ROOT/media/.deleting/retained/master.jpg"
assert_fails 'non-empty deleting area' 'media deleting area is not empty' \
  invoke_backup "$DELETING_ROOT" "$DELETING_ROOT/backups/manual"

reset_fakes
NO_CLOBBER_HASH="$(sha256_file "$ARCHIVE_A")"
assert_fails 'same timestamp output' 'backup output already exists' \
  invoke_backup "$DATA_ROOT_A" "$TARGET_A"
[[ "$(sha256_file "$ARCHIVE_A")" == "$NO_CLOBBER_HASH" ]] ||
  fail 'same timestamp backup overwrote the existing archive'
if grep -Fq 'systemctl:stop' "$EVENT_LOG"; then
  fail 'known output collision stopped the service'
fi

reset_fakes
STOP_STUCK_ROOT="$TEST_ROOT/var/lib/stop-stuck"
create_data_fixture "$STOP_STUCK_ROOT" 'stop-stuck'
FAKE_STOP_STUCK=1
export FAKE_STOP_STUCK
assert_fails 'service remained active' 'API service is still active after stop' \
  invoke_backup "$STOP_STUCK_ROOT" "$STOP_STUCK_ROOT/backups/manual"
if grep -Fq '^mv:' "$EVENT_LOG"; then
  fail 'stop-stuck backup moved data or output files'
fi

reset_fakes
FAIL_ROOT="$TEST_ROOT/var/lib/fail-after-stop"
create_data_fixture "$FAIL_ROOT" 'trap'
FAKE_TAR_CREATE_FAIL=1
export FAKE_TAR_CREATE_FAIL
assert_fails 'archive creation failure' 'archive creation failed' \
  invoke_backup "$FAIL_ROOT" "$FAIL_ROOT/backups/manual"
grep -Fq 'systemctl:stop' "$EVENT_LOG" || fail 'archive failure did not occur after stop'
grep -Fq 'systemctl:start' "$EVENT_LOG" || fail 'archive failure did not restart the service'
grep -Fq 'curl:' "$EVENT_LOG" || fail 'archive failure did not check loopback health'

test_backup_publish_term

reset_fakes
ORIGINAL_ARCHIVE_HASH="$(sha256_file "$ARCHIVE_A")"
ORIGINAL_DATA_HASH="$(sha256_file "$DATA_ROOT_A/database/sweet-memories.sqlite3")"
invoke_restore "$DATA_ROOT_A" verify "$ARCHIVE_A"
[[ "$(sha256_file "$DATA_ROOT_A/database/sweet-memories.sqlite3")" == "$ORIGINAL_DATA_HASH" ]] ||
  fail 'restore verify wrote production data'
if grep -Fq 'systemctl:' "$EVENT_LOG"; then
  fail 'restore verify called systemctl'
fi

reset_fakes
IMMUTABLE_INPUT_DIR="$TEST_ROOT/immutable-input"
IMMUTABLE_INPUT="$(copy_valid_archive "$IMMUTABLE_INPUT_DIR" 20260903T030000Z)"
FAKE_REPLACE_INPUT_AFTER_COPY="$IMMUTABLE_INPUT"
export FAKE_REPLACE_INPUT_AFTER_COPY
invoke_restore "$DATA_ROOT_A" verify "$IMMUTABLE_INPUT"
[[ -e "$CAT_HOOK_MARKER" && "$(cat "$IMMUTABLE_INPUT")" == \
  'attacker archive replacement' ]] ||
  fail 'archive replacement hook did not replace the caller path'
[[ -f "$IMMUTABLE_INPUT.operation-owned" ]] ||
  fail 'archive replacement did not preserve the copied source inode'

reset_fakes
SYMLINK_INPUT_DIR="$TEST_ROOT/input-symlink"
mkdir "$SYMLINK_INPUT_DIR"
SYMLINK_INPUT="$SYMLINK_INPUT_DIR/sweet-memories-data-20260903T030001Z.tar.gz"
ln -s "$ARCHIVE_A" "$SYMLINK_INPUT"
write_sidecar "$SYMLINK_INPUT"
assert_fails 'symlink archive input' 'single-link ordinary file' \
  invoke_restore "$DATA_ROOT_A" verify "$SYMLINK_INPUT"

reset_fakes
HARDLINK_INPUT_ORIGIN_DIR="$TEST_ROOT/input-hardlink-origin"
HARDLINK_INPUT_DIR="$TEST_ROOT/input-hardlink"
mkdir "$HARDLINK_INPUT_ORIGIN_DIR" "$HARDLINK_INPUT_DIR"
HARDLINK_INPUT_ORIGIN="$HARDLINK_INPUT_ORIGIN_DIR/sweet-memories-data-20260903T030002Z.tar.gz"
HARDLINK_INPUT="$HARDLINK_INPUT_DIR/sweet-memories-data-20260903T030002Z.tar.gz"
cp "$ARCHIVE_A" "$HARDLINK_INPUT_ORIGIN"
ln "$HARDLINK_INPUT_ORIGIN" "$HARDLINK_INPUT"
write_sidecar "$HARDLINK_INPUT"
assert_fails 'hardlink archive input' 'single-link ordinary file' \
  invoke_restore "$DATA_ROOT_A" verify "$HARDLINK_INPUT"

reset_fakes
FIFO_INPUT_DIR="$TEST_ROOT/input-fifo"
mkdir "$FIFO_INPUT_DIR"
FIFO_INPUT="$FIFO_INPUT_DIR/sweet-memories-data-20260903T030003Z.tar.gz"
mkfifo "$FIFO_INPUT"
printf '%064d  %s\n' 0 "$(basename "$FIFO_INPUT")" >"$FIFO_INPUT.sha256"
assert_fails 'FIFO archive input' 'single-link ordinary file' \
  invoke_restore "$DATA_ROOT_A" verify "$FIFO_INPUT"

reset_fakes
SIDECAR_SYMLINK_DIR="$TEST_ROOT/sidecar-symlink"
SIDECAR_SYMLINK_ARCHIVE="$(copy_valid_archive "$SIDECAR_SYMLINK_DIR" 20260903T030004Z)"
rm "$SIDECAR_SYMLINK_ARCHIVE.sha256"
ln -s "$SIDECAR_A" "$SIDECAR_SYMLINK_ARCHIVE.sha256"
assert_fails 'symlink sidecar input' 'single-link ordinary file' \
  invoke_restore "$DATA_ROOT_A" verify "$SIDECAR_SYMLINK_ARCHIVE"

reset_fakes
SIDECAR_HARDLINK_DIR="$TEST_ROOT/sidecar-hardlink"
SIDECAR_HARDLINK_ARCHIVE="$(copy_valid_archive "$SIDECAR_HARDLINK_DIR" 20260903T030005Z)"
ln "$SIDECAR_HARDLINK_ARCHIVE.sha256" "$TEST_ROOT/sidecar-second-link"
assert_fails 'hardlink sidecar input' 'single-link ordinary file' \
  invoke_restore "$DATA_ROOT_A" verify "$SIDECAR_HARDLINK_ARCHIVE"

reset_fakes
SIDECAR_FIFO_DIR="$TEST_ROOT/sidecar-fifo"
SIDECAR_FIFO_ARCHIVE="$(copy_valid_archive "$SIDECAR_FIFO_DIR" 20260903T030006Z)"
rm "$SIDECAR_FIFO_ARCHIVE.sha256"
mkfifo "$SIDECAR_FIFO_ARCHIVE.sha256"
assert_fails 'FIFO sidecar input' 'single-link ordinary file' \
  invoke_restore "$DATA_ROOT_A" verify "$SIDECAR_FIFO_ARCHIVE"

reset_fakes
BAD_SIDECAR_DIR="$TEST_ROOT/bad-sidecar"
mkdir "$BAD_SIDECAR_DIR"
BAD_SIDECAR="$BAD_SIDECAR_DIR/sweet-memories-data-20260903T020305Z.tar.gz"
cp "$ARCHIVE_A" "$BAD_SIDECAR"
printf '%064d  %s\n' 0 "$(basename "$BAD_SIDECAR")" >"$BAD_SIDECAR.sha256"
assert_fails 'bad archive sidecar' 'archive checksum mismatch' \
  invoke_restore "$DATA_ROOT_A" verify "$BAD_SIDECAR"
if grep -Fq 'systemctl:' "$EVENT_LOG"; then
  fail 'failed restore verify called systemctl'
fi

reset_fakes
TRAVERSAL_DIR="$TEST_ROOT/traversal"
mkdir "$TRAVERSAL_DIR"
TRAVERSAL_ARCHIVE="$TRAVERSAL_DIR/sweet-memories-data-20260903T020306Z.tar.gz"
make_malicious_archive "$TRAVERSAL_ARCHIVE"
assert_fails 'path traversal archive' 'unsafe archive path' \
  invoke_restore "$DATA_ROOT_A" verify "$TRAVERSAL_ARCHIVE"

reset_fakes
ABSOLUTE_DIR="$TEST_ROOT/absolute"
mkdir "$ABSOLUTE_DIR"
ABSOLUTE_ARCHIVE="$ABSOLUTE_DIR/sweet-memories-data-20260903T020309Z.tar.gz"
make_absolute_archive "$ABSOLUTE_ARCHIVE"
assert_fails 'absolute-path archive' 'unsafe archive path' \
  invoke_restore "$DATA_ROOT_A" verify "$ABSOLUTE_ARCHIVE"

for kind in symlink hardlink fifo; do
  reset_fakes
  INTERNAL_SPECIAL_DIR="$TEST_ROOT/internal-special-$kind-archive"
  mkdir "$INTERNAL_SPECIAL_DIR"
  INTERNAL_SPECIAL_ARCHIVE="$INTERNAL_SPECIAL_DIR/sweet-memories-data-20260903T02031${#kind}Z.tar.gz"
  make_internal_special_archive "$kind" "$INTERNAL_SPECIAL_ARCHIVE"
  assert_fails "internal $kind archive entry" 'archive contains a non-ordinary entry' \
    invoke_restore "$DATA_ROOT_A" verify "$INTERNAL_SPECIAL_ARCHIVE"
done

reset_fakes
BROKEN_TREE="$TEST_ROOT/broken-reference"
mkdir -m 0700 "$BROKEN_TREE"
"$REAL_TAR" -xzf "$ARCHIVE_A" -C "$BROKEN_TREE"
rm "$BROKEN_TREE/media/$ORIGINAL_PHOTO_ID/master.jpg"
grep -v "media/$ORIGINAL_PHOTO_ID/master.jpg" "$BROKEN_TREE/SHA256SUMS" >"$BROKEN_TREE/SHA256SUMS.next"
mv "$BROKEN_TREE/SHA256SUMS.next" "$BROKEN_TREE/SHA256SUMS"
grep -v "media/$ORIGINAL_PHOTO_ID/master.jpg" "$BROKEN_TREE/MANIFEST.txt" >"$BROKEN_TREE/MANIFEST.next"
mv "$BROKEN_TREE/MANIFEST.next" "$BROKEN_TREE/MANIFEST.txt"
BROKEN_DIR="$TEST_ROOT/broken-reference-archive"
mkdir "$BROKEN_DIR"
BROKEN_ARCHIVE="$BROKEN_DIR/sweet-memories-data-20260903T020307Z.tar.gz"
repack_tree "$BROKEN_TREE" "$BROKEN_ARCHIVE"
assert_fails 'missing referenced media' 'database references missing media' \
  invoke_restore "$DATA_ROOT_A" verify "$BROKEN_ARCHIVE"

reset_fakes
ORPHAN_TREE="$TEST_ROOT/orphan-media"
mkdir -m 0700 "$ORPHAN_TREE"
"$REAL_TAR" -xzf "$ARCHIVE_A" -C "$ORPHAN_TREE"
printf 'orphan\n' >"$ORPHAN_TREE/media/$ORIGINAL_PHOTO_ID/orphan.jpg"
regenerate_tree_metadata "$ORPHAN_TREE"
ORPHAN_DIR="$TEST_ROOT/orphan-media-archive"
mkdir "$ORPHAN_DIR"
ORPHAN_ARCHIVE="$ORPHAN_DIR/sweet-memories-data-20260903T020313Z.tar.gz"
repack_tree "$ORPHAN_TREE" "$ORPHAN_ARCHIVE"
assert_fails 'orphan media' 'database and media file sets do not match' \
  invoke_restore "$DATA_ROOT_A" verify "$ORPHAN_ARCHIVE"

reset_fakes
MISMATCH_TREE="$TEST_ROOT/photo-id-mismatch"
mkdir -m 0700 "$MISMATCH_TREE"
"$REAL_TAR" -xzf "$ARCHIVE_A" -C "$MISMATCH_TREE"
MISMATCH_PHOTO_ID="$(fixture_photo_id mismatch-directory)"
mv "$MISMATCH_TREE/media/$ORIGINAL_PHOTO_ID" "$MISMATCH_TREE/media/$MISMATCH_PHOTO_ID"
sqlite3 "$MISMATCH_TREE/database/sweet-memories.sqlite3" \
  "UPDATE photo_assets SET relative_path='$MISMATCH_PHOTO_ID/master.jpg';"
regenerate_tree_metadata "$MISMATCH_TREE"
MISMATCH_DIR="$TEST_ROOT/photo-id-mismatch-archive"
mkdir "$MISMATCH_DIR"
MISMATCH_ARCHIVE="$MISMATCH_DIR/sweet-memories-data-20260903T020314Z.tar.gz"
repack_tree "$MISMATCH_TREE" "$MISMATCH_ARCHIVE"
assert_fails 'photo ID path mismatch' 'database media path does not match its photo ID' \
  invoke_restore "$DATA_ROOT_A" verify "$MISMATCH_ARCHIVE"

reset_fakes
NESTED_TREE="$TEST_ROOT/nested-media-path"
mkdir -m 0700 "$NESTED_TREE"
"$REAL_TAR" -xzf "$ARCHIVE_A" -C "$NESTED_TREE"
mkdir "$NESTED_TREE/media/$ORIGINAL_PHOTO_ID/nested"
mv "$NESTED_TREE/media/$ORIGINAL_PHOTO_ID/master.jpg" \
  "$NESTED_TREE/media/$ORIGINAL_PHOTO_ID/nested/master.jpg"
sqlite3 "$NESTED_TREE/database/sweet-memories.sqlite3" \
  "UPDATE photo_assets SET relative_path='$ORIGINAL_PHOTO_ID/nested/master.jpg';"
regenerate_tree_metadata "$NESTED_TREE"
NESTED_DIR="$TEST_ROOT/nested-media-path-archive"
mkdir "$NESTED_DIR"
NESTED_ARCHIVE="$NESTED_DIR/sweet-memories-data-20260903T020317Z.tar.gz"
repack_tree "$NESTED_TREE" "$NESTED_ARCHIVE"
assert_fails 'nested media path' 'database media path is unsafe' \
  invoke_restore "$DATA_ROOT_A" verify "$NESTED_ARCHIVE"

reset_fakes
FOREIGN_KEY_TREE="$TEST_ROOT/foreign-key-broken"
mkdir -m 0700 "$FOREIGN_KEY_TREE"
"$REAL_TAR" -xzf "$ARCHIVE_A" -C "$FOREIGN_KEY_TREE"
FOREIGN_KEY_PHOTO_ID="$(fixture_photo_id foreign-key-missing)"
mkdir "$FOREIGN_KEY_TREE/media/$FOREIGN_KEY_PHOTO_ID"
printf 'dangling\n' >"$FOREIGN_KEY_TREE/media/$FOREIGN_KEY_PHOTO_ID/master.jpg"
sqlite3 "$FOREIGN_KEY_TREE/database/sweet-memories.sqlite3" \
  "INSERT INTO photo_assets(photo_id,kind,format,width,height,relative_path) VALUES('$FOREIGN_KEY_PHOTO_ID','master','jpeg',1,1,'$FOREIGN_KEY_PHOTO_ID/master.jpg');"
regenerate_tree_metadata "$FOREIGN_KEY_TREE"
FOREIGN_KEY_DIR="$TEST_ROOT/foreign-key-broken-archive"
mkdir "$FOREIGN_KEY_DIR"
FOREIGN_KEY_ARCHIVE="$FOREIGN_KEY_DIR/sweet-memories-data-20260903T020316Z.tar.gz"
repack_tree "$FOREIGN_KEY_TREE" "$FOREIGN_KEY_ARCHIVE"
assert_fails 'foreign-key-broken archive' 'SQLite foreign key check failed' \
  invoke_restore "$DATA_ROOT_A" verify "$FOREIGN_KEY_ARCHIVE"

reset_fakes
assert_fails 'invalid apply preflight' 'archive checksum mismatch' \
  invoke_restore "$DATA_ROOT_A" apply "$BAD_SIDECAR"
if grep -Fq 'systemctl:' "$EVENT_LOG"; then
  fail 'invalid apply preflight called systemctl'
fi

reset_fakes
APPLY_ROOT="$TEST_ROOT/apply-parent/sweet-memories"
create_data_fixture "$APPLY_ROOT" 'current'
CURRENT_PHOTO_ID="$(fixture_photo_id current)"
printf 'current-only\n' >"$APPLY_ROOT/staging/current.marker"
APPLY_ARCHIVE="$APPLY_ROOT/backups/manual/sweet-memories-data-20260903T020308Z.tar.gz"
cp "$ARCHIVE_A" "$APPLY_ARCHIVE"
write_sidecar "$APPLY_ARCHIVE"
invoke_restore "$APPLY_ROOT" apply "$APPLY_ARCHIVE"
[[ "$(cat "$APPLY_ROOT/media/$ORIGINAL_PHOTO_ID/master.jpg")" == 'image-original' ]] ||
  fail 'restore apply did not install archived media'
[[ ! -e "$APPLY_ROOT/media/$CURRENT_PHOTO_ID" ]] || fail 'restore apply retained current media'
RECOVERY_BUNDLE="$(find "$(dirname "$APPLY_ROOT")" -mindepth 1 -maxdepth 1 \
  -type d -name 'sweet-memories-recovery-*' -print -quit)"
[[ -n "$RECOVERY_BUNDLE" && -f "$RECOVERY_BUNDLE/staging/current.marker" ]] ||
  fail 'successful restore did not retain the original recovery bundle'
[[ ! -e "$(dirname "$APPLY_ROOT")/.sweet-memories-restore" ]] ||
  fail 'successful restore retained its crash journal'
[[ "$(file_mode "$APPLY_ROOT")" == '750' && \
  "$(file_mode "$APPLY_ROOT/database")" == '700' && \
  "$(file_mode "$APPLY_ROOT/database/sweet-memories.sqlite3")" == '600' && \
  "$(file_mode "$APPLY_ROOT/media")" == "$(if [[ "$(uname -s)" == 'Linux' ]]; then printf 2750; else printf 750; fi)" && \
  "$(file_mode "$APPLY_ROOT/media/$ORIGINAL_PHOTO_ID/master.jpg")" == '640' ]] ||
  fail 'restored ownership mode contract is incorrect'
[[ -d "$APPLY_ROOT/media/.deleting" && "$(file_mode "$APPLY_ROOT/media/.deleting")" == '700' &&
  -d "$APPLY_ROOT/staging" && -d "$APPLY_ROOT/backups/deploy" &&
  -d "$APPLY_ROOT/backups/manual" ]] ||
  fail 'restore did not recreate private runtime directories'
[[ ! -e "$APPLY_ROOT/database/sweet-memories.sqlite3-wal" &&
  ! -e "$APPLY_ROOT/database/sweet-memories.sqlite3-shm" ]] ||
  fail 'restore installed unmanifested SQLite auxiliary files'
grep -Fq 'chown:-R sweet-memories:sweet-memories-media' "$EVENT_LOG" ||
  fail 'restore apply did not normalize service ownership'

REFERENCE_ARCHIVE_DIR="$TEST_ROOT/apply-archive-reference"
mkdir "$REFERENCE_ARCHIVE_DIR"
REFERENCE_ARCHIVE="$REFERENCE_ARCHIVE_DIR/sweet-memories-data-20260903T020315Z.tar.gz"
cp "$ARCHIVE_A" "$REFERENCE_ARCHIVE"
write_sidecar "$REFERENCE_ARCHIVE"

reset_fakes
SERIAL_BACKUP_ROOT="$TEST_ROOT/serial-backup/sweet-memories"
SERIAL_RESTORE_ROOT="$TEST_ROOT/serial-restore/sweet-memories"
create_data_fixture "$SERIAL_BACKUP_ROOT" 'serial-backup'
create_data_fixture "$SERIAL_RESTORE_ROOT" 'serial-restore'
FAKE_STOP_DELAY=0.2
export FAKE_STOP_DELAY
invoke_backup "$SERIAL_BACKUP_ROOT" "$SERIAL_BACKUP_ROOT/backups/manual" \
  >"$TEST_ROOT/serial-backup.out" 2>&1 &
SERIAL_BACKUP_PID=$!
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  grep -Fq 'lock:acquire' "$EVENT_LOG" && break
  "$REAL_SLEEP" 0.02
done
grep -Fq 'lock:acquire' "$EVENT_LOG" || fail 'serialization fixture did not acquire the first lock'
invoke_restore "$SERIAL_RESTORE_ROOT" apply "$REFERENCE_ARCHIVE" \
  >"$TEST_ROOT/serial-restore.out" 2>&1 &
SERIAL_RESTORE_PID=$!
wait "$SERIAL_BACKUP_PID" || fail 'serialized backup failed'
wait "$SERIAL_RESTORE_PID" || fail 'serialized restore failed'
SERIAL_LOCK_EVENTS="$(grep '^lock:' "$EVENT_LOG" | tr '\n' ' ')"
[[ "$SERIAL_LOCK_EVENTS" == 'lock:acquire lock:release lock:acquire lock:release ' ]] ||
  fail "backup and restore maintenance locks overlapped: $SERIAL_LOCK_EVENTS"

reset_fakes
APPLY_CAPACITY_ROOT="$TEST_ROOT/apply-capacity-parent/sweet-memories"
create_data_fixture "$APPLY_CAPACITY_ROOT" 'apply-capacity'
FAKE_DF_AVAILABLE_KB=1
export FAKE_DF_AVAILABLE_KB
assert_fails 'restore capacity' 'insufficient free space before archive extraction' \
  invoke_restore "$APPLY_CAPACITY_ROOT" apply "$REFERENCE_ARCHIVE"
if grep -Fq 'systemctl:stop' "$EVENT_LOG"; then
  fail 'restore capacity failure stopped the service'
fi
if grep -Fq 'tar:extract' "$EVENT_LOG"; then
  fail 'restore capacity failure extracted the archive'
fi

reset_fakes
APPLY_STOP_STUCK_ROOT="$TEST_ROOT/apply-stop-stuck-parent/sweet-memories"
create_data_fixture "$APPLY_STOP_STUCK_ROOT" 'apply-stop-stuck'
FAKE_STOP_STUCK=1
export FAKE_STOP_STUCK
assert_fails 'restore service remained active' 'API service is still active after stop' \
  invoke_restore "$APPLY_STOP_STUCK_ROOT" apply "$REFERENCE_ARCHIVE"
if grep -Fq '^mv:' "$EVENT_LOG"; then
  fail 'stop-stuck restore moved production data'
fi

reset_fakes
ROLLBACK_ROOT="$TEST_ROOT/rollback-parent/sweet-memories"
create_data_fixture "$ROLLBACK_ROOT" 'rollback-current'
ROLLBACK_PHOTO_ID="$(fixture_photo_id rollback-current)"
ROLLBACK_DB_HASH="$(sha256_file "$ROLLBACK_ROOT/database/sweet-memories.sqlite3")"
ROLLBACK_MEDIA_HASH="$(sha256_file "$ROLLBACK_ROOT/media/$ROLLBACK_PHOTO_ID/master.jpg")"
FAKE_HEALTH_FAILURES=3
export FAKE_HEALTH_FAILURES
assert_fails 'unhealthy restored data' 'restored service health check failed' \
  invoke_restore "$ROLLBACK_ROOT" apply "$REFERENCE_ARCHIVE"
[[ "$(sha256_file "$ROLLBACK_ROOT/database/sweet-memories.sqlite3")" == "$ROLLBACK_DB_HASH" && \
  "$(sha256_file "$ROLLBACK_ROOT/media/$ROLLBACK_PHOTO_ID/master.jpg")" == "$ROLLBACK_MEDIA_HASH" ]] ||
  fail 'health failure did not roll back the original data'
[[ ! -e "$(dirname "$ROLLBACK_ROOT")/.sweet-memories-restore" ]] ||
  fail 'health rollback retained its crash journal'
[[ "$(cat "$SYSTEMCTL_STATE")" == 'active' ]] || fail 'health rollback did not restart the old service'

reset_fakes
START_FAILURE_ROOT="$TEST_ROOT/start-failure-parent/sweet-memories"
create_data_fixture "$START_FAILURE_ROOT" 'start-failure-current'
START_FAILURE_DB_HASH="$(sha256_file "$START_FAILURE_ROOT/database/sweet-memories.sqlite3")"
START_FAILURE_JOURNAL="$(dirname "$START_FAILURE_ROOT")/.sweet-memories-restore"
FAKE_START_FAIL=1
export FAKE_START_FAIL
set +e
START_FAILURE_OUTPUT="$(invoke_restore "$START_FAILURE_ROOT" apply "$REFERENCE_ARCHIVE" 2>&1)"
START_FAILURE_STATUS=$?
set -e
[[ "$START_FAILURE_STATUS" -ne 0 &&
  "$(sha256_file "$START_FAILURE_ROOT/database/sweet-memories.sqlite3")" == \
    "$START_FAILURE_DB_HASH" ]] ||
  fail 'start failure did not restore the original data'
[[ -d "$START_FAILURE_JOURNAL" &&
  "$START_FAILURE_OUTPUT" == *'journal retained for manual recovery'* ]] ||
  fail 'failed compensation did not retain its recovery journal'
reset_fakes
assert_fails 'start-failure journal recovery' 'recovered interrupted restore; rerun apply' \
  invoke_restore "$START_FAILURE_ROOT" apply "$REFERENCE_ARCHIVE"
[[ ! -e "$START_FAILURE_JOURNAL" && "$(cat "$SYSTEMCTL_STATE")" == 'active' ]] ||
  fail 'rerun did not finish the interrupted compensation'

reset_fakes
COLLISION_ROOT="$TEST_ROOT/collision-parent/sweet-memories"
create_data_fixture "$COLLISION_ROOT" 'collision-current'
COLLISION_RECOVERY="$(dirname "$COLLISION_ROOT")/sweet-memories-recovery-$FAKE_UTC_TIMESTAMP"
mkdir "$COLLISION_RECOVERY"
printf 'do-not-overwrite\n' >"$COLLISION_RECOVERY/sentinel"
assert_fails 'recovery bundle collision' 'recovery bundle already exists' \
  invoke_restore "$COLLISION_ROOT" apply "$REFERENCE_ARCHIVE"
[[ "$(cat "$COLLISION_RECOVERY/sentinel")" == 'do-not-overwrite' ]] ||
  fail 'restore overwrote a recovery collision'
if grep -Fq 'systemctl:stop' "$EVENT_LOG"; then
  fail 'recovery collision was detected after stopping the service'
fi

for signal_window in recovery live; do
  reset_fakes
  TERM_ROOT="$TEST_ROOT/term-$signal_window-parent/sweet-memories"
  create_data_fixture "$TERM_ROOT" "term-$signal_window-current"
  TERM_CURRENT_ID="$(fixture_photo_id "term-$signal_window-current")"
  TERM_DB_HASH="$(sha256_file "$TERM_ROOT/database/sweet-memories.sqlite3")"
  if [[ "$signal_window" == 'recovery' ]]; then
    FAKE_TERM_AFTER_MOVE_TO="$(dirname "$TERM_ROOT")/sweet-memories-recovery-$FAKE_UTC_TIMESTAMP"
  else
    FAKE_TERM_AFTER_MOVE_TO="$TERM_ROOT"
  fi
  export FAKE_TERM_AFTER_MOVE_TO
  set +e
  invoke_restore "$TERM_ROOT" apply "$REFERENCE_ARCHIVE" >/dev/null 2>&1
  TERM_STATUS=$?
  set -e
  [[ "$TERM_STATUS" -eq 143 ]] ||
    fail "TERM $signal_window window returned $TERM_STATUS instead of 143"
  [[ "$(sha256_file "$TERM_ROOT/database/sweet-memories.sqlite3")" == "$TERM_DB_HASH" &&
    -f "$TERM_ROOT/media/$TERM_CURRENT_ID/master.jpg" ]] ||
    fail "TERM $signal_window window did not restore the original data"
  [[ ! -e "$(dirname "$TERM_ROOT")/.sweet-memories-restore" ]] ||
    fail "TERM $signal_window window retained a completed journal"
  [[ "$(cat "$SYSTEMCTL_STATE")" == 'active' ]] ||
    fail "TERM $signal_window window did not restore service health"
done

reset_fakes
THIRD_PARTY_ROOT="$TEST_ROOT/third-party-parent/sweet-memories"
create_data_fixture "$THIRD_PARTY_ROOT" 'third-party-current'
THIRD_PARTY_RECOVERY="$(dirname "$THIRD_PARTY_ROOT")/sweet-memories-recovery-$FAKE_UTC_TIMESTAMP"
FAKE_REPLACE_AFTER_MOVE_TO="$THIRD_PARTY_ROOT"
FAKE_THIRD_PARTY_SENTINEL=external-owner
export FAKE_REPLACE_AFTER_MOVE_TO FAKE_THIRD_PARTY_SENTINEL
set +e
invoke_restore "$THIRD_PARTY_ROOT" apply "$REFERENCE_ARCHIVE" >/dev/null 2>&1
THIRD_PARTY_STATUS=$?
set -e
[[ "$THIRD_PARTY_STATUS" -eq 143 ]] ||
  fail "third-party live replacement returned $THIRD_PARTY_STATUS instead of 143"
[[ "$(cat "$THIRD_PARTY_ROOT/external-owner")" == 'third-party-live' ]] ||
  fail 'restore compensation overwrote third-party live data'
[[ -d "$THIRD_PARTY_RECOVERY" &&
  -d "$(dirname "$THIRD_PARTY_ROOT")/.sweet-memories-restore" ]] ||
  fail 'third-party conflict did not preserve recovery state for manual repair'

reset_fakes
JOURNAL_REPLACE_ROOT="$TEST_ROOT/journal-replace-parent/sweet-memories"
create_data_fixture "$JOURNAL_REPLACE_ROOT" 'journal-replace-current'
JOURNAL_REPLACE_PATH="$(dirname "$JOURNAL_REPLACE_ROOT")/.sweet-memories-restore"
JOURNAL_REPLACE_DB_HASH="$(sha256_file "$JOURNAL_REPLACE_ROOT/database/sweet-memories.sqlite3")"
mkdir "$JOURNAL_REPLACE_PATH"
printf 'third-party-journal\n' >"$JOURNAL_REPLACE_PATH/journal-owner"
assert_fails 'third-party journal collision' 'restore journal metadata is unsafe' \
  invoke_restore "$JOURNAL_REPLACE_ROOT" apply "$REFERENCE_ARCHIVE"
[[ "$(sha256_file "$JOURNAL_REPLACE_ROOT/database/sweet-memories.sqlite3")" == \
  "$JOURNAL_REPLACE_DB_HASH" ]] || fail 'journal replacement changed live production data'
[[ -d "$JOURNAL_REPLACE_PATH" &&
  "$(cat "$JOURNAL_REPLACE_PATH/journal-owner")" == 'third-party-journal' ]] ||
  fail 'restore cleanup removed a third-party journal replacement'

reset_fakes
CRASH_ROOT="$TEST_ROOT/crash-parent/sweet-memories"
create_data_fixture "$CRASH_ROOT" 'crash-current'
CRASH_DB_HASH="$(sha256_file "$CRASH_ROOT/database/sweet-memories.sqlite3")"
CRASH_RECOVERY="$(dirname "$CRASH_ROOT")/sweet-memories-recovery-$FAKE_UTC_TIMESTAMP"
FAKE_KILL_AFTER_MOVE_TO="$CRASH_RECOVERY"
export FAKE_KILL_AFTER_MOVE_TO
set +e
invoke_restore "$CRASH_ROOT" apply "$REFERENCE_ARCHIVE" >/dev/null 2>&1
CRASH_STATUS=$?
set -e
[[ "$CRASH_STATUS" -eq 137 ]] || fail "crash injection returned $CRASH_STATUS instead of 137"
[[ -d "$(dirname "$CRASH_ROOT")/.sweet-memories-restore" ]] ||
  fail 'crash window did not retain a recovery journal'
CRASH_JOURNAL="$(dirname "$CRASH_ROOT")/.sweet-memories-restore"
CRASH_WORKSPACE_NAME="$(sed -n 's/^workspace=//p' "$CRASH_JOURNAL/metadata")"
CRASH_WORKSPACE="$(dirname "$CRASH_ROOT")/$CRASH_WORKSPACE_NAME"
mv "$CRASH_WORKSPACE" "$CRASH_WORKSPACE.operation-owned"
mkdir "$CRASH_WORKSPACE"
printf 'third-party-workspace\n' >"$CRASH_WORKSPACE/sentinel"
reset_fakes
assert_fails 'crash journal recovery stop' 'recovered interrupted restore; rerun apply' \
  invoke_restore "$CRASH_ROOT" apply "$REFERENCE_ARCHIVE"
[[ "$(sha256_file "$CRASH_ROOT/database/sweet-memories.sqlite3")" == "$CRASH_DB_HASH" ]] ||
  fail 'journal recovery did not restore the pre-crash database'
[[ ! -e "$(dirname "$CRASH_ROOT")/.sweet-memories-restore" ]] ||
  fail 'journal recovery did not remove the completed journal'
[[ "$(cat "$CRASH_WORKSPACE/sentinel")" == 'third-party-workspace' ]] ||
  fail 'journal recovery removed a third-party workspace replacement'

[[ "$(sha256_file "$ARCHIVE_A")" == "$ORIGINAL_ARCHIVE_HASH" ]] ||
  fail 'restore reopened or modified its caller-owned archive'

printf 'data backup and restore tests passed\n'
