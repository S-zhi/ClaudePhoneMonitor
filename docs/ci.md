# CI 与本地复现

`.github/workflows/ci.yml` 在每个 PR 和 `main` push 上运行。`Node checks` 与 `Android checks` 是稳定的合并检查；`Publish validated artifacts` 仅在 main push 的两个检查都成功后发布制品。CI 不需要 Claude、Codex 账户、API key、用户 Hook 或现有 Relay。

## 前置环境

- **Node.js 24.13.0**（见 `.node-version`）：使用该版本的内置 `node:sqlite`，无需另装 SQLite 或本机数据库服务。仓库根目录、protocol、collector、relay 各有提交的 `package-lock.json`；`npm run ci:install` 在四处执行 `npm ci`，不更新锁文件。
- **JDK 21**：用于运行 Gradle；Android Java/Kotlin 编译目标仍为 17。使用提交的 **Gradle 8.14.5 Wrapper**，无需全局 Gradle。`gradle/wrapper/gradle-wrapper.properties` 固定官方发行包 SHA-256；AGP 8.7.3 与 Kotlin 2.0.21 保持原版本。
- **Android SDK Platform 35、Build Tools 35.0.0**、command-line tools 与已接受的 SDK licenses：`compileSdk/targetSdk` 为 35，`buildToolsVersion` 明确固定为 35.0.0，避免 AGP 默认选择 34.0.0 并在 CI 自动下载另一版本。设置 `ANDROID_HOME` 为 SDK 根目录，将 `$ANDROID_HOME/cmdline-tools/latest/bin` 和 `$ANDROID_HOME/platform-tools` 加入 PATH，再执行 `sdkmanager --licenses` 和 `sdkmanager 'platforms;android-35' 'build-tools;35.0.0'`。如果同时设置 `ANDROID_SDK_ROOT`，必须与 `ANDROID_HOME` 相同；也可使用本机 `local.properties` 的 `sdk.dir`，该文件不应提交。
- **Python 3.12、PyYAML 6.0.3**：Python 测试及 YAML 校验使用；执行 `python3 -m pip install -r .github/requirements-ci.txt`。**Bash 3+** 用于辅助脚本，`check:shell` 验证最低版本；本地 macOS Bash 3.2 与 CI Ubuntu runner 的 Bash 5 均可使用。Bash 由操作系统提供，未锁定补丁版本。**actionlint 1.7.7** 用于 `check:workflows`，版本在工作流安装步骤中固定；本地也需安装 ShellCheck（本次验证为 0.11.0），供 actionlint 检查内嵌 shell。

SDK、JDK、上述运行时与网络下载能力是必需条件。npm/Gradle/pip cache 只是加速：空缓存应能完成同样检查。首次 Wrapper 运行会下载 Gradle；初次构建还需下载 Maven 依赖。不要把开发机已有的 `dist`、数据库或用户配置当作前置条件。

## 复现命令

从仓库根目录运行，先确认 `node --version` 为 `v24.13.0`、`java -version` 为 21，以及 `python3 --version` 为 3.12。macOS 的 JDK 21 示例是 `export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`；SDK 路径按实际安装位置设置。

```bash
npm run ci:install
python3 -m pip install -r .github/requirements-ci.txt
npm run lint
npm run typecheck
npm run check:shell
npm run check:workflows
npm run build
npm run test:unit
npm run test:integration
npm run test:helpers
npm run test:github
npm run test:ci
npm run test:live
./gradlew --no-daemon :apps:android:lintDebug :apps:android:testDebugUnitTest :apps:android:assembleDebug
```

`test:unit` 运行各包单元测试；`test:integration` 运行进程内协议、Codex 与 Usage 集成测试。`test:live` 重新构建并启动独立的 loopback Relay，使用临时 SQLite 数据库、临时 bootstrap secret 和动态端口，执行真实 HTTP/WebSocket 合约后清理子进程与临时目录；无需连接部署中的服务。Android JVM 测试与 APK 构建不等于真机 UI/扫码验收。

`CodexLiveWireTest` 只在提供 `CODEX_LIVE_WIRE_PATH` 时读取真实采集、已经脱敏的 Codex wire 录制：

```bash
CODEX_LIVE_WIRE_PATH=/absolute/path/to/redacted-recording.json ./gradlew --no-daemon :apps:android:testDebugUnitTest --rerun-tasks
```

未提供该环境变量时，允许该测试明确跳过。不能用 synthetic fixture 冒充真实录制，也不能把包含会话正文、命令、路径或 token 的原始文件上传为 CI artifact。

## 现有 Android lint 警告

Issue #16 开始时的既有 `lint-results-debug.txt` 报告为 **0 errors、15 warnings**：8 条 `GradleDependency`（Compose BOM、Activity、Core、Lifecycle 的新版本提示）；3 条 `ModifierParameter`（ClawdProceduralView 和 PixelPetCanvas 的默认 Modifier/参数顺序）；各 1 条 `DiscouragedApi`（固定横屏）、`InsecureBaseConfiguration`（debug 允许明文 LAN）、`DataExtractionRules`（Android 12+ 备份规则）、`MissingApplicationIcon`（应用图标）。这些是已有告警，CI 接入不自动升级依赖或添加 suppression。明文网络仅适合可信 LAN，备份规则与图标应作为产品发布前的独立修复。本次本地运行在显式固定 Build Tools 35.0.0 后实际得到 **0 errors、11 warnings**：4 条 GradleDependency、上述 3 条 ModifierParameter 与 4 条单项警告；此前未固定 Build Tools 的运行得到 7 条。依赖更新提示受远端版本元数据与缓存影响，不能把数量减少理解为依赖已升级。每次运行以实际生成的 lint 报告为准。

## 合并与制品

仓库管理员需在 GitHub **Settings → Branches → main branch protection**（或 Rulesets）启用 required status checks，并选择首次 CI 运行生成的 **Node checks** 和 **Android checks**；YAML 本身不会打开分支保护。保留这两个 job 显示名称以避免 required check 名称漂移；发布 job 不作为 PR 必需检查，因为它只在 main 上运行。

每次运行的 Node 日志、`reports/relay-smoke` 结果和 Android 日志、lint/测试报告保存为 `node-diagnostics-<github.sha>`、`android-diagnostics-<github.sha>`，保留 14 天。main 上验证的 backend/APK 先临时保存 1 天，全部检查成功后才发布 `backend-<github.sha>` 和 `apk-<github.sha>`，保留 14 天；名称中的 SHA 是该运行的 GitHub source SHA，可从 Actions run 核对，PR 运行可能使用合并测试 SHA。下载前确认两个检查与发布 job 均成功。APK 位于 `apps/android/build/outputs/apk/debug/android-debug.apk`，是 debug 构建，不是签名发布版。

backend 压缩包含构建后的 protocol、collector、relay、对应锁文件、`.node-version`、`SOURCE_COMMIT` 与运行 README，不含 node_modules、用户配置或 secret。解压后按包内 README 在各包执行 `npm ci --omit=dev`，设置 `RELAY_AUTH_MODE=paired`、`RELAY_HOST`、`RELAY_DB_PATH`、`RELAY_BOOTSTRAP_SECRET` 和可达的 `RELAY_PUBLIC_URL`，用 `npm --prefix services/relay start` 启动 Relay；Collector 使用 `npm --prefix services/collector start`。保留 bootstrap secret 供配对使用。LAN 一键启动和 Hook 安装脚本在源码 checkout 中，完整步骤见 [真实 LAN 部署](real-lan-deployment.md) 与根 [README](../README.md)。
