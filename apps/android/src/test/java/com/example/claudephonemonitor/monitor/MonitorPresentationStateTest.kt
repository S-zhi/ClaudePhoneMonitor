package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModelStore
import com.example.claudephonemonitor.ui.MonitorPage
import com.example.claudephonemonitor.ui.selectMonitorPage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MonitorPresentationStateTest {
    @Test
    fun allSixStatusPromptsExpireAtExactFifteenSecondBoundary() {
        val cases = listOf(
            Triple(PetState.IDLE, snapshot(2, PetState.IDLE), snapshot(1, PetState.WORKING)),
            Triple(PetState.WORKING, snapshot(2, PetState.WORKING), snapshot(1, PetState.IDLE)),
            Triple(PetState.WAITING, snapshot(2, PetState.WAITING), snapshot(1, PetState.IDLE)),
            Triple(PetState.FINISH, outcome(2, MonitorEventName.TASK_FINISHED), snapshot(1, PetState.IDLE)),
            Triple(PetState.ERROR, outcome(2, MonitorEventName.TASK_FAILED), snapshot(1, PetState.IDLE)),
            Triple(PetState.OFFLINE, MonitorEvent(type = MonitorEventType.DISCONNECTED), snapshot(1, PetState.WORKING)),
        )
        cases.forEach { (expected, event, initial) ->
            var state = reduce(MonitorPresentationState(), initial, 0L)
            state = reduce(state, event, 100L)
            assertEquals(expected, MonitorPresentationReducer.stateChange(state, 100L)?.status)
            assertEquals(15_000L, MonitorPresentationReducer.stateChange(state, 100L)?.remainingMs)
            assertEquals(1L, MonitorPresentationReducer.stateChange(state, 15_099L)?.remainingMs)
            assertNull(MonitorPresentationReducer.stateChange(state, 15_100L))
        }
    }

    @Test
    fun stateChangesUseFifteenSecondDeadlineAndPreserveUnderlyingPetState() {
        var state = MonitorPresentationState()
        state = reduce(state, snapshot(1, PetState.IDLE), 0L)
        assertNull(MonitorPresentationReducer.stateChange(state, 0L)) // Initial authority is not an animation.

        state = reduce(state, snapshot(2, PetState.WORKING), 100L)
        assertEquals(PetState.WORKING, state.baseState)
        assertEquals(StateChangeUi(PetState.WORKING, 15_000L), MonitorPresentationReducer.stateChange(state, 100L))
        assertEquals(1L, MonitorPresentationReducer.stateChange(state, 15_099L)?.remainingMs)
        assertNull(MonitorPresentationReducer.stateChange(state, 15_100L))
    }

    @Test
    fun outcomesAndDisconnectRefreshButDuplicateOrOrdinaryEventsDoNot() {
        var state = reduce(MonitorPresentationState(), snapshot(1, PetState.IDLE), 0L)
        val failed = outcome(2, MonitorEventName.TASK_FAILED)
        state = reduce(state, failed, 100L)
        assertEquals(PetState.ERROR, MonitorPresentationReducer.stateChange(state, 100L)?.status)
        val deadline = state.changeDeadlineMs
        state = MonitorPresentationReducer.reduce(state, failed, 1_000L).state
        assertEquals(deadline, state.changeDeadlineMs)

        state = reduce(state, MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.TOOL_STARTED, sequence = 3), 2_000L)
        assertEquals(deadline, state.changeDeadlineMs)
        state = reduce(state, MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.TASK_STARTED, sequence = 4), 2_100L)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.stateChange(state, 2_100L)?.status)
        assertEquals(PetState.WORKING, state.baseState)

        state = reduce(state, MonitorEvent(type = MonitorEventType.DISCONNECTED), 2_200L)
        assertEquals(PetState.OFFLINE, state.baseState)
        assertEquals(PetState.OFFLINE, MonitorPresentationReducer.stateChange(state, 2_200L)?.status)
    }

    @Test
    fun finishSurvivesMatchingToolTailAndSnapshotAndLocksNamePastRelayTtl() {
        var state = reduce(
            MonitorPresentationState(),
            MonitorEvent(
                type = MonitorEventType.SNAPSHOT,
                snapshot = MonitorSnapshot(
                    computerState = ComputerState.ONLINE,
                    claudeState = ClaudeState.WORKING,
                    lastSequence = 10,
                    sessions = listOf(SessionSummary("other", "background", ClaudeState.WORKING, 10)),
                    runningCount = 1,
                ),
            ), 0L,
        )
        val finish = MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED,
            sessionId = "done",
            taskId = "task-1",
            sessionTitle = "release prep",
            sequence = 11,
        )
        state = reduce(state, finish, 100L)
        assertEquals(PetState.WORKING, state.baseState)
        assertEquals(PetState.FINISH, MonitorPresentationReducer.stateChange(state, 100L)?.status)
        assertEquals("release prep", MonitorPresentationReducer.stateChange(state, 100L)?.completionName)

        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TOOL_FINISHED,
            sessionId = "done",
            taskId = "task-1",
            sequence = 12,
        ), 200L)
        assertEquals(14_900L, MonitorPresentationReducer.stateChange(state, 200L)?.remainingMs)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(
                computerState = ComputerState.ONLINE,
                claudeState = ClaudeState.WORKING,
                lastSequence = 12,
                runningCount = 1,
                recentCompletion = RecentCompletion("done", "task-1", 11, "", "release prep"),
            ),
        ), 300L)
        assertEquals(14_800L, MonitorPresentationReducer.stateChange(state, 300L)?.remainingMs)
        assertEquals(PetState.WORKING, state.baseState)
    }

    @Test
    fun stopTailSnapshotAfterRelayCompletionTtlCannotCancelFinish() {
        var state = reduce(MonitorPresentationState(), snapshot(40, PetState.IDLE), 0L)
        val finish = MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED,
            sessionId = "s-1",
            taskId = "task-a",
            sequence = 41,
        )
        state = reduce(state, finish, 100L)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TOOL_FINISHED,
            sessionId = "s-1",
            sequence = 42,
        ), 200L) // Relay may omit task_id on this stop-tail event.
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(
                computerState = ComputerState.ONLINE,
                claudeState = ClaudeState.WORKING,
                lastSequence = 42,
                runningCount = 1,
                recentCompletion = null, // Its five-second Relay TTL has elapsed.
            ),
        ), 6_000L)
        assertEquals(PetState.WORKING, state.baseState)
        assertEquals(PetState.FINISH, MonitorPresentationReducer.stateChange(state, 6_000L)?.status)
        assertEquals(9_100L, MonitorPresentationReducer.stateChange(state, 6_000L)?.remainingMs)
    }

    @Test
    fun sameFinishSnapshotCanFillMissingNameWithoutChangingDeadline() {
        var state = reduce(MonitorPresentationState(), snapshot(7, PetState.IDLE), 0L)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED,
            sessionId = "s-2",
            taskId = "task-b",
            sequence = 8,
        ), 100L)
        assertEquals("未命名会话已完成", MonitorPresentationReducer.stateChange(state, 100L)?.completionName)
        val deadline = state.changeDeadlineMs
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(
                computerState = ComputerState.ONLINE,
                claudeState = ClaudeState.IDLE,
                lastSequence = 8,
                recentCompletion = RecentCompletion("s-2", "task-b", 8, "", "reviewed release"),
            ),
        ), 500L)
        assertEquals("reviewed release", MonitorPresentationReducer.stateChange(state, 500L)?.completionName)
        assertEquals(deadline, state.changeDeadlineMs)
    }

    @Test
    fun alreadyWorkingOtherSessionSnapshotRefreshDoesNotCancelFinish() {
        var state = reduce(MonitorPresentationState(), MonitorEvent(
            type = MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(
                computerState = ComputerState.ONLINE,
                claudeState = ClaudeState.WORKING,
                lastSequence = 10,
                sessions = listOf(
                    SessionSummary("codex-done", "Codex", ClaudeState.IDLE, 9),
                    SessionSummary("claude-existing", "Claude", ClaudeState.WORKING, 10),
                ),
                runningCount = 1,
                sessionCount = 2,
            ),
        ), 0L)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED,
            sessionId = "codex-done",
            taskId = "turn-done",
            sequence = 11,
        ), 100L)
        val deadline = state.changeDeadlineMs
        assertEquals(PetState.WORKING, state.baseState)
        assertEquals(PetState.FINISH, MonitorPresentationReducer.stateChange(state, 100L)?.status)

        // This is only a same-state refresh for the already-working Claude
        // session; there is no later task_started event in this sequence.
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(
                computerState = ComputerState.ONLINE,
                claudeState = ClaudeState.WORKING,
                lastSequence = 12,
                sessions = listOf(
                    SessionSummary("codex-done", "Codex", ClaudeState.IDLE, 9),
                    SessionSummary("claude-existing", "Claude", ClaudeState.WORKING, 12),
                ),
                runningCount = 1,
                sessionCount = 2,
            ),
        ), 500L)

        assertEquals(PetState.FINISH, MonitorPresentationReducer.stateChange(state, 500L)?.status)
        assertEquals(deadline, state.changeDeadlineMs)
        assertEquals(14_600L, MonitorPresentationReducer.stateChange(state, 500L)?.remainingMs)
    }

    @Test
    fun aNewTaskStartedAfterFinishChangesThePromptToWorking() {
        var state = reduce(MonitorPresentationState(), snapshot(1, PetState.IDLE), 0L)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED,
            sessionId = "codex-done",
            taskId = "turn-done",
            sequence = 2,
        ), 100L)
        assertEquals(PetState.FINISH, MonitorPresentationReducer.stateChange(state, 100L)?.status)

        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TASK_STARTED,
            sessionId = "claude-new",
            taskId = "turn-new",
            sequence = 3,
        ), 200L)

        assertEquals(PetState.WORKING, state.baseState)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.stateChange(state, 200L)?.status)
        assertEquals(15_000L, MonitorPresentationReducer.stateChange(state, 200L)?.remainingMs)
    }

    @Test
    fun workingAggregateIsNotReplacedBySessionWaitingOrTaskStartedReplay() {
        var state = reduce(MonitorPresentationState(), MonitorEvent(
            type = MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(
                computerState = ComputerState.ONLINE,
                claudeState = ClaudeState.WORKING,
                lastSequence = 1,
                sessions = (1..5).map { SessionSummary("idle-$it", "Idle $it", ClaudeState.IDLE, 1) },
                runningCount = 1,
                sessionCount = 6,
            ),
        ), 0L)
        assertEquals(PetState.WORKING, state.baseState) // Sixth working session is outside Top 5.
        state = reduce(state, MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.WAITING, sequence = 2), 100L)
        assertEquals(PetState.WORKING, state.baseState)
        assertNull(MonitorPresentationReducer.stateChange(state, 100L))
        state = reduce(state, MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.TASK_STARTED, sequence = 3), 200L)
        assertEquals(PetState.WORKING, state.baseState)
        assertNull(MonitorPresentationReducer.stateChange(state, 200L))
    }

    @Test
    fun reconnectSnapshotEstablishesStateWithoutReplayingHistoricalCompletion() {
        var state = reduce(MonitorPresentationState(), MonitorEvent(type = MonitorEventType.DISCONNECTED), 0L)
        state = reduce(state, MonitorEvent(type = MonitorEventType.CONNECTED), 100L)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(
                computerState = ComputerState.ONLINE,
                claudeState = ClaudeState.IDLE,
                lastSequence = 30,
                recentCompletion = RecentCompletion("s", "task", 29, "", "older result"),
            ),
        ), 200L)
        assertEquals(PetState.IDLE, state.baseState)
        assertNull(MonitorPresentationReducer.stateChange(state, 200L))
    }

    @Test
    fun offlineOutranksLiveEventsAndRepeatedDisconnectDoesNotReplayIt() {
        var state = reduce(MonitorPresentationState(), snapshot(1, PetState.WORKING), 0L)
        state = reduce(state, MonitorEvent(type = MonitorEventType.DISCONNECTED), 100L)
        val offlineDeadline = state.changeDeadlineMs
        assertEquals(PetState.OFFLINE, state.baseState)
        assertEquals(PetState.OFFLINE, MonitorPresentationReducer.stateChange(state, 100L)?.status)

        state = reduce(state, MonitorEvent(type = MonitorEventType.DISCONNECTED), 1_000L)
        assertEquals(offlineDeadline, state.changeDeadlineMs)
        state = reduce(state, MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.TASK_STARTED, sequence = 2L), 1_100L)
        state = reduce(state, outcome(3L, MonitorEventName.TASK_FINISHED), 1_200L)
        state = reduce(state, outcome(4L, MonitorEventName.TASK_FAILED), 1_300L)
        assertEquals(PetState.OFFLINE, state.baseState)
        assertEquals(offlineDeadline, state.changeDeadlineMs)
        assertEquals(PetState.OFFLINE, MonitorPresentationReducer.stateChange(state, 1_300L)?.status)

        state = MonitorPresentationReducer.expire(state, 15_100L)
        state = reduce(state, MonitorEvent(type = MonitorEventType.DISCONNECTED), 16_000L)
        assertNull(MonitorPresentationReducer.stateChange(state, 16_000L))
        state = reduce(state, MonitorEvent(type = MonitorEventType.CONNECTED), 16_100L)
        state = reduce(state, MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.TASK_STARTED, sequence = 5L), 16_200L)
        assertEquals(PetState.OFFLINE, state.baseState)
        assertNull(MonitorPresentationReducer.stateChange(state, 16_200L))

        state = reduce(state, snapshot(6L, PetState.WORKING), 16_300L)
        assertEquals(PetState.WORKING, state.baseState)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.stateChange(state, 16_300L)?.status)
    }

    @Test
    fun wireJsonFlowsThroughFakeClientAndViewModelTimer() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        kotlinx.coroutines.Dispatchers.setMain(dispatcher)
        try {
            var monotonicMs = 0L
            val client = FakeMonitorClient()
            val store = ViewModelStore()
            val vm = MonitorViewModel(client) { monotonicMs }.also { store.put("monitor", it) }
            runCurrent()
            client.emit("""{"type":"snapshot","snapshot":{"computer_state":"online","claude_state":"idle","last_sequence":1,"sessions":[],"running_count":0}}""")
            runCurrent()
            assertNull(vm.uiState.value.stateChange)

            client.emit("""{"type":"event","event_type":"task_finished","session_id":"s-7","task_id":"task-3","session_title":"release prep","sequence":2,"occurred_at":"2026-10-07T01:00:00Z"}""")
            runCurrent()
            assertEquals(PetState.IDLE, vm.uiState.value.petState)
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            assertEquals("release prep", vm.uiState.value.stateChange?.completionName)
            assertEquals(15_000L, vm.uiState.value.stateChange?.remainingMs)

            monotonicMs = 14_999L
            advanceTimeBy(100L)
            runCurrent()
            assertEquals(1L, vm.uiState.value.stateChange?.remainingMs)
            monotonicMs = 15_000L
            advanceTimeBy(100L)
            runCurrent()
            assertNull(vm.uiState.value.stateChange)
            store.clear()
        } finally {
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun bareCompletionUsesOnlyTheMatchingSessionTitleFromTheLastSnapshot() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        kotlinx.coroutines.Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        try {
            val client = FakeMonitorClient()
            val vm = MonitorViewModel(client) { 100L }.also { store.put("completion-title", it) }
            runCurrent()
            client.emit(
                """{"type":"snapshot","installation_id":"install","computer_state":"online","claude_state":"idle","last_sequence":1,"sessions":[{"session_id":"codex:sess:target","title":"Codex","claude_state":"idle","last_activity_sequence":1},{"session_id":"other-session","title":"Other Session","claude_state":"idle","last_activity_sequence":1}],"running_count":0,"session_count":2}""",
            )
            runCurrent()

            client.emit(
                """{"type":"event","schema_version":1,"installation_id":"install","session_id":"codex:sess:target","task_id":"codex:turn:target","sequence":2,"occurred_at":"2026-10-07T01:00:00Z","event_type":"task_finished","payload":{}}""",
            )
            runCurrent()
            assertEquals("Codex", vm.uiState.value.stateChange?.completionName)
            assertEquals("Codex", vm.uiState.value.snapshot.recentCompletion?.displayName)
            assertEquals("codex:sess:target", vm.uiState.value.snapshot.recentCompletion?.sessionId)

            client.emit(
                """{"type":"event","installation_id":"install","session_id":"unknown-session","task_id":"task-3","sequence":3,"occurred_at":"2026-10-07T01:00:01Z","event_type":"task_finished","payload":{}}""",
            )
            runCurrent()
            assertEquals("未命名会话已完成", vm.uiState.value.stateChange?.completionName)
            assertEquals("unknown-session", vm.uiState.value.snapshot.recentCompletion?.sessionId)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun usageOnlySnapshotRefreshesAuthoritativeValuesWithoutRestartingFinishPrompt() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        kotlinx.coroutines.Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        try {
            var monotonicMs = 100L
            val client = FakeMonitorClient()
            val vm = MonitorViewModel(client) { monotonicMs }.also { store.put("usage-refresh", it) }
            runCurrent()
            client.emit(usageSnapshotJson(sequence = 1, revision = 1))
            runCurrent()

            client.emit("""{"type":"event","event_type":"task_finished","session_id":"s-1","task_id":"turn-1","sequence":2,"occurred_at":"2026-10-07T01:00:00Z"}""")
            runCurrent()
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            val finishDeadline = monotonicMs + requireNotNull(vm.uiState.value.stateChange).remainingMs

            monotonicMs = 1_000L
            client.emit(usageSnapshotJson(sequence = 3, revision = 2))
            runCurrent()
            assertEquals(2L, vm.uiState.value.snapshot.usage?.revision)
            assertEquals(PetState.IDLE, vm.uiState.value.petState)
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            assertEquals(finishDeadline, monotonicMs + requireNotNull(vm.uiState.value.stateChange).remainingMs)

            vm.showUsagePage()
            assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))
            assertEquals(2L, vm.uiState.value.snapshot.usage?.revision)

            vm.showStatusPage()
            assertEquals(MonitorPage.STATE_CHANGE, selectMonitorPage(vm.uiState.value))
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            assertEquals(finishDeadline, monotonicMs + requireNotNull(vm.uiState.value.stateChange).remainingMs)
            vm.showUsagePage()

            client.disconnect()
            client.emit("""{"type":"disconnected"}""")
            runCurrent()
            assertEquals(false, vm.uiState.value.isConnected)
            assertEquals(2L, vm.uiState.value.snapshot.usage?.revision)
            assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))

            vm.showStatusPage()
            assertEquals(MonitorPage.STATE_CHANGE, selectMonitorPage(vm.uiState.value))
            assertEquals(PetState.OFFLINE, vm.uiState.value.petState)
            assertEquals(PetState.OFFLINE, vm.uiState.value.stateChange?.status)
            assertEquals(15_000L, vm.uiState.value.stateChange?.remainingMs)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun oldSequenceAndEqualSnapshotDoNotRestartPrompt() {
        var state = reduce(MonitorPresentationState(), snapshot(8, PetState.IDLE), 0L)
        state = reduce(state, outcome(9, MonitorEventName.TASK_FINISHED), 100L)
        val deadline = state.changeDeadlineMs
        val sameSeq = MonitorPresentationReducer.reduce(state, snapshot(9, PetState.IDLE), 1_000L)
        assertTrue(sameSeq.accepted)
        assertEquals(deadline, sameSeq.state.changeDeadlineMs)
        val old = MonitorPresentationReducer.reduce(sameSeq.state, snapshot(7, PetState.WORKING), 1_100L)
        assertFalse(old.accepted)
        assertEquals(deadline, old.state.changeDeadlineMs)
    }

    private fun reduce(state: MonitorPresentationState, event: MonitorEvent, now: Long) =
        MonitorPresentationReducer.reduce(state, event, now).state

    private fun snapshot(sequence: Long, state: PetState) = MonitorEvent(
        type = MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(
            computerState = if (state == PetState.OFFLINE) ComputerState.OFFLINE else ComputerState.ONLINE,
            claudeState = when (state) {
                PetState.WORKING -> ClaudeState.WORKING
                PetState.WAITING -> ClaudeState.WAITING
                else -> ClaudeState.IDLE
            },
            lastSequence = sequence,
        ),
    )

    private fun outcome(sequence: Long, name: MonitorEventName) = MonitorEvent(
        type = MonitorEventType.EVENT,
        name = name,
        sequence = sequence,
        sessionId = "session",
        taskId = "task",
    )

    private fun usageSnapshotJson(sequence: Long, revision: Long) = """
        {
          "type":"snapshot",
          "sequence":$sequence,
          "snapshot":{
            "installation_id":"install",
            "computer_state":"online",
            "claude_state":"idle",
            "last_sequence":$sequence,
            "updated_at":"2026-10-07T01:00:00Z",
            "usage":{
              "epoch_id":"epoch-1",
              "started_at":"2026-10-07T00:00:00Z",
              "revision":$revision,
              "observed_responses":2,
              "complete_responses":2,
              "provider_coverage":{
                "claude":{"status":"ready","observed_responses":1,"complete_responses":1},
                "codex":{"status":"ready","observed_responses":1,"complete_responses":1}
              },
              "new_input":{"value":20,"quality":"complete"},
              "cached_input":{"value":10,"quality":"complete"},
              "output":{"value":15,"quality":"complete"},
              "actual":{"value":35,"quality":"complete"},
              "total_input":{"value":30,"quality":"complete"},
              "cache_hit":{"numerator":10,"denominator":30,"quality":"complete"},
              "quota":{"start_remaining":null,"current_remaining":null,"unit":null,"reset_at":null,"availability":"unavailable"}
            }
          }
        }
    """.trimIndent()

    private class FakeMonitorClient : MonitorClient {
        private val mutableEvents = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 8)
        override val events = mutableEvents
        override val isConnected = MutableStateFlow(false)
        override fun connect() { isConnected.value = true }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) = Unit
        fun emit(rawJson: String) { mutableEvents.tryEmit(MonitorEvent.fromWireJson(rawJson)!!) }
    }
}
