package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

/** Presentation state is independent of Android lifecycle and uses monotonic milliseconds. */
internal data class MonitorPresentationState(
    val baseState: PetState = PetState.OFFLINE,
    val lastSequence: Long? = null,
    val lastHandledEventSequence: Long? = null,
    val hasSnapshot: Boolean = false,
    val changeStatus: PetState? = null,
    val changeIdentity: String? = null,
    val changeSessionId: String? = null,
    val changeDeadlineMs: Long? = null,
    val changeStrength: ReminderStrength = ReminderStrength.WEAK,
    val completionName: String? = null,
    val recentSessionCompletion: RecentCompletion? = null,
    val sessionCompletionDeadlineMs: Long? = null,
    val lastOutcomeIdentity: String? = null,
    val lastCompletionIdentity: String? = null,
    val finishTailSequence: Long? = null,
    val workingSessionIds: Set<String>? = null,
    val sessionKinds: Map<String, SessionKind> = emptyMap(),
    val activeTasks: Map<String, TaskTiming> = emptyMap(),
)

/** Server/source time proves identity and duration; display deadlines remain monotonic. */
internal data class TaskTiming(
    val taskId: String?,
    val startedAtMs: Long,
    val elapsedAtObservationMs: Long,
    val observedMonotonicMs: Long,
) {
    fun elapsed(nowMs: Long): Long? {
        if (nowMs < observedMonotonicMs) return null
        return (elapsedAtObservationMs + (nowMs - observedMonotonicMs).coerceAtMost(MAX_TASK_DURATION_MS))
            .coerceAtMost(MAX_TASK_DURATION_MS)
    }

    fun matches(taskId: String?): Boolean = this.taskId == null || taskId == null || this.taskId == taskId
}

internal data class MonitorPresentationReduction(
    val state: MonitorPresentationState,
    val accepted: Boolean,
)

/** Event-bound reminders are independent of the underlying aggregate state. */
internal object MonitorPresentationReducer {
    const val STATE_CHANGE_DURATION_MS = 15_000L
    const val WEAK_REMINDER_DURATION_MS = 5_000L
    const val LONG_TASK_THRESHOLD_MS = 300_000L
    private val USER_ACTION_REASONS = setOf("permission", "question", "approval", "input")

