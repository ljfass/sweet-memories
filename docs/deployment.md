# 生产环境自动部署指南

本文用于第一次配置 GitHub Actions 自动部署，也用于以后发版时查阅。示例服务器是 Ubuntu 24.04，公网 IP 是 `8.163.27.231`，Nginx 当前读取 `/var/www/huangjianfen.cn/html`。

## 1. 最终会怎样工作

完成一次性配置后，发布过程如下：

1. 代码先合并到远程 `main`。
2. 在 `main` 历史中的某个提交上创建以 `v` 开头的 Tag，例如 `v1.0.0`，再把 Tag 推送到 GitHub。
3. GitHub Actions 检出 Tag 准确指向的代码，并确认该提交属于 `origin/main` 历史。
4. 工作流依次运行类型检查、代码检查、单元测试、部署脚本测试和生产构建。
5. 全部通过后，构建产物上传到服务器的临时目录，并解压到 `/var/www/huangjianfen.cn/releases/<40位提交SHA>`。
6. 发布脚本原子切换 `html` 软链接，公网健康检查成功后保留新版本；如果新版本已经切换但健康检查失败，则自动切回 `previous`。
7. 清理较旧版本，正常情况下保留最近 5 个发布目录，并保护正在使用的版本和上一个版本。

只有 `v*` Tag 会触发生产部署。普通分支推送不会触发；即使在功能分支上创建了 `v*` Tag，只要该 Tag 指向的提交还没有进入远程 `main`，任务也会明确失败。

整个自动部署工作分成 6 个主 Task：

| Task | 内容 | 状态或负责人 |
| --- | --- | --- |
| 1 | 编写并测试服务器发布脚本 | 仓库已经完成 |
| 2 | 编写并测试 GitHub Actions 工作流 | 仓库已经完成 |
| 3 | 编写新手部署指南 | 就是本文 |
| 4 | 完整本地验证和代码审查 | 由项目开发流程完成 |
| 5 | 配置服务器、SSH 和 GitHub Environment | 需要你只手工做一次 |
| 6 | 推送第一个 Tag 并核对线上结果 | 完成 Task 5 后由你操作 |

### 仓库已经自动完成的配置

- `.github/workflows/deploy.yml`：只响应 `v*` Tag，校验 `main`、测试、构建、上传、切换、健康检查和清理。
- `scripts/deploy/manage-release.sh`：启用版本、回退版本、清理旧版本。
- `scripts/deploy/manage-release.test.sh` 和 `scripts/deploy/workflow.test.ts`：保护发布脚本和工作流的关键行为。

### 你仍需一次性手工完成的配置

- 备份现有站点。
- 创建专用 SSH 密钥和服务器 `deploy` 用户。
- 把现有普通 `html` 目录迁移为软链接结构。
- 核验服务器 SSH 主机指纹。
- 在 GitHub 配置 `production` Environment、Secrets 和 Variable。
- 确认阿里云安全组允许 GitHub Actions 连接实际 SSH 端口。
- 推送第一个发布 Tag 并检查结果。

## 2. 开始前的准备清单

以下条件缺一项都先不要发 Tag：

- 能使用现有管理员账号 SSH 登录服务器，并能执行 `sudo`。
- 已给当前网站做可恢复的备份。建议先在阿里云控制台创建磁盘快照，再按下文复制一份当前 `html`。
- 能打开 GitHub 仓库的 `Settings`，有权限管理 Actions、Environments、Secrets 和 Variables。
- 阿里云安全组、防火墙和 SSH 服务允许从外部连接实际 SSH 端口。默认端口通常是 `22`，但必须以下文预检结果为准。
- 当前公网地址 `http://8.163.27.231` 可以正常打开。
- 本机已安装 `git`、`ssh`、`scp`、`ssh-keygen` 和 `ssh-keyscan`。macOS 通常已经自带。

先在当前 Mac 终端定义连接信息。把 `ubuntu` 替换成你现在实际使用的服务器管理员用户名：

```bash
SSH_HOST=8.163.27.231
SSH_PORT=22
SSH_ADMIN=ubuntu
```

如果稍后的服务器预检显示端口不是 `22`，立刻在本机重新执行，例如 `SSH_PORT=2222`。本文后续命令都使用这个变量。

## 3. 备份现有站点

先登录服务器：

```bash
ssh -p "$SSH_PORT" "$SSH_ADMIN@$SSH_HOST"
```

下面命令都在服务器执行。它会在 `/var/backups` 中复制当前站点，不会修改线上目录。整段由独立的严格模式 Bash 执行，任一检查失败都会停止，不会显示备份成功：

```bash
sudo bash <<'BACKUP_SITE'
set -Eeuo pipefail

SITE_ROOT=/var/www/huangjianfen.cn
BACKUP_DIR="/var/backups/sweet-memories-before-cicd-$(date -u +%Y%m%dT%H%M%SZ)"

[[ -d "$SITE_ROOT/html" && ! -L "$SITE_ROOT/html" ]]
[[ -f "$SITE_ROOT/html/index.html" && ! -L "$SITE_ROOT/html/index.html" ]]
if [[ -e "$BACKUP_DIR" || -L "$BACKUP_DIR" ]]; then
  echo "停止：备份目标已经存在，请重新生成一个时间戳。"
  exit 1
fi
install -d -m 700 "$BACKUP_DIR"
cp -a -- "$SITE_ROOT/html" "$BACKUP_DIR/html"
[[ -f "$BACKUP_DIR/html/index.html" && ! -L "$BACKUP_DIR/html/index.html" ]]
echo "备份位置：$BACKUP_DIR"
BACKUP_SITE
```

