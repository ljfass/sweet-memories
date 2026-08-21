#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANAGER="$SCRIPT_DIR/manage-release.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

resolve_path() {
  (cd "$1" && pwd -P)
}

assert_same_path() {
  local actual="$1"
  local expected="$2"

  [[ "$(resolve_path "$actual")" == "$(resolve_path "$expected")" ]] ||
    fail "$actual does not point to $expected"
}

assert_fails() {
  local label="$1"
  shift

  if "$@" >"$TEST_DIR/failure.out" 2>&1; then
    fail "$label unexpectedly succeeded"
  fi
}

file_mode() {
  local path="$1"

  if stat -c '%a' "$path" >/dev/null 2>&1; then
    stat -c '%a' "$path"
  else
    stat -f '%Lp' "$path"
  fi
}

make_archive() {
  local label="$1"
  local archive="$2"
  local source_dir

  source_dir="$(mktemp -d "$TEST_DIR/source.XXXXXX")"
  mkdir -p "$source_dir/assets"
  printf '<html>%s</html>\n' "$label" >"$source_dir/index.html"
  printf '%s\n' "$label" >"$source_dir/assets/version.txt"
  tar -C "$source_dir" -czf "$archive" .
  rm -rf "$source_dir"
}

SITE_ROOT="$TEST_DIR/site"
mkdir -p "$SITE_ROOT/releases/initial"
printf '<html>initial</html>\n' >"$SITE_ROOT/releases/initial/index.html"
ln -s "$SITE_ROOT/releases/initial" "$SITE_ROOT/html"

SHA_A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
ARCHIVE_A="$TEST_DIR/release-a.tar.gz"
make_archive 'release-a' "$ARCHIVE_A"
bash "$MANAGER" activate "$SITE_ROOT" "$SHA_A" "$ARCHIVE_A"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
assert_same_path "$SITE_ROOT/previous" "$SITE_ROOT/releases/initial"
[[ "$(cat "$SITE_ROOT/html/assets/version.txt")" == 'release-a' ]] ||
  fail 'activated release content is incorrect'
[[ ! -e "$ARCHIVE_A" ]] || fail 'validated archive was not deleted'
[[ "$(file_mode "$SITE_ROOT/releases/$SHA_A")" == '755' ]] ||
  fail 'release directory permissions are not 755'
[[ "$(file_mode "$SITE_ROOT/releases/$SHA_A/index.html")" == '644' ]] ||
  fail 'release file permissions are not 644'

PREVIOUS_BEFORE="$(resolve_path "$SITE_ROOT/previous")"
IDEMPOTENT_ARCHIVE="$TEST_DIR/release-a-again.tar.gz"
make_archive 'replacement-a' "$IDEMPOTENT_ARCHIVE"
bash "$MANAGER" activate "$SITE_ROOT" "$SHA_A" "$IDEMPOTENT_ARCHIVE"
[[ "$(resolve_path "$SITE_ROOT/previous")" == "$PREVIOUS_BEFORE" ]] ||
  fail 'idempotent activation changed the previous pointer'
[[ "$(cat "$SITE_ROOT/html/assets/version.txt")" == 'release-a' ]] ||
  fail 'idempotent activation replaced an existing release'
[[ ! -e "$IDEMPOTENT_ARCHIVE" ]] ||
  fail 'idempotent activation did not delete the archive'

SHA_B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
BAD_ARCHIVE="$TEST_DIR/release-b.tar.gz"
BAD_SOURCE="$TEST_DIR/bad-source"
mkdir -p "$BAD_SOURCE/assets"
printf 'missing index\n' >"$BAD_SOURCE/assets/version.txt"
tar -C "$BAD_SOURCE" -czf "$BAD_ARCHIVE" .
assert_fails 'archive missing index.html' \
  bash "$MANAGER" activate "$SITE_ROOT" "$SHA_B" "$BAD_ARCHIVE"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
[[ ! -e "$SITE_ROOT/releases/$SHA_B" ]] ||
  fail 'invalid target release was not removed'
[[ ! -e "$SITE_ROOT/releases/.incoming-$SHA_B" ]] ||
  fail 'invalid staged release was not removed'

