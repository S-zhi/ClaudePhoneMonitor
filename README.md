# Claude Phone Monitor

一个面向 Claude Code 的 Android 像素宠物监控应用：macOS 上的 Claude Code Hook 将脱敏生命周期事件交给本地 Collector，Collector 通过 WebSocket 发送到同一台 Mac 上的 Relay，Android 通过局域网 QR 配对后显示真实状态。

## 当前实现

- `packages/protocol/`：canonical v1 事件/消息类型、隐私校验、状态 reducer、sequence/resume 辅助。
- `services/collector/`：macOS Claude Hook Adapter、只读 Codex 会话监听、Unix Socket、持久化 outbox、WebSocket 心跳/重连/challenge、launchd Collector。
- `services/relay/`：Fastify 健康检查、collector/Android WebSocket、SQLite 持久化、一次性 pairing、角色令牌、事件 ACK、快照、resume、probe/challenge 和脱敏。
- `apps/android/`：Kotlin + Jetpack Compose 横屏沉浸式真实模式客户端，首次启动扫码配对，使用 Android Keystore 保存令牌；已移除 Mock/Demo 客户端。
- `skills/claude-monitor/`：安装/真实配对/诊断/状态/卸载 Skill 和 Hook 配置脚本。
- `tests/`：协议 smoke harness 和真实 LAN pairing 合约测试。

## JavaScript 测试

需要 Node.js 24.13.0（固定版本见 `.node-version`）；完整环境与 CI 复现见 [CI 指南](docs/ci.md)：

```bash
npm run ci:install
```

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

真实 LAN live test 默认跳过；配置 `RELAY_BASE_URL` 和 `RELAY_BOOTSTRAP_SECRET` 后才会连接运行中的 Relay：

```bash
RELAY_BASE_URL=http://127.0.0.1:8787 RELAY_BOOTSTRAP_SECRET='your-secret' node --test tests/real-lan-contract.test.mjs
```

## Mac 局域网真实部署

Relay、Collector 和 Claude Code 运行在同一台 Mac。Android 必须使用 Mac 的局域网 IP，不能使用 `127.0.0.1`。

### 1. 启动 Relay

```bash
RELAY_HOST=0.0.0.0 RELAY_PORT=8787 RELAY_PUBLIC_URL=http://192.168.1.3:8787 RELAY_BOOTSTRAP_SECRET='replace-with-a-long-url-safe-secret' RELAY_DB_PATH="$HOME/.claude-phone-monitor/relay.sqlite" npm --prefix services/relay run start
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

配置 `RELAY_BOOTSTRAP_SECRET` 后 Relay 自动进入 paired 模式；没有该变量时才是本地 development 模式。真实安装必须配置 `RELAY_DB_PATH`，否则重启会丢失配对和事件状态。

### 2. 构建 Collector

```bash
npm --prefix services/collector run build
```

### 3. 通过 Skill 配对

```bash
RELAY_BOOTSTRAP_SECRET='replace-with-the-same-secret' skills/claude-monitor/scripts/pair --relay-http http://127.0.0.1:8787 --relay-ws ws://192.168.1.3:8787/ws/collector --public-url http://192.168.1.3:8787
```

配对脚本会：

- 生成一次性 pairing code；
- 从 Relay 获取 collector token；
- 将配置写入 `~/.claude-phone-monitor/monitor.env`，权限为 `0600`；
- 生成 `pairing.json` 和 `pairing.png`；
- QR 中不包含长期 token；
- 如果已有 launchd Collector，会尝试重新加载它。

### 4. 安装真实 Hook 和 Collector

```bash
skills/claude-monitor/scripts/install
```

```bash
skills/claude-monitor/scripts/doctor --strict
```

Hook 使用 `services/collector/dist/cli.js --event EVENT`，launchd 使用同一个 CLI 的 `--collector` 模式。Collector 令牌通过环境文件加载。默认遥测模式的 Hook 保持 fail-open，不等待用户审批；显式启用的[可选审批桥](docs/issue-23-approval-reminder.md)会暂时持有 `PermissionRequest`，等待手机决定或返回电脑处理。

### 5. Android 扫码

安装 [Debug APK](apps/android/build/outputs/apk/debug/android-debug.apk) 后打开应用，扫描 `pairing.png`。Android 会调用 claim API 获取自己的令牌，然后连接 QR 中的 `/ws/android` 地址。

Android 端令牌存入 Android Keystore；重新配对会清除旧令牌。当前局域网版本使用 `ws://`，只适合可信局域网；跨网络或公网部署前必须切换 WSS/TLS。

