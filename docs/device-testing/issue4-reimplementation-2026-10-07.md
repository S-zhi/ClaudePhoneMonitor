# issue #4 多 Session 重新实现 — 2026-10-07

状态页按最近有效活动展示 Top 5 会话及标题、状态；Running 统计全部活跃会话，任一 Working 优先，否则使用最活跃会话的状态。Codex 原生任务名依次取自 canonical `threads.name`、`session_index.jsonl` 的 `thread_name`、旧版安全 `threads.title`，安全名称不可用时才用哈希后缀。`session_title_updated` 只更新标题和序号，不改变任务状态、TTL 或活动排序；完成提示按原 Session、turn 和序号匹配，标题在完成后 6～14 秒才到时可补名，但不延长原 15 秒截止。重复、旧任务或无身份结束不会触发可归属的完成提示；不转发 prompt、命令、路径或正文。主分支 `89620c9` 的配对令牌验证与复用修复已保留。

最终 `npm test` 通过：Node 145 项、Python 12 项（9 + 3），0 失败；三包 typecheck、Android JVM 82 项（81 通过、可选真实 wire 测试 1 项跳过）、Debug APK 构建与 lint 通过。原生 Compose 真机 fixture 四项通过，覆盖五行标题与全量计数、匹配完成名称且继续 Working 动画、短横屏、2 倍字号滚动可达性；使用安装 APK 后直接调用 AndroidJUnitRunner 的路径。归档 fixture 图验证生产 Compose 布局与呈现，native 名称与完成归属链路另由 memory + SQLite 端到端及 JVM 测试验证。

当前 Relay/Collector 已通过受管理启动入口构建并更新，Codex 监听由 0 启用为 1，Usage 原为 0 并保持不变，原安装身份与手机配对保留。真机确认 Relay 已连接，当前聊天真实原生任务名称已显示（按列表宽度省略），Relay 对应会话完整名称为「支持多 Session 列表、聚合宠物状态和完成任务名称展示」；无可用安全名称的其他会话仍允许匿名回退。含其他私人任务名的新截图仅保留本地，不提交公开仓库；下方连接图属于前轮旧 Relay 的历史连接记录。真实完成页的完整 15 秒可见时长尚未录屏，deadline、去重与迟到补名由 JVM 测试验证。提供的两张参考图 SHA-256 相同，第二张没有独立变化态内容，完成页沿用既有 15 秒规范。

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

Debug APK SHA-256：`681f2e7adb42197742d64b91e28e03eedb039ed93871763741e2672adfffc262`。

前轮 fixture 截图：[状态页](screenshots/issue4-reimplementation-2026-10-07/status.png)、[完成提示页](screenshots/issue4-reimplementation-2026-10-07/state-change.png)、[短横屏](screenshots/issue4-reimplementation-2026-10-07/status-short.png)、[大字号](screenshots/issue4-reimplementation-2026-10-07/status-large-font.png)；[历史 Relay 连接图](screenshots/issue4-reimplementation-2026-10-07/live-connected.png)。
