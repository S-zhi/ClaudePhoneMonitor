# Issue #8：实机验证记录（2026-10-07）

本轮已恢复旧 4×4 双手、更换独立完整球并完成连续 8 秒 Usage 动作。在同一 **HUAWEI DBR-W00、Android 12 / API 31、2560×1600 横屏、400 dpi** 实机上，最终 **19 项全部通过，耗时 92.068 秒**，完整循环的受控帧 QA 通过。下方保留上一轮 18 项与旧 APK 的历史记录。

## 本轮命令与结果

```sh
adb -s USFBB23A23203071 shell am instrument -w -r \
  -e class com.example.claudephonemonitor.ui.ClawdKeyPoseDeviceTest,com.example.claudephonemonitor.ui.MonitorReferenceTest,com.example.claudephonemonitor.ui.ReminderTimingDeviceTest \
  com.example.claudephonemonitor.test/androidx.test.runner.AndroidJUnitRunner \
  > reports/issue8-device-v2/instrumentation.txt 2>&1
```

`ClawdKeyPoseDeviceTest` 5 项、`MonitorReferenceTest` 12 项、`ReminderTimingDeviceTest` 2 项，共 19/19 通过。最终 APK 为 11,757,628 bytes，SHA-256：`a84e9109d567afd1c500945463d441b83a46177b2086548be8c49e726b73dee9`；设备主应用与测试 APK 的哈希分别与最终本地产物一致。

最终正常启动 MainActivity 后，已成功点击进入 Usage，Relay connected。现场截图保存在 `reports/issue8-device-v2/app-working.png` 与 `app-usage.png`，验收结束时平板停留在 Usage 页。

## 本轮受控采样证据

[日志](../reports/issue8-device-v2/instrumentation.txt) 的结果为 `OK (19 tests)` / `Time: 92.068`。251 张实际 Android Compose PNG 位于 `reports/issue8-device-v2/issue8-screenshots/usage-cycle/`；[capture-metadata.json](../reports/issue8-device-v2/issue8-screenshots/usage-cycle/capture-metadata.json) 与 [samples.csv](../reports/issue8-device-v2/issue8-screenshots/usage-cycle/samples.csv) 记录首帧观察相位 0、每步 32 ms、总采样 8,000 ms，frame-250 的观察相位回到 0。

[8 秒实机受控采样预览](../reports/issue8-device-v2/usage-device-cycle.mp4) 由前 250 张上述实机 PNG 按 31.25 fps 合成；第 251 张用于循环首尾检查。它是受控测试时钟下的实际 Compose 渲染帧，**不是墙钟录屏**。设备仍缺少 `screenrecord`，没有本轮墙钟录屏。

最终 [设备接触表](../reports/issue8-device-v2/device-contact-sheet.png) 与逐帧 QA 确认：frame-000 / frame-250 的 RGBA 完全相同；251 帧中角色可见宽度最小 283 px，转向保持完整姿态。在 3,392 / 3,424 ms，角色底边与球顶边间隔为 64～65 px，采样帧没有穿球或裁切。WORKING 电脑的 111,727 个灰色像素坐标固定，旧右侧橙块区域为 0，旧双手可见。

这些测试使用 fixture / 测试客户端；正常应用启动、Relay connected 和 Usage 点击另行现场确认，仍不代表真实后端任务的完整端到端验证。所有 `reports/` 截图、CSV 与视频仅留本地，没有作为源素材提交。

## 上一轮历史摘要


在 **HUAWEI DBR-W00、Android 12 / API 31、2560×1600 横屏、400 dpi** 实机上完成修复后的第二轮 instrumentation：**18 项全部通过**，耗时 **38.104 秒**。首轮截图 QA 发现 WORKING 左手独立缩放的一像素接缝，现已让双手及电脑前景与 BASE 共用主体范围透明画布，最终实机截图检查通过。

## 上一轮命令与结果

在仓库根目录执行：

```sh
adb -s USFBB23A23203071 shell am instrument -w -r \
  -e class com.example.claudephonemonitor.ui.ClawdKeyPoseDeviceTest,com.example.claudephonemonitor.ui.MonitorReferenceTest,com.example.claudephonemonitor.ui.ReminderTimingDeviceTest \
  com.example.claudephonemonitor.test/androidx.test.runner.AndroidJUnitRunner \
  > reports/issue8-device/instrumentation.txt 2>&1
```

| 测试类 | 通过数 | 检查范围 |
|---|---:|---|
| `ClawdKeyPoseDeviceTest` | 4 | 状态 PNG 渲染、双手动画与电脑固定、Usage 提醒选择、生命周期暂停及离线/静默/离页停钟 |
| `MonitorReferenceTest` | 12 | 会话列表与计数、短横屏/大字号、完成名称、强弱提醒与页面选择 |
| `ReminderTimingDeviceTest` | 2 | fixture wire 事件驱动生产 ViewModel，以 Android 实际时钟检查 5 秒/15 秒提醒及页面恢复 |

上一轮日志结尾为 `OK (18 tests)`，总耗时 `38.104` 秒。上一轮生产 APK 为 11,750,231 bytes，SHA-256：`4d2bb523f18b6d46494ac0a83156f0fc1371e441285824053be8707aa98c5312`；设备已安装 APK 的哈希与本地产物一致。生产 APK 的构建与素材检查见 [动作与素材方案](issue-8-pet-actions.md)。

## 上一轮本地证据与范围

上一轮日志为 [instrumentation.txt](../reports/issue8-device/instrumentation.txt)；10 张 instrumentation 导出的实机 PNG 位于 [issue8-screenshots](../reports/issue8-device/issue8-screenshots)，包含六种状态、两张打字采样，以及弱提醒前后的两张 Usage 采样。首轮 18/18、38.049 秒的日志与旧截图保留在 `reports/issue8-device/initial/`。这些 `reports/` 证据仅保存在本地，未作为仓库内素材提交。

上一轮 PNG 检查确认两张 WORKING 采样的单像素接缝计数均为 0；修复前的 50 个黑缝像素在新首帧恢复为角色橙色。电脑的 111,727 个灰色像素没有丢失或新增，帧间 930 个变化像素只位于手部。

正常应用中已实见原配对保留、Relay connected，首轮 Usage 入口点击成功并取回 `reports/issue8-device/live-usage-1.png` 至 `live-usage-3.png`。上一轮 APK 覆盖安装后正常启动 MainActivity，执行 HOME 退后台再回前台，[app-resumed.png](../reports/issue8-device/app-resumed.png) 确认状态页可见、Relay connected、原配对保持。

这些 instrumentation 在实机执行生产 Compose 渲染器和 ViewModel，但测试输入为 fixture / 测试客户端，不能解释为真实后端任务的完整端到端验证。模型采样图与上述实机 PNG 分开保存。设备缺少 `screenrecord` 命令，上一轮没有视频或录屏；APK 与素材追溯见 [Issue #8 动作与素材方案](issue-8-pet-actions.md)。
