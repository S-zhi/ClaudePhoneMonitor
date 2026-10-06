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

/** The presentation state independent of the Android lifecycle and wall clock. */
internal data class MonitorPresentationState(
    val baseState: PetState = PetState.OFFLINE,
    val lastSequence: Long? = null,
    val overlayState: PetState? = null,
    val overlayDeadlineMs: Long? = null,
    val activeStateLabel: String? = null,
    val stateLabelDeadlineMs: Long? = null,
    val lastCompletionIdentity: String? = null,
    val workingSessionIds: Set<String>? = null,
)

internal data class MonitorPresentationReduction(
    val state: MonitorPresentationState,
    val accepted: Boolean,
)

/** Pure state transitions make replay and overlay timing deterministic in JVM tests. */
internal object MonitorPresentationReducer {
    const val FINISH_DURATION_MS = 5_000L
    const val ERROR_DURATION_MS = 10_000L
    private const val STATE_LABEL_DURATION_MS = 2_500L

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
        if (atOrBehindSequence && !equalSequenceSnapshotRefresh) {
            return MonitorPresentationReduction(current, accepted = false)
        }

        val outcomeState = event.outcomeState()
        val baseState = when {
            event.type == MonitorEventType.DISCONNECTED -> PetState.OFFLINE
            // A new snapshot's aggregate state covers every active session, while the list only
            // contains the Top 5. Keep aggregate Working until Relay's next authoritative snapshot
            // settles whether the completion ended the final running session.
            outcomeState != null && current.baseState == PetState.WORKING &&
                current.workingSessionIds != null -> {
                PetState.WORKING
            }
            outcomeState != null && current.baseState == PetState.OFFLINE -> {
                PetState.OFFLINE
            }
            outcomeState != null -> {
                PetState.IDLE
            }
            event.snapshot != null || event.type == MonitorEventType.SNAPSHOT ||
                event.type == MonitorEventType.PROBE_RESULT -> event.snapshot?.toPetState() ?: current.baseState
            event.type == MonitorEventType.EVENT && event.name != MonitorEventName.UNKNOWN ->
                event.name.toPetState()
            else -> current.baseState
        }

        val nextOverlayState = outcomeState ?: current.overlayState
        val nextOverlayDeadlineMs = outcomeState?.let { nowMs + it.overlayDurationMs() }
            ?: current.overlayDeadlineMs
        val labelChangedByOutcome = outcomeState != null
        val labelChangedByBase = !labelChangedByOutcome && current.overlayState == null &&
            baseState != current.baseState
        val nextLabel = when {
            labelChangedByOutcome -> outcomeState?.title
            labelChangedByBase -> baseState.title
            else -> current.activeStateLabel
        }
        val nextLabelDeadlineMs = when {
            labelChangedByOutcome -> nextOverlayDeadlineMs
            labelChangedByBase -> nowMs + STATE_LABEL_DURATION_MS
            else -> current.stateLabelDeadlineMs
        }

