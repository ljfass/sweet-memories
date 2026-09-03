#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
MANAGER="$SCRIPT_DIR/manage-api-release.sh"
SYSTEMD_TEMPLATE="$REPOSITORY_ROOT/ops/systemd/sweet-memories-api.service"
NGINX_TEMPLATE="$REPOSITORY_ROOT/ops/nginx/sweet-memories-api.conf"
SUDOERS_TEMPLATE="$REPOSITORY_ROOT/ops/sudoers/sweet-memories-api"
TEST_ROOT="$(mktemp -d)"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local path="$1"
  local expected="$2"

  grep -Fqx -- "$expected" "$path" ||
    fail "$path does not contain the exact line: $expected"
}

assert_fails() {
  local label="$1"
  local expected="$2"
  local output
  shift 2

  if output="$("$@" 2>&1)"; then
    fail "$label unexpectedly succeeded"
  fi
  [[ "$output" == *"$expected"* ]] ||
    fail "$label failed without '$expected': $output"
}

resolve_link() {
  local path="$1"
  local target

  [[ -L "$path" ]] || fail "$path is not a symlink"
  target="$(readlink "$path")"
  if [[ "$target" != /* ]]; then
    target="$(dirname "$path")/$target"
  fi
  (cd "$target" && pwd -P)
}

assert_link() {
  local link="$1"
  local target="$2"

  [[ "$(resolve_link "$link")" == "$(cd "$target" && pwd -P)" ]] ||
    fail "$link does not point to $target"
}

file_mode() {
  local path="$1"

  if stat -c '%a' "$path" >/dev/null 2>&1; then
    stat -c '%a' "$path"
  else
    stat -f '%Lp' "$path"
  fi
}

[[ -f "$MANAGER" ]] || fail 'manage-api-release.sh does not exist'

REPOSITORY_ROOT="$REPOSITORY_ROOT" TEST_ROOT="$TEST_ROOT" \
  node --experimental-strip-types --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = process.env.REPOSITORY_ROOT;
const testRoot = process.env.TEST_ROOT;
assert.ok(repositoryRoot);
assert.ok(testRoot);
const databaseModuleUrl = pathToFileURL(
  join(repositoryRoot, 'apps/api/src/cli/database.ts'),
).href;
const betterSqliteUrl = pathToFileURL(
  join(repositoryRoot, 'apps/api/node_modules/better-sqlite3/lib/index.js'),
).href;
const { runDatabaseCommand } = await import(databaseModuleUrl);
const { default: Database } = await import(betterSqliteUrl);

const dataRoot = realpathSync(testRoot);
const deployBackupRoot = join(dataRoot, 'backups', 'deploy');
mkdirSync(deployBackupRoot, { recursive: true });
const database = new Database(join(dataRoot, 'source.sqlite3'));
database.exec('CREATE TABLE values_table(value TEXT NOT NULL)');
database.prepare('INSERT INTO values_table(value) VALUES (?)').run('preserved');
let migrationCount = 0;
const output = [];
const options = (argv) => ({
  argv,
  db: database,
  dataRoot,
  migrationsRoot: '/release/migrations',
  output: { write: (text) => output.push(text) },
  migrate: () => { migrationCount += 1; },
});
const backup = join(deployBackupRoot, 'before.sqlite3');
assert.equal(await runDatabaseCommand(options(['database', 'backup', backup])), 0);
assert.equal(migrationCount, 0);
assert.equal(statSync(backup).mode & 0o777, 0o600);
const restored = new Database(backup, { readonly: true });
assert.equal(restored.prepare('SELECT value FROM values_table').pluck().get(), 'preserved');
restored.close();
assert.equal(await runDatabaseCommand(options(['database', 'backup', backup])), 1);
assert.equal(
  await runDatabaseCommand(options(['database', 'backup', join(dataRoot, 'outside.sqlite3')])),
  1,
);
assert.equal(await runDatabaseCommand(options(['database', 'migrate'])), 0);
assert.equal(migrationCount, 1);
database.close();
NODE

REAL_TAR="$(command -v tar)"
REAL_SLEEP="$(command -v sleep)"
REAL_MV="$(command -v mv)"
MOCK_BIN="$TEST_ROOT/bin"
EVENT_LOG="$TEST_ROOT/events.log"
CHOWN_LOG="$TEST_ROOT/chown.log"
CURL_LOG="$TEST_ROOT/curl.log"
INSTALL_LOG="$TEST_ROOT/install.log"
LOCK_LOG="$TEST_ROOT/lock.log"
TAR_LOG="$TEST_ROOT/tar.log"
mkdir -p "$MOCK_BIN"
: >"$EVENT_LOG"
: >"$CHOWN_LOG"
: >"$CURL_LOG"
: >"$INSTALL_LOG"
: >"$LOCK_LOG"
: >"$TAR_LOG"

cat >"$MOCK_BIN/install" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$INSTALL_LOG"
mode=''
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index++)); do
  if [[ "${arguments[index]}" == '-m' ]]; then
    mode="${arguments[index + 1]}"
  fi
done
target="${!#}"
mkdir -p "$target"
if [[ -n "$mode" ]] && ! chmod "$mode" "$target"; then
  if [[ "$mode" == '2750' && "$(uname -s)" != 'Linux' ]]; then
    chmod 0750 "$target"
  else
    exit 1
  fi
fi
MOCK

cat >"$MOCK_BIN/chown" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CHOWN_LOG"
MOCK

cat >"$MOCK_BIN/mv" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
destination="${!#}"
"$REAL_MV" "$@"
if [[ -n "${FAKE_CURRENT_REPLACE_SIGNAL_MARKER:-}" &&
  "$destination" == */current &&
  ! -e "$FAKE_CURRENT_REPLACE_SIGNAL_MARKER" ]]; then
  : >"$FAKE_CURRENT_REPLACE_SIGNAL_MARKER"
  if [[ -n "${FAKE_CURRENT_REPLACE_THIRD_PARTY:-}" ]]; then
    third_party_temporary="$destination.third-party-$PPID"
    ln -s "$FAKE_CURRENT_REPLACE_THIRD_PARTY" "$third_party_temporary"
    if "$REAL_MV" --help 2>&1 | grep -q -- '-T,'; then
      "$REAL_MV" -Tf "$third_party_temporary" "$destination"
    else
      "$REAL_MV" -hf "$third_party_temporary" "$destination"
    fi
  fi
  kill -TERM "$PPID"
fi
MOCK

cat >"$MOCK_BIN/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 2 && "$1" == 'restart' && "$2" == 'sweet-memories-api.service' ]]
printf 'systemctl:%s:%s\n' "$1" "$2" >>"$EVENT_LOG"
if [[ -n "${FAKE_RESTART_BARRIER:-}" && ! -e "$FAKE_RESTART_BARRIER/used" ]]; then
  mkdir -p "$FAKE_RESTART_BARRIER"
  : >"$FAKE_RESTART_BARRIER/used"
  printf '%s\n' "$PPID" >"$FAKE_RESTART_BARRIER/manager-pid"
  : >"$FAKE_RESTART_BARRIER/ready"
  while [[ ! -e "$FAKE_RESTART_BARRIER/release" ]]; do
    "$REAL_SLEEP" 0.02
  done
fi
[[ "${FAKE_RESTART_FAIL:-0}" != '1' ]]
MOCK

cat >"$MOCK_BIN/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl:%s\n' "$*" >>"$EVENT_LOG"
printf '%s\n' "$*" >>"$CURL_LOG"
case "${FAKE_HEALTH_MODE:-healthy}" in
  healthy) exit 0 ;;
  fail) exit 22 ;;
  fail-twice)
    [[ "$(wc -l <"$CURL_LOG" | tr -d ' ')" -ge 3 ]]
    ;;
  *) exit 64 ;;
