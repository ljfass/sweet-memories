#!/usr/bin/env bash
set -Eeuo pipefail

DATA_ROOT=/var/lib/sweet-memories
SERVICE_NAME=sweet-memories-api.service
HEALTH_URL=http://127.0.0.1:3100/api/health
LOCK_FILE=/run/lock/sweet-memories-api-release.lock
RESERVE_BYTES=1073741824
SCHEMA_FINGERPRINT_001=f2492449ec523816a42e63bbfe87a023d10d1361096ebba7d718f4402297e14c

backup_workspace=''
backup_workspace_identity=''
backup_temporary_archive=''
backup_temporary_sidecar=''
backup_published_archive=''
backup_published_sidecar=''
backup_archive_identity=''
backup_sidecar_identity=''
backup_completed=0
backup_lock_held=0
backup_trap_active=0

backup_die() {
  printf 'data backup error: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || backup_die 'must run as root'
}

validate_tools() {
  command -v sqlite3 >/dev/null 2>&1 || backup_die 'sqlite3 is required'
  command -v flock >/dev/null 2>&1 || backup_die 'flock is required'
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    backup_die 'a SHA-256 tool is required'
  fi
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

sha256_open_file() {
  local path="$1"
  local identity="$2"
  local descriptor_inode digest

  exec 7<"$path" || return 1
  descriptor_inode="$(file_inode /dev/fd/7)" || {
    exec 7<&-
    return 1
  }
  [[ "$descriptor_inode" == "${identity#*:}" &&
    "$(file_identity "$path")" == "$identity" ]] || {
    exec 7<&-
    return 1
  }
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(sha256sum <&7 | awk '{print $1}')"
  else
    digest="$(shasum -a 256 <&7 | awk '{print $1}')"
  fi
  exec 7<&-
  [[ "$digest" =~ ^[0-9a-f]{64}$ && -f "$path" && ! -L "$path" &&
    "$(file_identity "$path")" == "$identity" ]] || return 1
  printf '%s\n' "$digest"
}

is_owned_ordinary_file() {
  local path="$1"
  local identity="$2"

  [[ -f "$path" && ! -L "$path" && "$(file_link_count "$path")" == '1' &&
    "$(file_identity "$path")" == "$identity" ]]
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

validate_data_sources() {
  local database="$DATA_ROOT/database/sweet-memories.sqlite3"
  local unsupported entry relative

  [[ "$(canonical_directory "$DATA_ROOT")" == "$DATA_ROOT" ]] ||
    backup_die 'data root is not a safe ordinary directory'
  [[ "$(canonical_directory "$DATA_ROOT/database")" == "$DATA_ROOT/database" ]] ||
    backup_die 'database directory is not safe'
  [[ "$(canonical_directory "$DATA_ROOT/media")" == "$DATA_ROOT/media" ]] ||
    backup_die 'media directory is not safe'
  [[ -f "$database" && ! -L "$database" ]] ||
    backup_die 'production database is not an ordinary file'
  [[ "$(file_link_count "$database")" == '1' ]] ||
    backup_die 'hard-linked data file is not allowed'

  if [[ -e "$DATA_ROOT/media/.deleting" || -L "$DATA_ROOT/media/.deleting" ]]; then
    [[ -d "$DATA_ROOT/media/.deleting" && ! -L "$DATA_ROOT/media/.deleting" ]] ||
      backup_die 'unsupported data entry: media/.deleting'
    [[ -z "$(find "$DATA_ROOT/media/.deleting" -mindepth 1 -print -quit)" ]] ||
      backup_die 'media deleting area is not empty'
  fi

  unsupported="$(find "$DATA_ROOT/media" ! -type f ! -type d -print -quit)"
  [[ -z "$unsupported" ]] || backup_die "unsupported data entry: $unsupported"
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    relative="${entry#"$DATA_ROOT/media/"}"
    safe_relative_path "$relative" || backup_die 'unsupported data path'
    [[ "$(file_link_count "$entry")" == '1' ]] ||
      backup_die 'hard-linked data file is not allowed'
  done < <(find "$DATA_ROOT/media" -type f -print)
}

data_size_bytes() {
  local total entry size

  total="$(file_size "$DATA_ROOT/database/sweet-memories.sqlite3")"
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    size="$(file_size "$entry")"
    total=$((total + size))
  done < <(find "$DATA_ROOT/media" -type f -print)
  printf '%s\n' "$total"
}

ensure_capacity() {
  local target="$1"
  local data_bytes available_kb available_bytes required_bytes

  data_bytes="$(data_size_bytes)"
  available_kb="$(df -Pk "$target" | awk 'NR == 2 { print $4 }')"
  [[ "$available_kb" =~ ^[0-9]+$ ]] || backup_die 'could not determine free space'
  available_bytes=$((available_kb * 1024))
  required_bytes=$((data_bytes * 2 + RESERVE_BYTES))
  [[ "$available_bytes" -ge "$required_bytes" ]] ||
    backup_die "insufficient free space: need $required_bytes bytes"
}

acquire_backup_lock() {
  local parent

  [[ "$LOCK_FILE" == /* && ! -L "$LOCK_FILE" ]] || backup_die 'maintenance lock path is unsafe'
  parent="$(dirname "$LOCK_FILE")"
  [[ "$(canonical_directory "$parent")" == "$parent" ]] ||
    backup_die 'maintenance lock directory is unsafe'
  umask 077
  exec 9>>"$LOCK_FILE"
  chown root:root "$LOCK_FILE"
  chmod 0600 "$LOCK_FILE"
  flock -x 9 || backup_die 'could not acquire maintenance lock'
  backup_lock_held=1
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

cleanup_backup_workspace() {
  [[ -n "$backup_workspace" && -n "$backup_workspace_identity" ]] || return 0
  case "$backup_workspace" in
    */.sweet-memories-backup.*)
      if [[ -d "$backup_workspace" && ! -L "$backup_workspace" &&
        "$(file_identity "$backup_workspace")" == "$backup_workspace_identity" ]]; then
        rm -rf -- "$backup_workspace"
      fi
      ;;
  esac
  backup_workspace=''
  backup_workspace_identity=''
}

backup_exit_handler() {
  local status=$?
  local recovery_status=0

  [[ "$backup_trap_active" == '1' ]] || return "$status"
  backup_trap_active=0
  trap - EXIT INT TERM
  if [[ "$backup_completed" != '1' ]]; then
    if [[ -n "$backup_published_archive" &&
      ( -e "$backup_published_archive" || -L "$backup_published_archive" ) ]]; then
      if [[ -n "$backup_published_sidecar" &&
        ( -e "$backup_published_sidecar" || -L "$backup_published_sidecar" ) ]]; then
        printf 'data backup error: incomplete backup transaction retained for manual recovery: %s\n' \
          "$backup_published_archive" >&2
      else
        printf 'data backup error: incomplete archive retained for manual recovery: %s\n' \
          "$backup_published_archive" >&2
      fi
    fi
  fi
  cleanup_backup_workspace
  if ! systemctl start "$SERVICE_NAME"; then
    printf 'data backup error: could not start API service\n' >&2
    recovery_status=1
  elif ! health_check; then
    printf 'data backup error: API service failed loopback health check\n' >&2
    recovery_status=1
  fi
  if [[ "$backup_lock_held" == '1' ]]; then
    flock -u 9 || recovery_status=1
    backup_lock_held=0
  fi
  if [[ "$status" -eq 0 && "$recovery_status" -ne 0 ]]; then
    status="$recovery_status"
  fi
  exit "$status"
}

install_backup_traps() {
  backup_trap_active=1
  trap backup_exit_handler EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

validate_target() {
  local target="$1"
  local backup_root="$DATA_ROOT/backups"
  local canonical

  [[ "$target" == /* ]] || backup_die 'backup target must be absolute'
  [[ "$(canonical_directory "$backup_root")" == "$backup_root" ]] ||
    backup_die 'backup root is not a safe ordinary directory'
  canonical="$(canonical_directory "$target")" ||
    backup_die 'backup target is not a safe ordinary directory'
  [[ "$canonical" == "$target" && "$target" == "$backup_root/"* ]] ||
    backup_die 'backup target must be inside the fixed backup root'
}

sqlite_integrity_check() {
  local database="$1"
  local result

  result="$(sqlite3 -batch -noheader "$database" 'PRAGMA integrity_check;')" || return 1
  [[ "$result" == 'ok' ]]
}

sqlite_schema_fingerprint() {
  local database="$1"
  local query

  query="SELECT type || '|' || hex(name) || '|' || hex(tbl_name) || '|' || hex(sql)
    FROM sqlite_schema
    WHERE type IN ('table','index','view','trigger') AND name NOT GLOB 'sqlite_*'
    ORDER BY type,name,tbl_name;"
  if command -v sha256sum >/dev/null 2>&1; then
    sqlite3 -batch -noheader "$database" "$query" | sha256sum | awk '{print $1}'
  else
    sqlite3 -batch -noheader "$database" "$query" | shasum -a 256 | awk '{print $1}'
  fi
}

validate_sqlite_schema_contract() {
  local database="$1"
  local migration version applied_at extra objects columns setting fingerprint

  migration="$(sqlite3 -batch -noheader -separator $'\t' "$database" \
    'SELECT version, applied_at FROM schema_migrations ORDER BY version;')" || return 1
  IFS=$'\t' read -r version applied_at extra <<<"$migration"
  [[ -z "${extra:-}" && "$version" == '001' &&
    "$applied_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ &&
    "$(printf '%s\n' "$migration" | wc -l | tr -d ' ')" == '1' ]] || return 1
  fingerprint="$(sqlite_schema_fingerprint "$database")" || return 1
  [[ "$fingerprint" == "$SCHEMA_FINGERPRINT_001" ]] || return 1

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

validate_sqlite_and_media() {
  local tree="$1"
  local database="$tree/database/sweet-memories.sqlite3"
  local result photo_id relative asset_name
  local database_refs="$tree/.database-media"
  local actual_refs="$tree/.actual-media"
  local photo_ids="$tree/.photo-ids"

  result="$(sqlite3 -batch -noheader "$database" 'PRAGMA quick_check;')" ||
    backup_die 'copied database failed SQLite quick check'
  [[ "$result" == 'ok' ]] || backup_die 'copied database failed SQLite quick check'
  sqlite_integrity_check "$database" ||
    backup_die 'copied database failed SQLite integrity check'
  result="$(sqlite3 -batch -noheader "$database" 'PRAGMA foreign_key_check;')" ||
    backup_die 'copied database failed SQLite foreign key check'
  [[ -z "$result" ]] || backup_die 'copied database failed SQLite foreign key check'
  if ! validate_sqlite_schema_contract "$database"; then
    printf 'data backup error: copied database failed schema contract\n' >&2
    backup_die 'copied database schema fingerprint is unsupported'
  fi

  sqlite3 -batch -noheader "$database" 'SELECT id FROM photos ORDER BY id;' >"$photo_ids" ||
    backup_die 'could not read copied database photo IDs'
  while IFS= read -r photo_id || [[ -n "$photo_id" ]]; do
    canonical_uuid "$photo_id" || backup_die 'database photo ID is not a canonical UUID'
  done <"$photo_ids"

  sqlite3 -batch -noheader -separator $'\t' "$database" \
    'SELECT photo_id, relative_path FROM photo_assets ORDER BY relative_path;' >"$database_refs" ||
    backup_die 'could not read copied database media references'
  : >"$actual_refs"
  while IFS= read -r -d '' relative; do
    relative="${relative#"$tree/media/"}"
    safe_relative_path "$relative" || backup_die 'copied media path is unsafe'
    printf '%s\n' "$relative" >>"$actual_refs"
  done < <(find "$tree/media" -type f -print0)
  LC_ALL=C sort -o "$actual_refs" "$actual_refs"
  while IFS=$'\t' read -r photo_id relative extra || [[ -n "${photo_id:-}" ]]; do
    [[ -z "${extra:-}" && -n "$photo_id" ]] || backup_die 'database media reference is invalid'
    canonical_uuid "$photo_id" || backup_die 'database photo ID is not a canonical UUID'
    safe_relative_path "$relative" || backup_die 'database media path is unsafe'
    [[ "$relative" == "$photo_id/"* && "$relative" != "$photo_id/" ]] ||
      backup_die 'database media path does not match its photo ID'
    asset_name="${relative#"$photo_id/"}"
    safe_path_segment "$asset_name" || backup_die 'database media path is unsafe'
    [[ -f "$tree/media/$relative" && ! -L "$tree/media/$relative" ]] ||
      backup_die 'database references missing media'
  done <"$database_refs"
  cut -f2 "$database_refs" >"$database_refs.paths"
  cmp -s "$database_refs.paths" "$actual_refs" ||
    backup_die 'database and media file sets do not match'
  rm -f -- "$database_refs" "$database_refs.paths" "$actual_refs" "$photo_ids"
  clear_sqlite_auxiliary "$database"
}

clear_sqlite_auxiliary() {
  local database="$1"
  local result auxiliary

  result="$(sqlite3 -batch -noheader "$database" 'PRAGMA wal_checkpoint(TRUNCATE);')" ||
    backup_die 'SQLite WAL checkpoint failed'
  [[ "$result" == '0|0|0' ]] || backup_die 'SQLite WAL checkpoint did not complete'
  if [[ -e "$database-wal" || -L "$database-wal" ]]; then
    [[ -f "$database-wal" && ! -L "$database-wal" &&
      "$(file_link_count "$database-wal")" == '1' && "$(file_size "$database-wal")" == '0' ]] ||
      backup_die 'SQLite still depends on WAL data after stop'
    rm -f -- "$database-wal"
  fi
  if [[ -e "$database-shm" || -L "$database-shm" ]]; then
    [[ -f "$database-shm" && ! -L "$database-shm" &&
      "$(file_link_count "$database-shm")" == '1' ]] ||
      backup_die 'SQLite SHM path is unsafe after stop'
    rm -f -- "$database-shm"
  fi
  [[ ! -e "$database-wal" && ! -L "$database-wal" &&
    ! -e "$database-shm" && ! -L "$database-shm" ]] ||
    backup_die 'SQLite auxiliary files could not be cleared after checkpoint'
}

checkpoint_database() {
  clear_sqlite_auxiliary "$DATA_ROOT/database/sweet-memories.sqlite3"
}

snapshot_source_files() {
  local output="$1"
  local entry relative

  : >"$output"
  entry="$DATA_ROOT/database/sweet-memories.sqlite3"
  printf '%s\t%s\t%s\n' "$(file_identity "$entry")" "$(file_size "$entry")" \
    'database/sweet-memories.sqlite3' >>"$output"
  while IFS= read -r -d '' entry; do
    relative="media/${entry#"$DATA_ROOT/media/"}"
    [[ "$relative" != 'media/.deleting/'* ]] || continue
    printf '%s\t%s\t%s\n' "$(file_identity "$entry")" "$(file_size "$entry")" \
      "$relative" >>"$output"
  done < <(find "$DATA_ROOT/media" -type f -print0)
  LC_ALL=C sort -t $'\t' -k3,3 -o "$output" "$output"
}

verify_source_snapshot() {
  local snapshot="$1"
  local identity size relative source destination extra

  while IFS=$'\t' read -r identity size relative extra; do
    [[ -z "${extra:-}" ]] || backup_die 'source identity snapshot is invalid'
    source="$DATA_ROOT/$relative"
    destination="$backup_workspace/data/$relative"
    [[ -f "$source" && ! -L "$source" && "$(file_link_count "$source")" == '1' &&
      "$(file_identity "$source")" == "$identity" && "$(file_size "$source")" == "$size" ]] ||
      backup_die 'data source identity changed during copy'
    [[ -f "$destination" && ! -L "$destination" &&
      "$(file_size "$destination")" == "$size" ]] ||
      backup_die 'copied data does not match source metadata'
  done <"$snapshot"
}

copy_media_without_deleting() {
  local destination="$1"
  local entry

  while IFS= read -r -d '' entry; do
    [[ "$(basename "$entry")" == '.deleting' ]] && continue
    cp -a "$entry" "$destination/" || backup_die 'media copy failed'
  done < <(find "$DATA_ROOT/media" -mindepth 1 -maxdepth 1 -print0)
}

write_manifests() {
  local tree="$1"
  local sha_unsorted="$tree/.SHA256SUMS.unsorted"
  local manifest_unsorted="$tree/.MANIFEST.unsorted"
  local entry relative size digest

  : >"$sha_unsorted"
  : >"$manifest_unsorted"
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    relative="${entry#"$tree/"}"
    safe_relative_path "$relative" || backup_die 'unsupported staged data path'
    size="$(file_size "$entry")"
    digest="$(sha256_file "$entry")"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || backup_die 'could not hash staged data'
    printf '%s  %s\n' "$digest" "$relative" >>"$sha_unsorted"
    printf '%s\t%s\t%s\n' "$digest" "$size" "$relative" >>"$manifest_unsorted"
  done < <(find "$tree/database" "$tree/media" -type f -print | LC_ALL=C sort)
  LC_ALL=C sort -k2,2 "$sha_unsorted" >"$tree/SHA256SUMS"
  LC_ALL=C sort -t $'\t' -k3,3 "$manifest_unsorted" >"$tree/MANIFEST.txt"
  rm -f -- "$sha_unsorted" "$manifest_unsorted"
  chmod 0600 "$tree/SHA256SUMS" "$tree/MANIFEST.txt"
}

linked_backup_pair_is_owned() {
  local private="$1"
  local public="$2"
  local identity="$3"

  [[ -f "$private" && ! -L "$private" && -f "$public" && ! -L "$public" &&
    "$(file_identity "$private")" == "$identity" &&
    "$(file_identity "$public")" == "$identity" &&
    "$(file_link_count "$private")" == '2' &&
    "$(file_link_count "$public")" == '2' ]]
}

publish_link_no_clobber() {
  local private="$1"
  local destination="$2"
  local identity="$3"

  is_owned_ordinary_file "$private" "$identity" ||
    backup_die 'private backup output identity is invalid'
  [[ ! -e "$destination" && ! -L "$destination" ]] || backup_die 'backup output already exists'
  ln "$private" "$destination" || backup_die 'backup output could not be published'
  linked_backup_pair_is_owned "$private" "$destination" "$identity" ||
    backup_die 'published backup identity is invalid'
}

backup_before_sidecar_commit() {
  :
}

backup_data() {
  local target timestamp archive sidecar target_identity tree database source_snapshot digest

  [[ "$#" -eq 1 ]] || backup_die 'usage: backup-data.sh /var/lib/sweet-memories/backups/manual'
  require_root
  validate_tools
  acquire_backup_lock
  install_backup_traps
  validate_target "$1"
  target="$1"
  target_identity="$(file_identity "$target")"
  validate_data_sources
  ensure_capacity "$target"

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  [[ "$timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || backup_die 'UTC timestamp is invalid'
  archive="$target/sweet-memories-data-$timestamp.tar.gz"
  sidecar="$archive.sha256"
  [[ ! -e "$archive" && ! -L "$archive" && ! -e "$sidecar" && ! -L "$sidecar" ]] ||
    backup_die 'backup output already exists'

  systemctl stop "$SERVICE_NAME" || backup_die 'could not stop API service'
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    backup_die 'API service is still active after stop'
  fi
  [[ "$(file_identity "$target")" == "$target_identity" ]] ||
    backup_die 'backup target identity changed'
  validate_data_sources
  checkpoint_database
  validate_data_sources

  backup_workspace="$(mktemp -d "$target/.sweet-memories-backup.XXXXXX")" ||
    backup_die 'could not create private backup workspace'
  chmod 0700 "$backup_workspace"
  chown root:root "$backup_workspace"
  backup_workspace_identity="$(file_identity "$backup_workspace")"
  [[ "$(canonical_directory "$backup_workspace")" == "$backup_workspace" ]] ||
    backup_die 'private backup workspace is unsafe'
  tree="$backup_workspace/data"
  source_snapshot="$backup_workspace/source-identities"
  snapshot_source_files "$source_snapshot"
  mkdir -m 0700 "$tree" "$tree/database" "$tree/media"
  database="$DATA_ROOT/database/sweet-memories.sqlite3"
  cp -p "$database" "$tree/database/sweet-memories.sqlite3" ||
    backup_die 'database copy failed'
  copy_media_without_deleting "$tree/media"
  verify_source_snapshot "$source_snapshot"
  [[ -z "$(find "$tree" ! -type f ! -type d -print -quit)" ]] ||
    backup_die 'copied data contains unsupported entries'
  validate_sqlite_and_media "$tree"
  write_manifests "$tree"

  backup_temporary_archive="$backup_workspace/archive.tar.gz"
  [[ ! -e "$backup_temporary_archive" && ! -L "$backup_temporary_archive" ]] ||
    backup_die 'private archive path already exists'
  set -o noclobber
  if ! { exec 8>"$backup_temporary_archive"; } 2>/dev/null; then
    set +o noclobber
    backup_die 'could not create private archive file'
  fi
  set +o noclobber
  chmod 0600 "$backup_temporary_archive"
  chown root:root "$backup_temporary_archive"
  backup_archive_identity="$(file_identity "$backup_temporary_archive")"
  [[ "$(file_inode /dev/fd/8)" == "${backup_archive_identity#*:}" ]] ||
    backup_die 'private archive descriptor identity changed'
  if ! tar -czf - -C "$tree" database media SHA256SUMS MANIFEST.txt >&8; then
    exec 8>&-
    backup_die 'archive creation failed'
  fi
  exec 8>&-
  is_owned_ordinary_file "$backup_temporary_archive" "$backup_archive_identity" ||
    backup_die 'temporary archive identity changed'
  digest="$(sha256_open_file "$backup_temporary_archive" "$backup_archive_identity")" ||
    backup_die 'could not hash private archive'
  backup_published_archive="$archive"
  publish_link_no_clobber "$backup_temporary_archive" "$archive" "$backup_archive_identity"
  [[ "$(file_identity "$target")" == "$target_identity" ]] ||
    backup_die 'backup target identity changed during archive publication'

  backup_before_sidecar_commit "$archive"
  linked_backup_pair_is_owned "$backup_temporary_archive" "$archive" "$backup_archive_identity" ||
    backup_die 'published archive identity changed before commit'
  [[ "$(sha256_open_file "$backup_temporary_archive" "$backup_archive_identity")" == "$digest" &&
    "$(file_identity "$target")" == "$target_identity" ]] ||
    backup_die 'published archive content changed before commit'

  backup_temporary_sidecar="$backup_workspace/archive.tar.gz.sha256"
  [[ ! -e "$backup_temporary_sidecar" && ! -L "$backup_temporary_sidecar" ]] ||
    backup_die 'private checksum sidecar path already exists'
  set -o noclobber
  if ! { exec 8>"$backup_temporary_sidecar"; } 2>/dev/null; then
    set +o noclobber
    backup_die 'could not create private checksum sidecar'
  fi
  set +o noclobber
  chmod 0600 "$backup_temporary_sidecar"
  chown root:root "$backup_temporary_sidecar"
  backup_sidecar_identity="$(file_identity "$backup_temporary_sidecar")"
  [[ "$(file_inode /dev/fd/8)" == "${backup_sidecar_identity#*:}" ]] ||
    backup_die 'private sidecar descriptor identity changed'
  printf '%s  %s\n' "$digest" "$(basename "$archive")" >&8 || {
    exec 8>&-
    backup_die 'could not write private checksum sidecar'
  }
  exec 8>&-
  is_owned_ordinary_file "$backup_temporary_sidecar" "$backup_sidecar_identity" ||
    backup_die 'temporary sidecar identity changed'
  backup_published_sidecar="$sidecar"
  publish_link_no_clobber "$backup_temporary_sidecar" "$sidecar" "$backup_sidecar_identity"
  linked_backup_pair_is_owned "$backup_temporary_archive" "$archive" "$backup_archive_identity" &&
    linked_backup_pair_is_owned "$backup_temporary_sidecar" "$sidecar" "$backup_sidecar_identity" &&
    [[ "$(sha256_open_file "$backup_temporary_archive" "$backup_archive_identity")" == "$digest" &&
      "$(cat "$backup_temporary_sidecar")" == "$digest  $(basename "$archive")" &&
      "$(file_identity "$target")" == "$target_identity" ]] ||
    backup_die 'published backup transaction failed identity validation'

  rm -f -- "$backup_temporary_archive" "$backup_temporary_sidecar" ||
    backup_die 'could not finalize private backup links'
  backup_temporary_archive=''
  backup_temporary_sidecar=''
  [[ -f "$archive" && ! -L "$archive" && -f "$sidecar" && ! -L "$sidecar" &&
    "$(file_identity "$archive")" == "$backup_archive_identity" &&
    "$(file_identity "$sidecar")" == "$backup_sidecar_identity" &&
    "$(file_link_count "$archive")" == '1' && "$(file_link_count "$sidecar")" == '1' &&
    "$(sha256_file "$archive")" == "$digest" ]] ||
    backup_die 'finalized backup transaction is invalid'

  cleanup_backup_workspace
  backup_completed=1
  printf 'backup archive: %s\n' "$archive"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  backup_data "$@"
fi
