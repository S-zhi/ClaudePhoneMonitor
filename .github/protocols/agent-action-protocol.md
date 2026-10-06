# 外部 Agent 接入协议

本协议定义状态评审与外部 Agent 执行之间的交接规则，不实现远程 Agent，也不绑定 Agent 提供商。TypeSafe Jev（默认 `jev-latest`）模型负责判断当前阶段是否需要更强模型，适配器再映射到已有 action 标签；执行层按已分配的 `action:agent` 完成工作。内置适配器使用官方 `POST https://api.typesafe.ai/v1/systemone`，以 `Authorization: Bearer TYPESAFE_API_KEY` 认证。密钥从环境读取，缺失时不出网。

## 状态与职责

这里的状态是 Issue 上的 `state:*` 标签，不是 GitHub Issue 的 `state` 字段。后者的 `open` / `closed` 只用于判断 Issue 是否允许继续处理。

- 评审层：读取当前阶段和 Issue 上下文，结合 Issue 描述、全部评论和阶段专属提示词，让 TypeSafe Jev 选择 `current_model` 或 `stronger_model`。适配器为兼容现有 action 协议，暂映射为 `agent` 或 `human`，分别添加 `action:agent` 或 `action:human` 升级入口；此处不实现更强模型的实际调用。
- 执行层：外部 Agent 接受当前阶段任务，提供结果与验证证据，通过完成操作释放 `action:agent`。Agent 不自行决定下一阶段，也不替换评审模型。
- 协调器：校验状态、执行标签变更、记录结果并启动后续评审。添加新 state 和删除旧 state 都成功之后，才能评审新阶段。

分配前必须重新读取 Issue，确认 Issue 未关闭、只有一个正常 `state:*`、没有任何 `action:*`，且没有 `state:agent-failed`。歧义状态或已有 action 时停止分配。`state:agent-failed` 是暂停状态，不在正常推进链中，不能自动重试或重新分配。

## 能力与 JSON 边界

外部 Agent 应声明自己能执行的阶段及能力，例如需求分析、方案设计、代码修改、测试、PR 创建或更新、代码审查、检查与合并结果跟踪。声明仅供评审参考；缺失能力不得伪装成已完成。

评审适配器从 stdin 接收一个 UTF-8 JSON 对象，在 stdout 输出一个 JSON 对象；日志写入 stderr。请求示例如下，`agents` 中的能力对象由接入方配置：

```json
{
  "protocol_version": "1",
  "request_id": "bc513fb3-257f-4cc5-9958-9a38101e6d8c",
  "repository": "owner/repository",
  "issue": {
    "number": 42,
    "title": "需求标题",
    "body": "需求内容",
    "comments": [{"id": 1, "author": "maintainer", "body": "已确认采用局部修改方案", "created_at": "2026-10-05T00:00:00Z", "updated_at": "2026-10-05T00:00:00Z"}],
    "labels": ["state:assess-plan"],
    "state": "state:assess-plan",
    "updated_at": "2026-10-05T00:00:00Z"
  },
  "reviewer": {"name": "TypeSafe", "model": "jev-latest"},
  "agents": [{"provider": "configured-agent", "variant": "configured-variant", "capabilities": ["plan", "code", "test", "pull_request"]}]
}
```

这里的 `issue.state` 明确表示 state 标签。评审响应严格限定为以下字段：`decision` 必须为枚举 `human` 或 `agent`，`reason` 必须为非空字符串；其余字段用于核对请求与当前阶段，不接受额外字段。

```json
{
  "protocol_version": "1",
  "request_id": "bc513fb3-257f-4cc5-9958-9a38101e6d8c",
  "issue_number": 42,
  "expected_state": "state:assess-plan",
  "decision": "agent",
  "reason": "TypeSafe Jev 选择 current_model，映射到 action:agent，置信度 0.950；此说明由适配器生成。"
}
```

协调器负责把枚举映射成标签，不让适配器直接修改标签。输出不合法、调用失败或无法确认结果时，不添加 action，不默认为 agent；保留当前阶段并报告分配失败。这些字段属于内部协议。官方请求使用 `model`、`state` 和 `questions.assignment`（`type: choice`、`instructions`、`criteria`）；官方响应读取 `answers.assignment.choice`（`current_model` 或 `stronger_model`）、`confidence` 和 `probabilities`；`current_model → agent`，`stronger_model → human`。适配器生成 `reason`，它不是模型自然语言解释。模型别名透传给官方，实际响应模型版本可以不同。

