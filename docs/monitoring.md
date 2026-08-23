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

本任务只提供定时 Actions 的失败可见性，不表示 GitHub 会发送邮件或微信通知。

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
