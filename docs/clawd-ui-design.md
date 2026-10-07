# Clawd Android 展示整合设计

本文记录最初的界面整合设计；后续状态提醒时长与页面路由以 [Issue #17 提醒分级](issue-17-reminder-policy.md) 为准。

## 两套实现的分工

- **形象与动作来源**：`update_clawd_assets@1054ce5` 的 Clawd 24×22 采样帧与本地资源，不再调用旧 `PixelPetCanvas`。
- **运行逻辑来源**：主工作区已经修复的 QR claim、Keystore、真实 WebSocket、六状态与独立 15 秒状态变化提示。
- 不直接合并 incoming 的 MonitorViewModel：它含 Mock 默认数据源与全 10 秒倒计时，会回退真实部署功能。
- 帧数据由用户提供的分支标注为 Clawd 采样；本次不下载新素材，不把代码中的描述当作商业分发授权。

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

工作参考为 issue #4 的 512×512 静态 PNG，包含暗炭黑背景、橙色像素 Clawd 与灰色笔记本电脑。TYPING 帧保留同一矩形头部与侧臂，使用闭眼 ^ 表情且没有笑嘴；坐姿左脚可见，灰色笔记本在右下方前景，双手分别位于键盘旁与屏幕后并反向移动一格。笔记本面板和身体保持固定，沿用 320 ms 的两帧打字原语；静态构图不代表已获取 GIF 动帧或其真实节奏。

| 状态 | 动作 |
|---|---|
| IDLE | 静坐、呼吸、周期眨眼 |
| WORKING | Clawd 坐在灰色笔记本电脑后打字，双手交替活动；不奔跑、不横移 |
| WAITING | POINT 帧序列 |
| FINISH | DANCE/JUMP 庆祝 |
| ERROR | 同一 Clawd 的警示动作 |
| OFFLINE | 降低对比的 STILL |

不重绘脸型，不因状态变化换成另一种生物。像素按整数尺寸绘制，禁止网格缝和模糊插值。

## 状态与兼容性

- 真实状态与展示提示分离；完成结果的收尾工具事件与同结果 snapshot 只更新底层状态，不提前取消或重启 FINISH 提示。
- 提示截止后恢复最新状态；新的有效状态或结果可以立即接替当前提示。
- 不恢复 Mock/Demo。
- 同包名与 debug 签名，覆盖安装应保留现有配对数据。
- 保留 KeyGenParameterSpec 和 Debug LAN 网络安全配置，不要求为了换皮肤重新扫码。

## 验收

- 帧矩阵、状态转换与时长 JVM 测试。
- Gradle build/lint。
- JVM 回归覆盖真实 wire JSON、fake client、ViewModel StateFlow 与 15 秒页面选择链路。该检查不代表 Compose 真机实测。
- debug manifest 将 Compose 的测试宿主 ComponentActivity 固定为横屏并处理方向变化，避免首次测试在 setContent 后异步重建 Activity；正式 MainActivity 的配置不受影响。
- `MonitorReferenceTest` 在原生 Compose instrumentation 中调用同一个 internal MonitorScreen，无真实 client，也不增加产品 Demo。测试样例包含五行中英文长标题、四种行状态与 Top 5 外仍运行的第六个会话；验证完整标题可访问、全部计数、完成对应行与仍在 Working 的宠物语义。
- 测试截图写入设备 external files 的 `issue4-screenshots` 目录：`status.png`、`state-change.png`、`status-short.png`、`status-large-font.png`。最后两个检查 720×320 dp 短横屏与 2 倍系统字体。只有实际运行 connectedDebugAndroidTest 成功后，才可作为本版本现场验证证据；截图测试本身不证明真实 Relay 的 15 秒计时。
- APK 输出、版本、签名与哈希校验。
