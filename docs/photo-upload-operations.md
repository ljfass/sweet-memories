# 图片上传 API 运维指南

本文用于首次安装图片 API、五张旧照片迁移、日常备份恢复和故障回退。静态站点、Tag 和 GitHub `production` Environment 的基础配置仍以 [生产部署指南](./deployment.md) 为准。

文中的“服务器”是 Ubuntu 生产机；“Mac”是保存仓库和异地备份的管理员电脑。高权限服务器操作只能由人工维护账号执行。GitHub Actions 的 `deploy` 账号只保留已提交 sudoers 中的单一管理入口。

## 1. 安装 Ubuntu 运行环境

执行位置：服务器（人工维护账号）。

先确认系统确实是 Ubuntu 24.04、CPU 是 x86-64。任一断言失败都停止，不要安装其他架构的 Node：

```bash
set -Eeuo pipefail

. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]]
[[ "$(uname -m)" == x86_64 ]]

sudo apt-get update
sudo apt-get install --yes --no-install-recommends \
  ca-certificates curl gnupg xz-utils libheif-examples sqlite3
heif-info --help >/dev/null
heif-convert --help >/dev/null
sqlite3 --version
```

从 Node.js 官方 release 下载固定的 Node 24.20.0 Linux x64 包、清单和分离签名。这里使用 Node.js 项目维护的 active release keyring；先用浏览器分别查看 Node.js 官方 README 与 `nodejs/release-keys`，确认 keyring 地址仍由 Node.js 项目声明，再执行：

```bash
set -Eeuo pipefail
umask 077

NODE_VERSION=v24.20.0
NODE_ARCHIVE=node-$NODE_VERSION-linux-x64.tar.xz
NODE_RELEASE_URL=https://nodejs.org/dist/$NODE_VERSION
NODE_WORK="$(mktemp -d)"
START_DIRECTORY="$PWD"
GNUPGHOME=$NODE_WORK/gnupg
export GNUPGHOME
install -d -m 0700 "$GNUPGHOME"
cd "$NODE_WORK"

curl --fail --silent --show-error --location \
  --output "$GNUPGHOME/pubring.kbx" \
  https://github.com/nodejs/release-keys/raw/refs/heads/main/gpg-only-active-keys/pubring.kbx
curl --fail --silent --show-error --remote-name "$NODE_RELEASE_URL/$NODE_ARCHIVE"
curl --fail --silent --show-error --remote-name "$NODE_RELEASE_URL/SHASUMS256.txt"
curl --fail --silent --show-error --remote-name "$NODE_RELEASE_URL/SHASUMS256.txt.sig"

gpg --verify SHASUMS256.txt.sig SHASUMS256.txt
grep ' node-v24.20.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check --strict -

sudo tar --extract --xz --file "$NODE_ARCHIVE" \
  --directory /usr/local --strip-components 1 --no-same-owner
test "$(/usr/local/bin/node --version)" = v24.20.0
test "$(/usr/local/bin/node -p 'process.platform + "/" + process.arch')" = linux/x64

cd "$START_DIRECTORY"
find "$NODE_WORK" -depth -mindepth 1 -delete
rmdir "$NODE_WORK"
```

签名或 SHA-256 校验失败时，不得执行 `tar`。不要以系统仓库中的另一个 Node 主版本替代这个固定运行时。

## 2. 创建账号和持久化目录

执行位置：服务器（人工维护账号）。

API 固定使用系统用户 `sweet-memories` 和组 `sweet-memories-media`。Nginx 用户 `www-data` 只通过补充组读取媒体：

```bash
set -Eeuo pipefail

getent group sweet-memories-media >/dev/null ||
  sudo groupadd --system sweet-memories-media
id sweet-memories >/dev/null 2>&1 ||
  sudo useradd --system \
    --gid sweet-memories-media \
    --home-dir /var/lib/sweet-memories \
    --shell /usr/sbin/nologin \
    sweet-memories
sudo usermod --append --groups sweet-memories-media www-data

[[ "$(id -gn sweet-memories)" == sweet-memories-media ]]
getent passwd sweet-memories |
  awk -F: '$1 == "sweet-memories" && $6 == "/var/lib/sweet-memories" && $7 == "/usr/sbin/nologin" { found=1 } END { exit !found }'
id -nG www-data | tr ' ' '\n' | grep -Fx sweet-memories-media

sudo install -d -o sweet-memories -g sweet-memories-media -m 0750 \
  /var/lib/sweet-memories
sudo install -d -o sweet-memories -g sweet-memories-media -m 0700 \
  /var/lib/sweet-memories/database \
  /var/lib/sweet-memories/staging \
  /var/lib/sweet-memories/backups \
  /var/lib/sweet-memories/backups/deploy \
  /var/lib/sweet-memories/backups/manual
sudo install -d -o sweet-memories -g sweet-memories-media -m 2750 \
  /var/lib/sweet-memories/media
```