记录最后输出的完整备份位置。继续前最好也在阿里云控制台确认磁盘快照已成功。

## 4. 服务器预检

以下命令仍在服务器执行。每段都使用严格模式；有报错时先停止，不要带着错误继续迁移。

### 4.1 确认 SSH、用户组和现有目录

```bash
sudo bash <<'PREFLIGHT_SERVER'
set -Eeuo pipefail

systemctl is-active ssh
/usr/sbin/sshd -T | awk '$1 == "port" { found=1; print "SSH 端口：" $2 } END { exit !found }'
getent group www-data >/dev/null

SITE_ROOT=/var/www/huangjianfen.cn
[[ -d "$SITE_ROOT" && ! -L "$SITE_ROOT" ]]
[[ -d "$SITE_ROOT/html" && ! -L "$SITE_ROOT/html" ]]
[[ -f "$SITE_ROOT/html/index.html" && ! -L "$SITE_ROOT/html/index.html" ]]
find "$SITE_ROOT/html" -maxdepth 2 -printf '%M %u:%g %p\n' | sed -n '1,30p'
PREFLIGHT_SERVER
```

请把 `SSH 端口` 的数字记下来，并确保本机的 `SSH_PORT` 与它一致。`www-data` 是 Ubuntu 上 Nginx 常用的用户组，`getent` 必须能输出该组。

### 4.2 确认 Nginx 和公网访问

```bash
sudo bash <<'PREFLIGHT_NGINX'
set -Eeuo pipefail

nginx -t
systemctl is-active nginx
nginx -T 2>&1 | grep -nF '/var/www/huangjianfen.cn/html'
curl --fail --silent --show-error --output /dev/null http://8.163.27.231
echo "服务器内健康检查通过"
PREFLIGHT_NGINX
```

然后退出服务器：

```bash
exit
```

在本机另行检查公网访问；只有 `curl` 成功才会显示通过：

```bash
if curl --fail --silent --show-error --output /dev/null http://8.163.27.231; then
  echo "本机公网健康检查通过"
else
  echo "停止：本机公网健康检查失败。"
  return 1 2>/dev/null || exit 1
fi
```

如果 `nginx -T` 没有显示 `/var/www/huangjianfen.cn/html`，先确认实际 Nginx `root`，不要继续套用本文路径。

## 5. 在本机生成专用 SSH 密钥

这把密钥只给 GitHub Actions 使用，不要复用个人 SSH 密钥。下面命令在本机执行。

先检查目标文件不存在，避免覆盖旧密钥：

```bash
DEPLOY_KEY="$HOME/.ssh/sweet-memories-github-actions"

if test -e "$DEPLOY_KEY" || test -e "$DEPLOY_KEY.pub"; then
  echo "停止：目标密钥文件已存在，请保留旧文件并改用一个新的文件名。"
  return 1 2>/dev/null || exit 1
fi

ssh-keygen -t ed25519 \
  -C "github-actions-sweet-memories" \
  -f "$DEPLOY_KEY" \
  -N ''
```

如果看到了“停止”，不要执行后面的步骤。先给 `DEPLOY_KEY` 换一个全新的文件名，再重新生成；绝不要覆盖未知密钥。

成功后应有两个文件：

- `$DEPLOY_KEY.pub` 是公钥，可以安装到服务器的 `authorized_keys`。
- `$DEPLOY_KEY` 是无 `.pub` 后缀的私钥，只能放入 GitHub Secret。

检查文件权限和公钥类型：

```bash
test -f "$DEPLOY_KEY"
test -f "$DEPLOY_KEY.pub"
chmod 600 "$DEPLOY_KEY"
ssh-keygen -lf "$DEPLOY_KEY.pub" -E sha256
```

私钥不要发送到聊天、邮件或工单，不要提交到 Git 仓库，也不要放进截图。本文不会要求你把真实私钥粘贴到任何代码文件。

## 6. 创建无密码 `deploy` 用户并安装公钥

重新使用现有管理员账号登录服务器：

```bash
ssh -p "$SSH_PORT" "$SSH_ADMIN@$SSH_HOST"
```

下面命令在服务器执行。先确认是否已经存在同名用户：

```bash
if id deploy >/dev/null 2>&1; then
  echo "停止：deploy 用户已经存在，请先确认它是不是本项目以前创建的用户。"
  return 1 2>/dev/null || exit 1
fi

sudo adduser --disabled-password --gecos '' deploy
```

如果显示“停止”，不要覆盖该用户的配置；先查清它的用途。新用户创建成功后执行：

```bash
getent passwd deploy
sudo passwd -l deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
```

在本机另开一个终端，只显示公钥：

```bash
DEPLOY_KEY="$HOME/.ssh/sweet-memories-github-actions"
cat "$DEPLOY_KEY.pub"
```

复制这一整行 `ssh-ed25519 ...` 公钥。回到服务器终端，执行下面命令，并在提示后粘贴公钥再回车：

```bash
read -r -p "请粘贴完整的 ssh-ed25519 公钥：" DEPLOY_PUBLIC_KEY

case "$DEPLOY_PUBLIC_KEY" in
  ssh-ed25519\ *) ;;
  *) echo "停止：输入的不是 ssh-ed25519 公钥。"; unset DEPLOY_PUBLIC_KEY; return 1 2>/dev/null || exit 1 ;;
esac

printf '%s\n' "$DEPLOY_PUBLIC_KEY" \
  | sudo tee /home/deploy/.ssh/authorized_keys >/dev/null
unset DEPLOY_PUBLIC_KEY
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo test "$(sudo stat -c '%U:%G %a' /home/deploy/.ssh)" = 'deploy:deploy 700'
sudo test "$(sudo stat -c '%U:%G %a' /home/deploy/.ssh/authorized_keys)" = 'deploy:deploy 600'
```

