#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGER="$SCRIPT_DIR/package-api.sh"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sweet-memories-package-api-test.XXXXXX")"
DIST_PATH="$REPOSITORY_ROOT/apps/api/dist"
ORIGINAL_DIST_SNAPSHOT="$TEST_ROOT/original-dist"
ORIGINAL_DIST_PRESENT=0

if [[ -e "$DIST_PATH" || -L "$DIST_PATH" ]]; then
  [[ -d "$DIST_PATH" && ! -L "$DIST_PATH" ]] || {
    printf 'package-api test failed: initial dist must be an ordinary directory\n' >&2
    exit 1
  }
  cp -a "$DIST_PATH" "$ORIGINAL_DIST_SNAPSHOT"
  ORIGINAL_DIST_PRESENT=1
fi

cleanup() {
  rm -rf -- "$DIST_PATH"
  if [[ "$ORIGINAL_DIST_PRESENT" -eq 1 ]]; then
    cp -a "$ORIGINAL_DIST_SNAPSHOT" "$DIST_PATH"
  fi
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
  'requires Ubuntu 24.04 x64 with Node.js 24' \
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
REAL_CAT="$(command -v cat)"
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
if [[ " $* " == *' --dir apps/api build '* || " $* " == *' --dir apps/api exec tsc '* ]]; then
  destination="$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist"
  previous=''
  for argument in "$@"; do
    if [[ "$previous" == '--outDir' ]]; then
      destination="$argument"
      break
    fi
    previous="$argument"
  done
  mkdir -p "$destination"
  build_id="${PACKAGE_API_RUN_ID:-default-package}"
  printf 'export const runtime = "%s";\n' "$build_id" >"$destination/index.js"
  printf 'export const cli = "%s";\n' "$build_id" >"$destination/cli.js"
  printf 'throw new Error("test must be pruned");\n' \
    >"$destination/index.test.js"
  printf '{}\n' >"$destination/index.js.map"
  printf 'export {};\n' >"$destination/index.d.ts"
  if [[ -n "${PACKAGE_API_BUILD_BARRIER:-}" ]]; then
    : >"$PACKAGE_API_BUILD_BARRIER/$build_id.ready"
    released=0
    for _ in $(seq 1 1000); do
      if [[ -e "$PACKAGE_API_BUILD_BARRIER/$build_id.release" ]]; then
        released=1
        break
      fi
      sleep 0.01
    done
    [[ "$released" -eq 1 ]] || {
      printf 'build barrier timed out: %s\n' "$build_id" >&2
      exit 1
    }
  fi
  exit 0
fi
if [[ " $* " == *' deploy '* ]]; then
  destination="${!#}"
  mkdir -p "$destination/dist" "$destination/migrations" \
    "$destination/seed" "$destination/node_modules/@fastify"
  printf 'export const runtime = "stale-deploy-dist";\n' >"$destination/dist/index.js"
  printf 'export const cli = "stale-deploy-dist";\n' >"$destination/dist/cli.js"
  if [[ -d "$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist" ]]; then
    cp -R "$PACKAGE_API_REPOSITORY_ROOT/apps/api/dist/." "$destination/dist/"
  fi
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
archive=''
previous=''
for argument in "$@"; do
  if [[ "$previous" == '-czf' ]]; then
    archive="$argument"
  fi
  case "$argument" in
    --dereference) translated+=('-h') ;;
    --hard-dereference|--numeric-owner|--quoting-style=escape) ;;
    *) translated+=("$argument") ;;
  esac
  previous="$argument"
done
if [[ -n "$archive" && -n "${PACKAGE_API_ARCHIVE_BARRIER:-}" ]]; then
  archive_id="${PACKAGE_API_RUN_ID:-default-package}"
  : >"$PACKAGE_API_ARCHIVE_BARRIER/$archive_id.ready"
  released=0
  for _ in $(seq 1 1000); do
    if [[ -e "$PACKAGE_API_ARCHIVE_BARRIER/$archive_id.release" ]]; then
      released=1
      break
    fi
    sleep 0.01
  done
  [[ "$released" -eq 1 ]] || {
    printf 'archive barrier timed out: %s\n' "$archive_id" >&2
    exit 1
  }
fi
exec "$PACKAGE_API_REAL_TAR" "${translated[@]}"
EOF

