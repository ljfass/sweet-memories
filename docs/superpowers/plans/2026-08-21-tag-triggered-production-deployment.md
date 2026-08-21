# 基于 Tag 触发的生产环境自动部署实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 当 `main` 分支历史中的 `v*` Tag 被推送到 GitHub 时，先完成全部质量检查，再把构建产物安全、可回退地发布到阿里云 Nginx 静态目录。

**架构：** `.github/workflows/deploy.yml` 负责 Tag 校验、Vue/Vite 构建、SSH 传输、公网健康检查和并发控制。`scripts/deploy/manage-release.sh` 只负责服务器上的版本解压、软链接原子切换、回退和旧版本清理，并通过独立 Shell 集成测试验证。`docs/deployment.md` 提供不需要预备知识的一次性服务器和 GitHub 配置步骤。

**技术栈：** GitHub Actions、Node.js 24 LTS、pnpm 8.6.1、Vue 3、Vite 8、Vitest、Bash、OpenSSH、Nginx

**设计规范：** `docs/superpowers/specs/2026-08-21-tag-triggered-production-deployment-design.md`

---

## 文件规划

- 创建 `.github/workflows/deploy.yml`：定义 `v*` Tag 触发、`main` 提交校验、质量检查、打包、SSH 发布、健康检查和失败回退。
- 创建 `scripts/deploy/manage-release.sh`：在服务器上执行 `activate`、`rollback` 和 `cleanup` 三种原子发布操作。
- 创建 `scripts/deploy/manage-release.test.sh`：使用临时目录验证成功切换、失败不切换、回退和仅保留 5 个版本。
- 创建 `scripts/deploy/workflow.test.ts`：使用 YAML 解析器验证工作流触发条件、权限、并发、环境和关键安全步骤。
- 修改 `package.json`：增加 `test:deploy` 命令和 YAML 测试依赖。
- 修改 `pnpm-lock.yaml`：锁定 YAML 解析器依赖。
- 创建 `docs/deployment.md`：记录服务器、SSH 密钥、GitHub Environment、Secret、Variable 和首次 Tag 发布操作。

### 任务 1：以测试驱动方式实现服务器版本管理脚本

**文件：**
- 创建：`scripts/deploy/manage-release.test.sh`
- 创建：`scripts/deploy/manage-release.sh`
- 修改：`package.json`

- [ ] **步骤 1：写入失败的 Shell 集成测试**

