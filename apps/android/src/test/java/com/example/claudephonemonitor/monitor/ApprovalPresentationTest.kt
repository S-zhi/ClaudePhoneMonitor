package com.example.claudephonemonitor.monitor

import com.example.claudephonemonitor.ui.MonitorPage
import com.example.claudephonemonitor.ui.selectMonitorPage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalPresentationTest {
    @Test fun actualRequestImmediatelyOwnsExactlyFiveMinutes() {
        val state = reduce(ApprovalPresentationState(), request(), 100L)
        assertEquals("Task awaiting permission", state.active?.displayName)
        assertEquals(300_100L, state.deadlineMs)
        assertEquals(300_000L, reminder(state, 100L)?.remainingMs)
        assertEquals(1L, reminder(state, 300_099L)?.remainingMs)
        assertNull(reminder(state, 300_100L))
        assertTrue(ApprovalPresentationReducer.expire(state, 300_100L).requests[REQUEST_A]?.isPending == true)
    }

    @Test fun duplicatesRefreshesAndReconnectCannotRestartASeenRequest() {
        var state = reduce(ApprovalPresentationState(), request(), 100L)
        state = reduce(state, request(sequence = 3), 5_000L)
        state = reduce(state, snapshot(summary().copy(displayName = "Authoritative name")), 20_000L)
        assertEquals(300_100L, state.deadlineMs)
        assertEquals("Authoritative name", state.active?.displayName)
        state = reduce(state, MonitorEvent(MonitorEventType.DISCONNECTED), 21_000L)
        assertFalse(requireNotNull(state.active).canRespond)
        state = reduce(state, snapshot(summary()), 50_000L)
        assertEquals(300_100L, state.deadlineMs)
        state = reduce(state, snapshot(summary()), 300_100L)
        assertNull(state.active)
        state = reduce(state, request(sequence = 5), 400_000L)
        assertNull(state.active)
        assertTrue(state.requests[REQUEST_A]?.isPending == true)
    }

    @Test fun snapshotFirstThenLiveRequestUsesTheSameOriginalDeadline() {
        var state = reduce(ApprovalPresentationState(), snapshot(summary()), 10L)
        state = reduce(state, request(), 200L)
        assertEquals(300_010L, state.deadlineMs)
        assertEquals(1, state.displayedRequestIds.size)
        assertEquals(1, state.requests.size)
    }

    @Test fun unrelatedEventsAndSnapshotsCannotCloseReplaceOrNavigateThePage() {
        var state = reduce(ApprovalPresentationState(), request(), 100L)
        MonitorEventName.entries.filter { it !in setOf(MonitorEventName.APPROVAL_REQUESTED, MonitorEventName.APPROVAL_RESOLVED) }
            .forEachIndexed { index, name ->
                state = reduce(state, MonitorEvent(MonitorEventType.EVENT, name = name, sequence = 10L + index,
                    sessionId = "other", durationMs = 600_000L), 1_000L + index)
                assertEquals(REQUEST_A, state.active?.requestId)
                assertEquals(300_100L, state.deadlineMs)
                val ui = MonitorUiState(petState = PetState.WORKING, usagePageVisible = true,
                    stateChange = StateChangeUi(PetState.ERROR, 15_000L, strength = ReminderStrength.STRONG),
                    approvalReminder = reminder(state, 2_000L))
                assertEquals(MonitorPage.APPROVAL, selectMonitorPage(ui))
            }
        state = reduce(state, snapshot(), 3_000L)
        assertEquals(REQUEST_A, state.active?.requestId)
        assertEquals(300_100L, state.deadlineMs)
        assertFalse(requireNotNull(state.active).canRespond)
    }

    @Test fun handledResultsStayOnTheSamePageForFifteenSecondsWithoutRefreshOrReconnectExtendingThem() {
        listOf(ApprovalStatus.APPROVED, ApprovalStatus.DENIED).forEach { result ->
            var state = reduce(ApprovalPresentationState(), request(), 100L)
            state = reduce(state, resolved(result), 220_000L)
            assertEquals(result, state.active?.status)
            assertFalse(requireNotNull(state.active).canRespond)
            assertEquals(235_000L, state.deadlineMs)
            assertEquals(15_000L, reminder(state, 220_000L)?.remainingMs)
            state = reduce(state, resolved(result, sequence = 4), 225_000L)
            state = reduce(state, snapshot(summary().copy(status = result, canRespond = false)), 230_000L)
            state = reduce(state, MonitorEvent(MonitorEventType.DISCONNECTED), 231_000L)
            state = reduce(state, snapshot(summary()), 234_000L)
            assertEquals(result, state.active?.status)
            assertEquals(235_000L, state.deadlineMs)
            assertEquals(1L, reminder(state, 234_999L)?.remainingMs)
            assertNull(reminder(state, 235_000L))
            assertNull(reduce(state, resolved(result, sequence = 5), 236_000L).active)
        }
    }

    @Test fun lateHandledResultGetsAllFifteenSecondsAcrossTheOldFiveMinuteBoundary() {
        var state = reduce(ApprovalPresentationState(), request(), 0L)
        state = reduce(state, resolved(ApprovalStatus.APPROVED), 299_999L)
        assertEquals(314_999L, state.deadlineMs)
        assertEquals(14_999L, reminder(state, 300_000L)?.remainingMs)
        assertEquals(1L, reminder(state, 314_998L)?.remainingMs)
        assertNull(reminder(state, 314_999L))
    }

    @Test fun unknownDoesNotClaimHandlingAndResultsAtOrAfterExpiryNeverReopenThePage() {
        var unknown = reduce(ApprovalPresentationState(), request(), 100L)
        unknown = reduce(unknown, resolved(ApprovalStatus.UNKNOWN), 220_000L)
        assertEquals(300_100L, unknown.deadlineMs)
        assertEquals(80_100L, reminder(unknown, 220_000L)?.remainingMs)
        listOf(300_100L, 400_000L).forEach { now ->
            val state = reduce(reduce(ApprovalPresentationState(), request(), 100L), resolved(ApprovalStatus.APPROVED), now)
            assertNull(state.active)
            assertEquals(ApprovalStatus.APPROVED, state.requests[REQUEST_A]?.status)
        }
    }

    @Test fun snapshotFirstResultAndQueuedRequestsRespectTheFirstResultDisplayDeadline() {
        var state = reduce(ApprovalPresentationState(), request(), 100L)
        state = reduce(state, request(REQUEST_B, 3), 1_000L)
        val handled = summary().copy(status = ApprovalStatus.DENIED, canRespond = false)
        state = reduce(state, snapshot(handled, summary(REQUEST_B)), 2_000L)
        assertEquals(17_000L, state.deadlineMs)
        state = reduce(state, resolved(ApprovalStatus.DENIED, sequence = 4), 3_000L)
        assertEquals(17_000L, state.deadlineMs)
        assertEquals(REQUEST_A, reminder(state, 16_999L)?.request?.requestId)
        state = ApprovalPresentationReducer.expire(state, 17_000L)
        assertEquals(REQUEST_B, state.active?.requestId)
        assertEquals(317_000L, state.deadlineMs)
    }

    @Test fun aResultFromAnotherRequestSessionOrTaskCannotChangeThePinnedRequest() {
        val initial = reduce(ApprovalPresentationState(), request(), 100L)
        listOf(resolved(ApprovalStatus.APPROVED, REQUEST_B),
            resolved(ApprovalStatus.APPROVED).copy(sessionId = "unrelated"),
            resolved(ApprovalStatus.APPROVED).copy(taskId = "unrelated-task")).forEach { event ->
            val state = reduce(initial, event, 1_000L)
            assertEquals(ApprovalStatus.PENDING, state.active?.status)
            assertEquals(300_100L, state.deadlineMs)
        }
    }

    @Test fun ordinaryWaitingSilenceAndResolvedOnlyRecordsNeverCreateApprovalPages() {
        listOf("permission", "approval", "input", "unknown", null).forEach { reason ->
            val state = reduce(ApprovalPresentationState(), MonitorEvent(MonitorEventType.EVENT,
                name = MonitorEventName.WAITING, waitingReason = reason, sessionId = "session-a", sequence = 1), 100L)
            assertNull(state.active)
        }
        assertNull(reduce(ApprovalPresentationState(), resolved(ApprovalStatus.APPROVED), 100L).active)
        assertNull(reduce(ApprovalPresentationState(), snapshot(summary().copy(status = ApprovalStatus.APPROVED,
            canRespond = false)), 100L).active)
    }

    @Test fun independentRequestsWaitUntilTheirFirstActualDisplayToStartTiming() {
        var state = reduce(ApprovalPresentationState(), request(), 100L)
        state = reduce(state, request(REQUEST_B, 3), 20_000L)
        assertEquals(REQUEST_A, state.active?.requestId)
        assertEquals(setOf(REQUEST_A), state.displayedRequestIds)
        state = ApprovalPresentationReducer.expire(state, 300_100L)
        assertEquals(REQUEST_B, state.active?.requestId)
        assertEquals(600_100L, state.deadlineMs)
        assertEquals(300_000L, reminder(state, 300_100L)?.remainingMs)
    }

    @Test fun queuedRequestsResolvedBeforeDisplayNeverProduceAResultPage() {
        var state = reduce(ApprovalPresentationState(), request(), 100L)
        state = reduce(state, request(REQUEST_B, 3), 1_000L)
        state = reduce(state, resolved(ApprovalStatus.DENIED, REQUEST_B, 4), 2_000L)
        state = ApprovalPresentationReducer.expire(state, 300_100L)
        assertNull(state.active)
        assertFalse(REQUEST_B in state.displayedRequestIds)
    }

    @Test fun durableResultCannotBecomeActionableAfterAStalePendingRefresh() {
        var state = reduce(ApprovalPresentationState(), request(), 100L)
        state = reduce(state, resolved(ApprovalStatus.APPROVED), 200L)
        state = reduce(state, snapshot(summary()), 300L)
        assertEquals(ApprovalStatus.APPROVED, state.active?.status)
        assertFalse(requireNotNull(state.requests[REQUEST_A]).canRespond)
        state = reduce(state, resolved(ApprovalStatus.UNKNOWN, sequence = 4), 400L)
        assertEquals(ApprovalStatus.APPROVED, state.active?.status)
    }

    @Test fun transportAcknowledgementDoesNotClaimAResultOrMoveTheDeadline() {
        var state = reduce(ApprovalPresentationState(), request(), 100L)
        state = state.copy(pendingDecisions = mapOf(REQUEST_A to PendingApprovalDecision(DECISION_A, ApprovalDecision.ALLOW)))
        state = ApprovalPresentationReducer.acknowledge(state, ApprovalDecisionAck(REQUEST_A, DECISION_A, true))
        assertEquals(ApprovalStatus.PENDING, state.active?.status)
        assertTrue(reminder(state, 200L)?.decisionPending == true)
        assertEquals(300_100L, state.deadlineMs)
        state = ApprovalPresentationReducer.acknowledge(state, ApprovalDecisionAck(REQUEST_A, REQUEST_B, false))
        assertTrue(reminder(state, 200L)?.decisionPending == true)
        state = ApprovalPresentationReducer.acknowledge(state, ApprovalDecisionAck(REQUEST_A, DECISION_A, false))
        assertFalse(reminder(state, 200L)?.decisionPending == true)
        assertTrue(reminder(state, 200L)?.decisionFailed == true)
        assertTrue(reminder(state, 200L)?.decisionUncertain == true)
        assertEquals(DECISION_A, state.pendingDecisions[REQUEST_A]?.decisionId)
        assertEquals(300_100L, state.deadlineMs)
    }

    @Test fun disconnectionKeepsTheOriginalDecisionButMakesDeliveryUncertaintyVisible() {
        var state = reduce(ApprovalPresentationState(), request(), 100L)
        state = state.copy(pendingDecisions = mapOf(REQUEST_A to PendingApprovalDecision(DECISION_A, ApprovalDecision.DENY)))
        state = reduce(state, MonitorEvent(MonitorEventType.DISCONNECTED), 200L)
        assertFalse(reminder(state, 200L)?.decisionPending == true)
        assertTrue(reminder(state, 200L)?.decisionUncertain == true)
        assertEquals(ApprovalDecision.DENY, state.pendingDecisions[REQUEST_A]?.decision)
        state = reduce(state, snapshot(summary()), 300L)
        assertTrue(requireNotNull(state.active).canRespond)
        assertTrue(reminder(state, 300L)?.decisionUncertain == true)
        assertEquals(300_100L, state.deadlineMs)
        state = reduce(state, resolved(ApprovalStatus.DENIED), 400L)
        assertTrue(state.pendingDecisions.isEmpty())
    }

    @Test fun eventPayloadCannotElevateAvailabilityAgainstItsOwnAuthoritativeSnapshot() {
        val incoming = request().copy(snapshot = snapshot(summary().copy(canRespond = false)).snapshot)
        val state = reduce(ApprovalPresentationState(), incoming, 100L)
        assertFalse(requireNotNull(state.active).canRespond)
        val omitted = reduce(state, request(sequence = 4).copy(snapshot = snapshot().snapshot), 200L)
        assertFalse(requireNotNull(omitted.active).canRespond)
        assertEquals(300_100L, omitted.deadlineMs)
    }

    private fun request(id: String = REQUEST_A, sequence: Long = 2) = MonitorEvent(
        type = MonitorEventType.EVENT, name = MonitorEventName.APPROVAL_REQUESTED,
        sessionId = "session-a", taskId = "task-a", sessionTitle = "Task awaiting permission", sequence = sequence,
        occurredAt = AT, approval = ApprovalEventMetadata(id, ApprovalStatus.PENDING, true, "Bash", EXPIRES),
    )
    private fun resolved(status: ApprovalStatus, id: String = REQUEST_A, sequence: Long = 3) = request(id, sequence).copy(
        name = MonitorEventName.APPROVAL_RESOLVED, approval = ApprovalEventMetadata(id, status, false),
    )
    private fun summary(id: String = REQUEST_A) = ApprovalSummary(id, "session-a", "task-a",
        "Task awaiting permission", 2, AT, ApprovalStatus.PENDING, true, "Bash", EXPIRES)
    private fun snapshot(vararg approvals: ApprovalSummary) = MonitorEvent(MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, claudeState = ClaudeState.WORKING,
            lastSequence = 10, approvals = approvals.toList()))
    private fun reduce(state: ApprovalPresentationState, event: MonitorEvent, nowMs: Long) =
        ApprovalPresentationReducer.reduce(state, event, nowMs)
    private fun reminder(state: ApprovalPresentationState, nowMs: Long) = ApprovalPresentationReducer.reminder(state, nowMs)

    companion object {
        const val REQUEST_A = "11111111-1111-4111-8111-111111111111"
        const val REQUEST_B = "22222222-2222-4222-8222-222222222222"
        const val DECISION_A = "33333333-3333-4333-8333-333333333333"
        const val AT = "2026-10-07T01:00:00Z"
        const val EXPIRES = "2026-10-07T01:10:00Z"
    }
}
