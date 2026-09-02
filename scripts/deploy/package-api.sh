#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'package api error: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || die 'usage: package-api.sh <absolute-output.tar.gz>'

OUTPUT="$1"
[[ "$OUTPUT" == /* ]] || die 'output path must be absolute'
[[ "$OUTPUT" == *.tar.gz ]] || die 'output filename must end with .tar.gz'
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || die 'output path must not already exist'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
OUTPUT_PARENT="$(dirname "$OUTPUT")"
[[ -d "$OUTPUT_PARENT" && ! -L "$OUTPUT_PARENT" ]] ||
  die 'output parent must be an existing ordinary directory'
OUTPUT_PARENT="$(cd "$OUTPUT_PARENT" && pwd -P)"
OUTPUT="$OUTPUT_PARENT/$(basename "$OUTPUT")"
case "$OUTPUT" in
  "$REPOSITORY_ROOT"/*) die 'output must be outside the repository' ;;
esac

PLATFORM_REQUIREMENT='requires Ubuntu 24.04 x64 with Node.js 24'
[[ "$(uname -s)" == 'Linux' && "$(uname -m)" == 'x86_64' ]] ||
  die "$PLATFORM_REQUIREMENT"
if ! OS_RELEASE="$(cat /etc/os-release 2>/dev/null)"; then
  die "$PLATFORM_REQUIREMENT"
fi
OS_ID=''
OS_VERSION_ID=''
while IFS='=' read -r key value; do
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  case "$key" in
    ID) OS_ID="$value" ;;
    VERSION_ID) OS_VERSION_ID="$value" ;;
  esac
done <<<"$OS_RELEASE"
[[ "$OS_ID" == 'ubuntu' && "$OS_VERSION_ID" == '24.04' ]] ||
  die "$PLATFORM_REQUIREMENT"
NODE_VERSION="$(node --version 2>/dev/null || true)"
[[ "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]] ||
  die "$PLATFORM_REQUIREMENT"
tar --version 2>/dev/null | head -n 1 | grep -q 'GNU tar' ||
  die 'GNU tar is required'

[[ -n "${RUNNER_TEMP:-}" && "$RUNNER_TEMP" == /* ]] ||
  die 'RUNNER_TEMP must be an absolute directory'
[[ -d "$RUNNER_TEMP" && ! -L "$RUNNER_TEMP" ]] ||
  die 'RUNNER_TEMP must be an existing ordinary directory'
RUNNER_TEMP="$(cd "$RUNNER_TEMP" && pwd -P)"
case "$RUNNER_TEMP" in
  "$REPOSITORY_ROOT"|"$REPOSITORY_ROOT"/*)
    die 'RUNNER_TEMP must be outside the repository'
    ;;
esac

WORK_ROOT="$(mktemp -d "$RUNNER_TEMP/sweet-memories-api-package.XXXXXX")"
DEPLOY_ROOT="$WORK_ROOT/deploy"
SEED_ROOT="$WORK_ROOT/legacy-seed"
DIST_BACKUP="$WORK_ROOT/original-dist"
DIST_PATH="$REPOSITORY_ROOT/apps/api/dist"
HAD_DIST=0
ARCHIVE_COMPLETE=0

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -e "$DIST_PATH" || -L "$DIST_PATH" ]]; then
    rm -rf -- "$DIST_PATH"
  fi
  if [[ "$HAD_DIST" -eq 1 && -d "$DIST_BACKUP" && ! -L "$DIST_BACKUP" ]]; then
    mv -- "$DIST_BACKUP" "$DIST_PATH"
  fi
  rm -rf -- "$WORK_ROOT"
  if [[ "$ARCHIVE_COMPLETE" -ne 1 && ( -e "$OUTPUT" || -L "$OUTPUT" ) ]]; then
    rm -f -- "$OUTPUT"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [[ -e "$DIST_PATH" || -L "$DIST_PATH" ]]; then
  [[ -d "$DIST_PATH" && ! -L "$DIST_PATH" ]] ||
    die 'apps/api/dist must be an ordinary directory when present'
  mv -- "$DIST_PATH" "$DIST_BACKUP"
  HAD_DIST=1
fi

pnpm --dir apps/api build
[[ -d "$DIST_PATH" && ! -L "$DIST_PATH" ]] || die 'API build did not create dist'
pnpm --filter @sweet-memories/api deploy --prod "$DEPLOY_ROOT"

mkdir "$SEED_ROOT"
node scripts/api/prepare-legacy-seed.mjs --output "$SEED_ROOT"
[[ -d "$SEED_ROOT/media" && ! -L "$SEED_ROOT/media" ]] ||
  die 'legacy seed media was not generated'
[[ -f "$SEED_ROOT/media-manifest.json" && ! -L "$SEED_ROOT/media-manifest.json" ]] ||
  die 'legacy seed manifest was not generated'
mkdir -p "$DEPLOY_ROOT/seed"
cp -a "$SEED_ROOT/media" "$SEED_ROOT/media-manifest.json" "$DEPLOY_ROOT/seed/"

# TypeScript tests, declarations and source maps are build-time material only.
find "$DEPLOY_ROOT/dist" -type f \( \
  -name '*.test.js' -o -name '*.test.d.ts' -o -name '*.test.js.map' \
  -o -name '*.test.d.ts.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \
  -o -name '*.js.map' \
\) -delete

node --input-type=module - "$DEPLOY_ROOT/package.json" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';

const path = process.argv[2];
const source = JSON.parse(await readFile(path, 'utf8'));
const output = {
  name: source.name,
  private: true,
  version: source.version,
  type: source.type,
  engines: source.engines,
  main: source.main,
  scripts: {
    start: 'node dist/index.js',
    cli: 'node dist/cli.js',
  },
  dependencies: source.dependencies,
};
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o644 });
NODE

for required in dist migrations seed package.json node_modules; do
  [[ -e "$DEPLOY_ROOT/$required" && ! -L "$DEPLOY_ROOT/$required" ]] ||
    die "runtime entry is missing: $required"
done
[[ -f "$DEPLOY_ROOT/dist/index.js" && ! -L "$DEPLOY_ROOT/dist/index.js" ]] ||
  die 'runtime entry is missing: dist/index.js'
[[ -f "$DEPLOY_ROOT/dist/cli.js" && ! -L "$DEPLOY_ROOT/dist/cli.js" ]] ||
  die 'runtime entry is missing: dist/cli.js'
[[ -f "$DEPLOY_ROOT/seed/legacy-photos.json" && ! -L "$DEPLOY_ROOT/seed/legacy-photos.json" ]] ||
  die 'legacy photo contract is missing'

while IFS= read -r -d '' entry; do
  name="$(basename "$entry")"
  case "$name" in
    dist|migrations|seed|package.json|node_modules) ;;
    *) die "unexpected runtime entry: $name" ;;
  esac
done < <(find "$DEPLOY_ROOT" -mindepth 1 -maxdepth 1 -print0)

REAL_DEPLOY_ROOT="$(realpath -e "$DEPLOY_ROOT")"
while IFS= read -r -d '' link; do
  target="$(realpath -e "$link" 2>/dev/null)" || die 'runtime contains a dangling symlink'
  case "$target" in
    "$REAL_DEPLOY_ROOT"|"$REAL_DEPLOY_ROOT"/*) ;;
    *) die 'runtime symlink escapes the deploy root' ;;
  esac
done < <(find "$DEPLOY_ROOT" -type l -print0)

SPECIAL_ENTRY="$(find "$DEPLOY_ROOT" ! -type d ! -type f ! -type l -print -quit)"
[[ -z "$SPECIAL_ENTRY" ]] || die 'runtime contains a special filesystem entry'

while IFS= read -r -d '' entry; do
  relative_entry="${entry#"$DEPLOY_ROOT"/}"
  case "$relative_entry" in
    *$'\n'*|*$'\r'*|/*|../*|*/../*|*/..|..)
      die 'runtime contains an unsafe path'
      ;;
  esac
done < <(find "$DEPLOY_ROOT" -mindepth 1 -print0)

node --input-type=module - "$DEPLOY_ROOT" <<'NODE'
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
process.chdir(root);
const manifest = JSON.parse(await readFile(join(root, 'seed/media-manifest.json'), 'utf8'));
if (!Array.isArray(manifest.photos) || manifest.photos.length !== 5) {
  throw new Error('legacy seed must contain exactly five photos');
}
const assets = manifest.photos.flatMap((photo) => photo.assets);
if (assets.length !== 50) throw new Error('legacy seed asset count is invalid');
for (const asset of assets) {
  const path = join(root, 'seed/media', asset.relativePath);
  const contents = await readFile(path);
  const digest = createHash('sha256').update(contents).digest('hex');
  if (contents.length !== asset.size || digest !== asset.sha256) {
    throw new Error('legacy seed asset verification failed');
  }
}

const require = createRequire(join(root, 'package.json'));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const [{ default: Database }] = await Promise.all([
  load('better-sqlite3'),
  load('sharp'),
  load('argon2'),
  load('file-type'),
  load('exifr'),
  load('fastify'),
  load('@fastify/cookie'),
  load('@fastify/multipart'),
]);
const database = new Database(':memory:');
database.close();
NODE

tar --dereference --hard-dereference -C "$DEPLOY_ROOT" -czf "$OUTPUT" .
[[ -f "$OUTPUT" && ! -L "$OUTPUT" ]] || die 'runtime archive was not created'

MEMBER_LIST="$WORK_ROOT/archive-members.txt"
TYPE_LIST="$WORK_ROOT/archive-types.txt"
tar -tzf "$OUTPUT" >"$MEMBER_LIST"
tar --numeric-owner --quoting-style=escape -tvzf "$OUTPUT" >"$TYPE_LIST"

while IFS= read -r member; do
  normalized="$member"
  while [[ "$normalized" == ./* ]]; do normalized="${normalized#./}"; done
  normalized="${normalized%/}"
  if [[ -z "$normalized" ]]; then
    continue
  fi
  case "$normalized" in
    *$'\n'*|*$'\r'*|/*|../*|*/../*|*/..|..)
      die 'archive contains an unsafe member path'
      ;;
  esac
done <"$MEMBER_LIST"

while IFS= read -r verbose_member; do
  type_character="${verbose_member%"${verbose_member#?}"}"
  case "$type_character" in
    -|d) ;;
    *) die 'archive contains a link or special member' ;;
  esac
done <"$TYPE_LIST"

if grep -Eiq '^(\./)?(\.env([^/]*)?|src)(/|$)|^(\./)?dist/.*(\.test\.js|\.ts|\.map)$' "$MEMBER_LIST"; then
  die 'archive contains source, test, environment or development files'
fi
if grep -Eq '^(\./)?(database|media)(/|$)' "$MEMBER_LIST"; then
  die 'archive contains persistent application data'
fi

ARCHIVE_COMPLETE=1
printf 'photo API package created: %s\n' "$OUTPUT"
