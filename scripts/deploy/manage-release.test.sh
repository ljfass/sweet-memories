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
  local expected="$2"
  local output
  shift 2

  if output="$("$@" 2>&1)"; then
    fail "$label unexpectedly succeeded"
  fi
  [[ "$output" == *"$expected"* ]] ||
    fail "$label failed without expected error '$expected': $output"
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
assert_fails 'archive missing index.html' 'missing a regular index.html' \
  bash "$MANAGER" activate "$SITE_ROOT" "$SHA_B" "$BAD_ARCHIVE"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
[[ ! -e "$SITE_ROOT/releases/$SHA_B" ]] ||
  fail 'invalid target release was not removed'
[[ ! -e "$SITE_ROOT/releases/.incoming-$SHA_B" ]] ||
  fail 'invalid staged release was not removed'

SHA_D='dddddddddddddddddddddddddddddddddddddddd'
CORRUPT_ARCHIVE="$TEST_DIR/release-d.tar.gz"
printf 'not a tar archive\n' >"$CORRUPT_ARCHIVE"
assert_fails 'corrupt archive' 'release archive could not be extracted' \
  bash "$MANAGER" activate "$SITE_ROOT" "$SHA_D" "$CORRUPT_ARCHIVE"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
[[ ! -e "$SITE_ROOT/releases/$SHA_D" ]] ||
  fail 'corrupt target release was created'
[[ ! -e "$SITE_ROOT/releases/.incoming-$SHA_D" ]] ||
  fail 'corrupt staged release was not removed'

SHA_TERM='6666666666666666666666666666666666666666'
OTHER_STAGING_SHA='6767676767676767676767676767676767676767'
TERM_ARCHIVE="$TEST_DIR/release-term.tar.gz"
printf 'archive contents are replaced by the fault-injection tar\n' >"$TERM_ARCHIVE"
mkdir -p "$SITE_ROOT/releases/.incoming-$OTHER_STAGING_SHA"
TERM_BIN="$TEST_DIR/term-bin"
mkdir -p "$TERM_BIN"
cat >"$TERM_BIN/tar" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