        return MonitorPresentationReduction(
            state = current.copy(
                baseState = baseState,
                lastSequence = incomingSequence ?: current.lastSequence,
                overlayState = nextOverlayState,
                overlayDeadlineMs = nextOverlayDeadlineMs,
                activeStateLabel = nextLabel,
                stateLabelDeadlineMs = nextLabelDeadlineMs,
                lastCompletionIdentity = event.completionIdentity() ?: current.lastCompletionIdentity,
                workingSessionIds = event.snapshot?.let { snapshot ->
                    snapshot.sessions?.filter { it.claudeState == ClaudeState.WORKING }
                        ?.mapTo(linkedSetOf()) { it.sessionId }
                } ?: if (event.snapshot != null) null else current.workingSessionIds,
            ),
            accepted = true,
        )
    }

    fun expire(state: MonitorPresentationState, nowMs: Long): MonitorPresentationState {
        val overlayExpired = state.overlayDeadlineMs?.let { nowMs >= it } == true
        val labelExpired = state.stateLabelDeadlineMs?.let { nowMs >= it } == true
        if (!overlayExpired && !labelExpired) return state

        return state.copy(
            overlayState = if (overlayExpired) null else state.overlayState,
            overlayDeadlineMs = if (overlayExpired) null else state.overlayDeadlineMs,
            activeStateLabel = if (overlayExpired || labelExpired) null else state.activeStateLabel,
            stateLabelDeadlineMs = if (overlayExpired || labelExpired) null else state.stateLabelDeadlineMs,
        )
    }

    fun effectivePetState(state: MonitorPresentationState, nowMs: Long): PetState {
        val current = expire(state, nowMs)
        return when (current.baseState) {
            PetState.OFFLINE, PetState.WORKING -> current.baseState
            else -> current.overlayState ?: current.baseState
        }
    }

    fun visibleOverlayState(state: MonitorPresentationState, nowMs: Long): PetState? {
        val current = expire(state, nowMs)
        return current.overlayState.takeUnless {
            current.baseState == PetState.OFFLINE || current.baseState == PetState.WORKING
        }
    }

    fun overlayRemainingMs(state: MonitorPresentationState, nowMs: Long): Long =
        state.overlayDeadlineMs?.let { (it - nowMs).coerceAtLeast(0L) } ?: 0L

    fun transitionRemainingMs(state: MonitorPresentationState, nowMs: Long): Long =
        (state.stateLabelDeadlineMs ?: state.overlayDeadlineMs)
            ?.let { (it - nowMs).coerceAtLeast(0L) }
            ?: 0L

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

    private fun MonitorEvent.completionIdentity(): String? {
        if (type != MonitorEventType.EVENT || name != MonitorEventName.TASK_FINISHED) return null
        val resolvedSessionId = sessionId ?: return null
        val resolvedSequence = sequence ?: return null
        return "$resolvedSessionId|${taskId.orEmpty()}|$resolvedSequence"
    }

    private fun PetState.overlayDurationMs(): Long = when (this) {
        PetState.FINISH -> FINISH_DURATION_MS
        PetState.ERROR -> ERROR_DURATION_MS
        else -> 0L
    }
}

data class MonitorUiState(
    val snapshot: MonitorSnapshot = MonitorSnapshot(),
    val petState: PetState = PetState.OFFLINE,
    val activity: ActivityVariation = ActivityVariation.BREATH,
    val message: String = "Waiting for Relay connection",
    val isConnected: Boolean = false,
    val controlsVisible: Boolean = false,
    val overlayState: PetState? = null,
    val overlayRemainingMs: Long = 0L,
    val eventCount: Int = 0,
    val completedDisplayName: String? = null,
)

