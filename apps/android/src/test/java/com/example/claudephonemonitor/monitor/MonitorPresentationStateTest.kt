package com.example.claudephonemonitor.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitorPresentationStateTest {
    @Test
    fun monitorStartsOfflineWithControlsHidden() {
        val state = MonitorUiState()

        assertEquals(ComputerState.OFFLINE, state.snapshot.computerState)
        assertEquals(PetState.OFFLINE, state.petState)
        assertFalse(state.controlsVisible)
    }

    @Test
    fun historicalOutcomeSnapshotsDoNotStartResultOverlays() {
        listOf("task_finished", "task_failed", "tool_failed").forEachIndexed { index, activity ->
            val reduction = MonitorPresentationReducer.reduce(
                MonitorPresentationState(),
                snapshotEvent(
                    sequence = index + 1L,
                    claudeState = ClaudeState.IDLE,
                    activity = activity,
                ),
                nowMs = 1_000L,
            )

            assertTrue(reduction.accepted)
            assertNull(reduction.state.overlayState)
            assertEquals(0L, MonitorPresentationReducer.overlayRemainingMs(reduction.state, 1_000L))
            assertEquals(PetState.IDLE, MonitorPresentationReducer.effectivePetState(reduction.state, 1_000L))
        }
    }

    @Test
    fun canonicalToolFailedEventStartsTenSecondErrorOverlay() {
        val base = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            snapshotEvent(sequence = 1L, claudeState = ClaudeState.IDLE),
            nowMs = 0L,
        ).state
        val failed = MonitorPresentationReducer.reduce(
            base,
            outcomeEvent(sequence = 2L, name = MonitorEventName.TOOL_FAILED),
            nowMs = 100L,
        ).state

        assertEquals(PetState.IDLE, failed.baseState)
        assertEquals(PetState.ERROR, failed.overlayState)
        assertEquals(10_000L, MonitorPresentationReducer.overlayRemainingMs(failed, 100L))
        val expired = MonitorPresentationReducer.expire(failed, 10_100L)
        assertNull(expired.overlayState)
        assertEquals(PetState.IDLE, MonitorPresentationReducer.effectivePetState(expired, 10_100L))
    }

    @Test
    fun duplicateAndStaleSnapshotsDoNotReplayFinishTransition() {
        val base = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            snapshotEvent(sequence = 7L, claudeState = ClaudeState.IDLE),
            nowMs = 900L,
        ).state
        val finish = outcomeEvent(sequence = 8L, name = MonitorEventName.TASK_FINISHED)

        val started = MonitorPresentationReducer.reduce(base, finish, nowMs = 1_000L)
        assertTrue(started.accepted)
        assertEquals(PetState.IDLE, started.state.baseState)
        assertEquals(PetState.FINISH, MonitorPresentationReducer.effectivePetState(started.state, 1_000L))
        assertEquals(5_000L, MonitorPresentationReducer.transitionRemainingMs(started.state, 1_000L))

        val duplicate = MonitorPresentationReducer.reduce(started.state, finish, nowMs = 3_000L)
        assertFalse(duplicate.accepted)
        assertEquals(3_000L, MonitorPresentationReducer.transitionRemainingMs(duplicate.state, 3_000L))
        assertEquals(PetState.FINISH, MonitorPresentationReducer.effectivePetState(duplicate.state, 3_000L))

        val stale = MonitorPresentationReducer.reduce(
            duplicate.state,
            snapshotEvent(sequence = 7L, claudeState = ClaudeState.WORKING),
            nowMs = 3_100L,
        )
        assertFalse(stale.accepted)
        assertEquals(PetState.IDLE, stale.state.baseState)
        assertEquals(PetState.FINISH, MonitorPresentationReducer.effectivePetState(stale.state, 3_100L))
    }

    @Test
    fun newerSnapshotUpdatesBaseAndFinishResumesItAtExactExpiry() {
        val base = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            snapshotEvent(sequence = 9L, claudeState = ClaudeState.IDLE),
            nowMs = 1_000L,
        ).state
        val finish = MonitorPresentationReducer.reduce(
            base,
            outcomeEvent(sequence = 10L, name = MonitorEventName.TASK_FINISHED),
            nowMs = 2_000L,
        ).state

        val newerSnapshot = MonitorPresentationReducer.reduce(
            finish,
            snapshotEvent(sequence = 11L, claudeState = ClaudeState.WORKING, activity = "tool_started"),
            nowMs = 4_000L,
        )
        assertTrue(newerSnapshot.accepted)
        assertEquals(PetState.WORKING, newerSnapshot.state.baseState)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(newerSnapshot.state, 4_000L))
        assertEquals(3_000L, MonitorPresentationReducer.overlayRemainingMs(newerSnapshot.state, 4_000L))

        val oneMillisecondBeforeExpiry = MonitorPresentationReducer.expire(newerSnapshot.state, 6_999L)
        assertEquals(1L, MonitorPresentationReducer.overlayRemainingMs(oneMillisecondBeforeExpiry, 6_999L))
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(oneMillisecondBeforeExpiry, 6_999L))

        val expired = MonitorPresentationReducer.expire(newerSnapshot.state, 7_000L)
        assertNull(expired.overlayState)
        assertEquals(0L, MonitorPresentationReducer.overlayRemainingMs(expired, 7_000L))
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(expired, 7_000L))
    }

    @Test
    fun errorAndOrdinaryStateLabelsExpireAtTheirSpecifiedDurations() {
        val authenticated = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            snapshotEvent(sequence = 1L, claudeState = ClaudeState.IDLE),
            nowMs = 0L,
        ).state
        val error = MonitorPresentationReducer.reduce(
            authenticated,
            MonitorEvent(
                type = MonitorEventType.EVENT,
                name = MonitorEventName.TASK_FAILED,
                sequence = 2L,
            ),
            nowMs = 100L,
        ).state

        assertEquals("ERROR", error.activeStateLabel)
        assertEquals(10_000L, MonitorPresentationReducer.transitionRemainingMs(error, 100L))
        assertEquals(1L, MonitorPresentationReducer.transitionRemainingMs(error, 10_099L))
        val errorExpired = MonitorPresentationReducer.expire(error, 10_100L)
        assertNull(errorExpired.activeStateLabel)
        assertEquals(0L, MonitorPresentationReducer.transitionRemainingMs(errorExpired, 10_100L))

        val waiting = MonitorPresentationReducer.reduce(
            errorExpired,
            MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.WAITING, sequence = 3L),
            nowMs = 11_000L,
        ).state
        assertEquals("WAITING", waiting.activeStateLabel)
        assertEquals(2_500L, MonitorPresentationReducer.transitionRemainingMs(waiting, 11_000L))
        assertEquals(1L, MonitorPresentationReducer.transitionRemainingMs(waiting, 13_499L))
        assertNull(MonitorPresentationReducer.expire(waiting, 13_500L).activeStateLabel)
    }

    @Test
    fun offlineSnapshotOutranksAnActiveResultOverlay() {
        val base = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            snapshotEvent(sequence = 3L, claudeState = ClaudeState.IDLE),
            nowMs = 0L,
        ).state
        val finish = MonitorPresentationReducer.reduce(
            base,
            outcomeEvent(sequence = 4L, name = MonitorEventName.TASK_FINISHED),
            nowMs = 0L,
        ).state
        val offline = MonitorPresentationReducer.reduce(
            finish,
            snapshotEvent(
                sequence = 5L,
                computerState = ComputerState.OFFLINE,
                claudeState = ClaudeState.IDLE,
            ),
            nowMs = 1_000L,
        ).state

        assertEquals(PetState.OFFLINE, offline.baseState)
        assertEquals(PetState.OFFLINE, MonitorPresentationReducer.effectivePetState(offline, 1_000L))
        assertNull(MonitorPresentationReducer.visibleOverlayState(offline, 1_000L))
        assertEquals(4_000L, MonitorPresentationReducer.overlayRemainingMs(offline, 1_000L))
    }

    @Test
    fun disconnectImmediatelySetsOfflineUntilFreshSnapshotArrives() {
        val working = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            snapshotEvent(sequence = 1L, claudeState = ClaudeState.WORKING),
            nowMs = 0L,
        ).state
        val disconnected = MonitorPresentationReducer.reduce(
            working,
            MonitorEvent(type = MonitorEventType.DISCONNECTED, sequence = 2L),
            nowMs = 100L,
        ).state

        assertEquals(PetState.OFFLINE, disconnected.baseState)
        assertEquals(PetState.OFFLINE, MonitorPresentationReducer.effectivePetState(disconnected, 100L))

        val reconnected = MonitorPresentationReducer.reduce(
            disconnected,
            MonitorEvent(type = MonitorEventType.CONNECTED),
            nowMs = 200L,
        ).state
        assertEquals(PetState.OFFLINE, reconnected.baseState)
        assertEquals(PetState.OFFLINE, MonitorPresentationReducer.effectivePetState(reconnected, 200L))

        val refreshed = MonitorPresentationReducer.reduce(
            reconnected,
            snapshotEvent(sequence = 3L, claudeState = ClaudeState.WORKING, activity = "tool_started"),
            nowMs = 300L,
        ).state
        assertEquals(PetState.WORKING, refreshed.baseState)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(refreshed, 300L))
    }

    @Test
    fun equalSequenceSnapshotRefreshesBaseWithoutReplayingOutcome() {
        val base = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            snapshotEvent(sequence = 7L, claudeState = ClaudeState.WORKING),
            nowMs = 500L,
        ).state
        val finish = MonitorPresentationReducer.reduce(
            base,
            outcomeEvent(sequence = 8L, name = MonitorEventName.TASK_FINISHED),
            nowMs = 1_000L,
        )
        assertTrue(finish.accepted)
        assertEquals(PetState.IDLE, finish.state.baseState)
        assertEquals(PetState.FINISH, finish.state.overlayState)

        val sameSequenceSnapshot = MonitorPresentationReducer.reduce(
            finish.state,
            snapshotEvent(sequence = 8L, claudeState = ClaudeState.IDLE, activity = "task_finished"),
            nowMs = 1_100L,
        )
        assertTrue(sameSequenceSnapshot.accepted)
        assertEquals(PetState.IDLE, sameSequenceSnapshot.state.baseState)
        assertEquals(PetState.FINISH, sameSequenceSnapshot.state.overlayState)
        assertEquals(4_900L, MonitorPresentationReducer.overlayRemainingMs(sameSequenceSnapshot.state, 1_100L))

        val duplicateFinish = MonitorPresentationReducer.reduce(
            sameSequenceSnapshot.state,
            outcomeEvent(sequence = 8L, name = MonitorEventName.TASK_FINISHED),
            nowMs = 1_500L,
        )
        assertFalse(duplicateFinish.accepted)
        assertEquals(4_500L, MonitorPresentationReducer.overlayRemainingMs(duplicateFinish.state, 1_500L))

        val nextTask = MonitorPresentationReducer.reduce(
            duplicateFinish.state,
            MonitorEvent(
                type = MonitorEventType.EVENT,
                name = MonitorEventName.TASK_STARTED,
                sequence = 9L,
            ),
            nowMs = 2_000L,
        )
        assertTrue(nextTask.accepted)
        assertEquals(PetState.WORKING, nextTask.state.baseState)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(nextTask.state, 2_000L))
        assertEquals(4_000L, MonitorPresentationReducer.overlayRemainingMs(nextTask.state, 2_000L))

        val expired = MonitorPresentationReducer.expire(nextTask.state, 6_000L)
        assertNull(expired.overlayState)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(expired, 6_000L))
    }

    @Test
    fun finishDoesNotHideAnotherWorkingSessionAndIsBoundToSessionTaskIdentity() {
        val aggregateWorking = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            MonitorEvent(
                type = MonitorEventType.SNAPSHOT,
                snapshot = MonitorSnapshot(
                    computerState = ComputerState.ONLINE,
                    claudeState = ClaudeState.WORKING,
                    lastSequence = 20L,
                    sessions = listOf(
                        SessionSummary("session-b", "background build", ClaudeState.WORKING, 20L),
                    ),
                    runningCount = 1,
                    sessionCount = 2,
                ),
            ),
            nowMs = 0L,
        ).state
        val finished = MonitorEvent(
            type = MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED,
            sequence = 21L,
            sessionId = "session-a",
            taskId = "task-a1",
        )

        val first = MonitorPresentationReducer.reduce(aggregateWorking, finished, nowMs = 100L)
        assertTrue(first.accepted)
        assertEquals("session-a|task-a1|21", first.state.lastCompletionIdentity)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(first.state, 100L))
        assertNull(MonitorPresentationReducer.visibleOverlayState(first.state, 100L))

        val duplicate = MonitorPresentationReducer.reduce(first.state, finished, nowMs = 1_000L)
        assertFalse(duplicate.accepted)
        assertEquals(4_100L, MonitorPresentationReducer.overlayRemainingMs(duplicate.state, 1_000L))
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(duplicate.state, 1_000L))
    }

    @Test
    fun aggregateWorkingOutsideTopFiveSurvivesFinishUntilAuthoritativeIdleSnapshot() {
        val snapshot = MonitorEvent(
            type = MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(
                computerState = ComputerState.ONLINE,
                claudeState = ClaudeState.WORKING,
                lastSequence = 40L,
                sessions = (1..5).map { index ->
                    SessionSummary("idle-$index", "Idle $index", ClaudeState.IDLE, 40L - index)
                },
                runningCount = 1,
                sessionCount = 6,
            ),
        )
        val current = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            snapshot,
            nowMs = 0L,
        ).state
        val finished = MonitorPresentationReducer.reduce(
            current,
            MonitorEvent(
                type = MonitorEventType.EVENT,
                name = MonitorEventName.TASK_FINISHED,
                sequence = 41L,
                sessionId = "hidden-working-session",
                taskId = "task-6",
            ),
            nowMs = 100L,
        )

        assertTrue(finished.accepted)
        assertTrue(finished.state.workingSessionIds?.isEmpty() == true)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(finished.state, 100L))
        assertNull(MonitorPresentationReducer.visibleOverlayState(finished.state, 100L))

        val settled = MonitorPresentationReducer.reduce(
            finished.state,
            MonitorEvent(
                type = MonitorEventType.SNAPSHOT,
                snapshot = snapshot.snapshot?.copy(
                    claudeState = ClaudeState.IDLE,
                    lastSequence = 41L,
                    runningCount = 0,
                ),
            ),
            nowMs = 200L,
        )
        assertTrue(settled.accepted)
        assertEquals(PetState.IDLE, settled.state.baseState)
        assertEquals(PetState.FINISH, MonitorPresentationReducer.effectivePetState(settled.state, 200L))
        assertEquals("hidden-working-session|task-6|41", settled.state.lastCompletionIdentity)
    }

    @Test
    fun finalWorkingSessionCompletionShowsFinishAfterRelayConfirmsIdle() {
        val working = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            MonitorEvent(
                type = MonitorEventType.SNAPSHOT,
                snapshot = MonitorSnapshot(
                    computerState = ComputerState.ONLINE,
                    claudeState = ClaudeState.WORKING,
                    lastSequence = 50L,
                    sessions = listOf(SessionSummary("only", "Only task", ClaudeState.WORKING, 50L)),
                    runningCount = 1,
                    sessionCount = 1,
                ),
            ),
            nowMs = 0L,
        ).state
        val finish = MonitorPresentationReducer.reduce(
            working,
            MonitorEvent(
                type = MonitorEventType.EVENT,
                name = MonitorEventName.TASK_FINISHED,
                sequence = 51L,
                sessionId = "only",
                taskId = "task-only",
            ),
            nowMs = 100L,
        )
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(finish.state, 100L))

        val idle = MonitorPresentationReducer.reduce(
            finish.state,
            MonitorEvent(
                type = MonitorEventType.SNAPSHOT,
                snapshot = MonitorSnapshot(
                    computerState = ComputerState.ONLINE,
                    claudeState = ClaudeState.IDLE,
                    lastSequence = 51L,
                    sessions = listOf(SessionSummary("only", "Only task", ClaudeState.IDLE, 51L)),
                    runningCount = 0,
                    sessionCount = 1,
                ),
            ),
            nowMs = 150L,
        )

        assertTrue(idle.accepted)
        assertEquals(PetState.FINISH, MonitorPresentationReducer.effectivePetState(idle.state, 150L))
        assertEquals(4_950L, MonitorPresentationReducer.overlayRemainingMs(idle.state, 150L))
    }

    @Test
    fun reconnectSnapshotCarriesCompletionNameWithoutReplayingAnimation() {
        val reconnect = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            MonitorEvent(
                type = MonitorEventType.SNAPSHOT,
                snapshot = MonitorSnapshot(
                    computerState = ComputerState.ONLINE,
                    claudeState = ClaudeState.IDLE,
                    lastSequence = 30L,
                    sessions = emptyList(),
                    runningCount = 0,
                    sessionCount = 0,
                    recentCompletion = RecentCompletion(
                        sessionId = "session-a",
                        taskId = "task-a1",
                        sequence = 29L,
                        occurredAt = "2026-10-06T01:02:03Z",
                        displayName = "release prep",
                    ),
                ),
            ),
            nowMs = 5_000L,
        )

        assertTrue(reconnect.accepted)
        assertNull(reconnect.state.overlayState)
        assertEquals(PetState.IDLE, MonitorPresentationReducer.effectivePetState(reconnect.state, 5_000L))
    }

    @Test
    fun offlineStillOutranksSessionActivityAndOutcomeOverlays() {
        val offline = MonitorPresentationReducer.reduce(
            MonitorPresentationState(),
            MonitorEvent(
                type = MonitorEventType.SNAPSHOT,
                snapshot = MonitorSnapshot(
                    computerState = ComputerState.OFFLINE,
                    claudeState = ClaudeState.WORKING,
                    sessions = listOf(SessionSummary("s1", "working", ClaudeState.WORKING, 1L)),
                ),
            ),
            nowMs = 0L,
        ).state

        assertEquals(PetState.OFFLINE, MonitorPresentationReducer.effectivePetState(offline, 0L))
    }

    private fun outcomeEvent(sequence: Long, name: MonitorEventName) = MonitorEvent(
        type = MonitorEventType.EVENT,
        name = name,
        sequence = sequence,
    )

    private fun snapshotEvent(
        sequence: Long,
        computerState: ComputerState = ComputerState.ONLINE,
        claudeState: ClaudeState,
        activity: String? = null,
    ) = MonitorEvent(
        type = MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(
            computerState = computerState,
            claudeState = claudeState,
            activity = activity,
            lastSequence = sequence,
        ),
        sequence = sequence,
        activity = activity,
    )
}
