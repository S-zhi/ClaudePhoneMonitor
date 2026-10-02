package com.example.claudephonemonitor.monitor

import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MockMonitorClient : MonitorClient {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val eventFlow = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 32)
    private val connectionState = MutableStateFlow(false)
    private var demoJob: Job? = null
    private var demoEnabled = true
    private var sequence = 0L
    private var snapshot = MonitorSnapshot()

    override val events: Flow<MonitorEvent> = eventFlow.asSharedFlow()
    override val isConnected = connectionState

    override fun connect() {
        if (connectionState.value) return
        connectionState.value = true
        eventFlow.tryEmit(MonitorEvent(type = MonitorEventType.CONNECTED))
        startDemoIfNeeded()
    }

    override fun disconnect() {
        demoJob?.cancel()
        demoJob = null
        connectionState.value = false
        eventFlow.tryEmit(MonitorEvent(type = MonitorEventType.DISCONNECTED))
    }

    override fun send(command: MonitorCommand) {
        when (command) {
            is MonitorCommand.SetDemoMode -> {
                demoEnabled = command.enabled
                if (demoEnabled) {
                    startDemoIfNeeded()
                } else {
                    demoJob?.cancel()
                    demoJob = null
                    eventFlow.tryEmit(
                        MonitorEvent(
                            type = MonitorEventType.EVENT,
                            detail = "Demo stream paused",
                        ),
                    )
                }
            }

            MonitorCommand.RequestFinish -> emitDemoEvent(MonitorEventName.TASK_FINISHED)
            MonitorCommand.RequestError -> emitDemoEvent(MonitorEventName.TASK_FAILED)
            is MonitorCommand.Hello,
            is MonitorCommand.Subscribe -> Unit
        }
    }

    private fun startDemoIfNeeded() {
        if (!connectionState.value || !demoEnabled || demoJob?.isActive == true) return
        demoJob = scope.launch {
            val steps = listOf(
                DemoStep(MonitorEventName.SESSION_STARTED, ClaudeState.WORKING, "booting session", 2_200L),
                DemoStep(MonitorEventName.TASK_STARTED, ClaudeState.WORKING, "planning next action", 2_600L),
                DemoStep(MonitorEventName.TOOL_STARTED, ClaudeState.WORKING, "running tool", 2_900L),
                DemoStep(MonitorEventName.TOOL_FINISHED, ClaudeState.WORKING, "tool returned", 2_000L),
                DemoStep(MonitorEventName.WAITING, ClaudeState.WAITING, "waiting for input", 2_700L),
                DemoStep(MonitorEventName.TASK_FINISHED, ClaudeState.IDLE, "task complete", 6_200L),
                DemoStep(MonitorEventName.TASK_FAILED, ClaudeState.IDLE, "task failed", 11_200L),
                DemoStep(MonitorEventName.SESSION_ENDED, ClaudeState.IDLE, "session ended", 3_200L),
            )
            var index = 0
            while (isActive && connectionState.value && demoEnabled) {
                val step = steps[index % steps.size]
                emitDemoEvent(step.name, step.claudeState, step.detail)
                delay(step.durationMs)
                index += 1
            }
        }
    }

    private fun emitDemoEvent(
        name: MonitorEventName,
        claudeState: ClaudeState = snapshot.claudeState,
        detail: String = name.wireValue.replace('_', ' '),
    ) {
        sequence += 1
        val nextSnapshot = snapshot.copy(
            claudeState = claudeState,
            activity = activityFor(name),
            lastSequence = sequence,
            updatedAt = Instant.now().toString(),
        )
        snapshot = nextSnapshot
        eventFlow.tryEmit(
            MonitorEvent(
                type = MonitorEventType.EVENT,
                name = name,
                snapshot = nextSnapshot,
                sequence = sequence,
                activity = nextSnapshot.activity,
                detail = detail,
                updatedAt = nextSnapshot.updatedAt,
            ),
        )
    }

    private fun activityFor(name: MonitorEventName): String = when (name) {
        MonitorEventName.SESSION_STARTED,
        MonitorEventName.TASK_STARTED -> ActivityVariation.THINK.wireValue
        MonitorEventName.TOOL_STARTED,
        MonitorEventName.TOOL_FINISHED -> ActivityVariation.TOOL.wireValue
        MonitorEventName.WAITING -> ActivityVariation.WAIT.wireValue
        MonitorEventName.TASK_FINISHED -> ActivityVariation.CELEBRATE.wireValue
        MonitorEventName.TASK_FAILED,
        MonitorEventName.TOOL_FAILED -> ActivityVariation.ALERT.wireValue
        MonitorEventName.SESSION_ENDED,
        MonitorEventName.UNKNOWN -> ActivityVariation.BREATH.wireValue
    }

    private data class DemoStep(
        val name: MonitorEventName,
        val claudeState: ClaudeState,
        val detail: String,
        val durationMs: Long,
    )
}
