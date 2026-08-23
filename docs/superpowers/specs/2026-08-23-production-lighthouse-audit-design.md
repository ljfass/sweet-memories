# 生产站点 Lighthouse 自动检查设计

## 目标

为现有生产站点增加独立的 Lighthouse 自动质量检查。GitHub Actions 每天以移动端模式检查一次 `MONITOR_URL`，也支持手动运行；检查结果低于阈值时 workflow 失败并使用现有 GitHub 原生通知发送失败邮件，但不会阻止或回滚生产发布。

本设计覆盖四个 Lighthouse 分类：

- 性能；
- 可访问性；
- 最佳实践；
- SEO。

## 已确认的产品决策

- 使用官方 Lighthouse CI CLI，不使用第三方 Lighthouse Action。
- 检查与 `发布生产环境`、`生产站点巡检` 完全独立。
- 每天自动运行一次，并支持 `workflow_dispatch` 手动运行。
- 自动运行时间为每天 `18:23 UTC`，即北京时间次日约 `02:23`；GitHub 定时任务可能延迟。
- 只使用 Lighthouse 默认移动端模式。
- 每次对同一 URL 连续采集 3 次，并使用中位数判断阈值。
- 性能最低分为 `0.70`。
- 可访问性、最佳实践和 SEO 最低分均为 `0.90`。
- 复用现有仓库 Variable `MONITOR_URL`，不新增 URL Secret。
- HTML 和 JSON 报告作为 GitHub Artifact 保留 14 天。
- 检查失败只使独立 workflow 变红并触发失败邮件，不参与部署门禁。

## 方案选择

采用“官方 Lighthouse CI CLI + 独立 GitHub Actions workflow”。`@lhci/cli` 作为锁定的开发依赖进入 `package.json` 和 `pnpm-lock.yaml`，workflow 使用 `pnpm install --frozen-lockfile` 安装，再分别运行 `lhci collect` 和 `lhci assert`。

没有选择另外两种方案：

- 直接使用 Lighthouse CLI 并自行实现采集、聚合和断言，会重复 Lighthouse CI 已提供的能力并增加维护成本；
- 第三方 Lighthouse GitHub Action 虽然 YAML 较短，但会增加不必要的供应链和行为控制风险。

## 架构

新增独立 workflow `生产站点 Lighthouse 检查`：

```text
schedule / workflow_dispatch
            |
            v
    校验 MONITOR_URL
            |
            v
安装锁定的 Node、pnpm 和依赖
            |
            v
移动端 Lighthouse 连续采集 3 次
            |
            v
生成四项中位数 Actions 摘要
            |
            v
按 70 / 90 / 90 / 90 执行断言
            |
            v
始终尝试上传 HTML + JSON Artifact
            |
      +-----+-----+
      |           |
    达标          不达标或执行错误
      |           |
   workflow 绿   workflow 红 -> GitHub 失败邮件
```

该 workflow 不被部署 workflow 调用，部署 workflow 也不等待它。Lighthouse 失败不会修改线上目录、Nginx、发布指针或服务器状态。

## 组件与文件

### `.github/workflows/lighthouse.yml`

负责调度和编排：

- `schedule` 使用 `23 18 * * *`；
- 支持 `workflow_dispatch`；
- `permissions` 仅为 `contents: read`；
- 使用独立 concurrency group，避免定时和手动检查相互重叠；
- job 使用有界总超时，各步骤也设置正数超时；
- 从 `${{ vars.MONITOR_URL }}` 注入目标 URL；
- 只使用官方 GitHub Actions，并固定到完整 commit SHA；
- 断言失败后仍通过 `always()` 条件执行 Artifact 上传；
- Artifact 设置 `retention-days: 14`，文件缺失时失败而不是静默跳过。

workflow 不声明 `environment`，不读取 `secrets.*`，不执行 SSH、SCP、rsync 或任何服务器写命令。

### `lighthouserc.cjs`

负责 Lighthouse CI 的确定性配置：