staging=''
while (($# > 0)); do
  if [[ "$1" == '-C' && $# -ge 2 ]]; then
    staging="$2"
    break
  fi
  shift
done
[[ -n "$staging" ]]
mkdir -p "$staging/assets"
printf '<html>interrupted</html>\n' >"$staging/index.html"
printf 'partial\n' >"$staging/assets/version.txt"
kill -TERM "$PPID"
exit 143
EOF
chmod u+x "$TERM_BIN/tar"
if env PATH="$TERM_BIN:$PATH" \
  bash "$MANAGER" activate "$SITE_ROOT" "$SHA_TERM" "$TERM_ARCHIVE" \
  >/dev/null 2>&1; then
  fail 'TERM-interrupted activation unexpectedly succeeded'
fi
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
[[ ! -e "$SITE_ROOT/releases/$SHA_TERM" ]] ||
  fail 'TERM-interrupted activation created the final release'
[[ ! -e "$SITE_ROOT/releases/.incoming-$SHA_TERM" ]] ||
  fail 'TERM-interrupted activation left its staging directory behind'
[[ -d "$SITE_ROOT/releases/.incoming-$OTHER_STAGING_SHA" ]] ||
  fail 'TERM-interrupted activation deleted another staging directory'

SHA_SYMLINK='1111111111111111111111111111111111111111'
SYMLINK_ARCHIVE="$TEST_DIR/release-symlink.tar.gz"
SYMLINK_SOURCE="$TEST_DIR/symlink-source"
mkdir -p "$SYMLINK_SOURCE/assets"
printf '<html>unsafe symlink</html>\n' >"$SYMLINK_SOURCE/index.html"
ln -s /etc/passwd "$SYMLINK_SOURCE/assets/server-file"
tar -C "$SYMLINK_SOURCE" -czf "$SYMLINK_ARCHIVE" .
assert_fails 'archive containing an external symlink' \
  'release contains an unsupported filesystem entry' \
  bash "$MANAGER" activate "$SITE_ROOT" "$SHA_SYMLINK" "$SYMLINK_ARCHIVE"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
[[ ! -e "$SITE_ROOT/releases/$SHA_SYMLINK" ]] ||
  fail 'symlink target release was created'
[[ ! -e "$SITE_ROOT/releases/.incoming-$SHA_SYMLINK" ]] ||
  fail 'symlink staged release was not removed'

SHA_FIFO='2222222222222222222222222222222222222222'
FIFO_ARCHIVE="$TEST_DIR/release-fifo.tar.gz"
FIFO_SOURCE="$TEST_DIR/fifo-source"
mkdir -p "$FIFO_SOURCE/assets"
printf '<html>unsafe fifo</html>\n' >"$FIFO_SOURCE/index.html"
mkfifo "$FIFO_SOURCE/assets/unsafe.pipe"
COPYFILE_DISABLE=1 tar -C "$FIFO_SOURCE" -czf "$FIFO_ARCHIVE" .
assert_fails 'archive containing a FIFO' \
  'release contains an unsupported filesystem entry' \
  bash "$MANAGER" activate "$SITE_ROOT" "$SHA_FIFO" "$FIFO_ARCHIVE"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
[[ ! -e "$SITE_ROOT/releases/$SHA_FIFO" ]] ||
  fail 'FIFO target release was created'
[[ ! -e "$SITE_ROOT/releases/.incoming-$SHA_FIFO" ]] ||
  fail 'FIFO staged release was not removed'

SHA_C='cccccccccccccccccccccccccccccccccccccccc'
ARCHIVE_C="$TEST_DIR/release-c.tar.gz"
make_archive 'release-c' "$ARCHIVE_C"
bash "$MANAGER" activate "$SITE_ROOT" "$SHA_C" "$ARCHIVE_C"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_C"
assert_same_path "$SITE_ROOT/previous" "$SITE_ROOT/releases/$SHA_A"
bash "$MANAGER" rollback "$SITE_ROOT"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
assert_same_path "$SITE_ROOT/previous" "$SITE_ROOT/releases/$SHA_C"

ROLLBACK_EXPECTED_ROOT="$TEST_DIR/rollback-expected-site"
ROLLBACK_EXPECTED_SHA='3333333333333333333333333333333333333333'
mkdir -p "$ROLLBACK_EXPECTED_ROOT/releases/$ROLLBACK_EXPECTED_SHA" \
  "$ROLLBACK_EXPECTED_ROOT/releases/known-good"
printf '<html>unhealthy</html>\n' \
  >"$ROLLBACK_EXPECTED_ROOT/releases/$ROLLBACK_EXPECTED_SHA/index.html"
printf '<html>known-good</html>\n' \
  >"$ROLLBACK_EXPECTED_ROOT/releases/known-good/index.html"
ln -s "$ROLLBACK_EXPECTED_ROOT/releases/$ROLLBACK_EXPECTED_SHA" \
  "$ROLLBACK_EXPECTED_ROOT/html"
ln -s "$ROLLBACK_EXPECTED_ROOT/releases/known-good" \
  "$ROLLBACK_EXPECTED_ROOT/previous"

bash "$MANAGER" rollback-if-current \
  "$ROLLBACK_EXPECTED_ROOT" "$ROLLBACK_EXPECTED_SHA"
assert_same_path \
  "$ROLLBACK_EXPECTED_ROOT/html" \
  "$ROLLBACK_EXPECTED_ROOT/releases/known-good"
assert_same_path \
  "$ROLLBACK_EXPECTED_ROOT/previous" \
  "$ROLLBACK_EXPECTED_ROOT/releases/$ROLLBACK_EXPECTED_SHA"

EXPECTED_HTML_AFTER_ROLLBACK="$(resolve_path "$ROLLBACK_EXPECTED_ROOT/html")"
EXPECTED_PREVIOUS_AFTER_ROLLBACK="$(resolve_path "$ROLLBACK_EXPECTED_ROOT/previous")"
assert_fails 'rollback-if-current retry after successful rollback' \
  'current release does not match expected SHA' \
  bash "$MANAGER" rollback-if-current \
    "$ROLLBACK_EXPECTED_ROOT" "$ROLLBACK_EXPECTED_SHA"
[[ "$(resolve_path "$ROLLBACK_EXPECTED_ROOT/html")" == \
  "$EXPECTED_HTML_AFTER_ROLLBACK" ]] ||
  fail 'rollback-if-current retry changed the html pointer'
[[ "$(resolve_path "$ROLLBACK_EXPECTED_ROOT/previous")" == \
  "$EXPECTED_PREVIOUS_AFTER_ROLLBACK" ]] ||
  fail 'rollback-if-current retry changed the previous pointer'

ROLLBACK_MISMATCH_ROOT="$TEST_DIR/rollback-mismatch-site"
ROLLBACK_MISMATCH_SHA='4444444444444444444444444444444444444444'
mkdir -p "$ROLLBACK_MISMATCH_ROOT/releases/current" \
  "$ROLLBACK_MISMATCH_ROOT/releases/known-good"
printf '<html>current</html>\n' \
  >"$ROLLBACK_MISMATCH_ROOT/releases/current/index.html"
printf '<html>known-good</html>\n' \
  >"$ROLLBACK_MISMATCH_ROOT/releases/known-good/index.html"
ln -s "$ROLLBACK_MISMATCH_ROOT/releases/current" \
  "$ROLLBACK_MISMATCH_ROOT/html"
ln -s "$ROLLBACK_MISMATCH_ROOT/releases/known-good" \
  "$ROLLBACK_MISMATCH_ROOT/previous"
MISMATCH_HTML_BEFORE="$(resolve_path "$ROLLBACK_MISMATCH_ROOT/html")"
MISMATCH_PREVIOUS_BEFORE="$(resolve_path "$ROLLBACK_MISMATCH_ROOT/previous")"
assert_fails 'rollback-if-current current mismatch' \
  'current release does not match expected SHA' \
  bash "$MANAGER" rollback-if-current \
    "$ROLLBACK_MISMATCH_ROOT" "$ROLLBACK_MISMATCH_SHA"
[[ "$(resolve_path "$ROLLBACK_MISMATCH_ROOT/html")" == \
  "$MISMATCH_HTML_BEFORE" ]] ||
  fail 'rollback-if-current mismatch changed the html pointer'
[[ "$(resolve_path "$ROLLBACK_MISMATCH_ROOT/previous")" == \
  "$MISMATCH_PREVIOUS_BEFORE" ]] ||
  fail 'rollback-if-current mismatch changed the previous pointer'

assert_fails 'rollback-if-current invalid SHA' \
  'release SHA must be 40 lowercase hexadecimal characters' \
  bash "$MANAGER" rollback-if-current "$ROLLBACK_MISMATCH_ROOT" not-a-sha
[[ "$(resolve_path "$ROLLBACK_MISMATCH_ROOT/html")" == \
  "$MISMATCH_HTML_BEFORE" ]] ||
  fail 'rollback-if-current invalid SHA changed the html pointer'
[[ "$(resolve_path "$ROLLBACK_MISMATCH_ROOT/previous")" == \
  "$MISMATCH_PREVIOUS_BEFORE" ]] ||
  fail 'rollback-if-current invalid SHA changed the previous pointer'

ROLLBACK_NO_PREVIOUS_ROOT="$TEST_DIR/rollback-no-previous-site"
ROLLBACK_NO_PREVIOUS_SHA='5555555555555555555555555555555555555555'
mkdir -p "$ROLLBACK_NO_PREVIOUS_ROOT/releases/$ROLLBACK_NO_PREVIOUS_SHA"
printf '<html>current</html>\n' \
  >"$ROLLBACK_NO_PREVIOUS_ROOT/releases/$ROLLBACK_NO_PREVIOUS_SHA/index.html"
ln -s "$ROLLBACK_NO_PREVIOUS_ROOT/releases/$ROLLBACK_NO_PREVIOUS_SHA" \
  "$ROLLBACK_NO_PREVIOUS_ROOT/html"
assert_fails 'rollback-if-current without previous' \
  'no previous release is available' \
  bash "$MANAGER" rollback-if-current \
    "$ROLLBACK_NO_PREVIOUS_ROOT" "$ROLLBACK_NO_PREVIOUS_SHA"
assert_same_path \
  "$ROLLBACK_NO_PREVIOUS_ROOT/html" \
  "$ROLLBACK_NO_PREVIOUS_ROOT/releases/$ROLLBACK_NO_PREVIOUS_SHA"

ROLLBACK_INVALID_PREVIOUS_ROOT="$TEST_DIR/rollback-invalid-previous-site"
ROLLBACK_INVALID_PREVIOUS_SHA='5656565656565656565656565656565656565656'
mkdir -p \
  "$ROLLBACK_INVALID_PREVIOUS_ROOT/releases/$ROLLBACK_INVALID_PREVIOUS_SHA" \
  "$ROLLBACK_INVALID_PREVIOUS_ROOT/outside-release"
printf '<html>current</html>\n' \
  >"$ROLLBACK_INVALID_PREVIOUS_ROOT/releases/$ROLLBACK_INVALID_PREVIOUS_SHA/index.html"
printf '<html>outside</html>\n' \
  >"$ROLLBACK_INVALID_PREVIOUS_ROOT/outside-release/index.html"
ln -s \
  "$ROLLBACK_INVALID_PREVIOUS_ROOT/releases/$ROLLBACK_INVALID_PREVIOUS_SHA" \
  "$ROLLBACK_INVALID_PREVIOUS_ROOT/html"
ln -s "$ROLLBACK_INVALID_PREVIOUS_ROOT/outside-release" \
  "$ROLLBACK_INVALID_PREVIOUS_ROOT/previous"
INVALID_PREVIOUS_HTML_BEFORE="$(
  resolve_path "$ROLLBACK_INVALID_PREVIOUS_ROOT/html"
)"
INVALID_PREVIOUS_LINK_BEFORE="$(
  resolve_path "$ROLLBACK_INVALID_PREVIOUS_ROOT/previous"
)"
assert_fails 'rollback-if-current with previous outside releases' \
  'must point to a release' \
  bash "$MANAGER" rollback-if-current \
    "$ROLLBACK_INVALID_PREVIOUS_ROOT" "$ROLLBACK_INVALID_PREVIOUS_SHA"
[[ "$(resolve_path "$ROLLBACK_INVALID_PREVIOUS_ROOT/html")" == \
  "$INVALID_PREVIOUS_HTML_BEFORE" ]] ||
  fail 'invalid-previous rollback changed the html pointer'
[[ "$(resolve_path "$ROLLBACK_INVALID_PREVIOUS_ROOT/previous")" == \
  "$INVALID_PREVIOUS_LINK_BEFORE" ]] ||
  fail 'invalid-previous rollback changed the previous pointer'

ROLLBACK_SAME_ROOT="$TEST_DIR/rollback-same-target-site"
ROLLBACK_SAME_SHA='cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
mkdir -p "$ROLLBACK_SAME_ROOT/releases/$ROLLBACK_SAME_SHA"
printf '<html>same target</html>\n' \
  >"$ROLLBACK_SAME_ROOT/releases/$ROLLBACK_SAME_SHA/index.html"
ln -s "$ROLLBACK_SAME_ROOT/releases/$ROLLBACK_SAME_SHA" \
  "$ROLLBACK_SAME_ROOT/html"
ln -s "$ROLLBACK_SAME_ROOT/releases/$ROLLBACK_SAME_SHA" \
  "$ROLLBACK_SAME_ROOT/previous"
SAME_HTML_BEFORE="$(resolve_path "$ROLLBACK_SAME_ROOT/html")"
SAME_PREVIOUS_BEFORE="$(resolve_path "$ROLLBACK_SAME_ROOT/previous")"
same_target_errors=''
if bash "$MANAGER" rollback "$ROLLBACK_SAME_ROOT" >/dev/null 2>&1; then
  same_target_errors='ordinary rollback'
fi
if bash "$MANAGER" rollback-if-current \
  "$ROLLBACK_SAME_ROOT" "$ROLLBACK_SAME_SHA" >/dev/null 2>&1; then
  if [[ -n "$same_target_errors" ]]; then
    same_target_errors+=', '
  fi
  same_target_errors+='rollback-if-current'
fi
[[ -z "$same_target_errors" ]] ||
  fail "$same_target_errors accepted identical current and previous releases"
[[ "$(resolve_path "$ROLLBACK_SAME_ROOT/html")" == "$SAME_HTML_BEFORE" ]] ||
  fail 'identical-target rollback changed the html pointer'
[[ "$(resolve_path "$ROLLBACK_SAME_ROOT/previous")" == \
  "$SAME_PREVIOUS_BEFORE" ]] ||
  fail 'identical-target rollback changed the previous pointer'

ROLLBACK_FAULT_ROOT="$TEST_DIR/rollback-fault-site"
mkdir -p "$ROLLBACK_FAULT_ROOT/releases/unhealthy" \
  "$ROLLBACK_FAULT_ROOT/releases/known-good"
printf '<html>unhealthy</html>\n' \
  >"$ROLLBACK_FAULT_ROOT/releases/unhealthy/index.html"
printf '<html>known-good</html>\n' \
  >"$ROLLBACK_FAULT_ROOT/releases/known-good/index.html"
ln -s "$ROLLBACK_FAULT_ROOT/releases/unhealthy" "$ROLLBACK_FAULT_ROOT/html"
ln -s "$ROLLBACK_FAULT_ROOT/releases/known-good" \
  "$ROLLBACK_FAULT_ROOT/previous"

FAULT_BIN="$TEST_DIR/fault-bin"
mkdir -p "$FAULT_BIN"
cat >"$FAULT_BIN/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

destination=''
for argument in "$@"; do
  destination="$argument"
done
if [[ "$destination" == "${FAIL_MV_DESTINATION:-}" ]]; then
  printf 'injected previous rename failure\n' >&2
  exit 73
fi
exec "$REAL_MV" "$@"
EOF
chmod u+x "$FAULT_BIN/mv"
REAL_MV="$(command -v mv)"
ROLLBACK_FAULT_ROOT_REAL="$(resolve_path "$ROLLBACK_FAULT_ROOT")"
assert_fails 'rollback previous-link rename fault' \
  'injected previous rename failure' \
  env PATH="$FAULT_BIN:$PATH" \
    REAL_MV="$REAL_MV" \
    FAIL_MV_DESTINATION="$ROLLBACK_FAULT_ROOT_REAL/previous" \
    bash "$MANAGER" rollback "$ROLLBACK_FAULT_ROOT"
assert_same_path \
  "$ROLLBACK_FAULT_ROOT/html" \
  "$ROLLBACK_FAULT_ROOT/releases/known-good"
assert_same_path \
  "$ROLLBACK_FAULT_ROOT/previous" \
  "$ROLLBACK_FAULT_ROOT/releases/known-good"
[[ -d "$ROLLBACK_FAULT_ROOT/releases/unhealthy" ]] ||
  fail 'failed current release was removed after rollback rename fault'
[[ -z "$(
  find "$ROLLBACK_FAULT_ROOT" -maxdepth 1 -name '.*-rollback-*' -print -quit
)" ]] || fail 'rollback left an unused temporary symlink'

NO_PREVIOUS_ROOT="$TEST_DIR/no-previous-site"
mkdir -p "$NO_PREVIOUS_ROOT/releases/initial"
ln -s "$NO_PREVIOUS_ROOT/releases/initial" "$NO_PREVIOUS_ROOT/html"
assert_fails 'rollback without previous' 'no previous release is available' \
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

STAGING_CLEANUP_ROOT="$TEST_DIR/staging-cleanup-site"
ANCIENT_STAGING_SHA='7777777777777777777777777777777777777777'
RECENT_STAGING_SHA='8888888888888888888888888888888888888888'
SYMLINK_STAGING_SHA='9999999999999999999999999999999999999999'
FILE_STAGING_SHA='abababababababababababababababababababab'
mkdir -p "$STAGING_CLEANUP_ROOT/releases/live" \
  "$STAGING_CLEANUP_ROOT/releases/.incoming-$ANCIENT_STAGING_SHA" \
  "$STAGING_CLEANUP_ROOT/releases/.incoming-$RECENT_STAGING_SHA" \
  "$STAGING_CLEANUP_ROOT/releases/.incoming-not-a-sha" \
  "$STAGING_CLEANUP_ROOT/symlink-target"
printf '<html>live</html>\n' \
  >"$STAGING_CLEANUP_ROOT/releases/live/index.html"
touch -t 202001010000 \
  "$STAGING_CLEANUP_ROOT/releases/.incoming-$ANCIENT_STAGING_SHA"
ln -s "$STAGING_CLEANUP_ROOT/symlink-target" \
  "$STAGING_CLEANUP_ROOT/releases/.incoming-$SYMLINK_STAGING_SHA"
printf 'not a directory\n' \
  >"$STAGING_CLEANUP_ROOT/releases/.incoming-$FILE_STAGING_SHA"
ln -s "$STAGING_CLEANUP_ROOT/releases/live" "$STAGING_CLEANUP_ROOT/html"
STAGING_CLEANUP_OUTPUT="$(
  bash "$MANAGER" cleanup "$STAGING_CLEANUP_ROOT" 1
)"
[[ ! -e \
  "$STAGING_CLEANUP_ROOT/releases/.incoming-$ANCIENT_STAGING_SHA" ]] ||
  fail 'cleanup retained an ancient valid staging directory'
[[ "$STAGING_CLEANUP_OUTPUT" == *"removed stale staging:"* ]] ||
  fail 'cleanup did not report the removed stale staging directory'
[[ -d "$STAGING_CLEANUP_ROOT/releases/.incoming-$RECENT_STAGING_SHA" ]] ||
  fail 'cleanup deleted a recent staging directory'
[[ -d "$STAGING_CLEANUP_ROOT/releases/.incoming-not-a-sha" ]] ||
  fail 'cleanup deleted a staging directory with an invalid name'
[[ -L "$STAGING_CLEANUP_ROOT/releases/.incoming-$SYMLINK_STAGING_SHA" ]] ||
  fail 'cleanup deleted a staging symlink'
[[ -f "$STAGING_CLEANUP_ROOT/releases/.incoming-$FILE_STAGING_SHA" ]] ||
  fail 'cleanup deleted a staging file'

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
assert_fails 'unknown mode' \
  'mode must be activate, rollback, rollback-if-current, or cleanup' \
  bash "$MANAGER" unknown
assert_fails 'activate argument count' 'usage: manage-release.sh activate' \
  bash "$MANAGER" activate "$SITE_ROOT"
assert_fails 'rollback argument count' 'usage: manage-release.sh rollback' \
  bash "$MANAGER" rollback
assert_fails 'rollback-if-current argument count' \
  'usage: manage-release.sh rollback-if-current' \
  bash "$MANAGER" rollback-if-current "$SITE_ROOT"
assert_fails 'cleanup argument count' 'usage: manage-release.sh cleanup' \
  bash "$MANAGER" cleanup "$SITE_ROOT"
assert_fails 'relative site root' 'site root must be an absolute path' \
  bash -c 'cd "$1" && bash "$2" rollback site' _ "$TEST_DIR" "$MANAGER"
assert_fails 'invalid SHA' 'release SHA must be 40 lowercase hexadecimal characters' \
  bash "$MANAGER" activate "$SITE_ROOT" abc "$VALIDATION_ARCHIVE"
assert_fails 'missing archive' 'release archive does not exist' \
  bash "$MANAGER" activate "$SITE_ROOT" \
    ffffffffffffffffffffffffffffffffffffffff "$TEST_DIR/missing.tar.gz"
assert_fails 'zero keep count' 'keep count must be a positive integer' \
  bash "$MANAGER" cleanup "$SITE_ROOT" 0
assert_fails 'negative keep count' 'keep count must be a positive integer' \
  bash "$MANAGER" cleanup "$SITE_ROOT" -1
assert_fails 'non-numeric keep count' 'keep count must be a positive integer' \
  bash "$MANAGER" cleanup "$SITE_ROOT" many

INVALID_LIVE_ROOT="$TEST_DIR/invalid-live-site"
mkdir -p "$INVALID_LIVE_ROOT/releases" "$INVALID_LIVE_ROOT/html"
assert_fails 'html is not a symlink' 'html must be a symlink' \
  bash "$MANAGER" activate "$INVALID_LIVE_ROOT" \
    ffffffffffffffffffffffffffffffffffffffff "$VALIDATION_ARCHIVE"

BROKEN_LIVE_ROOT="$TEST_DIR/broken-live-site"
mkdir -p "$BROKEN_LIVE_ROOT/releases"
ln -s "$BROKEN_LIVE_ROOT/releases/missing" "$BROKEN_LIVE_ROOT/html"
assert_fails 'html target is missing' 'directory does not exist' \
  bash "$MANAGER" activate "$BROKEN_LIVE_ROOT" \
    ffffffffffffffffffffffffffffffffffffffff "$VALIDATION_ARCHIVE"

printf 'manage-release.sh: all tests passed\n'
