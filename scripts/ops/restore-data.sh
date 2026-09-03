#!/usr/bin/env bash
set -Eeuo pipefail

DATA_ROOT=/var/lib/sweet-memories
SERVICE_NAME=sweet-memories-api.service
SERVICE_USER=sweet-memories
SERVICE_GROUP=sweet-memories-media
HEALTH_URL=http://127.0.0.1:3100/api/health
LOCK_FILE=/run/lock/sweet-memories-api-release.lock
RESTORE_JOURNAL=/var/lib/.sweet-memories-restore.state
RESERVE_BYTES=1073741824

restore_workspace=''
restore_workspace_identity=''
restore_private_archive=''
restore_private_sidecar=''
restore_extracted=''
restore_lock_held=0
restore_trap_active=0
restore_apply_started=0
restore_service_stopped=0
restore_completed=0
restore_recovery=''
restore_recovery_identity=''
restore_original_identity=''
restore_installed_identity=''
restore_journal_identity=''
restore_journal_phase=''
restore_journal_temporary=''
restore_journal_temporary_identity=''

restore_die() {
  printf 'data restore error: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || restore_die 'must run as root'
}

canonical_directory() {
  local path="$1"

  [[ -d "$path" && ! -L "$path" ]] || return 1
  (cd "$path" && pwd -P)
}

file_size() {
  stat -c '%s' "$1" 2>/dev/null || stat -f '%z' "$1"
}

file_identity() {
  stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1"
}

file_identity_follow() {
  stat -Lc '%d:%i' "$1" 2>/dev/null || stat -Lf '%d:%i' "$1"
}

file_inode() {
  stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1"
}