`deploy` 不需要加入 `sudo` 组，也不要给它设置可登录密码。它以后只拥有发布目录，不应拥有整台服务器的管理权限。

## 7. 核验 SSH 主机指纹

主机指纹用来确认 GitHub 连接的是你的服务器，而不是冒充者。绝不能为了省事关闭 `StrictHostKeyChecking`。

先在服务器显示正在使用的 ED25519 主机公钥指纹：

```bash
sudo test -f /etc/ssh/ssh_host_ed25519_key.pub
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

记下输出中的 `SHA256:...` 和 `ED25519`。不要关闭这个服务器终端。

在本机终端重新确认变量，然后获取主机公钥到临时文件：

```bash
SSH_HOST=8.163.27.231
# 如果服务器预检显示的不是 22，请改成实际数字
SSH_PORT=22
HOST_KEY_FILE="$(mktemp "${TMPDIR:-/tmp}/sweet-memories-known-hosts.XXXXXX")"

ssh-keyscan -p "$SSH_PORT" -t ed25519 "$SSH_HOST" > "$HOST_KEY_FILE"
if ! test -s "$HOST_KEY_FILE" \
  || ! ssh-keygen -lf "$HOST_KEY_FILE" -E sha256; then
  echo "停止：没有获取到有效的 ED25519 主机公钥。"
  return 1 2>/dev/null || exit 1
fi
echo "待与服务器指纹比对的 known_hosts 临时文件：$HOST_KEY_FILE"
```

逐字符比较本机输出和服务器输出中的 `SHA256:...`，并确认两边都是 `ED25519`：

- 完全一致：可以继续。
- 不一致或任一方无输出：立即停止，检查 IP、SSH 端口和服务器，不要保存到 GitHub。

核验成功后，保留本机终端和 `$HOST_KEY_FILE`，后面配置 GitHub 时还要使用。

## 8. 先验证专用密钥能登录

完成主机指纹核验后，在本机执行：

```bash
DEPLOY_KEY="$HOME/.ssh/sweet-memories-github-actions"
ssh -i "$DEPLOY_KEY" \
  -p "$SSH_PORT" \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile="$HOST_KEY_FILE" \
  -o StrictHostKeyChecking=yes \
  deploy@"$SSH_HOST" \
  'whoami && id'
```

第一行预期输出 `deploy`。如果要求输入 `deploy` 的密码，说明公钥安装不正确，应停止排查；正常情况只使用密钥，不需要账号密码。

## 9. 只执行一次：迁移现有 `html` 目录

目前 `html` 是普通目录，自动发布脚本要求它是软链接。下面迁移会把现有站点变成：

```text
/var/www/huangjianfen.cn/
├── html -> /var/www/huangjianfen.cn/releases/initial-时间戳
└── releases/
    └── initial-时间戳/
        ├── index.html
        └── assets/
```

重要说明：

- 这段迁移命令只允许成功执行一次，不能把它当作可重复脚本。
- 再次执行时，前置检查会因为 `html` 已是软链接或 `releases` 已存在而停止。
- 执行前必须已经完成备份、用户创建、密钥登录验证和 Nginx 预检。
- 不要把目录权限放宽到所有人可写，也不要手工删除整个站点目录。

使用现有管理员账号登录服务器：

```bash
ssh -p "$SSH_PORT" "$SSH_ADMIN@$SSH_HOST"
```

然后一次性完整粘贴下面整段。它会在失败时尝试把刚移动的目录放回 `html`：

```bash
sudo bash <<'MIGRATE'
set -Eeuo pipefail

SITE_ROOT=/var/www/huangjianfen.cn
PUBLIC_URL=http://8.163.27.231
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASES="$SITE_ROOT/releases"
INITIAL_RELEASE="$RELEASES/initial-$STAMP"
RELEASES_CREATED=0
HTML_MOVED=0
MIGRATION_COMPLETE=0

ORIGINAL_ROOT_OWNER="$(stat -c '%u:%g' "$SITE_ROOT")"
ORIGINAL_ROOT_MODE="$(stat -c '%a' "$SITE_ROOT")"

recover_on_exit() {
  status=$?
  trap - EXIT INT TERM

  if (( status == 0 || MIGRATION_COMPLETE == 1 )); then
    exit "$status"
  fi

  echo "迁移中断，开始保守恢复。" >&2

  if (( HTML_MOVED == 1 )); then
    CAN_RESTORE=1
    if [[ -L "$SITE_ROOT/html" ]]; then
      LINK_TARGET="$(readlink -f "$SITE_ROOT/html" 2>/dev/null || true)"
      if [[ "$LINK_TARGET" == "$INITIAL_RELEASE" ]]; then
        unlink "$SITE_ROOT/html"
      else
        echo "html 指向了未知目标，拒绝自动解除链接。" >&2
        CAN_RESTORE=0
      fi
    elif [[ -e "$SITE_ROOT/html" ]]; then
      echo "html 已被其他路径占用，拒绝自动覆盖。" >&2
      CAN_RESTORE=0
    fi

    if (( CAN_RESTORE == 1 )) \
      && [[ ! -e "$SITE_ROOT/html" && ! -L "$SITE_ROOT/html" ]] \
      && [[ -d "$INITIAL_RELEASE" && ! -L "$INITIAL_RELEASE" ]]; then
      mv -- "$INITIAL_RELEASE" "$SITE_ROOT/html"
      chown "$ORIGINAL_ROOT_OWNER" "$SITE_ROOT"
      chmod "$ORIGINAL_ROOT_MODE" "$SITE_ROOT"
      echo "已恢复为普通 html 目录。" >&2
    else
      echo "自动恢复未完成，请保留现场并按本文的手工恢复步骤处理。" >&2
    fi
  fi

  if (( RELEASES_CREATED == 1 )); then
    rmdir "$RELEASES" 2>/dev/null || true
  fi
  exit "$status"
}

