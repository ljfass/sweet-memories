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
MOCK_BIN="$TEST_ROOT/bin"
EVENT_LOG="$TEST_ROOT/events.log"
CHOWN_LOG="$TEST_ROOT/chown.log"
CURL_LOG="$TEST_ROOT/curl.log"
INSTALL_LOG="$TEST_ROOT/install.log"
mkdir -p "$MOCK_BIN"
: >"$EVENT_LOG"
: >"$CHOWN_LOG"
: >"$CURL_LOG"
: >"$INSTALL_LOG"

cat >"$MOCK_BIN/install" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$INSTALL_LOG"
target="${!#}"
mkdir -p "$target"
MOCK

cat >"$MOCK_BIN/chown" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CHOWN_LOG"
MOCK

cat >"$MOCK_BIN/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -eq 2 && "$1" == 'restart' && "$2" == 'sweet-memories-api.service' ]]
printf 'systemctl:%s:%s\n' "$1" "$2" >>"$EVENT_LOG"
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

chmod +x "$MOCK_BIN"/*
export REAL_TAR EVENT_LOG CHOWN_LOG CURL_LOG INSTALL_LOG

API_ROOT="$TEST_ROOT/opt/sweet-memories-api"
DATA_ROOT="$TEST_ROOT/var/lib/sweet-memories"

invoke_manager_at() {
  local api_root="$1"
  local data_root="$2"
  shift 2

  env PATH="$MOCK_BIN:$PATH" \
    REAL_TAR="$REAL_TAR" \
    EVENT_LOG="$EVENT_LOG" \
    CHOWN_LOG="$CHOWN_LOG" \
    CURL_LOG="$CURL_LOG" \
    INSTALL_LOG="$INSTALL_LOG" \
    FAKE_HEALTH_MODE="${FAKE_HEALTH_MODE:-healthy}" \
    FAKE_MIGRATE_FAIL="${FAKE_MIGRATE_FAIL:-0}" \
    FAKE_RESTART_FAIL="${FAKE_RESTART_FAIL:-0}" \
    FAKE_TAR_TERM="${FAKE_TAR_TERM:-0}" \
    bash -c '
      source "$1"
      API_ROOT="$2"
      DATA_ROOT="$3"
      ARCHIVE_ROOT="$4"
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
