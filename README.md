# Claude Phone Monitor

一个面向 Claude Code 的 Android 像素宠物监控 MVP：macOS 上的 Claude Code Hook 将脱敏生命周期事件交给本地采集器，采集器通过 WebSocket 发送到 Relay，Android 客户端显示状态和像素宠物动画。

## 当前实现

- `packages/protocol/`：canonical v1 事件/消息类型、隐私校验、状态 reducer、sequence/resume 辅助。
- `services/collector/`：macOS 本地 Hook Adapter、Unix Socket、持久化 outbox、WebSocket 心跳/重连/challenge、launchd 模板。
- `services/relay/`：Fastify 健康检查、collector/Android WebSocket 网关、事件 ACK、快照、resume、probe/challenge、开发配对和脱敏。
- `apps/android/`：Kotlin + Jetpack Compose 横屏沉浸式像素宠物 Demo，支持 mock 事件和 Relay snapshot/event 边界。
- `skills/claude-monitor/`：安装/配对/诊断/状态/卸载 Skill 和 Hook 配置脚本。
- `tests/`：不依赖网络、数据库或 Claude 凭据的端到端协议 smoke harness。

## 快速验证

需要 Node.js 20+。在仓库根目录运行：

```bash
npm install --prefix packages/protocol
npm install --prefix services/collector
npm install --prefix services/relay
npm test
```

单独运行：

```bash
npm run typecheck
npm run mvp:harness
npm --prefix packages/protocol test
npm --prefix services/collector test
npm --prefix services/relay test
bash skills/claude-monitor/tests/test_scripts.sh
```

当前测试不需要 `ANTHROPIC_API_KEY`、OAuth 登录、远程数据库或真实 Claude 任务。

## 启动 Relay

```bash
npm run relay:dev
```

默认健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

Relay 当前使用内存存储作为第一版开发实现；接口和 repository 边界已经为 SQLite/生产持久化预留。生产部署前需要增加 HTTPS/WSS、持久化数据库和真实令牌鉴权配置。

## 本地 Collector

Collector 的 CLI、Hook Adapter 和安装说明位于 [services/collector](services/collector/README.md)（若使用本地安装脚本，先阅读 Skill 文档）。Skill 入口位于 [skills/claude-monitor/SKILL.md](skills/claude-monitor/SKILL.md)。

Hook 采用 fail-open 设计：本地采集器或远程 Relay 不可用时，Hook 不会阻塞 Claude Code，也不会将原始 prompt、工具参数、工具结果、stdout/stderr、绝对路径或令牌发送出去。

## Android

Android 模块位于 [apps/android](apps/android)。它需要 Java 17、Android SDK、Gradle/Gradle Wrapper 和 `adb`。当前开发机器未安装这些工具，因此这里只能完成源代码和资源静态检查，尚未在本机生成 APK。

应用默认：

- 仅横屏；
- 隐藏系统栏；
- Canvas 绘制原创像素宠物；
- `FINISH` overlay 5 秒；
- `ERROR` overlay 10 秒；
- 点击屏幕显示/隐藏控制面板；
- 支持 Demo 模式模拟状态变化。

## 隐私边界

协议层和 Relay 都使用白名单字段。允许的事件元数据包括事件类型、工具名称、耗时、退出码、错误类别、等待原因、会话/任务 ID 和序号。禁止转发和持久化 prompt、工具输入/输出、命令、路径、stdout/stderr、密钥及授权头。

真实 Claude Code Hook 接入前，应针对实际 Claude Code 版本保存经过脱敏的 payload fixture；`tests/fixtures/` 中的内容是合成测试数据，不代表真实 Hook 字段。

## 目录

```text
apps/android/                  Android Compose client
packages/protocol/             shared TypeScript protocol
services/collector/            macOS collector and Hook Adapter
services/relay/                relay WebSocket service
skills/claude-monitor/         Skill and macOS setup scripts
tests/                         dependency-free integration harness
docs/                          local operator notes
```

## 当前限制

- Android 构建尚未在当前机器验证，因为缺少 Java/Android SDK/Gradle。
- Relay 默认是内存存储，仅适合本地 MVP；还未提供生产 VPS Docker 镜像和 TLS 配置。
- Android 的正式 QR 扫描、Keystore、FCM 后台通知和真实 token 配对仍是下一步工作。
- 真实 Claude Code Hook 的字段需要在目标版本上进行 fixture 验证；未知字段会被忽略。
