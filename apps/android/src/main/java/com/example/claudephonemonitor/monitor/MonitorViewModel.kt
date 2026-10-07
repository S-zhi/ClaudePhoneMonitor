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

/** Presentation state is independent of Android lifecycle and uses monotonic milliseconds. */
internal data class MonitorPresentationState(
    val baseState: PetState = PetState.OFFLINE,
    val lastSequence: Long? = null,
    val hasSnapshot: Boolean = false,
    val changeStatus: PetState? = null,
    val changeIdentity: String? = null,
    val changeDeadlineMs: Long? = null,
    val completionName: String? = null,
    val recentSessionCompletion: RecentCompletion? = null,
    val sessionCompletionDeadlineMs: Long? = null,
    val lastOutcomeIdentity: String? = null,
    val lastCompletionIdentity: String? = null,
    val finishTailSequence: Long? = null,
    val workingSessionIds: Set<String>? = null,
)

internal data class MonitorPresentationReduction(
    val state: MonitorPresentationState,
    val accepted: Boolean,
)

/** Reducer for the underlying aggregate state and its independent 15 second change page. */
internal object MonitorPresentationReducer {
    const val STATE_CHANGE_DURATION_MS = 15_000L

    fun reduce(
        state: MonitorPresentationState,
        event: MonitorEvent,
        nowMs: Long,
    ): MonitorPresentationReduction {
        val current = expire(state, nowMs)
        val incomingSequence = event.sequenceWatermark()
        val atOrBehindSequence = incomingSequence != null &&
            current.lastSequence?.let { incomingSequence <= it } == true
        val equalSequenceSnapshotRefresh = event.type != MonitorEventType.EVENT &&
            event.snapshot != null && incomingSequence != null &&
            incomingSequence == current.lastSequence
        if (event.type != MonitorEventType.DISCONNECTED && atOrBehindSequence && !equalSequenceSnapshotRefresh) {
            return MonitorPresentationReduction(current, accepted = false)
        }

        val outcome = event.outcomeState()
        val outcomeIdentity = event.outcomeIdentity()
        val duplicateOutcome = outcomeIdentity != null && outcomeIdentity == current.lastOutcomeIdentity
        val completion = event.snapshot?.recentCompletion
        val matchingEventCompletion = completion?.takeIf {
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_FINISHED &&
                it.sessionId == event.sessionId && it.sequence == event.sequence &&
                (it.taskId == null || event.taskId == null || it.taskId == event.taskId)
        }?.let { it.copy(taskId = it.taskId ?: event.taskId) }
        val matchingCompletion = completion?.takeIf {
            it.matchesCompletion(current.recentSessionCompletion)
        }?.let { it.copy(taskId = it.taskId ?: current.recentSessionCompletion?.taskId) }
        val snapshotConfirmsCurrentFinish = current.changeStatus == PetState.FINISH &&
            current.changeDeadlineMs?.let { nowMs < it } == true &&
            (matchingCompletion != null || completion?.identity == current.changeIdentity ||
                (event.snapshot?.activity == MonitorEventName.TASK_FINISHED.wireValue &&
                    incomingSequence != null && incomingSequence == current.lastSequence))
        val activeFinishParts = current.changeIdentity?.split('|')
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
            event.snapshot != null -> event.snapshot.aggregatePetState()
            outcome != null && current.baseState == PetState.WORKING -> PetState.WORKING
            outcome != null && current.baseState == PetState.OFFLINE -> PetState.OFFLINE
            outcome != null -> PetState.IDLE
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_STARTED -> PetState.WORKING
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
        val eventStatus = when {
            current.baseState == PetState.OFFLINE && event.snapshot == null -> null
            outcome != null -> outcome
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_STARTED &&
                (current.baseState != PetState.WORKING ||
                    (current.changeStatus == PetState.FINISH && activeFinishParts?.getOrNull(0) == event.sessionId)) -> PetState.WORKING
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.WAITING && current.baseState !in setOf(PetState.WORKING, PetState.WAITING) -> PetState.WAITING
            else -> null
        }
        val snapshotStatusChanged = event.snapshot != null && current.hasSnapshot &&
            baseState != current.baseState
        val suppressFinishTail = snapshotConfirmsCurrentFinish || toolFinishedClosesCurrentFinish || matchingFinishTailSnapshot

        var changeStatus = current.changeStatus
        var changeIdentity = current.changeIdentity
        var changeDeadlineMs = current.changeDeadlineMs
        var completionName = current.completionName
        val startsChange = when {
            disconnectChanged -> true
            newSnapshotCompletion != null -> true
            eventStatus != null && !(outcome != null && duplicateOutcome) && !suppressFinishTail -> true
            snapshotStatusChanged && !suppressFinishTail -> true
            else -> false
        }
        if (startsChange) {
            val status = when {
                disconnectChanged -> PetState.OFFLINE
                newSnapshotCompletion != null -> PetState.FINISH
                eventStatus != null -> eventStatus
                else -> baseState
            }
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
            changeDeadlineMs = nowMs + STATE_CHANGE_DURATION_MS
            completionName = if (status == PetState.FINISH) {
                newSnapshotCompletion?.displayName?.takeIf { it.isNotBlank() }
                    ?: matchingEventCompletion?.displayName?.takeIf { it.isNotBlank() }
                    ?: event.sessionTitle?.takeIf { it.isNotBlank() }
                    ?: event.sessionId?.let { id -> event.snapshot?.sessions?.firstOrNull { it.sessionId == id }?.title }
                    ?: current.completionName?.takeIf { current.changeIdentity == identity }
                    ?: event.sessionId?.let(::fallbackSessionTitle)
                    ?: "未命名会话"
            } else null
        } else if (current.changeStatus == PetState.FINISH && matchingCompletion != null &&
            matchingCompletion.displayName.isNotBlank()
        ) {
            // Fill in a better label within the existing local deadline; never restart it.
            completionName = matchingCompletion.displayName
            changeIdentity = matchingCompletion.identity
        }

        var recentSessionCompletion = current.recentSessionCompletion
        var sessionCompletionDeadlineMs = current.sessionCompletionDeadlineMs
        if (startsChange && changeStatus == PetState.FINISH && newSnapshotCompletion != null) {
            recentSessionCompletion = newSnapshotCompletion
            sessionCompletionDeadlineMs = nowMs + STATE_CHANGE_DURATION_MS
        } else if (startsChange && changeStatus == PetState.FINISH && event.sessionId != null && event.sequence != null) {
            recentSessionCompletion = matchingEventCompletion ?: RecentCompletion(
                sessionId = event.sessionId,
                taskId = event.taskId,
                sequence = event.sequence,
                occurredAt = event.occurredAt.ifBlank { event.updatedAt },
                displayName = requireNotNull(completionName),
            )
            sessionCompletionDeadlineMs = nowMs + STATE_CHANGE_DURATION_MS
        } else if (matchingCompletion != null) {
            recentSessionCompletion = matchingCompletion
        }
        val completedSession = recentSessionCompletion?.let { result ->
            event.snapshot?.sessions?.firstOrNull { it.sessionId == result.sessionId }
        }
        val completedSessionRestarted = event.type == MonitorEventType.EVENT &&
            (event.name == MonitorEventName.TASK_STARTED || event.name == MonitorEventName.SESSION_STARTED) &&
            event.sessionId == recentSessionCompletion?.sessionId
        val snapshotShowsRestart = completedSession != null && completedSession.claudeState != ClaudeState.IDLE &&
            completedSession.lastActivitySequence > (recentSessionCompletion?.sequence ?: Long.MAX_VALUE)
        val snapshotRenamedSession = completedSession != null &&
            completedSession.lastActivitySequence > (recentSessionCompletion?.sequence ?: Long.MAX_VALUE) &&
            completedSession.title != recentSessionCompletion?.displayName && event.snapshot?.recentCompletion == null
        val lastCompletionIdentity = recentSessionCompletion?.identity ?: current.lastCompletionIdentity
        if (event.type == MonitorEventType.DISCONNECTED || completedSessionRestarted || snapshotShowsRestart || snapshotRenamedSession) {
            recentSessionCompletion = null
            sessionCompletionDeadlineMs = null
        }

        val state = current.copy(
            baseState = baseState,
            lastSequence = incomingSequence ?: current.lastSequence,
            hasSnapshot = current.hasSnapshot || event.snapshot != null,
            changeStatus = changeStatus,
            changeIdentity = changeIdentity,
            changeDeadlineMs = changeDeadlineMs,
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
                snapshot.sessions?.filter { it.claudeState == ClaudeState.WORKING }
                    ?.mapTo(linkedSetOf()) { it.sessionId }
            } ?: if (event.snapshot != null) null else current.workingSessionIds,
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
            changeDeadlineMs = if (changeExpired) null else state.changeDeadlineMs,
            completionName = if (changeExpired) null else state.completionName,
            recentSessionCompletion = if (completionExpired) null else state.recentSessionCompletion,
            sessionCompletionDeadlineMs = if (completionExpired) null else state.sessionCompletionDeadlineMs,
        )
    }

    fun stateChange(state: MonitorPresentationState, nowMs: Long): StateChangeUi? {
        val current = expire(state, nowMs)
        val status = current.changeStatus ?: return null
        val remaining = (current.changeDeadlineMs ?: return null) - nowMs
        return if (remaining > 0L) StateChangeUi(status, remaining, current.completionName) else null
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
    /** Identity-bound local result, retained for 15 seconds even after Relay clears its result. */
    val recentSessionCompletion: RecentCompletion? = null,
    /** Local presentation route; it never changes the server-authoritative monitor snapshot. */
    val usagePageVisible: Boolean = false,
)

