#!/usr/bin/env bash
set -Eeuo pipefail

DATA_ROOT=/var/lib/sweet-memories
SERVICE_NAME=sweet-memories-api.service
SERVICE_USER=sweet-memories
SERVICE_GROUP=sweet-memories-media
HEALTH_URL=http://127.0.0.1:3100/api/health
LOCK_FILE=/run/lock/sweet-memories-api-release.lock
RESTORE_JOURNAL=/var/lib/.sweet-memories-restore
RESERVE_BYTES=1073741824
MAX_ARCHIVE_BYTES=68719476736
MAX_ARCHIVE_MEMBERS=200000
MAX_EXPANDED_BYTES=274877906944

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
restore_journal_metadata_identity=''
restore_service_was_active=1
restore_journal_source=''
restore_journal_source_inode=''
restore_declared_members=0
restore_declared_bytes=0

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

canonical_uuid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]
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

valid_journal_entry_name() {
  case "$1" in
    metadata|prepared|service-stopped|old-moved|new-installed|healthy|committed) return 0 ;;
    *) return 1 ;;
  esac
}

journal_directory_owned() {
  [[ -n "$restore_journal_identity" ]] &&
    directory_is_owned "$RESTORE_JOURNAL" "$restore_journal_identity"
}

journal_entry_content_valid() {
  local entry="$1"
  local name value

  name="$(basename "$entry")"
  ordinary_single_link "$entry" || return 1
  if [[ "$name" == 'metadata' ]]; then
    [[ "$(wc -l <"$entry" | tr -d ' ')" == '7' &&
      "$(sed -n 's/^journal_identity=//p' "$entry")" == "$restore_journal_identity" ]] ||
      return 1
    [[ -z "$restore_journal_metadata_identity" ||
      "$(file_identity "$entry")" == "$restore_journal_metadata_identity" ]]
    return
  fi
  value="$(cat "$entry")"
  [[ "$value" == "$name"$'\t'"$restore_journal_identity" ]]
}

