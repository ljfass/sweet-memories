# AGENTS.md

pnpm 8.6.1 (`packageManager` in root `package.json`). CI and API runtime are Node 24. Install with `pnpm install --frozen-lockfile`.

## Commands

Deploy gate (`.github/workflows/deploy.yml`): `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm test:api` → `pnpm test:deploy` → `pnpm test:monitor` → `pnpm build:frontend` / `pnpm build:api`.

- Lint is `eslint . --max-warnings=0`.
- `pnpm typecheck` is `vue-tsc -p tsconfig.app.json` plus `apps/api`. It does not typecheck `scripts/`.
- `pnpm test` is root Vitest (`happy-dom`, setup `tests/setup.ts`). It already includes `apps/api` and `scripts` tests; Node files must keep `// @vitest-environment node`.
- Single file: `pnpm exec vitest run path/to/file.test.ts`. API-only: `pnpm --dir apps/api test` (`src/**/*.test.ts` only).
- `pnpm test:api` reruns API Vitest and `scripts/deploy/package-api.test.sh`. The real packager (`pnpm package:api` / `package-api.sh`) requires Ubuntu 24.04 x64, GNU tar, Node 24, `RUNNER_TEMP` outside the repo, and an absolute `*.tar.gz` path that does not already exist.
- Also: `pnpm test:data-backup`, `pnpm test:lighthouse` (not in deploy). Lighthouse CI needs `MONITOR_URL`.

No PR CI. Production deploys only on `v*` tags whose commit is already on `origin/main`.

## Layout

- Vue 3 + Vite public album (`src/`) and `/admin` SPA (`src/main.ts` chooses root by exact `/admin` or `/admin/`).
- Fastify photo API: `apps/api` (`@sweet-memories/api`). Workspace is only `apps/*`.
- Album mode is `src/config/album-source.json` (`{"mode":"api"}` today). Parser allows only `{mode:"static"|"api"}`. A unit test pins current mode to `api`; deploy/monitor/health checks branch on it. Do not flip casually.
- `mode: "static"` uses `src/data/memories.ts` and `src/assets/generated/*`. Rebuild those with `pnpm media:build` from `codebase/assets` (`scripts/media-config.mjs`); `pnpm media:verify` checks budgets. Do not hand-edit generated media. ESLint ignores `src/assets/generated/**` and `codebase/**`.

## Local dev

`pnpm dev` is Vite on `127.0.0.1:5173` (`strictPort`, `base: './'`). It proxies `/api` and `/media` to `https://huangjianfen.cn` (`scripts/dev/production-api-proxy.ts`). Admin login/upload/edit/delete hit production data. Do not start a local API for normal frontend work.

Dev session cookie is `sweet_memories_dev_session` (mapped to production `__Host-sweet_memories_session`). Proxy origin is rewritten to the production origin.

To run the API locally you need absolute `SWEET_MEMORIES_*` paths under a data root, host `127.0.0.1` (default port 3100), and `heif-info` / `heif-convert`. Production defaults: origin `https://huangjianfen.cn`, data `/var/lib/sweet-memories`. API listen address cannot be anything but `127.0.0.1`.

## Conventions

- Frontend TS/Vue: no semicolons. API (`apps/api`): semicolons, `NodeNext`, `.js` import specifiers.
- User-facing copy and API error messages are Chinese; keep them stable.
- Mutating admin API calls need exact `Origin` plus `x-csrf-token`.
- `public/robots.txt` is `Disallow: /`; `index.html` is `noindex`. Do not add SEO crawlability.
- Ops/deploy details: `docs/deployment.md`, `docs/photo-upload-operations.md`. Do not invent SSH/sudo/release steps.