    fun reduce(
        state: MonitorPresentationState,
        event: MonitorEvent,
        nowMs: Long,
    ): MonitorPresentationReduction {
        var current = expire(state, nowMs)
        val incomingSequence = event.sequenceWatermark()
        val atOrBehindSequence = incomingSequence != null &&
            current.lastSequence?.let { incomingSequence <= it } == true
        val equalSequenceSnapshotRefresh = event.type != MonitorEventType.EVENT &&
            event.snapshot != null && incomingSequence != null &&
            incomingSequence == current.lastSequence
        // A snapshot can advance the watermark before the corresponding live event arrives.
        // Accept that one event once; lower sequences and repeats remain ineligible.
        val unseenEqualSequenceEvent = event.type == MonitorEventType.EVENT && event.sequence != null &&
            event.sequence == incomingSequence && incomingSequence == current.lastSequence &&
            event.sequence != current.lastHandledEventSequence
        if (event.type != MonitorEventType.DISCONNECTED && atOrBehindSequence && !equalSequenceSnapshotRefresh && !unseenEqualSequenceEvent) {
            return MonitorPresentationReduction(current, accepted = false)
        }

        val sessionKinds = current.sessionKinds.toMutableMap()
        event.snapshot?.sessions?.forEach { row -> row.sessionKind?.let { if (sessionKinds[row.sessionId] != SessionKind.SUBAGENT) sessionKinds[row.sessionId] = it } }
        event.sessionId?.let { id -> event.sessionKind?.let { if (sessionKinds[id] != SessionKind.SUBAGENT) sessionKinds[id] = it } }
        val neutral = event.name == MonitorEventName.SESSION_CLASSIFICATION_UPDATED ||
            (event.type == MonitorEventType.EVENT && sessionKinds[event.sessionId] == SessionKind.SUBAGENT)
        val resolvedSnapshot = event.snapshot?.copy(sessions = event.snapshot.sessions?.map { row ->
            row.copy(sessionKind = sessionKinds[row.sessionId] ?: row.sessionKind)
        })
        val observedTasks = observeTasks(current.activeTasks, resolvedSnapshot, sessionKinds, nowMs)
        if (sessionKinds[current.changeSessionId] == SessionKind.SUBAGENT) {
            current = current.copy(changeStatus = null, changeIdentity = null, changeSessionId = null,
                changeDeadlineMs = null, completionName = null, changeStrength = ReminderStrength.WEAK)
        }
        if (sessionKinds[current.recentSessionCompletion?.sessionId] == SessionKind.SUBAGENT) {
            current = current.copy(recentSessionCompletion = null, sessionCompletionDeadlineMs = null)
        }
        if (neutral) {
            val mainWorkingIds = current.workingSessionIds?.filterTo(linkedSetOf()) {
                sessionKinds[it] != SessionKind.SUBAGENT
            }
            return MonitorPresentationReduction(current.copy(
                baseState = resolvedSnapshot?.aggregatePetState(current.recentSessionCompletion) ?: if (
                    current.baseState == PetState.WORKING && mainWorkingIds?.isEmpty() == true
                ) PetState.IDLE else current.baseState,
                lastSequence = incomingSequence ?: current.lastSequence,
                lastHandledEventSequence = event.sequence.takeIf { event.type == MonitorEventType.EVENT } ?: current.lastHandledEventSequence,
                hasSnapshot = current.hasSnapshot || resolvedSnapshot != null,
                sessionKinds = sessionKinds,
                activeTasks = observedTasks,
                workingSessionIds = resolvedSnapshot?.sessions?.filter {
                    it.sessionKind != SessionKind.SUBAGENT &&
                        it.displayState(current.recentSessionCompletion) == SessionDisplayState.WORKING
                }?.mapTo(linkedSetOf()) { it.sessionId } ?: mainWorkingIds,
            ), accepted = true)
        }
        val outcome = event.outcomeState()?.takeUnless { it == PetState.FINISH && event.sessionId == "unknown" }
        val validCompletionOutcome = outcome == PetState.FINISH && event.sessionId != null && event.sessionId != "unknown"
        val outcomeIdentity = event.outcomeIdentity()
        val duplicateOutcome = outcomeIdentity != null && outcomeIdentity == current.lastOutcomeIdentity
        val completion = event.snapshot?.recentCompletion?.takeUnless { it.sessionId == "unknown" || sessionKinds[it.sessionId] == SessionKind.SUBAGENT }
        val matchingEventCompletion = completion?.takeIf {
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_FINISHED &&
                it.sessionId == event.sessionId && it.sequence == event.sequence &&
                (it.taskId == null || event.taskId == null || it.taskId == event.taskId)
        }?.let { it.copy(taskId = it.taskId ?: event.taskId) }
        val matchingCompletion = completion?.takeIf {
            it.matchesCompletion(current.recentSessionCompletion)
        }?.let { it.copy(taskId = it.taskId ?: current.recentSessionCompletion?.taskId) }
        val titledLocalCompletion = current.recentSessionCompletion?.takeIf {
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.SESSION_TITLE_UPDATED &&
                event.sessionId == it.sessionId && !event.taskId.isNullOrBlank() && event.taskId == it.taskId &&
                !event.sessionTitle.isNullOrBlank()
        }?.copy(displayName = event.sessionTitle.orEmpty())
        val activeFinishParts = current.changeIdentity?.split('|')
        val activeFinishSequence = activeFinishParts?.getOrNull(2)?.toLongOrNull()
        // A later suppressed finish can replace the durable local result while this reminder
        // still belongs to its original task. Refine only that reminder's completion identity.
        val matchingReminderCompletion = completion?.takeIf {
            it.sessionId == activeFinishParts?.getOrNull(0) && it.sequence == activeFinishSequence &&
                (activeFinishParts?.getOrNull(1).isNullOrBlank() || it.taskId == null ||
                    it.taskId == activeFinishParts?.getOrNull(1))
        }?.let { it.copy(taskId = it.taskId ?: activeFinishParts?.getOrNull(1)?.takeIf { taskId -> taskId.isNotBlank() }) }
        val snapshotConfirmsCurrentFinish = current.changeStatus == PetState.FINISH &&
            current.changeDeadlineMs?.let { nowMs < it } == true &&
            (matchingReminderCompletion != null ||
                (completion == null && event.snapshot?.activity == MonitorEventName.TASK_FINISHED.wireValue &&
                    incomingSequence != null && incomingSequence == activeFinishSequence))
        val toolFinishedClosesCurrentFinish = event.type == MonitorEventType.EVENT &&
            event.name == MonitorEventName.TOOL_FINISHED && event.sessionId != null &&
            activeFinishParts?.getOrNull(0) == event.sessionId &&
            (event.taskId == null || activeFinishParts.getOrNull(1) == event.taskId) &&
            current.changeDeadlineMs?.let { nowMs < it } == true
        val matchingFinishTailSnapshot = event.snapshot != null && current.changeStatus == PetState.FINISH &&
            current.changeDeadlineMs?.let { nowMs < it } == true && incomingSequence != null &&
            incomingSequence == current.finishTailSequence

        val baseState = when {
            event.type == MonitorEventType.DISCONNECTED -> PetState.OFFLINE
            current.baseState == PetState.OFFLINE && event.snapshot == null -> PetState.OFFLINE
            event.snapshot != null -> resolvedSnapshot!!.aggregatePetState(current.recentSessionCompletion)
            outcome != null && current.baseState == PetState.WORKING -> if (
                current.workingSessionIds?.none { it != event.sessionId } == true ||
                    (current.workingSessionIds == null && current.activeTasks.isNotEmpty() &&
                        current.activeTasks.keys.none { it != event.sessionId })
            ) if (validCompletionOutcome) PetState.FINISH else PetState.IDLE else PetState.WORKING
            outcome != null && current.baseState == PetState.OFFLINE -> PetState.OFFLINE
            outcome != null -> if (validCompletionOutcome) PetState.FINISH else PetState.IDLE
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_STARTED -> PetState.WORKING
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.SESSION_STARTED && current.baseState != PetState.WORKING -> PetState.IDLE
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.WAITING && current.baseState != PetState.WORKING -> PetState.WAITING
            else -> current.baseState
        }

        // Relay only retains recent_completion for five seconds. Restore an unseen result on
        // connection, but never extend a result already shown, even after its local deadline.
        val lastCompletionSequence = current.lastCompletionIdentity?.substringAfterLast('|')?.toLongOrNull()
        val newSnapshotCompletion = completion?.takeIf {
            event.type != MonitorEventType.EVENT && baseState != PetState.OFFLINE &&
                (lastCompletionSequence == null || it.sequence > lastCompletionSequence)
        }

        val disconnectChanged = event.type == MonitorEventType.DISCONNECTED &&
            current.hasSnapshot && current.baseState != PetState.OFFLINE
        val duplicateTaskStart = event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_STARTED &&
            !event.taskId.isNullOrBlank() && current.activeTasks[event.sessionId]?.taskId == event.taskId
        val eventStatus = when {
            current.baseState == PetState.OFFLINE && event.snapshot == null -> null
            outcome != null -> outcome
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_STARTED && !duplicateTaskStart &&
                (event.sessionId != null || current.baseState != PetState.WORKING ||
                    (current.changeStatus == PetState.FINISH && activeFinishParts?.getOrNull(0) == event.sessionId)) -> PetState.WORKING
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.WAITING &&
                (event.sessionId != null || current.baseState !in setOf(PetState.WORKING, PetState.WAITING)) -> PetState.WAITING
            else -> null
        }
        val snapshotStatusChanged = event.snapshot != null && current.hasSnapshot &&
            baseState != current.baseState
        val equalSequenceIdleRefreshDuringFinish = equalSequenceSnapshotRefresh &&
            baseState == PetState.IDLE && current.changeStatus == PetState.FINISH
        val suppressFinishTail = snapshotConfirmsCurrentFinish || toolFinishedClosesCurrentFinish ||
            matchingFinishTailSnapshot || equalSequenceIdleRefreshDuringFinish
        val seenCompletionParts = current.lastCompletionIdentity?.split('|')
        val eventConfirmsPresentedCompletion = event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_FINISHED &&
            (current.recentSessionCompletion?.let {
                it.sessionId == event.sessionId && it.sequence == event.sequence &&
                    (it.taskId == null || event.taskId == null || it.taskId == event.taskId)
            } == true || (seenCompletionParts?.getOrNull(0) == event.sessionId &&
                seenCompletionParts?.getOrNull(2)?.toLongOrNull() == event.sequence &&
                (seenCompletionParts?.getOrNull(1).isNullOrBlank() || event.taskId == null ||
                    seenCompletionParts?.getOrNull(1) == event.taskId)))

        var changeStatus = current.changeStatus
        var changeIdentity = current.changeIdentity
        var changeDeadlineMs = current.changeDeadlineMs
        var changeStrength = current.changeStrength
        var completionName = current.completionName
        val candidateStatus = when {
            disconnectChanged -> PetState.OFFLINE
            newSnapshotCompletion != null -> PetState.FINISH
            eventStatus != null -> eventStatus
            else -> baseState
        }
        val duration = when {
            newSnapshotCompletion != null -> newSnapshotCompletion.durationMs.validTaskDuration()
                ?: taskDuration(current.activeTasks, newSnapshotCompletion.sessionId, newSnapshotCompletion.taskId,
                    newSnapshotCompletion.occurredAt, nowMs)
            outcome == PetState.FINISH || event.name == MonitorEventName.TASK_FAILED ->
                event.durationMs.validTaskDuration() ?: matchingEventCompletion?.durationMs.validTaskDuration()
                    ?: taskDuration(current.activeTasks, event.sessionId, event.taskId, event.occurredAt, nowMs)
            event.name == MonitorEventName.WAITING -> taskDuration(observedTasks, event.sessionId, event.taskId, event.occurredAt, nowMs)
            else -> null
        }
        val strength = when {
            candidateStatus == PetState.OFFLINE &&
                event.detail != "monitor closed" &&
                observedTasks.any { (id, timing) ->
                    sessionKinds[id] != SessionKind.SUBAGENT && timing.elapsed(nowMs)?.let { it > LONG_TASK_THRESHOLD_MS } == true
                } -> ReminderStrength.STRONG
            candidateStatus == PetState.FINISH && duration?.let { it > LONG_TASK_THRESHOLD_MS } == true -> ReminderStrength.STRONG
            candidateStatus == PetState.ERROR && event.name == MonitorEventName.TASK_FAILED &&
                duration?.let { it > LONG_TASK_THRESHOLD_MS } == true -> ReminderStrength.STRONG
            candidateStatus == PetState.WAITING && event.type == MonitorEventType.EVENT &&
                event.name == MonitorEventName.WAITING && event.waitingReason in USER_ACTION_REASONS &&
                duration?.let { it > LONG_TASK_THRESHOLD_MS } == true -> ReminderStrength.STRONG
            else -> ReminderStrength.WEAK
        }
        val candidateStartsChange = when {
            disconnectChanged -> true
            newSnapshotCompletion != null -> true
            eventStatus != null && !(outcome != null && duplicateOutcome) && !suppressFinishTail && !eventConfirmsPresentedCompletion -> true
            snapshotStatusChanged && baseState != PetState.FINISH && !suppressFinishTail -> true
            else -> false
        }
        // Ordinary changes can update the underlying state without taking over a strong result.
        val startsChange = candidateStartsChange &&
            !(current.changeStatus != null && current.changeStrength == ReminderStrength.STRONG && strength == ReminderStrength.WEAK)
        val reminderDuration = if (strength == ReminderStrength.STRONG) STATE_CHANGE_DURATION_MS else WEAK_REMINDER_DURATION_MS
        if (startsChange) {
            val status = candidateStatus
            val identity = if (status == PetState.FINISH) {
                newSnapshotCompletion?.identity ?: matchingEventCompletion?.identity ?: event.completionIdentity() ?: outcomeIdentity
            } else outcomeIdentity
                ?: when {
                disconnectChanged -> "disconnect:${nowMs}"
                incomingSequence != null -> "snapshot:$incomingSequence:${status.name}"
                else -> "state:${status.name}:$nowMs"
            }
            changeStatus = status
            changeIdentity = identity
            changeDeadlineMs = nowMs + reminderDuration
            changeStrength = strength
            completionName = if (status == PetState.FINISH) {
                newSnapshotCompletion?.displayName?.takeIf { it.isNotBlank() }
                    ?: matchingEventCompletion?.displayName?.takeIf { it.isNotBlank() }
                    ?: event.sessionTitle?.takeIf { it.isNotBlank() }
                    ?: event.sessionId?.let { id -> event.snapshot?.sessions?.firstOrNull { it.sessionId == id }?.title }
                    ?: current.completionName?.takeIf { current.changeIdentity == identity }
                    ?: event.sessionId?.let(::fallbackSessionTitle)
                    ?: "未命名会话"
            } else null
        } else if (current.changeStatus == PetState.FINISH && matchingReminderCompletion != null &&
            matchingReminderCompletion.displayName.isNotBlank()
        ) {
            // Fill in a better label within the existing local deadline; never restart it.
            completionName = matchingReminderCompletion.displayName
            changeIdentity = matchingReminderCompletion.identity
        }
        if (titledLocalCompletion != null && changeStatus == PetState.FINISH &&
            changeIdentity == titledLocalCompletion.identity
        ) completionName = titledLocalCompletion.displayName

        var recentSessionCompletion = current.recentSessionCompletion
        var sessionCompletionDeadlineMs = current.sessionCompletionDeadlineMs
        if (newSnapshotCompletion != null) {
            recentSessionCompletion = newSnapshotCompletion
            sessionCompletionDeadlineMs = nowMs + reminderDuration
        } else if (validCompletionOutcome && event.sessionId != null && event.sequence != null && !duplicateOutcome && !eventConfirmsPresentedCompletion) {
            recentSessionCompletion = matchingEventCompletion ?: RecentCompletion(
                sessionId = event.sessionId,
                taskId = event.taskId,
                sequence = event.sequence,
                occurredAt = event.occurredAt.ifBlank { event.updatedAt },
                displayName = event.sessionTitle?.takeIf { it.isNotBlank() }
                    ?: event.snapshot?.sessions?.firstOrNull { it.sessionId == event.sessionId }?.title
                    ?: fallbackSessionTitle(event.sessionId),
                durationMs = duration,
            )
            sessionCompletionDeadlineMs = nowMs + reminderDuration
        } else if (matchingCompletion != null) {
            recentSessionCompletion = matchingCompletion
        } else if (titledLocalCompletion != null) {
            recentSessionCompletion = titledLocalCompletion
        }
        val completedSession = recentSessionCompletion?.let { result ->
            event.snapshot?.sessions?.firstOrNull { it.sessionId == result.sessionId }
        }
        val completedSessionRestarted = event.type == MonitorEventType.EVENT &&
            (event.name in setOf(MonitorEventName.TASK_STARTED, MonitorEventName.SESSION_STARTED, MonitorEventName.TASK_FAILED, MonitorEventName.WAITING)) &&
            event.sessionId == recentSessionCompletion?.sessionId
        val snapshotShowsRestart = completedSession != null && completedSession.taskCompleted != true &&
            completedSession.lastActivitySequence > (recentSessionCompletion?.sequence ?: Long.MAX_VALUE) &&
            event.name != MonitorEventName.SESSION_TITLE_UPDATED
        // A weak finish suppressed by a strong reminder is still seen, so a following snapshot
        // cannot replay it after the strong reminder expires.
        val observedCompletionIdentity = newSnapshotCompletion?.identity ?: event.completionIdentity()
            ?: recentSessionCompletion?.identity ?: current.lastCompletionIdentity
        val lastCompletionIdentity = if (
            (current.lastCompletionIdentity?.substringAfterLast('|')?.toLongOrNull() ?: -1L) >
            (observedCompletionIdentity?.substringAfterLast('|')?.toLongOrNull() ?: -1L)
        ) current.lastCompletionIdentity else observedCompletionIdentity
        if (completedSessionRestarted || snapshotShowsRestart) {
            recentSessionCompletion = null
            sessionCompletionDeadlineMs = null
        }

        val state = current.copy(
            sessionKinds = sessionKinds,
            baseState = if (event.type == MonitorEventType.DISCONNECTED) baseState
                else resolvedSnapshot?.aggregatePetState(recentSessionCompletion) ?: baseState,
            lastSequence = incomingSequence ?: current.lastSequence,
            lastHandledEventSequence = event.sequence.takeIf { event.type == MonitorEventType.EVENT } ?: current.lastHandledEventSequence,
            hasSnapshot = current.hasSnapshot || event.snapshot != null,
            changeStatus = changeStatus,
            changeIdentity = changeIdentity,
            changeSessionId = if (startsChange) newSnapshotCompletion?.sessionId ?: event.sessionId else current.changeSessionId,
            changeDeadlineMs = changeDeadlineMs,
            changeStrength = changeStrength,
            completionName = completionName,
            recentSessionCompletion = recentSessionCompletion,
            sessionCompletionDeadlineMs = sessionCompletionDeadlineMs,
            lastOutcomeIdentity = if (outcomeIdentity != null && !duplicateOutcome) outcomeIdentity else current.lastOutcomeIdentity,
            lastCompletionIdentity = lastCompletionIdentity,
            finishTailSequence = when {
                startsChange -> null
                toolFinishedClosesCurrentFinish -> incomingSequence
                else -> current.finishTailSequence
            },
            workingSessionIds = event.snapshot?.let { snapshot ->
                snapshot.sessions?.filter { sessionKinds[it.sessionId] != SessionKind.SUBAGENT &&
                    it.displayState(recentSessionCompletion) == SessionDisplayState.WORKING }
                    ?.mapTo(linkedSetOf()) { it.sessionId }
            } ?: if (event.snapshot != null) null else when {
                event.type == MonitorEventType.EVENT && event.sessionId != null && event.name == MonitorEventName.TASK_STARTED ->
                    current.workingSessionIds?.plus(event.sessionId)
                event.type == MonitorEventType.EVENT && event.sessionId != null &&
                    event.name in setOf(MonitorEventName.TASK_FINISHED, MonitorEventName.TASK_FAILED, MonitorEventName.SESSION_ENDED) ->
                    current.workingSessionIds?.minus(event.sessionId)
                else -> current.workingSessionIds
            },
            activeTasks = updateTasks(observedTasks, event, sessionKinds, nowMs),
        )
        return MonitorPresentationReduction(state, accepted = true)
    }

