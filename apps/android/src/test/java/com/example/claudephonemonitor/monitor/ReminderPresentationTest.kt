package com.example.claudephonemonitor.monitor

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReminderPresentationTest {
    @Test
    fun taskOutcomesUseTheirOwnDurationAndStrictFiveMinuteThreshold() {
        listOf(MonitorEventName.TASK_FINISHED, MonitorEventName.TASK_FAILED).forEach { name ->
            listOf(null, -1L, 299_999L, 300_000L, 300_001L, 86_400_001L).forEach { duration ->
                val state = reduce(initial(), event(name, 2, durationMs = duration), 100)
                val expectedStrength = if (duration == 300_001L) ReminderStrength.STRONG else ReminderStrength.WEAK
                val visibleMs = if (expectedStrength == ReminderStrength.STRONG) 15_000L else 5_000L
                val prompt = requireNotNull(MonitorPresentationReducer.stateChange(state, 100))
                assertEquals("$name / $duration", expectedStrength, prompt.strength)
                assertEquals(visibleMs, prompt.remainingMs)
                assertEquals(1L, MonitorPresentationReducer.stateChange(state, 100 + visibleMs - 1)?.remainingMs)
                assertNull(MonitorPresentationReducer.stateChange(state, 100 + visibleMs))
                if (name == MonitorEventName.TASK_FINISHED) {
                    assertNotNull(MonitorPresentationReducer.expire(state, 100 + visibleMs - 1).recentSessionCompletion)
                    assertNotNull(MonitorPresentationReducer.expire(state, 100 + visibleMs).recentSessionCompletion)
                }
            }
        }
    }

    @Test
    fun completionRestoredAfterAppRestartKeepsItsOwnStrengthAndName() {
        listOf(300_000L, 300_001L).forEach { duration ->
            val completion = RecentCompletion("done", "done-task", 8, at(duration), "Release", duration)
            val state = reduce(MonitorPresentationState(), snapshot(9,
                sessions = listOf(SessionSummary("other", "Other", ClaudeState.WORKING, 9)),
                activeTasks = listOf(task("other", 600_000)), completion = completion), 20)
            assertEquals(PetState.WORKING, state.baseState)
            assertEquals(PetState.FINISH, state.changeStatus)
            assertEquals("Release", state.completionName)
            assertEquals(if (duration > 300_000) ReminderStrength.STRONG else ReminderStrength.WEAK, state.changeStrength)
            assertEquals(completion, state.recentSessionCompletion)
        }
    }

    @Test
    fun waitsCountTowardTheTaskStartedToFinishedDuration() {
        var state = reduce(initial(), event(MonitorEventName.TASK_STARTED, 2, occurredAt = at(0)), 100)
        state = reduce(state, event(MonitorEventName.WAITING, 3, occurredAt = at(100_000), reason = "input"), 200)
        assertEquals(ReminderStrength.WEAK, state.changeStrength)
        state = reduce(state, event(MonitorEventName.TASK_FINISHED, 4, occurredAt = at(300_001)), 300)
        assertEquals(ReminderStrength.STRONG, state.changeStrength)
        assertEquals(300_001L, state.recentSessionCompletion?.durationMs)
        assertTrue(state.activeTasks.isEmpty())
    }

    @Test
    fun explicitUserWaitsAreStrongEvenWhenAnotherSessionKeepsWorking() {
        listOf("permission", "question", "approval", "input", "unknown", null, "stale").forEach { reason ->
            val initial = initial(listOf(task("target", 300_001), task("other", 100)))
            val state = reduce(initial, event(MonitorEventName.WAITING, 2, reason = reason), 0)
            assertEquals(PetState.WORKING, state.baseState)
            assertEquals(PetState.WAITING, state.changeStatus)
            assertEquals(if (reason in listOf("permission", "question", "approval", "input")) {
                ReminderStrength.STRONG
            } else ReminderStrength.WEAK, state.changeStrength)
            assertEquals("target", state.changeSessionId)
        }
    }

    @Test
    fun staleAndOrdinaryAggregateChangesStayWeakDespiteLongActiveTasks() {
        listOf(ClaudeState.IDLE, ClaudeState.WORKING, ClaudeState.WAITING).forEach { aggregate ->
            val first = if (aggregate == ClaudeState.IDLE) ClaudeState.WORKING else ClaudeState.IDLE
            var state = reduce(MonitorPresentationState(), snapshot(1, first, activeTasks = listOf(task("target", 600_000))), 0)
            state = reduce(state, snapshot(2, aggregate, activeTasks = listOf(task("target", 600_001))), 100)
            assertEquals(ReminderStrength.WEAK, state.changeStrength)
            assertEquals(5_000L, MonitorPresentationReducer.stateChange(state, 100)?.remainingMs)
        }
        var stale = initial(listOf(task("target", 600_000)))
        stale = reduce(stale, snapshot(2, ClaudeState.IDLE, computerState = ComputerState.STALE,
            activeTasks = listOf(task("target", 600_001))), 100)
        assertEquals(PetState.WAITING, stale.baseState)
        assertEquals(ReminderStrength.WEAK, stale.changeStrength)
    }

    @Test
    fun toolFailureIsWeakAndDoesNotEndTheLongTask() {
        var state = initial(listOf(task("target", 300_001)))
        state = reduce(state, event(MonitorEventName.TOOL_FAILED, 2, durationMs = 600_000), 0)
        assertEquals(PetState.ERROR, state.changeStatus)
        assertEquals(ReminderStrength.WEAK, state.changeStrength)
        assertTrue(state.activeTasks.containsKey("target"))
        state = reduce(state, event(MonitorEventName.TASK_FINISHED, 3), 100)
        assertEquals(ReminderStrength.STRONG, state.changeStrength)
        assertEquals(PetState.FINISH, state.changeStatus)
        assertTrue(state.activeTasks.isEmpty())
    }

    @Test
    fun unexpectedDisconnectAddsMonotonicTimeToAllSnapshotTasks() {
        listOf(0L, 1L).forEach { elapsedSinceSnapshot ->
            val rows = (1..5).map { SessionSummary("visible-$it", "Visible", ClaudeState.IDLE, it.toLong()) }
            val initial = reduce(MonitorPresentationState(), snapshot(1, sessions = rows,
                activeTasks = listOf(task("outside-top-five", 300_000))), 100)
            val state = reduce(initial, MonitorEvent(MonitorEventType.DISCONNECTED), 100 + elapsedSinceSnapshot)
            assertEquals(PetState.OFFLINE, state.baseState)
            assertEquals(if (elapsedSinceSnapshot == 0L) ReminderStrength.WEAK else ReminderStrength.STRONG, state.changeStrength)
        }
    }

    @Test
    fun offlineRelaySnapshotHonorsTheCurrentAuthoritativeTaskList() {
        val state = reduce(initial(listOf(task("target", 300_001))), snapshot(2,
            computerState = ComputerState.OFFLINE, activeTasks = emptyList()), 100)
        assertEquals(PetState.OFFLINE, state.changeStatus)
        assertEquals(ReminderStrength.WEAK, state.changeStrength)
        val stillRunning = reduce(initial(listOf(task("target", 300_001))), snapshot(2,
            computerState = ComputerState.OFFLINE, activeTasks = listOf(task("target", 300_002))), 100)
        assertEquals(ReminderStrength.STRONG, stillRunning.changeStrength)
    }

    @Test
    fun localTaskStartSupportsDisconnectWithoutSnapshotTiming() {
        var state = reduce(initial(), event(MonitorEventName.TASK_STARTED, 2, occurredAt = at(0)), 100)
        state = reduce(state, MonitorEvent(MonitorEventType.DISCONNECTED), 300_101)
        assertEquals(ReminderStrength.STRONG, state.changeStrength)
    }

    @Test
    fun manualReconnectIsWeakEvenDuringALongTask() {
        val state = reduce(initial(listOf(task("target", 600_000))),
            MonitorEvent(MonitorEventType.DISCONNECTED, detail = "monitor closed"), 100)
        assertEquals(PetState.OFFLINE, state.baseState)
        assertEquals(ReminderStrength.WEAK, state.changeStrength)
        assertEquals(5_000L, MonitorPresentationReducer.stateChange(state, 100)?.remainingMs)
    }

    @Test
    fun missingInvalidOrAmbiguousTimingCannotCauseStrongDisconnect() {
        listOf(null, emptyList(), listOf(task("target", -1)), listOf(task("target", 86_400_001)),
            listOf(task("target", 600_000).copy(startedAt = "invalid")),
            listOf(task("target", 600_000), task("target", 600_000).copy(taskId = "other"))).forEach { tasks ->
            val state = reduce(initial(tasks), MonitorEvent(MonitorEventType.DISCONNECTED), 100)
            assertEquals(ReminderStrength.WEAK, state.changeStrength)
        }
    }

    @Test
    fun disconnectAfterTaskEndsDoesNotReuseItsDuration() {
        var state = initial(listOf(task("target", 100)))
        state = reduce(state, event(MonitorEventName.TASK_FAILED, 2), 0)
        assertTrue(state.activeTasks.isEmpty())
        state = reduce(state, MonitorEvent(MonitorEventType.DISCONNECTED), 400_000)
        assertEquals(ReminderStrength.WEAK, state.changeStrength)
    }

    @Test
    fun perTaskDurationNeverBorrowsAnotherSessionOrAMismatchedTask() {
        val otherSession = reduce(initial(listOf(task("other", 600_000))), event(MonitorEventName.TASK_FINISHED, 2), 100)
        assertEquals(ReminderStrength.WEAK, otherSession.changeStrength)
        val otherTask = reduce(initial(listOf(task("target", 600_000))),
            event(MonitorEventName.TASK_FINISHED, 2).copy(taskId = "different-task"), 100)
        assertEquals(ReminderStrength.WEAK, otherTask.changeStrength)
        assertTrue(otherTask.activeTasks.containsKey("target"))
    }

    @Test
    fun invalidEventTimeDoesNotTurnAWaitIntoAStrongReminder() {
        listOf("invalid", at(-1)).forEach { occurredAt ->
            val state = reduce(initial(listOf(task("target", 600_000))),
                event(MonitorEventName.WAITING, 2, occurredAt = occurredAt, reason = "permission"), 100)
            assertEquals(ReminderStrength.WEAK, state.changeStrength)
        }
    }

    @Test
    fun monotonicClockGoingBackwardsCannotAddTimeToTaskEvidence() {
        val first = reduce(MonitorPresentationState(), snapshot(1, activeTasks = listOf(task("target", 300_000))), 100)
        val state = reduce(first, MonitorEvent(MonitorEventType.DISCONNECTED), 99)
        assertEquals(ReminderStrength.WEAK, state.changeStrength)
    }

    @Test
    fun weakEventsCannotPreemptStrongAndSuppressedResultsCannotReplayLater() {
        var state = reduce(initial(), event(MonitorEventName.TASK_FINISHED, 2, durationMs = 300_001), 100)
        val originalDeadline = state.changeDeadlineMs
        val originalIdentity = state.changeIdentity
        state = reduce(state, event(MonitorEventName.TASK_STARTED, 3, occurredAt = at(1)).copy(sessionId = "other"), 200)
        assertEquals(PetState.WORKING, state.baseState)
        state = reduce(state, event(MonitorEventName.TASK_FINISHED, 4, durationMs = 1).copy(sessionId = "short"), 300)
        assertEquals(originalDeadline, state.changeDeadlineMs)
        assertEquals(originalIdentity, state.changeIdentity)
        assertEquals("short", state.recentSessionCompletion?.sessionId)
        state = reduce(state, snapshot(5, claudeState = ClaudeState.WORKING), 400)
        state = reduce(state, snapshot(5, claudeState = ClaudeState.WORKING,
            completion = RecentCompletion("short", "task-target", 4, at(1), "Short", 1)), 15_100)
        assertNull(state.changeStatus)
        assertEquals("short", state.recentSessionCompletion?.sessionId)
    }

    @Test
    fun suppressedWeakCompletionSnapshotCannotRenameTheActiveStrongReminder() {
        val alpha = event(MonitorEventName.TASK_FINISHED, 2, durationMs = 300_001)
            .copy(sessionId = "alpha", taskId = "alpha-task", sessionTitle = "Completed Alpha")
        val beta = event(MonitorEventName.TASK_FINISHED, 3, durationMs = 1)
            .copy(sessionId = "beta", taskId = "beta-task", sessionTitle = "Completed Beta")
        var state = reduce(initial(), alpha, 100)
        val deadline = state.changeDeadlineMs
        val identity = state.changeIdentity
        state = reduce(state, beta, 200)
        val betaCompletion = RecentCompletion("beta", "beta-task", 3, beta.occurredAt, "Completed Beta", 1)
        state = reduce(state, snapshot(3, completion = betaCompletion), 300)
        assertEquals(betaCompletion, state.recentSessionCompletion)
        assertEquals(PetState.FINISH, state.changeStatus)
        assertEquals(ReminderStrength.STRONG, state.changeStrength)
        assertEquals("Completed Alpha", state.completionName)
        assertEquals(identity, state.changeIdentity)
        assertEquals(deadline, state.changeDeadlineMs)

        // A late refinement of Alpha still belongs to the active reminder, even when Beta
        // is the newest durable task result. Neither result can restart the reminder timer.
        val namedAlpha = RecentCompletion("alpha", "alpha-task", 2, alpha.occurredAt, "Renamed Alpha", 300_001)
        state = reduce(state, snapshot(4, completion = namedAlpha), 400)
        assertEquals(betaCompletion, state.recentSessionCompletion)
        assertEquals("Renamed Alpha", state.completionName)
        assertEquals(identity, state.changeIdentity)
        assertEquals(deadline, state.changeDeadlineMs)
    }

    @Test
    fun newStrongReminderReplacesAnOlderStrongReminder() {
        var state = reduce(initial(), event(MonitorEventName.TASK_FINISHED, 2, durationMs = 300_001), 100)
        state = reduce(state, event(MonitorEventName.TASK_FAILED, 3, durationMs = 300_001).copy(sessionId = "other"), 500)
        assertEquals(PetState.ERROR, state.changeStatus)
        assertEquals(ReminderStrength.STRONG, state.changeStrength)
        assertEquals("other", state.changeSessionId)
        assertEquals(15_500L, state.changeDeadlineMs)
    }

    @Test
    fun duplicatesOldEventsAndAuthoritativeNameUpdatesDoNotExtendStrongDeadline() {
        val finish = event(MonitorEventName.TASK_FINISHED, 2, durationMs = 300_001).copy(sessionTitle = null)
        var state = reduce(initial(), finish, 100)
        val deadline = state.changeDeadlineMs
        val duplicate = MonitorPresentationReducer.reduce(state, finish, 500)
        assertFalse(duplicate.accepted)
        state = duplicate.state
        val old = MonitorPresentationReducer.reduce(state, event(MonitorEventName.TASK_STARTED, 1), 600)
        assertFalse(old.accepted)
        val completion = RecentCompletion("target", "task-target", 2, at(300_001), "Authoritative name", 300_001)
        state = reduce(old.state, snapshot(2, completion = completion), 1_000)
        assertEquals("Authoritative name", state.completionName)
        assertEquals(deadline, state.changeDeadlineMs)
        state = reduce(state, snapshot(2, completion = completion), 15_100)
        assertNull(state.changeStatus)
    }

    @Test
    fun newTaskInTheSameSessionStartsItsOwnDuration() {
        var state = initial(listOf(task("target", 600_000)))
        state = reduce(state, event(MonitorEventName.TASK_FAILED, 2), 0)
        state = reduce(state, event(MonitorEventName.TASK_STARTED, 3, occurredAt = at(600_000)).copy(taskId = "new-task"), 16_000)
        state = reduce(state, event(MonitorEventName.TASK_FINISHED, 4, occurredAt = at(600_100)).copy(taskId = "new-task"), 16_100)
        assertEquals(ReminderStrength.WEAK, state.changeStrength)
        assertEquals(100L, state.recentSessionCompletion?.durationMs)
    }

    @Test
    fun childTimingIsExcludedEvenWhenAnOldRelayAdvertisesIt() {
        val rows = listOf(SessionSummary("child", "Child", ClaudeState.WORKING, 1, SessionKind.SUBAGENT))
        val initial = reduce(MonitorPresentationState(), snapshot(1, sessions = rows,
            activeTasks = listOf(task("child", 600_000))), 0)
        val state = reduce(initial, MonitorEvent(MonitorEventType.DISCONNECTED), 100)
        assertEquals(ReminderStrength.WEAK, state.changeStrength)
        assertTrue(state.activeTasks.isEmpty())
    }

    @Test
    fun snapshotBeforeSameSequenceFailureOrUserWaitStillShowsTheUnseenEventOnce() {
        listOf(MonitorEventName.TASK_FAILED, MonitorEventName.WAITING).forEach { name ->
            var state = reduce(initial(listOf(task("target", 600_000))), snapshot(2,
                activeTasks = if (name == MonitorEventName.WAITING) listOf(task("target", 600_000)) else emptyList()), 100)
            val incoming = event(name, 2, durationMs = 600_000, reason = "permission")
            val reduction = MonitorPresentationReducer.reduce(state, incoming, 200)
            assertTrue(reduction.accepted)
            state = reduction.state
            assertEquals(ReminderStrength.STRONG, state.changeStrength)
            assertEquals(15_200L, state.changeDeadlineMs)
            val repeated = MonitorPresentationReducer.reduce(state, incoming, 300)
            assertFalse(repeated.accepted)
            assertEquals(15_200L, repeated.state.changeDeadlineMs)
        }
    }

    @Test
    fun snapshotBeforeSameSequenceCompletionDoesNotRestartAnAlreadyRestoredResult() {
        val completion = RecentCompletion("target", "task-target", 2, at(600_000), "Target", 600_000)
        var state = reduce(initial(), snapshot(2, completion = completion), 100)
        val reduction = MonitorPresentationReducer.reduce(state, event(MonitorEventName.TASK_FINISHED, 2, durationMs = 600_000), 200)
        assertTrue(reduction.accepted)
        state = reduction.state
        assertEquals(15_100L, state.changeDeadlineMs)
        assertEquals(15_100L, state.sessionCompletionDeadlineMs)
    }

    @Test
    fun repeatedStartForTheSameExplicitTaskKeepsItsOriginalTimeAndReminderDeadline() {
        var state = reduce(initial(), event(MonitorEventName.TASK_STARTED, 2, occurredAt = at(0)), 100)
        val timing = state.activeTasks["target"]
        val deadline = state.changeDeadlineMs
        state = reduce(state, event(MonitorEventName.TASK_STARTED, 3, occurredAt = at(299_000)), 299_100)
        assertEquals(timing, state.activeTasks["target"])
        assertNull(state.changeDeadlineMs) // The old five-second prompt expired; the duplicate cannot replay it.
        assertEquals(5_100L, deadline)
        state = reduce(state, event(MonitorEventName.TASK_FINISHED, 4, occurredAt = at(300_001)), 300_101)
        assertEquals(ReminderStrength.STRONG, state.changeStrength)
        assertEquals(300_001L, state.recentSessionCompletion?.durationMs)
    }

    @Test
    fun completionEventArrivingAfterItsRestoredSnapshotDeadlineCannotReplayTheResult() {
        val completion = RecentCompletion("target", "task-target", 2, at(600_000), "Target", 600_000)
        val first = reduce(initial(), snapshot(2, completion = completion), 100)
        val late = MonitorPresentationReducer.reduce(first,
            event(MonitorEventName.TASK_FINISHED, 2, durationMs = 600_000), 15_100)
        assertTrue(late.accepted)
        assertNull(late.state.changeStatus)
        assertEquals(completion, late.state.recentSessionCompletion)
    }

    private fun initial(tasks: List<ActiveTask>? = null) =
        reduce(MonitorPresentationState(), snapshot(1,
            claudeState = if (tasks.isNullOrEmpty()) ClaudeState.IDLE else ClaudeState.WORKING, activeTasks = tasks), 0)

    private fun task(id: String, elapsedMs: Long) = ActiveTask(id, "task-$id", at(0), elapsedMs)

    private fun event(
        name: MonitorEventName,
        sequence: Long,
        occurredAt: String = "",
        durationMs: Long? = null,
        reason: String? = null,
    ) = MonitorEvent(MonitorEventType.EVENT, name = name, sequence = sequence, sessionId = "target",
        taskId = "task-target", sessionTitle = "Target", occurredAt = occurredAt,
        durationMs = durationMs, waitingReason = reason)

    private fun snapshot(
        sequence: Long,
        claudeState: ClaudeState = ClaudeState.IDLE,
        computerState: ComputerState = ComputerState.ONLINE,
        sessions: List<SessionSummary>? = null,
        activeTasks: List<ActiveTask>? = null,
        completion: RecentCompletion? = null,
    ) = MonitorEvent(MonitorEventType.SNAPSHOT, snapshot = MonitorSnapshot(computerState = computerState,
        claudeState = claudeState, lastSequence = sequence, sessions = sessions,
        activeTasks = activeTasks, recentCompletion = completion))

    private fun reduce(state: MonitorPresentationState, event: MonitorEvent, nowMs: Long) =
        MonitorPresentationReducer.reduce(state, event, nowMs).state

    private fun at(offsetMs: Long): String = Instant.parse("2026-10-07T01:00:00Z").plusMillis(offsetMs).toString()
}
