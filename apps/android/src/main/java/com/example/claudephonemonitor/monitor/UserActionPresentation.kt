package com.example.claudephonemonitor.monitor

/** An observed need for a human response, without a phone response bridge. */
data class AwaitingUserAction(
    val sessionId: String,
    val taskId: String?,
    val displayName: String,
    val reason: String,
    val sequence: Long,
    val toolName: String? = null,
    val correlationId: String? = null,
) {
    val title: String get() = when (reason) {
        "question" -> "Awaiting answer"
        "input" -> "Awaiting input"
        else -> "Awaiting approval"
    }
    val computerHint: String get() = when (reason) {
        "question" -> "请回电脑上的原会话回答问题。"
        "input" -> "请回电脑上的原会话提供输入。"
        else -> "请回电脑上的原会话审阅并处理。"
    }
}

internal data class UserActionPresentationState(
    val actions: Map<String, AwaitingUserAction> = emptyMap(),
    /** Per-session tombstones prevent an old row in a newer snapshot from reviving a question. */
    val clearedThroughSequence: Map<String, Long> = emptyMap(),
)

internal object UserActionPresentationReducer {
    fun reduce(state: UserActionPresentationState, event: MonitorEvent,
        knownTaskIds: Map<String, String?> = emptyMap()): UserActionPresentationState {
        val actions = state.actions.toMutableMap()
        val cleared = state.clearedThroughSequence.toMutableMap()
        fun clear(id: String, sequence: Long) {
            if (actions[id]?.sequence?.let { sequence < it } == true) return
            actions.remove(id)
            cleared[id] = maxOf(cleared[id] ?: -1L, sequence)
        }
        event.snapshot?.sessions?.forEach { row ->
            val current = actions[row.sessionId]
            val sequence = row.lastActivitySequence
            if (sequence < (current?.sequence ?: -1L)) return@forEach
            val reason = row.waitingReason?.takeIf { row.claudeState == ClaudeState.WAITING && it in USER_ACTION_WAITING_REASONS }
            if (reason != null && sequence > (cleared[row.sessionId] ?: -1L)) {
                val sameReason = current?.reason == reason
                actions[row.sessionId] = AwaitingUserAction(row.sessionId, current?.taskId, row.title, reason,
                    sequence, current?.toolName?.takeIf { sameReason }, current?.correlationId?.takeIf { sameReason })
            } else if (row.claudeState != ClaudeState.WAITING) {
                clear(row.sessionId, sequence)
            }
        }
        // Omitted Top 5 rows are unknown, never evidence that a question was answered.
        if (event.type != MonitorEventType.EVENT) return state.copy(actions = actions, clearedThroughSequence = cleared)
        val id = event.sessionId?.takeUnless { it == "unknown" } ?: return state.copy(actions = actions, clearedThroughSequence = cleared)
        val sequence = event.sequence ?: return state.copy(actions = actions, clearedThroughSequence = cleared)
        val current = actions[id]
        if (sequence < (current?.sequence ?: -1L)) return state.copy(actions = actions, clearedThroughSequence = cleared)
        val reason = event.waitingReason?.takeIf { it in USER_ACTION_WAITING_REASONS }
        val repeatedTaskStart = event.name == MonitorEventName.TASK_STARTED && !event.taskId.isNullOrBlank() &&
            (event.taskId == current?.taskId || event.taskId == knownTaskIds[id])
        val startsNewTask = event.name == MonitorEventName.TASK_STARTED && !repeatedTaskStart
        if (current == null && (startsNewTask || event.name in setOf(MonitorEventName.TASK_FINISHED,
                MonitorEventName.TASK_FAILED, MonitorEventName.SESSION_STARTED, MonitorEventName.SESSION_ENDED) ||
            (event.name in setOf(MonitorEventName.TOOL_FINISHED, MonitorEventName.TOOL_FAILED) &&
                event.toolName in setOf("AskUserQuestion", "ExitPlanMode")))) {
            clear(id, sequence)
        }
        if (event.name == MonitorEventName.WAITING && reason != null && sequence > (cleared[id] ?: -1L)) {
            actions[id] = AwaitingUserAction(id, event.taskId,
                event.sessionTitle ?: event.snapshot?.sessions?.firstOrNull { it.sessionId == id }?.title
                    ?: current?.displayName ?: fallbackSessionTitle(id), reason, sequence, event.toolName, event.correlationId)
        } else if (current != null) {
            val taskMatches = current.taskId == null || event.taskId == null || current.taskId == event.taskId
            val matchingToolResult = event.name in setOf(MonitorEventName.TOOL_FINISHED, MonitorEventName.TOOL_FAILED) &&
                taskMatches && when {
                    current.correlationId != null -> current.correlationId == event.correlationId
                    current.toolName != null -> current.toolName == event.toolName
                    else -> false // An unrelated tool never proves that a generic input wait ended.
                }
            val bridgeResult = event.name == MonitorEventName.APPROVAL_RESOLVED && event.approval != null &&
                current.reason == "permission" && taskMatches
            if (matchingToolResult || bridgeResult || startsNewTask || event.name in setOf(
                    MonitorEventName.SESSION_STARTED, MonitorEventName.SESSION_ENDED) ||
                (taskMatches && event.name in setOf(MonitorEventName.TASK_FINISHED, MonitorEventName.TASK_FAILED))) {
                clear(id, sequence)
            } else if (event.name == MonitorEventName.SESSION_TITLE_UPDATED && !event.sessionTitle.isNullOrBlank()) {
                actions[id] = current.copy(displayName = event.sessionTitle)
            }
        }
        return state.copy(actions = actions, clearedThroughSequence = cleared)
    }
}