class MonitorViewModel(
    private val client: MonitorClient,
) : ViewModel() {
    private val _uiState = MutableStateFlow(MonitorUiState())
    val uiState: StateFlow<MonitorUiState> = _uiState.asStateFlow()

    private var presentationState = MonitorPresentationState()
    private var presentationTimerJob: Job? = null

    init {
        viewModelScope.launch {
            client.events.collect(::handleEvent)
        }
        viewModelScope.launch {
            client.isConnected.collect { connected ->
                _uiState.update { it.copy(isConnected = connected) }
            }
        }
        presentationTimerJob = viewModelScope.launch {
            while (isActive) {
                refreshOverlayTimer()
                delay(100L)
            }
        }
        client.connect()
    }

    fun toggleControls() {
        _uiState.update { it.copy(controlsVisible = !it.controlsVisible) }
    }

    fun setControlsVisible(visible: Boolean) {
        _uiState.update { it.copy(controlsVisible = visible) }
    }

    private fun handleEvent(event: MonitorEvent) {
        val previous = _uiState.value
        val nowMs = monotonicTimeMs()
        val reduction = MonitorPresentationReducer.reduce(presentationState, event, nowMs)
        presentationState = reduction.state
        if (!reduction.accepted) {
            publishPresentation(nowMs)
            return
        }

        val activityFromEvent = if (
            event.type == MonitorEventType.EVENT && event.name != MonitorEventName.UNKNOWN
        ) {
            event.name.wireValue
        } else {
            event.activity
        }
        val incomingSnapshot = event.snapshot?.let { snapshot ->
            val highestSequence = listOfNotNull(
                snapshot.lastSequence,
                event.sequence,
                previous.snapshot.lastSequence,
            ).maxOrNull() ?: 0L
            snapshot.copy(
                lastSequence = highestSequence,
                activity = activityFromEvent ?: snapshot.activity,
            )
        }
        val nextSnapshot = incomingSnapshot ?: previous.snapshot.copy(
            lastSequence = event.sequence?.let { maxOf(previous.snapshot.lastSequence, it) }
                ?: previous.snapshot.lastSequence,
            activity = activityFromEvent ?: previous.snapshot.activity,
            updatedAt = event.updatedAt.ifBlank { previous.snapshot.updatedAt },
        )
        val completion = when {
            incomingSnapshot?.recentCompletion != null -> incomingSnapshot.recentCompletion
            event.type == MonitorEventType.EVENT && event.name == MonitorEventName.TASK_FINISHED &&
                reduction.state.lastCompletionIdentity != previous.snapshot.recentCompletion?.identity -> {
                val id = event.sessionId
                val sequence = event.sequence
                if (id != null && sequence != null) RecentCompletion(
                    sessionId = id,
                    taskId = event.taskId,
                    sequence = sequence,
                    occurredAt = event.occurredAt.ifBlank { event.updatedAt },
                    displayName = event.sessionTitle ?: "未命名会话已完成",
                ) else null
            }
            incomingSnapshot != null -> null
            else -> previous.snapshot.recentCompletion
        }
        val presentationSnapshot = nextSnapshot.copy(recentCompletion = completion)
        val activity = (activityFromEvent ?: nextSnapshot.activity ?: event.name.wireValue)
            .toActivityVariation()
        val detail = event.detail.ifBlank { defaultMessage(event, nextSnapshot) }
        val visibleOverlay = MonitorPresentationReducer.visibleOverlayState(presentationState, nowMs)
        _uiState.update {
            it.copy(
                snapshot = presentationSnapshot,
                petState = MonitorPresentationReducer.effectivePetState(presentationState, nowMs),
                activity = activity,
                message = detail,
                isConnected = when (event.type) {
                    MonitorEventType.CONNECTED -> true
                    MonitorEventType.DISCONNECTED -> false
                    else -> it.isConnected
                },
                overlayState = visibleOverlay,
                overlayRemainingMs = MonitorPresentationReducer.overlayRemainingMs(presentationState, nowMs),
                eventCount = if (event.type == MonitorEventType.CONNECTED ||
                    event.type == MonitorEventType.DISCONNECTED
                ) it.eventCount else it.eventCount + 1,
            )
        }
    }

    private fun refreshOverlayTimer() {
        val nowMs = monotonicTimeMs()
        presentationState = MonitorPresentationReducer.expire(presentationState, nowMs)
        publishPresentation(nowMs)
    }

    private fun publishPresentation(nowMs: Long) {
        val visibleOverlay = MonitorPresentationReducer.visibleOverlayState(presentationState, nowMs)
        val petState = MonitorPresentationReducer.effectivePetState(presentationState, nowMs)
        val remainingMs = MonitorPresentationReducer.overlayRemainingMs(presentationState, nowMs)
        _uiState.update { current ->
            if (current.petState == petState && current.overlayState == visibleOverlay &&
                current.overlayRemainingMs == remainingMs
            ) {
                current
            } else {
                current.copy(
                    petState = petState,
                    overlayState = visibleOverlay,
                    overlayRemainingMs = remainingMs,
                )
            }
        }
    }

    private fun defaultMessage(event: MonitorEvent, snapshot: MonitorSnapshot): String = when {
        event.type == MonitorEventType.CONNECTED -> "Monitor connected"
        event.type == MonitorEventType.DISCONNECTED -> "Monitor disconnected"
        event.type == MonitorEventType.PROBE_RESULT ->
            "Probe ${event.probeLatencyMs?.let { "${it}ms" } ?: "received"}"
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
    claudeState == ClaudeState.WORKING -> PetState.WORKING
    computerState == ComputerState.STALE -> PetState.WAITING
    claudeState == ClaudeState.WAITING -> PetState.WAITING
    else -> PetState.IDLE
}

private fun monotonicTimeMs(): Long = System.nanoTime() / 1_000_000L
