# Magpie session monitor plugin validation

这是运行在 Magpie Bun 插件宿主内的本地 Agent 会话历史与生命周期监控插件；不是独立 macOS/Linux 采集服务，也不注册 provider、auth 或 model。可通过私有配对配置启用插件内 Relay 转发，将验证过的会话元数据和 Codex 活动状态送到手机。

## Isolated end-to-end runner

The runner starts the installed Magpie web process with its own temporary `HOME` and XDG directories, installs this checkout through Magpie's plugin-management API, and uses synthetic Codex-native fixtures. It reuses the supplied Bun runtime and does not install or download runtimes. It never inherits API keys or the caller's home configuration. The synthetic history cache is produced by Magpie's real CLI rather than pre-seeded by the test. All runner-owned web/plugin children are tracked and stopped; reports are written under ignored `reports/` by default.

```sh
node --test tests/ci/magpie-session-plugin.test.mjs
node scripts/ci/magpie-session-plugin.mjs \
  --magpie /Users/wenzhengfeng/.local/bin/magpie \
  --bun /Users/wenzhengfeng/.cache/magpie/bun/1.4.2/magpie-bun
```

只读观察真实本机源目录时可添加 `--live-readonly`。运行时、配置与 CLI 缓存仍位于临时隔离 HOME，原生源目录仅作为只读输入；live 报告省略标题与 session 标识。

Live mode 使用 5 秒轮询、最多 5000 个 session 和 60 秒命令超时。插件输入上限为 8 MiB，每行上限 1 MiB，整体读取预算为 64 MiB。

## 本地安装与数据边界

需要安装时，先将发布包解压到用户选择的持久目录，再在 Magpie 的 Plugins 页面选择包含 `package.json` 与 `index.mjs` 的 `package` 子目录（不是解压父目录）。例如：

```sh
mkdir -p /tmp/magpie-plugin
tar -xzf artifacts/magpie-plugin/opencode-magpie-session-monitor-0.1.0.tgz -C /tmp/magpie-plugin
# 在 Magpie 中选择 /tmp/magpie-plugin/package
```

实际使用请改为自己选择的持久目录；开发时直接选择仓库的 `packages/magpie-monitor` 最简单。插件由 Magpie Bun 插件宿主运行；不需要安装或启动独立 macOS/Linux 服务。本文 E2E 用 Magpie web 模式验证宿主，不代表用户必须以 web 模式运行 Magpie。可在插件选项中设置 `pollIntervalMs` 与 `limit`（最大 5000）；默认分别为 5000 ms 和 5000 条。

插件在 Magpie 分配的插件目录下维护 `monitor-sessions/state.json` 与 SQLite 协调锁。Codex 标题来自原生 SQLite `threads.name` 或 `session_index.jsonl`，不从首条 prompt 推断。`working` 表示最近原生记录证明有尚未结束的 turn，`idle` 表示最近记录的 turn 已结束；两者都不代表底层进程在线或窗口位于前台。证据不足时为 `unknown`，不应解读为 inactive。本次 live 观察中其他 Agent 的当前执行状态均为 `unknown`。活动时长仅使用 Magpie CLI 自己生成的缓存估算值，基于小于 5 分钟的相邻记录间隔，不代表精确前台使用时间。插件不把快照遗漏当作会话结束，也不采集前台窗口或焦点状态。

合成 E2E 使用临时隔离配置和合成 fixtures；live E2E 使用临时 Magpie 配置并只读访问真实原生源目录。当时两种验证均未在真实用户 Magpie 配置中安装插件；所有测试启动的 web/plugin 进程均已退出。

Runner 通过 loopback Plugins 管理 API 安装插件，该 API 对应 Magpie Plugins 页面使用的管理路径；未验证视觉 UI 点击流程。本次仅验证 macOS arm64，未验证 Windows/Linux。

## Validation status

2026-10-13，Magpie `0.1.1211` / Bun `1.4.2`，`darwin/arm64`：合成 native E2E `10/10` gates 通过，报告 `reports/magpie-session-plugin/native-verified/report.json`；真实源只读观察 `4/4` gates 通过，报告 `reports/magpie-session-plugin/live-verified/report.json`。Live 观察到 3280 个 session：Codex 1684、Claude Code 49、Hermes 1547；执行状态 working 2、idle 34、unknown 3244；1286 个标题、3241 个历史活动记录，diagnostic codes 为空。两次运行的 cleanup 均为 complete。Node CI `19/19`、Bun 插件测试 `6/6`、全局 lint 均通过。

以上 E2E 不覆盖桌面点击安装流程、前台窗口/焦点状态或 Windows/Linux；真实数据验证是只读的。

插件单元测试由 `tests/ci/magpie-session-plugin.test.mjs` 导入；CI 测试本身不会启动 Magpie。真实 E2E 是有意执行的本地验证步骤，不属于常规 CI 测试。

## 桌面实例安装

2026-10-13，已将开发目录 `packages/magpie-monitor` 添加到用户日常使用的 Magpie，保留原有三个插件。刷新桌面页面后，已安装列表显示四个插件，其中 `magpie-monitor` 已启用。它显示“没有 magpie 能用的登录”，因为采集插件不提供模型登录，这是正常的界面分类。

已核对采集宿主是 Magpie 桌面进程的子进程，使用 Bun `1.4.3`；同一宿主的 tick 从 35 增至 36，读取 3341 个会话，诊断码为空。采集继续由 Magpie 管理；这次安装没有创建独立服务。

## USB 实机验证

2026-10-13，在 USB 连接的 Android 设备上安装隔离测试包 `.magpieusbtest`，保留原 `.myc23test` 应用与配对。生产 `MainActivity` 的 `MagpiePluginDeviceTest` 通过 `1/1`：合成原生 Codex 历史与改名、运行/完成、证据未知但不误报 DONE、停用 tick 停止、重新启用补采、隔离 Magpie Web 重启恢复和手机重连。该隔离实例使用 Magpie `0.1.1211` / Bun `1.4.2`；原始输出见 `reports/device-magpie-plugin/magpie-plugin-instrumentation.stdout.txt`。这是合成原生会话测试，不是从 Magpie UI 发起重命名；当前 Magpie 没有该控件。

随后验证日常桌面实例：Magpie PID `4673` 的 Bun `1.4.3` 子进程 PID `55164` 读取 `3352` 个真实会话，诊断为空、Relay 已连接、outbox 待确认数为零。当前真实 Codex 会话通过原生 API 临时改名后，Magpie CLI、插件、Relay 和 USB 手机均显示新标题及 Working；原标题已恢复并验证同步。报告见 `reports/device-magpie-plugin/live-native-rename.json`，截图见 `reports/device-magpie-plugin/phone-live-renamed.png`。本次没有运行独立 Collector；Relay 与 USB reverse 仅作为临时测试链路。

Relay 转发默认关闭；配置为宿主目录下权限 `0600` 的 `monitor-sessions/relay.json`，包含 `relay_url`、`installation_id` 与 `collector_token`，不得把内容写入日志。outbox 按 installation 隔离，先持久化再发送、收到 ACK 后删除；只有 writer 建立连接。证据丢失使用 `session_metadata_updated.payload.source_execution_status: "unknown"` 撤销 Working，不伪造完成；需要包含本分支扩展的 Relay。手机最多展示 50 条历史，插件每轮选择 100 条候选（另处理已发布任务的撤销）；当前仅转发有可信原生分类的 Codex 会话，不能声称支持所有 Agent 的实时执行状态或前台焦点。