SHA_D='dddddddddddddddddddddddddddddddddddddddd'
CORRUPT_ARCHIVE="$TEST_DIR/release-d.tar.gz"
printf 'not a tar archive\n' >"$CORRUPT_ARCHIVE"
assert_fails 'corrupt archive' \
  bash "$MANAGER" activate "$SITE_ROOT" "$SHA_D" "$CORRUPT_ARCHIVE"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
[[ ! -e "$SITE_ROOT/releases/$SHA_D" ]] ||
  fail 'corrupt target release was created'
[[ ! -e "$SITE_ROOT/releases/.incoming-$SHA_D" ]] ||
  fail 'corrupt staged release was not removed'

SHA_C='cccccccccccccccccccccccccccccccccccccccc'
ARCHIVE_C="$TEST_DIR/release-c.tar.gz"
make_archive 'release-c' "$ARCHIVE_C"
bash "$MANAGER" activate "$SITE_ROOT" "$SHA_C" "$ARCHIVE_C"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_C"
assert_same_path "$SITE_ROOT/previous" "$SITE_ROOT/releases/$SHA_A"
bash "$MANAGER" rollback "$SITE_ROOT"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
assert_same_path "$SITE_ROOT/previous" "$SITE_ROOT/releases/$SHA_C"

NO_PREVIOUS_ROOT="$TEST_DIR/no-previous-site"
mkdir -p "$NO_PREVIOUS_ROOT/releases/initial"
ln -s "$NO_PREVIOUS_ROOT/releases/initial" "$NO_PREVIOUS_ROOT/html"
assert_fails 'rollback without previous' \
  bash "$MANAGER" rollback "$NO_PREVIOUS_ROOT"

CLEANUP_ROOT="$TEST_DIR/cleanup-site"
mkdir -p "$CLEANUP_ROOT/releases/.incoming-orphan"
printf 'not a release directory\n' >"$CLEANUP_ROOT/releases/loose-file"
for number in 1 2 3 4 5 6 7; do
  release="$CLEANUP_ROOT/releases/release-$number"
  mkdir -p "$release"
  printf '<html>%s</html>\n' "$number" >"$release/index.html"
  touch -t "2026010${number}0000" "$release"
done
ln -s "$CLEANUP_ROOT/releases/release-7" "$CLEANUP_ROOT/html"
ln -s "$CLEANUP_ROOT/releases/release-6" "$CLEANUP_ROOT/previous"
bash "$MANAGER" cleanup "$CLEANUP_ROOT" 5
[[ ! -e "$CLEANUP_ROOT/releases/release-1" ]] ||
  fail 'oldest release 1 was not deleted'
[[ ! -e "$CLEANUP_ROOT/releases/release-2" ]] ||
  fail 'oldest release 2 was not deleted'
for number in 3 4 5 6 7; do
  [[ -d "$CLEANUP_ROOT/releases/release-$number" ]] ||
    fail "retained release $number was deleted"
done
[[ -d "$CLEANUP_ROOT/releases/.incoming-orphan" ]] ||
  fail 'cleanup deleted a hidden staging directory'
[[ -f "$CLEANUP_ROOT/releases/loose-file" ]] ||
  fail 'cleanup deleted a non-directory entry'

PROTECTED_ROOT="$TEST_DIR/protected-cleanup-site"
mkdir -p "$PROTECTED_ROOT/releases/current" \
  "$PROTECTED_ROOT/releases/previous" \
  "$PROTECTED_ROOT/releases/newest" \
  "$PROTECTED_ROOT/releases/stale"
touch -t 202001010000 "$PROTECTED_ROOT/releases/previous"
touch -t 202001020000 "$PROTECTED_ROOT/releases/current"
touch -t 202001030000 "$PROTECTED_ROOT/releases/stale"
touch -t 202001040000 "$PROTECTED_ROOT/releases/newest"
ln -s "$PROTECTED_ROOT/releases/current" "$PROTECTED_ROOT/html"
ln -s "$PROTECTED_ROOT/releases/previous" "$PROTECTED_ROOT/previous"
bash "$MANAGER" cleanup "$PROTECTED_ROOT" 1
[[ -d "$PROTECTED_ROOT/releases/current" ]] ||
  fail 'cleanup deleted the current release outside the keep count'
[[ -d "$PROTECTED_ROOT/releases/previous" ]] ||
  fail 'cleanup deleted the previous release outside the keep count'
[[ -d "$PROTECTED_ROOT/releases/newest" ]] ||
  fail 'cleanup deleted the newest release'
