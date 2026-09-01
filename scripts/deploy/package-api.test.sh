#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGER="$SCRIPT_DIR/package-api.sh"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sweet-memories-package-api-test.XXXXXX")"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'package-api test failed: %s\n' "$1" >&2
  exit 1
}

[[ -f "$PACKAGER" ]] || fail 'package-api.sh is missing'

assert_fails() {
  local label="$1"
  local expected="$2"
  shift 2
  local output

  if output="$("$@" 2>&1)"; then
    fail "$label unexpectedly succeeded"
  fi
  [[ "$output" == *"$expected"* ]] ||
    fail "$label did not report '$expected': $output"
}

assert_archive_member() {
  local archive="$1"
  local expected="$2"

  tar -tzf "$archive" | sed 's#^\./##' | grep -Fxq "$expected" ||
    fail "archive is missing $expected"
}

DIST_PATH="$REPOSITORY_ROOT/apps/api/dist"
DIST_PRESENT_BEFORE=0
DIST_DIGEST_BEFORE=''
if [[ -e "$DIST_PATH" || -L "$DIST_PATH" ]]; then
  [[ -d "$DIST_PATH" && ! -L "$DIST_PATH" ]] ||
    fail 'pre-existing dist fixture must be an ordinary directory'
  DIST_PRESENT_BEFORE=1
  DIST_DIGEST_BEFORE="$(tar -C "$REPOSITORY_ROOT" -cf - apps/api/dist | shasum -a 256)"
fi

assert_dist_unchanged() {
  if [[ "$DIST_PRESENT_BEFORE" -eq 0 ]]; then
    [[ ! -e "$DIST_PATH" && ! -L "$DIST_PATH" ]] ||
      fail 'packaging left a new dist directory in the worktree'
    return
  fi
  [[ -d "$DIST_PATH" && ! -L "$DIST_PATH" ]] ||
    fail 'packaging did not restore the pre-existing dist directory'
  local digest_after
  digest_after="$(tar -C "$REPOSITORY_ROOT" -cf - apps/api/dist | shasum -a 256)"
  [[ "$digest_after" == "$DIST_DIGEST_BEFORE" ]] ||
    fail 'packaging changed the pre-existing dist directory'
}

STATUS_BEFORE="$(git -C "$REPOSITORY_ROOT" status --porcelain=v1)"
REFUSAL_ROOT="$TEST_ROOT/refusal"
mkdir "$REFUSAL_ROOT"
assert_fails \
  'unsupported local platform' \
  'requires Ubuntu Linux x64 with Node.js 24' \
  env RUNNER_TEMP="$REFUSAL_ROOT" \
  bash "$PACKAGER" "$REFUSAL_ROOT/api.tar.gz"
[[ ! -e "$REFUSAL_ROOT/api.tar.gz" ]] ||
  fail 'platform refusal left an archive behind'
[[ "$(git -C "$REPOSITORY_ROOT" status --porcelain=v1)" == "$STATUS_BEFORE" ]] ||
  fail 'platform refusal changed the Git worktree'
assert_dist_unchanged

REAL_NODE="$(command -v node)"
REAL_PNPM="$(command -v pnpm)"
REAL_TAR="$(command -v tar)"
REAL_REALPATH="$(command -v realpath)"
MOCK_BIN="$TEST_ROOT/bin"
mkdir "$MOCK_BIN"

cat >"$MOCK_BIN/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf 'Linux\n' ;;
  -m) printf 'x86_64\n' ;;
  *) printf 'Linux\n' ;;
esac
EOF

cat >"$MOCK_BIN/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == '--version' ]]; then
  printf 'v24.20.0\n'
  exit 0
fi
exec "$PACKAGE_API_REAL_NODE" "$@"
EOF

cat >"$MOCK_BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ " $* " == *' --dir apps/api build '* ]]; then
  mkdir -p "$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist"
  printf 'export const runtime = true;\n' >"$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist/index.js"
  printf 'export const cli = true;\n' >"$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist/cli.js"
  printf 'throw new Error("test must be pruned");\n' \
    >"$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist/index.test.js"
  printf '{}\n' >"$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist/index.js.map"
  printf 'export {};\n' >"$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist/index.d.ts"
  exit 0
fi
if [[ " $* " == *' deploy '* ]]; then
  destination="${!#}"
  mkdir -p "$destination/dist" "$destination/migrations" \
    "$destination/seed" "$destination/node_modules/@fastify"
  cp -R "$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist/." "$destination/dist/"
  cp -R "$PACKAGE_API_REPOSITORY_ROOT/apps/api/migrations/." "$destination/migrations/"
  cp -R "$PACKAGE_API_REPOSITORY_ROOT/apps/api/seed/." "$destination/seed/"
  cp "$PACKAGE_API_REPOSITORY_ROOT/apps/api/package.json" "$destination/package.json"
  for dependency in argon2 better-sqlite3 exifr fastify file-type sharp; do
    package="$destination/node_modules/$dependency"
    mkdir -p "$package"
    printf '{"name":"%s","type":"module","main":"index.js"}\n' "$dependency" \
      >"$package/package.json"
    if [[ "$dependency" == 'better-sqlite3' ]]; then
      printf 'export default class Database { close() {} }\n' >"$package/index.js"
    else
      printf 'export default {};\n' >"$package/index.js"
    fi
  done
  for dependency in cookie multipart; do
    package="$destination/node_modules/@fastify/$dependency"
    mkdir -p "$package"
    printf '{"name":"@fastify/%s","type":"module","main":"index.js"}\n' "$dependency" \
      >"$package/package.json"
    printf 'export default {};\n' >"$package/index.js"
  done
  if [[ "${PACKAGE_API_INJECT_EXTERNAL_LINK:-0}" == '1' ]]; then
    ln -s /etc/passwd "$destination/node_modules/escape-link"
  fi
  exit 0
