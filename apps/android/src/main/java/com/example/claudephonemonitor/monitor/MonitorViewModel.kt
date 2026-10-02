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

data class MonitorUiState(
    val snapshot: MonitorSnapshot = MonitorSnapshot(),
    val petState: PetState = PetState.IDLE,
    val activity: ActivityVariation = ActivityVariation.BREATH,
    val message: String = "Demo stream ready",
    val isConnected: Boolean = false,
    val isDemoMode: Boolean = true,
    val controlsVisible: Boolean = true,
    val overlayState: PetState? = null,
    val overlayRemainingMs: Long = 0L,
    val eventCount: Int = 0,
)

class MonitorViewModel(
    private val client: MonitorClient = MockMonitorClient(),
) : ViewModel() {
    private val _uiState = MutableStateFlow(MonitorUiState())
    val uiState: StateFlow<MonitorUiState> = _uiState.asStateFlow()

    private var overlayDeadlineMs: Long? = null
    private var overlayJob: Job? = null

    init {
        viewModelScope.launch {
            client.events.collect(::handleEvent)
        }
        viewModelScope.launch {
            client.isConnected.collect { connected ->
                _uiState.update { it.copy(isConnected = connected) }
            }
        }
        overlayJob = viewModelScope.launch {
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

    fun toggleDemoMode() {
        val enabled = !_uiState.value.isDemoMode
        _uiState.update { it.copy(isDemoMode = enabled) }
        client.send(MonitorCommand.SetDemoMode(enabled))
    }

    fun simulateFinish() {
        client.send(MonitorCommand.RequestFinish)
    }

    fun simulateError() {
        client.send(MonitorCommand.RequestError)
    }

    private fun handleEvent(event: MonitorEvent) {
        val previous = _uiState.value
        val incomingSnapshot = event.snapshot?.let { snapshot ->
            if (snapshot.lastSequence == 0L && event.sequence != null) {
                snapshot.copy(lastSequence = event.sequence)
            } else {
                snapshot
            }
        }
        val nextSnapshot = incomingSnapshot ?: previous.snapshot.copy(
            lastSequence = event.sequence ?: previous.snapshot.lastSequence,
            activity = event.activity ?: previous.snapshot.activity,
            updatedAt = event.updatedAt.ifBlank { previous.snapshot.updatedAt },
        )
        val stateFromEvent = when {
            event.type == MonitorEventType.EVENT && event.name != MonitorEventName.UNKNOWN ->
                event.name.toPetState()
            event.snapshot != null || event.type == MonitorEventType.SNAPSHOT ||
                event.type == MonitorEventType.PROBE_RESULT -> nextSnapshot.toPetState()
            else -> previous.petState
        }
        val activity = (event.activity ?: nextSnapshot.activity ?: event.name.wireValue)
            .toActivityVariation()
        val detail = event.detail.ifBlank { defaultMessage(event, nextSnapshot) }
        _uiState.update {
            it.copy(
                snapshot = nextSnapshot,
                petState = stateFromEvent,
                activity = activity,
                message = detail,
                isConnected = when (event.type) {
                    MonitorEventType.CONNECTED -> true
                    MonitorEventType.DISCONNECTED -> false
                    else -> it.isConnected
                },
                eventCount = if (event.type == MonitorEventType.CONNECTED ||
                    event.type == MonitorEventType.DISCONNECTED
                ) it.eventCount else it.eventCount + 1,
            )
        }
        when (event.name) {
            MonitorEventName.TASK_FINISHED -> beginOverlay(PetState.FINISH, 5_000L)
            MonitorEventName.TASK_FAILED,
            MonitorEventName.TOOL_FAILED -> beginOverlay(PetState.ERROR, 10_000L)
            else -> Unit
        }
    }

    private fun beginOverlay(state: PetState, durationMs: Long) {
        overlayDeadlineMs = System.currentTimeMillis() + durationMs
        _uiState.update {
            it.copy(
                petState = state,
                overlayState = state,
                overlayRemainingMs = durationMs,
            )
        }
    }

    private fun refreshOverlayTimer() {
        val deadline = overlayDeadlineMs ?: return
        val remaining = (deadline - System.currentTimeMillis()).coerceAtLeast(0L)
        if (remaining == 0L) {
            val finishedOverlay = _uiState.value.overlayState
            overlayDeadlineMs = null
            _uiState.update { state ->
                if (finishedOverlay == null || state.overlayState != finishedOverlay) {
                    state
                } else {
                    state.copy(
                        petState = state.snapshot.toPetState(),
                        overlayState = null,
                        overlayRemainingMs = 0L,
                        message = "Overlay complete",
                    )
                }
            }
        } else {
            _uiState.update { it.copy(overlayRemainingMs = remaining) }
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
        overlayJob?.cancel()
        client.disconnect()
        super.onCleared()
    }
}

private fun MonitorSnapshot.toPetState(): PetState = when {
    computerState == ComputerState.OFFLINE -> PetState.OFFLINE
    computerState == ComputerState.STALE -> PetState.WAITING
    claudeState == ClaudeState.WAITING -> PetState.WAITING
    claudeState == ClaudeState.WORKING -> PetState.WORKING
    else -> PetState.IDLE
}
