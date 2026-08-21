#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'deploy error: %s\n' "$1" >&2
  exit 1
}

canonical_dir() {
  local path="$1"

  [[ -d "$path" ]] || die "directory does not exist: $path"
  (cd "$path" && pwd -P)
}

validate_site_root() {
  local site_root="$1"

  [[ "$site_root" == /* ]] || die 'site root must be an absolute path'
  site_root="$(canonical_dir "$site_root")"
  [[ -d "$site_root/releases" && ! -L "$site_root/releases" ]] ||
    die "$site_root/releases must be a directory"
  [[ -L "$site_root/html" ]] || die "$site_root/html must be a symlink"
  printf '%s\n' "$site_root"
}

resolve_link() {
  local link_path="$1"
  local target

  [[ -L "$link_path" ]] || die "$link_path must be a symlink"
  target="$(readlink "$link_path")"
  if [[ "$target" != /* ]]; then
    target="$(dirname "$link_path")/$target"
  fi
  canonical_dir "$target"
}

resolve_release_link() {
  local link_path="$1"
  local releases="$2"
  local target

  target="$(resolve_link "$link_path")"
  [[ "$(dirname "$target")" == "$releases" ]] ||
    die "$link_path must point to a release in $releases"
  printf '%s\n' "$target"
}

replace_symlink() {
  local target="$1"
  local link_path="$2"
  local temp_link="$3"

  [[ -d "$target" ]] || die "symlink target does not exist: $target"
  if [[ -e "$link_path" && ! -L "$link_path" ]]; then
    die "refusing to replace non-symlink path: $link_path"
  fi

  rm -f "$temp_link"
  ln -s "$target" "$temp_link"
  if mv --help 2>&1 | grep -q -- '-T,'; then
    if ! mv -Tf "$temp_link" "$link_path"; then
      rm -f "$temp_link"
      die "could not replace symlink: $link_path"
    fi
  else
    if ! mv -hf "$temp_link" "$link_path"; then
      rm -f "$temp_link"
      die "could not replace symlink: $link_path"
    fi
  fi
}

directory_mtime() {
  local path="$1"

  if stat -c '%Y' "$path" >/dev/null 2>&1; then
    stat -c '%Y' "$path"
  else
    stat -f '%m' "$path"
  fi
}

activate() {
  local site_root="$1"
  local release_sha="$2"
  local archive="$3"
  local releases release_dir staging current canonical_release

  [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] ||
    die 'release SHA must be 40 lowercase hexadecimal characters'
  [[ -f "$archive" ]] || die "release archive does not exist: $archive"

  site_root="$(validate_site_root "$site_root")"
  releases="$(canonical_dir "$site_root/releases")"
  current="$(resolve_release_link "$site_root/html" "$releases")"
  release_dir="$releases/$release_sha"
  staging="$releases/.incoming-$release_sha"

  if [[ ! -e "$release_dir" ]]; then
    rm -rf "$staging"
    mkdir "$staging"
    if ! tar -xzf "$archive" -C "$staging"; then
      rm -rf "$staging"
      die 'release archive could not be extracted'
    fi
    if [[ ! -f "$staging/index.html" || -L "$staging/index.html" ]]; then
      rm -rf "$staging"
      die 'release is missing a regular index.html file'
    fi
    if ! mv "$staging" "$release_dir"; then
      rm -rf "$staging"
      die 'staged release could not be finalized'
    fi
  fi

  [[ -d "$release_dir" && ! -L "$release_dir" ]] ||
    die "release path is not a directory: $release_dir"
  [[ -f "$release_dir/index.html" && ! -L "$release_dir/index.html" ]] ||
    die 'target release is missing a regular index.html file'
  canonical_release="$(canonical_dir "$release_dir")"
  [[ "$(dirname "$canonical_release")" == "$releases" ]] ||
    die 'target release is outside the releases directory'

  chmod -R u=rwX,go=rX "$release_dir"
  touch "$release_dir"
  rm -f "$archive"

  if [[ "$current" == "$canonical_release" ]]; then
    printf 'release already active: %s\n' "$release_sha"
    return
  fi

  replace_symlink \
    "$current" \
    "$site_root/previous" \
    "$site_root/.previous-next-$release_sha-$$"
  replace_symlink \
    "$canonical_release" \
    "$site_root/html" \
    "$site_root/.html-next-$release_sha-$$"
  printf 'activated release: %s\n' "$release_sha"
}

rollback() {
  local site_root="$1"
  local releases current previous marker

  site_root="$(validate_site_root "$site_root")"
  [[ -L "$site_root/previous" ]] || die 'no previous release is available'
  releases="$(canonical_dir "$site_root/releases")"
  current="$(resolve_release_link "$site_root/html" "$releases")"
  previous="$(resolve_release_link "$site_root/previous" "$releases")"
  marker="$(basename "$previous")"

  replace_symlink \
    "$current" \
    "$site_root/previous" \
    "$site_root/.previous-rollback-$marker-$$"
  replace_symlink \
    "$previous" \
    "$site_root/html" \
    "$site_root/.html-rollback-$marker-$$"
  printf 'rolled back to: %s\n' "$previous"
}

cleanup() {
  local site_root="$1"
  local keep_count="$2"
  local releases current previous candidate candidate_mtime canonical_candidate
  local i j newest_index swap_path swap_mtime
  local release_dirs=()
  local release_mtimes=()

  [[ "$keep_count" =~ ^[1-9][0-9]*$ ]] ||
    die 'keep count must be a positive integer'
  site_root="$(validate_site_root "$site_root")"
  releases="$(canonical_dir "$site_root/releases")"
  current="$(resolve_release_link "$site_root/html" "$releases")"
  previous=''
  if [[ -L "$site_root/previous" ]]; then
    previous="$(resolve_release_link "$site_root/previous" "$releases")"
  fi

  shopt -s nullglob
  for candidate in "$releases"/*; do
    if [[ -d "$candidate" && ! -L "$candidate" ]]; then
      release_dirs+=("$candidate")
      candidate_mtime="$(directory_mtime "$candidate")"
      [[ "$candidate_mtime" =~ ^[0-9]+$ ]] ||
        die "could not read release mtime: $candidate"
      release_mtimes+=("$candidate_mtime")
    fi
  done
  shopt -u nullglob

  for ((i = 0; i < ${#release_dirs[@]}; i++)); do
    newest_index=$i
    for ((j = i + 1; j < ${#release_dirs[@]}; j++)); do
      if ((release_mtimes[j] > release_mtimes[newest_index])); then
        newest_index=$j
      fi
    done
    if ((newest_index != i)); then
      swap_path="${release_dirs[i]}"
      release_dirs[i]="${release_dirs[newest_index]}"
      release_dirs[newest_index]="$swap_path"
      swap_mtime="${release_mtimes[i]}"
      release_mtimes[i]="${release_mtimes[newest_index]}"
      release_mtimes[newest_index]="$swap_mtime"
    fi
  done

  for ((i = keep_count; i < ${#release_dirs[@]}; i++)); do
    candidate="${release_dirs[i]}"
    canonical_candidate="$(canonical_dir "$candidate")"
    if [[ "$canonical_candidate" != "$current" &&
      "$canonical_candidate" != "$previous" ]]; then
      rm -rf "$candidate"
      printf 'removed old release: %s\n' "$canonical_candidate"
    fi
  done
}

mode="${1:-}"
case "$mode" in
  activate)
    [[ $# -eq 4 ]] ||
      die 'usage: manage-release.sh activate <absolute-site-root> <sha> <archive>'
    activate "$2" "$3" "$4"
    ;;
  rollback)
    [[ $# -eq 2 ]] ||
      die 'usage: manage-release.sh rollback <absolute-site-root>'
    rollback "$2"
    ;;
  cleanup)
    [[ $# -eq 3 ]] ||
      die 'usage: manage-release.sh cleanup <absolute-site-root> <keep-count>'
    cleanup "$2" "$3"
    ;;
  *)
    die 'mode must be activate, rollback, or cleanup'
    ;;
esac
