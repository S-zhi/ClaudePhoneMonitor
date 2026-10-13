# Magpie 开发约定

## 独立桌面运行包

`npm run build && npm run package:magpie` 生成 `artifacts/magpie-backend-<SOURCE_SHA>.tar.gz` 和相应 `.sha256`。归档只含编译后的 Protocol、Collector、Relay、锁文件、启动/配对脚本和 `SOURCE_COMMIT`；不含 `node_modules`、用户会话、凭据或运行状态。它是 macOS 桌面运行包，不依赖仓库 checkout 或 TypeScript 编译器。解压后联网执行 `scripts/setup-magpie-monitor.sh` 安装锁定的生产依赖，再用 `scripts/start-magpie-monitor.sh --check` 检查本机条件。

运行需 Node 24.13.0 至 24.x、Python 3、Swift 命令行工具、curl、OpenSSL 和本机 `magpie` CLI。在可信局域网内运行 `scripts/start-magpie-monitor.sh --pair --open-qr`，手机用此包生成的一次性 QR 配对。默认使用 `~/.claude-phone-monitor-magpie`、端口 `8788`，与原服务的数据库、凭据、Collector socket 和安装身份分开；可通过 `MAGPIE_MONITOR_HOME`、`MAGPIE_RELAY_PORT`、`MAGPIE_RELAY_LAN_IP`、`MAGPIE_BIN` 调整。启动器清理继承的旧服务环境变量，不安装 Claude Hook 或改动原服务设置。`Ctrl-C` 只结束本次启动的子进程。

此入口默认读取 Magpie 的安全会话历史元数据，并开启原生 Codex 会话活动监听；传 `--no-watch-codex` 可保存关闭选择。Magpie CLI 的会话列表本身不提供任务/工具活动状态，也无法识别前台焦点；这部分仍需有来源依据的原生适配器或桥接事件。Android APK 目前仅用于本地测试，尚未发布，也没有可下载的 GitHub Release；如需测试，请从当前源码自行构建并安装 APK。本文不代表设备安装已经完成。

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

## Magpie 会话历史读取

可选开启 `COLLECTOR_WATCH_MAGPIE_SESSIONS=1` 或 `--watch-magpie-sessions`，默认关闭。Collector 只读取 `magpie sessions --json --limit N` 返回的最近 N 条，将安全身份、可核实的原生标题和来源时间写为 `session_metadata_updated`；没有标题和时间时也可只记录身份。只有来源明确提供的 `source_started_at` 才能作为会话创建时间。Relay 快照的 `history_sessions` 最多返回最近 50 条；来源的最近 N 条并非完整历史。时间变化和列表缺失都不能证明工作中或已结束；当前活动必须有原生监听或桥接事件依据，否则状态为 `unknown`。此方案也无法观察哪个 Agent 窗口处于前台或获得焦点。

Magpie CLI 的 `title` 可能是首条提示词，始终丢弃。Codex UUID 会话只用本机原生标题，身份与 Codex 原生监听统一；组合运行时排除 Claude Code 的 Magpie 行，由现有 Hook 负责其活动。原始 ID、路径、工作目录、提示词、恢复命令和转录正文不会进入事件。私有 checkpoint 仅保存哈希身份与安全元数据指纹；每轮批量写入，入队失败下轮重试，列表暂时挤出或重启不会重放已记录的行。

通用 Agent 桥接区分已有文件的追加内容和新发现或轮转文件的初始片段：初始片段的事件必须带有效且新鲜的来源时间，才可形成实时状态；追加事件缺少时间时，使用观察时间，不声称是精确来源时间。读取预算允许为推进游标而多读一条有上限的完整记录。任务、工具、等待、完成等状态仍需各 Agent 的原生或桥接生命周期证据。路由、Token 与成本历史，以及生产环境和手机安装验证，留待后续阶段。
