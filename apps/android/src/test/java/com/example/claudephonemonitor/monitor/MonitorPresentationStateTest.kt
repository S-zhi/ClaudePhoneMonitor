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
        assertEquals(PetState.FINISH, MonitorPresentationReducer.effectivePetState(newerSnapshot.state, 4_000L))
        assertEquals(3_000L, MonitorPresentationReducer.overlayRemainingMs(newerSnapshot.state, 4_000L))

        val oneMillisecondBeforeExpiry = MonitorPresentationReducer.expire(newerSnapshot.state, 6_999L)
        assertEquals(1L, MonitorPresentationReducer.overlayRemainingMs(oneMillisecondBeforeExpiry, 6_999L))
        assertEquals(PetState.FINISH, MonitorPresentationReducer.effectivePetState(oneMillisecondBeforeExpiry, 6_999L))

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
        assertEquals(PetState.FINISH, MonitorPresentationReducer.effectivePetState(nextTask.state, 2_000L))
        assertEquals(4_000L, MonitorPresentationReducer.overlayRemainingMs(nextTask.state, 2_000L))

        val expired = MonitorPresentationReducer.expire(nextTask.state, 6_000L)
        assertNull(expired.overlayState)
        assertEquals(PetState.WORKING, MonitorPresentationReducer.effectivePetState(expired, 6_000L))
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