    fun expire(state: MonitorPresentationState, nowMs: Long): MonitorPresentationState {
        val changeExpired = state.changeDeadlineMs?.let { nowMs >= it } == true
        val completionExpired = state.sessionCompletionDeadlineMs?.let { nowMs >= it } == true
        if (!changeExpired && !completionExpired) return state
        return state.copy(
            changeStatus = if (changeExpired) null else state.changeStatus,
            changeIdentity = if (changeExpired) null else state.changeIdentity,
            changeSessionId = if (changeExpired) null else state.changeSessionId,
            changeDeadlineMs = if (changeExpired) null else state.changeDeadlineMs,
            changeStrength = if (changeExpired) ReminderStrength.WEAK else state.changeStrength,
            completionName = if (changeExpired) null else state.completionName,
            // The reminder expires; the confirmed task result remains until newer activity.
            recentSessionCompletion = state.recentSessionCompletion,
            sessionCompletionDeadlineMs = if (completionExpired) null else state.sessionCompletionDeadlineMs,
        )
    }

    fun stateChange(state: MonitorPresentationState, nowMs: Long): StateChangeUi? {
        val current = expire(state, nowMs)
        val status = current.changeStatus ?: return null
        val remaining = (current.changeDeadlineMs ?: return null) - nowMs
        return if (remaining > 0L) StateChangeUi(status, remaining, current.completionName, current.changeStrength) else null
    }