esac
MOCK

cat >"$MOCK_BIN/sleep" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'sleep:%s\n' "$*" >>"$EVENT_LOG"
MOCK

cat >"$MOCK_BIN/runuser" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'runuser:%s\n' "$*" >>"$EVENT_LOG"
[[ "$1" == '--user' && "$2" == 'sweet-memories' ]]
[[ "$3" == '--group' && "$4" == 'sweet-memories-media' && "$5" == '--' ]]
shift 5
[[ "$1" == 'env' && "$2" == '-i' ]]
data_root=''
for argument in "$@"; do
  case "$argument" in
    SWEET_MEMORIES_DATA_ROOT=*) data_root="${argument#*=}" ;;
  esac
done
[[ -n "$data_root" ]]
if [[ " $* " == *' database backup '* ]]; then
  output="${!#}"
  [[ ! -e "$output" ]]
  mkdir -p "$(dirname "$output")"
  : >"$output"
  printf 'backup\n' >>"$EVENT_LOG"
elif [[ " $* " == *' database migrate '* ]]; then
  printf 'migrate\n' >>"$EVENT_LOG"
  [[ "${FAKE_MIGRATE_FAIL:-0}" != '1' ]] || exit 1
  if [[ -n "${FAKE_MIGRATE_BARRIER:-}" && ! -e "$FAKE_MIGRATE_BARRIER/used" ]]; then
    mkdir -p "$FAKE_MIGRATE_BARRIER"
    : >"$FAKE_MIGRATE_BARRIER/used"
    : >"$FAKE_MIGRATE_BARRIER/ready"
    while [[ ! -e "$FAKE_MIGRATE_BARRIER/release" ]]; do
      "$REAL_SLEEP" 0.02
    done
  fi
  mkdir -p "$data_root/database"
  : >"$data_root/database/sweet-memories.sqlite3"
elif [[ " $* " == *' migration check-ready '* ||
  " $* " == *' migration activate '* ||
  " $* " == *' uploads enable '* ||
  " $* " == *' uploads disable '* ||
  " $* " == *' uploads status '* ]]; then
  printf 'management-cli\n' >>"$EVENT_LOG"
else
  exit 64
fi
MOCK

cat >"$MOCK_BIN/tar" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
archive=''
for argument in "$@"; do
  if [[ "$argument" == *.tar.gz && -f "$argument" ]]; then
    archive="$argument"
  fi
done
if [[ -n "$archive" ]]; then
  printf '%s\n' "$archive" >>"$TAR_LOG"
  mode="$(stat -c '%a' "$archive" 2>/dev/null || stat -f '%Lp' "$archive")"
  links="$(stat -c '%h' "$archive" 2>/dev/null || stat -f '%l' "$archive")"
  parent_mode="$(stat -c '%a' "$(dirname "$archive")" 2>/dev/null || stat -f '%Lp' "$(dirname "$archive")")"
  printf 'tar-meta:%s:%s:%s:%s\n' "$archive" "$mode" "$links" "$parent_mode" >>"$EVENT_LOG"
fi
if [[ -n "${FAKE_ARCHIVE_SWAP_SOURCE:-}" && ! -e "${FAKE_ARCHIVE_SWAP_MARKER:-}" ]]; then
  : >"$FAKE_ARCHIVE_SWAP_MARKER"
  mv -f "$FAKE_ARCHIVE_REPLACEMENT" "$FAKE_ARCHIVE_SWAP_SOURCE"
fi
if [[ "${FAKE_TAR_TERM:-0}" == '1' && " $* " == *' -x'* ]]; then
  staging=''
  while (($# > 0)); do
    if [[ "$1" == '-C' && $# -ge 2 ]]; then
      staging="$2"
      break
    fi
    shift
  done
  [[ -n "$staging" ]]
  mkdir -p "$staging/dist"
  printf 'partial\n' >"$staging/dist/index.js"
  kill -TERM "$PPID"
  exit 143
fi
exec "$REAL_TAR" "$@"
MOCK

cat >"$MOCK_BIN/flock" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ -n "${FAKE_LOCK_DIR:-}" ]]
case "$1" in
  -x|--exclusive)
    while ! mkdir "$FAKE_LOCK_DIR" 2>/dev/null; do
      "$REAL_SLEEP" 0.02
    done
    printf 'acquire:%s\n' "$PPID" >>"$LOCK_LOG"
    ;;
  -u|--unlock)
    rmdir "$FAKE_LOCK_DIR"
    printf 'release:%s\n' "$PPID" >>"$LOCK_LOG"
    ;;
  *) exit 64 ;;
esac
MOCK