remove_owned_journal() {
  local entry identity

  [[ -n "$restore_journal_identity" ]] || return 0
  journal_directory_owned || return 1
  while IFS= read -r entry; do
    valid_journal_entry_name "$(basename "$entry")" || return 1
    journal_entry_content_valid "$entry" || return 1
  done < <(find "$RESTORE_JOURNAL" -mindepth 1 -maxdepth 1 -print)
  while IFS= read -r entry; do
    identity="$(file_identity "$entry")"
    journal_directory_owned && journal_entry_content_valid "$entry" &&
      [[ "$(file_identity "$entry")" == "$identity" ]] || return 1
    rm -f -- "$entry" || return 1
  done < <(find "$RESTORE_JOURNAL" -mindepth 1 -maxdepth 1 -type f -print)
  journal_directory_owned || return 1
  rmdir "$RESTORE_JOURNAL" || return 1
  restore_journal_identity=''
  restore_journal_metadata_identity=''
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
  local basename expected recorded line actual archive_size sidecar_size

  basename="$(basename "$archive")"
  [[ "$basename" =~ ^sweet-memories-data-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] ||
    restore_die 'archive basename is invalid'
  [[ -e "$sidecar" || -L "$sidecar" ]] || restore_die 'archive checksum sidecar is missing'
  archive_size="$(file_size "$archive")"
  sidecar_size="$(file_size "$sidecar")"
  [[ "$archive_size" =~ ^[0-9]+$ && "$archive_size" -le "$MAX_ARCHIVE_BYTES" ]] ||
    restore_die 'archive exceeds maximum size'
  [[ "$sidecar_size" =~ ^[0-9]+$ && "$sidecar_size" -le 4096 ]] ||
    restore_die 'archive checksum sidecar is too large'
  ensure_filesystem_capacity "$restore_workspace" $((archive_size + sidecar_size + RESERVE_BYTES)) \
    'insufficient free space before archive extraction'
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
  local header_listing="$restore_workspace/header-listing"
  local entry type member normalized size previous_bytes pipeline_status
  local tar_status filter_status verbose_count name_count

  set +e
  LC_ALL=C tar -tvPzf "$restore_private_archive" |
    awk -v maximum="$MAX_ARCHIVE_MEMBERS" 'NR > maximum { exit 42 } { print }' >"$type_listing"
  pipeline_status="${PIPESTATUS[*]}"
  set -e
  set -- $pipeline_status
  tar_status="$1"
  filter_status="$2"
  [[ "$filter_status" != '42' ]] || restore_die 'archive member limit exceeded'
  [[ "$tar_status" == '0' && "$filter_status" == '0' ]] ||
    restore_die 'archive could not be listed'
  : >"$header_listing"
  restore_declared_bytes=0
  verbose_count=0
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    verbose_count=$((verbose_count + 1))
    type="${entry:0:1}"
    [[ "$type" == '-' || "$type" == 'd' ]] ||
      restore_die 'archive contains a non-ordinary entry'
    set -f
    set -- $entry
    set +f
    if [[ "${2:-}" =~ ^[0-9]+$ && "${5:-}" =~ ^[0-9]+$ ]]; then
      size="$5"
    elif [[ "${3:-}" =~ ^[0-9]+$ ]]; then
      size="$3"
    else
      restore_die 'archive entry size is invalid'
    fi
    member="${!#}"
    normalized="$(normalize_archive_member "$member")"
    [[ -n "$normalized" ]] || continue
    printf '%s\t%s\t%s\n' "$type" "$size" "$normalized" >>"$header_listing"
    if [[ "$type" == '-' ]]; then
      [[ "$size" -le "$MAX_EXPANDED_BYTES" ]] ||
        restore_die 'declared archive size exceeds maximum'
      previous_bytes="$restore_declared_bytes"
      restore_declared_bytes=$((restore_declared_bytes + size))
      [[ "$restore_declared_bytes" -ge "$previous_bytes" &&
        "$restore_declared_bytes" -le "$MAX_EXPANDED_BYTES" ]] ||
        restore_die 'declared archive size exceeds maximum'
    fi
  done <"$type_listing"

  set +e
  LC_ALL=C tar -tPzf "$restore_private_archive" |
    awk -v maximum="$MAX_ARCHIVE_MEMBERS" 'NR > maximum { exit 42 } { print }' >"$name_listing"
  pipeline_status="${PIPESTATUS[*]}"
  set -e
  set -- $pipeline_status
  tar_status="$1"
  filter_status="$2"
  [[ "$filter_status" != '42' ]] || restore_die 'archive member limit exceeded'
  [[ "$tar_status" == '0' && "$filter_status" == '0' ]] ||
    restore_die 'archive could not be listed'
  : >"$normalized_listing"
  name_count=0
  while IFS= read -r member; do
    normalized="$(normalize_archive_member "$member")"
    [[ -n "$normalized" ]] || continue
    safe_relative_path "$normalized" || restore_die 'unsafe archive path'
    allowed_archive_member "$normalized" || restore_die 'archive contains a forbidden path'
    printf '%s\n' "$normalized" >>"$normalized_listing"
    name_count=$((name_count + 1))
  done <"$name_listing"
  restore_declared_members="$name_count"
  [[ "$name_count" -eq "$verbose_count" && "$name_count" -le "$MAX_ARCHIVE_MEMBERS" ]] ||
    restore_die 'archive listings do not agree'
  cmp -s <(cut -f3 "$header_listing") "$normalized_listing" ||
    restore_die 'archive listings do not agree'
  [[ -z "$(LC_ALL=C sort "$normalized_listing" | uniq -d)" ]] ||
    restore_die 'archive contains duplicate paths'
  for member in database database/sweet-memories.sqlite3 media SHA256SUMS MANIFEST.txt; do
    grep -Fxq "$member" "$normalized_listing" || restore_die "archive is missing $member"
  done
}

ensure_filesystem_capacity() {
  local path="$1"
  local required_bytes="$2"
  local message="$3"
  local available_kb available_bytes

  available_kb="$(df -Pk "$path" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || restore_die 'could not determine free space'
  available_bytes=$((available_kb * 1024))
  [[ "$available_bytes" -ge "$required_bytes" ]] || restore_die "$message: need $required_bytes bytes"
}

ensure_extraction_capacity() {
  local action="$1"
  local required_bytes archive_bytes current_bytes=0

  archive_bytes="$(file_size "$restore_private_archive")"
  if [[ "$action" == 'apply' ]]; then
    [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" &&
      "$(canonical_directory "$DATA_ROOT")" == "$DATA_ROOT" ]] ||
      restore_die 'production data root is unsafe'
    current_bytes="$(tree_size_bytes "$DATA_ROOT")"
  fi
  required_bytes=$((current_bytes + archive_bytes + restore_declared_bytes + RESERVE_BYTES))
  ensure_filesystem_capacity "$restore_workspace" "$required_bytes" \
    'insufficient free space before archive extraction'
}