cat >"$MOCK_BIN/realpath" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == '-e' ]]; then shift; fi
exec "$PACKAGE_API_REAL_REALPATH" "$@"
EOF

cat >"$MOCK_BIN/cat" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$#" -eq 1 && "$1" == '/etc/os-release' ]]; then
  case "${PACKAGE_API_OS_RELEASE_FIXTURE:-ubuntu}" in
    ubuntu)
      printf 'ID=ubuntu\nVERSION_ID="24.04"\n'
      ;;
    alpine)
      printf 'ID=alpine\nVERSION_ID=3.22\n'
      ;;
    ubuntu-22)
      printf 'ID=ubuntu\nVERSION_ID="22.04"\n'
      ;;
    *)
      printf 'invalid os-release fixture\n' >&2
      exit 1
      ;;
  esac
  exit 0
fi
exec "$PACKAGE_API_REAL_CAT" "$@"
EOF
chmod +x "$MOCK_BIN/uname" "$MOCK_BIN/node" "$MOCK_BIN/pnpm" \
  "$MOCK_BIN/tar" "$MOCK_BIN/realpath" "$MOCK_BIN/cat"

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
    PACKAGE_API_REAL_CAT="$REAL_CAT" \
    PACKAGE_API_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
    "$@" \
    bash "$PACKAGER" "$output"
}

wait_for_path() {
  local path="$1"
  local label="$2"

  for _ in $(seq 1 1000); do
    [[ -e "$path" || -L "$path" ]] && return 0
    sleep 0.01
  done
  fail "timed out waiting for $label"
}

wait_for_process() {
  local pid="$1"
  local result_name="$2"
  local status

  if wait "$pid"; then
    status=0
  else
    status=$?
  fi
  printf -v "$result_name" '%s' "$status"
}

set_dist_fixture() {
  local marker="$1"

  rm -rf -- "$DIST_PATH"
  mkdir -p "$DIST_PATH"
  printf 'export const runtime = "%s";\n' "$marker" >"$DIST_PATH/index.js"
  printf 'export const cli = "%s";\n' "$marker" >"$DIST_PATH/cli.js"
  printf '%s\n' "$marker" >"$DIST_PATH/fixture-marker.txt"
}

clear_dist_fixture() {
  rm -rf -- "$DIST_PATH"
}

dist_fixture_digest() {
  "$REAL_TAR" -C "$REPOSITORY_ROOT" -cf - apps/api/dist | shasum -a 256
}

archive_runtime_marker() {
  local archive="$1"

  "$REAL_TAR" -xOzf "$archive" ./dist/index.js 2>/dev/null ||
    "$REAL_TAR" -xOzf "$archive" dist/index.js
}

restore_original_dist() {
  clear_dist_fixture
  if [[ "$ORIGINAL_DIST_PRESENT" -eq 1 ]]; then
    cp -a "$ORIGINAL_DIST_SNAPSHOT" "$DIST_PATH"
  fi
}

ALPINE_RUNNER="$TEST_ROOT/alpine-runner"
ALPINE_OUTPUT_ROOT="$TEST_ROOT/alpine-output"
mkdir "$ALPINE_RUNNER" "$ALPINE_OUTPUT_ROOT"
ALPINE_ARCHIVE="$ALPINE_OUTPUT_ROOT/photo-api.tar.gz"
assert_fails \
  'non-Ubuntu Linux platform' \
  'requires Ubuntu 24.04 x64 with Node.js 24' \
  run_packager "$ALPINE_RUNNER" "$ALPINE_ARCHIVE" \
  PACKAGE_API_OS_RELEASE_FIXTURE=alpine
[[ ! -e "$ALPINE_ARCHIVE" ]] ||
  fail 'non-Ubuntu refusal left an archive behind'
[[ -z "$(find "$ALPINE_RUNNER" -mindepth 1 -print -quit)" ]] ||
  fail 'non-Ubuntu refusal left temporary runner files behind'
[[ "$(git -C "$REPOSITORY_ROOT" status --porcelain=v1)" == "$STATUS_BEFORE" ]] ||
  fail 'non-Ubuntu refusal changed the Git worktree'
assert_dist_unchanged