chmod +x "$MOCK_BIN"/*
export REAL_TAR REAL_SLEEP REAL_MV EVENT_LOG CHOWN_LOG CURL_LOG INSTALL_LOG LOCK_LOG TAR_LOG

API_ROOT="$TEST_ROOT/opt/sweet-memories-api"
DATA_ROOT="$TEST_ROOT/var/lib/sweet-memories"

invoke_manager_at() {
  local api_root="$1"
  local data_root="$2"
  shift 2

  env PATH="$MOCK_BIN:$PATH" \
    REAL_TAR="$REAL_TAR" \
    REAL_SLEEP="$REAL_SLEEP" \
    REAL_MV="$REAL_MV" \
    EVENT_LOG="$EVENT_LOG" \
    CHOWN_LOG="$CHOWN_LOG" \
    CURL_LOG="$CURL_LOG" \
    INSTALL_LOG="$INSTALL_LOG" \
    LOCK_LOG="$LOCK_LOG" \
    TAR_LOG="$TAR_LOG" \
    FAKE_LOCK_DIR="$TEST_ROOT/.fixture-lock" \
    FAKE_ARCHIVE_SWAP_SOURCE="${FAKE_ARCHIVE_SWAP_SOURCE:-}" \
    FAKE_ARCHIVE_REPLACEMENT="${FAKE_ARCHIVE_REPLACEMENT:-}" \
    FAKE_ARCHIVE_SWAP_MARKER="${FAKE_ARCHIVE_SWAP_MARKER:-}" \
    FAKE_HEALTH_MODE="${FAKE_HEALTH_MODE:-healthy}" \
    FAKE_MIGRATE_FAIL="${FAKE_MIGRATE_FAIL:-0}" \
    FAKE_MIGRATE_BARRIER="${FAKE_MIGRATE_BARRIER:-}" \
    FAKE_RESTART_FAIL="${FAKE_RESTART_FAIL:-0}" \
    FAKE_RESTART_BARRIER="${FAKE_RESTART_BARRIER:-}" \
    FAKE_CURRENT_REPLACE_SIGNAL_MARKER="${FAKE_CURRENT_REPLACE_SIGNAL_MARKER:-}" \
    FAKE_CURRENT_REPLACE_THIRD_PARTY="${FAKE_CURRENT_REPLACE_THIRD_PARTY:-}" \
    FAKE_TAR_TERM="${FAKE_TAR_TERM:-0}" \
    bash -c '
      source "$1"
      API_ROOT="$2"
      DATA_ROOT="$3"
      ARCHIVE_ROOT="$4"
      LOCK_FILE="$4/sweet-memories-api-release.lock"
      SERVICE_NAME="sweet-memories-api.service"
      manage_api_release "${@:5}"
    ' _ "$MANAGER" "$api_root" "$data_root" "$TEST_ROOT" "$@"
}

invoke_manager() {
  invoke_manager_at "$API_ROOT" "$DATA_ROOT" "$@"
}

make_archive() {
  local archive="$1"
  local label="$2"
  local source

  source="$(mktemp -d "$TEST_ROOT/archive-source.XXXXXX")"
  mkdir -p "$source/dist" "$source/migrations" "$source/seed" "$source/node_modules/runtime"
  printf 'console.log(%q);\n' "$label" >"$source/dist/index.js"
  printf 'console.log(%q);\n' "$label-cli" >"$source/dist/cli.js"
  printf 'CREATE TABLE example(value TEXT);\n' >"$source/migrations/001_initial.sql"
  printf '{}\n' >"$source/seed/media-manifest.json"
  printf '{}\n' >"$source/package.json"
  printf '%s\n' "$label" >"$source/node_modules/runtime/index.js"
  "$REAL_TAR" -C "$source" -czf "$archive" .
  rm -rf "$source"
}

wait_for_path() {
  local path="$1"
  local label="$2"
  local attempt

  for attempt in $(seq 1 250); do
    [[ -e "$path" ]] && return 0
    "$REAL_SLEEP" 0.02
  done
  fail "timed out waiting for $label"
}

wait_for_process() {
  local pid="$1"
  local result_name="$2"
  local process_status

  set +e
  wait "$pid"
  process_status=$?
  set -e
  printf -v "$result_name" '%s' "$process_status"
}

reset_fixture_logs() {
  : >"$EVENT_LOG"
  : >"$CHOWN_LOG"
  : >"$CURL_LOG"
  : >"$INSTALL_LOG"
  : >"$LOCK_LOG"
  : >"$TAR_LOG"
}

probe_persistent_permissions() {
  local api_root="$TEST_ROOT/review-permissions/opt/sweet-memories-api"
  local data_root="$TEST_ROOT/review-permissions/var/lib/sweet-memories"
  local archive="$TEST_ROOT/review-permissions.tar.gz"
  local sha='6060606060606060606060606060606060606060'
  local path
  local expected_media_mode='2750'

  if [[ "$(uname -s)" != 'Linux' ]]; then
    expected_media_mode='750'
  fi

  make_archive "$archive" 'review-permissions'
  invoke_manager_at "$api_root" "$data_root" activate "$sha" "$archive"
  [[ "$(file_mode "$data_root")" == '750' ]] || fail 'data root mode must be 0750'
  for path in database staging backups backups/deploy; do
    [[ "$(file_mode "$data_root/$path")" == '700' ]] ||
      fail "$path mode must be 0700"
  done
  [[ "$(file_mode "$data_root/media")" == "$expected_media_mode" ]] ||
    fail "media mode must be $expected_media_mode on this host"

  chmod 0777 "$data_root/database" "$data_root/staging" "$data_root/backups" \
    "$data_root/backups/deploy" "$data_root/media"
  invoke_manager_at "$api_root" "$data_root" cli uploads status
  for path in database staging backups backups/deploy; do
    [[ "$(file_mode "$data_root/$path")" == '700' ]] ||
      fail "$path mode was not restored to 0700 on a later invocation"
  done
  [[ "$(file_mode "$data_root/media")" == "$expected_media_mode" ]] ||
    fail "media mode was not restored to $expected_media_mode on a later invocation"

  mkdir -p "$data_root/media/www-data-fixture"
  if ! chmod 2750 "$data_root/media/www-data-fixture"; then
    chmod 0750 "$data_root/media/www-data-fixture"
  fi
  printf 'media\n' >"$data_root/media/www-data-fixture/photo.jpg"
  chmod 0640 "$data_root/media/www-data-fixture/photo.jpg"
  [[ "$(file_mode "$data_root/media/www-data-fixture")" == "$expected_media_mode" &&
    "$(file_mode "$data_root/media/www-data-fixture/photo.jpg")" == '640' ]] ||
    fail 'www-data fixture does not grant group read/traverse without group write'
  grep -Fq -- "-o sweet-memories -g sweet-memories-media -m 2750 $data_root/media" \
    "$INSTALL_LOG" || fail 'media ownership/mode installation contract is missing'

  if [[ "$(id -u)" -eq 0 ]] && id -u www-data >/dev/null 2>&1 &&
    id -nG www-data 2>/dev/null | tr ' ' '\n' | grep -Fxq sweet-memories-media; then
    local access_fixture="$TEST_ROOT/www-data-media-access"

    install -d -o sweet-memories -g sweet-memories-media -m 2750 "$access_fixture"
    install -o sweet-memories -g sweet-memories-media -m 0640 \
      /dev/null "$access_fixture/photo.jpg"
    runuser --user www-data -- test -r "$access_fixture/photo.jpg" ||
      fail 'configured www-data user cannot read group-readable media'
    if runuser --user www-data -- test -w "$access_fixture/photo.jpg"; then
      fail 'configured www-data user can write group-readable media'
    fi
  else
    grep -Fq 'Group=sweet-memories-media' "$SYSTEMD_TEMPLATE" ||
      fail 'service template does not establish the media group contract'
    grep -Fq 'root /var/lib/sweet-memories;' "$NGINX_TEMPLATE" ||
      fail 'nginx template does not serve the protected media root'
  fi
}

probe_private_archive_copy() {
  local api_root="$TEST_ROOT/review-archive/opt/sweet-memories-api"
  local data_root="$TEST_ROOT/review-archive/var/lib/sweet-memories"
  local archive="$TEST_ROOT/review-archive.tar.gz"
  local replacement="$TEST_ROOT/review-archive-replacement.tar.gz"
  local marker="$TEST_ROOT/review-archive-swapped"
  local sha='6161616161616161616161616161616161616161'
  local tar_path unique_count

  reset_fixture_logs
  make_archive "$archive" 'immutable-original'
  make_archive "$replacement" 'attacker-replacement'
  FAKE_ARCHIVE_SWAP_SOURCE="$archive" \
  FAKE_ARCHIVE_REPLACEMENT="$replacement" \
  FAKE_ARCHIVE_SWAP_MARKER="$marker" \
    invoke_manager_at "$api_root" "$data_root" activate "$sha" "$archive"
  grep -Fq 'immutable-original' "$api_root/releases/$sha/dist/index.js" ||
    fail 'activation consumed the caller path after it was replaced'
  if grep -Fqx -- "$archive" "$TAR_LOG"; then
    fail 'tar reopened the mutable caller archive path'
  fi
  unique_count="$(sort -u "$TAR_LOG" | wc -l | tr -d ' ')"
  [[ "$unique_count" == '1' ]] || fail 'validation and extraction did not use one archive copy'
  tar_path="$(head -1 "$TAR_LOG")"
  [[ "$tar_path" == "$api_root"/.archive-*/release.tar.gz ]] ||
    fail 'archive was not copied into a root-owned private workspace'
  grep -Fq "tar-meta:$tar_path:400:1:700" "$EVENT_LOG" ||
    fail 'private archive copy was not mode 0400, single-linked, inside mode 0700'
  grep -Fq -- "root:root $tar_path" "$CHOWN_LOG" ||
    fail 'private archive copy was not normalized to root:root'
  [[ -z "$(find "$api_root" -maxdepth 1 -name '.archive-*' -print -quit)" ]] ||
    fail 'private archive workspace was not cleaned'
}

