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
        val snapshotConfirmsCurrentFinish = current.changeStatus == PetState.FINISH &&
            current.changeDeadlineMs?.let { nowMs < it } == true &&
            (completion?.identity == current.changeIdentity ||
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

        var baseState = when {
            event.type == MonitorEventType.DISCONNECTED -> PetState.OFFLINE
            current.baseState == PetState.OFFLINE && event.snapshot == null -> PetState.OFFLINE
            outcome != null && current.baseState == PetState.WORKING -> PetState.WORKING
            outcome != null && current.baseState == PetState.OFFLINE -> PetState.OFFLINE
            outcome != null -> PetState.IDLE
            event.snapshot != null -> event.snapshot.toPetState()
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_STARTED -> PetState.WORKING
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.WAITING && current.baseState != PetState.WORKING -> PetState.WAITING
            else -> current.baseState
        }

        val disconnectChanged = event.type == MonitorEventType.DISCONNECTED &&
            current.hasSnapshot && current.baseState != PetState.OFFLINE
        val eventStatus = when {
            current.baseState == PetState.OFFLINE && event.snapshot == null -> null
            outcome != null -> outcome
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_STARTED && current.baseState != PetState.WORKING -> PetState.WORKING
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
            eventStatus != null && !(outcome != null && duplicateOutcome) && !suppressFinishTail -> true
            snapshotStatusChanged && !suppressFinishTail -> true
            else -> false
        }
        if (startsChange) {
            val status = when {
                disconnectChanged -> PetState.OFFLINE
                eventStatus != null -> eventStatus
                else -> baseState
            }
            val identity = if (status == PetState.FINISH) event.completionIdentity() ?: outcomeIdentity else outcomeIdentity
                ?: when {
                disconnectChanged -> "disconnect:${nowMs}"
                incomingSequence != null -> "snapshot:$incomingSequence:${status.name}"
                else -> "state:${status.name}:$nowMs"
            }
            changeStatus = status
            changeIdentity = identity
            changeDeadlineMs = nowMs + STATE_CHANGE_DURATION_MS
            completionName = if (status == PetState.FINISH) {
                event.sessionTitle?.takeIf { it.isNotBlank() }
                    ?: event.sessionId?.let { id -> event.snapshot?.sessions?.firstOrNull { it.sessionId == id }?.title }
                    ?: current.completionName?.takeIf { current.changeIdentity == identity }
                    ?: "未命名会话已完成"
            } else null
        } else if (snapshotConfirmsCurrentFinish && completion != null && completion.displayName.isNotBlank()) {
            // Fill in a better label within the existing local deadline; never restart it.
            completionName = completion.displayName
        }

        val state = current.copy(
            baseState = baseState,
            lastSequence = incomingSequence ?: current.lastSequence,
            hasSnapshot = current.hasSnapshot || event.snapshot != null,
            changeStatus = changeStatus,
            changeIdentity = changeIdentity,
            changeDeadlineMs = changeDeadlineMs,
            completionName = completionName,
            lastOutcomeIdentity = if (outcomeIdentity != null && !duplicateOutcome) outcomeIdentity else current.lastOutcomeIdentity,
            lastCompletionIdentity = event.completionIdentity() ?: completion?.identity ?: current.lastCompletionIdentity,
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

    fun expire(state: MonitorPresentationState, nowMs: Long): MonitorPresentationState =
        if (state.changeDeadlineMs?.let { nowMs >= it } == true) {
            state.copy(changeStatus = null, changeIdentity = null, changeDeadlineMs = null, completionName = null)
        } else state

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
    val completedDisplayName: String? = null,
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

    private fun handleEvent(event: MonitorEvent) {
        val previous = _uiState.value
        val resolvedTitle = if (
            event.type == MonitorEventType.EVENT &&
            event.name == MonitorEventName.TASK_FINISHED &&
            event.sessionTitle.isNullOrBlank()
        ) {
            event.sessionId?.let { sessionId ->
                previous.snapshot.sessions
                    ?.firstOrNull { it.sessionId == sessionId }
                    ?.title
                    ?.takeIf { it.isNotBlank() }
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
                displayName = presentationEvent.sessionTitle ?: "未命名会话已完成",
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
                completedDisplayName = completion?.displayName ?: current.completedDisplayName,
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
            if (current.petState == presentationState.baseState && current.stateChange == change) current
            else current.copy(petState = presentationState.baseState, stateChange = change)
        }
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

private fun MonitorSnapshot.toPetState(): PetState = when {
    computerState == ComputerState.OFFLINE -> PetState.OFFLINE
    sessions?.any { it.claudeState == ClaudeState.WORKING } == true -> PetState.WORKING
    claudeState == ClaudeState.WORKING || runningCount?.let { it > 0 } == true -> PetState.WORKING
    computerState == ComputerState.STALE -> PetState.WAITING
    claudeState == ClaudeState.WAITING -> PetState.WAITING
    else -> PetState.IDLE
}
