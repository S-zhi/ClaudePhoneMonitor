# Issue #8：宠物动作与素材追溯（本轮双手与球动作已通过实机回归）

用户确认的三个页面——**状态页 `STATUS`、改变状态页 `STATE_CHANGE`、Usage 页 `USAGE`**——共有 7 张关键姿态，已生成、完成用户明确授权的 Python 技术清理，并通过素材视觉审核，现已原样复制到 Android。当前运行时结合姿态图层、按用户要求恢复的旧代码双手，以及新增独立完整球；本轮已通过本地构建、19 项实机回归与最终受控帧检查。素材均为 **1024×1024 透明 RGBA PNG**，Alpha 仅 `0/255`，有效纯色 2～4 种，角色和道具完整入镜，四边安全留白至少 153 像素。

| action_id / 独立状态 | 适用页面 | 已验收交付图 |
|---|---|---|
| `idle-rest` / IDLE | STATUS、STATE_CHANGE | [idle-rest-clean.png](pet-assets/images/idle-rest-clean.png) |
| `working-typing` / WORKING | STATUS、STATE_CHANGE | [working-typing-clean.png](pet-assets/images/working-typing-clean.png) |
| `waiting-point` / WAITING | STATUS、STATE_CHANGE | [waiting-point-clean.png](pet-assets/images/waiting-point-clean.png) |
| `finish-cheer` / FINISH | STATUS、STATE_CHANGE | [finish-cheer-clean.png](pet-assets/images/finish-cheer-clean.png) |
| `error-alert` / ERROR | STATUS、STATE_CHANGE | [error-alert-clean.png](pet-assets/images/error-alert-clean.png) |
| `offline-rest` / OFFLINE | STATUS、STATE_CHANGE | [offline-rest-clean.png](pet-assets/images/offline-rest-clean.png) |
| `usage-ball` / PLAY_LOOP | 仅 USAGE | [usage-ball-clean.png](pet-assets/images/usage-ball-clean.png) |

[动画源素材预览页](pet-assets/preview.md) 直接显示这 7 张 PNG。每张交付图通过生成账本对应 v1 记录的 `processed_image_path` 关联，`processing.review_status` 均为 `accepted`；新增 `runtime_asset_path` 指向 [Android 动作素材目录](../apps/android/src/main/assets/clawd/actions)，各运行时副本与清理源图逐字节一致。OFFLINE 保持常规深色眼睛 `#1E1917`。新球见 [usage-soccer-ball-clean.png](pet-assets/images/usage-soccer-ball-clean.png)，运行时路径为 `assets/clawd/props/usage-soccer-ball.png`，追溯单独记录于 [generated-props.jsonl](pet-assets/generated-props.jsonl)。

## 现状与素材来源

`MonitorPage.kt` 保留上述三个页面及原有选择规则：状态页按 `uiState.petState` 展示宠物，改变状态页按 `resolveStateChangeAnimationState` 展示提示对应动作。`ClawdProceduralView.kt` 现使用 `resolveClawdAction` 选择 PNG，`UsagePlayground.kt` 使用独立的 `USAGE_BALL` 姿态。姿态图层与运行时替换由 [ClawdKeyPose.kt](../apps/android/src/main/java/com/example/claudephonemonitor/ui/ClawdKeyPose.kt) 实现：WORKING 原手区域清除后绘制旧 4×4 双手，Usage 原球替换为独立完整球；[ClawdMotion.kt](../apps/android/src/main/java/com/example/claudephonemonitor/ui/ClawdMotion.kt) 定义动作，[ClawdImageRenderer.kt](../apps/android/src/main/java/com/example/claudephonemonitor/ui/ClawdImageRenderer.kt) 加载与绘制；ERROR 当前已使用暖红警示块脉冲，主渲染不再复用 CRAB 矩阵。

形象参考使用仓库内 [Clawd-Still.png](../apps/android/src/main/assets/clawd/Clawd-Still.png)，其 Git 历史可追溯至 `update_clawd_assets` 分支的 `1054ce5`。原图为 2750×1850，角色位于下方边缘、留白很大；新提示词只取角色的矩形轮廓、四条短腿和 terracotta 色彩，要求重新完整居中，不复制原图留白与边缘裁切。动作参考来自 [ClawdSpriteData.kt](../apps/android/src/main/java/com/example/claudephonemonitor/ui/ClawdSpriteData.kt) 及 [现有界面设计](clawd-ui-design.md)；历史帧矩阵中的打字是按先前确认的静态构图编写的两帧，并非已取得的原始 GIF 动帧。仓库没有这些历史资源的原始生成 prompt，不能补造追溯记录；旧枚举中列出的 GIF 文件名也不能当作现存图片。

## 动作与切换规则