extract_and_validate_tree() {
  local entry relative top unsupported actual_members actual_bytes header_size

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
  actual_members="$(find "$restore_extracted" -mindepth 1 -print | wc -l | tr -d ' ')"
  actual_bytes="$(tree_size_bytes "$restore_extracted")"
  [[ "$actual_members" -eq "$restore_declared_members" &&
    "$actual_bytes" -eq "$restore_declared_bytes" ]] ||
    restore_die 'extracted archive does not match declared size'
  while IFS=$'\t' read -r type header_size relative; do
    [[ "$type" == '-' ]] || continue
    [[ -f "$restore_extracted/$relative" && ! -L "$restore_extracted/$relative" &&
      "$(file_link_count "$restore_extracted/$relative")" == '1' &&
      "$(file_size "$restore_extracted/$relative")" == "$header_size" ]] ||
      restore_die 'extracted archive does not match declared size'
  done <"$restore_workspace/header-listing"
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

validate_sqlite_schema_contract() {
  local database="$1"
  local migration version applied_at extra objects columns setting

  migration="$(sqlite3 -batch -noheader -separator $'\t' "$database" \
    'SELECT version, applied_at FROM schema_migrations ORDER BY version;')" || return 1
  IFS=$'\t' read -r version applied_at extra <<<"$migration"
  [[ -z "${extra:-}" && "$version" == '001' &&
    "$applied_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ &&
    "$(printf '%s\n' "$migration" | wc -l | tr -d ' ')" == '1' ]] || return 1
  objects="$(sqlite3 -batch -noheader "$database" \
    "SELECT type || ':' || name FROM sqlite_schema
     WHERE (type='table' AND name IN
       ('schema_migrations','admins','sessions','login_attempts','settings','photos','photo_assets'))
        OR (type='index' AND name IN ('sessions_admin_id_idx','photos_public_order_idx'))
     ORDER BY type, name;")" || return 1
  [[ "$objects" == $'index:photos_public_order_idx\nindex:sessions_admin_id_idx\ntable:admins\ntable:login_attempts\ntable:photo_assets\ntable:photos\ntable:schema_migrations\ntable:sessions\ntable:settings' ]] || return 1
  while IFS='|' read -r table expected; do
    columns="$(sqlite3 -batch -noheader "$database" \
      "SELECT group_concat(name, ',') FROM
       (SELECT name FROM pragma_table_info('$table') ORDER BY cid);")" || return 1
    [[ "$columns" == "$expected" ]] || return 1
  done <<'SCHEMA_COLUMNS'
schema_migrations|version,applied_at
admins|id,username,password_hash,created_at,updated_at
sessions|token_hash,admin_id,csrf_hash,created_at,last_activity_at,absolute_expires_at
login_attempts|ip,failure_count,blocked_until,updated_at
settings|key,value,updated_at
photos|id,title,description,captured_date,status,rotation,offset_x,offset_y,request_id,version,created_at,updated_at
photo_assets|photo_id,kind,format,width,height,relative_path
SCHEMA_COLUMNS
  setting="$(sqlite3 -batch -noheader -separator $'\t' "$database" \
    "SELECT value, updated_at FROM settings WHERE key='uploads_enabled';")" || return 1
  IFS=$'\t' read -r version applied_at extra <<<"$setting"
  [[ -z "${extra:-}" && ( "$version" == 'true' || "$version" == 'false' ) &&
    "$applied_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ &&
    "$(printf '%s\n' "$setting" | wc -l | tr -d ' ')" == '1' ]]
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
  local result photo_id relative asset_name extra
  local actual_refs="$restore_workspace/actual-media"
  local database_refs="$restore_workspace/database-media"
  local photo_ids="$restore_workspace/photo-ids"

  result="$(sqlite3 -batch -noheader "$database_uri" 'PRAGMA quick_check;')" ||
    restore_die 'SQLite quick check failed'
  [[ "$result" == 'ok' ]] || restore_die 'SQLite quick check failed'
  result="$(sqlite3 -batch -noheader "$database_uri" 'PRAGMA integrity_check;')" ||
    restore_die 'SQLite integrity check failed'
  [[ "$result" == 'ok' ]] || restore_die 'SQLite integrity check failed'
  result="$(sqlite3 -batch -noheader "$database_uri" 'PRAGMA foreign_key_check;')" ||
    restore_die 'SQLite foreign key check failed'
  [[ -z "$result" ]] || restore_die 'SQLite foreign key check failed'
  validate_sqlite_schema_contract "$database_uri" ||
    restore_die 'SQLite schema contract failed'

  sqlite3 -batch -noheader "$database_uri" 'SELECT id FROM photos ORDER BY id;' >"$photo_ids" ||
    restore_die 'could not read database photo IDs'
  while IFS= read -r photo_id || [[ -n "$photo_id" ]]; do
    canonical_uuid "$photo_id" || restore_die 'database photo ID is not a canonical UUID'
  done <"$photo_ids"

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
    canonical_uuid "$photo_id" || restore_die 'database photo ID is not a canonical UUID'
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
  ensure_extraction_capacity "$action"
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
  sed -n "s/^${key}=//p" "$RESTORE_JOURNAL/metadata"
}

journal_before_stage_publish() {
  :
}

open_private_journal_source() {
  local stage="$2"
  local attempt candidate

  directory_is_owned "$restore_workspace" "$restore_workspace_identity" ||
    restore_die 'restore workspace identity changed before journal write'
  umask 077
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    candidate="$restore_workspace/.journal-$stage.$$.$RANDOM"
    [[ ! -e "$candidate" && ! -L "$candidate" ]] || continue
    set -o noclobber
    if { exec 8>"$candidate"; } 2>/dev/null; then
      set +o noclobber
      restore_journal_source="$candidate"
      restore_journal_source_inode="$(file_inode /dev/fd/8)"
      return 0
    fi
    set +o noclobber
  done
  restore_die 'could not create private restore journal source'
}

publish_journal_source() {
  local path="$1"
  local stage="$2"

  exec 8>&-
  ordinary_single_link "$restore_journal_source" &&
    [[ "$(file_inode "$restore_journal_source")" == "$restore_journal_source_inode" ]] ||
    restore_die 'private restore journal source identity changed'
  chmod 0600 "$restore_journal_source"
  journal_directory_owned || restore_die 'restore journal identity changed'
  [[ ! -e "$path" && ! -L "$path" ]] || restore_die 'restore journal stage already exists'
  journal_before_stage_publish "$path" "$stage"
  ln "$restore_journal_source" "$path" ||
    restore_die 'could not publish restore journal stage without clobbering'
  [[ -f "$path" && ! -L "$path" &&
    "$(file_inode "$path")" == "$restore_journal_source_inode" &&
    "$(file_link_count "$path")" == '2' ]] ||
    restore_die 'published restore journal stage identity changed'
  [[ -f "$restore_journal_source" && ! -L "$restore_journal_source" &&
    "$(file_inode "$restore_journal_source")" == "$restore_journal_source_inode" &&
    "$(file_link_count "$restore_journal_source")" == '2' ]] ||
    restore_die 'private restore journal source identity changed'
  rm -f -- "$restore_journal_source" || restore_die 'could not finalize restore journal stage'
  ordinary_single_link "$path" && [[ "$(file_inode "$path")" == "$restore_journal_source_inode" ]] ||
    restore_die 'finalized restore journal stage identity changed'
  restore_journal_source=''
  restore_journal_source_inode=''
}

create_journal() {
  local parent metadata

  parent="$(dirname "$RESTORE_JOURNAL")"
  [[ "$RESTORE_JOURNAL" == "$parent/.sweet-memories-restore" &&
    "$(canonical_directory "$parent")" == "$parent" ]] ||
    restore_die 'restore journal path is unsafe'
  [[ ! -e "$RESTORE_JOURNAL" && ! -L "$RESTORE_JOURNAL" ]] ||
    restore_die 'restore journal already exists'
  umask 077
  mkdir "$RESTORE_JOURNAL" || restore_die 'could not create restore journal transaction'
  chmod 0700 "$RESTORE_JOURNAL"
  chown root:root "$RESTORE_JOURNAL"
  restore_journal_identity="$(file_identity "$RESTORE_JOURNAL")"
  journal_directory_owned || restore_die 'restore journal transaction is unsafe'

  metadata="$RESTORE_JOURNAL/metadata"
  open_private_journal_source "$metadata" metadata
  {
    printf 'journal_identity=%s\n' "$restore_journal_identity"
    printf 'recovery=%s\n' "$(basename "$restore_recovery")"
    printf 'workspace=%s\n' "$(basename "$restore_workspace")"
    printf 'workspace_identity=%s\n' "$restore_workspace_identity"
    printf 'original_identity=%s\n' "$restore_original_identity"
    printf 'installed_identity=%s\n' "$restore_installed_identity"
    printf 'service_was_active=%s\n' "$restore_service_was_active"
  } >&8 || {
    exec 8>&-
    restore_die 'could not write restore journal metadata'
  }
  publish_journal_source "$metadata" metadata
  restore_journal_metadata_identity="$(file_identity "$metadata")"
}

write_journal_stage() {
  local stage="$1"
  local path="$RESTORE_JOURNAL/$stage"

  case "$stage" in
    prepared|service-stopped|old-moved|new-installed|healthy|committed) ;;
    *) restore_die 'restore journal stage is invalid' ;;
  esac
  open_private_journal_source "$path" "$stage"
  printf '%s\t%s\n' "$stage" "$restore_journal_identity" >&8 || {
    exec 8>&-
    restore_die 'could not write restore journal stage'
  }
  publish_journal_source "$path" "$stage"
  restore_journal_phase="$stage"
}

