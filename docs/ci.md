# CI 与本地复现

`.github/workflows/ci.yml` 在每个 PR 以及 `main`、`dev/magpie` push 上运行。`Node checks` 与 `Android checks` 是稳定的合并检查；`Publish validated artifacts` 仅在 main push 的两个检查都成功后发布原有制品。当前 Magpie 只生成本地测试包：`dev/magpie` push 和以它为目标的 PR 执行无发行密钥的 Magpie lint、单元测试与 APK 构建，不暂存 Magpie 下载制品，也不创建 Release。

Magpie 开发规则见 [Magpie 开发约定](magpie-development.md)：相关提交直接进入 `dev/magpie`，Magpie 功能禁止合并回 `main`。`branch-policy.yml` 提供只读取 PR 元数据的 `Prevent dev/magpie to main` 检查，要求 `dev/magpie`、`dev/magpie-*`、`codex/magpie-*` 的 PR 目标必须为 `dev/magpie`。该工作流尚未部署到远端基线分支并设为 required status check 前，远端门禁不生效；YAML 不会自行创建 GitHub 保护规则。

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

Issue #16 开始时的既有报告为 **0 errors、15 warnings**：8 条 `GradleDependency`、3 条 `ModifierParameter`，以及 `DiscouragedApi`、`InsecureBaseConfiguration`、`DataExtractionRules`、`MissingApplicationIcon` 各 1 条。

合并最新 main 后使用 JDK 21、Gradle Wrapper 8.14.5 与 Build Tools 35.0.0 的最终本地校验通过：**82 个 JVM 测试，81 个通过、1 个真实 Codex 录制测试预期跳过；debug APK 已生成；lint 为 0 errors、14 warnings**。警告分类为 6 条 `GradleDependency`（依赖更新提示）、3 条 `ModifierParameter`（ClawdProceduralView/PixelPetCanvas 的默认 Modifier 与参数顺序）、2 条 `DiscouragedApi`（main/debug activity 固定横屏），以及明文 debug LAN 配置、Android 12+ 备份规则、应用图标各 1 条。依赖更新提示受远端版本元数据与缓存影响，数量可能变化；每次以实际报告为准。CI 接入没有升级依赖或添加 suppression。明文网络仅适合可信 LAN，备份规则与图标应作为发布前的独立修复。

## 合并与制品

仓库管理员需在 GitHub **Settings → Branches → main branch protection**（或 Rulesets）启用 required status checks，并选择首次 CI 运行生成的 **Node checks**、**Android checks** 和 **Prevent dev/magpie to main**；YAML 本身不会打开分支保护。保留这些 job 显示名称以避免 required check 名称漂移；发布 job 不作为 PR 必需检查，因为它只在 main 上运行。

每次运行的 Node 日志、`reports/relay-smoke` 结果和 Android 日志、lint/测试报告保存为 `node-diagnostics-<github.sha>`、`android-diagnostics-<github.sha>`，保留 14 天。main 上验证的 backend/APK 先临时保存 1 天，全部检查成功后才发布 `backend-<github.sha>` 和 `apk-<github.sha>`，保留 14 天；名称中的 SHA 是该运行的 GitHub source SHA，可从 Actions run 核对，PR 运行可能使用合并测试 SHA。下载前确认两个检查与发布 job 均成功。APK 位于 `apps/android/build/outputs/apk/debug/android-debug.apk`，是 debug 构建，不是签名发布版。

backend 压缩包含构建后的 protocol、collector、relay、对应锁文件、`.node-version`、`SOURCE_COMMIT` 与运行 README，不含 node_modules、用户配置或 secret。解压后按包内 README 在各包执行 `npm ci --omit=dev`，设置 `RELAY_AUTH_MODE=paired`、`RELAY_HOST`、`RELAY_DB_PATH`、`RELAY_BOOTSTRAP_SECRET` 和可达的 `RELAY_PUBLIC_URL`，用 `npm --prefix services/relay start` 启动 Relay；Collector 使用 `npm --prefix services/collector start`。保留 bootstrap secret 供配对使用。LAN 一键启动和 Hook 安装脚本在源码 checkout 中，完整步骤见 [真实 LAN 部署](real-lan-deployment.md) 与根 [README](../README.md)。

## Magpie 开发下载

当前仅本地构建测试包：`./gradlew --no-daemon :apps:android:lintMagpie :apps:android:testMagpieUnitTest :apps:android:assembleMagpie`，APK 在 `apps/android/build/outputs/apk/magpie/`；运行 `npm run build && npm run package:magpie` 可在 `artifacts/` 得到桌面后端包。APK 包名是 `com.example.claudephonemonitor.magpie`，可与日常应用并存。后端包是 macOS 启动材料，需要 Node 24.13+、Python 3 和 Magpie CLI；自动配对还调用 Swift CLI/CoreImage。它不是原生单文件程序，也不是 Magpie 插件。

远端分发流程目前关闭：只有仓库变量 `MAGPIE_PUBLISH_ENABLED` **明确设为 `true`**，且配置长期保存的私有开发签名密钥 `MAGPIE_KEYSTORE_BASE64`、`MAGPIE_KEYSTORE_PASSWORD`、`MAGPIE_KEY_ALIAS`、`MAGPIE_KEY_PASSWORD`，才会在 `dev/magpie` push 上构建签名包、暂存制品并发布 Magpie 预发布版。未设置变量或设为 `false` 不读取密钥、不暂存制品、不发布。将来开启后，可在仓库 [Releases 页面](https://github.com/S-zhi/ClaudePhoneMonitor/releases) 查找 `magpie-dev-` tag，下载 `magpie-monitor.apk`、`magpie-backend.tar.gz`、`SHA256SUMS` 和 `build-manifest.json`。发布 job 独有 `contents: write`；脚本仍复核显式开关、事件、分支、两项检查结果、包内 `SOURCE_COMMIT` 和已存在 Release 的来源及摘要。