    private fun observeTasks(
        previous: Map<String, TaskTiming>,
        snapshot: MonitorSnapshot?,
        sessionKinds: Map<String, SessionKind>,
        nowMs: Long,
    ): Map<String, TaskTiming> {
        val mainTasks = previous.filterKeys { sessionKinds[it] != SessionKind.SUBAGENT }
        val tasks = snapshot?.activeTasks ?: return mainTasks
        // More than one current task for a session is ambiguous; do not infer its duration.
        return tasks.groupBy { it.sessionId }.mapNotNull { (id, candidates) ->
            val task = candidates.singleOrNull() ?: return@mapNotNull null
            if (sessionKinds[id] == SessionKind.SUBAGENT || id == "unknown") return@mapNotNull null
            val startedAtMs = wireTimestampMillis(task.startedAt) ?: return@mapNotNull null
            val elapsedMs = task.elapsedMs.validTaskDuration() ?: return@mapNotNull null
            id to TaskTiming(task.taskId, startedAtMs, elapsedMs, nowMs)
        }.toMap()
    }

    private fun taskDuration(
        tasks: Map<String, TaskTiming>,
        sessionId: String?,
        taskId: String?,
        occurredAt: String,
        nowMs: Long,
    ): Long? {
        val timing = tasks[sessionId] ?: return null
        if (!timing.matches(taskId)) return null
        if (occurredAt.isBlank()) return timing.elapsed(nowMs)
        val occurredAtMs = wireTimestampMillis(occurredAt) ?: return null
        return (occurredAtMs - timing.startedAtMs).takeIf { it >= 0L }?.coerceAtMost(MAX_TASK_DURATION_MS)
    }