固定权限合同如下：

- `0750 /var/lib/sweet-memories`
- `0700 /var/lib/sweet-memories/database`
- `0700 /var/lib/sweet-memories/staging`
- `0700 /var/lib/sweet-memories/backups`
- `0700 /var/lib/sweet-memories/backups/deploy`
- `0700 /var/lib/sweet-memories/backups/manual`
- `2750 /var/lib/sweet-memories/media`

生产数据库的唯一正确路径是 `/var/lib/sweet-memories/database/sweet-memories.sqlite3`。旧设计中的示意名 `app.db` 和单数目录 `backup` 都不是运行时合同。不要手工创建数据库文件；首次 API 激活会通过迁移创建它。照片目录由服务创建为 0750、媒体文件为 0640，私有删除区 `.deleting` 为 0700。

复核用户、组和目录；输出必须与上面的合同一致：

```bash
set -Eeuo pipefail

id sweet-memories
id www-data
sudo stat -c '%U:%G %a %n' \
  /var/lib/sweet-memories \
  /var/lib/sweet-memories/database \
  /var/lib/sweet-memories/staging \
  /var/lib/sweet-memories/backups \
  /var/lib/sweet-memories/backups/deploy \
  /var/lib/sweet-memories/backups/manual \
  /var/lib/sweet-memories/media
```

## 3. 安装服务文件和管理脚本

执行位置：服务器（包含本次 Tag 源码的受控 checkout）。

先进入与准备发布同一提交的仓库 checkout，再把三个脚本和三个模板安装为 root-owned 文件：

```bash
set -Eeuo pipefail

cd /root/sweet-memories
test -f scripts/deploy/manage-api-release.sh
test -f scripts/ops/backup-data.sh
test -f scripts/ops/restore-data.sh

sudo install -o root -g root -m 0755 scripts/deploy/manage-api-release.sh /usr/local/sbin/manage-sweet-memories-api
sudo install -o root -g root -m 0755 scripts/ops/backup-data.sh /usr/local/sbin/backup-sweet-memories-data
sudo install -o root -g root -m 0755 scripts/ops/restore-data.sh /usr/local/sbin/restore-sweet-memories-data
sudo install -o root -g root -m 0644 ops/systemd/sweet-memories-api.service /etc/systemd/system/sweet-memories-api.service
sudo install -o root -g root -m 0644 ops/nginx/sweet-memories-api.conf /etc/nginx/snippets/sweet-memories-api.conf
sudo install -o root -g root -m 0440 ops/sudoers/sweet-memories-api /etc/sudoers.d/sweet-memories-api

sudo visudo -cf /etc/sudoers.d/sweet-memories-api
sudo systemctl daemon-reload
sudo systemctl enable sweet-memories-api.service
```

`/etc/sudoers.d/sweet-memories-api` 只允许 `deploy` 以 root 运行 `/usr/local/sbin/manage-sweet-memories-api`，不得增加通配命令或交互 shell。三个 helper 必须保持 root-owned，普通用户不可写。

在当前 `huangjianfen.cn` 的 HTTPS `server` 块内加入且只加入一次：

```nginx
include /etc/nginx/snippets/sweet-memories-api.conf;
```

保存后必须先检查再重载。这样会让新的 `www-data` 补充组同时生效：

```bash
set -Eeuo pipefail

sudo nginx -t
sudo systemctl reload nginx.service
sudo systemctl is-active --quiet nginx.service
```

此时没有后端 release 时不要手工启动 API；准备 Tag 的 API 原子激活会创建 `/opt/sweet-memories-api/current`、重启服务并检查回环健康。

