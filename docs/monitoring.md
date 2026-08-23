# 生产站点定时巡检

GitHub runner 每 30 分钟自动巡检一次生产站点，也支持随时手动运行。巡检会确认首页可以访问、响应类型是 HTML、页面包含 Vue 挂载点，并请求页面直接引用的同源 JavaScript 模块和 CSS 样式表。

巡检只通过公网进行只读访问，不使用 SSH，不修改服务器，不重启 Nginx，也不会自动回滚。

## 一次性配置仓库变量

1. 打开 GitHub 仓库，进入 `Settings -> Secrets and variables -> Actions -> Variables`。
2. 点击 `New repository variable`。
3. 在 `Name` 中填写 `MONITOR_URL`，在 `Value` 中填写 `http://8.163.27.231`。
4. 点击 `Add variable`。

这里配置的是仓库的 repository variable，不是 `production` Environment 中的变量，也不是 Secret。

## 第一次手动验证

只有当这套巡检代码已经进入远程 `main` 后，才进行第一次手动验证：

1. 打开仓库的 `Actions`。
2. 选择 `生产站点巡检`。
3. 点击 `Run workflow`。
4. 分支选择 `main`。
5. 点击绿色的 `Run workflow`。
6. 等待作业 `检查公网首页和构建资源` 变为绿色。

成功日志会显示首页 HTTP 状态、静态资源数量和最终地址。

## 自动执行时间

定时任务在每小时第 7 分钟和第 37 分钟触发，也就是每 30 分钟一次。GitHub Actions 的定时任务可能延迟，不是严格的实时监控。

## 失败信息怎么看

| 日志中的信息 | 含义 |
| --- | --- |
| `缺少仓库变量 MONITOR_URL` | 没有按上文添加仓库变量，或变量名填写错误 |
| `首页请求失败` | 首页连接失败、超时，或返回了失败的 HTTP 状态 |
| `首页 Content-Type 不是 text/html` | 首页响应不是 HTML |
| `HTML 缺少 Vue 挂载点 id="app"` | 首页缺少 Vue 应用挂载点 |
| `HTML 没有可巡检的模块脚本` | 首页没有引用可巡检的 JavaScript 模块 |
| `HTML 没有可巡检的样式表` | 首页没有引用可巡检的 CSS 样式表 |
| `HTML 资源解析失败` | 资源地址无效、不是同源 HTTP(S) 地址，或页面使用了 `<base href>`；巡检会拒绝这些情况，避免检查到与浏览器不同的资源 |
| `静态资源请求失败` | 某个 JavaScript 模块或 CSS 样式表无法直接访问 |

巡检失败只会在 GitHub Actions 中显示失败，不会自动操作服务器。先用浏览器检查生产站点，再查看 Actions 失败作业的日志；不要因为巡检失败就删除发布目录，也不要关闭 SSH 主机校验。

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

## 本地验证

在仓库根目录运行：

```bash
pnpm test:monitor
```

这条命令只使用本地测试夹具，不访问生产站点。

它会覆盖资源解析器和本地 HTTP 集成测试；全项目测试 `pnpm test` 还会包含巡检 workflow 的 YAML 契约测试。

需要只读检查真实生产站点时运行：

```bash
bash scripts/monitor/check-site.sh http://8.163.27.231
```

第二条命令会通过公网读取真实生产站点，不会修改服务器。