trap recover_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -d "$SITE_ROOT" && ! -L "$SITE_ROOT" ]] || {
  echo "站点根目录不存在或是软链接，停止。" >&2
  exit 1
}
[[ -d "$SITE_ROOT/html" && ! -L "$SITE_ROOT/html" ]] || {
  echo "html 不是普通目录；本迁移只能执行一次，停止。" >&2
  exit 1
}
[[ -f "$SITE_ROOT/html/index.html" && ! -L "$SITE_ROOT/html/index.html" ]] || {
  echo "缺少普通 index.html 文件，停止。" >&2
  exit 1
}
[[ ! -e "$RELEASES" && ! -L "$RELEASES" ]] || {
  echo "releases 已存在；不要重复迁移，停止。" >&2
  exit 1
}
[[ ! -e "$SITE_ROOT/previous" && ! -L "$SITE_ROOT/previous" ]] || {
  echo "previous 已存在；请先查明原因，停止。" >&2
  exit 1
}
UNSUPPORTED_ENTRY="$(find "$SITE_ROOT/html" ! -type f ! -type d -print -quit)"
[[ -z "$UNSUPPORTED_ENTRY" ]] || {
  echo "站点包含软链接或特殊文件，停止：$UNSUPPORTED_ENTRY" >&2
  exit 1
}
id deploy >/dev/null
getent group www-data >/dev/null
nginx -t
curl --fail --silent --show-error --output /dev/null "$PUBLIC_URL"

install -d -m 755 -o deploy -g www-data "$RELEASES"
RELEASES_CREATED=1
mv -- "$SITE_ROOT/html" "$INITIAL_RELEASE"
HTML_MOVED=1

chown deploy:www-data "$SITE_ROOT"
chmod 755 "$SITE_ROOT"
chown -R deploy:www-data "$INITIAL_RELEASE"
find "$INITIAL_RELEASE" -type d -exec chmod 755 {} +
find "$INITIAL_RELEASE" -type f -exec chmod 644 {} +
runuser -u deploy -- ln -s "$INITIAL_RELEASE" "$SITE_ROOT/html"

[[ "$(readlink -f "$SITE_ROOT/html")" == "$INITIAL_RELEASE" ]]
[[ "$(stat -c '%U:%G %a' "$SITE_ROOT")" == 'deploy:www-data 755' ]]
[[ "$(stat -c '%U:%G %a' "$RELEASES")" == 'deploy:www-data 755' ]]
[[ "$(stat -c '%U:%G %a' "$INITIAL_RELEASE")" == 'deploy:www-data 755' ]]
runuser -u deploy -- test -w "$SITE_ROOT"
runuser -u deploy -- test -w "$RELEASES"
nginx -t
curl --fail --silent --show-error --output /dev/null "$PUBLIC_URL"

MIGRATION_COMPLETE=1
echo "迁移成功，初始版本：$INITIAL_RELEASE"
echo "html 当前指向：$(readlink -f "$SITE_ROOT/html")"
MIGRATE
```

迁移成功后，在服务器逐项验证。该块任一步失败都会停止，不会显示“网站正常”：

```bash
sudo bash <<'VERIFY_MIGRATION'
set -Eeuo pipefail

SITE_ROOT=/var/www/huangjianfen.cn
[[ -L "$SITE_ROOT/html" ]]
ACTIVE_RELEASE="$(readlink -f "$SITE_ROOT/html")"
[[ "$ACTIVE_RELEASE" == "$SITE_ROOT"/releases/initial-* ]]
printf 'html 当前指向：%s\n' "$ACTIVE_RELEASE"
find "$SITE_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n'
nginx -t
curl --fail --silent --show-error --output /dev/null http://8.163.27.231
echo "迁移后网站正常"
VERIFY_MIGRATION
```

再在本机验证 `deploy` 对发布目录有写权限：

```bash
DEPLOY_KEY="$HOME/.ssh/sweet-memories-github-actions"
ssh -i "$DEPLOY_KEY" \
  -p "$SSH_PORT" \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile="$HOST_KEY_FILE" \
  -o StrictHostKeyChecking=yes \
  deploy@"$SSH_HOST" \
  'test -w /var/www/huangjianfen.cn && test -w /var/www/huangjianfen.cn/releases && readlink -f /var/www/huangjianfen.cn/html && echo 可部署'
```

### 迁移中途失败时手工恢复

上面的脚本会自动尝试恢复。如果终端断开或服务器重启导致自动恢复未完成，先不要再次运行迁移，也不要创建 Tag。

在服务器用 `sudo find /var/www/huangjianfen.cn/releases -mindepth 1 -maxdepth 1 -type d -name 'initial-*' -print` 找到唯一的初始目录。把下面 `INITIAL_RELEASE` 改成刚查到的完整路径，再执行保护性恢复。该块会拒绝覆盖任何已有的普通 `html`，任一校验或健康检查失败也不会显示恢复成功：

```bash
sudo bash <<'RECOVER_INITIAL'
set -Eeuo pipefail

