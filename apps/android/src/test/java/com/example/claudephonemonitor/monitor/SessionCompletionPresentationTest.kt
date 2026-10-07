package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModelStore
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
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionCompletionPresentationTest {
    @Test
    fun firstSnapshotRestoresFreshCompletionWhileOtherSessionsKeepWorking() {
        val completion = RecentCompletion("done", "task", 3, "", "Named release")
        var state = reduce(MonitorPresentationState(), snapshot(4, completion, listOf(
            SessionSummary("done", "Named release", ClaudeState.IDLE, 3),
            SessionSummary("other", "Other", ClaudeState.WORKING, 4),
        ), runningCount = 1), 0)
        assertEquals(PetState.WORKING, state.baseState)
        assertEquals(PetState.FINISH, state.changeStatus)
        assertEquals("Named release", state.completionName)
        assertEquals(completion, state.recentSessionCompletion)
        assertEquals(15_000L, state.sessionCompletionDeadlineMs)

        state = reduce(state, snapshot(4, completion, runningCount = 1), 1_000)
        assertEquals(15_000L, state.changeDeadlineMs)
        assertEquals(15_000L, state.sessionCompletionDeadlineMs)
        state = reduce(state, snapshot(4, completion, runningCount = 1), 15_000)
        assertNull(state.changeStatus)
        assertNull(state.recentSessionCompletion)
    }

    @Test
    fun reconnectDoesNotReplaySeenResultButCanRestoreNewAuthoritativeResult() {
        var state = reduce(MonitorPresentationState(), snapshot(1), 0)
        state = reduce(state, finished("a", 2, "Release A"), 100)
        state = reduce(state, MonitorEvent(type = MonitorEventType.DISCONNECTED), 200)
        state = reduce(state, MonitorEvent(type = MonitorEventType.CONNECTED), 300)
        state = reduce(state, snapshot(2, RecentCompletion("a", "task", 2, "", "Release A")), 400)
        assertEquals(PetState.IDLE, state.baseState)
        assertEquals(PetState.IDLE, state.changeStatus)
        assertNull(state.recentSessionCompletion)

        state = reduce(state, MonitorEvent(type = MonitorEventType.DISCONNECTED), 500)
        state = reduce(state, MonitorEvent(type = MonitorEventType.CONNECTED), 600)
        state = reduce(state, snapshot(3, RecentCompletion("b", "task", 3, "", "Release B")), 700)
        assertEquals(PetState.FINISH, state.changeStatus)
        assertEquals("Release B", state.completionName)
        assertEquals("b", state.recentSessionCompletion?.sessionId)
        assertEquals(15_700L, state.sessionCompletionDeadlineMs)
    }

    @Test
    fun unrelatedCompletionCannotFillNameEvenWhenLegacySnapshotConfirmsFinish() {
        var state = reduce(MonitorPresentationState(), snapshot(1), 0)
        state = reduce(state, finished("a", 2, "Release A"), 100)
        val deadline = state.changeDeadlineMs
        listOf(
            RecentCompletion("b", "task", 2, "", "Other session"),
            RecentCompletion("a", "other-task", 2, "", "Other task"),
            RecentCompletion("a", "task", 1, "", "Older result"),
        ).forEach { unrelated ->
            state = reduce(state, snapshot(2, unrelated, activity = "task_finished"), 500)
            assertEquals("Release A", state.completionName)
            assertEquals("Release A", state.recentSessionCompletion?.displayName)
            assertEquals(deadline, state.changeDeadlineMs)
        }
        state = reduce(state, snapshot(2, RecentCompletion("a", "task", 2, "", "Authoritative A")), 600)
        assertEquals("Authoritative A", state.completionName)
        assertEquals("Authoritative A", state.recentSessionCompletion?.displayName)
        assertEquals(deadline, state.changeDeadlineMs)
    }

    @Test
    fun stopWithoutTaskIdCanAcquireOnlyItsMatchingAuthoritativeIdentityWithoutRestarting() {
        var state = reduce(MonitorPresentationState(), snapshot(1), 0)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT, name = MonitorEventName.TASK_STARTED,
            sessionId = "a", taskId = "known-task", sequence = 2,
        ), 50)
        state = reduce(state, finished("a", 3, null).copy(taskId = null), 100)
        val deadline = state.changeDeadlineMs
        state = reduce(state, snapshot(3, RecentCompletion("a", "known-task", 3, "", "Named release")), 600)

        assertEquals("a|known-task|3", state.changeIdentity)
        assertEquals("known-task", state.recentSessionCompletion?.taskId)
        assertEquals("Named release", state.completionName)
        assertEquals(deadline, state.changeDeadlineMs)
        assertEquals(14_500L, MonitorPresentationReducer.stateChange(state, 600)?.remainingMs)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT, name = MonitorEventName.TOOL_FINISHED,
            sessionId = "a", taskId = "known-task", sequence = 4,
        ), 700)
        assertEquals(deadline, state.changeDeadlineMs)
        state = reduce(state, snapshot(4, RecentCompletion("a", "known-task", 3, "", "Named release")), 800)
        assertEquals(deadline, state.changeDeadlineMs)
    }

    @Test
    fun interleavedFinishesKeepTheMostRecentSessionNameAndIndependentExpiry() {
        var state = reduce(MonitorPresentationState(), snapshot(1), 0)
        state = reduce(state, finished("a", 2, "Release A"), 100)
        state = reduce(state, finished("b", 3, "Release B"), 200)
        state = reduce(state, snapshot(3, RecentCompletion("a", "task", 2, "", "Release A"),
            activity = "task_finished"), 300)
        assertEquals("Release B", state.completionName)
        assertEquals("b", state.recentSessionCompletion?.sessionId)
        assertEquals(15_200L, state.sessionCompletionDeadlineMs)

        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT, name = MonitorEventName.TASK_FAILED,
            sessionId = "c", taskId = "task", sequence = 4,
        ), 1_000)
        assertEquals(PetState.ERROR, state.changeStatus)
        assertEquals("b", state.recentSessionCompletion?.sessionId)
        assertEquals(15_200L, state.sessionCompletionDeadlineMs)
        assertEquals("b", MonitorPresentationReducer.expire(state, 15_199).recentSessionCompletion?.sessionId)
        val expired = MonitorPresentationReducer.expire(state, 15_200)
        assertNull(expired.recentSessionCompletion)
        assertEquals(PetState.ERROR, expired.changeStatus) // The later error has its own deadline.
    }

    @Test
    fun relayCleanupAndIdleToolTailPreserveDoneButNewTaskImmediatelyClearsIt() {
        val activeSessions = listOf(
            SessionSummary("done", "Release", ClaudeState.WORKING, 1),
            SessionSummary("background", "Background", ClaudeState.WORKING, 1),
        )
        var state = reduce(MonitorPresentationState(), snapshot(1, sessions = activeSessions, runningCount = 2), 0)
        state = reduce(state, finished("done", 2, "Release"), 100)
        assertEquals(PetState.WORKING, state.baseState)
        assertEquals(SessionDisplayState.DONE, activeSessions[0].displayState(state.recentSessionCompletion))

        val idleTail = activeSessions[0].copy(claudeState = ClaudeState.IDLE, lastActivitySequence = 3)
        state = reduce(state, snapshot(3, sessions = listOf(idleTail, activeSessions[1]), runningCount = 1), 6_000)
        assertEquals(SessionDisplayState.DONE, idleTail.displayState(state.recentSessionCompletion))
        assertEquals(15_100L, state.sessionCompletionDeadlineMs)
        state = reduce(state, MonitorEvent(
            type = MonitorEventType.EVENT, name = MonitorEventName.TASK_STARTED,
            sessionId = "done", taskId = "new-task", sequence = 4,
        ), 6_100)
        assertNull(state.recentSessionCompletion)
        assertEquals(PetState.WORKING, state.changeStatus)
        assertEquals(PetState.WORKING, state.baseState)
    }

    @Test
    fun laterWorkingOrWaitingSnapshotCannotResurrectOldDone() {
        listOf(ClaudeState.WORKING, ClaudeState.WAITING).forEach { nextState ->
            var state = reduce(MonitorPresentationState(), snapshot(1), 0)
            state = reduce(state, finished("a", 2, "Release"), 100)
            state = reduce(state, snapshot(3, sessions = listOf(
                SessionSummary("a", "Release", nextState, 3),
            )), 200)
            assertNull(state.recentSessionCompletion)
        }
    }

    @Test
    fun restartedSessionClearsDoneWithEitherNewOrUnchangedTitleAndDoesNotReplaySeenResult() {
        listOf("Release A", "Release B").forEach { nextTitle ->
            var state = reduce(MonitorPresentationState(), snapshot(1), 0)
            state = reduce(state, finished("same", 3, "Release A"), 100)
            val deadline = state.changeDeadlineMs
            val oldCompletion = requireNotNull(state.recentSessionCompletion)
            state = reduce(state, MonitorEvent(
                type = MonitorEventType.EVENT, name = MonitorEventName.SESSION_STARTED,
                sessionId = "same", sessionTitle = nextTitle, sequence = 4,
            ), 200)
            assertNull(state.recentSessionCompletion)
            assertNull(state.sessionCompletionDeadlineMs)

            val restartedSession = SessionSummary("same", nextTitle, ClaudeState.IDLE, 4)
            state = reduce(state, snapshot(4, sessions = listOf(restartedSession)), 300)
            assertEquals(SessionDisplayState.IDLE, restartedSession.displayState(state.recentSessionCompletion))
            assertEquals("Release A", state.completionName) // The popup remains bound to the old task.
            assertEquals(deadline, state.changeDeadlineMs)
            state = reduce(state, snapshot(5, oldCompletion, sessions = listOf(restartedSession)), 400)
            assertNull(state.recentSessionCompletion)
            assertEquals(SessionDisplayState.IDLE, restartedSession.displayState(state.recentSessionCompletion))
        }
    }

    @Test
    fun newerSnapshotWithRenamedSessionClearsOldDoneEvenWhenStartEventWasMissed() {
        var state = reduce(MonitorPresentationState(), snapshot(1), 0)
        state = reduce(state, finished("same", 3, "Release A"), 100)
        val oldCompletion = requireNotNull(state.recentSessionCompletion)
        val renamedSession = SessionSummary("same", "Release B", ClaudeState.IDLE, 4)
        state = reduce(state, snapshot(4, sessions = listOf(renamedSession)), 200)
        assertNull(state.recentSessionCompletion)
        assertEquals(SessionDisplayState.IDLE, renamedSession.displayState(state.recentSessionCompletion))
        state = reduce(state, snapshot(5, oldCompletion, sessions = listOf(renamedSession)), 300)
        assertNull(state.recentSessionCompletion)
    }

    @Test
    fun viewModelCachesTitlesOutsideTopFiveAndPublishesLocalResultAfterRelayCleanup() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            var nowMs = 0L
            val client = FakeMonitorClient()
            val viewModel = MonitorViewModel(client) { nowMs }.also { store.put("monitor", it) }
            runCurrent()
            client.emit(snapshot(1, sessions = listOf(SessionSummary("target", "Named release", ClaudeState.IDLE, 1))))
            runCurrent()
            client.emit(snapshot(2, sessions = (1..5).map {
                SessionSummary("other-$it", "Other $it", ClaudeState.IDLE, 2)
            }))
            runCurrent()

            nowMs = 100
            client.emit(finished("target", 3, null))
            runCurrent()
            assertEquals("Named release", viewModel.uiState.value.stateChange?.completionName)
            assertEquals("Named release", viewModel.uiState.value.recentSessionCompletion?.displayName)
            nowMs = 6_000
            client.emit(snapshot(4)) // Relay's result expires after five seconds.
            runCurrent()
            assertNull(viewModel.uiState.value.snapshot.recentCompletion)
            assertEquals("target", viewModel.uiState.value.recentSessionCompletion?.sessionId)
            nowMs = 15_099
            advanceTimeBy(100)
            runCurrent()
            assertEquals("Named release", viewModel.uiState.value.recentSessionCompletion?.displayName)
            nowMs = 15_100
            advanceTimeBy(100)
            runCurrent()
            assertNull(viewModel.uiState.value.recentSessionCompletion)
            assertNull(viewModel.uiState.value.stateChange)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun viewModelBoundsTitleCacheAndRemembersSessionStartedTitles() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = FakeMonitorClient()
            val viewModel = MonitorViewModel(client) { 100L }.also { store.put("cache", it) }
            runCurrent()
            client.emit(snapshot(1, sessions = listOf(SessionSummary("old", "Old name", ClaudeState.IDLE, 1))))
            runCurrent()
            client.emit(MonitorEvent(
                type = MonitorEventType.EVENT, name = MonitorEventName.SESSION_STARTED,
                sessionId = "started", sessionTitle = "Started title", sequence = 2,
            ))
            runCurrent()
            client.emit(finished("started", 3, null))
            runCurrent()
            assertEquals("Started title", viewModel.uiState.value.recentSessionCompletion?.displayName)

            repeat(64) { index ->
                client.emit(snapshot(4L + index, sessions = listOf(
                    SessionSummary("session-$index", "Title $index", ClaudeState.IDLE, 4L + index),
                )))
                runCurrent()
            }
            client.emit(finished("old", 68, null))
            runCurrent()
            assertEquals(fallbackSessionTitle("old"), viewModel.uiState.value.recentSessionCompletion?.displayName)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    private fun reduce(state: MonitorPresentationState, event: MonitorEvent, nowMs: Long) =
        MonitorPresentationReducer.reduce(state, event, nowMs).state

    private fun snapshot(
        sequence: Long,
        completion: RecentCompletion? = null,
        sessions: List<SessionSummary>? = null,
        runningCount: Int? = null,
        activity: String? = null,
    ) = MonitorEvent(
        type = MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(
            computerState = ComputerState.ONLINE,
            lastSequence = sequence,
            sessions = sessions,
            runningCount = runningCount,
            recentCompletion = completion,
            activity = activity,
        ),
    )

    private fun finished(sessionId: String, sequence: Long, title: String?) = MonitorEvent(
        type = MonitorEventType.EVENT,
        name = MonitorEventName.TASK_FINISHED,
        sessionId = sessionId,
        taskId = "task",
        sessionTitle = title,
        sequence = sequence,
    )

    private class FakeMonitorClient : MonitorClient {
        override val events = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 8)
        override val isConnected = MutableStateFlow(false)
        override fun connect() { isConnected.value = true }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) = Unit
        fun emit(event: MonitorEvent) { events.tryEmit(event) }
    }
}