OLD_UBUNTU_RUNNER="$TEST_ROOT/old-ubuntu-runner"
OLD_UBUNTU_OUTPUT_ROOT="$TEST_ROOT/old-ubuntu-output"
mkdir "$OLD_UBUNTU_RUNNER" "$OLD_UBUNTU_OUTPUT_ROOT"
OLD_UBUNTU_ARCHIVE="$OLD_UBUNTU_OUTPUT_ROOT/photo-api.tar.gz"
assert_fails \
  'unsupported Ubuntu version' \
  'requires Ubuntu 24.04 x64 with Node.js 24' \
  run_packager "$OLD_UBUNTU_RUNNER" "$OLD_UBUNTU_ARCHIVE" \
  PACKAGE_API_OS_RELEASE_FIXTURE=ubuntu-22
[[ ! -e "$OLD_UBUNTU_ARCHIVE" ]] ||
  fail 'unsupported Ubuntu version left an archive behind'
[[ -z "$(find "$OLD_UBUNTU_RUNNER" -mindepth 1 -print -quit)" ]] ||
  fail 'unsupported Ubuntu version left temporary runner files behind'
[[ "$(git -C "$REPOSITORY_ROOT" status --porcelain=v1)" == "$STATUS_BEFORE" ]] ||
  fail 'unsupported Ubuntu version changed the Git worktree'
assert_dist_unchanged

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

PARALLEL_ROOT="$TEST_ROOT/parallel-packages"
PARALLEL_BARRIER="$PARALLEL_ROOT/build-barrier"
PARALLEL_RUNNER_ONE="$PARALLEL_ROOT/runner-one"
PARALLEL_RUNNER_TWO="$PARALLEL_ROOT/runner-two"
PARALLEL_OUTPUT_ROOT="$PARALLEL_ROOT/output"
PARALLEL_ARCHIVE_ONE="$PARALLEL_OUTPUT_ROOT/one.tar.gz"
PARALLEL_ARCHIVE_TWO="$PARALLEL_OUTPUT_ROOT/two.tar.gz"
mkdir -p "$PARALLEL_BARRIER" "$PARALLEL_RUNNER_ONE" "$PARALLEL_RUNNER_TWO" \
  "$PARALLEL_OUTPUT_ROOT"
set_dist_fixture 'pre-existing-dist'
PARALLEL_DIST_DIGEST="$(dist_fixture_digest)"
run_packager "$PARALLEL_RUNNER_ONE" "$PARALLEL_ARCHIVE_ONE" \
  PACKAGE_API_RUN_ID=parallel-one \
  PACKAGE_API_BUILD_BARRIER="$PARALLEL_BARRIER" \
  >"$PARALLEL_ROOT/one.log" 2>&1 &
PARALLEL_PID_ONE=$!
wait_for_path "$PARALLEL_BARRIER/parallel-one.ready" 'first parallel package build'
run_packager "$PARALLEL_RUNNER_TWO" "$PARALLEL_ARCHIVE_TWO" \
  PACKAGE_API_RUN_ID=parallel-two \
  PACKAGE_API_BUILD_BARRIER="$PARALLEL_BARRIER" \
  >"$PARALLEL_ROOT/two.log" 2>&1 &
PARALLEL_PID_TWO=$!
wait_for_path "$PARALLEL_BARRIER/parallel-two.ready" 'second parallel package build'
: >"$PARALLEL_BARRIER/parallel-one.release"
wait_for_process "$PARALLEL_PID_ONE" PARALLEL_STATUS_ONE
: >"$PARALLEL_BARRIER/parallel-two.release"
wait_for_process "$PARALLEL_PID_TWO" PARALLEL_STATUS_TWO
[[ "$PARALLEL_STATUS_ONE" -eq 0 && "$PARALLEL_STATUS_TWO" -eq 0 ]] ||
  fail "parallel packages failed: one=$PARALLEL_STATUS_ONE ($(cat "$PARALLEL_ROOT/one.log")); two=$PARALLEL_STATUS_TWO ($(cat "$PARALLEL_ROOT/two.log"))"
[[ -f "$PARALLEL_ARCHIVE_ONE" && -f "$PARALLEL_ARCHIVE_TWO" ]] ||
  fail 'parallel packages did not both publish archives'
[[ "$(archive_runtime_marker "$PARALLEL_ARCHIVE_ONE")" == *'parallel-one'* ]] ||
  fail 'first parallel archive mixed another build output'
[[ "$(archive_runtime_marker "$PARALLEL_ARCHIVE_TWO")" == *'parallel-two'* ]] ||
  fail 'second parallel archive mixed another build output'