[[ ! -e "$PROTECTED_ROOT/releases/stale" ]] ||
  fail 'cleanup retained an old unprotected release'

REFRESH_ROOT="$TEST_DIR/refresh-site"
REFRESH_SHA='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
mkdir -p "$REFRESH_ROOT/releases/initial" \
  "$REFRESH_ROOT/releases/$REFRESH_SHA"
printf '<html>initial</html>\n' >"$REFRESH_ROOT/releases/initial/index.html"
printf '<html>existing</html>\n' >"$REFRESH_ROOT/releases/$REFRESH_SHA/index.html"
touch -t 202001010000 "$REFRESH_ROOT/releases/$REFRESH_SHA"
ln -s "$REFRESH_ROOT/releases/initial" "$REFRESH_ROOT/html"
REFRESH_ARCHIVE="$TEST_DIR/refresh.tar.gz"
make_archive 'ignored' "$REFRESH_ARCHIVE"
bash "$MANAGER" activate "$REFRESH_ROOT" "$REFRESH_SHA" "$REFRESH_ARCHIVE"
mkdir -p "$REFRESH_ROOT/releases/current" \
  "$REFRESH_ROOT/releases/previous" \
  "$REFRESH_ROOT/releases/stale"
touch -t 202001020000 "$REFRESH_ROOT/releases/current"
touch -t 202001030000 "$REFRESH_ROOT/releases/previous"
touch -t 202001040000 "$REFRESH_ROOT/releases/stale"
ln -sfn "$REFRESH_ROOT/releases/current" "$REFRESH_ROOT/html"
ln -sfn "$REFRESH_ROOT/releases/previous" "$REFRESH_ROOT/previous"
bash "$MANAGER" cleanup "$REFRESH_ROOT" 1
[[ -d "$REFRESH_ROOT/releases/$REFRESH_SHA" ]] ||
  fail 'reactivated release mtime was not refreshed for cleanup'
[[ ! -e "$REFRESH_ROOT/releases/stale" ]] ||
  fail 'cleanup retained a stale release after mtime refresh'

VALIDATION_ARCHIVE="$TEST_DIR/validation.tar.gz"
make_archive 'validation' "$VALIDATION_ARCHIVE"
assert_fails 'unknown mode' bash "$MANAGER" unknown
assert_fails 'activate argument count' bash "$MANAGER" activate "$SITE_ROOT"
assert_fails 'rollback argument count' bash "$MANAGER" rollback
assert_fails 'cleanup argument count' bash "$MANAGER" cleanup "$SITE_ROOT"
assert_fails 'relative site root' \
  bash -c 'cd "$1" && bash "$2" rollback site' _ "$TEST_DIR" "$MANAGER"
assert_fails 'invalid SHA' \
  bash "$MANAGER" activate "$SITE_ROOT" abc "$VALIDATION_ARCHIVE"
assert_fails 'missing archive' \
  bash "$MANAGER" activate "$SITE_ROOT" \
    ffffffffffffffffffffffffffffffffffffffff "$TEST_DIR/missing.tar.gz"
assert_fails 'zero keep count' bash "$MANAGER" cleanup "$SITE_ROOT" 0
assert_fails 'negative keep count' bash "$MANAGER" cleanup "$SITE_ROOT" -1
assert_fails 'non-numeric keep count' bash "$MANAGER" cleanup "$SITE_ROOT" many

INVALID_LIVE_ROOT="$TEST_DIR/invalid-live-site"
mkdir -p "$INVALID_LIVE_ROOT/releases" "$INVALID_LIVE_ROOT/html"
assert_fails 'html is not a symlink' \
  bash "$MANAGER" activate "$INVALID_LIVE_ROOT" \
    ffffffffffffffffffffffffffffffffffffffff "$VALIDATION_ARCHIVE"

BROKEN_LIVE_ROOT="$TEST_DIR/broken-live-site"
mkdir -p "$BROKEN_LIVE_ROOT/releases"
ln -s "$BROKEN_LIVE_ROOT/releases/missing" "$BROKEN_LIVE_ROOT/html"
assert_fails 'html target is missing' \
  bash "$MANAGER" activate "$BROKEN_LIVE_ROOT" \
    ffffffffffffffffffffffffffffffffffffffff "$VALIDATION_ARCHIVE"

printf 'manage-release.sh: all tests passed\n'