repair_interrupted_journal_link() {
  local path="$1"
  local stage="$2"
  local candidate matching='' matches=0 inode

  [[ "$(file_link_count "$path")" == '2' && -n "$restore_workspace" &&
    -n "$restore_workspace_identity" ]] || return 1
  inode="$(file_inode "$path")"
  while IFS= read -r candidate; do
    [[ -f "$candidate" && ! -L "$candidate" &&
      "$(file_inode "$candidate")" == "$inode" ]] || continue
    matching="$candidate"
    matches=$((matches + 1))
  done < <(find "$restore_workspace" -mindepth 1 -maxdepth 1 \
    -type f -name ".journal-$stage.*" -print)
  [[ "$matches" == '1' && "$(file_link_count "$matching")" == '2' ]] || return 1
  rm -f -- "$matching" || return 1
  ordinary_single_link "$path" && [[ "$(file_inode "$path")" == "$inode" ]]
}

load_journal() {
  local recovery_name workspace_name workspace_identity journal_identity
  local original_identity installed_identity service_was_active parent entry name
  local stage gap=0 value

  [[ -d "$RESTORE_JOURNAL" && ! -L "$RESTORE_JOURNAL" ]] ||
    restore_die 'restore journal is unsafe'
  restore_journal_identity="$(file_identity "$RESTORE_JOURNAL")"
  ordinary_single_link "$RESTORE_JOURNAL/metadata" || restore_die 'restore journal metadata is unsafe'
  [[ "$(wc -l <"$RESTORE_JOURNAL/metadata" | tr -d ' ')" == '7' ]] ||
    restore_die 'restore journal metadata is invalid'
  restore_journal_metadata_identity="$(file_identity "$RESTORE_JOURNAL/metadata")"
  journal_identity="$(journal_value journal_identity)"
  recovery_name="$(journal_value recovery)"
  workspace_name="$(journal_value workspace)"
  workspace_identity="$(journal_value workspace_identity)"
  original_identity="$(journal_value original_identity)"
  installed_identity="$(journal_value installed_identity)"
  service_was_active="$(journal_value service_was_active)"
  [[ "$journal_identity" == "$restore_journal_identity" &&
    "$recovery_name" =~ ^sweet-memories-recovery-[0-9]{8}T[0-9]{6}Z$ &&
    "$workspace_name" == .sweet-memories-restore.* &&
    "$workspace_identity" =~ ^[0-9]+:[0-9]+$ &&
    "$original_identity" =~ ^[0-9]+:[0-9]+$ &&
    "$installed_identity" =~ ^[0-9]+:[0-9]+$ &&
    ( "$service_was_active" == '0' || "$service_was_active" == '1' ) ]] ||
    restore_die 'restore journal content is invalid'
  parent="$(dirname "$DATA_ROOT")"
  restore_recovery="$parent/$recovery_name"
  restore_workspace="$parent/$workspace_name"
  restore_original_identity="$original_identity"
  restore_installed_identity="$installed_identity"
  restore_service_was_active="$service_was_active"
  if [[ -d "$restore_workspace" && ! -L "$restore_workspace" &&
    "$(file_identity "$restore_workspace")" == "$workspace_identity" ]]; then
    restore_workspace_identity="$workspace_identity"
  else
    restore_workspace=''
    restore_workspace_identity=''
  fi
  while IFS= read -r entry; do
    name="$(basename "$entry")"
    valid_journal_entry_name "$name" || restore_die 'restore journal contains an unexpected entry'
    [[ -f "$entry" && ! -L "$entry" &&
      ( "$(file_link_count "$entry")" == '1' || "$(file_link_count "$entry")" == '2' ) ]] ||
      restore_die 'restore journal entry is unsafe'
  done < <(find "$RESTORE_JOURNAL" -mindepth 1 -maxdepth 1 -print)
  restore_journal_phase=metadata
  for stage in prepared service-stopped old-moved new-installed healthy committed; do
    if [[ -e "$RESTORE_JOURNAL/$stage" || -L "$RESTORE_JOURNAL/$stage" ]]; then
      if [[ "$(file_link_count "$RESTORE_JOURNAL/$stage")" == '2' ]]; then
        repair_interrupted_journal_link "$RESTORE_JOURNAL/$stage" "$stage" ||
          restore_die 'restore journal stage has an unknown extra link'
      fi
      [[ "$gap" == '0' ]] && ordinary_single_link "$RESTORE_JOURNAL/$stage" ||
        restore_die 'restore journal stages are not a continuous prefix'
      value="$(cat "$RESTORE_JOURNAL/$stage")"
      [[ "$value" == "$stage"$'\t'"$restore_journal_identity" ]] ||
        restore_die 'restore journal stage content is invalid'
      restore_journal_phase="$stage"
    else
      gap=1
    fi
  done
}