[[ -d "$DIST_PATH" && "$(dist_fixture_digest)" == "$PARALLEL_DIST_DIGEST" ]] ||
  fail 'parallel packages changed the pre-existing repository dist'
[[ -z "$(find "$PARALLEL_RUNNER_ONE" "$PARALLEL_RUNNER_TWO" -mindepth 1 -print -quit)" ]] ||
  fail 'parallel packages left owned runner temporary files behind'
restore_original_dist

BUILD_RACE_ROOT="$TEST_ROOT/package-build-race"
BUILD_RACE_BARRIER="$BUILD_RACE_ROOT/build-barrier"
BUILD_RACE_RUNNER="$BUILD_RACE_ROOT/runner"
BUILD_RACE_OUTPUT="$BUILD_RACE_ROOT/output"
BUILD_RACE_ARCHIVE="$BUILD_RACE_OUTPUT/photo-api.tar.gz"
mkdir -p "$BUILD_RACE_BARRIER" "$BUILD_RACE_RUNNER" "$BUILD_RACE_OUTPUT"
clear_dist_fixture
run_packager "$BUILD_RACE_RUNNER" "$BUILD_RACE_ARCHIVE" \
  PACKAGE_API_RUN_ID=isolated-package-build \
  PACKAGE_API_BUILD_BARRIER="$BUILD_RACE_BARRIER" \
  >"$BUILD_RACE_ROOT/package.log" 2>&1 &
BUILD_RACE_PID=$!
wait_for_path "$BUILD_RACE_BARRIER/isolated-package-build.ready" 'isolated package build'
PACKAGE_API_REPOSITORY_ROOT="$REPOSITORY_ROOT" \
  PACKAGE_API_RUN_ID=repository-build \
  "$MOCK_BIN/pnpm" --dir apps/api build
: >"$BUILD_RACE_BARRIER/isolated-package-build.release"
wait_for_process "$BUILD_RACE_PID" BUILD_RACE_STATUS
[[ "$BUILD_RACE_STATUS" -eq 0 ]] ||
  fail "package failed beside repository build: $(cat "$BUILD_RACE_ROOT/package.log")"
[[ -f "$DIST_PATH/index.js" && "$(cat "$DIST_PATH/index.js")" == *'repository-build'* ]] ||
  fail 'packaging removed or replaced the concurrent repository build'
[[ "$(archive_runtime_marker "$BUILD_RACE_ARCHIVE")" == *'isolated-package-build'* ]] ||
  fail 'package archive mixed the concurrent repository build'
[[ -z "$(find "$BUILD_RACE_RUNNER" -mindepth 1 -print -quit)" ]] ||
  fail 'package/build race left owned runner temporary files behind'
restore_original_dist

SAME_OUTPUT_ROOT="$TEST_ROOT/same-output"
SAME_OUTPUT_BUILD_BARRIER="$SAME_OUTPUT_ROOT/build-barrier"
SAME_OUTPUT_ARCHIVE_BARRIER="$SAME_OUTPUT_ROOT/archive-barrier"
SAME_OUTPUT_RUNNER_ONE="$SAME_OUTPUT_ROOT/runner-one"
SAME_OUTPUT_RUNNER_TWO="$SAME_OUTPUT_ROOT/runner-two"
SAME_OUTPUT_DIRECTORY="$SAME_OUTPUT_ROOT/output"
SAME_OUTPUT_ARCHIVE="$SAME_OUTPUT_DIRECTORY/photo-api.tar.gz"
mkdir -p "$SAME_OUTPUT_BUILD_BARRIER" "$SAME_OUTPUT_ARCHIVE_BARRIER" \
  "$SAME_OUTPUT_RUNNER_ONE" "$SAME_OUTPUT_RUNNER_TWO" "$SAME_OUTPUT_DIRECTORY"
set_dist_fixture 'same-output-pre-existing-dist'
SAME_OUTPUT_DIST_DIGEST="$(dist_fixture_digest)"
run_packager "$SAME_OUTPUT_RUNNER_ONE" "$SAME_OUTPUT_ARCHIVE" \
  PACKAGE_API_RUN_ID=same-output-one \
  PACKAGE_API_BUILD_BARRIER="$SAME_OUTPUT_BUILD_BARRIER" \
  PACKAGE_API_ARCHIVE_BARRIER="$SAME_OUTPUT_ARCHIVE_BARRIER" \
  >"$SAME_OUTPUT_ROOT/one.log" 2>&1 &