创建 `scripts/deploy/manage-release.test.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MANAGER="$SCRIPT_DIR/manage-release.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

resolve_path() {
  (cd "$1" && pwd -P)
}

assert_same_path() {
  local actual="$1"
  local expected="$2"
  [[ "$(resolve_path "$actual")" == "$(resolve_path "$expected")" ]] ||
    fail "$actual 没有指向 $expected"
}

make_archive() {
  local label="$1"
  local archive="$2"
  local source_dir
  source_dir="$(mktemp -d "$TEST_DIR/source.XXXXXX")"
  mkdir -p "$source_dir/assets"
  printf '<html>%s</html>\n' "$label" > "$source_dir/index.html"
  printf '%s\n' "$label" > "$source_dir/assets/version.txt"
  tar -C "$source_dir" -czf "$archive" .
  rm -rf "$source_dir"
}

SITE_ROOT="$TEST_DIR/site"
mkdir -p "$SITE_ROOT/releases/initial"
printf '<html>initial</html>\n' > "$SITE_ROOT/releases/initial/index.html"
ln -s "$SITE_ROOT/releases/initial" "$SITE_ROOT/html"

SHA_A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
ARCHIVE_A="$TEST_DIR/release-a.tar.gz"
make_archive 'release-a' "$ARCHIVE_A"
bash "$MANAGER" activate "$SITE_ROOT" "$SHA_A" "$ARCHIVE_A"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
assert_same_path "$SITE_ROOT/previous" "$SITE_ROOT/releases/initial"
[[ "$(cat "$SITE_ROOT/html/assets/version.txt")" == 'release-a' ]] ||
  fail '新版本内容不正确'

SHA_B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
BAD_ARCHIVE="$TEST_DIR/release-b.tar.gz"
BAD_SOURCE="$TEST_DIR/bad-source"
mkdir -p "$BAD_SOURCE/assets"
printf 'missing index\n' > "$BAD_SOURCE/assets/version.txt"
tar -C "$BAD_SOURCE" -czf "$BAD_ARCHIVE" .
if bash "$MANAGER" activate "$SITE_ROOT" "$SHA_B" "$BAD_ARCHIVE"; then
  fail '缺少 index.html 的发布不应成功'
fi
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
[[ ! -e "$SITE_ROOT/releases/$SHA_B" ]] || fail '无效版本目录没有清理'

SHA_C='cccccccccccccccccccccccccccccccccccccccc'
ARCHIVE_C="$TEST_DIR/release-c.tar.gz"
make_archive 'release-c' "$ARCHIVE_C"
bash "$MANAGER" activate "$SITE_ROOT" "$SHA_C" "$ARCHIVE_C"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_C"
assert_same_path "$SITE_ROOT/previous" "$SITE_ROOT/releases/$SHA_A"
bash "$MANAGER" rollback "$SITE_ROOT"
assert_same_path "$SITE_ROOT/html" "$SITE_ROOT/releases/$SHA_A"
assert_same_path "$SITE_ROOT/previous" "$SITE_ROOT/releases/$SHA_C"

CLEANUP_ROOT="$TEST_DIR/cleanup-site"
mkdir -p "$CLEANUP_ROOT/releases"
for number in 1 2 3 4 5 6 7; do
  release="$CLEANUP_ROOT/releases/release-$number"
  mkdir -p "$release"
  printf '<html>%s</html>\n' "$number" > "$release/index.html"
  touch -t "2026010${number}0000" "$release"
done
ln -s "$CLEANUP_ROOT/releases/release-7" "$CLEANUP_ROOT/html"
ln -s "$CLEANUP_ROOT/releases/release-6" "$CLEANUP_ROOT/previous"
bash "$MANAGER" cleanup "$CLEANUP_ROOT" 5
[[ ! -e "$CLEANUP_ROOT/releases/release-1" ]] || fail '最旧版本 1 未删除'
[[ ! -e "$CLEANUP_ROOT/releases/release-2" ]] || fail '最旧版本 2 未删除'
for number in 3 4 5 6 7; do
  [[ -d "$CLEANUP_ROOT/releases/release-$number" ]] ||
    fail "应保留的版本 $number 被删除"
done

printf 'manage-release.sh: all tests passed\n'
```

- [ ] **步骤 2：运行测试并确认它因实现文件不存在而失败**

运行：

```bash
bash scripts/deploy/manage-release.test.sh
```

预期：退出码非 `0`，并提示 `manage-release.sh` 不存在。

- [ ] **步骤 3：实现最小可用的版本管理脚本**

创建 `scripts/deploy/manage-release.sh`：

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'deploy error: %s\n' "$1" >&2
  exit 1
}

canonical_dir() {
  (cd "$1" && pwd -P)
}

