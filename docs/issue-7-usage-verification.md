# Issue #7 Usage 验证记录

本轮由 Astra 负责方案决策和最终代码审阅，Sol6.1 负责 Android 与启动器/采集器的实际代码实现。Android 布局依据 Issue 原图：暖黑背景、无卡片容器、左侧灰色额度刻度仪表、右侧四项指标、分隔线下的全宽 Clawd 踢球场景。

## 修复内容

原启动器默认没有启动 Usage 采集，因此手机只能收到不含 usage 的状态快照。启动器现在支持首次配置并持久保存 Usage 选择，显式 `--watch-usage` 可开启采集。另一根因是 JSONL 单行 64 KiB 上限太低，无关长正文被当作超限记录，导致来源覆盖永久 partial。上限现在改为 4 MiB，并调整读取预算，使范围内的长行能完整 JSON.parse 后判断类型；超过 4 MiB 的记录仍保守标记 partial，既有 epoch 的真实累计缺项继续保留。首次启用跳过历史原本已有，本轮继续保持该统计口径。

Android 将采集空态、额度缺源、来源缺项和连接新鲜度分别显示。没有 usage 时提供 Mac 启用命令；启用但没有新响应时显示等待提示。部分数据继续显示已确认下界，命中率只在完整覆盖且总输入为正数时计算。Relay 断开、Mac 采集端离线和 Mac 状态过期均保留最后快照并明确提示。

新版真机断连测试另发现既有 WebSocket 客户端只处理 `onClosed` / `onFailure`，收到 Relay 的优雅关闭帧后没有回复握手，页面仍显示已连接。最小修复在 `onClosing` 立即发布一次断连并清除当前 socket/generation，再回复合法的 `1000` 关闭帧；迟到回调不能影响新连接或游标。保留现有手动 Reconnect，不增加自动重连，也不修改主页、ViewModel 或命名逻辑。

## 使用方式

在 Mac 项目目录运行：

```sh
./scripts/start-lan-monitor.sh --watch-usage
```

也可双击 `Start Claude Phone Monitor.command`，首次选择启用 Usage。已有启动器正在运行时，先停止再运行上述命令；显式开启会保存选择。首次启用之前不回填历史，启用后需要 Claude 或 Codex 产生新的模型响应。手机上点按舞台显示控制栏，再点击 Usage；Usage 顶栏和系统返回键都可返回状态页，15 秒状态提示逻辑继续保留。

额度没有可信来源时，启动时与当前均显示不可用；实际消耗为新增输入加输出，缓存读取单独列示。总请求数指已观测模型响应，内部重试不可见。

## 基线纠正与验证时间链

最初的本地构建及测试基于旧提交 `89620c9`，只证明当时旧版本中的 Usage 修改可以编译，不能证明已合并主页面功能保留。2026-10-07 13:58（UTC+8）尚无连接设备；临时 Paparazzi 截图尝试未产出可验收画面，该尝试从未修改生产 Gradle 依赖。

随后 USB 测试曾安装上述旧基线构建并切换到旧服务，造成多 Session 主页面和原生任务名回档。这次安装属于失败的整体验证，不能以 Usage 页面可读替代功能回归验收。发现后已恢复设备原 APK，并恢复正确服务版本；恢复所用原 APK 与现场数据只保存在私有临时目录，不提交私人任务名称。

本轮现已将 Usage 修改移植到最新已合并主线 `6a5d455`，包含 PR #15 主页面与 PR #18 CI。`MonitorApp.kt`、`PixelTypography.kt`、`MonitorViewModel.kt`、`SessionPresentation.kt` 与 `Clawd*.kt` 与该基线逐字一致。移植后的初次真机测试发现上述优雅关闭问题，修复后重新构建、安装并完成下述设备复测。

## 最新主线本地验证

