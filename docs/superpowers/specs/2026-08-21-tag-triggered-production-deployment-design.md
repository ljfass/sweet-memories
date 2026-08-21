# Tag-Triggered Production Deployment Design

## Goal

Deploy the Vue/Vite static site to the existing Alibaba Cloud server automatically when a version tag is pushed to GitHub. A release must pass all repository checks before it can replace the live files, and a failed upload or health check must leave or restore the previous working release.

The existing Nginx document root is `/var/www/huangjianfen.cn/html`. The public health-check URL is initially `http://8.163.27.231`.

## Approved Release Contract

- Tags beginning with `v` trigger production deployment, for example `v1.0.0`.
- Ordinary branch pushes do not deploy.
- The exact commit referenced by the tag is built and deployed.
- Only one production deployment runs at a time.
- A release must pass type checking, linting, unit tests, and the production build.
- Nginx continues serving static files and does not need a restart or reload for a release.
- The server keeps the five newest releases so an earlier version remains available for rollback.

## Architecture

One GitHub Actions workflow owns both verification and deployment:

1. Check out the tagged commit.
2. Install the pnpm version declared by the repository and a supported Node.js runtime.
3. Install dependencies with the frozen lockfile.
4. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.
5. Package the contents of `dist/` as an immutable release artifact.
6. Transfer the artifact over SSH to a dedicated, unprivileged `deploy` user on the Alibaba Cloud server.
7. Extract it into `/var/www/huangjianfen.cn/releases/<commit-sha>` and verify that `index.html` exists.
8. Atomically switch `/var/www/huangjianfen.cn/html` to a symlink targeting the new release.
9. Request the configured public URL. If the request fails, atomically restore the previous symlink target and fail the workflow.
10. After a successful check, remove releases older than the five newest entries.

The workflow uses the standard SSH and archive tools available on the GitHub-hosted Ubuntu runner. It does not depend on a third-party SSH deployment action.

## One-Time Server Preparation

The server receives a dedicated `deploy` account with no password login. Its only application responsibility is writing release directories and switching the static-site symlink under `/var/www/huangjianfen.cn`.

Initial preparation will:

- create the `deploy` user and its SSH directory;
- authorize a dedicated Ed25519 public key generated specifically for GitHub Actions;
- create `/var/www/huangjianfen.cn/releases`;
- move the currently served static files into an initial release directory;
- replace the existing `html` directory with an `html` symlink to that initial release;
- grant `deploy` ownership only over the application deployment directory;
- retain read and traversal permissions required by the Nginx worker user.

SSH remains on the server's configured port, initially assumed to be port `22`. The preparation steps will first inspect the actual SSH port and relevant file ownership before making changes.

## Credentials And GitHub Configuration

The production workflow uses a GitHub Environment named `production`. The following values are configured outside the repository:

- `ALIYUN_HOST`: server address;
- `ALIYUN_SSH_PORT`: SSH port;
- `ALIYUN_USER`: dedicated deployment user, `deploy`;
- `ALIYUN_SSH_PRIVATE_KEY`: dedicated private key used only by GitHub Actions;
- `ALIYUN_KNOWN_HOSTS`: pinned SSH host-key entry used to verify the server;
- `PRODUCTION_URL`: public URL used by the post-deployment health check.

Sensitive values are stored as environment secrets. The public URL may be stored as an environment variable. The workflow grants only `contents: read` permission and never writes a private key, password, or secret into the repository or workflow logs.

The server's security group must permit SSH connections from GitHub-hosted runners. Authentication uses the dedicated key; the `deploy` account has no password. Broader SSH hardening is separate from this deployment change so the existing administrator login is not accidentally disabled.

## Atomic Activation And Rollback

Each build is extracted into a new commit-addressed directory. The live `html` path is not modified while files are uploading or extracting.

Activation creates a temporary symlink beside `html` and renames it over the live symlink. On Linux this rename is atomic, so Nginx sees either the complete old release or the complete new release. The previous target is recorded before activation.

If upload, extraction, or validation fails, activation never occurs. If the public health check fails after activation, the workflow switches `html` back to the recorded previous target before reporting failure. Cleanup only runs after a successful health check and never removes the live or immediately previous release.

## Concurrency And Failure Handling

GitHub Actions production concurrency prevents overlapping deployments. An already running production release is allowed to finish rather than being canceled during its server update.

SSH uses strict host-key checking and non-interactive authentication. Remote commands fail on unset variables, command errors, and failed pipelines. Release directory names use the Git commit SHA rather than the tag text, avoiding shell interpolation and path traversal from unusual tag names.

Re-pushing the same immutable tag commit is idempotent: the matching release directory can be validated and activated again. Moving published tags is discouraged; GitHub repository policy should treat release tags as immutable.

## Verification And Acceptance

Repository verification covers:

- the existing type-check, lint, and Vitest suites;
- a clean production build from the frozen lockfile;
- workflow syntax and shell-script syntax;
- absence of committed credentials or private keys.

The first release is accepted when:

- pushing a test version tag starts the workflow;
- all checks complete before any server files change;
- the workflow deploys the tag's exact commit;
- `http://8.163.27.231` returns a successful response after activation;
- the live `html` symlink points to the new commit-addressed release;
- an ordinary branch push does not deploy;
- a deliberately failed pre-deployment check does not alter the live release.

The server-preparation instructions and GitHub secret setup will be documented for a beginner and performed as explicit, verifiable steps.

## Out Of Scope

- changing the Nginx virtual-host configuration;
- adding a domain name or HTTPS certificate;
- deploying ordinary branch pushes;
- Docker, PM2, or building application code on the server;
- automatically creating or moving Git tags;
- globally disabling SSH password login or changing unrelated server security settings.