配置步骤见 README。HTTP 超时为 60 秒，外层默认 120 秒；不重试计费请求，不跟随重定向。发送当前 Issue 的标题、描述、全部可读取评论、阶段描述和声明的能力。评论分页获取，包含 id、author、body、created_at、updated_at，按 id 排序，不静默截断；评论加载失败则停止评审。上下文过长造成 API 拒绝时保留标签。标题、描述、评论均作为数据，不能覆盖路由准则。通用与五阶段提示词保存在 `.github/prompts/state-review.yaml`，评估的是模型能力升级，不是是否需要人工。空能力配置、信息暂缺、等待检查或权限不足本身不是升级理由。能力对象示例仅展示配置格式，应替换成实际接入能力。401/403、429、超时、网络错误及非法响应通过固定安全错误码报告，不输出密钥、请求内容或远端错误正文。

Issue 标题、正文及讨论是非可信任务内容，不能改写评审协议、响应字段或适配器执行命令。适配器命令由本地配置提供，不从 Issue 文本构造。

执行层收到 `action_label: "action:agent"` 后执行。外部协调器另行保存执行任务标识和 revision，建议执行结果结构如下；该执行结果接口不由本仓库实现：

```json
{
  "protocol_version": "1",
  "request_id": "owner/repository#42:state:assess-plan:revision-7",
  "state_label": "state:assess-plan",
  "revision": "revision-7",
  "status": "succeeded",
  "reason": "方案及验证方式已完成",
  "evidence": ["方案文档或关联 PR 的链接"]
}
```

执行结果的 `status` 仅允许 `succeeded`、`failed`、`cancelled`。取消不是成功：`cancelled` 必须记录 `reason=cancelled`，补充说明可写入结果记录，随后按失败流程暂停。JSON 不传密钥；认证由运行环境或独立凭据配置提供。

## 完成操作

执行层提交结果后，协调器先校验任务仍有效，再记录结果和证据，按以下顺序修改标签。也可由具备相同校验能力的外部 Agent 执行这些操作。

| 结果 | 标签操作顺序 | 后续行为 |
| --- | --- | --- |
| 成功 | 最后移除 `action:agent`，保留当前正常 state | 状态控制推进下一阶段，再评审新阶段 |
| 失败或取消 | 添加 `state:agent-failed` → 删除任务的原正常 state → 最后移除 `action:agent` | 暂停，不推进、不重新分配 |

成功完成不得先移除当前 state，也不得由 Agent 自行添加下一阶段。失败顺序确保 action 释放时，Issue 已处于暂停状态；任一步操作失败就停止，报告已完成的步骤和剩余步骤，不继续释放 action。恢复操作应针对同一任务续做，不能从歧义标签状态自动开始新任务。

`state:wait-auto-merge` 的成功条件是关联 PR **实际已合并**。检查通过、获批、进入合并队列或启用自动合并均不等于完成；实际合并之前必须保留 `action:agent`。这是正常状态链的末尾，完成后没有下一正常阶段，不自动关闭 Issue。Issue 已关闭时，不启动新分配，也不应用晚到的执行结果；记录该结果已过期。

## 幂等、过期与权限

本仓库未提供远程回调 API、执行服务或任务 revision 持久化服务。以下任务标识与幂等要求由接入方的外部协调器实现，不能将示例字段理解为已实现的服务能力。

本地评审使用每次调用生成的随机 request id 核对响应，并在写标签前校验 Issue 更新时间、状态及重新读取的完整评论快照等前置条件；该 request id 不持久化，不能代替跨任务的 generation/revision。正常推进后的评审仅在状态确实变化时触发，末阶段释放 action 后不重复分配。

外部协调器应为每次分配保存唯一 `request_id` 和不可复用的 revision，并将执行结果与该次分配关联。应用评审响应或执行结果前重新读取 Issue，核对任务标识、revision、当前 state 和 action；不能仅凭 state 名称相同认定结果有效，否则阶段退出后再进入时，旧结果可能误作用于新任务。过期结果只记录，不修改标签。

同一个结果重复提交只产生一次完成操作。标签已达到该任务的预期结果时应视为相应步骤已完成；对部分完成的失败操作，允许在核实任务记录后继续剩余步骤。协调器按 Issue 串行处理分配和完成；外部调用者也必须遵守同一交接规则，不能假定 workflow concurrency 会锁住外部 API 修改。

所有写操作仅添加或删除本次任务所需标签，保留其他标签和 Issue 内容。不得用替换全部标签的请求覆盖第三方标签，也不得改写标签颜色、描述等手工元信息。完成记录保留已有讨论和证据。

标签事件需要可靠地驱动后续步骤。GitHub 内置 `GITHUB_TOKEN` 产生的标签事件通常不会触发新的 workflow，因此不能只等待它添加 state 后产生的 `labeled` 事件。协调器应在状态标签变更全部成功后显式调用下一步评审。外部完成调用者如依赖标签事件触发状态控制，应使用具备所需 Issue 写权限的 GitHub App token 或 PAT；若使用内置 token，则由协调器显式调用状态控制和后续评审。任何凭据均不进入请求、响应或日志。