下表记录已接入动作及沿用的切换规则，六状态图片由前两个页面复用。`PLAY_LOOP` 只是 Usage 的展示动作名，不增加协议状态，也不覆盖真实 `PetState`。每个动作的完整提交提示词见 [pending-prompts.jsonl](pet-assets/pending-prompts.jsonl)，以 `action_id` 对应；原始 prompt 保持不变，PNG 图层动作由本地代码定义。

| action_id / 独立状态 | 适用页面 | 当前图层动画 | 选用与退出规则 |
|---|---|---|---|
| `idle-rest` / IDLE | STATUS、STATE_CHANGE | 原地轻呼吸、周期眨眼 | 状态页仅在底层 IDLE 选用；改变状态页仅在既有规则选择 IDLE 提示时选用。页面或对应展示状态改变即退出。 |
| `working-typing` / WORKING | STATUS、STATE_CHANGE | 旧 4×4 深描边、橙掌心双手，320 ms 旧序列/1,920 ms 循环，身体与电脑固定 | 状态页底层 WORKING 选用；改变状态页展示 WORKING 选用。FINISH 提示期间仍有主任务 WORKING，也选用此动作。固定机身、电脑和位置，禁止奔跑、横移与追球。 |
| `waiting-point` / WAITING | STATUS、STATE_CHANGE | 指向手端小幅往返，其余身体固定 | 仅在对应展示状态为 WAITING 时选用；恢复工作、出现新有效提示或页面改变时退出。不得从工具名称猜测等待。 |
| `finish-cheer` / FINISH | STATUS、STATE_CHANGE | 双臂轻抬庆祝，身体和脚保持原位 | 仅在对应展示状态为 FINISH，且不存在 FINISH + 底层 WORKING 例外时选用；提醒结束后按最新页面和状态重新选择。 |
| `error-alert` / ERROR | STATUS、STATE_CHANGE | 暖红警示块明暗脉冲，角色原地 | 仅在对应展示状态为 ERROR 时选用；状态或提示改变即退出。当前已使用暖红警示块脉冲。 |
| `offline-rest` / OFFLINE | STATUS、STATE_CHANGE | 灰蓝关键姿态静止，不创建动画循环 | 仅在对应展示状态为 OFFLINE 时选用；重连后立即按真实状态选择。沿用现有 OFFLINE 静默语义。 |
| `usage-ball` / PLAY_LOOP | 仅 USAGE | 独立完整球随走近、蓄脚触球、滚球追逐与越球转向动作滚动旋转，8 秒循环 | 仅由 Usage 页面可见性选用；真实 WORKING、FINISH、ERROR、用量涨跌或数据不可用均不改变它。离开 Usage 即退出。 |

保留现有路由与提醒分级：强提醒可进入改变状态页，结束后由既有页面选择恢复；弱提醒不打断 Usage。是否触发提醒、15 秒计时、主/子会话分类和完成归属均由现有逻辑及相关 issue 管理，本方案不修改它们。状态页始终保留原地工作动作，Usage 的走跳玩球不能用作 WORKING 的回退动作。

7 张 1024×1024 姿态 PNG 保持原样，运行时从姿态拆分局部图层，并按用户要求清除 WORKING 两处原手橙块、去掉侧边橙块，重建旧 4×4 深描边、橙掌心双手；双手使用 320 ms 旧代码序列、1,920 ms 循环，身体与电脑固定。Usage 原球替换为 `clawd/props/usage-soccer-ball.png` 独立完整球。这些运行时组合由代码执行，不能解释为全部来自七张 PNG 的原像素，也不冒称原始 GIF 动帧。

Usage 使用 32 ms 采样的连续 8 秒循环，每半程 4 秒：走近并蓄脚，1,200 ms 触球，球滚走后追逐，2,800 ms 开始越球并连续转向，4,000 ms 换向；球同步滚动旋转。转向时姿态宽度保持 82%～100%，跳跃中的 3,280～3,520 ms 以两组完整姿态短交叠渐变，球始终只绘制一层。素材在 IO 线程加载，图层按需要裁剪或保留主体透明画布，由全局 6 MiB `LruCache` 复用。Canvas 使用取整位置/尺寸与最近邻过滤绘制，`withInfiniteAnimationFrameNanos` 时钟在 `STARTED` 内采样，后台暂停、离页停止、换动作从零开始；OFFLINE 和静默姿态无循环。

## 确认与生成记录

三个页面、7 张关键姿态、1024×1024 目标和 [pending-prompts.jsonl](pet-assets/pending-prompts.jsonl) 中的 7 条完整 prompt 已在本次聊天确认，确认记录时间为 `2026-10-07T11:56:16Z`（UTC）。计划均为 `approval_status: "approved"`，`approval_source: "user confirmation in this chat"`；原始 prompt 未修改，计划不包含生成图片路径。