SITE_ROOT=/var/www/huangjianfen.cn
INITIAL_RELEASE=/var/www/huangjianfen.cn/releases/initial-请替换为实际时间戳

[[ -d "$INITIAL_RELEASE" && ! -L "$INITIAL_RELEASE" ]]
[[ "$INITIAL_RELEASE" == "$SITE_ROOT"/releases/initial-* ]]

if [[ -L "$SITE_ROOT/html" ]]; then
  CURRENT_TARGET="$(readlink -f "$SITE_ROOT/html")"
  if [[ "$CURRENT_TARGET" != "$INITIAL_RELEASE" ]]; then
    echo "停止：html 指向未知目标 $CURRENT_TARGET，不做覆盖。"
    exit 1
  fi
  unlink "$SITE_ROOT/html"
elif [[ -e "$SITE_ROOT/html" ]]; then
  echo "停止：html 是已有的普通文件或目录，不做覆盖。"
  exit 1
fi

[[ ! -e "$SITE_ROOT/html" && ! -L "$SITE_ROOT/html" ]]
mv -- "$INITIAL_RELEASE" "$SITE_ROOT/html"
[[ -d "$SITE_ROOT/html" && ! -L "$SITE_ROOT/html" ]]
nginx -t
curl --fail --silent --show-error --output /dev/null http://8.163.27.231
echo "已恢复为普通 html 目录"
RECOVER_INITIAL
```

恢复脚本只保证把可访问的站点内容放回普通 `html` 目录。如果失败发生在权限规范化之后，目录内容可能仍是 `deploy:www-data`，目录可能是 `755`、文件可能是 `644`；它不会声称恢复了迁移前的全部所有者和权限元数据。如需逐项还原原始元数据，应使用第 3 节的备份或阿里云磁盘快照。

如果保护性检查失败，停止操作，并使用第 3 节记录的备份或阿里云磁盘快照恢复。不要猜测目录、不要覆盖一个未知的 `html`。

## 10. 配置阿里云安全组

工作流运行在 GitHub 托管的执行器上，它必须能连接服务器实际 SSH 端口。进入阿里云控制台的实例安全组，检查入方向 TCP 规则：

- 端口必须是第 4 节 `sshd -T` 显示的实际端口。
- 如果规则只允许你的家庭或办公室 IP，GitHub Actions 通常会连接超时。
- GitHub 托管执行器没有一个永久不变的单一出口 IP；应按 GitHub 当前公布的 Actions 地址范围维护规则，或使用有固定出口的执行器方案。
- 不要为了排错关闭 SSH 主机校验，也不要给 `deploy` 增加密码或 `sudo` 权限。

安全组规则变更后，先确保现有管理员连接和本机专用密钥连接都仍然正常。

## 11. 配置 GitHub `production` Environment

打开 GitHub 仓库，依次进入：

`Settings（设置）` -> `Environments（环境）` -> `New environment（新建环境）`

环境名称必须准确填写小写的 `production`。工作流已经声明使用这个环境。

### 11.1 添加 Environment secrets

在 `production` 页面找到 `Environment secrets`，逐个添加以下 5 个 Secret，名称必须完全一致：

| Secret 名称 | 填写内容 |
| --- | --- |
| `ALIYUN_HOST` | `8.163.27.231` |
| `ALIYUN_SSH_PORT` | 第 4 节确认的实际 SSH 端口，例如 `22` |
| `ALIYUN_USER` | `deploy` |
| `ALIYUN_SSH_PRIVATE_KEY` | 本机专用私钥 `$DEPLOY_KEY` 的完整多行内容，文件名没有 `.pub` |
| `ALIYUN_KNOWN_HOSTS` | 第 7 节已核验的 `$HOST_KEY_FILE` 完整内容 |

只在 GitHub Secret 输入框中查看专用私钥：

```bash
DEPLOY_KEY="$HOME/.ssh/sweet-memories-github-actions"
if pbcopy < "$DEPLOY_KEY"; then
  echo "专用私钥已复制到剪贴板，请立即粘贴到 ALIYUN_SSH_PRIVATE_KEY"
else
  echo "停止：复制私钥失败，不要继续配置 Secret。"
  return 1 2>/dev/null || exit 1
fi
```

只在 GitHub Secret 输入框中使用已核验的主机记录：

```bash
cat "$HOST_KEY_FILE"
```

`ALIYUN_SSH_PRIVATE_KEY` 必须包含专用私钥文件从起始标记到结束标记的完整多行内容。`ALIYUN_KNOWN_HOSTS` 的主机和端口格式由 `ssh-keyscan` 自动生成，不要手改。`pbcopy` 是 macOS 自带命令，它不会把私钥打印到终端；粘贴完成后不要再把剪贴板内容发往其他地方。

把私钥粘贴并保存到 GitHub 后，立即在本机清空剪贴板：

```bash
printf '' | pbcopy
```

不要把 Secret 写进 `.github/workflows/deploy.yml`、其他仓库文件、Issue、聊天或截图。GitHub 保存 Secret 后不会再显示原值，这是正常现象。

### 11.2 添加 Environment variable

在同一 `production` 页面找到 `Environment variables`，添加：

| Variable 名称 | 值 |
| --- | --- |
| `PRODUCTION_URL` | `http://8.163.27.231` |

