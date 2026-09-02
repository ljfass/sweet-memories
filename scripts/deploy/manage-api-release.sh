#!/usr/bin/env bash
set -Eeuo pipefail

API_ROOT=/opt/sweet-memories-api
DATA_ROOT=/var/lib/sweet-memories
ARCHIVE_ROOT=/tmp
SERVICE_NAME=sweet-memories-api.service
SERVICE_USER=sweet-memories
SERVICE_GROUP=sweet-memories-media
NODE_PATH=/usr/local/bin/node
HEALTH_URL=http://127.0.0.1:3100/api/health

activation_staging=''

die() {
  printf 'api release error: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die 'must run as root'
}

validate_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] ||
    die 'release SHA must be 40 lowercase hexadecimal characters'
}

canonical_dir() {
  local path="$1"

  [[ -d "$path" && ! -L "$path" ]] || die "directory is not safe: $path"
  (cd "$path" && pwd -P)
}

ensure_directory() {
  local owner="$1"
  local group="$2"
  local mode="$3"
  local path="$4"

  if [[ -e "$path" && ( ! -d "$path" || -L "$path" ) ]]; then
    die "refusing unsafe directory path: $path"
  fi
  install -d -o "$owner" -g "$group" -m "$mode" "$path"
  [[ "$(canonical_dir "$path")" == "$path" ]] ||
    die "directory resolves outside its fixed path: $path"
}

ensure_layout() {
  ensure_directory root root 0755 "$API_ROOT"
  ensure_directory root root 0755 "$API_ROOT/releases"
  ensure_directory "$SERVICE_USER" "$SERVICE_GROUP" 0750 "$DATA_ROOT"
  ensure_directory "$SERVICE_USER" "$SERVICE_GROUP" 0750 "$DATA_ROOT/database"
  ensure_directory "$SERVICE_USER" "$SERVICE_GROUP" 0750 "$DATA_ROOT/media"
  ensure_directory "$SERVICE_USER" "$SERVICE_GROUP" 0750 "$DATA_ROOT/staging"
  ensure_directory "$SERVICE_USER" "$SERVICE_GROUP" 0750 "$DATA_ROOT/backups"
  ensure_directory "$SERVICE_USER" "$SERVICE_GROUP" 0750 "$DATA_ROOT/backups/deploy"
}

