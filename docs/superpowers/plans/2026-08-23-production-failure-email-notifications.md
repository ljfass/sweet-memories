# Production Failure Email Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document and safely enable GitHub's native failure-only email notifications for the existing production monitor and deployment workflows.

**Architecture:** Keep both workflow files and all runtime scripts unchanged. Update the Chinese monitoring guide with account-level GitHub notification configuration, a non-destructive delivery test, repeated-alert behavior, and troubleshooting; after the repository change is merged, the user completes the personal GitHub settings in the browser.

**Tech Stack:** Markdown, Bash contract checks, existing pnpm/Vitest/ESLint/Vue build toolchain, GitHub native Actions notifications.

---

## File Map

- Modify: `docs/monitoring.md`
  - Explain native GitHub Actions failure emails.
  - Give exact personal-settings navigation and safe verification steps.
  - Explain recipients, repeated failures, limitations, and troubleshooting.
- Create: `docs/superpowers/plans/2026-08-23-production-failure-email-notifications.md`
  - This implementation plan only; no runtime responsibility.

The implementation must not modify:

- `.github/workflows/monitor.yml`
- `.github/workflows/deploy.yml`
- `scripts/monitor/*`
- `package.json` or `pnpm-lock.yaml`
- GitHub Secrets or the `production` Environment

## Starting State

- Base commit: `90c193e` (`docs: design production failure email notifications`).
- Worktree: `.worktrees/production-failure-email-notifications`.
- Existing baseline is green:
  - ESLint exits `0`.
  - Type checking exits `0`.
  - Vitest passes `17` files and `71` tests.
  - Deployment integration tests pass.
  - Vite builds `1882` modules.
- The existing monitor already makes workflow failures visible; this plan changes only how the user subscribes to those failures.

### Task 1: Add the Failure Email Guide

**Files:**
- Modify: `docs/monitoring.md`

- [ ] **Step 1: Run the documentation contract and verify RED**

Run this before editing the guide:

```bash
bash <<'BASH'
set -euo pipefail

DOC='docs/monitoring.md'
required=(
  '## GitHub 失败邮件通知'
  'Settings -> Notifications'
  'System -> Actions'
  'Only notify for failed workflows'
  '发布生产环境'
  '每 30 分钟收到一封失败邮件'
  'GitHub 主邮箱是否已验证'
)

for text in "${required[@]}"; do
  grep -F -- "$text" "$DOC" >/dev/null || {
    echo "missing notification guide text: $text" >&2
    exit 1
  }
done

if grep -F -- '不表示 GitHub 会发送邮件或微信通知' "$DOC" >/dev/null; then
  echo 'obsolete no-email statement remains' >&2
  exit 1
fi
BASH
```

Expected: exit `1`, with the first missing-text message:

```text
missing notification guide text: ## GitHub 失败邮件通知
```

- [ ] **Step 2: Replace the obsolete notification sentence and add the complete guide**

In `docs/monitoring.md`, replace:

```markdown
本任务只提供定时 Actions 的失败可见性，不表示 GitHub 会发送邮件或微信通知。
```

with the following content, immediately before the existing `## 本地验证` heading:

```markdown
巡检不会自动重启、回滚或修改服务器，也不发送微信通知。完成下方个人通知设置后，失败邮件由 GitHub 原生 Actions 通知服务发送。

## GitHub 失败邮件通知

GitHub 原生 Actions 邮件同时覆盖“生产站点巡检”和“发布生产环境”。这是 GitHub 用户的个人通知设置，不是仓库 Variable、Secret 或 `production` Environment 配置；其他协作者如需邮件，也要在自己的账户中单独设置。

定时巡检持续失败时，每次运行都可能发送通知，因此最多可能每 30 分钟收到一封失败邮件。邮件可能延迟或被邮箱分类，故障状态仍以仓库 `Actions` 页面为准。

### 一次性配置

1. 确认 GitHub 主邮箱已经验证并且可以正常收信。
2. 在仓库页面确认当前仓库处于 `Watching` 状态。
3. 打开 GitHub 个人 `Settings -> Notifications`。
4. 找到 `System -> Actions`，选择 `Email` 并保存。
5. 完成下方邮件通道验证后，在同一位置启用 `Only notify for failed workflows`，再次保存。

定时 workflow 的通知发送给最初创建该定时 workflow 的用户；如果其他用户修改 `schedule` 的 cron 表达式，后续通知接收人会变为该用户。

### 不制造故障的验证

1. 首次配置时先不要启用 `Only notify for failed workflows`。
2. 在 `main` 上手动运行一次“生产站点巡检”。
3. 等待作业成功，确认 GitHub 绑定邮箱收到包含运行状态的邮件。
4. 回到通知设置，启用 `Only notify for failed workflows` 并保存。
5. 再手动运行一次成功巡检；成功运行不要求发送邮件，今后的失败运行才会发送。

验证过程不要修改 `MONITOR_URL`，不要停止 Nginx，也不要故意破坏生产站点。

### 收不到邮件时

按以下顺序检查：

1. GitHub 主邮箱是否已验证；
2. 邮箱垃圾邮件或自动分类目录；
3. `Settings -> Notifications -> System -> Actions` 是否选择了 `Email`；
4. `Only notify for failed workflows` 是否已保存；
5. 仓库是否处于 `Watching` 状态；
6. 当前用户是否为定时 workflow 的创建者或最近重新启用者。

GitHub 官方说明：[管理 Actions 通知](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)和[工作流运行通知](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)。
```

