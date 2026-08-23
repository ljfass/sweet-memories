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
  '不是仓库级广播'
  'Tag push'
  'Default notifications email'
  'Watch -> All Activity'
  '只会收到由自己触发的 workflow run 完成通知'
  '触发该运行的用户'
  '初始创建者'
  'cron 修改者'
  '重新启用者'
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

for obsolete in 'GitHub 主邮箱' '设置为 `Watching`'; do
  if grep -F -- "$obsolete" "$DOC" >/dev/null; then
    echo "obsolete notification setup text remains: $obsolete" >&2
    exit 1
  fi
done
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
巡检本身不会自动重启、回滚或修改服务器，也不会发送微信通知；完成下面的个人设置后，失败邮件由 GitHub 原生 Actions 通知发送。

## GitHub 失败邮件通知

GitHub Actions 通知不是仓库级广播。启用邮件后，每位用户只会收到由自己触发的 workflow run 完成通知，不会收到其他协作者触发的全部运行通知。`生产站点巡检` 和 `发布生产环境` 都遵循这条规则：对本项目，手动触发和 Tag push 部署的通知接收人是触发该运行的用户；定时巡检按下文的 actor 规则确定。

这是每个用户自己的 GitHub 通知设置，不是仓库 Variable、Secret 或 `production` Environment 配置。每位协作者单独配置，只决定自己能否收到属于自己的通知，并不代表可以订阅其他协作者触发的全部运行。

生产站点持续失败时，每次定时运行都可能触发邮件，因此最多可能每 30 分钟收到一封失败邮件。邮件可能延迟，也可能被邮箱过滤；GitHub Actions 页面始终是运行状态的准确信息来源。

### 一次性配置

1. 打开 GitHub 个人 `Settings -> Notifications`。
2. 在 `Default notifications email` 中选择一个已验证、当前可以正常收信的邮箱，然后保存。
3. 在仓库页面选择 `Watch -> All Activity`。
4. 在 `System -> Actions` 中选择 `Email`，然后保存。
5. 完成下文的送达测试后，启用 `Only notify for failed workflows`，然后再次保存。

定时巡检的通知接收人遵循 actor 规则：默认是初始创建者；其他用户修改 cron 后，后续通知转给该 cron 修改者；定时 workflow 被禁用后重新启用，通知则转给重新启用者，而不是之前的 cron 修改者。

### 不制造故障的验证

1. 开始验证时先不要选择 `Only notify for failed workflows`。
2. 使用准备验证收件的同一个 GitHub 用户，在 `main` 分支手动运行 `生产站点巡检`。
3. 确认运行结果为绿色，并确认该触发者收到运行完成邮件。
4. 启用 `Only notify for failed workflows` 并保存。
5. 再手动运行一次绿色巡检；此时不要求收到成功邮件，后续失败运行会发送邮件通知。
6. 不要为了测试而修改 `MONITOR_URL`、停止 Nginx 或破坏生产环境。

### 收不到邮件时

1. 检查 `Settings -> Notifications` 中的 `Default notifications email` 是否选择了已验证且可正常收信的邮箱。
2. 检查垃圾邮件、推广邮件等分类和邮箱过滤规则。
3. 检查 `System -> Actions` 是否仍选择了 `Email`。
4. 检查 `Only notify for failed workflows` 是否已保存。
5. 检查仓库是否仍选择了 `Watch -> All Activity`。
6. 对于手动触发或 Tag push，检查当前用户是否为该运行的触发者；对于定时巡检，检查当前用户是否为初始创建者、cron 修改者或重新启用者。

GitHub 官方说明：

- [管理 GitHub Actions 通知](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)
- [工作流运行通知](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)
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
  '不是仓库级广播'
  'Tag push'
  'Default notifications email'
  'Watch -> All Activity'
  '只会收到由自己触发的 workflow run 完成通知'
  '触发该运行的用户'
  '初始创建者'
  'cron 修改者'
  '重新启用者'
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

for obsolete in 'GitHub 主邮箱' '设置为 `Watching`'; do
  if grep -F -- "$obsolete" "$DOC" >/dev/null; then
    echo "obsolete notification setup text remains: $obsolete" >&2
    exit 1
  fi
done

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
set -euo pipefail

git diff --check

test -z "$(git diff --name-only 90c193e..HEAD -- \
  .github scripts package.json pnpm-lock.yaml)"

for required in \
  'Only notify for failed workflows' \
  '不会发送微信通知' \
  '不要为了测试而修改 `MONITOR_URL`' \
  '停止 Nginx 或破坏生产环境'; do
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
2. Open GitHub personal `Settings -> Notifications`; under `Default notifications email`, select a verified address that can receive mail and save.
3. On the repository page, select `Watch -> All Activity`.
4. Under `System -> Actions`, select `Email`; initially leave failure-only filtering disabled and save.
5. Using the same GitHub user that should receive the test message, manually run `Actions -> 生产站点巡检` on `main`.
6. Wait for the green run and confirm that triggering user receives the completion message.
7. Return to `Settings -> Notifications -> System -> Actions`.
8. Enable `Only notify for failed workflows` and save.
9. Optionally run one more successful monitor to confirm no failure notification is expected.
10. Do not change `MONITOR_URL`, GitHub Secrets, the `production` Environment, Nginx, or server files during validation.

Actions notifications are not repository-wide broadcasts. For manual runs and Tag push deployments, only the user who triggers that workflow run receives its completion notification. Scheduled monitor notifications go to the initial creator, then a cron modifier, or the user who re-enables the workflow according to GitHub's actor rules.

The final state accepts repeated failure emails: if the site remains unhealthy, each failed 30-minute scheduled run may send another message.
