package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.claudephonemonitor.ui.ClawdPersona
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
    val persona: ClawdPersona = ClawdPersona.AUTO,
    val isSilentMode: Boolean = false,
    val message: String = "Ready",
    val isConnected: Boolean = false,
    val isDemoMode: Boolean = true,
    val controlsVisible: Boolean = false,
    val eventCount: Int = 0,
    val transitionRemainingMs: Long = 10_000L, // Show on initial launch and every switch for 10s
    val activeStateLabel: String = "IDLE",
)

class MonitorViewModel(
    private val client: MonitorClient = MockMonitorClient(),
) : ViewModel() {
    private val _uiState = MutableStateFlow(MonitorUiState())
    val uiState: StateFlow<MonitorUiState> = _uiState.asStateFlow()

    private var transitionDeadlineMs: Long = System.currentTimeMillis() + 10_000L
    private var timerJob: Job? = null

    init {
        viewModelScope.launch {
            client.events.collect(::handleEvent)
        }
        viewModelScope.launch {
            client.isConnected.collect { connected ->
                _uiState.update { it.copy(isConnected = connected) }
            }
        }
        timerJob = viewModelScope.launch {
            while (isActive) {
                refreshTransitionTimer()
                delay(100L)
            }
        }
        client.connect()
    }

    fun toggleControls() {
        _uiState.update { it.copy(controlsVisible = !it.controlsVisible) }
        triggerTransition(durationMs = 10_000L)
    }

    fun setControlsVisible(visible: Boolean) {
        _uiState.update { it.copy(controlsVisible = visible) }
    }

    fun selectPersona(persona: ClawdPersona) {
        _uiState.update { it.copy(persona = persona) }
        triggerTransition(durationMs = 10_000L)
    }

    fun toggleSilentMode() {
        val nextSilent = !_uiState.value.isSilentMode
        _uiState.update { it.copy(isSilentMode = nextSilent) }
        triggerTransition(
            label = if (nextSilent) "SLEEP" else _uiState.value.petState.title,
            durationMs = 10_000L,
        )
    }

    fun toggleDemoMode() {
        val enabled = !_uiState.value.isDemoMode
        _uiState.update { it.copy(isDemoMode = enabled) }
        client.send(MonitorCommand.SetDemoMode(enabled))
        triggerTransition(durationMs = 10_000L)
    }

    fun simulateFinish() {
        client.send(MonitorCommand.RequestFinish)
        triggerTransition(label = "FINISHED", durationMs = 10_000L)
    }

    fun simulateError() {
        client.send(MonitorCommand.RequestError)
        triggerTransition(label = "ERROR", durationMs = 10_000L)
    }

    fun triggerTransition(label: String? = null, durationMs: Long = 10_000L) {
        transitionDeadlineMs = System.currentTimeMillis() + durationMs
        _uiState.update { state ->
            val resolvedLabel = label ?: if (state.isSilentMode) "SLEEP" else state.petState.title
            state.copy(
                transitionRemainingMs = durationMs,
                activeStateLabel = resolvedLabel,
            )
        }
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

        val stateChanged = stateFromEvent != previous.petState || event.name == MonitorEventName.TASK_FINISHED ||
            event.name == MonitorEventName.TASK_FAILED || event.name == MonitorEventName.TOOL_FAILED

        val displayLabel = when {
            previous.isSilentMode -> "SLEEP"
            event.name == MonitorEventName.TASK_FINISHED -> "FINISHED"
            event.name == MonitorEventName.TASK_FAILED || event.name == MonitorEventName.TOOL_FAILED -> "ERROR"
            else -> stateFromEvent.title
        }

        if (stateChanged) {
            transitionDeadlineMs = System.currentTimeMillis() + 10_000L
        }

        _uiState.update {
            it.copy(
                snapshot = nextSnapshot,
                petState = stateFromEvent,
                activity = activity,
                message = detail,
                activeStateLabel = displayLabel,
                transitionRemainingMs = if (stateChanged) 10_000L else it.transitionRemainingMs,
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
    }

    private fun refreshTransitionTimer() {
        val remaining = (transitionDeadlineMs - System.currentTimeMillis()).coerceAtLeast(0L)
        if (_uiState.value.transitionRemainingMs != remaining) {
            _uiState.update { it.copy(transitionRemainingMs = remaining) }
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
        timerJob?.cancel()
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