probe_cleanup_requires_five() {
  local api_root="$TEST_ROOT/review-cleanup/opt/sweet-memories-api"
  local data_root="$TEST_ROOT/review-cleanup/var/lib/sweet-memories"

  assert_fails 'cleanup count other than five' 'cleanup count must be exactly 5' \
    invoke_manager_at "$api_root" "$data_root" cleanup 4
}

probe_global_serialization() {
  local api_root="$TEST_ROOT/review-lock/opt/sweet-memories-api"
  local data_root="$TEST_ROOT/review-lock/var/lib/sweet-memories"
  local base_sha='6262626262626262626262626262626262626262'
  local first_sha='6363636363636363636363636363636363636363'
  local second_sha='6464646464646464646464646464646464646464'
  local third_sha='6565656565656565656565656565656565656565'
  local base_archive="$TEST_ROOT/review-lock-base.tar.gz"
  local first_archive="$TEST_ROOT/review-lock-first.tar.gz"
  local second_archive="$TEST_ROOT/review-lock-second.tar.gz"
  local third_archive="$TEST_ROOT/review-lock-third.tar.gz"
  local first_barrier="$TEST_ROOT/review-lock-first-barrier"
  local third_barrier="$TEST_ROOT/review-lock-third-barrier"
  local first_pid second_pid third_pid rollback_pid
  local first_status second_status third_status rollback_status
  local second_started_early=0 rollback_finished_early=0
  local acquire_count release_count

  reset_fixture_logs
  make_archive "$base_archive" 'lock-base'
  invoke_manager_at "$api_root" "$data_root" activate "$base_sha" "$base_archive"

  make_archive "$first_archive" 'lock-first'
  make_archive "$second_archive" 'lock-second'
  FAKE_MIGRATE_BARRIER="$first_barrier" \
    invoke_manager_at "$api_root" "$data_root" activate "$first_sha" "$first_archive" \
    >"$TEST_ROOT/review-lock-first.log" 2>&1 &
  first_pid=$!
  wait_for_path "$first_barrier/ready" 'first serialized migration barrier'
  invoke_manager_at "$api_root" "$data_root" activate "$second_sha" "$second_archive" \
    >"$TEST_ROOT/review-lock-second.log" 2>&1 &
  second_pid=$!
  "$REAL_SLEEP" 0.2
  if [[ -e "$api_root/releases/$second_sha" ]]; then
    second_started_early=1
  fi
  : >"$first_barrier/release"
  wait_for_process "$first_pid" first_status
  wait_for_process "$second_pid" second_status
  [[ "$second_started_early" -eq 0 ]] ||
    fail 'parallel activation entered the mutation phase before the first lock released'
  [[ "$first_status" -eq 0 && "$second_status" -eq 0 ]] ||
    fail "parallel activation failed: first=$first_status second=$second_status"
  assert_link "$api_root/current" "$api_root/releases/$second_sha"
  assert_link "$api_root/previous" "$api_root/releases/$first_sha"

  make_archive "$third_archive" 'lock-third'
  FAKE_MIGRATE_BARRIER="$third_barrier" \
    invoke_manager_at "$api_root" "$data_root" activate "$third_sha" "$third_archive" \
    >"$TEST_ROOT/review-lock-third.log" 2>&1 &
  third_pid=$!
  wait_for_path "$third_barrier/ready" 'conditional rollback serialization barrier'
  invoke_manager_at "$api_root" "$data_root" rollback-if-current "$second_sha" \
    >"$TEST_ROOT/review-lock-rollback.log" 2>&1 &
  rollback_pid=$!
  "$REAL_SLEEP" 0.2
  if ! kill -0 "$rollback_pid" 2>/dev/null; then
    rollback_finished_early=1
  fi
  : >"$third_barrier/release"
  wait_for_process "$third_pid" third_status
  wait_for_process "$rollback_pid" rollback_status
  [[ "$rollback_finished_early" -eq 0 ]] ||
    fail 'conditional rollback was not serialized behind activation'
  [[ "$third_status" -eq 0 && "$rollback_status" -ne 0 ]] ||
    fail "conditional rollback did not re-check current under lock: activate=$third_status rollback=$rollback_status"
  assert_link "$api_root/current" "$api_root/releases/$third_sha"

  invoke_manager_at "$api_root" "$data_root" cleanup 5
  invoke_manager_at "$api_root" "$data_root" cli uploads status
  [[ "$(file_mode "$TEST_ROOT/sweet-memories-api-release.lock")" == '600' ]] ||
    fail 'release lock file is not mode 0600'
  grep -Fq -- "root:root $TEST_ROOT/sweet-memories-api-release.lock" "$CHOWN_LOG" ||
    fail 'release lock file was not normalized to root:root'
  acquire_count="$(grep -c '^acquire:' "$LOCK_LOG" || true)"
  release_count="$(grep -c '^release:' "$LOCK_LOG" || true)"
  [[ "$acquire_count" -ge 7 && "$release_count" == "$acquire_count" ]] ||
    fail "all manager commands were not covered by one balanced lock: acquire=$acquire_count release=$release_count"
}

probe_activate_current_replace_signal_window() {
  local api_root="$TEST_ROOT/review-signal-window-activate/opt/sweet-memories-api"
  local data_root="$TEST_ROOT/review-signal-window-activate/var/lib/sweet-memories"
  local base_sha='7171717171717171717171717171717171717171'
  local target_sha='7272727272727272727272727272727272727272'
  local base_archive="$TEST_ROOT/review-signal-window-activate-base.tar.gz"
  local target_archive="$TEST_ROOT/review-signal-window-activate-target.tar.gz"
  local marker="$TEST_ROOT/review-signal-window-activate.marker"
  local status current_target restart_count leftovers

  reset_fixture_logs
  make_archive "$base_archive" 'signal-window-activate-base'
  invoke_manager_at "$api_root" "$data_root" activate "$base_sha" "$base_archive"
  reset_fixture_logs
  make_archive "$target_archive" 'signal-window-activate-target'
  set +e
  FAKE_CURRENT_REPLACE_SIGNAL_MARKER="$marker" \
    invoke_manager_at "$api_root" "$data_root" activate "$target_sha" "$target_archive" \
    >"$TEST_ROOT/review-signal-window-activate.log" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 143 ]] ||
    fail "activate atomic-current TERM returned $status instead of 143"
  current_target="$(readlink "$api_root/current" 2>/dev/null || true)"
  [[ "$current_target" == "$api_root/releases/$base_sha" ]] ||
    fail "activate atomic-current TERM status=$status left current incorrectly at $current_target"
  [[ ! -e "$api_root/previous" && ! -L "$api_root/previous" ]] ||
    fail 'activate atomic-current TERM did not restore the original previous-link state'
  restart_count="$(grep -c '^systemctl:restart:' "$EVENT_LOG" || true)"
  [[ "$restart_count" -eq 1 ]] ||
    fail "activate atomic-current TERM restarted the old service $restart_count times instead of once"
  leftovers="$(find "$api_root" -maxdepth 2 \
    \( -name '.archive-*' -o -name '.incoming-*' -o -name '.current-*' -o -name '.previous-*' \) \
    -print -quit)"
  [[ -z "$leftovers" ]] || fail "activate atomic-current TERM left owned state: $leftovers"
}