Do not change the failure-message table or the local validation commands.

- [ ] **Step 3: Run the documentation contract and verify GREEN**

Run:

```bash
bash <<'BASH'
set -euo pipefail

DOC='docs/monitoring.md'
required=(
  '## GitHub 失败邮件通知'
  'Settings -> Notifications'
  'System -> Actions'
  'Only notify for failed workflows'
  '发布生产环境'
  '每 30 分钟收到一封失败邮件'
  'GitHub 主邮箱是否已验证'
)

for text in "${required[@]}"; do
  grep -F -- "$text" "$DOC" >/dev/null || {
    echo "missing notification guide text: $text" >&2
    exit 1
  }
done

if grep -F -- '不表示 GitHub 会发送邮件或微信通知' "$DOC" >/dev/null; then
  echo 'obsolete no-email statement remains' >&2
  exit 1
fi

for forbidden in MAIL_PASSWORD SMTP_PASSWORD WEBHOOK_URL; do
  if grep -F -- "$forbidden" "$DOC" >/dev/null; then
    echo "guide unexpectedly requests a notification credential: $forbidden" >&2
    exit 1
  fi
done

echo 'notification documentation contract passed'
BASH
```

Expected:

```text
notification documentation contract passed
```

- [ ] **Step 4: Prove the executable scope is unchanged**

Run:

```bash
if git diff --name-only -- \
  .github scripts package.json pnpm-lock.yaml | grep -q .; then
  echo 'notification documentation task changed executable scope' >&2
  git diff --name-only -- .github scripts package.json pnpm-lock.yaml >&2
  exit 1
fi

git diff --check
```

Expected: both commands exit `0` without output.

- [ ] **Step 5: Commit the guide**

```bash
git add docs/monitoring.md
git commit -m "docs: add GitHub failure email setup"
```

Expected: the commit contains only `docs/monitoring.md`.

### Task 2: Run Full Repository Verification

**Files:**
- Verify only; no file changes.

- [ ] **Step 1: Run focused monitoring checks**

Run:

```bash
pnpm test:monitor
pnpm vitest run scripts/monitor/workflow.test.ts
```

Expected:

- Python reports `Ran 11 tests` and `OK`.
- Shell integration ends with `check-site.sh: all tests passed`.
- Workflow contract reports `1` test file and `6` tests passed.

The local HTTP integration test binds only a temporary `127.0.0.1` port. If the managed sandbox blocks loopback binding, rerun the same command through the normal approval mechanism; do not weaken or skip the test.

- [ ] **Step 2: Run the full existing quality suite**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:deploy
pnpm build
```

Expected:

- ESLint exits `0` with zero warnings.
- Type checking exits `0`.
- Vitest passes `17` files and `71` tests.
- Deployment integration ends with `manage-release.sh: all tests passed`.
- Vite successfully builds `dist/index.html` and hashed assets.

- [ ] **Step 3: Run final scope and content checks**

Run:

```bash
git diff --check

test -z "$(git diff --name-only 90c193e..HEAD -- \
  .github scripts package.json pnpm-lock.yaml)"

for required in \
  'Only notify for failed workflows' \
  '不发送微信通知' \
  '不要修改 `MONITOR_URL`' \
  '不要停止 Nginx'; do
  grep -F -- "$required" docs/monitoring.md >/dev/null
done

git status --short --branch
```

Expected:

- Diff check exits `0`.
- No executable/config file is listed.
- Every required safety statement is present.
- Worktree is clean except for no uncommitted changes.

## Operational Handoff After Merge

These steps change the user's GitHub account and must not be represented as repository automation:

1. Merge the feature branch to `main` and push `main` to GitHub.
2. Confirm the repository is `Watching`.
3. Open GitHub personal `Settings -> Notifications`.
4. Under `System -> Actions`, select `Email`; initially leave failure-only filtering disabled and save.
5. Manually run `Actions -> 生产站点巡检` on `main`.
6. Wait for the green run and confirm the GitHub account email receives the completion message.
7. Return to `Settings -> Notifications -> System -> Actions`.
8. Enable `Only notify for failed workflows` and save.
9. Optionally run one more successful monitor to confirm no failure notification is expected.
10. Do not change `MONITOR_URL`, GitHub Secrets, the `production` Environment, Nginx, or server files during validation.

The final state accepts repeated failure emails: if the site remains unhealthy, each failed 30-minute scheduled run may send another message.