这是公开健康检查地址，不是 Secret；名称仍然必须完全一致。

### 11.3 检查 Actions 权限

进入：

`Settings（设置）` -> `Actions` -> `General（常规）`

确认仓库允许 GitHub Actions 运行。当前工作流自身只申请 `contents: read`，不需要开启仓库写权限。

如果私有仓库当前套餐不支持 Environment secrets，可以改到：

`Settings（设置）` -> `Secrets and variables（机密和变量）` -> `Actions`

把上述 5 项添加为同名 `Repository secrets`，把 `PRODUCTION_URL` 添加为 `Repository variable`。工作流读取方式不变；仍然保留名为 `production` 的 Environment，用于标识和查看生产部署记录。

## 12. 第一次推送发布 Tag

必须先确保自动部署工作流已经合并并推送到远程 `main`。以下命令在本机项目目录执行：

```bash
if ! git switch main \
  || ! git pull --ff-only origin main \
  || ! git fetch origin main --no-tags \
  || ! git fetch origin --tags; then
  echo "停止：main 或远程 Tag 同步失败。"
  return 1 2>/dev/null || exit 1
fi

if test "$(git branch --show-current)" != main \
  || test -n "$(git status --short)" \
  || test ! -f .github/workflows/deploy.yml \
  || test ! -f scripts/deploy/manage-release.sh; then
  echo "停止：当前不是干净的 main，或自动部署文件尚未进入 main。"
  return 1 2>/dev/null || exit 1
fi

git log -1 --oneline
```

认真查看最后一行，确认这正是要发布的提交。再创建附注 Tag：

```bash
RELEASE_TAG=v1.0.0

if git rev-parse -q --verify "refs/tags/$RELEASE_TAG" >/dev/null; then
  echo "停止：$RELEASE_TAG 已存在，请使用一个全新的版本号。"
  return 1 2>/dev/null || exit 1
fi

git tag -a "$RELEASE_TAG" -m "Release $RELEASE_TAG"
git show --no-patch --decorate "$RELEASE_TAG"

LOCAL_TAG_SHA="$(git rev-list -n 1 "$RELEASE_TAG")"
if ! git merge-base --is-ancestor "$LOCAL_TAG_SHA" origin/main; then
  echo "停止：Tag 提交不属于 origin/main，没有推送。"
  return 1 2>/dev/null || exit 1
fi

if ! git push origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"; then
  echo "停止：git push 报错，远程结果可能未知。不要重推或复用这个 Tag；先到 GitHub Tags 页面检查远程状态。"
  return 1 2>/dev/null || exit 1
fi

REMOTE_PEELED_REF="refs/tags/$RELEASE_TAG^{}"
if ! REMOTE_TAG_OUTPUT="$(
  git ls-remote --exit-code origin "$REMOTE_PEELED_REF"
)"; then
  echo "停止：无法核验远程 Tag，远程结果可能未知。不要重推或复用这个 Tag；先检查 GitHub 远程状态。"
  return 1 2>/dev/null || exit 1
fi

if [[ "$REMOTE_TAG_OUTPUT" == *$'\n'* ]]; then
  echo "停止：远程 Tag 核验返回了多条记录，不要重推或复用；请先检查远程。"
  return 1 2>/dev/null || exit 1
fi

IFS=$'\t ' read -r REMOTE_TAG_SHA REMOTE_TAG_REF REMOTE_EXTRA <<< "$REMOTE_TAG_OUTPUT"
if [[ -n "${REMOTE_EXTRA:-}" \
  || "$REMOTE_TAG_REF" != "$REMOTE_PEELED_REF" \
  || ! "$REMOTE_TAG_SHA" =~ ^[0-9a-f]{40}$ \
  || "$REMOTE_TAG_SHA" != "$LOCAL_TAG_SHA" ]]; then
  echo "停止：远程 Tag 与本地提交不一致。不要重推或复用这个 Tag；请先检查远程。"
  return 1 2>/dev/null || exit 1
fi

echo "远程 Tag 已确认指向 $LOCAL_TAG_SHA，现在可以打开 GitHub Actions。"
```

不要使用 `--force`，不要强制移动已经推送的 Tag。如果 Tag 创建错了但还没推送，可以先停止并请熟悉 Git 的人检查；发布过或失败过的 Tag 不再复用。

功能分支本身没有特殊命名要求，但生产 Tag 指向的提交必须已经进入远程 `main` 历史。在尚未合并的功能分支提交上打 `v*` Tag，工作流会在“验证提交已经进入 main”步骤明确失败。

## 13. 在 GitHub 查看部署过程

只有上一步显示“远程 Tag 已确认”后，才打开仓库的 `Actions` 页面，选择 `发布生产环境`，再打开本次 `v1.0.0` 运行记录。如果推送或远程核验报错，先检查 GitHub Tags 页面，不要直接重推。

应依次看到这些关键步骤成功：

- `验证提交已经进入 main`
- `类型检查`
- `代码检查`
- `单元测试`
- `部署脚本测试`
- `生产构建`
- `上传发布产物`
- `原子启用新版本`
- `公网健康检查并在失败时回退`
- `清理旧版本`

同一时间只运行一个生产部署。已有部署正在运行时，后来的部署会等待，不会在切换服务器期间强制取消前一个任务。

## 14. 成功后验证服务器

工作流成功后，用专用密钥登录服务器：