file_link_count() {
  stat -c '%h' "$1" 2>/dev/null || stat -f '%l' "$1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

safe_relative_path() {
  local path="$1"

  [[ -n "$path" && "$path" != /* && "$path" != *'\'* &&
    "$path" != *$'\n'* && "$path" != *$'\r'* && "$path" != *$'\t'* &&
    "$path" != */../* && "$path" != ../* && "$path" != */.. &&
    "$path" != */./* && "$path" != ./* && "$path" != */. ]]
}

safe_path_segment() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

directory_is_owned() {
  local path="$1"
  local identity="$2"

  [[ -d "$path" && ! -L "$path" && "$(file_identity "$path")" == "$identity" ]]
}

ordinary_single_link() {
  local path="$1"

  [[ -f "$path" && ! -L "$path" && "$(file_link_count "$path")" == '1' ]]
}

acquire_restore_lock() {
  local parent

  [[ "$LOCK_FILE" == /* && ! -L "$LOCK_FILE" ]] || restore_die 'maintenance lock path is unsafe'
  parent="$(dirname "$LOCK_FILE")"
  [[ "$(canonical_directory "$parent")" == "$parent" ]] ||
    restore_die 'maintenance lock directory is unsafe'
  umask 077
  exec 9>>"$LOCK_FILE"
  chown root:root "$LOCK_FILE"
  chmod 0600 "$LOCK_FILE"
  flock -x 9 || restore_die 'could not acquire maintenance lock'
  restore_lock_held=1
}

health_check() {
  local attempt

  for attempt in 1 2 3; do
    if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$HEALTH_URL" \
      >/dev/null; then
      return 0
    fi
    [[ "$attempt" == '3' ]] || sleep 1
  done
  return 1
}

stop_service() {
  systemctl stop "$SERVICE_NAME" || restore_die 'could not stop API service'
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    restore_die 'API service is still active after stop'
  fi
  restore_service_stopped=1
}

start_and_check_service() {
  systemctl start "$SERVICE_NAME" || return 1
  health_check
}

cleanup_restore_workspace() {
  [[ -n "$restore_workspace" && -n "$restore_workspace_identity" ]] || return 0
  case "$(basename "$restore_workspace")" in
    .sweet-memories-restore.*|sweet-memories-restore.*)
      if directory_is_owned "$restore_workspace" "$restore_workspace_identity"; then
        rm -rf -- "$restore_workspace"
      fi
      ;;
  esac
  restore_workspace=''
  restore_workspace_identity=''
}

remove_owned_journal() {
  [[ -n "$restore_journal_identity" ]] || return 0
  if ordinary_single_link "$RESTORE_JOURNAL" &&
    [[ "$(file_identity "$RESTORE_JOURNAL")" == "$restore_journal_identity" ]]; then
    rm -f -- "$RESTORE_JOURNAL"
  fi
  restore_journal_identity=''
}

remove_owned_journal_temporary() {
  [[ -n "$restore_journal_temporary" &&
    -n "$restore_journal_temporary_identity" ]] || return 0
  if [[ -f "$restore_journal_temporary" && ! -L "$restore_journal_temporary" &&
    "$(file_identity "$restore_journal_temporary")" == \
      "$restore_journal_temporary_identity" ]]; then
    rm -f -- "$restore_journal_temporary"
  fi
  restore_journal_temporary=''
  restore_journal_temporary_identity=''
}

validate_tools() {
  command -v sqlite3 >/dev/null 2>&1 || restore_die 'sqlite3 is required'
  command -v flock >/dev/null 2>&1 || restore_die 'flock is required'
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    restore_die 'a SHA-256 tool is required'
  fi
}

create_restore_workspace() {
  local action="$1"
  local root parent

  if [[ "$action" == 'apply' ]]; then
    parent="$(dirname "$DATA_ROOT")"
    [[ "$(canonical_directory "$parent")" == "$parent" ]] ||
      restore_die 'data parent is not a safe ordinary directory'
    root="$parent"
  else
    root="${TMPDIR:-/tmp}"
    [[ "$(canonical_directory "$root")" == "$root" ]] ||
      restore_die 'temporary root is not a safe ordinary directory'
  fi
  restore_workspace="$(mktemp -d "$root/.sweet-memories-restore.XXXXXX")" ||
    restore_die 'could not create private restore workspace'
  chmod 0700 "$restore_workspace"
  chown root:root "$restore_workspace"
  restore_workspace_identity="$(file_identity "$restore_workspace")"
  directory_is_owned "$restore_workspace" "$restore_workspace_identity" ||
    restore_die 'private restore workspace is unsafe'
}

copy_open_file() {
  local source="$1"
  local destination="$2"
  local destination_identity source_inode source_size

  [[ "$source" == /* ]] || restore_die 'archive and sidecar paths must be absolute'
  ordinary_single_link "$source" || restore_die "archive input is not a single-link ordinary file: $source"
  source_inode="$(file_inode "$source")"
  source_size="$(file_size "$source")"
  exec 7<"$source" || restore_die "could not open restore input: $source"
  [[ -f /dev/fd/7 && "$(file_link_count /dev/fd/7)" == '1' &&
    "$(file_inode /dev/fd/7)" == "$source_inode" &&
    "$(file_size /dev/fd/7)" == "$source_size" ]] || {
    exec 7<&-
    restore_die 'opened restore input is not an ordinary file'
  }
  umask 077
  cat <&7 >"$destination" || {
    exec 7<&-
    restore_die 'restore input could not be copied'
  }
  exec 7<&-
  chmod 0400 "$destination"
  destination_identity="$(file_identity "$destination")"
  ordinary_single_link "$destination" ||
    restore_die 'private restore input is not an ordinary file'
  [[ "$(file_identity "$destination")" == "$destination_identity" &&
    "$(file_size "$destination")" == "$source_size" ]] ||
    restore_die 'private restore input identity changed'
}

copy_restore_inputs() {
  local archive="$1"
  local sidecar="$archive.sha256"
  local basename expected recorded line actual

  basename="$(basename "$archive")"
  [[ "$basename" =~ ^sweet-memories-data-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] ||
    restore_die 'archive basename is invalid'
  [[ -e "$sidecar" || -L "$sidecar" ]] || restore_die 'archive checksum sidecar is missing'
  restore_private_archive="$restore_workspace/archive.tar.gz"
  restore_private_sidecar="$restore_workspace/archive.tar.gz.sha256"
  copy_open_file "$archive" "$restore_private_archive"
  copy_open_file "$sidecar" "$restore_private_sidecar"

  [[ "$(wc -l <"$restore_private_sidecar" | tr -d ' ')" == '1' ]] ||
    restore_die 'archive checksum sidecar must contain exactly one line'
  line="$(cat "$restore_private_sidecar")"
  expected="${line%%  *}"
  recorded="${line#*  }"
  [[ "$line" == "$expected  $recorded" && "$expected" =~ ^[0-9a-f]{64}$ &&
    "$recorded" == "$basename" && "$recorded" != */* ]] ||
    restore_die 'archive checksum sidecar is invalid'
  actual="$(sha256_file "$restore_private_archive")"
  [[ "$actual" == "$expected" ]] || restore_die 'archive checksum mismatch'
}

normalize_archive_member() {
  local member="$1"

  while [[ "$member" == ./* ]]; do
    member="${member#./}"
  done
  member="${member%/}"
  printf '%s\n' "$member"
}

allowed_archive_member() {
  local member="$1"

  case "$member" in
    database|media|SHA256SUMS|MANIFEST.txt) return 0 ;;
    database/sweet-memories.sqlite3) return 0 ;;
    media/*) return 0 ;;
    *) return 1 ;;
  esac
}

validate_archive_listing() {
  local type_listing="$restore_workspace/type-listing"
  local name_listing="$restore_workspace/name-listing"
  local normalized_listing="$restore_workspace/normalized-listing"
  local entry type member normalized

  LC_ALL=C tar -tvPzf "$restore_private_archive" >"$type_listing" ||
    restore_die 'archive could not be listed'
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    type="${entry:0:1}"
    [[ "$type" == '-' || "$type" == 'd' ]] ||
      restore_die 'archive contains a non-ordinary entry'
  done <"$type_listing"

  LC_ALL=C tar -tPzf "$restore_private_archive" >"$name_listing" ||
    restore_die 'archive could not be listed'
  : >"$normalized_listing"
  while IFS= read -r member; do
    normalized="$(normalize_archive_member "$member")"
    [[ -n "$normalized" ]] || continue
    safe_relative_path "$normalized" || restore_die 'unsafe archive path'
    allowed_archive_member "$normalized" || restore_die 'archive contains a forbidden path'
    printf '%s\n' "$normalized" >>"$normalized_listing"
  done <"$name_listing"
  [[ -z "$(LC_ALL=C sort "$normalized_listing" | uniq -d)" ]] ||
    restore_die 'archive contains duplicate paths'
  for member in database database/sweet-memories.sqlite3 media SHA256SUMS MANIFEST.txt; do
    grep -Fxq "$member" "$normalized_listing" || restore_die "archive is missing $member"
  done
}

extract_and_validate_tree() {
  local entry relative top unsupported

  restore_extracted="$restore_workspace/data"
  mkdir -m 0700 "$restore_extracted"
  tar -xzf "$restore_private_archive" -C "$restore_extracted" ||
    restore_die 'archive extraction failed'
  unsupported="$(find "$restore_extracted" ! -type f ! -type d -print -quit)"
  [[ -z "$unsupported" ]] || restore_die 'extracted archive contains a non-ordinary entry'
  while IFS= read -r -d '' entry; do
    relative="${entry#"$restore_extracted/"}"
    safe_relative_path "$relative" || restore_die 'unsafe extracted archive path'
  done < <(find "$restore_extracted" -mindepth 1 -print0)
  while IFS= read -r top; do
    case "$(basename "$top")" in
      database|media|SHA256SUMS|MANIFEST.txt) ;;
      *) restore_die 'extracted archive contains a forbidden top-level path' ;;
    esac
  done < <(find "$restore_extracted" -mindepth 1 -maxdepth 1 -print)
  [[ -d "$restore_extracted/database" && ! -L "$restore_extracted/database" &&
    -d "$restore_extracted/media" && ! -L "$restore_extracted/media" &&
    -f "$restore_extracted/database/sweet-memories.sqlite3" &&
    ! -L "$restore_extracted/database/sweet-memories.sqlite3" &&
    -f "$restore_extracted/SHA256SUMS" && ! -L "$restore_extracted/SHA256SUMS" &&
    -f "$restore_extracted/MANIFEST.txt" && ! -L "$restore_extracted/MANIFEST.txt" ]] ||
    restore_die 'extracted archive structure is invalid'
}

validate_manifests() {
  local sha_file="$restore_extracted/SHA256SUMS"
  local manifest="$restore_extracted/MANIFEST.txt"
  local seen="$restore_workspace/seen-paths"
  local line digest separator relative actual size expected_manifest
  local sha_count=0 manifest_count=0 actual_count

  cmp -s "$sha_file" <(LC_ALL=C sort -k2,2 "$sha_file") ||
    restore_die 'SHA256SUMS is not sorted'
  cmp -s "$manifest" <(LC_ALL=C sort -t $'\t' -k3,3 "$manifest") ||
    restore_die 'MANIFEST.txt is not sorted'
  : >"$seen"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "${#line}" -ge 67 ]] || restore_die 'SHA256SUMS entry is invalid'
    digest="${line:0:64}"
    separator="${line:64:2}"
    relative="${line:66}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ && "$separator" == '  ' ]] ||
      restore_die 'SHA256SUMS entry is invalid'
    safe_relative_path "$relative" || restore_die 'checksum path is unsafe'
    case "$relative" in
      database/sweet-memories.sqlite3|media/*) ;;
      *) restore_die 'checksum contains a forbidden path' ;;
    esac
    grep -Fxq "$relative" "$seen" && restore_die 'checksum contains duplicate paths'
    printf '%s\n' "$relative" >>"$seen"
    [[ -f "$restore_extracted/$relative" && ! -L "$restore_extracted/$relative" ]] ||
      restore_die 'checksum references a missing ordinary file'
    actual="$(sha256_file "$restore_extracted/$relative")"
    [[ "$actual" == "$digest" ]] || restore_die 'file checksum mismatch'
    size="$(file_size "$restore_extracted/$relative")"
    expected_manifest="$digest"$'\t'"$size"$'\t'"$relative"
    grep -Fqx "$expected_manifest" "$manifest" ||
      restore_die 'manifest does not match checksums and file sizes'
    sha_count=$((sha_count + 1))
  done <"$sha_file"

  while IFS=$'\t' read -r digest size relative extra || [[ -n "${digest:-}" ]]; do
    [[ -z "${extra:-}" && "$digest" =~ ^[0-9a-f]{64}$ && "$size" =~ ^[0-9]+$ ]] ||
      restore_die 'manifest entry is invalid'
    safe_relative_path "$relative" || restore_die 'manifest path is unsafe'
    [[ -f "$restore_extracted/$relative" && ! -L "$restore_extracted/$relative" ]] ||
      restore_die 'manifest references a missing ordinary file'
    [[ "$(file_size "$restore_extracted/$relative")" == "$size" &&
      "$(sha256_file "$restore_extracted/$relative")" == "$digest" ]] ||
      restore_die 'manifest entry does not match restored data'
    manifest_count=$((manifest_count + 1))
  done <"$manifest"
  actual_count="$(find "$restore_extracted/database" "$restore_extracted/media" -type f | wc -l | tr -d ' ')"
  [[ "$sha_count" -eq "$manifest_count" && "$sha_count" -eq "$actual_count" ]] ||
    restore_die 'manifest does not cover every restored data file'
}

validate_sqlite_and_media() {
  local database="$restore_extracted/database/sweet-memories.sqlite3"
  local database_uri="file:$database?mode=ro&immutable=1"
  local result schema_count photo_id relative asset_name extra
  local actual_refs="$restore_workspace/actual-media"
  local database_refs="$restore_workspace/database-media"

  result="$(sqlite3 -batch -noheader "$database_uri" 'PRAGMA quick_check;')" ||
    restore_die 'SQLite quick check failed'
  [[ "$result" == 'ok' ]] || restore_die 'SQLite quick check failed'
  result="$(sqlite3 -batch -noheader "$database_uri" 'PRAGMA integrity_check;')" ||
    restore_die 'SQLite integrity check failed'
  [[ "$result" == 'ok' ]] || restore_die 'SQLite integrity check failed'
  result="$(sqlite3 -batch -noheader "$database_uri" 'PRAGMA foreign_key_check;')" ||
    restore_die 'SQLite foreign key check failed'
  [[ -z "$result" ]] || restore_die 'SQLite foreign key check failed'
  schema_count="$(sqlite3 -batch -noheader "$database_uri" \
    "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('photos','photo_assets');")" ||
    restore_die 'SQLite schema check failed'
  [[ "$schema_count" == '2' ]] || restore_die 'SQLite schema check failed'
  schema_count="$(sqlite3 -batch -noheader "$database_uri" \
    "SELECT count(*) FROM pragma_table_info('photo_assets') WHERE name IN ('photo_id','relative_path');")" ||
    restore_die 'SQLite schema check failed'
  [[ "$schema_count" == '2' ]] || restore_die 'SQLite schema check failed'

  sqlite3 -batch -noheader -separator $'\t' "$database_uri" \
    'SELECT photo_id, relative_path FROM photo_assets ORDER BY relative_path;' >"$database_refs" ||
    restore_die 'could not read database media references'
  : >"$actual_refs"
  while IFS= read -r -d '' relative; do
    relative="${relative#"$restore_extracted/media/"}"
    safe_relative_path "$relative" || restore_die 'database media path is unsafe'
    printf '%s\n' "$relative" >>"$actual_refs"
  done < <(find "$restore_extracted/media" -type f -print0)
  LC_ALL=C sort -o "$actual_refs" "$actual_refs"
  while IFS=$'\t' read -r photo_id relative extra || [[ -n "${photo_id:-}" ]]; do
    [[ -z "${extra:-}" && -n "$photo_id" ]] ||
      restore_die 'database media reference is invalid'
    safe_path_segment "$photo_id" || restore_die 'database media path is unsafe'
    safe_relative_path "$relative" || restore_die 'database media path is unsafe'
    [[ "$relative" == "$photo_id/"* && "$relative" != "$photo_id/" ]] ||
      restore_die 'database media path does not match its photo ID'
    asset_name="${relative#"$photo_id/"}"
    safe_path_segment "$asset_name" || restore_die 'database media path is unsafe'
    [[ -f "$restore_extracted/media/$relative" &&
      ! -L "$restore_extracted/media/$relative" ]] ||
      restore_die 'database references missing media'
  done <"$database_refs"
  cut -f2 "$database_refs" >"$database_refs.paths"
  cmp -s "$database_refs.paths" "$actual_refs" ||
    restore_die 'database and media file sets do not match'
}

prepare_restore() {
  local action="$1"
  local archive="$2"

  create_restore_workspace "$action"
  copy_restore_inputs "$archive"
  validate_archive_listing
  extract_and_validate_tree
  validate_manifests
  validate_sqlite_and_media
}

tree_size_bytes() {
  local root="$1"
  local total=0 entry size

  while IFS= read -r -d '' entry; do
    size="$(file_size "$entry")"
    total=$((total + size))
  done < <(find "$root" -type f -print0)
  printf '%s\n' "$total"
}

ensure_apply_capacity() {
  local parent available_kb available_bytes required_bytes
  local current_bytes restored_bytes archive_bytes

  parent="$(dirname "$DATA_ROOT")"
  current_bytes="$(tree_size_bytes "$DATA_ROOT")"
  restored_bytes="$(tree_size_bytes "$restore_extracted/database")"
  restored_bytes=$((restored_bytes + $(tree_size_bytes "$restore_extracted/media")))
  archive_bytes="$(file_size "$restore_private_archive")"
  available_kb="$(df -Pk "$parent" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || restore_die 'could not determine free space'
  available_bytes=$((available_kb * 1024))
  required_bytes=$((current_bytes + restored_bytes + archive_bytes + RESERVE_BYTES))
  [[ "$available_bytes" -ge "$required_bytes" ]] ||
    restore_die "insufficient free space for restore: need $required_bytes bytes"
}

normalize_restored_permissions() {
  local root="$1"
  local deleting="$root/media/.deleting"

  mkdir -p "$root/media/.deleting" "$root/staging" "$root/backups" \
    "$root/backups/deploy" "$root/backups/manual"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$root"
  chmod 0750 "$root"
  chmod 0700 "$root/database" "$root/staging" "$root/backups" \
    "$root/backups/deploy" "$root/backups/manual"
  find "$root/database" -type f -exec chmod 0600 {} +
  find "$root/media" -type d -exec chmod 0750 {} +
  find "$root/media" -type f -exec chmod 0640 {} +
  if ! chmod 2750 "$root/media"; then
    [[ "$(uname -s)" != 'Linux' ]] && chmod 0750 "$root/media" || return 1
  fi
  [[ -d "$deleting" && ! -L "$deleting" ]] || return 1
  chmod 0700 "$deleting"
}

journal_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$RESTORE_JOURNAL"
}

write_journal() {
  local phase="$1"
  local parent temporary temporary_identity journal_existed=0

  parent="$(dirname "$RESTORE_JOURNAL")"
  [[ "$RESTORE_JOURNAL" == "$parent/.sweet-memories-restore.state" ]] ||
    restore_die 'restore journal path is unsafe'
  if [[ -e "$RESTORE_JOURNAL" || -L "$RESTORE_JOURNAL" ]]; then
    journal_existed=1
    ordinary_single_link "$RESTORE_JOURNAL" ||
      restore_die 'restore journal was replaced'
    [[ -n "$restore_journal_identity" &&
      "$(file_identity "$RESTORE_JOURNAL")" == "$restore_journal_identity" ]] ||
      restore_die 'restore journal identity changed'
  fi
  temporary="$(mktemp "$parent/.sweet-memories-journal.XXXXXX")" ||
    restore_die 'could not create restore journal'
  restore_journal_temporary="$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  temporary_identity="$(file_identity "$temporary")"
  restore_journal_temporary_identity="$temporary_identity"
  {
    printf 'phase=%s\n' "$phase"
    printf 'recovery=%s\n' "$(basename "$restore_recovery")"
    printf 'workspace=%s\n' "$(basename "$restore_workspace")"
    printf 'workspace_identity=%s\n' "$restore_workspace_identity"
    printf 'original_identity=%s\n' "$restore_original_identity"
    printf 'installed_identity=%s\n' "$restore_installed_identity"
  } >"$temporary"
  ordinary_single_link "$temporary" &&
    [[ "$(file_identity "$temporary")" == "$temporary_identity" ]] ||
    restore_die 'temporary restore journal identity changed'
  if [[ "$journal_existed" == '1' ]]; then
    mv -f "$temporary" "$RESTORE_JOURNAL" || restore_die 'could not publish restore journal'
  else
    restore_journal_identity="$temporary_identity"
    ln "$temporary" "$RESTORE_JOURNAL" || restore_die 'could not publish restore journal'
    [[ -f "$RESTORE_JOURNAL" && ! -L "$RESTORE_JOURNAL" &&
      "$(file_identity "$RESTORE_JOURNAL")" == "$temporary_identity" ]] ||
      restore_die 'published restore journal is unsafe'
    rm -f -- "$temporary"
    [[ "$(file_link_count "$RESTORE_JOURNAL")" == '1' ]] ||
      restore_die 'published restore journal has an unsafe link count'
  fi
  restore_journal_temporary=''
  restore_journal_temporary_identity=''
  restore_journal_identity="$(file_identity "$RESTORE_JOURNAL")"
  ordinary_single_link "$RESTORE_JOURNAL" || restore_die 'published restore journal is unsafe'
}

load_journal() {
  local phase recovery_name workspace_name workspace_identity
  local original_identity installed_identity parent

  ordinary_single_link "$RESTORE_JOURNAL" || restore_die 'restore journal is unsafe'
  [[ "$(wc -l <"$RESTORE_JOURNAL" | tr -d ' ')" == '6' ]] ||
    restore_die 'restore journal is invalid'
  restore_journal_identity="$(file_identity "$RESTORE_JOURNAL")"
  phase="$(journal_value phase)"
  recovery_name="$(journal_value recovery)"
  workspace_name="$(journal_value workspace)"
  workspace_identity="$(journal_value workspace_identity)"
  original_identity="$(journal_value original_identity)"
  installed_identity="$(journal_value installed_identity)"
  [[ "$phase" == 'prepared' || "$phase" == 'old_moved' ||
    "$phase" == 'new_installed' || "$phase" == 'committed' ]] ||
    restore_die 'restore journal phase is invalid'
  [[ "$recovery_name" =~ ^sweet-memories-recovery-[0-9]{8}T[0-9]{6}Z$ &&
    "$workspace_name" == .sweet-memories-restore.* &&
    "$workspace_identity" =~ ^[0-9]+:[0-9]+$ &&
    "$original_identity" =~ ^[0-9]+:[0-9]+$ &&
    "$installed_identity" =~ ^[0-9]+:[0-9]+$ ]] ||
    restore_die 'restore journal content is invalid'
  parent="$(dirname "$DATA_ROOT")"
  restore_recovery="$parent/$recovery_name"
  restore_workspace="$parent/$workspace_name"
  restore_original_identity="$original_identity"
  restore_installed_identity="$installed_identity"
  if [[ -d "$restore_workspace" && ! -L "$restore_workspace" &&
    "$(file_identity "$restore_workspace")" == "$workspace_identity" ]]; then
    restore_workspace_identity="$workspace_identity"
  else
    restore_workspace=''
    restore_workspace_identity=''
  fi
  restore_journal_phase="$phase"
}

rollback_from_journal() {
  local data_identity=''
  local failed_root

  load_journal || return 1
  if [[ "$restore_journal_phase" == 'committed' ]]; then
    remove_owned_journal
    cleanup_restore_workspace
    return 0
  fi
  systemctl stop "$SERVICE_NAME" || return 1
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    return 1
  fi
  restore_service_stopped=1
  if [[ -e "$restore_recovery" || -L "$restore_recovery" ]]; then
    [[ -d "$restore_recovery" && ! -L "$restore_recovery" &&
      "$(file_identity "$restore_recovery")" == "$restore_original_identity" ]] || return 1
    if [[ -e "$DATA_ROOT" || -L "$DATA_ROOT" ]]; then
      [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" ]] || return 1
      data_identity="$(file_identity "$DATA_ROOT")"
      [[ "$data_identity" == "$restore_installed_identity" ]] || return 1
      if [[ -n "$restore_workspace" ]]; then
        failed_root="$restore_workspace/interrupted-restored-data"
      else
        restore_workspace="$(mktemp -d "$(dirname "$DATA_ROOT")/.sweet-memories-restore.XXXXXX")" ||
          return 1
        chmod 0700 "$restore_workspace"
        chown root:root "$restore_workspace"
        restore_workspace_identity="$(file_identity "$restore_workspace")"
        failed_root="$restore_workspace/interrupted-restored-data"
      fi
      [[ ! -e "$failed_root" && ! -L "$failed_root" ]] || return 1
      mv "$DATA_ROOT" "$failed_root" || return 1
    fi
    chown "$SERVICE_USER:$SERVICE_GROUP" "$restore_recovery" || return 1
    chmod 0750 "$restore_recovery" || return 1
    mv "$restore_recovery" "$DATA_ROOT" || return 1
    [[ "$(file_identity "$DATA_ROOT")" == "$restore_original_identity" ]] || return 1
  else
    [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" &&
      "$(file_identity "$DATA_ROOT")" == "$restore_original_identity" ]] || return 1
  fi
  if ! start_and_check_service; then
    return 1
  fi
  restore_service_stopped=0
  remove_owned_journal
  cleanup_restore_workspace
}

restore_exit_handler() {
  local status=$?
  local compensation_failed=0

  [[ "$restore_trap_active" == '1' ]] || return "$status"
  restore_trap_active=0
  trap - EXIT INT TERM
  if [[ "$restore_apply_started" == '1' && "$restore_completed" != '1' ]]; then
    if [[ -e "$RESTORE_JOURNAL" || -L "$RESTORE_JOURNAL" ]]; then
      if ! ordinary_single_link "$RESTORE_JOURNAL"; then
        printf 'data restore error: automatic compensation failed; journal retained for manual recovery\n' >&2
        compensation_failed=1
      elif ! rollback_from_journal; then
        printf 'data restore error: automatic compensation failed; journal retained for manual recovery\n' >&2
        compensation_failed=1
      fi
    elif [[ "$restore_service_stopped" == '1' ]]; then
      if ! start_and_check_service; then
        printf 'data restore error: could not restore API service health\n' >&2
        compensation_failed=1
      fi
    fi
  fi
  if [[ "$restore_completed" == '1' || "$restore_apply_started" != '1' ]]; then
    cleanup_restore_workspace
  fi
  remove_owned_journal_temporary
  if [[ "$restore_lock_held" == '1' ]]; then
    flock -u 9 || compensation_failed=1
    restore_lock_held=0
  fi
  if [[ "$status" -eq 0 && "$compensation_failed" -ne 0 ]]; then
    status=1
  fi
  exit "$status"
}

install_restore_traps() {
  restore_trap_active=1
  trap restore_exit_handler EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

recover_interrupted_restore() {
  [[ -e "$RESTORE_JOURNAL" || -L "$RESTORE_JOURNAL" ]] || return 0
  if ! rollback_from_journal; then
    restore_die 'interrupted restore compensation failed; journal retained for manual recovery'
  fi
  restore_completed=1
  restore_die 'recovered interrupted restore; rerun apply'
}

apply_restore() {
  local timestamp parent

  restore_apply_started=1
  [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" &&
    "$(canonical_directory "$DATA_ROOT")" == "$DATA_ROOT" ]] ||
    restore_die 'production data root is unsafe'
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  [[ "$timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || restore_die 'UTC timestamp is invalid'
  parent="$(dirname "$DATA_ROOT")"
  restore_recovery="$parent/sweet-memories-recovery-$timestamp"
  [[ ! -e "$restore_recovery" && ! -L "$restore_recovery" ]] ||
    restore_die 'recovery bundle already exists'
  ensure_apply_capacity
  stop_service
  restore_original_identity="$(file_identity "$DATA_ROOT")"
  normalize_restored_permissions "$restore_extracted"
  restore_installed_identity="$(file_identity "$restore_extracted")"

  write_journal prepared
  mv "$DATA_ROOT" "$restore_recovery" || restore_die 'could not move current data to recovery'
  restore_recovery_identity="$(file_identity "$restore_recovery")"
  [[ "$restore_recovery_identity" == "$restore_original_identity" ]] ||
    restore_die 'recovery bundle identity changed'
  chown root:root "$restore_recovery"
  chmod 0700 "$restore_recovery"
  write_journal old_moved

  mv "$restore_extracted" "$DATA_ROOT" || restore_die 'could not install restored data'
  [[ "$(file_identity "$DATA_ROOT")" == "$restore_installed_identity" ]] ||
    restore_die 'installed restored data identity changed'
  restore_extracted=''
  write_journal new_installed

  if ! systemctl start "$SERVICE_NAME"; then
    restore_die 'restored service could not start'
  fi
  restore_service_stopped=0
  if ! health_check; then
    restore_die 'restored service health check failed'
  fi
  write_journal committed
  remove_owned_journal
  restore_completed=1
  cleanup_restore_workspace
  printf 'restored data; recovery bundle retained at: %s\n' "$restore_recovery"
}

restore_data() {
  local action archive

  [[ "$#" -eq 2 ]] ||
    restore_die 'usage: restore-data.sh verify|apply /absolute/path/to/sweet-memories-data-*.tar.gz'
  action="$1"
  archive="$2"
  [[ "$action" == 'verify' || "$action" == 'apply' ]] ||
    restore_die 'restore mode must be verify or apply'
  install_restore_traps
  require_root
  validate_tools
  if [[ "$action" == 'apply' ]]; then
    acquire_restore_lock
    recover_interrupted_restore
  fi
  prepare_restore "$action" "$archive"
  if [[ "$action" == 'verify' ]]; then
    restore_completed=1
    printf 'verified data archive: %s\n' "$archive"
    return 0
  fi
  apply_restore
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  restore_data "$@"
fi