    internal fun inferTaskDuration(
        tasks: Map<String, TaskTiming>,
        sessionId: String?,
        taskId: String?,
        occurredAt: String,
        nowMs: Long,
    ): Long? = taskDuration(tasks, sessionId, taskId, occurredAt, nowMs)

    private fun updateTasks(
        observed: Map<String, TaskTiming>,
        event: MonitorEvent,
        sessionKinds: Map<String, SessionKind>,
        nowMs: Long,
    ): Map<String, TaskTiming> {
        if (event.type != MonitorEventType.EVENT) return observed
        val id = event.sessionId?.takeUnless { it == "unknown" || sessionKinds[it] == SessionKind.SUBAGENT } ?: return observed
        val tasks = observed.toMutableMap()
        when (event.name) {
            MonitorEventName.TASK_STARTED -> {
                val startedAtMs = wireTimestampMillis(event.occurredAt)
                if (!event.taskId.isNullOrBlank() && tasks[id]?.taskId == event.taskId) Unit
                else if (startedAtMs == null) tasks.remove(id)
                else if (tasks[id]?.let { it.taskId == event.taskId && it.startedAtMs == startedAtMs } != true) {
                    tasks[id] = TaskTiming(event.taskId, startedAtMs, 0L, nowMs)
                }
            }
            MonitorEventName.TASK_FINISHED, MonitorEventName.TASK_FAILED ->
                if (tasks[id]?.matches(event.taskId) == true) tasks.remove(id)
            MonitorEventName.SESSION_STARTED, MonitorEventName.SESSION_ENDED -> tasks.remove(id)
            else -> Unit // Tool failures and user waits leave the current task alive.
        }
        return tasks
    }

    private fun MonitorEvent.sequenceWatermark(): Long? {
        val snapshotSequence = snapshot?.lastSequence?.takeIf { it > 0L }
        return listOfNotNull(sequence, snapshotSequence).maxOrNull()
    }

    private fun MonitorEvent.outcomeState(): PetState? = when {
        type != MonitorEventType.EVENT -> null
        name == MonitorEventName.TASK_FINISHED -> PetState.FINISH
        name == MonitorEventName.TASK_FAILED || name == MonitorEventName.TOOL_FAILED -> PetState.ERROR
        else -> null
    }

    private fun MonitorEvent.outcomeIdentity(): String? {
        if (outcomeState() == null) return null
        val seq = sequence ?: return null
        return "${name.wireValue}:${sessionId.orEmpty()}:${taskId.orEmpty()}:$seq"
    }

    private fun MonitorEvent.completionIdentity(): String? {
        if (type != MonitorEventType.EVENT || name != MonitorEventName.TASK_FINISHED) return null
        val resolvedSessionId = sessionId ?: return null
        val resolvedSequence = sequence ?: return null
        return "$resolvedSessionId|${taskId.orEmpty()}|$resolvedSequence"
    }
}

data class MonitorUiState(
    val snapshot: MonitorSnapshot = MonitorSnapshot(),
    /** Latest underlying aggregate state. Timed results live in [stateChange]. */
    val petState: PetState = PetState.OFFLINE,
    val stateChange: StateChangeUi? = null,
    val activity: ActivityVariation = ActivityVariation.BREATH,
    val message: String = "Waiting for Relay connection",
    val isConnected: Boolean = false,
    val controlsVisible: Boolean = false,
    val eventCount: Int = 0,
    /** Confirmed result retained until newer activity, independently of reminder expiry. */
    val recentSessionCompletion: RecentCompletion? = null,
    /** Local presentation route; it never changes the server-authoritative monitor snapshot. */
    val usagePageVisible: Boolean = false,
    /** Independent pending page; confirmed results remain visible for fifteen seconds. */
    val approvalReminder: ApprovalReminderUi? = null,
    /** Retained independently of aggregate Working and the visible session rows. */
    val approvals: List<ApprovalSummary> = emptyList(),
    val approvalDecisionsInFlight: Set<String> = emptySet(),
    val approvalDecisionErrors: Set<String> = emptySet(),
    val uncertainApprovalDecisions: Set<String> = emptySet(),
    /** Explicit question/input/native approval waits, independently of aggregate Working. */
    val userActions: List<AwaitingUserAction> = emptyList(),
)