rollback_known_restore() {
  local data_identity=''
  local failed_root

  if [[ "$restore_journal_phase" == 'committed' ]]; then
    [[ -d "$DATA_ROOT" && ! -L "$DATA_ROOT" &&
      "$(file_identity "$DATA_ROOT")" == "$restore_installed_identity" ]] || return 1
    remove_owned_journal || return 1
    cleanup_restore_workspace
    return 0
  fi
  if [[ -e "$restore_recovery" || -L "$restore_recovery" ]]; then
    [[ -d "$restore_recovery" && ! -L "$restore_recovery" &&
      "$(file_identity "$restore_recovery")" == "$restore_original_identity" ]] || return 1
    systemctl stop "$SERVICE_NAME" || return 1
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      return 1
    fi
    restore_service_stopped=1
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
  if [[ "$restore_service_was_active" == '1' ]]; then
    if ! systemctl is-active --quiet "$SERVICE_NAME"; then
      start_and_check_service || return 1
    fi
    restore_service_stopped=0
  elif systemctl is-active --quiet "$SERVICE_NAME"; then
    systemctl stop "$SERVICE_NAME" || return 1
    systemctl is-active --quiet "$SERVICE_NAME" && return 1
  fi
  remove_owned_journal || return 1
  cleanup_restore_workspace
}

