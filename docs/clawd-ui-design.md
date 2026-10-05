# Clawd Android 展示整合设计

## 两套实现的分工

- **形象与动作来源**：`update_clawd_assets@1054ce5` 的 Clawd 24×22 采样帧与本地资源，不再调用旧 `PixelPetCanvas`。
- **运行逻辑来源**：主工作区已经修复的 QR claim、Keystore、真实 WebSocket、六状态、FINISH/ERROR 时间。
- 不直接合并 incoming 的 MonitorViewModel：它含 Mock 默认数据源与全 10 秒倒计时，会回退真实部署功能。
- 帧数据由用户提供的分支标注为 Clawd 采样；本次不下载新素材，不把代码中的描述当作商业分发授权。

## 视觉目标

横屏沉浸式状态屏，不是诊断后台。

- 暖炭黑舞台、terracotta Clawd、米白文字。
- 常态：宠物居中，尽量占满可用高度；仅保留很轻的连接标识。
- 状态变更：左侧单行巨型状态文字，右侧宠物；提示退场后宠物回到中央。
- 成功 **FINISH 5 秒**，错误 **ERROR 10 秒**；不显示秒数/倒计时卡片，不缩写成 DONE/ERR。
- 点击才显示连接详情、重新连接、重新配对及隐藏控制。配对重置应确认，不能误触后丢失 token。
- 配对页复用同一 Clawd 与色彩，中文说明、扫码按钮、处理中/错误提示。

## 动作

| 状态 | 动作 |
|---|---|
| IDLE | 静坐、呼吸、周期眨眼 |
| WORKING | CRAB 帧序列 |
| WAITING | POINT 帧序列 |
| FINISH | DANCE/JUMP 庆祝 |
| ERROR | 同一 Clawd 的警示动作 |
| OFFLINE | 降低对比的 STILL |

不重绘脸型，不因状态变化换成另一种生物。像素按整数尺寸绘制，禁止网格缝和模糊插值。

## 状态与兼容性

- 真实状态与展示提示分离；后续 snapshot 只能更新底层状态，不能取消/重复启动结果动画。
- overlay 结束恢复最新状态；offline 优先。
- 不恢复 Mock/Demo。
- 同包名与 debug 签名，覆盖安装应保留现有配对数据。
- 保留 KeyGenParameterSpec 和 Debug LAN 网络安全配置，不要求为了换皮肤重新扫码。

## 验收

- 帧矩阵、状态转换与时长 JVM 测试。
- Gradle build/lint。
- 对原生 APK 的配对页、工作态与结果态进行截图检视；不以网页仿真代替原生验收。
- APK 输出、版本、签名与哈希校验。
