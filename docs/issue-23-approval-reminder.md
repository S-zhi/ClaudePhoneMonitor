# Issue #23：独立审批提醒与显式决策桥

启用审批桥后，Claude 的每次真实 `PermissionRequest` Hook 调用生成独立 UUID。手机收到 `approval_requested` 后立即展示 `Awaiting approval`、关联任务、工具和请求编号，任务运行时长不影响触发。原操作内容留在电脑；手机提供 `Approve`、`Deny` 和 `在电脑处理` 入口，批准前需核对电脑上的待执行操作。同一会话、同一工具同时存在多个未决请求时，Compose 和 ViewModel 都禁止 `Approve`，可回电脑继续原生权限流程。

首次实际展示使用手机单调时钟，未处理的强提醒截止为首次展示时刻加 **300,000 毫秒**。在当前 ViewModel 持续期间，重复请求、同一请求的快照、名称更新、页面切换和重连都不重置截止。当前正在显示的请求一旦确认已处理，改为从首次收到处理结果起 **15,000 毫秒** 后退出；即使临近原五分钟边界，也展示完整 15 秒。普通 WORKING、WAITING、FINISH、ERROR、OFFLINE 事件继续更新最新任务状态，但不能关闭、替换或绕过有效审批页，也不会积攒一个普通强提醒在审批页到期后回放。第二个独立请求排队，只有真正展示时才开始自己的五分钟；排队期间已经明确处理的请求不会变成新的结果强提醒。

`approval_resolved` 必须匹配来源、请求身份及所属会话/任务。Claude 桥的 `approved` 显示 `Approval sent`，`denied` 显示 `Denial sent`；二者仅表示决定已写入 Claude Hook stdout，其他 Claude 权限规则或 Hooks 仍可能阻止执行。Codex 原生待办的 `resolved` 显示 `Handled on computer`，说明待办已解除，执行结果仍需在电脑核对，不推断批准或拒绝。这三种明确结果首次在当前审批页显示时启动固定的 15 秒结果期限，重复结果、快照、重连和后续事件不重启；已经退出的审批页也不会因迟到或重放结果重新打开。`unknown` 显示 `Approval status unavailable / Check on computer`，不证明已处理，仍使用原五分钟期限；交回电脑继续原生审核同样不被当作审批已完成。到有效期限边界，恢复之前的状态或 Usage 页并显示最新聚合状态；若请求仍明确 `pending`，两页均保留 `Awaiting approval` 提示和审批入口，即使其他任务仍为 WORKING，或该任务不在前五行会话中。当前没有跨 App 进程死亡或重启的倒计时持久化。

## Codex 原生待审批提示

Android 接受 `source=codex` 的权威原生待办元数据，显示同一 `Awaiting approval` 页面、关联任务和“请回电脑上的 Codex 原会话处理审批”提示。此来源始终 `can_respond=false`，手机不显示 Approve、Deny 或释放 Claude Hook 的“在电脑处理”按钮，也不发送 Codex 远程决定。`resolved` 只表示当前原生待办已解除；观察断线或桌面 owner 变化时为 unknown。界面拒绝 Codex 的 approved/denied 声称和可远程操作标记。

来源使用当前 Codex Desktop owner 的权威待办快照，不从 sessions JSONL、普通等待、静默或后续工具活动猜测审批。请求采用包含原生 owner、请求和线程身份的稳定脱敏标识，兼容 UUID v5，禁止转发 command、cwd 或原始 params。重复观察不重启五分钟等待或 15 秒结果期限；只有权威快照可将同一 Codex unknown 请求恢复为 pending，并保留最初身份、时间及本地首次展示期限。已经 resolved 的待办不能被旧事件复活。原生来源的安装和真实采集验证按实际部署结果记录，不能用此前 Claude 合成 Hook 的真机测试替代。