validate_archive_path() {
  local archive="$1"

  [[ "$archive" == /* ]] || die 'release archive path must be absolute'
  [[ "$(dirname "$archive")" == "$ARCHIVE_ROOT" ]] ||
    die "release archive must be directly inside $ARCHIVE_ROOT"
  [[ -f "$archive" && ! -L "$archive" ]] ||
    die "release archive is not a regular file: $archive"
}

normalize_member() {
  local member="$1"

  while [[ "$member" == ./* ]]; do
    member="${member#./}"
  done
  member="${member%/}"
  printf '%s\n' "$member"
}

validate_member_path() {
  local member="$1"
  local normalized component top
  local components=()

  [[ "$member" != /* ]] || die 'archive path is unsafe'
  normalized="$(normalize_member "$member")"
  [[ -z "$normalized" ]] && return 0
  [[ "$normalized" != *'\\'* && "$normalized" != *$'\r'* ]] ||
    die 'archive path is unsafe'

  IFS='/' read -r -a components <<<"$normalized"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != '.' && "$component" != '..' ]] ||
      die 'archive path is unsafe'
  done

  top="${components[0]}"
  case "$top" in
    dist | migrations | seed | node_modules)
      ;;
    package.json)
      [[ "$normalized" == 'package.json' ]] || die 'archive contains a forbidden path'
      ;;
    *)
      die 'archive contains a forbidden path'
      ;;
  esac
}

validate_archive() {
  local archive="$1"
  local listing entry_type member

  if ! listing="$(LC_ALL=C tar -tvzf "$archive")"; then
    die 'release archive could not be inspected'
  fi
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    entry_type="${entry:0:1}"
    [[ "$entry_type" == '-' || "$entry_type" == 'd' ]] ||
      die 'unsupported archive entry type'
  done <<<"$listing"

  if ! listing="$(LC_ALL=C tar -tzf "$archive")"; then
    die 'release archive could not be inspected'
  fi
  while IFS= read -r member; do
    validate_member_path "$member"
  done <<<"$listing"
}

validate_release_tree() {
  local release="$1"
  local entry unsupported top

  for entry in dist/index.js dist/cli.js package.json; do
    [[ -f "$release/$entry" && ! -L "$release/$entry" ]] ||
      die "release is missing a regular $entry"
  done
  for entry in migrations seed node_modules; do
    [[ -d "$release/$entry" && ! -L "$release/$entry" ]] ||
      die "release is missing a regular $entry directory"
  done
  unsupported="$(find "$release" ! -type f ! -type d -print -quit)"
  [[ -z "$unsupported" ]] || die 'release contains an unsupported filesystem entry'
  while IFS= read -r top; do
    case "$(basename "$top")" in
      dist | migrations | seed | node_modules | package.json) ;;
      *) die 'release contains a forbidden top-level path' ;;
    esac
  done < <(find "$release" -mindepth 1 -maxdepth 1 -print)
}

cleanup_activation_staging() {
  local name

  [[ -n "$activation_staging" ]] || return 0
  [[ "$(dirname "$activation_staging")" == "$API_ROOT/releases" ]] || return 0
  name="$(basename "$activation_staging")"
  [[ "$name" =~ ^\.incoming-[0-9a-f]{40}$ ]] || return 0
  rm -rf -- "$activation_staging"
}

resolve_release_link() {
  local link="$1"
  local target releases

  [[ -L "$link" ]] || die "$link must be a symlink"
  target="$(readlink "$link")"
  if [[ "$target" != /* ]]; then
    target="$(dirname "$link")/$target"
  fi
  target="$(canonical_dir "$target")"
  releases="$(canonical_dir "$API_ROOT/releases")"
  [[ "$(dirname "$target")" == "$releases" &&
    "$(basename "$target")" =~ ^[0-9a-f]{40}$ ]] ||
    die "$link does not point to a managed release"
  printf '%s\n' "$target"
}

commit_symlink() {
  local temporary="$1"
  local destination="$2"

  if mv --help 2>&1 | grep -q -- '-T,'; then
    mv -Tf "$temporary" "$destination"
  else
    mv -hf "$temporary" "$destination"
  fi
}

replace_symlink() {
  local target="$1"
  local destination="$2"
  local temporary="$3"

  [[ -d "$target" && ! -L "$target" ]] || die "invalid link target: $target"
  if [[ -e "$destination" && ! -L "$destination" ]]; then
    die "refusing to replace a non-symlink: $destination"
  fi
  rm -f -- "$temporary"
  ln -s "$target" "$temporary"
  if ! commit_symlink "$temporary" "$destination"; then
    rm -f -- "$temporary"
    die "could not replace symlink: $destination"
  fi
}

remove_symlink() {
  local path="$1"

  if [[ -e "$path" && ! -L "$path" ]]; then
    die "refusing to remove a non-symlink: $path"
  fi
  rm -f -- "$path"
}

run_release_cli() {
  local release="$1"
  shift

  runuser --user "$SERVICE_USER" --group "$SERVICE_GROUP" -- \
    env -i \
      PATH=/usr/local/bin:/usr/bin:/bin \
      NODE_ENV=production \
      SWEET_MEMORIES_ORIGIN=https://huangjianfen.cn \
      SWEET_MEMORIES_DATA_ROOT="$DATA_ROOT" \
      SWEET_MEMORIES_MIGRATIONS_ROOT="$release/migrations" \
      SWEET_MEMORIES_HEIF_INFO_PATH=/usr/bin/heif-info \
      SWEET_MEMORIES_HEIF_CONVERT_PATH=/usr/bin/heif-convert \
      "$NODE_PATH" "$release/dist/cli.js" "$@"
}

next_backup_path() {
  local sha="$1"
  local timestamp candidate sequence=0

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  while :; do
    candidate="$DATA_ROOT/backups/deploy/${timestamp}-${sha}-$$-$sequence.sqlite3"
    [[ ! -e "$candidate" && ! -L "$candidate" ]] && break
    sequence=$((sequence + 1))
  done
  printf '%s\n' "$candidate"
}

health_check() {
  local attempt

  for attempt in 1 2 3; do
    if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null; then
      return 0
    fi
    [[ "$attempt" -eq 3 ]] || sleep 2
  done
  return 1
}

restore_link_state() {
  local current="$1"
  local previous="$2"
  local marker="$3"

  if [[ -n "$current" ]]; then
    replace_symlink "$current" "$API_ROOT/current" "$API_ROOT/.current-restore-$marker-$$"
  else
    remove_symlink "$API_ROOT/current"
  fi
  if [[ -n "$previous" ]]; then
    replace_symlink "$previous" "$API_ROOT/previous" "$API_ROOT/.previous-restore-$marker-$$"
  else
    remove_symlink "$API_ROOT/previous"
  fi
}

activate() {
  local sha="$1"
  local archive="$2"
  local release staging backup current='' previous=''

  validate_sha "$sha"
  validate_archive_path "$archive"
  ensure_layout
  release="$API_ROOT/releases/$sha"
  staging="$API_ROOT/releases/.incoming-$sha"
  activation_staging="$staging"
  trap cleanup_activation_staging EXIT
  trap 'exit 143' HUP INT TERM

  if [[ ! -e "$release" ]]; then
    validate_archive "$archive"
    rm -rf -- "$staging"
    mkdir -m 0755 "$staging"
    if ! tar -xzf "$archive" -C "$staging"; then
      die 'release archive could not be extracted'
    fi
    validate_release_tree "$staging"
    chown -R root:root "$staging"
    chmod -R u=rwX,go=rX "$staging"
    mv "$staging" "$release"
    activation_staging=''
  fi
  [[ -d "$release" && ! -L "$release" ]] || die 'release path is not a regular directory'
  validate_release_tree "$release"

  if [[ -L "$API_ROOT/current" ]]; then
    current="$(resolve_release_link "$API_ROOT/current")"
    if [[ "$current" == "$release" ]]; then
      rm -f -- "$archive"
      printf 'release already active: %s\n' "$sha"
      return 0
    fi
  elif [[ -e "$API_ROOT/current" ]]; then
    die 'current must be a symlink'
  fi
  if [[ -L "$API_ROOT/previous" ]]; then
    previous="$(resolve_release_link "$API_ROOT/previous")"
  elif [[ -e "$API_ROOT/previous" ]]; then
    die 'previous must be a symlink'
  fi

  backup="$(next_backup_path "$sha")"
  if ! run_release_cli "$release" database backup "$backup"; then
    die 'database backup failed'
  fi
  if ! run_release_cli "$release" database migrate; then
    die 'database migration failed'
  fi

  if [[ -n "$current" ]]; then
    replace_symlink "$current" "$API_ROOT/previous" "$API_ROOT/.previous-next-$sha-$$"
  else
    remove_symlink "$API_ROOT/previous"
  fi
  if ! (replace_symlink "$release" "$API_ROOT/current" "$API_ROOT/.current-next-$sha-$$"); then
    restore_link_state "$current" "$previous" "$sha"
    die 'release link switch failed; restored previous release'
  fi
  if ! systemctl restart "$SERVICE_NAME"; then
    restore_link_state "$current" "$previous" "$sha"
    systemctl restart "$SERVICE_NAME" || true
    die 'service restart failed; restored previous release'
  fi
  if ! health_check; then
    if [[ -L "$API_ROOT/current" &&
      "$(resolve_release_link "$API_ROOT/current")" == "$release" ]]; then
      restore_link_state "$current" "$previous" "$sha"
      systemctl restart "$SERVICE_NAME" || true
    fi
    die 'health check failed; restored previous release'
  fi

  rm -f -- "$archive"
  printf 'activated API release: %s\n' "$sha"
}

rollback_if_current() {
  local sha="$1"
  local current previous

  validate_sha "$sha"
  ensure_layout
  [[ -L "$API_ROOT/current" ]] || die 'no current release is available'
  current="$(resolve_release_link "$API_ROOT/current")"
  [[ "$current" == "$API_ROOT/releases/$sha" ]] ||
    die 'current release does not match expected SHA'
  [[ -L "$API_ROOT/previous" ]] || die 'no previous release is available'
  previous="$(resolve_release_link "$API_ROOT/previous")"
  [[ "$current" != "$previous" ]] || die 'previous release must differ from current release'

  replace_symlink "$current" "$API_ROOT/previous" "$API_ROOT/.previous-rollback-$sha-$$"
  if ! (replace_symlink "$previous" "$API_ROOT/current" "$API_ROOT/.current-rollback-$sha-$$"); then
    restore_link_state "$current" "$previous" "$sha"
    die 'rollback link switch failed; restored original release'
  fi
  if ! systemctl restart "$SERVICE_NAME"; then
    restore_link_state "$current" "$previous" "$sha"
    systemctl restart "$SERVICE_NAME" || true
    die 'rollback service restart failed; restored original release'
  fi
  if ! health_check; then
    restore_link_state "$current" "$previous" "$sha"
    systemctl restart "$SERVICE_NAME" || true
    die 'rolled-back release failed its health check'
  fi
  printf 'rolled back API release: %s\n' "$(basename "$previous")"
}

directory_mtime() {
  local path="$1"

  if stat -c '%Y' "$path" >/dev/null 2>&1; then
    stat -c '%Y' "$path"
  else
    stat -f '%m' "$path"
  fi
}

cleanup() {
  local keep="$1"
  local current='' previous='' candidate mtime newest i j swap kept_protected=0 kept_other=0
  local releases=() mtimes=()

  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || die 'keep count must be a positive integer'
  ensure_layout
  if [[ -L "$API_ROOT/current" ]]; then
    current="$(resolve_release_link "$API_ROOT/current")"
    kept_protected=$((kept_protected + 1))
  fi
  if [[ -L "$API_ROOT/previous" ]]; then
    previous="$(resolve_release_link "$API_ROOT/previous")"
    [[ "$previous" == "$current" ]] || kept_protected=$((kept_protected + 1))
  fi

  shopt -s nullglob
  for candidate in "$API_ROOT/releases"/*; do
    [[ -d "$candidate" && ! -L "$candidate" &&
      "$(basename "$candidate")" =~ ^[0-9a-f]{40}$ ]] || continue
    releases+=("$candidate")
    mtime="$(directory_mtime "$candidate")"
    [[ "$mtime" =~ ^[0-9]+$ ]] || die "could not read release mtime: $candidate"
    mtimes+=("$mtime")
  done
  shopt -u nullglob

  for ((i = 0; i < ${#releases[@]}; i++)); do
    newest=$i
    for ((j = i + 1; j < ${#releases[@]}; j++)); do
      if ((mtimes[j] > mtimes[newest])); then
        newest=$j
      fi
    done
    if ((newest != i)); then
      swap="${releases[i]}"; releases[i]="${releases[newest]}"; releases[newest]="$swap"
      swap="${mtimes[i]}"; mtimes[i]="${mtimes[newest]}"; mtimes[newest]="$swap"
    fi
  done

  for candidate in "${releases[@]}"; do
    if [[ "$candidate" == "$current" || "$candidate" == "$previous" ]]; then
      continue
    fi
    if ((kept_protected + kept_other < keep)); then
      kept_other=$((kept_other + 1))
      continue
    fi
    rm -rf -- "$candidate"
    printf 'removed old API release: %s\n' "$(basename "$candidate")"
  done
}

run_current_cli() {
  local namespace="$1"
  local action="$2"
  local current

  case "$namespace:$action" in
    migration:check-ready | migration:activate | uploads:enable | uploads:disable | uploads:status)
      ;;
    *) die 'unsupported API management command' ;;
  esac
  ensure_layout
  [[ -L "$API_ROOT/current" ]] || die 'no current release is available'
  current="$(resolve_release_link "$API_ROOT/current")"
  run_release_cli "$current" "$namespace" "$action"
}

manage_api_release() {
  local mode="${1:-}"

  case "$mode" in
    activate)
      [[ $# -eq 3 ]] || die 'usage: manage-api-release.sh activate <sha> <archive>'
      activate "$2" "$3"
      ;;
    rollback-if-current)
      [[ $# -eq 2 ]] || die 'usage: manage-api-release.sh rollback-if-current <sha>'
      rollback_if_current "$2"
      ;;
    cleanup)
      [[ $# -eq 2 ]] || die 'usage: manage-api-release.sh cleanup <keep-count>'
      cleanup "$2"
      ;;
    cli)
      [[ $# -eq 3 ]] || die 'usage: manage-api-release.sh cli <namespace> <action>'
      run_current_cli "$2" "$3"
      ;;
    *)
      die 'mode must be activate, rollback-if-current, cleanup, or cli'
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  require_root
  manage_api_release "$@"
fi