## Android 构建

构建使用 JDK 21、提交的 Gradle 8.14.5 Wrapper、Android SDK Platform 35、Build Tools 35.0.0。Java/Kotlin 字节码目标仍为 17。SDK 配置与许可证要求见 [CI 指南](docs/ci.md)。

```bash
./gradlew --no-daemon :apps:android:lintDebug :apps:android:testDebugUnitTest :apps:android:assembleDebug
```

APK 输出：

```text
apps/android/build/outputs/apk/debug/android-debug.apk
```

应用特性：

- 仅横屏；
- 隐藏系统栏；
- 使用 `update_clawd_assets` 分支提供的 Clawd 帧矩阵作为主角，Compose Canvas 原生渲染；
- 横屏沉浸式暖炭黑舞台；常态显示会话列表和 Clawd，强提醒的 15 秒改变状态页以左侧大字、右侧 Clawd 分屏展示；
- 执行超过 5 分钟的任务完成、任务失败、明确需要用户操作的等待，以及长任务运行中断连，会显示 15 秒改变状态页；短任务与普通状态变化仅在当前页面内提示 5 秒；
- 显式启用 Claude 审批桥后，真实 `PermissionRequest` 立即显示独立 `Awaiting approval` 页及相关任务、工具和可操作入口；未处理时最多强提醒 5 分钟，确认已处理后原页展示结果 15 秒再恢复正常页面。重复事件、刷新和重连不会重启期限，未决审批在状态页和 Usage 页持续保留入口；
- 任务时长从 `task_started` 起算，等待时间计入；恰好 5 分钟或既无可靠起点、也无合法事件时长时采用弱提醒。重复事件、心跳与快照刷新不会重置提醒倒计时；
- 多主会话中单个任务完成时保留其他主任务的 `WORKING` 聚合状态，同时显示该任务的 `FINISH` 提示与完成会话名称；
- 主列表先过滤已识别子代理，再展示最近的五个主会话；`Main Running` 与 `Main Sessions` 统计全部有效主会话，`Total Running` 统计主会话及子代理的独立运行线程，旁边显示 `Includes subagents`。旧服务缺少明确统计时显示 `—`；
- `WORKING` 使用 Clawd 坐在灰色笔记本电脑后打字的动作；
- 首次启动 QR 配对页；
- Android Keystore 加密保存令牌；
- 真实 WebSocket snapshot/event；
- 无 Mock 客户端和 Demo 控件。