data class StateChangeUi(
    val status: PetState,
    val remainingMs: Long,
    val completionName: String? = null,
)

class MonitorViewModel(
    private val client: MonitorClient,
    private val monotonicClockMs: () -> Long = { System.nanoTime() / 1_000_000L },
) : ViewModel() {
    private val _uiState = MutableStateFlow(MonitorUiState())
    val uiState: StateFlow<MonitorUiState> = _uiState.asStateFlow()
    private var presentationState = MonitorPresentationState()
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

    private fun handleEvent(event: MonitorEvent) {
        val previous = _uiState.value
        val resolvedTitle = if (
            event.type == MonitorEventType.EVENT &&
            event.name == MonitorEventName.TASK_FINISHED &&
            event.sessionTitle.isNullOrBlank()
        ) {
            event.sessionId?.let { sessionId ->
                event.snapshot?.sessions?.firstOrNull { it.sessionId == sessionId }?.title
                    ?.takeIf { it.isNotBlank() }
                    ?: sessionTitles[sessionId]
            }
        } else null
        // Relay task_finished envelopes do not carry a title. Reuse only the
        // title from the authoritative snapshot for this exact session.
        val presentationEvent = if (resolvedTitle != null) {
            event.copy(sessionTitle = resolvedTitle)
        } else event
        val nowMs = monotonicClockMs()
        val reduction = MonitorPresentationReducer.reduce(presentationState, presentationEvent, nowMs)
        presentationState = reduction.state
        if (!reduction.accepted) {
            publishPresentation(nowMs)
            return
        }

        presentationEvent.snapshot?.sessions?.forEach { rememberSessionTitle(it.sessionId, it.title) }
        if (presentationEvent.name == MonitorEventName.SESSION_STARTED && presentationEvent.sessionId != null) {
            presentationEvent.sessionTitle?.let { rememberSessionTitle(presentationEvent.sessionId, it) }
        }

        val activityFromEvent = if (presentationEvent.type == MonitorEventType.EVENT && presentationEvent.name != MonitorEventName.UNKNOWN) {
            presentationEvent.name.wireValue
        } else presentationEvent.activity
        val incomingSnapshot = presentationEvent.snapshot?.let { snapshot ->
            val highestSequence = listOfNotNull(snapshot.lastSequence, presentationEvent.sequence, previous.snapshot.lastSequence).maxOrNull() ?: 0L
            snapshot.copy(lastSequence = highestSequence, activity = activityFromEvent ?: snapshot.activity)
        }
        val nextSnapshot = incomingSnapshot ?: previous.snapshot.copy(
            lastSequence = presentationEvent.sequence?.let { maxOf(previous.snapshot.lastSequence, it) } ?: previous.snapshot.lastSequence,
            activity = activityFromEvent ?: previous.snapshot.activity,
            updatedAt = presentationEvent.updatedAt.ifBlank { previous.snapshot.updatedAt },
        )
        val completion = when {
            incomingSnapshot?.recentCompletion != null -> incomingSnapshot.recentCompletion
            presentationEvent.type == MonitorEventType.EVENT && presentationEvent.name == MonitorEventName.TASK_FINISHED &&
                presentationEvent.sessionId != null && presentationEvent.sequence != null -> RecentCompletion(
                sessionId = presentationEvent.sessionId,
                taskId = presentationEvent.taskId,
                sequence = presentationEvent.sequence,
                occurredAt = presentationEvent.occurredAt.ifBlank { presentationEvent.updatedAt },
                displayName = presentationEvent.sessionTitle ?: fallbackSessionTitle(presentationEvent.sessionId),
            )
            incomingSnapshot != null -> null
            else -> previous.snapshot.recentCompletion
        }
        val presentationSnapshot = nextSnapshot.copy(recentCompletion = completion)
        val activity = (activityFromEvent ?: nextSnapshot.activity ?: event.name.wireValue).toActivityVariation()
        val detail = presentationEvent.detail.ifBlank { defaultMessage(presentationEvent, nextSnapshot) }
        _uiState.update { current ->
            current.copy(
                snapshot = presentationSnapshot,
                petState = presentationState.baseState,
                stateChange = MonitorPresentationReducer.stateChange(presentationState, nowMs),
                activity = activity,
                message = detail,
                isConnected = when (presentationEvent.type) {
                    MonitorEventType.CONNECTED -> true
                    MonitorEventType.DISCONNECTED -> false
                    else -> current.isConnected
                },
                eventCount = if (presentationEvent.type == MonitorEventType.CONNECTED || presentationEvent.type == MonitorEventType.DISCONNECTED) current.eventCount else current.eventCount + 1,
                recentSessionCompletion = presentationState.recentSessionCompletion,
            )
        }
    }

    private fun refreshPresentationTimer() {
        val nowMs = monotonicClockMs()
        presentationState = MonitorPresentationReducer.expire(presentationState, nowMs)
        publishPresentation(nowMs)
    }

    private fun publishPresentation(nowMs: Long) {
        val change = MonitorPresentationReducer.stateChange(presentationState, nowMs)
        _uiState.update { current ->
            if (current.petState == presentationState.baseState && current.stateChange == change &&
                current.recentSessionCompletion == presentationState.recentSessionCompletion
            ) current
            else current.copy(
                petState = presentationState.baseState,
                stateChange = change,
                recentSessionCompletion = presentationState.recentSessionCompletion,
            )
        }
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
        client.disconnect()
        super.onCleared()
    }
}
