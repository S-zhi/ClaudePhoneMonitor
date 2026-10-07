# Clawd Android 展示整合设计

本文记录当前 Clawd 界面与 PNG 图层动画的整合设计；状态提醒时长与页面路由以 [Issue #17 提醒分级](issue-17-reminder-policy.md) 为准。

## 实现与素材来源

- **当前动画来源**：[Issue #8](issue-8-pet-actions.md) 的 7 张姿态 PNG、`assets/clawd/props/usage-soccer-ball.png` 独立完整球，以及旧 4×4 代码手样式。`ClawdKeyPose.kt` 拆分姿态、清除原手区域并重建双手、替换球；`ClawdMotion.kt` 计算动作，两个 Canvas 通过 `ClawdImageRenderer.kt` 绘制。PNG 原文件保持不变。
- **形象参考与历史实现**：`update_clawd_assets@1054ce5` 的 Clawd 静态参考与 24×22 采样矩阵保留可追溯来源和历史回归用途，主渲染现使用 PNG 图层；历史 GIF 文件名不能解释为已有 GIF 动帧。
- **运行逻辑来源**：主工作区已经修复的 QR claim、Keystore、真实 WebSocket、六状态与独立 15 秒状态变化提示。
- 不直接合并 incoming 的 MonitorViewModel：它含 Mock 默认数据源与全 10 秒倒计时，会回退真实部署功能。

## 视觉目标

横屏沉浸式状态屏，不是诊断后台。连接后常态展示**状态页**：左侧会话摘要，右侧 Clawd 与当前聚合状态动作。符合 Issue #17 强提醒条件的状态变化或任务结果进入**改变状态页** 15 秒，使用左侧大状态字、右侧大 Clawd 的整屏构图；deadline 到期后恢复最新状态页。弱提醒只在当前页面显示小提示。

- 暖炭黑舞台、terracotta Clawd、米白文字。
- 状态页按 issue #4 的参考图重排：约 44:56 的左右分区，左侧轻量列表垂直居中，右侧为大 Clawd；保留左上角 RELAY CONNECTED / CONNECTING。没有聚合状态大标题或中文副标题。
- 列表头显示 SESSIONS · 计数与 RUNNING · 计数，二位补零；运行数使用全部真实会话的统计，不从可见五行推算。最多五行按最近活动倒序显示，Top 1 左侧一根细竖条。每行先显示像素 Working / Waiting / Idle / Done，再显示普通字体的原始标题，中文与英文均保留。
- Working 使用 terracotta，Waiting 为暖黄，Idle 为浅灰，Done 为浅绿。Done 根据 sessionId 匹配本地 15 秒完成记录，不单凭列表位置或全局 FINISH 猜测。
- 行高根据横屏宽度与系统字体大小调整，默认短横屏可显示五行；大字号时列表滚动，表头可以自动换行。标题过长时省略，但无障碍语义保留完整名称与对应状态。
- 改变状态页：暂时隐藏会话列表，左侧显示完整像素状态大字和真实完成会话名称，右侧显示对应的 Clawd 动作；从 ViewModel 发布强提醒起保留 **15 秒**，到期后回到最新聚合状态。大字与行内状态使用同一套 5×7 像素字形，组件先测量自然尺寸，再按可用宽高等比缩放，避免 Canvas 缺省为零高或末字裁切。
- `stateChange` 是单调时钟 deadline 的 UI 提示，`petState` 始终表达 Relay 最新底层聚合状态。重复/旧序号、同序号快照、心跳、probe 与同状态工具事件不会重启提示；新状态或新结果会开始新提示，断连立即切到 OFFLINE。
- 多会话仍有任务运行时，单个任务的 `FINISH` 可以显示完成会话名称，但底层状态和宠物动作继续表达 `WORKING`。本地完成名称锁定到 15 秒截止时间，不受 Relay recent completion 短期清理影响。
- 点击才显示连接详情、重新连接、重新配对及隐藏控制。配对重置应确认，不能误触后丢失 token。
- 配对页复用同一 Clawd 与色彩，中文说明、扫码按钮、处理中/错误提示。

## 动作

工作构图保留 Issue #8 `working-typing-clean.png` 的矩形脸型、闭眼 ^ 表情和电脑位置。按用户要求，运行时清除原 PNG 的两处手部橙块、移除侧边橙块，恢复旧 4×4 深描边、橙掌心双手；按 320 ms 的旧代码序列敲击，完整循环 1,920 ms。身体保持固定，电脑前景最后绘制且位置固定。该替换由代码执行，源 PNG 与原生成 prompt 未修改，不宣称取得原始 GIF 动帧。

| 状态 | 动作 |
|---|---|
| IDLE | 原地轻呼吸，周期眨眼 |
| WORKING | 固定电脑前的旧 4×4 双手按旧序列敲击，身体与电脑固定 |
| WAITING | 指向手端小幅往返，其余身体固定 |
| FINISH | 双臂轻抬庆祝，保持同一身体与脚的位置 |
| ERROR | 暖红警示块以明暗脉冲提醒，角色原地静止 |
| OFFLINE | 灰蓝关键姿态静止，保持常规深色眼睛 |
| Usage | 角色和腿来自源姿态，球替换为独立完整球；连续走近、蓄脚、触球、滚球追逐及越球转向，不依赖任务状态或用量涨跌 |

保持 Clawd 脸型、身体与电脑位置，使用旧手样式及独立完整球。目标位置和尺寸取整，图层使用 `FilterQuality.None` 最近邻缩放；WORKING 不做整体呼吸或横移。

Usage 以 32 ms 采样运行 8 秒循环，每半程 4 秒：走近并蓄脚，1,200 ms 触球，球滚走后追逐，2,800 ms 开始越球并连续转向，4,000 ms 完成换向；后半程向另一侧重复。转向时姿态宽度保持 82%～100%，跳跃中的 3,280～3,520 ms 使用两组完整姿态短交叠渐变，球仍只绘制一层。球的滚动带旋转，身体、脚、球的位置与朝向按连续模型计算。本轮 19 项实机回归和完整循环受控帧检查已通过。

PNG 在 IO 线程加载，拆分后的图层位图按需要裁剪或保留主体范围的透明画布，由全局 6 MiB `LruCache` 复用；WORKING 中需要对齐 BASE 的图层保留相同 `subjectBounds`，统一最近邻缩放的采样网格。Canvas 绘制时不读取或解码素材。当前动作由 Compose 保留，`withInfiniteAnimationFrameNanos` 时钟在 `STARTED` 生命周期内采样，退到后台暂停、离开页面停止，换动作从零开始。OFFLINE 和静默姿态不创建动画循环。

## 状态与兼容性

- 真实状态与展示提示分离；完成结果的收尾工具事件与同结果 snapshot 只更新底层状态，不提前取消或重启 FINISH 提示。
- 提示截止后恢复最新状态；新的有效状态或结果可以立即接替当前提示。
- 不恢复 Mock/Demo。
- 同包名与 debug 签名，覆盖安装应保留现有配对数据。
- 保留 KeyGenParameterSpec 和 Debug LAN 网络安全配置，不要求为了换皮肤重新扫码。

## 验收

- PNG 图层拆分、动作函数、状态选择与时长 JVM 测试；历史帧矩阵测试保留回归用途。
- Gradle build/lint。
- JVM 回归覆盖真实 wire JSON、fake client、ViewModel StateFlow 与 15 秒页面选择链路。该检查不代表 Compose 真机实测。
- debug manifest 将 Compose 的测试宿主 ComponentActivity 固定为横屏并处理方向变化，避免首次测试在 setContent 后异步重建 Activity；正式 MainActivity 的配置不受影响。
- `MonitorReferenceTest` 在原生 Compose instrumentation 中调用同一个 internal MonitorScreen，无真实 client，也不增加产品 Demo。测试样例包含五行中英文长标题、四种行状态与 Top 5 外仍运行的第六个会话；验证完整标题可访问、全部计数、完成对应行与仍在 Working 的宠物语义。
- 测试截图写入设备 external files 的 `issue4-screenshots` 目录：`status.png`、`state-change.png`、`status-short.png`、`status-large-font.png`。最后两个检查 720×320 dp 短横屏与 2 倍系统字体。只有实际运行 connectedDebugAndroidTest 成功后，才可作为本版本现场验证证据；截图测试本身不证明真实 Relay 的 15 秒计时。
- APK 输出、版本、签名与哈希校验。

本轮已通过本机 `testDebugUnitTest`、`lintDebug`、`assembleDebug` 与 `compileDebugAndroidTestKotlin`：145 个 JVM 用例中 144 通过、1 个预期跳过，0 失败/错误；lint 为 0 errors、8 warnings。包内独立完整球与清理源图逐字节一致，当前产物见 [Issue #8 验证记录](issue-8-pet-actions.md)。HUAWEI DBR-W00 上 19 项实机回归全部通过，耗时 92.068 秒；251 个受控 Compose 采样帧的首尾 RGBA 完全相同，转向保持完整姿态，未在这些采样帧中发现穿球或裁切，WORKING 保留旧小手且电脑固定。正常应用已成功进入 Usage，Relay connected。

本轮视频是实际 Compose 帧合成的“实机受控采样预览”，不是墙钟录屏。日志、CSV、截图和视频见 [实机验证记录](issue-8-device-validation.md)。

上一轮已在 HUAWEI DBR-W00（Android 12 / API 31）完成 18 项实机 instrumentation，全部通过、耗时 38.104 秒，并检查 WORKING 手部/电脑、原配对与后台返回；这些属于旧手部与旧 Usage 动作版本的历史证据，保留在 [实机验证记录](issue-8-device-validation.md)。测试使用 fixture，不代表真实后端任务的完整端到端验证；设备缺少 `screenrecord`，没有录屏。模型采样图继续与实机 PNG 区分。