```bash
DEPLOY_KEY="$HOME/.ssh/sweet-memories-github-actions"
ssh -i "$DEPLOY_KEY" \
  -p "$SSH_PORT" \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile="$HOST_KEY_FILE" \
  -o StrictHostKeyChecking=yes \
  deploy@"$SSH_HOST"
```

在服务器执行。任一步失败都会停止，不会显示“线上验证通过”：

```bash
bash <<'VERIFY_RELEASE'
set -Eeuo pipefail

SITE_ROOT=/var/www/huangjianfen.cn
RELEASES="$SITE_ROOT/releases"

die() {
  echo "线上验证错误：$1" >&2
  exit 1
}

[[ -d "$RELEASES" && ! -L "$RELEASES" ]] || \
  die "releases 不是普通目录"
[[ -L "$SITE_ROOT/html" ]] || \
  die "html 不是软链接"
ACTIVE_RELEASE="$(readlink -f "$SITE_ROOT/html")"
ACTIVE_SHA="$(basename "$ACTIVE_RELEASE")"

[[ "$(dirname "$ACTIVE_RELEASE")" == "$RELEASES" ]] || \
  die "html 没有指向 releases 的直接子目录"

[[ -d "$ACTIVE_RELEASE" && ! -L "$ACTIVE_RELEASE" ]] || \
  die "html 指向的版本不是实际存在的普通目录"
if [[ ! "$ACTIVE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  die "当前发布目录名不是 40 位小写 SHA"
fi

[[ -L "$SITE_ROOT/previous" ]] || \
  die "previous 不是软链接；首次自动部署没有完整记录上一个版本"
PREVIOUS_RELEASE="$(readlink -f "$SITE_ROOT/previous")"
[[ "$(dirname "$PREVIOUS_RELEASE")" == "$RELEASES" ]] || \
  die "previous 没有指向 releases 的直接子目录"

[[ -d "$PREVIOUS_RELEASE" && ! -L "$PREVIOUS_RELEASE" ]] || \
  die "previous 指向的版本不是实际存在的普通目录"
[[ "$PREVIOUS_RELEASE" != "$ACTIVE_RELEASE" ]] || \
  die "previous 与当前版本相同，无法提供有效回退"

echo "当前版本：$ACTIVE_RELEASE"
echo "上一个版本：$PREVIOUS_RELEASE"
find "$SITE_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
curl --fail --silent --show-error --output /dev/null http://8.163.27.231
echo "线上验证通过"
VERIFY_RELEASE
```

目录名的 40 位 SHA 应与 GitHub Actions 本次运行页面显示的提交一致。浏览器再打开 `http://8.163.27.231`，确认页面功能正常。

如果上传、解压或校验在切换前失败，旧版 `html` 不会改变。如果已经切换到新版但公网健康检查失败，工作流会调用发布脚本把 `html` 切回 `previous`，然后把本次运行标记为失败。

## 15. 常见故障排查

### `Tag 指向的提交尚未进入 main`

原因：Tag 指向功能分支上尚未合并的提交，或者远程 `main` 还没包含该提交。

处理：把修复正常合并到 `main`，同步本机，再创建一个新的版本 Tag。不要强制修改或复用已经推送的旧 Tag。

### `Permission denied (publickey)`

依次检查：

- `ALIYUN_USER` 是否准确为 `deploy`。
- `ALIYUN_SSH_PORT` 是否是实际端口。
- GitHub 中是否放入无 `.pub` 后缀的完整专用私钥。
- `/home/deploy/.ssh` 是否为 `deploy:deploy 700`。
- `authorized_keys` 是否为 `deploy:deploy 600`，内容是否是匹配的 `.pub` 公钥。
- 第 8 节本机严格校验命令能否登录。

不要给账号设置密码来绕过问题，也不要把权限放宽到所有人可写。

### `Host key verification failed`

原因通常是主机、端口或 `ALIYUN_KNOWN_HOSTS` 不匹配，也可能是服务器重装后主机密钥真的发生了变化。

处理：重新从服务器控制台读取 ED25519 指纹，再按第 7 节重新扫描并逐字符比对。只有确认一致后才更新 Secret。绝不能关闭 `StrictHostKeyChecking`，也不要把空的 known_hosts 放入 GitHub。

### 连接超时或安全组错误

检查 SSH 服务、实际端口、Ubuntu 防火墙和阿里云安全组。若本机能连而 Actions 超时，重点检查安全组来源是否只允许了你的个人 IP，以及 GitHub Actions 当前地址范围是否已放行。

### 健康检查失败并回退

先确认 `http://8.163.27.231` 从公网可访问，再查看 Nginx 日志和 Actions 的健康检查输出：

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo tail -n 100 /var/log/nginx/error.log
```

回退后用 `readlink -f /var/www/huangjianfen.cn/html` 确认当前目标。修复原因并合并到 `main` 后，用新 Tag 重试，不要复用失败 Tag。

### 发布目录权限错误

正常值需要区分首次迁移和后续自动发布：

- 站点根 `/var/www/huangjianfen.cn`、`releases` 根和 `initial-*` 初始版本由迁移脚本设置为 `deploy:www-data`。
- 后续以 40 位 SHA 命名的 release 是工作流以 `deploy` 用户创建的，通常属于 `deploy:deploy`；这不是错误。
- 所有发布目录应为 `755`，普通文件应为 `644`。因此即使 SHA release 的组是 `deploy`，Nginx 的 `www-data` 仍可依靠 other 位的读权限和目录执行权限读取静态文件。

检查：

```bash
sudo stat -c '%U:%G %a %n' \
  /var/www/huangjianfen.cn \
  /var/www/huangjianfen.cn/releases