fi
printf 'unexpected pnpm invocation: %s\n' "$*" >&2
exit 1
EOF

cat >"$MOCK_BIN/tar" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == '--version' ]]; then
  printf 'tar (GNU tar) 1.35\n'
  exit 0
fi
translated=()
for argument in "$@"; do
  case "$argument" in
    --dereference) translated+=('-h') ;;
    --hard-dereference|--numeric-owner|--quoting-style=escape) ;;
    *) translated+=("$argument") ;;
  esac
done
exec "$PACKAGE_API_REAL_TAR" "${translated[@]}"
EOF

cat >"$MOCK_BIN/realpath" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == '-e' ]]; then shift; fi
exec "$PACKAGE_API_REAL_REALPATH" "$@"
EOF
chmod +x "$MOCK_BIN/uname" "$MOCK_BIN/node" "$MOCK_BIN/pnpm" \
  "$MOCK_BIN/tar" "$MOCK_BIN/realpath"

run_packager() {
  local runner_temp="$1"
  local output="$2"
  shift 2

  env \
    PATH="$MOCK_BIN:$PATH" \
    RUNNER_TEMP="$runner_temp" \
    PACKAGE_API_REAL_NODE="$REAL_NODE" \
    PACKAGE_API_REAL_PNPM="$REAL_PNPM" \
    PACKAGE_API_REAL_TAR="$REAL_TAR" \
    PACKAGE_API_REAL_REALPATH="$REAL_REALPATH" \
    PACKAGE_API_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
    "$@" \
    bash "$PACKAGER" "$output"
}

RUNNER_ROOT="$TEST_ROOT/runner"
OUTPUT_ROOT="$TEST_ROOT/output"
mkdir "$RUNNER_ROOT" "$OUTPUT_ROOT"
ARCHIVE="$OUTPUT_ROOT/photo-api.tar.gz"
run_packager "$RUNNER_ROOT" "$ARCHIVE"

[[ -f "$ARCHIVE" && ! -L "$ARCHIVE" ]] || fail 'valid package was not created'
assert_archive_member "$ARCHIVE" 'dist/index.js'
assert_archive_member "$ARCHIVE" 'dist/cli.js'
assert_archive_member "$ARCHIVE" 'migrations/001_initial.sql'
assert_archive_member "$ARCHIVE" 'seed/legacy-photos.json'
assert_archive_member "$ARCHIVE" 'seed/media-manifest.json'
assert_archive_member "$ARCHIVE" 'package.json'
assert_archive_member "$ARCHIVE" 'node_modules/'

MEMBERS="$TEST_ROOT/members.txt"
tar -tzf "$ARCHIVE" | sed 's#^\./##' >"$MEMBERS"
if grep -Eq '^(src|database|media)(/|$)|^dist/.*(\.test\.js|\.ts|\.map)$|^\.env' "$MEMBERS"; then
  fail 'archive contains forbidden application files'
fi
if tar -tvzf "$ARCHIVE" | grep -Ev '^[-d]' | grep -q .; then
  fail 'archive contains a link or special member'
fi

EXTRACTED="$TEST_ROOT/extracted"
mkdir "$EXTRACTED"
tar -xzf "$ARCHIVE" -C "$EXTRACTED"
SEED_SUMMARY="$($REAL_NODE --input-type=module - "$EXTRACTED" <<'NODE'
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.argv[2];
const manifest = JSON.parse(await readFile(join(root, 'seed/media-manifest.json'), 'utf8'));
process.stdout.write(`${manifest.photos.length}:${manifest.photos.flatMap((photo) => photo.assets).length}`);
NODE
)"
[[ "$SEED_SUMMARY" == '5:50' ]] || fail "legacy seed summary is invalid: $SEED_SUMMARY"
[[ ! -e "$EXTRACTED/package.json.test" ]] || fail 'unexpected fixture file was packaged'
[[ "$(git -C "$REPOSITORY_ROOT" status --porcelain=v1)" == "$STATUS_BEFORE" ]] ||
  fail 'successful packaging changed the Git worktree'
assert_dist_unchanged
[[ -z "$(find "$RUNNER_ROOT" -mindepth 1 -print -quit)" ]] ||
  fail 'successful packaging left temporary runner files behind'

UNSAFE_RUNNER="$TEST_ROOT/unsafe-runner"
UNSAFE_OUTPUT_ROOT="$TEST_ROOT/unsafe-output"
mkdir "$UNSAFE_RUNNER" "$UNSAFE_OUTPUT_ROOT"
UNSAFE_ARCHIVE="$UNSAFE_OUTPUT_ROOT/photo-api.tar.gz"
assert_fails \
  'external dependency symlink' \
  'runtime symlink escapes the deploy root' \
  run_packager "$UNSAFE_RUNNER" "$UNSAFE_ARCHIVE" PACKAGE_API_INJECT_EXTERNAL_LINK=1
[[ ! -e "$UNSAFE_ARCHIVE" ]] || fail 'unsafe package failure left an archive behind'
[[ -z "$(find "$UNSAFE_RUNNER" -mindepth 1 -print -quit)" ]] ||
  fail 'unsafe package failure left temporary runner files behind'
[[ "$(git -C "$REPOSITORY_ROOT" status --porcelain=v1)" == "$STATUS_BEFORE" ]] ||
  fail 'unsafe package failure changed the Git worktree'
assert_dist_unchanged

printf 'package-api tests passed\n'
