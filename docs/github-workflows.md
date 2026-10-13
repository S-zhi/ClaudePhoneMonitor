# GitHub 工作流

本仓库的 `.github/` 复制自 [S-zhi/Juejin](https://github.com/S-zhi/Juejin)，源 commit：`b86acaa63e325e0bce565b8b8d21021e69c27b70`。

项目 CI 的检查、前置条件、制品和合并保护配置见 [CI 指南](ci.md)。`ci.yml` 在 PR、`main` push 和 `dev/magpie` push 上运行；main 的原有调试制品流程保留。Magpie 当前只做无发行密钥的变体检查及本地测试包构建，远端发布由默认关闭的 `MAGPIE_PUBLISH_ENABLED` 仓库变量控制。`branch-policy.yml` 提供名为 `Prevent dev/magpie to main` 的检查，要求 Magpie 分支 PR 只以 `dev/magpie` 为目标；部署并配置 required check 后才具有远端强制作用。以下三个工作流分别负责 issue 状态流转（`state-control.yaml`）、issue 动作控制（`action-control.yaml`）和标签同步（`sync-labels.yml`）。

## Magpie 分支规则

完整约定、清理基线和入口合同见 [Magpie 开发约定](magpie-development.md)。`dev/magpie` 用于持续开发 Magpie 入口和会话监听能力，Magpie 功能禁止合并回 `main`。`dev/magpie`、`dev/magpie-*`、`codex/magpie-*` 的 PR 只能以 `dev/magpie` 为目标。工作流使用 `pull_request_target`，不 checkout 或执行 PR 代码，仅通过环境变量读取分支名称。它必须单独部署到受保护目标基线并配置 required check 后才生效；改分支名、cherry-pick 或直接 push 不属于这个检查的识别范围。

## 启用

将改动提交到默认分支 `main` 并在仓库设置中启用 GitHub Actions 后，可手动运行 **Sync labels** 同步 8 个标签。到仓库 Actions secrets 中配置 `TYPESAFE_API_KEY`。

需要实际执行任务时，还需另行接入外部 Agent；当前 [`action-policy.yaml`](../.github/action-policy.yaml) 的 `agents` 是空数组，工作流不会启动 Agent。协议见 [agent-action-protocol.md](../.github/protocols/agent-action-protocol.md)。

目标标签页：[ClaudePhoneMonitor labels](https://github.com/S-zhi/ClaudePhoneMonitor/labels)

## 本地验证

本地验证需要 Python 3.12 和 PyYAML 6.0.3。

```sh
python3 -m unittest discover -s .github/tests -p 'test_*.py'
python3 .github/scripts/sync_labels.py --repo S-zhi/ClaudePhoneMonitor --dry-run
```