提醒分级见 [Issue #17 说明](docs/issue-17-reminder-policy.md)，独立审批页与可选决策桥见 [Issue #23 说明](docs/issue-23-approval-reminder.md)。

展示方向见 [Clawd 界面整合设计](docs/clawd-ui-design.md)；[待机构图](docs/clawd-design-idle.png) 和 [完成构图](docs/clawd-design-finish.png) 是按分支 STILL 帧绘制的设计参考，不是 APK 或真机截图。强提醒沿用完成构图的左右分屏，任务名称取实际会话。

## 事件和隐私

协议层和 Relay 都使用白名单字段。允许的事件元数据包括事件类型、工具名称、耗时、退出码、错误类别、等待原因、会话/任务 ID 和序号；审批桥另传独立请求/决定 UUID、来源、明确交付状态及期限。监控器的 IPC、outbox 和日志不转发或持久化 prompt、工具输入/输出、命令、路径、stdout/stderr、密钥及授权头。桥 Hook 的本地提示也仅包含请求编号及工具元数据，不复制原始操作输入。

## 可选 Claude 审批桥

默认仍只观察 Hook。需要手机的真实审批入口及完整请求/结果链路时，先停止正在运行的 Collector，再显式运行：

```bash
scripts/start-lan-monitor.sh --approval-bridge
```

该选项会安装 monitor-owned 的阻塞 `PermissionRequest` Hook，并保存启用选择；只有通过现有配对令牌鉴权的手机才能提交决定。手机只显示工具和任务等元数据，**批准前先在电脑核对待执行操作；无法可靠识别时选“在电脑处理”**。请求编号标识本桥请求，不表示 Claude 原生弹窗中也显示同一编号。`Approve` / `Deny` 将决定交付给原 Hook；`在电脑处理` 立即释放 Hook，继续 Claude 的原生权限流程。存在同会话、同工具的多个未决请求时，手机禁止 `Approve`，仍可返回电脑处理。

Hook 最多等待 10 分钟；超时、来源断连或恢复旧请求时，不替用户选择允许或拒绝，手机显示 `Approval status unavailable` 并提示核查电脑。`Approval sent` / `Denial sent` 仅表示决定已交付给 Claude Hook，实际执行仍受 Claude 其他权限规则和 Hooks 约束。关闭桥并恢复观察用 Hook：

```bash
scripts/start-lan-monitor.sh --no-approval-bridge
```

本桥覆盖 Claude 的 `PermissionRequest` 工具权限，不覆盖只发 `permission_prompt` 通知的 sandbox network 请求，也不代理 Codex 审批决定。`--watch-codex` 另外通过现有 Desktop IPC 只读观察原生审批待办，手机显示同一独立提醒页；电脑解除待办后显示结果 15 秒，再恢复正常页面。Codex sessions JSONL 本身不包含权威审批通道，普通等待和长时间静默不会被推断成审批。具体边界与验证见 [Issue #23 说明](docs/issue-23-approval-reminder.md)。

## 一键启动脚本

已提供 [Start Claude Phone Monitor.command](Start%20Claude%20Phone%20Monitor.command)。在 Finder 中双击它，会自动：

- 构建 Relay 和 Collector；
- 启动同一台 Mac 上的局域网 Relay；
- 生成或复用 bootstrap secret；
- 验证未过期的一次性 QR，或刷新已领取/过期/地址变更的 QR；
- 生成并打开 `pairing.png`；
- 安装 monitor-owned Claude Hooks；
- 首次询问是否启用 Usage，并记住选择；
- 启动 Collector。

也可以在终端运行：

```bash
scripts/start-lan-monitor.sh --pair --install-hooks --open-qr --configure-usage
```

脚本会检查 Relay 的 pairing 与 Usage 兼容能力。过期或已领取的 QR 会自动刷新，同时保留 installation ID、Collector token、Relay 数据库和 Usage 统计起点；要主动换一张新码时使用 `--pair`。如果目标端口运行着旧版或配置不兼容的 Relay，脚本会拒绝复用并提示你先手动停止旧实例，不会自行结束未知进程。

启动前会通过 Collector Unix socket 做一次无数据连接探测；如果已有 Collector 正在监听，脚本会停止并保留现有服务与配对文件，避免重复启动。启动 Collector 前会再次检查。

脚本会保持前台运行，按 `Ctrl-C` 只停止本次脚本启动的 Relay/Collector。只启动已经配对的服务时可以使用：

```bash
scripts/start-lan-monitor.sh
```

`--install-hooks` 会修改用户级 `~/.claude/settings.json`；如果只想验证服务而不改 Claude 配置，不要传这个选项。
配对二维码为一次性码，终端会显示到期时间；旧二维码过期后请重新运行启动命令，或显式加 `--pair`。

需要同时观察本机 Codex 桌面应用和 CLI 时，可显式启用只读 sessions 监听：

```bash
scripts/start-lan-monitor.sh --watch-codex
```

等价的环境开关是 `COLLECTOR_WATCH_CODEX=1`；直接运行 Collector 时也可使用
`--collector --watch-codex`。监听默认读取 `$CODEX_HOME/sessions`，未设置
`CODEX_HOME` 时读取 `~/.codex/sessions`；可用
`COLLECTOR_CODEX_SESSIONS_DIR` 指定其他目录。监听只读取 sessions JSONL 的安全
生命周期字段，不安装 Hook、不修改 Codex 配置。首次默认关闭；
`--watch-codex` 会保存启用选择，后续普通重启仍会监听；需要关闭时显式使用
`--no-watch-codex`。环境变量只覆盖当前启动，不改保存的选择。
若手机显示 `RELAY CONNECTED`，但结束的任务仍留在 Working 列表，先检查启动日志是否显示
`Codex session monitoring: enabled`，以及 Collector 进程是否带有 `--watch-codex`。
`RELAY CONNECTED` 只表示手机连上 Relay，不能证明 Codex 生命周期正在采集；
用 `scripts/start-lan-monitor.sh --watch-codex` 重启服务会恢复监听并保存该选择。

Codex 会话名称只从本机原生标题元数据读取：优先使用 `state_*.sqlite` 的
`threads.name`，其次是 `session_index.jsonl` 中同 UUID 的最新 `thread_name`，
旧版无 name 时才使用安全的 `threads.title`；不从 prompt、消息正文或预览生成名称。
标题必须通过 64 字符、路径、URL、控制字符及凭据检查；明确无效的新名称会撤回为
`Codex` 加短身份 hash，不沿用过去的名称。元数据目录默认是**已配置 sessions 目录的父目录**，
可用 `COLLECTOR_CODEX_METADATA_DIR` 或 Collector 的 `--codex-metadata-root PATH`
显式覆盖；同目录及其 `sqlite/` 子目录中的数据库都支持，不串读其他 Codex Home。
读取为只读，名称和原 UUID 不写入 checkpoint。改名即使没有新增 rollout 行，也只发送
`session_title_updated` 元事件，不重放任务开始、完成或改变运行数。

Codex 会话记录格式随版本变化。当前投影只报告可核实的 WORKING、正常完成 FINISH、
已确认的 `server_overloaded` 错误以及中性回稳；未知错误、中断、等待状态和工具活动
不会被推断。源文件连续 30 分钟没有增长或修改会中性结束会话，不代表完成、错误或等待；
这个阈值短于 Relay 的两小时 working-session TTL。原始会话内容、命令、工具输入/结果、
错误文本和完整路径不会进入 Relay。诊断只输出固定错误码，例如
`codex_jsonl_unsupported_shape`、`codex_jsonl_malformed_row` 和
`codex_source_read_failed`；这些代码提示本机来源格式或可读性需要复查，不代表任务失败，
也不包含计数、路径或源数据。

Codex 子代理只依据明确的 `thread_source = "subagent"` 或已支持的 `source.subagent`
元数据识别，包含 `{ other: "guardian_review" }` 形式的后台审核线程；父线程 ID、标题和 UUID 外形都不作为分类依据，未知格式继续视作主会话。
子代理仍被采集、持久化并推进事件序号，但不参与主会话列表、聚合状态或完成/错误提醒。
分类保存在本地 checkpoint 和 Relay 会话存储中；旧 checkpoint 重启时有界补读来源元数据，
用 `session_classification_updated` 纠正分类，不重放历史完成，也不改变任务状态、活动排序或过期时间。
统计范围仅包含监控器实际采集到的线程，不扩展 Claude Hook 的内部子任务采集能力。

需要在 Usage 页汇总本机 Claude Code 与 Codex 的 token 用量时，可另外显式开启只读账本：

```bash
scripts/start-lan-monitor.sh --watch-usage
```

双击入口首次在终端询问是否开启 Usage，选择保存在私有的
`~/.claude-phone-monitor/usage.preference`（权限 600，或由 `CLAUDE_PHONE_MONITOR_HOME`
指定目录）。普通启动沿用保存选择；`--watch-usage` / `--no-watch-usage` 分别保存开启 / 关闭。
`COLLECTOR_WATCH_USAGE=1` / `0` 仅覆盖本次启动，显式 CLI 选项优先。未选择且非交互启动时
保持关闭，并打印开启命令。直接运行 Collector 时使用 `--collector --watch-usage` 或上述环境
开关，默认关闭；启动脚本的保存选择只用于该脚本。保存选择损坏时关闭 Usage 并继续启动状态监控，
可用显式选项修复普通配置文件；无法安全保存时提示选择仅对本次生效。采集器读取
`~/.claude/projects` 与 `$CODEX_HOME/sessions`（默认 `~/.codex/sessions`），可分别用
`COLLECTOR_CLAUDE_PROJECTS_DIR` 和 `COLLECTOR_CODEX_SESSIONS_DIR` 指定来源。首次启用时
建立并持久化统计起点，不回填之前的历史；之后重启从本地游标追读。去重按 Claude 消息或
Codex response 身份，页面请求数表示“已观测模型响应”，不包括来源不可见的内部重试。
私有 `usage.sqlite` 只保存匿名身份散列、用量数字与游标，不保存 transcript 正文或完整路径；
Relay 只收到绝对汇总。缓存字段缺失或来源不可用会标记部分/不可用，剩余额度无真实来源时
保持不可用。诊断只输出固定代码，不输出原始数据。

单行 JSONL 最多读取 4 MiB，允许包含长正文的普通记录先解析类型再忽略。
超过该上限或损坏的记录会跳过并保守标记覆盖缺口，后续有效记录继续计数。
旧账本已有的覆盖缺口会继续显示部分覆盖；重启不会清除统计起点或伪装成完整数据。

口径按响应来源区分：Claude 新增输入为 `input_tokens + cache_creation_input_tokens`，Codex
新增输入为 `input_tokens - cached_input_tokens`；实际消耗为新增输入加输出，总输入再加缓存命中
Tokens。只有缓存分子、分母和两个来源覆盖都完整时才给完整命中率；缺失字段不会填零。

## 当前限制

- LAN MVP 的 `ws://` 未加密，只能运行在可信局域网；生产公网需要 WSS/TLS。
- FCM 后台推送尚未接入，前台 WebSocket 已可用。
- 真实 Claude Hook payload 仍需针对目标 Claude Code 版本做脱敏 fixture 验证；未知字段会被忽略。
- Codex 监听需要显式启用。已核实桌面应用版本为 26.930.61225（内嵌 runtime 0.160.0），
  独立 CLI 二进制为 0.159.3；两种执行形态不可混称。当前 Codex 会话 JSONL 格式不稳定。
  本项不假定可观察显式等待、全部工具活动或所有错误。
- 独立审批页在当前 Android ViewModel 中保存待处理的五分钟截止与确认结果的 15 秒截止，页面切换与 WebSocket 重连不会重置；App 进程结束后的期限恢复尚未持久化。此前七项实机用例的历史证据见[验证报告](docs/device-testing/issue23-2026-10-07.md)，真实 Codex 原生链路见 [Codex 实机复验](docs/device-testing/issue23-codex-2026-10-08.md)。阻塞问答仍仅覆盖 Claude 的明确工具和通知来源。
- Android 真机上的原生 Compose fixture 四项通过，覆盖多 Session 列表、完成名称、Working 优先、短横屏和大字号布局。当前后端已更新并启用 Codex 监听，保留原配对；真机确认 Relay 已连接、当前聊天真实原生任务名称已显示，无可用安全名称的其他会话允许匿名回退，见 [issue #4 验证记录](docs/device-testing/issue4-reimplementation-2026-10-07.md)。含私人任务名的新截图仅留本地；真实完成页的完整 15 秒可见时长尚未录屏，截止与迟到补名逻辑由 JVM 测试验证。

## 目录

```text
apps/android/                  Android Compose real-mode client
packages/protocol/             shared TypeScript protocol
services/collector/            macOS collector and Hook Adapter
services/relay/                LAN relay service
skills/claude-monitor/         Skill and macOS setup scripts
tests/                         protocol and LAN contract harness
docs/                          deployment and operator notes
```