- URL 来自 `MONITOR_URL`；
- `numberOfRuns` 为 `3`；
- 使用移动端默认配置；
- 只检查 `performance`、`accessibility`、`best-practices` 和 `seo` 四个分类；
- 四项断言级别均为 `error`；
- 每项断言显式使用 `aggregationMethod: "median"`；
- 最低分分别为 `0.70`、`0.90`、`0.90`、`0.90`；
- 不配置 Lighthouse CI 临时公共存储或外部 Lighthouse CI Server。

### `scripts/lighthouse/summarize-reports.mjs`

负责把报告转换为新手可读的 GitHub Actions 摘要：

- 只读取 Lighthouse CI 生成的 3 份 LHR JSON，忽略 `manifest.json` 等元数据文件；
- 要求恰好存在 3 份可解析报告；
- 校验四个分类及分数均存在且为 `0` 到 `1` 的有限数值；
- 对每个分类独立计算中位数；
- 输出包含实际分数、阈值和通过状态的 Markdown 表格；
- 在报告缺失、损坏或结构异常时以非零状态退出。

摘要只用于展示，最终通过或失败仍由 Lighthouse CI 的同一组中位数断言决定。

### 测试与文档

- `scripts/lighthouse/summarize-reports.test.ts`：覆盖中位数、阈值边界、缺失/损坏/非法分数报告。
- `scripts/lighthouse/config.test.ts`：结构化验证 3 次移动端采集、四项阈值和 median 聚合。
- `scripts/lighthouse/workflow.test.ts`：使用现有 YAML 解析依赖验证触发器、权限、步骤顺序、超时、固定 Action SHA、Artifact 保留和禁止项。
- `package.json`：增加专用 `test:lighthouse` 命令。
- `docs/lighthouse.md`：提供中文手动运行、分数解释、Artifact 下载、失败排查和邮件接收人说明。

## 数据流

1. GitHub 定时或用户手动触发 workflow。
2. workflow 从 repository variable 读取 `MONITOR_URL`，并复用现有 URL 校验能力拒绝空值、凭据、片段和非 HTTP(S) 地址。
3. Lighthouse CI 在 GitHub 托管 runner 的 Chrome 中对生产 URL 运行 3 次移动端检查。
4. 原始 LHR JSON 和 HTML 报告写入 runner 的 `.lighthouseci/` 临时目录。
5. 摘要脚本读取 3 份 JSON 并向 `GITHUB_STEP_SUMMARY` 写入四项中位数。
6. `lhci assert` 对同一批报告执行 median 断言。
7. Artifact 上传步骤无论断言成功或失败都尝试上传 HTML 和 JSON，保存 14 天。
8. workflow 最终状态由配置、采集、摘要、断言和报告上传共同决定。

## 失败处理

- `MONITOR_URL` 缺失或不安全：在启动 Lighthouse 前失败。
- 依赖安装失败：workflow 失败，不访问服务器。
- 页面无法访问、Chrome 启动失败、采集超时或不足 3 份报告：workflow 失败。
- 报告 JSON 损坏、分类缺失或分数非法：摘要步骤失败。
- 任一中位数低于阈值：断言步骤失败。
- 有报告时，即使断言失败也上传 Artifact；完全没有报告时，Artifact 步骤明确报错。
- Artifact 上传失败：workflow 失败，避免误以为已有可诊断报告。
- 所有失败均不触发重启、回滚、重新部署或服务器写操作。

GitHub Actions 页面是检查状态的事实来源。邮件可能延迟或被邮箱过滤；现有 `Only notify for failed workflows` 设置会在该 workflow 失败时通知相应用户。手动运行通知属于触发用户，定时运行通知接收人遵循 GitHub 的 scheduled workflow actor 规则。

## HTTP 生产地址说明

当前 `MONITOR_URL` 是 HTTP 公网地址。Lighthouse 可能因 HTTPS、性能或其他真实质量问题使最佳实践等分类低于阈值。首次运行变红并不代表自动化配置错误；应先下载报告确认失败审计项。

本设计不会自动降低阈值、关闭失败审计或改写生产 URL。任何后续域名和 HTTPS 配置应作为独立任务处理。即使 Lighthouse 持续失败，生产发布仍可正常进行。