resolve_link() {
  local link_path="$1"
  local target
  [[ -L "$link_path" ]] || die "$link_path 不是软链接"
  target="$(readlink "$link_path")"
  if [[ "$target" != /* ]]; then
    target="$(dirname "$link_path")/$target"
  fi
  canonical_dir "$target"
}

replace_symlink() {
  local target="$1"
  local link_path="$2"
  local temp_link="$3"
  [[ -d "$target" ]] || die "软链接目标不存在：$target"
  rm -f "$temp_link"
  ln -s "$target" "$temp_link"
  if mv --help 2>&1 | grep -q -- ' -T'; then
    mv -Tf "$temp_link" "$link_path"
  else
    mv -h -f "$temp_link" "$link_path"
  fi
}

validate_site_root() {
  local site_root="$1"
  [[ "$site_root" == /* ]] || die '站点目录必须是绝对路径'
  [[ -d "$site_root/releases" ]] || die "$site_root/releases 不存在"
  [[ -L "$site_root/html" ]] || die "$site_root/html 必须是软链接"
}

activate() {
  local site_root="$1"
  local release_sha="$2"
  local archive="$3"
  local releases release_dir staging current

  validate_site_root "$site_root"
  [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || die '提交哈希必须是 40 位小写十六进制字符'
  [[ -f "$archive" ]] || die "发布压缩包不存在：$archive"

  releases="$(canonical_dir "$site_root/releases")"
  release_dir="$releases/$release_sha"
  staging="$releases/.incoming-$release_sha"
  current="$(resolve_link "$site_root/html")"

  if [[ ! -d "$release_dir" ]]; then
    rm -rf "$staging"
    mkdir -p "$staging"
    if ! tar -xzf "$archive" -C "$staging"; then
      rm -rf "$staging"
      die '发布压缩包无法解压'
    fi
    if [[ ! -f "$staging/index.html" ]]; then
      rm -rf "$staging"
      die '发布产物缺少 index.html'
    fi
    chmod -R u=rwX,go=rX "$staging"
    mv "$staging" "$release_dir"
  fi

  [[ -f "$release_dir/index.html" ]] || die '目标版本缺少 index.html'
  rm -f "$archive"
  touch "$release_dir"

  if [[ "$current" == "$(canonical_dir "$release_dir")" ]]; then
    printf 'release already active: %s\n' "$release_sha"
    return
  fi

  replace_symlink "$current" "$site_root/previous" "$site_root/.previous-next-$release_sha"
  replace_symlink "$release_dir" "$site_root/html" "$site_root/.html-next-$release_sha"
  printf 'activated release: %s\n' "$release_sha"
}

rollback() {
  local site_root="$1"
  local current previous marker
  validate_site_root "$site_root"
  [[ -L "$site_root/previous" ]] || die '没有可回退版本'
  current="$(resolve_link "$site_root/html")"
  previous="$(resolve_link "$site_root/previous")"
  marker="$(basename "$previous")"
  replace_symlink "$current" "$site_root/previous" "$site_root/.previous-rollback-$marker"
  replace_symlink "$previous" "$site_root/html" "$site_root/.html-rollback-$marker"
  printf 'rolled back to: %s\n' "$previous"
}

cleanup() {
  local site_root="$1"
  local keep_count="$2"
  local releases current previous position candidate canonical_candidate
  local release_dirs=()

  validate_site_root "$site_root"
  [[ "$keep_count" =~ ^[1-9][0-9]*$ ]] || die '保留版本数量必须是正整数'
  releases="$(canonical_dir "$site_root/releases")"
  current="$(resolve_link "$site_root/html")"
  previous=''
  if [[ -L "$site_root/previous" ]]; then
    previous="$(resolve_link "$site_root/previous")"
  fi

  shopt -s nullglob
  release_dirs=("$releases"/*)
  shopt -u nullglob
  [[ ${#release_dirs[@]} -gt 0 ]] || return

  position=0
  while IFS= read -r candidate; do
    position=$((position + 1))
    [[ $position -le $keep_count ]] && continue
    [[ -d "$candidate" ]] || continue
    canonical_candidate="$(canonical_dir "$candidate")"
    if [[ "$canonical_candidate" != "$current" && "$canonical_candidate" != "$previous" ]]; then
      rm -rf "$canonical_candidate"
      printf 'removed old release: %s\n' "$canonical_candidate"
    fi
  done < <(ls -1dt "${release_dirs[@]}")
}

mode="${1:-}"
case "$mode" in
  activate)
    [[ $# -eq 4 ]] || die '用法：manage-release.sh activate <站点目录> <提交哈希> <压缩包>'
    activate "$2" "$3" "$4"
    ;;
  rollback)
    [[ $# -eq 2 ]] || die '用法：manage-release.sh rollback <站点目录>'
    rollback "$2"
    ;;
  cleanup)
    [[ $# -eq 3 ]] || die '用法：manage-release.sh cleanup <站点目录> <保留数量>'
    cleanup "$2" "$3"
    ;;
  *)
    die '模式必须是 activate、rollback 或 cleanup'
    ;;
esac
```

- [ ] **步骤 4：把 Shell 测试加入项目命令**

在 `package.json` 的 `scripts` 中加入：

```json
"test:deploy": "bash scripts/deploy/manage-release.test.sh"
```

- [ ] **步骤 5：验证脚本语法和行为**

运行：

```bash
bash -n scripts/deploy/manage-release.sh
bash -n scripts/deploy/manage-release.test.sh
pnpm test:deploy
```

预期：两个语法检查退出码均为 `0`，最后输出 `manage-release.sh: all tests passed`。

- [ ] **步骤 6：提交版本管理脚本**

```bash
git add package.json scripts/deploy/manage-release.sh scripts/deploy/manage-release.test.sh
git commit -m "feat: add atomic release manager"
```

### 任务 2：以测试驱动方式添加 GitHub Actions 工作流

**文件：**
- 创建：`scripts/deploy/workflow.test.ts`
- 创建：`.github/workflows/deploy.yml`
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：安装结构化 YAML 解析器**

运行：

```bash
pnpm add --save-dev yaml
```

预期：`package.json` 的 `devDependencies` 出现 `yaml`，`pnpm-lock.yaml` 同步更新。

- [ ] **步骤 2：写入失败的工作流结构测试**

创建 `scripts/deploy/workflow.test.ts`：

```ts
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  id?: string
  name?: string
  uses?: string
  run?: string
}

interface DeploymentWorkflow {
  on: { push: { tags: string[] } }
  permissions: { contents: string }
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: {
    deploy: {
      environment: { name: string; url: string }
      steps: WorkflowStep[]
    }
  }
}

const workflowPath = '.github/workflows/deploy.yml'

function readWorkflow() {
  return parse(readFileSync(workflowPath, 'utf8')) as DeploymentWorkflow
}

function stepById(workflow: DeploymentWorkflow, id: string) {
  return workflow.jobs.deploy.steps.find((step) => step.id === id)
}

describe('production deployment workflow', () => {
  it('only triggers for v-prefixed tags with read-only repository access', () => {
    const workflow = readWorkflow()

    expect(workflow.on).toEqual({ push: { tags: ['v*'] } })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'sweet-memories-production',
      'cancel-in-progress': false,
    })
  })

  it('uses the production environment and validates main before building', () => {
    const workflow = readWorkflow()
    const validation = stepById(workflow, 'validate-main')

    expect(workflow.jobs.deploy.environment).toEqual({
      name: 'production',
      url: '${{ vars.PRODUCTION_URL }}',
    })
    expect(validation?.run).toContain('git merge-base --is-ancestor')
    expect(validation?.run).toContain('origin/main')
  })

  it('contains activation, health-check rollback, and cleanup steps', () => {
    const workflow = readWorkflow()

    expect(stepById(workflow, 'activate')?.run).toContain('activate')
    expect(stepById(workflow, 'health-check')?.run).toContain('rollback')
    expect(stepById(workflow, 'cleanup')?.run).toContain('cleanup')
    expect(JSON.stringify(workflow)).toContain('StrictHostKeyChecking yes')
  })
})
```

- [ ] **步骤 3：运行测试并确认工作流文件缺失**

运行：

```bash
pnpm test -- scripts/deploy/workflow.test.ts
```

预期：FAIL，并报告无法读取 `.github/workflows/deploy.yml`。

- [ ] **步骤 4：实现生产部署工作流**

创建 `.github/workflows/deploy.yml`：

```yaml
name: 发布生产环境

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read

concurrency:
  group: sweet-memories-production
  cancel-in-progress: false

jobs:
  deploy:
    name: 检查并部署
    runs-on: ubuntu-latest
    environment:
      name: production
      url: ${{ vars.PRODUCTION_URL }}
    env:
      SITE_ROOT: /var/www/huangjianfen.cn
      REMOTE_ARCHIVE: /tmp/sweet-memories-${{ github.sha }}.tar.gz
    steps:
      - name: 检出 Tag 对应代码
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: 验证提交已经进入 main
        id: validate-main
        shell: bash
        run: |
          set -euo pipefail
          git fetch origin main:refs/remotes/origin/main --no-tags
          if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then
            echo "Tag 指向的提交尚未进入 main，拒绝部署。" >&2
            exit 1
          fi

      - name: 安装 Node.js
        uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: 安装项目指定的 pnpm
        run: npm install --global pnpm@8.6.1

      - name: 安装依赖
        run: pnpm install --frozen-lockfile

      - name: 类型检查
        run: pnpm typecheck

      - name: 代码检查
        run: pnpm lint

      - name: 单元测试
        run: pnpm test

      - name: 部署脚本测试
        run: pnpm test:deploy

      - name: 生产构建
        run: pnpm build

      - name: 打包构建产物
        shell: bash
        run: tar -C dist -czf "$RUNNER_TEMP/release.tar.gz" .

      - name: 校验部署配置
        shell: bash
        env:
          ALIYUN_HOST: ${{ secrets.ALIYUN_HOST }}
          ALIYUN_SSH_PORT: ${{ secrets.ALIYUN_SSH_PORT }}
          ALIYUN_USER: ${{ secrets.ALIYUN_USER }}
          PRODUCTION_URL: ${{ vars.PRODUCTION_URL }}
        run: |
          set -euo pipefail
          : "${ALIYUN_HOST:?缺少 ALIYUN_HOST}"
          : "${ALIYUN_SSH_PORT:?缺少 ALIYUN_SSH_PORT}"
          : "${ALIYUN_USER:?缺少 ALIYUN_USER}"
          : "${PRODUCTION_URL:?缺少 PRODUCTION_URL}"
          [[ "$ALIYUN_SSH_PORT" =~ ^[0-9]{1,5}$ ]]
          [[ "$PRODUCTION_URL" =~ ^https?:// ]]

      - name: 配置 SSH
        shell: bash
        env:
          ALIYUN_HOST: ${{ secrets.ALIYUN_HOST }}
          ALIYUN_SSH_PORT: ${{ secrets.ALIYUN_SSH_PORT }}
          ALIYUN_USER: ${{ secrets.ALIYUN_USER }}
          SSH_PRIVATE_KEY: ${{ secrets.ALIYUN_SSH_PRIVATE_KEY }}
          SSH_KNOWN_HOSTS: ${{ secrets.ALIYUN_KNOWN_HOSTS }}
        run: |
          set -euo pipefail
          umask 077
          : "${SSH_PRIVATE_KEY:?缺少 ALIYUN_SSH_PRIVATE_KEY}"
          : "${SSH_KNOWN_HOSTS:?缺少 ALIYUN_KNOWN_HOSTS}"
          mkdir -p "$HOME/.ssh"
          printf '%s\n' "$SSH_PRIVATE_KEY" > "$HOME/.ssh/id_ed25519"
          printf '%s\n' "$SSH_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
          ssh-keygen -y -f "$HOME/.ssh/id_ed25519" >/dev/null
          cat > "$HOME/.ssh/config" <<CONFIG
          Host production
            HostName $ALIYUN_HOST
            User $ALIYUN_USER
            Port $ALIYUN_SSH_PORT
            IdentityFile $HOME/.ssh/id_ed25519
            UserKnownHostsFile $HOME/.ssh/known_hosts
            BatchMode yes
            IdentitiesOnly yes
            StrictHostKeyChecking yes
            ConnectTimeout 15
          CONFIG

      - name: 上传发布产物
        run: scp "$RUNNER_TEMP/release.tar.gz" "production:$REMOTE_ARCHIVE"

      - name: 原子启用新版本
        id: activate
        shell: bash
        run: |
          set -euo pipefail
          ssh production bash -s -- activate "$SITE_ROOT" "$GITHUB_SHA" "$REMOTE_ARCHIVE" \
            < scripts/deploy/manage-release.sh

      - name: 公网健康检查并在失败时回退
        id: health-check
        shell: bash
        env:
          PRODUCTION_URL: ${{ vars.PRODUCTION_URL }}
        run: |
          set -euo pipefail
          if curl --fail --silent --show-error \
            --retry 5 --retry-delay 2 --retry-all-errors \
            "$PRODUCTION_URL" >/dev/null; then
            exit 0
          fi
          echo '公网健康检查失败，开始回退。' >&2
          ssh production bash -s -- rollback "$SITE_ROOT" \
            < scripts/deploy/manage-release.sh
          exit 1

      - name: 清理旧版本
        id: cleanup
        shell: bash
        run: |
          set -euo pipefail
          ssh production bash -s -- cleanup "$SITE_ROOT" 5 \
            < scripts/deploy/manage-release.sh
```

- [ ] **步骤 5：验证结构测试和完整项目测试**

运行：

```bash
pnpm test -- scripts/deploy/workflow.test.ts
pnpm test
pnpm test:deploy
```

预期：全部通过；工作流测试共 3 个用例通过。

- [ ] **步骤 6：提交工作流和测试**

```bash
git add .github/workflows/deploy.yml scripts/deploy/workflow.test.ts package.json pnpm-lock.yaml
git commit -m "ci: deploy production tags to Alibaba Cloud"
```

### 任务 3：编写面向初学者的部署配置指南

**文件：**
- 创建：`docs/deployment.md`

- [ ] **步骤 1：写入完整的部署指南**

创建 `docs/deployment.md`，按以下顺序写出可以直接执行的内容：

````markdown
# 自动部署配置指南

## 发布结果

只有已进入 `main` 的 `v*` Tag 才能发布。GitHub 会先完成类型检查、代码检查、测试和构建，再通过 SSH 把完整版本发布到 `/var/www/huangjianfen.cn`。任何构建或上传失败都不会切换线上版本；公网检查失败会自动回退。

## 第一步：在本地生成专用 SSH 密钥

在 Mac 终端运行：

```bash
ssh-keygen -t ed25519 -C "github-actions-sweet-memories" -f "$HOME/.ssh/sweet-memories-github-actions" -N ''
cat "$HOME/.ssh/sweet-memories-github-actions.pub"
```

记住第二条命令显示的整行公钥。私钥文件是 `$HOME/.ssh/sweet-memories-github-actions`，不能发送给其他人，也不能加入 Git 仓库。

## 第二步：检查服务器 SSH 配置

打开阿里云服务器终端，运行：

```bash
sudo sshd -T | awk '$1 == "port" { print $2 }'
getent group www-data
sudo test -d /var/www/huangjianfen.cn/html && echo '静态目录存在'
```

预期依次看到 SSH 端口（通常是 `22`）、`www-data` 用户组信息和“静态目录存在”。如果端口不是 `22`，后续所有端口值都使用实际输出。

## 第三步：创建 deploy 用户并安装公钥

在服务器终端运行：

```bash
id deploy >/dev/null 2>&1 || sudo adduser --disabled-password --gecos '' deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
read -r -p '粘贴完整公钥后按回车：' SWEET_MEMORIES_DEPLOY_PUBLIC_KEY
printf '%s\n' "$SWEET_MEMORIES_DEPLOY_PUBLIC_KEY" |
  sudo tee /home/deploy/.ssh/authorized_keys >/dev/null
unset SWEET_MEMORIES_DEPLOY_PUBLIC_KEY
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

粘贴内容必须以 `ssh-ed25519` 开头，并以 `github-actions-sweet-memories` 结尾。

## 第四步：把现有 html 目录改为版本软链接

先确认网站当前正常，再把下面整段粘贴到服务器终端：

```bash
set -euo pipefail
SWEET_MEMORIES_ROOT=/var/www/huangjianfen.cn
SWEET_MEMORIES_INITIAL="$SWEET_MEMORIES_ROOT/releases/initial-$(date +%Y%m%d%H%M%S)"
sudo test -d "$SWEET_MEMORIES_ROOT/html"
sudo test ! -L "$SWEET_MEMORIES_ROOT/html"
sudo install -d -m 755 -o deploy -g www-data "$SWEET_MEMORIES_ROOT/releases"
sudo mv "$SWEET_MEMORIES_ROOT/html" "$SWEET_MEMORIES_INITIAL"
sudo chown deploy:www-data "$SWEET_MEMORIES_ROOT"
sudo chown -R deploy:www-data "$SWEET_MEMORIES_ROOT/releases"
sudo find "$SWEET_MEMORIES_ROOT/releases" -type d -exec chmod 755 {} +
sudo find "$SWEET_MEMORIES_ROOT/releases" -type f -exec chmod 644 {} +
sudo -u deploy ln -s "$SWEET_MEMORIES_INITIAL" "$SWEET_MEMORIES_ROOT/html"
curl --fail --silent --show-error http://8.163.27.231 >/dev/null
readlink -f "$SWEET_MEMORIES_ROOT/html"
```

最后一行应显示 `/var/www/huangjianfen.cn/releases/initial-日期时间`。如果中间命令报错，不要重复执行整段，先根据报错定位当前停在哪一步。

## 第五步：验证 deploy 用户可以登录

回到 Mac 终端运行：

```bash
ssh -i "$HOME/.ssh/sweet-memories-github-actions" -p 22 deploy@8.163.27.231 'whoami && test -w /var/www/huangjianfen.cn && echo 可部署'
```

预期输出 `deploy` 和“可部署”。如果实际 SSH 端口不是 `22`，替换 `-p` 后的数字。连接超时时，在阿里云安全组中添加允许外部访问实际 SSH 端口的入方向 TCP 规则；GitHub 托管执行器没有固定的单一出口 IP，因此该规则需要覆盖 GitHub 公布的 Actions 地址范围，或在接受密钥登录保护的前提下允许公网访问该 SSH 端口。

## 第六步：生成并核对 known_hosts

先在服务器终端查看真实主机密钥指纹：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

再在 Mac 终端运行：

```bash
ssh-keyscan -p 22 -t ed25519 8.163.27.231 > /tmp/sweet-memories-known-hosts
ssh-keygen -lf /tmp/sweet-memories-known-hosts
cat /tmp/sweet-memories-known-hosts
```

两处显示的 SHA256 指纹必须完全相同。端口不是 `22` 时，两条相关命令都使用实际端口。只有指纹一致时，才使用 `cat` 输出作为 GitHub Secret。

## 第七步：配置 GitHub production 环境

进入 GitHub 仓库，依次打开 `Settings`、`Environments`、`New environment`，名称填写 `production`。

在 `production` 的 Environment secrets 中添加：

| 名称 | 值 |
| --- | --- |
| `ALIYUN_HOST` | `8.163.27.231` |
| `ALIYUN_SSH_PORT` | 实际 SSH 端口数字 |
| `ALIYUN_USER` | `deploy` |
| `ALIYUN_SSH_PRIVATE_KEY` | Mac 上运行 `cat "$HOME/.ssh/sweet-memories-github-actions"` 得到的完整多行内容 |
| `ALIYUN_KNOWN_HOSTS` | Mac 上运行 `cat /tmp/sweet-memories-known-hosts` 得到的完整一行内容 |

在 Environment variables 中添加：

| 名称 | 值 |
| --- | --- |
| `PRODUCTION_URL` | `http://8.163.27.231` |

如果私有仓库当前套餐不支持 Environment secrets，就把同名 Secret 配置到 `Settings`、`Secrets and variables`、`Actions` 的 Repository secrets 中，并把 `PRODUCTION_URL` 配置为 Repository variable；工作流仍然保留 `production` 环境名称。

## 第八步：发布第一个版本

确认代码已经推送到 `main`，然后在项目目录运行：

```bash
git switch main
git pull --ff-only
git tag -a v1.0.0 -m '发布 v1.0.0'
git push origin v1.0.0
```

进入 GitHub 仓库的 `Actions` 页面，打开“发布生产环境”任务。所有步骤变绿后访问 `http://8.163.27.231`。

服务器上可以用以下命令核对版本：

```bash
readlink -f /var/www/huangjianfen.cn/html
ls -1dt /var/www/huangjianfen.cn/releases/*
```

`html` 应指向以本次 Git 提交哈希命名的目录。

## 后续发布

每次先把改动合并并推送到 `main`，再递增版本号并推送新 Tag。已经推送的 Tag 不要删除后重新指向其他提交。
````

- [ ] **步骤 2：检查指南中的命令、路径和变量名**

运行：

```bash
rg -n 'ALIYUN_|PRODUCTION_URL|/var/www/huangjianfen.cn|8\.163\.27\.231|sweet-memories-github-actions' docs/deployment.md
```

预期：所有名称都与 `.github/workflows/deploy.yml` 一致，且文档中不包含真实私钥内容。

- [ ] **步骤 3：提交部署指南**

```bash
git add docs/deployment.md
git commit -m "docs: add production deployment guide"
```

### 任务 4：执行完整的本地验收

**文件：**
- 验证：`.github/workflows/deploy.yml`
- 验证：`scripts/deploy/manage-release.sh`
- 验证：`scripts/deploy/manage-release.test.sh`
- 验证：`scripts/deploy/workflow.test.ts`
- 验证：`docs/deployment.md`

- [ ] **步骤 1：运行全部自动化检查**

运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:deploy
pnpm build
bash -n scripts/deploy/manage-release.sh
bash -n scripts/deploy/manage-release.test.sh
git diff --check
```

预期：所有命令退出码均为 `0`，Vitest 和 Shell 测试全部通过，Vite 成功生成 `dist/`。

- [ ] **步骤 2：确认没有凭据进入仓库**

运行：

```bash
if git grep -n -E 'BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|ALIYUN_SSH_PRIVATE_KEY=.+' -- ':!docs/superpowers'; then
  echo '发现疑似私钥或硬编码 Secret' >&2
  exit 1
fi
```

预期：退出码为 `0` 且没有匹配输出。

- [ ] **步骤 3：检查最终改动范围**

运行：

```bash
git status --short
git log -5 --oneline
```

预期：仅出现本计划列出的自动部署相关文件；最近提交包含版本管理脚本、工作流和部署指南。

### 任务 5：完成服务器和 GitHub 的一次性配置

**外部配置：**
- 阿里云 Ubuntu 服务器
- GitHub 仓库 `production` Environment
- 本地 `$HOME/.ssh/sweet-memories-github-actions` 专用密钥

- [ ] **步骤 1：按照 `docs/deployment.md` 第一至第六步配置服务器和密钥**

预期：以下本地命令输出 `deploy` 和“可部署”：

```bash
ssh -i "$HOME/.ssh/sweet-memories-github-actions" -p 22 deploy@8.163.27.231 'whoami && test -w /var/www/huangjianfen.cn && echo 可部署'
```

- [ ] **步骤 2：按照指南第七步配置 5 个 Secret 和 1 个 Variable**

预期：GitHub `production` 环境显示 `ALIYUN_HOST`、`ALIYUN_SSH_PORT`、`ALIYUN_USER`、`ALIYUN_SSH_PRIVATE_KEY`、`ALIYUN_KNOWN_HOSTS`，以及 `PRODUCTION_URL`；Secret 的值不会在页面中回显。

- [ ] **步骤 3：验证当前网站在软链接迁移后仍然可访问**

运行：

```bash
curl --fail --silent --show-error http://8.163.27.231 >/dev/null
```

预期：退出码为 `0`。

### 任务 6：执行首个 Tag 发布并验收

**外部状态：**
- GitHub Actions 运行记录
- 阿里云 `/var/www/huangjianfen.cn/releases`

- [ ] **步骤 1：确认发布提交已经推送到 main**

运行：

```bash
git switch main
git pull --ff-only
git status --short
```

预期：分支与远程同步，工作区没有未提交改动。

- [ ] **步骤 2：创建并推送第一个发布 Tag**

运行：

```bash
git tag -a v1.0.0 -m '发布 v1.0.0'
git push origin v1.0.0
```

预期：GitHub Actions 自动出现“发布生产环境”运行记录。

- [ ] **步骤 3：核对 Actions 和公网结果**

预期：`validate-main`、类型检查、代码检查、单元测试、部署脚本测试、生产构建、上传、启用、健康检查和清理步骤全部成功，访问 `http://8.163.27.231` 显示新版本。

- [ ] **步骤 4：核对服务器版本指针和保留目录**

在服务器运行：

```bash
readlink -f /var/www/huangjianfen.cn/html
readlink -f /var/www/huangjianfen.cn/previous
ls -1dt /var/www/huangjianfen.cn/releases/*
```

预期：`html` 指向与 Tag 提交 SHA 相同的目录，`previous` 指向发布前版本，版本目录总数不超过 5。

- [ ] **步骤 5：验证普通分支推送不会创建部署任务**

检查 GitHub Actions 触发记录，确认没有由普通 `main` 分支 push 创建“发布生产环境”运行。