SAME_OUTPUT_PID_ONE=$!
wait_for_path "$SAME_OUTPUT_BUILD_BARRIER/same-output-one.ready" 'first same-output build'
run_packager "$SAME_OUTPUT_RUNNER_TWO" "$SAME_OUTPUT_ARCHIVE" \
  PACKAGE_API_RUN_ID=same-output-two \
  PACKAGE_API_BUILD_BARRIER="$SAME_OUTPUT_BUILD_BARRIER" \
  PACKAGE_API_ARCHIVE_BARRIER="$SAME_OUTPUT_ARCHIVE_BARRIER" \
  >"$SAME_OUTPUT_ROOT/two.log" 2>&1 &
SAME_OUTPUT_PID_TWO=$!
wait_for_path "$SAME_OUTPUT_BUILD_BARRIER/same-output-two.ready" 'second same-output build'
: >"$SAME_OUTPUT_BUILD_BARRIER/same-output-one.release"
wait_for_path "$SAME_OUTPUT_ARCHIVE_BARRIER/same-output-one.ready" 'first private archive'
: >"$SAME_OUTPUT_BUILD_BARRIER/same-output-two.release"
wait_for_path "$SAME_OUTPUT_ARCHIVE_BARRIER/same-output-two.ready" 'second private archive'
: >"$SAME_OUTPUT_ARCHIVE_BARRIER/same-output-one.release"
: >"$SAME_OUTPUT_ARCHIVE_BARRIER/same-output-two.release"
wait_for_process "$SAME_OUTPUT_PID_ONE" SAME_OUTPUT_STATUS_ONE
wait_for_process "$SAME_OUTPUT_PID_TWO" SAME_OUTPUT_STATUS_TWO
SAME_OUTPUT_SUCCESS_COUNT=0
[[ "$SAME_OUTPUT_STATUS_ONE" -eq 0 ]] && SAME_OUTPUT_SUCCESS_COUNT=$((SAME_OUTPUT_SUCCESS_COUNT + 1))
[[ "$SAME_OUTPUT_STATUS_TWO" -eq 0 ]] && SAME_OUTPUT_SUCCESS_COUNT=$((SAME_OUTPUT_SUCCESS_COUNT + 1))
[[ "$SAME_OUTPUT_SUCCESS_COUNT" -eq 1 ]] ||
  fail "same output must have exactly one winner: one=$SAME_OUTPUT_STATUS_ONE ($(cat "$SAME_OUTPUT_ROOT/one.log")); two=$SAME_OUTPUT_STATUS_TWO ($(cat "$SAME_OUTPUT_ROOT/two.log"))"
[[ -f "$SAME_OUTPUT_ARCHIVE" && ! -L "$SAME_OUTPUT_ARCHIVE" ]] ||
  fail 'same-output winner did not leave one ordinary archive'
"$REAL_TAR" -tzf "$SAME_OUTPUT_ARCHIVE" >/dev/null ||
  fail 'same-output winner left a partial archive'
SAME_OUTPUT_MARKER="$(archive_runtime_marker "$SAME_OUTPUT_ARCHIVE")"
[[ "$SAME_OUTPUT_MARKER" == *'same-output-one'* || "$SAME_OUTPUT_MARKER" == *'same-output-two'* ]] ||
  fail 'same-output archive mixed or lost its isolated build'
[[ -d "$DIST_PATH" && "$(dist_fixture_digest)" == "$SAME_OUTPUT_DIST_DIGEST" ]] ||
  fail 'same-output race changed the pre-existing repository dist'
[[ -z "$(find "$SAME_OUTPUT_RUNNER_ONE" "$SAME_OUTPUT_RUNNER_TWO" -mindepth 1 -print -quit)" ]] ||
  fail 'same-output packages left owned runner temporary files behind'
[[ "$(find "$SAME_OUTPUT_DIRECTORY" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" == '1' ]] ||
  fail 'same-output race left a private or partial publication behind'
restore_original_dist

[[ "$(git -C "$REPOSITORY_ROOT" status --porcelain=v1)" == "$STATUS_BEFORE" ]] ||
  fail 'concurrency packaging tests changed the Git worktree'
assert_dist_unchanged

printf 'package-api tests passed\n'