sudo find /var/www/huangjianfen.cn/releases -maxdepth 2 -printf '%M %u:%g %p\n' | head -n 50
sudo -u deploy test -w /var/www/huangjianfen.cn/releases && echo "deploy 可写"
```

不要把整个站点权限放宽到所有人可写。如果只有某个 release 权限异常，优先查清它是如何创建的，不要随意扩大整站权限。

## 16. 日常发布流程

以后每次发布只需要在本机做以下事情：

1. 通过正常评审把代码合并到远程 `main`。
2. 同步本机 `main`，确认工作区干净并查看要发布的提交。
3. 创建一个从未使用过的附注 `v*` Tag。
4. 只推送这个 Tag，并在 GitHub Actions 和公网页面检查结果。

示例：

```bash
if ! git switch main \
  || ! git pull --ff-only origin main \
  || ! git fetch origin main --no-tags \
  || ! git fetch origin --tags; then
  echo "停止：main 或远程 Tag 同步失败。"
  return 1 2>/dev/null || exit 1
fi

if test "$(git branch --show-current)" != main \
  || test -n "$(git status --short)"; then
  echo "停止：请先保持 main 工作区干净。"
  return 1 2>/dev/null || exit 1
fi

git log -1 --oneline

RELEASE_TAG=v1.0.1
if git rev-parse -q --verify "refs/tags/$RELEASE_TAG" >/dev/null; then
  echo "停止：$RELEASE_TAG 已存在，请换一个新版本号。"
  return 1 2>/dev/null || exit 1
fi

git tag -a "$RELEASE_TAG" -m "Release $RELEASE_TAG"
LOCAL_TAG_SHA="$(git rev-list -n 1 "$RELEASE_TAG")"
if ! git merge-base --is-ancestor "$LOCAL_TAG_SHA" origin/main; then
  echo "停止：Tag 提交不属于 origin/main，没有推送。"
  return 1 2>/dev/null || exit 1
fi

if ! git push origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"; then
  echo "停止：git push 报错，远程结果可能未知。不要重推或复用这个 Tag；先到 GitHub Tags 页面检查远程状态。"
  return 1 2>/dev/null || exit 1
fi

REMOTE_PEELED_REF="refs/tags/$RELEASE_TAG^{}"
if ! REMOTE_TAG_OUTPUT="$(
  git ls-remote --exit-code origin "$REMOTE_PEELED_REF"
)"; then
  echo "停止：无法核验远程 Tag，远程结果可能未知。不要重推或复用这个 Tag；先检查 GitHub 远程状态。"
  return 1 2>/dev/null || exit 1
fi

if [[ "$REMOTE_TAG_OUTPUT" == *$'\n'* ]]; then
  echo "停止：远程 Tag 核验返回了多条记录，不要重推或复用；请先检查远程。"
  return 1 2>/dev/null || exit 1
fi

IFS=$'\t ' read -r REMOTE_TAG_SHA REMOTE_TAG_REF REMOTE_EXTRA <<< "$REMOTE_TAG_OUTPUT"
if [[ -n "${REMOTE_EXTRA:-}" \
  || "$REMOTE_TAG_REF" != "$REMOTE_PEELED_REF" \
  || ! "$REMOTE_TAG_SHA" =~ ^[0-9a-f]{40}$ \
  || "$REMOTE_TAG_SHA" != "$LOCAL_TAG_SHA" ]]; then
  echo "停止：远程 Tag 与本地提交不一致。不要重推或复用这个 Tag；请先检查远程。"
  return 1 2>/dev/null || exit 1
fi

echo "远程 Tag 已确认指向 $LOCAL_TAG_SHA，现在可以打开 GitHub Actions。"
```

推荐使用语义化版本号：

- `v1.0.1`：修复问题，不改变主要使用方式。
- `v1.1.0`：增加向后兼容的新功能。
- `v2.0.0`：存在不兼容的大改动。

### 回退和重试原则

- 构建或上传失败时，线上通常没有切换；先修复问题，再合并到 `main` 并使用新 Tag。
- 新版健康检查失败时会自动回退，不要在 Actions 仍运行时手动改软链接。
- 如果健康检查通过但之后发现严重功能问题，可以在本机项目根目录使用仓库中的发布脚本回退一次。先确认 `previous` 是已知可用版本：

```bash
DEPLOY_KEY="$HOME/.ssh/sweet-memories-github-actions"
ssh -i "$DEPLOY_KEY" \
  -p "$SSH_PORT" \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile="$HOST_KEY_FILE" \
  -o StrictHostKeyChecking=yes \
  deploy@"$SSH_HOST" \
  'readlink -f /var/www/huangjianfen.cn/html; readlink -f /var/www/huangjianfen.cn/previous'
```

确认后只执行一次：

```bash
DEPLOY_KEY="$HOME/.ssh/sweet-memories-github-actions"
ssh -i "$DEPLOY_KEY" \
  -p "$SSH_PORT" \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile="$HOST_KEY_FILE" \
  -o StrictHostKeyChecking=yes \
  deploy@"$SSH_HOST" \
  'bash -s -- rollback /var/www/huangjianfen.cn' \
  < scripts/deploy/manage-release.sh

curl --fail --silent --show-error --output /dev/null http://8.163.27.231
```

回退命令会交换 `html` 和 `previous`，重复执行会再次切换，所以不要盲目运行第二次。回退只是止损，最终仍应修复代码、合并到 `main`，再使用一个全新的 Tag 发布。