现有 Collector `--watch-codex` 同时启用这份 Desktop IPC 只读观察，默认使用 Codex Home 的 `ipc/ipc.sock`；受控测试可用 `--codex-ipc-socket` 指定隔离 socket。此功能无需启用 Claude 的 `--approval-bridge`。IPC 不可用或 owner 变化时不能根据旧事件证明原生待办仍在等待。

## 明确的阻塞询问

提问和输入等待无需启用 `--approval-bridge`。Claude 的明确 `AskUserQuestion` 工具事件使用 `waiting / reason=question`，显示 `Awaiting answer`；已支持的 elicitation 和 agent-needs-input 通知使用 `reason=input`，显示 `Awaiting input`。`ExitPlanMode` 的原生计划审阅使用 `reason=approval`，显示 `Awaiting approval`。这些场景均显示与审批一致的 WAITING Clawd 图标、相关任务和回电脑回答或审阅的提示，不提供 Allow/Deny，也不新增手机远程回答桥。交互工具绕过审批决策桥，答案和计划确认仍由电脑上的 Claude 原生流程收集。

状态页和 Usage 页均持续保留这份醒目提示，十五秒普通强 WAITING 提醒到期后仍可定位任务。询问不会获得审批专用的五分钟固定期限，也不能抢占正在展示的五分钟审批页；审批期限内记录的新询问，在审批页到期后可见。旧桥请求的 unknown 历史不会隐藏下一任务的计划审阅；只有真正对应的 pending 权限请求才去除重复提示。

首次连接及重连读取会话快照的可选 `waiting_reason`，仅该会话明确处于 waiting 且原因属于 permission/question/approval/input 时展示，其他会话的 WORKING 不会清除该提示。实时工具等待按安全 `correlation_id` 对应工具结果解除，无关并行 Bash 完成、重复的同一任务开始、旧会话行、Top 5 省略或缺失原因字段都不会被当成已回答。新的任务输入、匹配的工具完成/失败、任务或会话结束以及更新的权威会话状态可解除等待提示；不会声称已经获得某个具体答案。普通 waiting、stale、unknown 或静默时间不构造阻塞询问。

## 启用和实际生命周期

```bash
# 停止现有 Collector 后启用并保存选择；会更新用户级 monitor-owned Hook。
scripts/start-lan-monitor.sh --approval-bridge

# 恢复普通观察 Hook，并保存关闭选择。
scripts/start-lan-monitor.sh --no-approval-bridge
```

直接部署时，安装脚本支持 `--approval-bridge`，Collector 支持 `--collector --approval-bridge` 或 `COLLECTOR_APPROVAL_BRIDGE=1`；两端均需启用，Relay 和手机使用现有配对凭据。默认观察 Hook 仍短时、fail-open，不新增阻塞。桥模式只阻塞 `PermissionRequest`，最长十分钟；安装时为此 Hook 设置足够的超时。手机选择 `在电脑处理` 时，Hook 不输出 allow/deny，立即释放并回到 Claude 的原生权限流程。超时、Hook/Collector/Relay 连接丢失或重启恢复旧请求时，同样不代替用户选择允许或拒绝，并将可验证状态标为 unknown。

手机决定由 Relay 按已鉴权的 installation、请求 UUID 和当前拥有该 Hook 的 Collector 连接路由。`approval_presence` 证明当前 Hook 存活；持久化请求或重放事件本身不证明可操作。`approval_decision_ack` 只确认传输，不是审批结果。只有原 Hook 成功输出决定并通过本地确认后，Collector 才产生匹配的结果事件。审批记录在 Relay 持久存储；终态快照保留十五分钟，永久请求身份用于阻止旧请求重播。

点击后禁用重复选择。手机传输中断时保存原决定及 `decision_id`，显示交付状态待确认；重新获得可操作的权威快照后只允许重试相同决定和相同 ID。后端幂等处理该 ID，禁止换成相反决定；不根据普通工具进度猜测已批准。原 Hook 不再存活时按钮关闭，结果由明确生命周期更新。服务器不会把旧事件的 `can_respond` 当作存活证明，Android 也只允许权威快照启用操作；权威快照遗漏请求会保留原提醒页而关闭操作。