data class StateChangeUi(
    val status: PetState,
    val remainingMs: Long,
    val completionName: String? = null,
    val strength: ReminderStrength = ReminderStrength.WEAK,
    val userAction: AwaitingUserAction? = null,
)

enum class ReminderStrength { STRONG, WEAK }

private fun MonitorPresentationState.withoutOrdinaryReminder(): MonitorPresentationState = copy(
    changeStatus = null, changeIdentity = null, changeSessionId = null, changeDeadlineMs = null,
    changeStrength = ReminderStrength.WEAK, completionName = null,
    sessionCompletionDeadlineMs = null,
)

class MonitorViewModel(
    private val client: MonitorClient,
    private val cuePlayer: ReminderCuePlayer,
    private val cueLedger: ReminderCueLedger,
    private val cueInstallationId: String?,
    private val monotonicClockMs: () -> Long,
) : ViewModel() {
    constructor(client: MonitorClient) : this(
        client, NoOpReminderCuePlayer, InMemoryReminderCueLedger(), null,
        { System.nanoTime() / 1_000_000L },
    )

    /** Keeps the original positional clock constructor available to existing callers. */
    constructor(client: MonitorClient, monotonicClockMs: () -> Long) : this(
        client, NoOpReminderCuePlayer, InMemoryReminderCueLedger(), null, monotonicClockMs,
    )

    private val _uiState = MutableStateFlow(MonitorUiState())
    val uiState: StateFlow<MonitorUiState> = _uiState.asStateFlow()
    private var presentationState = MonitorPresentationState()
    private var approvalState = ApprovalPresentationState()
    private var userActionState = UserActionPresentationState()
    private var presentationTimerJob: Job? = null
    private val sessionTitles = linkedMapOf<String, String>()

    init {
        viewModelScope.launch { client.events.collect(::handleEvent) }
        viewModelScope.launch {
            client.isConnected.collect { connected -> _uiState.update { it.copy(isConnected = connected) } }
        }
        presentationTimerJob = viewModelScope.launch {
            while (isActive) {
                refreshPresentationTimer()
                delay(100L)
            }
        }
        client.connect()
    }

    fun toggleControls() { _uiState.update { it.copy(controlsVisible = !it.controlsVisible) } }
    fun setControlsVisible(visible: Boolean) { _uiState.update { it.copy(controlsVisible = visible) } }
    fun reconnect() {
        client.disconnect()
        client.connect()
    }
    fun showUsagePage() { _uiState.update { it.copy(usagePageVisible = true, controlsVisible = false) } }
    fun showStatusPage() { _uiState.update { it.copy(usagePageVisible = false, controlsVisible = false) } }

    fun decideApproval(requestId: String, decision: ApprovalDecision) {
        val request = approvalState.requests[requestId] ?: return
        if (request.source != ApprovalSource.CLAUDE_CODE || !request.isPending || !request.canRespond || !client.isConnected.value ||
            requestId in approvalState.pendingDecisions) return
        if (decision == ApprovalDecision.ALLOW && approvalState.requests.values.count {
            it.isPending && it.sessionId == request.sessionId && it.toolName == request.toolName
        } > 1) return
        val decisionId = UUID.randomUUID().toString()
        approvalState = approvalState.copy(pendingDecisions = approvalState.pendingDecisions + (requestId to PendingApprovalDecision(decisionId, decision)),
            decisionErrors = approvalState.decisionErrors - requestId)
        client.send(MonitorCommand.DecideApproval(_uiState.value.snapshot.installationId, requestId, decisionId, decision))
        publishPresentation(monotonicClockMs())
    }

    fun retryApprovalDecision(requestId: String) {
        val original = approvalState.pendingDecisions[requestId] ?: return
        val request = approvalState.requests[requestId] ?: return
        if (request.source != ApprovalSource.CLAUDE_CODE || !request.isPending || !request.canRespond || !client.isConnected.value ||
            requestId !in approvalState.uncertainDecisions) return
        approvalState = approvalState.copy(uncertainDecisions = approvalState.uncertainDecisions - requestId)
        client.send(MonitorCommand.DecideApproval(_uiState.value.snapshot.installationId,
            requestId, original.decisionId, original.decision))
        publishPresentation(monotonicClockMs())
    }

    private fun handleEvent(event: MonitorEvent) {
        event.approvalDecisionAck?.let {
            approvalState = ApprovalPresentationReducer.acknowledge(approvalState, it)
            publishPresentation(monotonicClockMs())
            return
        }
        val previous = _uiState.value
        val resolvedTitle = if (
            event.type == MonitorEventType.EVENT &&
            event.name in setOf(MonitorEventName.TASK_FINISHED, MonitorEventName.APPROVAL_REQUESTED, MonitorEventName.WAITING) &&
            event.sessionTitle.isNullOrBlank()
        ) {
            event.sessionId?.let { sessionId ->
                event.snapshot?.sessions?.firstOrNull { it.sessionId == sessionId }?.title
                    ?.takeIf { it.isNotBlank() }
                    ?: sessionTitles[sessionId]
            }
        } else null
        // Older Relay task_finished envelopes omit the title. Reuse only the
        // title already known for this exact session.
        val presentationEvent = if (resolvedTitle != null) {
            event.copy(sessionTitle = resolvedTitle)
        } else event
        val nowMs = monotonicClockMs()
        val knownTaskIds = presentationState.activeTasks.mapValues { it.value.taskId }
        val knownTasks = presentationState.activeTasks
        val reduction = MonitorPresentationReducer.reduce(presentationState, presentationEvent, nowMs)
        presentationState = reduction.state
        if (!reduction.accepted) {
            publishPresentation(nowMs)
            return
        }
        processReminderCues(presentationEvent, previous.snapshot, knownTasks, nowMs)
        val wasPinned = approvalState.active != null
        userActionState = UserActionPresentationReducer.reduce(userActionState, presentationEvent, knownTaskIds)
        approvalState = ApprovalPresentationReducer.reduce(approvalState, presentationEvent, nowMs)
        playPendingApprovalCues(cueInstallationId ?: presentationEvent.snapshot?.installationId ?: previous.snapshot.installationId)
        if (wasPinned || approvalState.active != null) presentationState = presentationState.withoutOrdinaryReminder()

        presentationEvent.snapshot?.sessions?.forEach { rememberSessionTitle(it.sessionId, it.title) }
        if (presentationEvent.type == MonitorEventType.EVENT && presentationEvent.sessionId != null &&
            presentationEvent.name in setOf(
                MonitorEventName.SESSION_STARTED, MonitorEventName.SESSION_TITLE_UPDATED,
                MonitorEventName.TASK_STARTED, MonitorEventName.TASK_FINISHED,
            )
        ) {
            presentationEvent.sessionTitle?.let { rememberSessionTitle(presentationEvent.sessionId, it) }
        }

        val isNeutral = presentationEvent.name == MonitorEventName.SESSION_CLASSIFICATION_UPDATED ||
            (presentationEvent.type == MonitorEventType.EVENT &&
                presentationState.sessionKinds[presentationEvent.sessionId] == SessionKind.SUBAGENT)
        val isTitleUpdate = presentationEvent.type == MonitorEventType.EVENT &&
            presentationEvent.name == MonitorEventName.SESSION_TITLE_UPDATED
        val activityFromEvent = when {
            isTitleUpdate || isNeutral -> null
            presentationEvent.type == MonitorEventType.EVENT && presentationEvent.name != MonitorEventName.UNKNOWN -> presentationEvent.name.wireValue
            else -> presentationEvent.activity
        }
        val incomingSnapshot = presentationEvent.snapshot?.let { snapshot ->
            val highestSequence = listOfNotNull(snapshot.lastSequence, presentationEvent.sequence, previous.snapshot.lastSequence).maxOrNull() ?: 0L
            snapshot.copy(
                lastSequence = highestSequence,
                sessions = snapshot.sessions?.map { it.copy(sessionKind = presentationState.sessionKinds[it.sessionId] ?: it.sessionKind) },
                activity = if (isTitleUpdate || isNeutral) previous.snapshot.activity else activityFromEvent ?: snapshot.activity,
            )
        }
        val nextSnapshot = incomingSnapshot ?: previous.snapshot.copy(
            lastSequence = presentationEvent.sequence?.let { maxOf(previous.snapshot.lastSequence, it) } ?: previous.snapshot.lastSequence,
            activity = activityFromEvent ?: previous.snapshot.activity,
            updatedAt = presentationEvent.updatedAt.ifBlank { previous.snapshot.updatedAt },
        )
        val completion = when {
            isNeutral -> previous.snapshot.recentCompletion?.takeUnless {
                presentationState.sessionKinds[it.sessionId] == SessionKind.SUBAGENT
            }
            incomingSnapshot?.recentCompletion != null &&
                presentationState.sessionKinds[incomingSnapshot.recentCompletion.sessionId] != SessionKind.SUBAGENT -> incomingSnapshot.recentCompletion
            presentationEvent.type == MonitorEventType.EVENT && presentationEvent.name == MonitorEventName.TASK_FINISHED &&
                presentationEvent.sessionId != null && presentationEvent.sessionId != "unknown" &&
                presentationEvent.sequence != null -> RecentCompletion(
                sessionId = presentationEvent.sessionId,
                taskId = presentationEvent.taskId,
                sequence = presentationEvent.sequence,
                occurredAt = presentationEvent.occurredAt.ifBlank { presentationEvent.updatedAt },
                displayName = presentationEvent.sessionTitle ?: fallbackSessionTitle(presentationEvent.sessionId),
                durationMs = presentationEvent.durationMs.validTaskDuration(),
            )
            incomingSnapshot != null -> null
            else -> previous.snapshot.recentCompletion
        }
        val presentationSnapshot = nextSnapshot.copy(
            recentCompletion = completion,
            sessions = nextSnapshot.sessions?.map { it.copy(sessionKind = presentationState.sessionKinds[it.sessionId] ?: it.sessionKind) },
        )
        val activity = if (isTitleUpdate || isNeutral) previous.activity else {
            (activityFromEvent ?: nextSnapshot.activity ?: event.name.wireValue).toActivityVariation()
        }
        val detail = presentationEvent.detail.ifBlank { defaultMessage(presentationEvent, nextSnapshot) }
        _uiState.update { current ->
            current.copy(
                snapshot = presentationSnapshot,
                petState = presentationState.baseState,
                stateChange = presentationStateChange(nowMs),
                activity = activity,
                message = if (isNeutral) current.message else detail,
                isConnected = when (presentationEvent.type) {
                    MonitorEventType.CONNECTED -> true
                    MonitorEventType.DISCONNECTED -> false
                    else -> current.isConnected
                },
                eventCount = if (presentationEvent.type == MonitorEventType.CONNECTED || presentationEvent.type == MonitorEventType.DISCONNECTED) current.eventCount else current.eventCount + 1,
                recentSessionCompletion = presentationState.recentSessionCompletion,
                approvalReminder = ApprovalPresentationReducer.reminder(approvalState, nowMs),
                approvals = approvalState.requests.values.toList(),
                approvalDecisionsInFlight = approvalState.pendingDecisions.keys,
                approvalDecisionErrors = approvalState.decisionErrors,
                uncertainApprovalDecisions = approvalState.uncertainDecisions,
                userActions = userActionState.actions.values.sortedByDescending { it.sequence },
            )
        }
    }

    private fun processReminderCues(
        event: MonitorEvent,
        previousSnapshot: MonitorSnapshot,
        taskTimings: Map<String, TaskTiming>,
        nowMs: Long,
    ) {
        val installationId = cueInstallationId ?: event.snapshot?.installationId ?: previousSnapshot.installationId
        val liveFinish = event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_FINISHED
        val completion = event.snapshot?.recentCompletion?.takeUnless {
            presentationState.sessionKinds[it.sessionId] == SessionKind.SUBAGENT
        }
        val liveCompletion = if (liveFinish && !event.sessionId.isNullOrBlank() && event.sequence != null &&
            presentationState.sessionKinds[event.sessionId] != SessionKind.SUBAGENT
        ) RecentCompletion(
            sessionId = event.sessionId,
            taskId = event.taskId,
            sequence = event.sequence,
            occurredAt = event.occurredAt.ifBlank { event.updatedAt },
            displayName = "",
            durationMs = event.durationMs.validTaskDuration(),
        ) else null

        listOfNotNull(liveCompletion, completion).distinctBy { it.sessionId to it.sequence }.forEach { result ->
            val matchingSnapshot = completion?.takeIf {
                it.sessionId == result.sessionId && it.sequence == result.sequence &&
                    (it.taskId == null || result.taskId == null || it.taskId == result.taskId)
            }
            val duration = result.durationMs.validTaskDuration()
                ?: matchingSnapshot?.durationMs.validTaskDuration()
                ?: MonitorPresentationReducer.inferTaskDuration(
                    taskTimings, result.sessionId, result.taskId,
                    result.occurredAt, nowMs,
                )
            if (duration != null) {
                val key = "completion|$installationId|${result.sessionId}|${result.sequence}"
                val isFirstObservation = try { cueLedger.consumeIfNew(key) } catch (_: RuntimeException) { false }
                if (isFirstObservation && duration >= MonitorPresentationReducer.LONG_TASK_THRESHOLD_MS) {
                    try { cuePlayer.play(ReminderCue.LONG_TASK_COMPLETED) } catch (_: RuntimeException) { }
                }
            }
        }
    }

    private fun playPendingApprovalCues(installationId: String) {
        approvalState.requests.values.asSequence()
            .filter { it.isPending }
            .sortedWith(compareBy<ApprovalSummary> { it.sequence }.thenBy { it.requestId })
            .forEach { request ->
                val key = "approval|$installationId|${request.source.wireValue}|${request.requestId}"
                consumeAndPlay(key, ReminderCue.APPROVAL_PENDING)
            }
    }

    private fun consumeAndPlay(identity: String, cue: ReminderCue) {
        try {
            if (cueLedger.consumeIfNew(identity)) cuePlayer.play(cue)
        } catch (_: RuntimeException) {
            // Audio and persistence are best-effort side effects; monitor state must keep flowing.
        }
    }

    private fun refreshPresentationTimer() {
        val nowMs = monotonicClockMs()
        presentationState = MonitorPresentationReducer.expire(presentationState, nowMs)
        approvalState = ApprovalPresentationReducer.expire(approvalState, nowMs)
        if (approvalState.active != null) presentationState = presentationState.withoutOrdinaryReminder()
        publishPresentation(nowMs)
    }

    private fun publishPresentation(nowMs: Long) {
        // Publishing can be triggered by an ACK at the exact previous deadline.
        // Persist queue activation before the first frame so its timer cannot restart.
        approvalState = ApprovalPresentationReducer.expire(approvalState, nowMs)
        val change = presentationStateChange(nowMs)
        val approval = ApprovalPresentationReducer.reminder(approvalState, nowMs)
        _uiState.update { current ->
            if (current.petState == presentationState.baseState && current.stateChange == change &&
                current.recentSessionCompletion == presentationState.recentSessionCompletion &&
                current.approvalReminder == approval && current.approvals == approvalState.requests.values.toList() &&
                current.approvalDecisionsInFlight == approvalState.pendingDecisions.keys &&
                current.approvalDecisionErrors == approvalState.decisionErrors
                && current.uncertainApprovalDecisions == approvalState.uncertainDecisions &&
                current.userActions == userActionState.actions.values.sortedByDescending { it.sequence }
            ) current
            else current.copy(
                petState = presentationState.baseState,
                stateChange = change,
                recentSessionCompletion = presentationState.recentSessionCompletion,
                approvalReminder = approval,
                approvals = approvalState.requests.values.toList(),
                approvalDecisionsInFlight = approvalState.pendingDecisions.keys,
                approvalDecisionErrors = approvalState.decisionErrors,
                uncertainApprovalDecisions = approvalState.uncertainDecisions,
                userActions = userActionState.actions.values.sortedByDescending { it.sequence },
            )
        }
    }

    private fun presentationStateChange(nowMs: Long): StateChangeUi? {
        val change = MonitorPresentationReducer.stateChange(presentationState, nowMs) ?: return null
        return if (change.status == PetState.WAITING) {
            change.copy(userAction = userActionState.actions[presentationState.changeSessionId])
        } else change
    }

    private fun rememberSessionTitle(sessionId: String, title: String) {
        if (title.isBlank()) return
        sessionTitles.remove(sessionId)
        sessionTitles[sessionId] = title
        while (sessionTitles.size > 64) sessionTitles.remove(sessionTitles.keys.first())
    }

    private fun defaultMessage(event: MonitorEvent, snapshot: MonitorSnapshot): String = when {
        event.type == MonitorEventType.CONNECTED -> "Monitor connected"
        event.type == MonitorEventType.DISCONNECTED -> "Monitor disconnected"
        event.type == MonitorEventType.PROBE_RESULT -> "Probe ${event.probeLatencyMs?.let { "${it}ms" } ?: "received"}"
        event.name != MonitorEventName.UNKNOWN -> event.name.wireValue.replace('_', ' ')
        snapshot.updatedAt.isNotBlank() -> "Snapshot ${snapshot.updatedAt}"
        else -> "Awaiting monitor event"
    }

    override fun onCleared() {
        presentationTimerJob?.cancel()
        cuePlayer.close()
        client.disconnect()
        super.onCleared()
    }
}
