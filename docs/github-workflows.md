# GitHub 工作流

本仓库的 `.github/` 复制自 [S-zhi/Juejin](https://github.com/S-zhi/Juejin)，源 commit：`b86acaa63e325e0bce565b8b8d21021e69c27b70`。

三个工作流分别负责 issue 状态流转（`state-control.yaml`）、issue 动作控制（`action-control.yaml`）和标签同步（`sync-labels.yml`）。

## 启用

将改动提交到默认分支 `main` 并在仓库设置中启用 GitHub Actions 后，可手动运行 **Sync labels** 同步 8 个标签。到仓库 Actions secrets 中配置 `TYPESAFE_API_KEY`。

需要实际执行任务时，还需另行接入外部 Agent；当前 [`action-policy.yaml`](../.github/action-policy.yaml) 的 `agents` 是空数组，工作流不会启动 Agent。协议见 [agent-action-protocol.md](../.github/protocols/agent-action-protocol.md)。

目标标签页：[ClaudePhoneMonitor labels](https://github.com/S-zhi/ClaudePhoneMonitor/labels)

## 本地验证

本地验证需要 Python 3.12 和 PyYAML 6.0.2。

```sh
python3 -m unittest discover -s .github/tests -p 'test_*.py'
python3 .github/scripts/sync_labels.py --repo S-zhi/ClaudePhoneMonitor --dry-run
```
