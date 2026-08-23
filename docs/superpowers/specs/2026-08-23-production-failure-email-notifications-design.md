# 生产工作流失败邮件通知设计

## 目标

为现有 GitHub Actions 工作流启用 GitHub 原生邮件通知。当“生产站点巡检”或“发布生产环境”运行失败时，GitHub 向相关用户的已验证邮箱发送通知。

本阶段只配置失败通知，不改变巡检、部署或服务器行为。

## 范围

本设计覆盖：

- “生产站点巡检”失败邮件；
- “发布生产环境”失败邮件；
- GitHub 个人通知设置；
- 一次不制造生产故障的邮件通道验证；
- 中文操作指南更新。

本设计不包含：

- 企业微信、钉钉、飞书或自建 SMTP；
- 短信、电话或微信个人消息；
- 只针对单个 workflow 的自定义邮件逻辑；
- 告警合并、静默期或恢复通知；
- 自动重启、自动回滚或任何服务器写操作。

## 方案选择

采用 GitHub 原生 Actions 邮件通知，并启用“Only notify for failed workflows”。不在 workflow 中加入邮件 Action，不保存邮箱授权码或 Webhook Secret。

选择该方案的原因：

- 配置最少，适合当前单人维护场景；
- 不引入第三方服务和凭据；
- GitHub 直接根据 workflow 最终状态发送通知；
- 同时覆盖巡检失败和部署失败。

持续故障期间，每次失败的定时巡检都可能产生一封邮件。当前巡检每 30 分钟执行一次，因此可接受的最大发送频率约为每 30 分钟一封。

## 通知链路

```text
定时或手动触发 GitHub Actions
              |
              v
       workflow 运行完成
              |
       失败？ -- 否 --> 不发邮件
              |
             是
              |
              v
 GitHub 原生 Actions 通知服务
              |
              v
       GitHub 已验证邮箱
```

通知功能不参与巡检结果判定。即使邮件投递延迟或被邮箱过滤，Actions 页面中的 workflow 状态仍是事实来源。

## 接收人与配置边界

Actions 邮件是 GitHub 用户个人设置，不是仓库级配置，也不是 `production` Environment 配置。

- 手动触发的 workflow 通知与触发用户相关；
- 定时 workflow 的通知发送给最初创建该定时 workflow 的用户；
- 其他协作者若也需要邮件，必须在自己的 GitHub 账户中单独配置；
- 仓库应处于该用户的 Watching 范围内。

当前仓库由同一用户推送监控 workflow 并完成首次手动运行，因此该用户是本阶段的目标接收人。

## 一次性配置

1. 确认 GitHub 个人账户的主邮箱已验证并且可以正常收信。
2. 确认当前仓库处于 Watching 状态。
3. 打开 GitHub 个人 `Settings -> Notifications`。
4. 在 `System -> Actions` 中启用 `Email`。
5. 保存通知设置。

邮件通道确认后，在同一位置启用 `Only notify for failed workflows` 并再次保存。

## 安全验证流程

验证过程不修改 `MONITOR_URL`，不停止 Nginx，也不制造生产站点故障：

1. 首次配置时，暂不启用“仅失败时通知”。
2. 在 `main` 上手动运行一次“生产站点巡检”。
3. 等待 workflow 成功，并确认 GitHub 绑定邮箱收到成功状态邮件。
4. 回到通知设置，启用 `Only notify for failed workflows`。
5. 再手动运行一次成功巡检；该次成功运行不应产生失败通知。

第 3 步验证邮件投递通道，第 4 步启用最终过滤策略。无需为了测试而临时填写错误地址或破坏线上服务。

## 失败与排查

如果 Actions 已失败但没有收到邮件，按以下顺序检查：

1. GitHub 主邮箱是否已验证；
2. 邮箱垃圾邮件或自动分类目录；
3. `Settings -> Notifications -> System -> Actions` 是否启用了 Email；
4. 是否保存了“Only notify for failed workflows”；
5. 仓库是否处于 Watching 状态；
6. 失败的定时 workflow 是否由当前用户创建或重新启用。

邮件不是严格实时告警，也没有独立投递 SLA。故障判断仍应以仓库 `Actions` 页面中的运行结果和日志为准。

## 仓库改动

实现阶段只更新 `docs/monitoring.md`：

- 增加 GitHub 原生失败邮件配置说明；
- 增加安全验证步骤；
- 增加收不到邮件时的排查说明；
- 删除“不表示 GitHub 会发送邮件”的旧表述；
- 保留“不发送微信通知”和“不自动操作服务器”的边界。

以下文件不应修改：

- `.github/workflows/monitor.yml`；
- `.github/workflows/deploy.yml`；
- `scripts/monitor/*`；
- GitHub Secrets 或 Environment 配置。

## 验收标准

- 中文指南与 GitHub 当前通知入口和现有 workflow 名称一致；
- 仓库没有新增 Secret、Webhook、SMTP 凭据或第三方 Action；
- 现有 lint、类型检查、测试、部署测试、监控测试和构建保持通过；
- 用户完成一次成功邮件通道验证；
- 最终启用 Email 和“Only notify for failed workflows”；
- 成功 workflow 不要求发送邮件，失败 workflow 才发送邮件；
- 持续失败时允许每次定时运行重复通知。

## 参考资料

- GitHub Docs: [Managing GitHub Actions notifications](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)
- GitHub Docs: [Notifications for workflow runs](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)
