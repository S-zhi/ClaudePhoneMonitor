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

需要 Node.js 20+：

```bash
npm install --prefix packages/protocol
```

```bash
npm install --prefix services/collector
```

```bash
npm install --prefix services/relay
```

```bash
npm test
```

```bash
npm run typecheck
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

Hook 使用 `services/collector/dist/cli.js --event EVENT`，launchd 使用同一个 CLI 的 `--collector` 模式。Collector 令牌通过环境文件加载，Hook 仍然 fail-open，不会阻塞 Claude Code。

### 5. Android 扫码

安装 [Debug APK](apps/android/build/outputs/apk/debug/android-debug.apk) 后打开应用，扫描 `pairing.png`。Android 会调用 claim API 获取自己的令牌，然后连接 QR 中的 `/ws/android` 地址。

Android 端令牌存入 Android Keystore；重新配对会清除旧令牌。当前局域网版本使用 `ws://`，只适合可信局域网；跨网络或公网部署前必须切换 WSS/TLS。

## Android 构建

当前构建环境：JDK 17、Gradle 8.14.5、Android SDK Platform 35、Build Tools 35.0.0。

```bash
gradle :apps:android:testDebugUnitTest :apps:android:assembleDebug
```

APK 输出：

```text
apps/android/build/outputs/apk/debug/android-debug.apk
```

应用特性：

- 仅横屏；
- 隐藏系统栏；
- 使用 `update_clawd_assets` 分支提供的 Clawd 帧矩阵作为主角，Compose Canvas 原生渲染；
- 横屏沉浸式暖炭黑舞台，待机居中，状态变化短暂以大字和 Clawd 分屏展示；
- 有意义的状态变化与任务结果显示 15 秒改变状态页，倒计时由单调时钟截止；重复事件、心跳及同状态工具事件不会重置计时；
- 连接后常态展示状态页；真实状态变化或任务结果会切换到改变状态页 15 秒，然后回到最新状态页；
- 多会话中单个任务完成时保留全局 `WORKING` 聚合状态，同时显示该任务的 `FINISH` 提示与完成会话名称；
- `WORKING` 使用 Clawd 坐在灰色笔记本电脑后打字的动作；
- 首次启动 QR 配对页；
- Android Keystore 加密保存令牌；
- 真实 WebSocket snapshot/event；
- 无 Mock 客户端和 Demo 控件。

展示方向见 [Clawd 界面整合设计](docs/clawd-ui-design.md)；[待机构图](docs/clawd-design-idle.png) 和 [完成构图](docs/clawd-design-finish.png) 仅是按分支 STILL 帧绘制的设计参考，不是 APK 或真机截图。

## 事件和隐私

协议层和 Relay 都使用白名单字段。允许的事件元数据包括事件类型、工具名称、耗时、退出码、错误类别、等待原因、会话/任务 ID 和序号。禁止转发和持久化 prompt、工具输入/输出、命令、路径、stdout/stderr、密钥及授权头。

## 一键启动脚本

已提供 [Start Claude Phone Monitor.command](Start%20Claude%20Phone%20Monitor.command)。在 Finder 中双击它，会自动：

- 构建 Relay 和 Collector；
- 启动同一台 Mac 上的局域网 Relay；
- 生成或复用 bootstrap secret；
- 创建一次性 QR pairing；
- 生成并打开 `pairing.png`；
- 安装 monitor-owned Claude Hooks；
- 启动 Collector。

也可以在终端运行：

```bash
scripts/start-lan-monitor.sh --pair --install-hooks --open-qr
```

脚本会保持前台运行，按 `Ctrl-C` 会停止本次脚本启动的 Relay/Collector。只启动已经配对的服务时可以使用：

```bash
scripts/start-lan-monitor.sh
```

`--install-hooks` 会修改用户级 `~/.claude/settings.json`；如果只想验证服务而不改 Claude 配置，不要传这个选项。

需要同时观察本机 Codex 桌面应用和 CLI 时，可显式启用只读 sessions 监听：

```bash
scripts/start-lan-monitor.sh --watch-codex
```

等价的环境开关是 `COLLECTOR_WATCH_CODEX=1`；直接运行 Collector 时也可使用
`--collector --watch-codex`。监听默认读取 `$CODEX_HOME/sessions`，未设置
`CODEX_HOME` 时读取 `~/.codex/sessions`；可用
`COLLECTOR_CODEX_SESSIONS_DIR` 指定其他目录。监听只读取 sessions JSONL 的安全
生命周期字段，不安装 Hook、不修改 Codex 配置；如关闭监听，省略选项或使用
`--no-watch-codex`。

Codex 会话记录格式随版本变化。当前投影只报告可核实的 WORKING、正常完成 FINISH、
已确认的 `server_overloaded` 错误以及中性回稳；未知错误、中断、等待状态和工具活动
不会被推断。源文件连续 30 分钟没有增长或修改会中性结束会话，不代表完成、错误或等待；
这个阈值短于 Relay 的两小时 working-session TTL。原始会话内容、命令、工具输入/结果、
错误文本和完整路径不会进入 Relay。诊断只输出固定错误码，例如
`codex_jsonl_unsupported_shape`、`codex_jsonl_malformed_row` 和
`codex_source_read_failed`；这些代码提示本机来源格式或可读性需要复查，不代表任务失败，
也不包含计数、路径或源数据。

## 当前限制

- LAN MVP 的 `ws://` 未加密，只能运行在可信局域网；生产公网需要 WSS/TLS。
- FCM 后台推送尚未接入，前台 WebSocket 已可用。
- 真实 Claude Hook payload 仍需针对目标 Claude Code 版本做脱敏 fixture 验证；未知字段会被忽略。
- Codex 监听需要显式启用。已核实桌面应用版本为 26.930.61225（内嵌 runtime 0.160.0），
  独立 CLI 二进制为 0.159.3；两种执行形态不可混称。当前 Codex 会话 JSONL 格式不稳定。
  本项不假定可观察显式等待、全部工具活动或所有错误。
- 本轮明确跳过 Android 真机验收；设备上的 Compose 页面选择和 15 秒可见时长仍待后续录屏复验。JVM 测试验证 wire JSON、fake client、ViewModel 状态流及纯页面选择逻辑，不代表真机验收。

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
