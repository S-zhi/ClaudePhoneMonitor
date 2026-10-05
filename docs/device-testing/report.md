# Android 真机运行测试（已完成本轮；FINISH 未通过）

设备：AMP-AN00（Android 16 / API 36），物理显示 1224×2700，密度 520dpi。使用 USB 调试；未卸载应用、未清空配对数据。

## 已验证：真机而非模拟器

- 旧版本 0.1 曾安装；在用户确认系统安装提示后通过 `adb install -r` 无损升级 0.2.0，再升级 0.2.1（versionCode 3）。
- `.MainActivity` 冷启动成功，约 480–509ms；多次 Home → 前台恢复，未观察到应用 FATAL EXCEPTION。
- [Clawd 0.2.1 实际连接截图](clawd-v0.2.1-live-connected.png)：真机已展示来自新分支的 Clawd 帧而不是此前的自绘角色；横屏、隐藏系统栏、前台 KEEP_SCREEN_ON 生效。旧版对照截图仅保留在本地，未纳入 PR。
- 0.2.0 出现 `GET /`（手机端保留的旧 WS 基址缺少 `/ws/android`），Relay 原始 socket 遇 `read ECONNRESET` 退出。端点迁移已在 0.2.1 真机验证；Relay 新增针对异常升级后 `EPIPE` 的回归测试并通过，但先前的读侧 `ECONNRESET` 未在测试中单独复现。0.2.1 沿用原配对凭据，无需重扫；Relay/Collector/Android 各 1 个活跃连接。
- 手机和 Mac 位于同一私有网段。此前手机 VPN 把 LAN 发往 `tun0`，HTTP 返回空；用户手动断开 VPN 后，路由为 `wlan0`，手机直连 `/healthz` 得到 200，App 进入 `RELAY CONNECTED`。
- 以不含提示词/文件内容的本地 Hook 测试事件观察 [WORKING](clawd-v0.2.1-live-connected.png)、[WAITING](clawd-v0.2.1-waiting.png)、[FINISH](timing-finish-1.png)、[ERROR](clawd-v0.2.1-error-confirmed.png)，均为真机截图。
- ERROR 测量：`StopFailure` 事件后第 1.79–10.12 秒能检测到 ERROR 大字，第 11.33 秒消失；与约 10 秒要求相符。截图见 [ERROR 真机画面](clawd-v0.2.1-error-confirmed.png)。
- 当前配对使用的是覆盖升级前保存的 Android 令牌；0.2.1 把旧的 WebSocket 基址归一化到 `/ws/android` 后，无需清除数据或重新扫码即可连接。

## 当前待修：FINISH 提示过早消失

同一真机上的 `Stop` 测试事件：Relay 于 05:54:24.041Z 记录 task_finished（序号 701）；有一条正常的 tool_finished 在 05:54:24.895Z（序号 702），下一个工具事件直到约 05:54:32。自动截图观测：

- 发出后的 0.59 秒尚未见大字；
- 1.58 秒出现完整 `FINISH`（[截图](timing-finish-1.png)）；
- 2.59 秒大字消失（[截图](timing-finish-2.png)），未达到要求的 5 秒。

第二次独立复现同样是发出后 1.58 秒显示 FINISH、2.59 秒不再显示。该结果不是“已完成 5 秒”。先前纯 reducer 单元测试未捕捉到真机 UI 时序；需要针对实际事件解析、ViewModel 和 Compose 展示联动补回归测试。用户明确选择本轮只报告结果，因此**未修改 Android 代码或重新打包**来处理这一缺陷。

## 尚未完成的场景

- FINISH 显示时长的缺陷定位和修复（未授权修改，保持待办）；
- Relay 暂断/恢复与手动重连的真机验证（本轮未执行，以免再扰动用户的运行环境）；
- 新设备扫码 claim + Keystore 保存（本次特意保留用户现有配对，没有重置手机数据）。

## 安全边界

所有本地注入的测试 Hook 事件仅携带事件类型与固定的测试会话 ID，不含用户提示词、工具结果或令牌。设备截图只供测试查看，不作为网络明文安全性的证明。当前 Debug APK 的 `ws://` 仅适用于可信局域网；VPN 的局域网绕行属于用户手动选择，本助手没有修改 VPN 设置。
