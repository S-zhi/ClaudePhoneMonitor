# Magpie 开发约定

## 分支基线

`dev/magpie` 从清理基线 `46452d4` 开始，作为 Magpie 入口和 Agent 会话监听能力的长期开发分支。Magpie 相关提交直接进入 `dev/magpie`；`main` 是稳定基线，Magpie 功能长期禁止合并回 `main`。

工作区清理时先记录当前分支、HEAD、远端跟踪关系和工作区状态，再按提交来源核对已有文件。未确认来源的改动必须保留，不能用 `reset --hard`、`checkout --` 或删除文件来“清理”。

## 入口合同

Collector 是会话适配器的统一入口。适配器可以读取 Agent 明确暴露的本地会话文件、Hook 或数据库，把可安全转发的生命周期元数据归一化后交给现有 Collector、Outbox 和 Relay 链路。首批事件包括会话开始、标题变化、任务开始/完成/失败、工具开始/完成/失败、等待和会话结束。

每种 Agent 都要维护稳定的 `agent_id`、哈希后的 `session_id`、增量读取 checkpoint、启动基线、重复抑制、stale 超时和诊断计数。prompt、工具参数/结果、命令、路径、标准输出、密钥和授权头不得进入手机边界。Magpie 路由、历史用量和成本属于独立元数据，不伪造成生命周期事件。

## 分支门禁

`dev/magpie`、`dev/magpie-*` 和 `codex/magpie-*` 代表 Magpie 开发分支，它们的 PR 目标必须是 `dev/magpie`。`.github/workflows/branch-policy.yml` 使用 `pull_request_target` 读取 PR 的 base/head 元数据，不 checkout 或执行 PR 代码；job 名为 `Prevent dev/magpie to main`。

该工作流提交到远端并在 GitHub Ruleset/Branch protection 中设为 required status check 之前，远端门禁不会生效。禁止改名、cherry-pick 或直接 push 的判断超出此检查范围；main 的直接 push 仍应由 GitHub branch protection 单独限制。

## 里程碑

1. 完成分支和工作区基线清理，验证 `dev/magpie` 的 CI。
2. 打通单个 Agent 的只读会话适配器、标题变化和活动状态。
3. 接入任务、工具、等待、完成和失败事件，并验证 Relay 聚合。
4. 增加 `agent_id` 和多 Agent Android 展示。
5. 接入 Magpie 路由、历史用量和成本查询。