## 4. 准备阶段

执行位置：Mac（源码和 Tag）、服务器（CLI），以及 Mac 浏览器（管理员页面）。

准备发布必须保留精确 JSON：

```json
{ "mode": "static" }
```

### 4.1 推送准备 Tag

执行位置：Mac。

在干净的远程 `main` 上确认配置和静态五张照片，再按 [生产部署指南的 Tag 流程](./deployment.md#12-第一次推送发布-tag) 创建一个全新准备 Tag：

```bash
set -Eeuo pipefail

test "$(git branch --show-current)" = main
test -z "$(git status --short)"
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
const config = JSON.parse(readFileSync('src/config/album-source.json', 'utf8'))
if (JSON.stringify(config) !== '{"mode":"static"}') process.exit(1)
NODE
pnpm exec vitest run src/config/album-source.test.ts scripts/api/prepare-legacy-seed.test.ts
```

等待 GitHub Actions 完全成功，再打开 `https://huangjianfen.cn/`，确认公开相册仍只显示原有五张静态照片。不要在工作流仍运行时执行人工切换。

### 4.2 创建管理员并导入旧照片

执行位置：服务器人工交互终端。

下列函数复用发布管理器相同的服务用户、固定 PATH、生产 Origin、数据根、迁移根和 HEIF 工具。管理员密码只在 TTY 中隐藏输入两次；不要把密码放进命令、环境变量、Shell 历史或文档：

```bash
set -Eeuo pipefail

api_cli() {
  sudo runuser --user sweet-memories --group sweet-memories-media -- \
    env -i \
      PATH=/usr/local/bin:/usr/bin:/bin \
      NODE_ENV=production \
      SWEET_MEMORIES_ORIGIN=https://huangjianfen.cn \
      SWEET_MEMORIES_DATA_ROOT=/var/lib/sweet-memories \
      SWEET_MEMORIES_MIGRATIONS_ROOT=/opt/sweet-memories-api/current/migrations \
      SWEET_MEMORIES_HEIF_INFO_PATH=/usr/bin/heif-info \
      SWEET_MEMORIES_HEIF_CONVERT_PATH=/usr/bin/heif-convert \
      /usr/local/bin/node /opt/sweet-memories-api/current/dist/cli.js "$@"
}

api_cli admin create
api_cli migration import-legacy
```

以后确需重置时仍在服务器交互终端运行 `api_cli admin reset-password`。导入命令可重复执行，固定五张照片会被复用，不会重复创建。

### 4.3 补齐日期并检查准备状态

执行位置：Mac 浏览器，然后服务器。

1. 打开 `https://huangjianfen.cn/admin` 并登录。
2. 确认照片库正好包含五张迁移照片，上传按钮保持禁用。
3. 逐张填写合法的 `YYYY-MM-DD` 拍摄日期，并核对标题和图片描述。
4. 保存后确认顺序为：出生、第一次开心微笑、满月、睡觉、公园。

服务器运行只读准备检查和上传状态检查：

```bash
set -Eeuo pipefail

sudo /usr/local/sbin/manage-sweet-memories-api cli migration check-ready
UPLOAD_STATUS="$(sudo /usr/local/sbin/manage-sweet-memories-api cli uploads status)"
printf '%s\n' "$UPLOAD_STATUS"
[[ "$UPLOAD_STATUS" == *'图片上传：已禁用'* ]]
```

`migration check-ready` 会按 `captured_date ASC, created_at ASC, id ASC` 核验固定五张记录、日期、文字、媒体摘要和顺序。准备阶段的成功标准是 readiness 通过且显示“图片上传：已禁用”；此时不要手工执行 `migration activate` 或开启上传。

## 5. 备份和异地下载

执行位置：服务器生成一致性备份；Mac 使用已核验的严格 SSH 维护别名下载。

### 5.1 服务器生成归档

执行位置：服务器。

备份脚本与 API 发布共用锁，会在停服前检查空间，停服后合并 SQLite WAL、核验数据库和媒体双向一致，再生成只含 database、media、清单和 manifest 的归档。它始终尝试恢复服务并检查回环健康：

```bash
set -Eeuo pipefail

BACKUP_OUTPUT="$(sudo /usr/local/sbin/backup-sweet-memories-data /var/lib/sweet-memories/backups/manual)"
printf '%s\n' "$BACKUP_OUTPUT"
ARCHIVE="${BACKUP_OUTPUT##*backup archive: }"
[[ "$ARCHIVE" =~ ^/var/lib/sweet-memories/backups/manual/sweet-memories-data-[0-9]{8}T[0-9]{6}Z[.]tar[.]gz$ ]]
sudo test -f "$ARCHIVE"
sudo test ! -L "$ARCHIVE"
sudo test -f "$ARCHIVE.sha256"
sudo test ! -L "$ARCHIVE.sha256"
```

只认脚本最后返回的 UTC 文件名及其同名 sidecar；完整命名形式是 `sweet-memories-data-<UTC>.tar.gz.sha256`。服务器同盘副本不是异地备份。

### 5.2 下载到 Mac 并校验

执行位置：Mac。

备份文件是 root-only。使用已单独建立并核验主机指纹、有效用户为 `root` 的 `production-admin` 人工维护别名；不要使用 GitHub Actions 的 `deploy` 私钥，也不要放宽备份目录或 sudoers。`~/.ssh/config` 中该别名必须保持 `StrictHostKeyChecking yes`、固定 `UserKnownHostsFile`、`IdentitiesOnly yes` 和专用维护密钥。

把上一小节的绝对路径原样填入 `REMOTE_ARCHIVE`，先查看有效 SSH 配置，再下载两个文件：

```bash
set -Eeuo pipefail
umask 077

REMOTE_ARCHIVE=/var/lib/sweet-memories/backups/manual/sweet-memories-data-请替换UTC时间.tar.gz
ARCHIVE_NAME="${REMOTE_ARCHIVE##*/}"
LOCAL_BACKUP_DIR="$HOME/sweet-memories-backups"
mkdir -p -m 0700 "$LOCAL_BACKUP_DIR"

SSH_CONFIGURATION="$(ssh -G production-admin)"
printf '%s\n' "$SSH_CONFIGURATION" |
  awk '/^(user|stricthostkeychecking|userknownhostsfile|identitiesonly) / { print }'
printf '%s\n' "$SSH_CONFIGURATION" | grep -Fx 'user root'
printf '%s\n' "$SSH_CONFIGURATION" | grep -Eq '^stricthostkeychecking (yes|true)$'
printf '%s\n' "$SSH_CONFIGURATION" | grep -Fx 'identitiesonly yes'
printf '%s\n' "$SSH_CONFIGURATION" | grep -Eq '^userknownhostsfile /'
scp production-admin:"$REMOTE_ARCHIVE" "$LOCAL_BACKUP_DIR/"
scp production-admin:"$REMOTE_ARCHIVE.sha256" "$LOCAL_BACKUP_DIR/"

cd "$LOCAL_BACKUP_DIR"
shasum -a 256 --check "$ARCHIVE_NAME.sha256"
test -s "$ARCHIVE_NAME"
test -s "$ARCHIVE_NAME.sha256"
```

只有 `shasum` 明确报告归档 `OK` 才记录异地备份完成。记录 Tag、提交 SHA、UTC 文件名和 Mac 保存路径；不要在聊天、Issue 或日志中传输备份内容。

## 6. 恢复

执行位置：服务器（人工维护账号）；先 `verify`，经确认后才可 `apply`。

恢复输入必须是绝对路径，归档和同名 `.sha256` 都必须为 root-owned、单硬链接普通文件。先把待恢复的两个文件放到服务器 root-only 目录，并确认当前没有 Tag 发布或另一场备份/恢复。

`verify` 会私有复制并校验同一份输入，限制归档大小、成员数和展开体积，检查 SHA-256、成员路径、完整 SQLite schema、数据库完整性以及数据库和媒体的双向引用。`verify` 不会停止服务，也不会写生产数据：

```bash
set -Eeuo pipefail

RESTORE_ARCHIVE=/var/lib/sweet-memories/backups/manual/sweet-memories-data-请替换UTC时间.tar.gz
sudo /usr/local/sbin/restore-sweet-memories-data verify "$RESTORE_ARCHIVE"
sudo systemctl is-active --quiet sweet-memories-api.service
```

`apply` 会进入维护状态：再次完整预检和容量检查，停止 API，原子移动当前数据，安装已验证数据，规范化分层权限，再启动并检查回环健康。执行前确认已把当前备份下载到 Mac：

```bash
set -Eeuo pipefail

sudo /usr/local/sbin/restore-sweet-memories-data apply "$RESTORE_ARCHIVE"
sudo systemctl is-active --quiet sweet-memories-api.service
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  https://huangjianfen.cn/api/health
```

成功后脚本会输出并保留 `/var/lib/sweet-memories-recovery-<UTC>` 形式的 recovery bundle，不要立即清理。若中断或健康失败，脚本会按 journal 补偿并恢复旧数据；若提示 journal retained 或人工恢复，不要移动数据根、不要重跑其他发布命令，先保存日志并检查 `/var/lib/.sweet-memories-restore`。

恢复后的数据根会安全重建 `staging`、`backups/deploy` 和 `backups/manual`。再次运行 `verify`、登录管理员页面和公开巡检，确认数据后再安排 recovery bundle 的独立审计与清理。

## 7. 激活 API 相册

执行位置：Mac（配置、Tag 和公网验收）以及服务器（只读 readiness/status 复核）。

只有以下两项都有可复核记录时才进入激活：

1. 服务器 `migration check-ready` 对固定五张照片成功。
2. 最新一致性归档及 sidecar 已下载到 Mac，异地备份通过 `shasum`。

先再次复核 readiness 和上传关闭：

```bash
set -Eeuo pipefail

ssh production sudo /usr/local/sbin/manage-sweet-memories-api cli migration check-ready
ssh production sudo /usr/local/sbin/manage-sweet-memories-api cli uploads disable
```

在 Mac 把 `src/config/album-source.json` 改成精确 JSON，并通过正常评审进入远程 `main`：

```json
{ "mode": "api" }
```

按生产部署指南创建全新的激活 Tag。工作流必须依次成功：API activate（内部先关闭上传）、`migration check-ready`、`migration activate`、前端 activate、HTTPS 首页、`/api/photos`、五个固定 ID 顺序和同源 `/media/` 资源 2xx，最后才运行 `cli uploads enable`。

固定旧照片 ID 的预期顺序是：

1. `9a9a60f7-1edb-48ef-8ceb-5d9e188c2ab1`
2. `58efb95e-2a98-45be-bbe4-acde6c34f7cd`
3. `f83da4e8-d94e-4b8a-a725-36e2d1f931bf`
4. `a15b8021-9842-4ed7-bd0f-9f98518a2d72`
5. `c9608cd6-3480-43fb-84ab-623899262ff9`

Actions 全绿后在 Mac 运行公开巡检，并在服务器复核上传状态：

```bash
set -Eeuo pipefail

node scripts/monitor/check-photo-api.mjs https://huangjianfen.cn api
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  https://huangjianfen.cn/api/photos >/dev/null
ssh production sudo /usr/local/sbin/manage-sweet-memories-api cli uploads status
```

确认管理员页面允许选择文件，公开相册仍包含这五张并按拍摄日期排序。任一工作流或公网检查失败时，上传必须保持关闭，不要手工补做 enable。

## 8. 手工回退

执行位置：Mac（仓库根目录，使用严格 `production` deploy 别名）。

优先让 GitHub Actions 自己完成失败关闭和有条件回退。只有 Actions 已结束、确认需要人工止损且已记录本次失败的 40 位 SHA 时，才执行本节。手工顺序固定为：关闭上传，检查并有条件回退前端，只有前端确认回退成功或从未切到失败版本后，才检查并有条件回退 API。

下面的脚本对每次 SSH 返回值和指针都做确认；任一 SSH 或 curl 失败都会在最终成功信息前退出：

```bash
set -Eeuo pipefail

FAILED_SHA=请替换为失败发布的40位小写提交SHA
PREVIOUS_SHA=请替换为回退前已知可用的40位小写提交SHA
SITE_ROOT=/var/www/huangjianfen.cn
API_ROOT=/opt/sweet-memories-api
[[ "$FAILED_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$PREVIOUS_SHA" =~ ^[0-9a-f]{40}$ && "$PREVIOUS_SHA" != "$FAILED_SHA" ]]

ssh production sudo /usr/local/sbin/manage-sweet-memories-api cli uploads disable

EXPECTED_FRONTEND="$SITE_ROOT/releases/$FAILED_SHA"
EXPECTED_PREVIOUS_FRONTEND="$SITE_ROOT/releases/$PREVIOUS_SHA"
CURRENT_FRONTEND="$(ssh production readlink -f -- "$SITE_ROOT/html")"
if [[ "$CURRENT_FRONTEND" == "$EXPECTED_FRONTEND" ]]; then
  ssh production bash -s -- rollback-if-current "$SITE_ROOT" "$FAILED_SHA" \
    < scripts/deploy/manage-release.sh
  CURRENT_FRONTEND="$(ssh production readlink -f -- "$SITE_ROOT/html")"
  [[ "$CURRENT_FRONTEND" == "$EXPECTED_PREVIOUS_FRONTEND" ]]
else
  [[ "$CURRENT_FRONTEND" == "$EXPECTED_PREVIOUS_FRONTEND" ]]
fi

EXPECTED_API="$API_ROOT/releases/$FAILED_SHA"
EXPECTED_PREVIOUS_API="$API_ROOT/releases/$PREVIOUS_SHA"
CURRENT_API="$(ssh production readlink -f -- "$API_ROOT/current")"
if [[ "$CURRENT_API" == "$EXPECTED_API" ]]; then
  ssh production sudo /usr/local/sbin/manage-sweet-memories-api \
    rollback-if-current "$FAILED_SHA"
  CURRENT_API="$(ssh production readlink -f -- "$API_ROOT/current")"
  [[ "$CURRENT_API" == "$EXPECTED_PREVIOUS_API" ]]
else
  [[ "$CURRENT_API" == "$EXPECTED_PREVIOUS_API" ]]
fi

UPLOAD_STATUS="$(ssh production sudo /usr/local/sbin/manage-sweet-memories-api cli uploads status)"
[[ "$UPLOAD_STATUS" == *'图片上传：已禁用'* ]]
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  https://huangjianfen.cn/ >/dev/null
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  https://huangjianfen.cn/api/health >/dev/null

printf '手工回退已核验；上传保持关闭。\n'
```

若前端回退失败或无法确认，停止，保持新 API 和 uploads disabled，避免形成“新前端 + 旧 API”。不要反复运行普通 rollback；它会交换前后版本。修复后通过新 Tag 正常发布，公网全绿后再由工作流开启上传。

## 9. 日志和磁盘排障

执行位置：服务器；公网复核也可从 Mac 执行。

API 不可用时按本地服务、回环、Nginx、公网顺序检查。所有网络请求都有时间边界：

```bash
set -Eeuo pipefail

sudo systemctl status sweet-memories-api.service --no-pager
sudo journalctl -u sweet-memories-api.service --since '-30 minutes' --no-pager
curl --fail --silent --show-error --connect-timeout 2 --max-time 10 \
  http://127.0.0.1:3100/api/health
sudo nginx -t
sudo tail -n 100 /var/log/nginx/error.log
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  https://huangjianfen.cn/api/health
```

日志不得包含密码、Cookie、CSRF、会话令牌、原文件名或照片二进制。排查登录或上传问题时记录 UTC 时间、HTTP 状态和稳定错误码，不复制敏感请求头。

磁盘不足、备份失败或上传报告空间不足时检查固定数据和 release 文件系统：

```bash
set -Eeuo pipefail

df -h /var/lib/sweet-memories /opt/sweet-memories-api
df -i /var/lib/sweet-memories /opt/sweet-memories-api
sudo du -sh \
  /var/lib/sweet-memories/database/sweet-memories.sqlite3 \
  /var/lib/sweet-memories/media \
  /var/lib/sweet-memories/backups \
  /opt/sweet-memories-api/releases
sudo /usr/local/sbin/manage-sweet-memories-api cli uploads status
```

不要在服务运行时复制 SQLite 主文件，也不要删除 WAL/SHM、`.deleting`、journal 或未知临时目录。空间不足时先关闭上传，创建并下载一致性备份，再按保留策略使用发布管理器的精确 `cleanup 5`；持久化 `database`、`media`、`staging` 和 `backups` 永远不属于 release 清理范围。