rollback_from_journal() {
  load_journal || return 1
  rollback_known_restore
}

restore_exit_handler() {
  local status=$?
  local compensation_failed=0

  [[ "$restore_trap_active" == '1' ]] || return "$status"
  restore_trap_active=0
  trap - EXIT INT TERM
  if [[ "$restore_apply_started" == '1' && "$restore_completed" != '1' ]]; then
    if [[ -e "$RESTORE_JOURNAL" || -L "$RESTORE_JOURNAL" ]]; then
      if [[ ! -d "$RESTORE_JOURNAL" || -L "$RESTORE_JOURNAL" ]]; then
        printf 'data restore error: automatic compensation failed; journal retained for manual recovery\n' >&2
        compensation_failed=1
      elif ! rollback_known_restore; then
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
  restore_original_identity="$(file_identity "$DATA_ROOT")"
  normalize_restored_permissions "$restore_extracted"
  restore_installed_identity="$(file_identity "$restore_extracted")"
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    restore_service_was_active=1
  else
    restore_service_was_active=0
  fi

  create_journal
  write_journal_stage prepared
  stop_service
  write_journal_stage service-stopped
  mv "$DATA_ROOT" "$restore_recovery" || restore_die 'could not move current data to recovery'
  restore_recovery_identity="$(file_identity "$restore_recovery")"
  [[ "$restore_recovery_identity" == "$restore_original_identity" ]] ||
    restore_die 'recovery bundle identity changed'
  chown root:root "$restore_recovery"
  chmod 0700 "$restore_recovery"
  write_journal_stage old-moved

  mv "$restore_extracted" "$DATA_ROOT" || restore_die 'could not install restored data'
  [[ "$(file_identity "$DATA_ROOT")" == "$restore_installed_identity" ]] ||
    restore_die 'installed restored data identity changed'
  restore_extracted=''
  write_journal_stage new-installed

  if ! systemctl start "$SERVICE_NAME"; then
    restore_die 'restored service could not start'
  fi
  restore_service_stopped=0
  if ! health_check; then
    restore_die 'restored service health check failed'
  fi
  write_journal_stage healthy
  write_journal_stage committed
  remove_owned_journal || restore_die 'could not remove completed restore journal'
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