[generated-assets.jsonl](pet-assets/generated-assets.jsonl) 完整保留 **8 次 AI 工具输出**：7 张 v1 原图和 `idle-rest-v2` 技术纠正重试。首轮实际均为 1254×1254，带轻微纹理和边缘杂色；IDLE 工具重试没有纠正尺寸与纹理，状态为 `rejected`。7 条 v1 原始输出的 `review_status` 保持 `pending` 并注明 raw 不采用为交付，全部原图原样保留；接受的是对应的 7 张技术清理图。

每次 AI 输出记录有唯一 `generation_id`、`action_id`、实际提交的 `prompt`、真实 `reference_paths`、原始 `source_path`、仓库内 `image_path`、UTC `generated_at`、SHA-256 和实际尺寸/Alpha 信息。IDLE v2 单独保留纠正 prompt、以 v1 为参考图的路径及 `source_generation_id`，没有覆盖旧记录或确认计划。

每条 v1 记录另外包含 `processed_image_path` 和 `processing`，记载获授权的技术清理方法、源图路径/哈希、处理 UTC 时间、脚本路径/哈希、库版本、参数、输出哈希、实际尺寸、纯色与透明检查结果，以及独立的 `accepted` 审核状态。清理保留原图姿态与道具，清除纹理和杂色、映射纯色、以最近邻缩放居中到透明 1024×1024 画布；它不作为新的 AI 生成次数记录。

最初的姿态接入只给 7 条 v1 记录新增仓库相对路径 `runtime_asset_path`，指向 Android 的同名 PNG；全部原始生成及处理字段保持原值。本轮运行时改动没有改变这些 PNG 或原始记录。独立完整球的另一次 AI 生成、原始 prompt、清理脚本、处理与运行时路径记录在道具账本；代码双手不是 AI 新动帧。

## 本地校验

账本校验无需安装依赖，在仓库根目录运行：

```sh
python3 scripts/validate-pet-assets.py
python3 -m unittest discover -s tests -p 'test_pet_assets.py'
```

校验工具检查 JSONL、必需字段、计划/生成记录分离、动作 ID 关联与确认状态，以及参考图、原始输出和可选 `processed_image_path` / `runtime_asset_path` 确实为仓库内 PNG，并检查运行时副本与处理源逐字节一致。它不替代 Android 编译、动作测试或设备上的视觉验证。

技术清理可通过 [prepare-pet-assets.py](../scripts/prepare-pet-assets.py) 复现，需要 Pillow 和 NumPy：

```sh
python3 scripts/prepare-pet-assets.py
```

脚本保留 v1 原图，导出 7 个 `*-clean.png` 并实际检查尺寸、RGBA、二值 Alpha、纯色、居中及安全边距，真实处理元数据默认写入系统临时目录的 `issue8-cleanup-results.json`。

本轮已通过本机 `testDebugUnitTest`、`lintDebug`、`assembleDebug` 与 `compileDebugAndroidTestKotlin`。JVM 汇总为 145 个用例：144 通过、1 个预期跳过、0 失败/错误；lint 为 0 errors、8 warnings。包内新独立完整球与清理源图逐字节一致。最终 APK 为 [android-debug.apk](../apps/android/build/outputs/apk/debug/android-debug.apk)，大小 11,757,628 bytes，SHA-256：`a84e9109d567afd1c500945463d441b83a46177b2086548be8c49e726b73dee9`；主应用与测试 APK 在设备上的哈希分别与最终本地产物相符。

本轮 HUAWEI DBR-W00 实机回归为 19/19 通过、耗时 92.068 秒，251 个实际 Compose 帧按 32 ms 受控采样，覆盖完整 8 秒循环，首尾 RGBA 完全相同。最终采样帧 QA 确认角色转向未变线消失、越球阶段有可见间隔、未发现穿球或裁切，WORKING 电脑固定、侧橙块已清除且旧双手可见。正常应用最终启动并成功点击进入 Usage，Relay connected。视频为 250 个实机受控采样帧合成的 8 秒预览，不是墙钟录屏，详见 [实机验证记录](issue-8-device-validation.md)。

上一轮版本的 APK 大小为 11,750,231 bytes，SHA-256：`4d2bb523f18b6d46494ac0a83156f0fc1371e441285824053be8707aa98c5312`；18 项实机测试全部通过、耗时 38.104 秒，并完成接缝、电脑固定及后台返回检查。这些为旧手部/旧 Usage 版本的历史记录，保留在 [实机验证记录](issue-8-device-validation.md) 与 `reports/issue8-device/`；新证据单独写入 `reports/issue8-device-v2/`。测试输入为 fixture，不代表真实后端完整端到端验证；没有录屏，模型采样图与设备截图分别记录。