本节仅登记 `6a5d455` 移植后重新执行的结果，早期旧测试数字不作为本轮有效结果。完整 Node 检查使用固定 Node.js 24.13.0；Android 使用 JDK 21、Gradle Wrapper 8.14.5 和 Android SDK 35。Node 日志为 `/private/tmp/issue7-latest-node-checks.log`；移植阶段 Android 日志为 `/private/tmp/issue7-latest-android-checks.log`，关闭生命周期修复后最终日志为 `/private/tmp/issue7-websocket-android-checks.log`。

- `npm run lint`、`typecheck`、`build`、完整 `npm test` 与 `check:shell` 成功。分类测试共 156 个 Node 测试通过，0 失败、0 跳过；28 个 Python 测试和 shell fixture 通过；隔离临时 Relay 的 live smoke 通过，没有连接用户运行中的服务。
- `check:workflows` 初次因 PATH 未包含 actionlint 停止；指定已有 actionlint 1.7.7 后重新通过，独立日志为 `/private/tmp/issue7-latest-workflows.log`。
- 移植阶段 Android 87 个 JVM 用例中 86 个通过、1 个可选 live fixture 跳过。新增关闭回归测试先在未修复代码上复现 2 项失败；修复后最终 `lintDebug`、`testDebugUnitTest`、`assembleDebug` 成功，90 个 JVM 用例中 89 个通过、1 个可选 `CodexLiveWireTest` 因未提供实时 fixture 跳过。lint 0 error、18 warning；WebSocket 生命周期 5 个、原生任务名 wire 7 个、多 Session 展示 4 个、完成归属/提示 11 个与 Usage 展示 5 个测试全部通过。
- 7 个受保护的主页面、状态与 Clawd 源文件均与 `origin/main`（`6a5d455`）字节相同。最终 APK 为 `apps/android/build/outputs/apk/debug/android-debug.apk`，SHA-256 `dbbfd358faef750f64b3702310e11e13a3674a235c5fef10aecc0d9963cb0a7c`，主代理已安装并核对设备 APK hash。

主代理另独立核验包含原生任务名、Codex 生命周期与 Relay 在内的 12 个受保护源文件，均与主线字节相同。Issue #17 提醒分级与 #19 隐藏子代理仍为开放事项，本轮保持主线已有的 15 秒提示与统一 RUNNING 行为，未将这些未实现需求算作恢复成果。

## USB 验证与证据范围（2026-10-07）

主代理在 DBR-W00 上完成最终新版复测：[真实已连接画面](device-testing/screenshots/issue-7-2026-10-07/fixed-final-usage.png) 与 [Relay 停止后的离线画面](device-testing/screenshots/issue-7-2026-10-07/fixed-relay-disconnected.png) 只含 Usage 汇总。停止 Relay 后首张截图（约 3 秒）已显示“Relay 离线 · 上次快照，未实时更新”，原数值保留；恢复服务后仍保持离线，点现有 Reconnect 后重新连接。顶栏返回、系统返回、滚动到底、玩球多帧和 force-stop 后重启沿用配对均通过，未发现 app crash。

installation、Usage epoch、首次启用时间与配对环境保持一致；自然响应计数从基线 1448 增至重启前 1697，再至最终 1712，未注入 fixture 或重置账本。主页面布局与原生名称恢复，可见通用 Codex 名称为 0。自然完成通知已看到，15 秒显示时长未完整计时；本轮不宣称该时长已经真机计时验收。详情见[设备记录](device-testing/issue-7-2026-10-07.md)。

连接设备是 **DBR-W00 平板、API 31、2560×1600 横屏、density 400**。既有[真实已连接 Usage 画面](device-testing/screenshots/issue-7-2026-10-07/usage-connected.png) 记录的是旧基线安装阶段，只能作为当时 Usage 圆盘、四项指标、连接标签、返回按钮与玩球场景的局部展示证据，不能用于宣称主页面无回档或最新构建真机通过。

旧画面的 Usage 来自真实 Codex 自然记录；首次起点 `2026-10-07T00:58:02.422Z` 与旧 epoch 保留，已观测响应从 366 补读至 1292，再至画面中的 1314，旧 partial 状态继续保留。这段历史数据连续性不能替代版本与回归验收；最终结论仅依据上述最新构建和复测。