probe_rollback_current_replace_signal_window() {
  local api_root="$TEST_ROOT/review-signal-window-rollback/opt/sweet-memories-api"
  local data_root="$TEST_ROOT/review-signal-window-rollback/var/lib/sweet-memories"
  local previous_sha='7373737373737373737373737373737373737373'
  local current_sha='7474747474747474747474747474747474747474'
  local previous_archive="$TEST_ROOT/review-signal-window-rollback-previous.tar.gz"
  local current_archive="$TEST_ROOT/review-signal-window-rollback-current.tar.gz"
  local marker="$TEST_ROOT/review-signal-window-rollback.marker"
  local status current_target previous_target restart_count leftovers

  reset_fixture_logs
  make_archive "$previous_archive" 'signal-window-rollback-previous'
  invoke_manager_at "$api_root" "$data_root" activate "$previous_sha" "$previous_archive"
  make_archive "$current_archive" 'signal-window-rollback-current'
  invoke_manager_at "$api_root" "$data_root" activate "$current_sha" "$current_archive"
  reset_fixture_logs
  set +e
  FAKE_CURRENT_REPLACE_SIGNAL_MARKER="$marker" \
    invoke_manager_at "$api_root" "$data_root" rollback-if-current "$current_sha" \
    >"$TEST_ROOT/review-signal-window-rollback.log" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 143 ]] ||
    fail "rollback atomic-current TERM returned $status instead of 143"
  current_target="$(readlink "$api_root/current" 2>/dev/null || true)"
  [[ "$current_target" == "$api_root/releases/$current_sha" ]] ||
    fail "rollback atomic-current TERM status=$status left current incorrectly at $current_target"
  previous_target="$(readlink "$api_root/previous" 2>/dev/null || true)"
  [[ "$previous_target" == "$api_root/releases/$previous_sha" ]] ||
    fail "rollback atomic-current TERM did not restore previous: $previous_target"
  restart_count="$(grep -c '^systemctl:restart:' "$EVENT_LOG" || true)"
  [[ "$restart_count" -eq 1 ]] ||
    fail "rollback atomic-current TERM restarted the old service $restart_count times instead of once"
  leftovers="$(find "$api_root" -maxdepth 2 \
    \( -name '.archive-*' -o -name '.incoming-*' -o -name '.current-*' -o -name '.previous-*' \) \
    -print -quit)"
  [[ -z "$leftovers" ]] || fail "rollback atomic-current TERM left owned state: $leftovers"
}

probe_signal_recovery() {
  local api_root="$TEST_ROOT/review-signal/opt/sweet-memories-api"
  local data_root="$TEST_ROOT/review-signal/var/lib/sweet-memories"
  local base_sha='6666666666666666666666666666666666666666'
  local target_sha='6767676767676767676767676767676767676767'
  local base_archive="$TEST_ROOT/review-signal-base.tar.gz"
  local target_archive="$TEST_ROOT/review-signal-target.tar.gz"
  local barrier="$TEST_ROOT/review-signal-barrier"
  local wrapper_pid manager_pid status restart_count leftovers

  reset_fixture_logs
  make_archive "$base_archive" 'signal-base'
  invoke_manager_at "$api_root" "$data_root" activate "$base_sha" "$base_archive"
  reset_fixture_logs
  make_archive "$target_archive" 'signal-target'
  FAKE_RESTART_BARRIER="$barrier" \
    invoke_manager_at "$api_root" "$data_root" activate "$target_sha" "$target_archive" \
    >"$TEST_ROOT/review-signal.log" 2>&1 &
  wrapper_pid=$!
  wait_for_path "$barrier/manager-pid" 'post-switch manager PID'
  assert_link "$api_root/current" "$api_root/releases/$target_sha"
  manager_pid="$(cat "$barrier/manager-pid")"
  kill -TERM "$manager_pid"
  : >"$barrier/release"
  wait_for_process "$wrapper_pid" status
  [[ "$status" -ne 0 ]] || fail 'TERM-interrupted activation unexpectedly succeeded'
  assert_link "$api_root/current" "$api_root/releases/$base_sha"
  [[ ! -e "$api_root/previous" ]] || fail 'TERM recovery did not restore the previous-link state'
  restart_count="$(grep -c '^systemctl:restart:' "$EVENT_LOG" || true)"
  [[ "$restart_count" -eq 2 ]] || fail 'TERM recovery did not restart the old release exactly once'
  leftovers="$(find "$api_root" -maxdepth 2 \
    \( -name '.archive-*' -o -name '.incoming-*' -o -name '.current-*' -o -name '.previous-*' -o -name '.fixture-lock' \) \
    -print -quit)"
  [[ -z "$leftovers" ]] || fail "TERM recovery left owned temporary state: $leftovers"
}

probe_signal_does_not_overwrite_newer_current() {
  local api_root="$TEST_ROOT/review-signal-newer/opt/sweet-memories-api"
  local data_root="$TEST_ROOT/review-signal-newer/var/lib/sweet-memories"
  local base_sha='6868686868686868686868686868686868686868'
  local target_sha='6969696969696969696969696969696969696969'
  local newer_sha='7070707070707070707070707070707070707070'
  local base_archive="$TEST_ROOT/review-signal-newer-base.tar.gz"
  local target_archive="$TEST_ROOT/review-signal-newer-target.tar.gz"
  local marker="$TEST_ROOT/review-signal-newer.marker"
  local status restart_count

  reset_fixture_logs
  make_archive "$base_archive" 'signal-newer-base'
  invoke_manager_at "$api_root" "$data_root" activate "$base_sha" "$base_archive"
  reset_fixture_logs
  make_archive "$target_archive" 'signal-newer-target'
  mkdir -p "$api_root/releases/$newer_sha"
  set +e
  FAKE_CURRENT_REPLACE_SIGNAL_MARKER="$marker" \
  FAKE_CURRENT_REPLACE_THIRD_PARTY="$api_root/releases/$newer_sha" \
    invoke_manager_at "$api_root" "$data_root" activate "$target_sha" "$target_archive" \
    >"$TEST_ROOT/review-signal-newer.log" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 143 ]] || fail "newer-current TERM returned $status instead of 143"
  assert_link "$api_root/current" "$api_root/releases/$newer_sha"
  restart_count="$(grep -c '^systemctl:restart:' "$EVENT_LOG" || true)"
  [[ "$restart_count" -eq 0 ]] ||
    fail 'newer-current switching window restarted the old service'
}