## 支持范围与隐私

Claude [官方 Hooks 文档](https://code.claude.com/docs/en/hooks) 的 `PermissionRequest` 不提供 `tool_use_id`，因此桥给实际调用分配 UUID，而不是从普通等待、通知文本或静默时间构造审批身份。`PostToolUseFailure` 不覆盖权限拒绝，`PermissionDenied` 仅适用于 auto mode 拒绝，不能拼成完整人工审批结果。桥返回官方的 `hookSpecificOutput.decision.behavior`，不修改输入或永久权限。sandbox network 权限只通过 `permission_prompt` Notification 通知时，不属于本桥的完整生命周期；默认观察模式的等待也不升级成独立审批页。

原 Codex sessions JSONL watcher 不包含权威 requestApproval / serverRequest/resolved 通道。新增原生审批来源读取当前 Desktop 的权威待办，提供只读提示与电脑入口，独立于 JSONL 的 WORKING/FINISH 等投影；不代理 Codex 审批决定。

上述询问图标仍仅覆盖 Claude 的明确工具和通知来源；Codex 原生审批提示不扩展为任意阻塞问答采集。

审批 IPC、outbox、事件、Relay 和日志仅保存安全元数据、UUID、状态及时间。命令、工具输入/输出、路径、prompt、密钥不通过桥上传，也不复制到 Hook stderr 或监控器日志。桥 Hook 的本地提示仅含请求 UUID 和工具元数据，可能在 Claude verbose Hook 输出中可见；这不是已经验证的原生弹窗编号关联。手机元数据不足以独立审核操作，需核对电脑会话上下文；无法可靠识别时选择 `在电脑处理` 释放 Hook，再从原生权限界面审核。

## 回归验证

协议验证覆盖请求/结果身份、来源和字段白名单、操作枚举、重复快照身份、终态不可操作与私密内容拒绝。Android JVM 用例覆盖 300,000 毫秒等待边界与 15,000 毫秒结果边界、临近五分钟处理后的完整结果期、重复/快照先到/重连不续期、普通强弱提醒不能抢占、结果原位更新、独立请求排队、未展示结果不触发提醒、ACK 边界首次显示截止、传输不确定的同 ID 重试，以及 WORKING 与 Usage 中未决审批保留。询问回归另覆盖显式来源、十五秒之后持续提示、匹配工具结果、并行工具隔离、首次及重连恢复、旧行防复活、重复同任务开始、桥历史不能遮住原生计划，以及询问不抢占审批页。Collector/Relay 回归覆盖真实 Hook 输出、匹配的本地交付确认、超时/断线恢复、配对鉴权、并行身份隔离、重复决定和重放拒绝。

Android 检查包含 `testDebugUnitTest`、`lintDebug`、`assembleDebug` 和 `assembleDebugAndroidTest`。华为 DBR-W00 实机已通过七个不同用例：四项界面/注入时钟测试，以及真实 WebSocket 的问询生命周期、桥决定和真实五分钟计时。真实计时使用生产 ViewModel 默认时钟，验证重复与结果不续期、结果原位更新和到期恢复最新 Usage；严格桥用例同时核对真实 Node CLI 的退出码和决定 stdout。来源是隔离的合成 Hook 元数据，未执行 Claude 工具、未修改原配对或用户 Hooks，也不等于验证了所有真实 Claude 来源。环境、复现命令、计时观察和十四张安全截图见[实机验证报告](device-testing/issue23-2026-10-07.md)。

后续已把新增 Codex 来源的 APK 和日常后端部署到同一实机。首次真实当前桌面审批经日常 Collector / Relay 产生同 UUID 的 pending → resolved，实机显示 `Handled on computer`；未使用 fixture 或注入请求。这份历史截图采用结果沿用五分钟的旧规则，随后用户修正为确认结果展示 15 秒。来源、时间、部署保留检查及新规则复验记录见 [Codex 实机复验](device-testing/issue23-codex-2026-10-08.md)。