## 安全边界

- 不新增 Secret、邮件授权码、Webhook 或第三方服务凭据。
- 不读取现有阿里云部署 Secret。
- 不连接 SSH，不执行远程命令。
- 不修改 `MONITOR_URL`、服务器或生产文件。
- 不把 Lighthouse 报告上传到公共临时存储。
- GitHub Actions 固定完整 commit SHA，npm 依赖由 lockfile 固定并使用 frozen install。
- 报告只包含公开生产页面的审计数据；Artifact 的访问权限继承 GitHub 仓库权限。

## 测试策略

实施使用测试驱动方式：先增加失败的配置、摘要和 workflow 契约测试，再实现最小生产配置。

专用验证至少包括：

- `pnpm test:lighthouse`；
- 从 YAML 提取全部 `run` 块并执行 `bash -n`；
- 对配置文件进行结构化加载，而不是字符串猜测；
- 使用临时 LHR fixture 验证摘要输出和失败关闭；
- 验证 workflow 不含 `secrets.`、`environment`、SSH/SCP/rsync 和非官方 Action；
- 验证 Artifact 上传在断言失败后仍运行且保留 14 天；
- 验证 job 与步骤超时预算有界。

完整回归包括：

- `pnpm lint`；
- `pnpm typecheck`；
- `pnpm test`；
- `pnpm test:monitor`；
- `pnpm test:deploy`；
- `pnpm build`。

如果主工作树中的 Vitest 扫描到 `.worktrees/**`，验证命令必须明确排除该目录或在隔离 worktree 中运行，不能把其他 worktree 的测试结果算入当前分支。

## 操作交接

代码进入远程 `main` 后：

1. 打开仓库 `Actions`。
2. 选择 `生产站点 Lighthouse 检查`。
3. 在 `main` 上手动运行一次。
4. 查看 Actions Summary 中四项中位数。
5. 在运行页面下载 Lighthouse Artifact，确认包含 HTML 和 JSON。
6. 如果分数不达标，保持红色结果并根据报告处理，不要为了让检查变绿而关闭审计或降低阈值。
7. 不修改 `MONITOR_URL`、Nginx、服务器文件或部署 Secret 来测试失败。

如果首次检查成功，不要求收到邮件；如果首次检查因真实分数或执行问题失败，现有 GitHub 失败邮件设置应通知该运行对应的接收用户。

## 不在本次范围内

- 阻止 Tag 发布；
- 自动优化图片、视频、CSS 或 JavaScript；
- 自动修改 Lighthouse 阈值；
- 域名、DNS、HTTPS 或证书配置；
- Lighthouse CI Server、长期趋势图或外部数据仓库；
- PR 评论、状态徽章或公共报告链接；
- 企业微信、钉钉、飞书、短信或电话通知；
- 自动修复、重启、回滚或重新部署。

## 验收标准

- 每天一次和手动触发均存在，且不与部署 workflow 耦合。
- 使用 `MONITOR_URL` 对生产站点执行 3 次移动端 Lighthouse 检查。
- Actions Summary 展示四项中位数和阈值。
- Lighthouse CI 以 median 聚合执行 `0.70 / 0.90 / 0.90 / 0.90` 断言。
- 达标时 workflow 为绿色；不达标、采集异常或报告异常时为红色。
- HTML 和 JSON Artifact 在有报告时始终上传并保留 14 天。
- 失败不会阻止发布或修改服务器。
- workflow 只读、无 Secret、无 SSH、无第三方 Action，官方 Action 固定完整 SHA。
- 专用测试、现有测试、Lint、类型检查、部署测试、监控测试和生产构建全部通过。
- 用户在远程 `main` 上完成一次真实手动运行并能查看摘要和报告。

## 参考资料

- [Lighthouse CI configuration](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md)
- [Lighthouse CI getting started](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/getting-started.md)
- [Lighthouse reports](https://github.com/GoogleChrome/lighthouse/blob/main/readme.md#viewing-a-report)
- [GitHub Actions artifact retention](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