probe_hardened_database_backup() {
  REPOSITORY_ROOT="$REPOSITORY_ROOT" TEST_ROOT="$TEST_ROOT" \
    node --experimental-strip-types --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = process.env.REPOSITORY_ROOT;
const testRoot = process.env.TEST_ROOT;
assert.ok(repositoryRoot);
assert.ok(testRoot);
const { runDatabaseCommand } = await import(pathToFileURL(
  join(repositoryRoot, 'apps/api/src/cli/database.ts'),
).href);
const root = realpathSync(testRoot);
const dataRoot = join(root, 'review-backup');
const backupRoot = join(dataRoot, 'backups', 'deploy');
mkdirSync(backupRoot, { recursive: true });
const failures = [];
const check = async (name, operation) => {
  try {
    await operation();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const command = (database, destination) => runDatabaseCommand({
  argv: ['database', 'backup', destination],
  db: database,
  dataRoot,
  migrationsRoot: '/release/migrations',
  output: { write: () => undefined },
  migrate: () => undefined,
});

await check('private unpredictable temporary backup', async () => {
  const final = join(backupRoot, 'private.sqlite3');
  let observed;
  const result = await command({
    backup: async (temporary) => {
      observed = temporary;
      assert.equal(existsSync(final), false);
      assert.notEqual(temporary, final);
      assert.ok(temporary.startsWith(`${backupRoot}${sep}.incoming-`));
      assert.equal(lstatSync(dirname(temporary)).mode & 0o777, 0o700);
      writeFileSync(temporary, 'private-snapshot');
    },
  }, final);
  assert.equal(result, 0);
  assert.ok(observed);
  assert.equal(readFileSync(final, 'utf8'), 'private-snapshot');
  const finalStat = lstatSync(final);
  assert.equal(finalStat.isFile(), true);
  assert.equal(finalStat.isSymbolicLink(), false);
  assert.equal(finalStat.nlink, 1);
  assert.equal(finalStat.mode & 0o777, 0o600);
});

await check('final symlink no-clobber', async () => {
  const external = join(dataRoot, 'symlink-external');
  const final = join(backupRoot, 'symlink.sqlite3');
  writeFileSync(external, 'external-safe');
  symlinkSync(external, final);
  assert.equal(await command({ backup: async () => assert.fail('backup must not run') }, final), 1);
  assert.equal(readFileSync(external, 'utf8'), 'external-safe');
  assert.equal(lstatSync(final).isSymbolicLink(), true);
});

await check('final hard-link no-clobber', async () => {
  const external = join(dataRoot, 'hardlink-external');
  const final = join(backupRoot, 'hardlink.sqlite3');
  writeFileSync(external, 'hardlink-safe');
  chmodSync(external, 0o640);
  linkSync(external, final);
  assert.equal(await command({ backup: async () => assert.fail('backup must not run') }, final), 1);
  assert.equal(readFileSync(external, 'utf8'), 'hardlink-safe');
  assert.equal(lstatSync(final).ino, lstatSync(external).ino);
  assert.equal(lstatSync(external).mode & 0o777, 0o640);
});

await check('publish race no-clobber', async () => {
  const final = join(backupRoot, 'race.sqlite3');
  const result = await command({
    backup: async (temporary) => {
      writeFileSync(temporary, 'snapshot');
      writeFileSync(final, 'attacker-won-race');
    },
  }, final);
  assert.equal(result, 1);
  assert.equal(readFileSync(final, 'utf8'), 'attacker-won-race');
});

await check('temporary symlink rejected', async () => {
  const external = join(dataRoot, 'temporary-symlink-external');
  const final = join(backupRoot, 'temporary-symlink.sqlite3');
  writeFileSync(external, 'temporary-symlink-safe');
  const result = await command({
    backup: async (temporary) => {
      unlinkSync(temporary);
      symlinkSync(external, temporary);
    },
  }, final);
  assert.equal(result, 1);
  assert.equal(readFileSync(external, 'utf8'), 'temporary-symlink-safe');
  assert.equal(existsSync(final), false);
});

await check('temporary ordinary replacement rejected by identity', async () => {
  const replacement = join(dataRoot, 'temporary-replacement');
  const final = join(backupRoot, 'temporary-replacement.sqlite3');
  writeFileSync(replacement, 'replacement');
  const result = await command({
    backup: async (temporary) => {
      unlinkSync(temporary);
      renameSync(replacement, temporary);
    },
  }, final);
  assert.equal(result, 1);
  assert.equal(existsSync(final), false);
});

await check('temporary hard link rejected without chmod', async () => {
  const external = join(dataRoot, 'temporary-hardlink-external');
  const final = join(backupRoot, 'temporary-hardlink.sqlite3');
  writeFileSync(external, 'temporary-hardlink-safe');
  chmodSync(external, 0o640);
  const result = await command({
    backup: async (temporary) => {
      unlinkSync(temporary);
      linkSync(external, temporary);
    },
  }, final);
  assert.equal(result, 1);
  assert.equal(readFileSync(external, 'utf8'), 'temporary-hardlink-safe');
  assert.equal(lstatSync(external).mode & 0o777, 0o640);
  assert.equal(existsSync(final), false);
});

await check('temporary cleanup after backup error', async () => {
  const final = join(backupRoot, 'failure.sqlite3');
  const result = await command({
    backup: async (temporary) => {
      writeFileSync(temporary, 'partial');
      throw new Error('injected backup failure');
    },
  }, final);
  assert.equal(result, 1);
  assert.equal(existsSync(final), false);
  assert.deepEqual(readdirSync(backupRoot).filter((name) => name.startsWith('.incoming-')), []);
});

rmSync(dataRoot, { recursive: true, force: true });
if (failures.length > 0) {
  for (const failure of failures) console.error(`BACKUP RED: ${failure}`);
  process.exitCode = 1;
}
NODE
}

review_failure_count=0
for review_probe in \
  probe_persistent_permissions \
  probe_private_archive_copy \
  probe_global_serialization \
  probe_activate_current_replace_signal_window \
  probe_rollback_current_replace_signal_window \
  probe_signal_recovery \
  probe_signal_does_not_overwrite_newer_current \
  probe_hardened_database_backup \
  probe_cleanup_requires_five; do
  if review_output="$($review_probe 2>&1)"; then
    printf 'review probe passed: %s\n' "$review_probe"
  else
    review_failure_count=$((review_failure_count + 1))
    printf 'review probe failed: %s\n%s\n' "$review_probe" "$review_output" >&2
  fi
done
if [[ "$review_failure_count" -ne 0 ]]; then
  fail "$review_failure_count Task18 review regression probes failed"
fi

reset_fixture_logs

SHA_A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
SHA_B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
SHA_C='cccccccccccccccccccccccccccccccccccccccc'
SHA_D='dddddddddddddddddddddddddddddddddddddddd'
ARCHIVE_A="$TEST_ROOT/a.tar.gz"
make_archive "$ARCHIVE_A" 'release-a'
invoke_manager activate "$SHA_A" "$ARCHIVE_A"
assert_link "$API_ROOT/current" "$API_ROOT/releases/$SHA_A"
[[ ! -e "$API_ROOT/previous" ]] || fail 'first activation created a previous link'
[[ ! -e "$ARCHIVE_A" ]] || fail 'first activation did not consume its archive'
grep -Fq -- "-R root:root $API_ROOT/releases/.incoming-$SHA_A" "$CHOWN_LOG" ||
  fail 'release staging was not normalized to root:root'
[[ "$(file_mode "$API_ROOT/releases/$SHA_A")" == '755' ]] ||
  fail 'release directory is not service-readable and root-writable only'
[[ "$(file_mode "$API_ROOT/releases/$SHA_A/dist/index.js")" == '644' ]] ||
  fail 'release file is not service-readable and root-writable only'
[[ -f "$DATA_ROOT/database/sweet-memories.sqlite3" ]] ||
  fail 'migration did not create the database as the service account'
[[ "$(stat -f '%u' "$DATA_ROOT/database/sweet-memories.sqlite3" 2>/dev/null ||
  stat -c '%u' "$DATA_ROOT/database/sweet-memories.sqlite3")" == "$(id -u)" ]] ||
  fail 'test service account did not own the created database fixture'
if grep -Fq -- "$DATA_ROOT" "$CHOWN_LOG"; then
  fail 'release normalization attempted to chown persistent data'
fi
grep -Fq -- "--user sweet-memories --group sweet-memories-media -- env -i" "$EVENT_LOG" ||
  fail 'database CLI did not run through the fixed runuser boundary'
grep -Fq -- "PATH=/usr/local/bin:/usr/bin:/bin" "$EVENT_LOG" ||
  fail 'database CLI did not receive the fixed PATH'
grep -Fq -- "NODE_ENV=production" "$EVENT_LOG" ||
  fail 'database CLI did not receive NODE_ENV=production'
grep -Fq -- "SWEET_MEMORIES_ORIGIN=https://huangjianfen.cn" "$EVENT_LOG" ||
  fail 'database CLI did not receive the fixed production Origin'
grep -Fq -- "$API_ROOT/releases/$SHA_A/dist/cli.js database backup" "$EVENT_LOG" ||
  fail 'backup did not use the new release CLI'
EVENT_SEQUENCE="$(tr '\n' ' ' <"$EVENT_LOG")"
[[ "$EVENT_SEQUENCE" == *'backup '*migrate*'systemctl:restart:sweet-memories-api.service '*curl* ]] ||
  fail "activation order was not backup -> migrate -> restart -> health: $EVENT_SEQUENCE"

BEFORE_REPEAT="$(wc -l <"$EVENT_LOG" | tr -d ' ')"
REPEAT_ARCHIVE="$TEST_ROOT/a-repeat.tar.gz"
make_archive "$REPEAT_ARCHIVE" 'replacement-a'
invoke_manager activate "$SHA_A" "$REPEAT_ARCHIVE"
[[ "$(wc -l <"$EVENT_LOG" | tr -d ' ')" == "$BEFORE_REPEAT" ]] ||
  fail 'repeated activation reran side effects'
[[ ! -e "$REPEAT_ARCHIVE" ]] || fail 'repeated activation did not consume its archive'

ARCHIVE_B="$TEST_ROOT/b.tar.gz"
make_archive "$ARCHIVE_B" 'release-b'
invoke_manager activate "$SHA_B" "$ARCHIVE_B"
assert_link "$API_ROOT/current" "$API_ROOT/releases/$SHA_B"
assert_link "$API_ROOT/previous" "$API_ROOT/releases/$SHA_A"

ARCHIVE_C="$TEST_ROOT/c.tar.gz"
make_archive "$ARCHIVE_C" 'release-c'
: >"$CURL_LOG"
FAKE_HEALTH_MODE=fail
export FAKE_HEALTH_MODE
assert_fails 'unhealthy activation' 'health check failed; restored previous release' \
  invoke_manager activate "$SHA_C" "$ARCHIVE_C"
unset FAKE_HEALTH_MODE
assert_link "$API_ROOT/current" "$API_ROOT/releases/$SHA_B"
assert_link "$API_ROOT/previous" "$API_ROOT/releases/$SHA_A"
[[ "$(wc -l <"$CURL_LOG" | tr -d ' ')" == '3' ]] ||
  fail 'unhealthy activation did not make exactly three health attempts'

invoke_manager rollback-if-current "$SHA_B"
assert_link "$API_ROOT/current" "$API_ROOT/releases/$SHA_A"
assert_link "$API_ROOT/previous" "$API_ROOT/releases/$SHA_B"
assert_fails 'conditional rollback with stale SHA' 'current release does not match expected SHA' \
  invoke_manager rollback-if-current "$SHA_B"
assert_link "$API_ROOT/current" "$API_ROOT/releases/$SHA_A"

ARCHIVE_D="$TEST_ROOT/d.tar.gz"
make_archive "$ARCHIVE_D" 'release-d'
FAKE_MIGRATE_FAIL=1
export FAKE_MIGRATE_FAIL
assert_fails 'failed migration' 'database migration failed' \
  invoke_manager activate "$SHA_D" "$ARCHIVE_D"
unset FAKE_MIGRATE_FAIL
assert_link "$API_ROOT/current" "$API_ROOT/releases/$SHA_A"

SHA_E='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
ARCHIVE_E="$TEST_ROOT/e.tar.gz"
make_archive "$ARCHIVE_E" 'release-e'
FAKE_RESTART_FAIL=1
export FAKE_RESTART_FAIL
assert_fails 'failed service restart' 'service restart failed; restored previous release' \
  invoke_manager activate "$SHA_E" "$ARCHIVE_E"
unset FAKE_RESTART_FAIL
assert_link "$API_ROOT/current" "$API_ROOT/releases/$SHA_A"
assert_link "$API_ROOT/previous" "$API_ROOT/releases/$SHA_B"

for command in \
  'migration check-ready' \
  'migration activate' \
  'uploads enable' \
  'uploads disable' \
  'uploads status'; do
  # shellcheck disable=SC2086
  invoke_manager cli $command
done

INVALID_ARCHIVE="$TEST_ROOT/invalid.tar.gz"
make_archive "$INVALID_ARCHIVE" 'invalid-sha'
assert_fails 'short SHA' 'release SHA must be 40 lowercase hexadecimal characters' \
  invoke_manager activate abc "$INVALID_ARCHIVE"

UNSAFE_SOURCE="$TEST_ROOT/unsafe-source"
mkdir -p "$UNSAFE_SOURCE/dist" "$UNSAFE_SOURCE/migrations" "$UNSAFE_SOURCE/seed" \
  "$UNSAFE_SOURCE/node_modules"
printf 'entry\n' >"$UNSAFE_SOURCE/dist/index.js"
printf 'cli\n' >"$UNSAFE_SOURCE/dist/cli.js"
printf '{}\n' >"$UNSAFE_SOURCE/package.json"
ln -s /etc/passwd "$UNSAFE_SOURCE/node_modules/external"
SYMLINK_ARCHIVE="$TEST_ROOT/symlink.tar.gz"
"$REAL_TAR" -C "$UNSAFE_SOURCE" -czf "$SYMLINK_ARCHIVE" .
assert_fails 'symlink archive' 'unsupported archive entry type' \
  invoke_manager activate '1111111111111111111111111111111111111111' "$SYMLINK_ARCHIVE"

rm "$UNSAFE_SOURCE/node_modules/external"
mkfifo "$UNSAFE_SOURCE/node_modules/pipe"
FIFO_ARCHIVE="$TEST_ROOT/fifo.tar.gz"
COPYFILE_DISABLE=1 "$REAL_TAR" -C "$UNSAFE_SOURCE" -czf "$FIFO_ARCHIVE" .
assert_fails 'special-file archive' 'unsupported archive entry type' \
  invoke_manager activate '2222222222222222222222222222222222222222' "$FIFO_ARCHIVE"

rm "$UNSAFE_SOURCE/node_modules/pipe"
printf 'not allowed\n' >"$UNSAFE_SOURCE/unexpected.txt"
EXTRA_ARCHIVE="$TEST_ROOT/extra.tar.gz"
"$REAL_TAR" -C "$UNSAFE_SOURCE" -czf "$EXTRA_ARCHIVE" .
assert_fails 'archive with unexpected top-level content' 'archive contains a forbidden path' \
  invoke_manager activate '3333333333333333333333333333333333333333' "$EXTRA_ARCHIVE"

rm "$UNSAFE_SOURCE/unexpected.txt" "$UNSAFE_SOURCE/dist/cli.js"
ln "$UNSAFE_SOURCE/dist/index.js" "$UNSAFE_SOURCE/dist/cli.js"
HARDLINK_ARCHIVE="$TEST_ROOT/hardlink.tar.gz"
"$REAL_TAR" -C "$UNSAFE_SOURCE" -czf "$HARDLINK_ARCHIVE" .
"$REAL_TAR" -tvzf "$HARDLINK_ARCHIVE" | grep -q '^h' ||
  fail 'test setup did not create a hard-link archive member'
assert_fails 'hard-link archive' 'unsupported archive entry type' \
  invoke_manager activate '3434343434343434343434343434343434343434' "$HARDLINK_ARCHIVE"

TRAVERSAL_SOURCE="$TEST_ROOT/traversal-source"
mkdir -p "$TRAVERSAL_SOURCE/dist"
printf 'escape\n' >"$TRAVERSAL_SOURCE/dist/escape.js"
TRAVERSAL_ARCHIVE="$TEST_ROOT/traversal.tar.gz"
if "$REAL_TAR" --version 2>/dev/null | grep -q 'GNU tar'; then
  "$REAL_TAR" -C "$TRAVERSAL_SOURCE" --transform='s#^dist#../escape#' \
    -czf "$TRAVERSAL_ARCHIVE" dist/escape.js
else
  "$REAL_TAR" -C "$TRAVERSAL_SOURCE" -s ',^dist,../escape,' \
    -czf "$TRAVERSAL_ARCHIVE" dist/escape.js
fi
"$REAL_TAR" -tzf "$TRAVERSAL_ARCHIVE" | grep -Fq '..' ||
  fail 'test setup did not create a traversal member'
assert_fails 'path traversal archive' 'archive path is unsafe' \
  invoke_manager activate '4444444444444444444444444444444444444444' "$TRAVERSAL_ARCHIVE"
[[ ! -e "$API_ROOT/escape" && ! -e "$(dirname "$API_ROOT")/escape" ]] ||
  fail 'path traversal wrote outside staging'

TERM_SHA='5555555555555555555555555555555555555555'
TERM_ARCHIVE="$TEST_ROOT/term.tar.gz"
make_archive "$TERM_ARCHIVE" 'term'
FAKE_TAR_TERM=1
export FAKE_TAR_TERM
assert_fails 'TERM-interrupted activation' '' \
  invoke_manager activate "$TERM_SHA" "$TERM_ARCHIVE"
unset FAKE_TAR_TERM
[[ ! -e "$API_ROOT/releases/.incoming-$TERM_SHA" ]] ||
  fail 'TERM-interrupted activation left staging behind'

CLEAN_API_ROOT="$TEST_ROOT/cleanup/opt/sweet-memories-api"
mkdir -p "$CLEAN_API_ROOT/releases"
for digit in 0 1 2 3 4 5 6 7; do
  sha="${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}${digit}"
  mkdir "$CLEAN_API_ROOT/releases/$sha"
  touch -t "20260902010$digit" "$CLEAN_API_ROOT/releases/$sha"
done
SHA_0='0000000000000000000000000000000000000000'
SHA_1='1111111111111111111111111111111111111111'
ln -s "$CLEAN_API_ROOT/releases/$SHA_0" "$CLEAN_API_ROOT/current"
ln -s "$CLEAN_API_ROOT/releases/$SHA_1" "$CLEAN_API_ROOT/previous"
PERSISTENT_MARKER="$DATA_ROOT/media/preserved/photo.jpg"
mkdir -p "$(dirname "$PERSISTENT_MARKER")"
printf 'persistent\n' >"$PERSISTENT_MARKER"
invoke_manager_at "$CLEAN_API_ROOT" "$DATA_ROOT" cleanup 5
[[ "$(find "$CLEAN_API_ROOT/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == '5' ]] ||
  fail 'cleanup did not retain exactly five releases'
[[ -d "$CLEAN_API_ROOT/releases/$SHA_0" && -d "$CLEAN_API_ROOT/releases/$SHA_1" ]] ||
  fail 'cleanup removed current or previous release'
[[ -f "$PERSISTENT_MARKER" ]] || fail 'cleanup removed persistent media'

grep -Fq 'API_ROOT=/opt/sweet-memories-api' "$MANAGER" ||
  fail 'manager does not declare the fixed API root'
grep -Fq 'DATA_ROOT=/var/lib/sweet-memories' "$MANAGER" ||
  fail 'manager does not declare the fixed data root'
grep -Fq 'SERVICE_NAME=sweet-memories-api.service' "$MANAGER" ||
  fail 'manager does not declare the fixed service name'
grep -Fq 'require_root' "$MANAGER" || fail 'direct manager entry does not require root'

for template in "$SYSTEMD_TEMPLATE" "$NGINX_TEMPLATE" "$SUDOERS_TEMPLATE"; do
  [[ -f "$template" ]] || fail "missing template: $template"
done

for line in \
  'Type=simple' \
  'User=sweet-memories' \
  'Group=sweet-memories-media' \
  'WorkingDirectory=/opt/sweet-memories-api/current' \
  'Environment=NODE_ENV=production' \
  'Environment=SWEET_MEMORIES_ORIGIN=https://huangjianfen.cn' \
  'Environment=SWEET_MEMORIES_DATA_ROOT=/var/lib/sweet-memories' \
  'ExecStart=/usr/local/bin/node /opt/sweet-memories-api/current/dist/index.js' \
  'Restart=on-failure' \
  'RestartSec=5' \
  'TimeoutStopSec=75' \
  'UMask=0027' \
  'MemoryHigh=768M' \
  'MemoryMax=1G' \
  'TasksMax=64' \
  'NoNewPrivileges=true' \
  'PrivateTmp=true' \
  'ProtectSystem=strict' \
  'ProtectHome=true' \
  'ReadWritePaths=/var/lib/sweet-memories'; do
  assert_contains "$SYSTEMD_TEMPLATE" "$line"
done
if grep -Eq '^User=(root|deploy|www-data)$' "$SYSTEMD_TEMPLATE"; then
  fail 'systemd service uses a privileged or shared account'
fi

for line in \
  'client_max_body_size 12m;' \
  'client_body_timeout 30s;' \
  'proxy_send_timeout 30s;' \
  'proxy_read_timeout 180s;' \
  'proxy_pass http://127.0.0.1:3100;' \
  'proxy_set_header Host $host;' \
  'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
  'proxy_set_header X-Forwarded-Proto $scheme;' \
  'root /var/lib/sweet-memories;' \
  'autoindex off;' \
  'add_header X-Content-Type-Options nosniff always;' \
  'add_header Cache-Control "public, max-age=31536000, immutable" always;'; do
  grep -Fq -- "$line" "$NGINX_TEMPLATE" ||
    fail "nginx template is missing: $line"
done
grep -Eq 'location .*\^/media/.*\\\.' "$NGINX_TEMPLATE" ||
  fail 'nginx template does not reject hidden media paths'
grep -Fq 'return 404;' "$NGINX_TEMPLATE" ||
  fail 'nginx hidden-media location does not return 404'
grep -Fq 'limit_except GET HEAD' "$NGINX_TEMPLATE" ||
  fail 'nginx media location does not explicitly deny writes'

[[ "$(grep -Ev '^[[:space:]]*(#|$)' "$SUDOERS_TEMPLATE")" == \
  'deploy ALL=(root) NOPASSWD: /usr/local/sbin/manage-sweet-memories-api' ]] ||
  fail 'sudoers grants more than the fixed root-owned release manager'
if grep -Eq '(^|[[:space:]/])(node|systemctl|bash|sh|vim|nano)([[:space:]/]|$)|\*' \
  "$SUDOERS_TEMPLATE"; then
  fail 'sudoers contains a broad command grant'
fi

if [[ "$(id -u)" -ne 0 ]]; then
  assert_fails 'direct non-root invocation' 'must run as root' \
    bash "$MANAGER" cleanup 5
fi

printf 'manage-api-release tests passed\n'
