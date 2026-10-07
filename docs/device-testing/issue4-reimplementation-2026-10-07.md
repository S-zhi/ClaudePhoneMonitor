# issue #4 多 Session 重新实现 — 2026-10-07

状态页按最近有效活动展示 Top 5 会话及标题、状态；Running 统计全部活跃会话，任一 Working 优先，否则使用最活跃会话的状态。完成提示按原 Session、任务和序号匹配，本地保留 15 秒；重复或旧任务尾事件不触发提示，也不改变活动排序。匿名会话与 Codex 使用安全哈希后缀，完成名与列表一致，不转发 prompt、命令、路径或正文。此次整合保留了主分支 `89620c9` 的 Collector 配对令牌验证和复用修复。提供的两张参考图下载后 SHA-256 相同，第二张没有独立变化态内容；完成页沿用既有 15 秒规范。

`npm test` 通过：Node 123 项、Python 12 项（9 + 3）；三包 typecheck、Android JVM 75 项（74 通过、可选真实 wire 测试 1 项跳过，0 失败）、Debug APK 构建与 lint 通过。原生 Compose 真机 fixture 四项通过，耗时 5.415 秒：五行标题与全量计数、匹配完成名称且继续 Working 动画、短横屏、2 倍字号滚动可达性。首次 `connectedDebugAndroidTest` 因 Gradle UTP 插件未缓存而失败，有效设备结果来自安装 APK 后直接调用 AndroidJUnitRunner。

设备 fixture 直接渲染生产 Compose 页面，验证布局与呈现；15 秒 deadline、结果去重、快照补全和恢复由 JVM 测试验证。真实连接截图复用手机原有配对，连接的是原有运行中的 Relay，仍使用旧的通用 Codex 名称；本次没有重新部署该后端，新版安全哈希名称与完成归属链路由 memory + SQLite 端到端测试验证。真实 Relay 事件在设备上的完整 15 秒可见时长尚未录屏。

复验命令：

```bash
npm test
npm run typecheck
gradle :apps:android:testDebugUnitTest :apps:android:assembleDebug :apps:android:lintDebug
gradle :apps:android:assembleDebugAndroidTest
adb install -r apps/android/build/outputs/apk/debug/android-debug.apk
adb install -r apps/android/build/outputs/apk/androidTest/debug/android-debug-androidTest.apk
adb shell am force-stop com.example.claudephonemonitor
adb shell am instrument -w -r -e class com.example.claudephonemonitor.ui.MonitorReferenceTest com.example.claudephonemonitor.test/androidx.test.runner.AndroidJUnitRunner
```

Debug APK SHA-256：`f6cc9cc946db98a6bd5cd4e605692452a86d85b24b1afd73ec705a4823da2356`。

截图：[状态页](screenshots/issue4-reimplementation-2026-10-07/status.png)、[完成提示页](screenshots/issue4-reimplementation-2026-10-07/state-change.png)、[短横屏](screenshots/issue4-reimplementation-2026-10-07/status-short.png)、[大字号](screenshots/issue4-reimplementation-2026-10-07/status-large-font.png)、[真实 Relay 连接](screenshots/issue4-reimplementation-2026-10-07/live-connected.png)。
