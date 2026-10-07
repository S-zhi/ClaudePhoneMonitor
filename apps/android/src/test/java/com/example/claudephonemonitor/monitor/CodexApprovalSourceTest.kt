package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModelStore
import com.example.claudephonemonitor.ui.approvalTitle
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.StandardTestDispatcher
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
class CodexApprovalSourceTest {
    @Test fun nativeV5IdentityRoundTripsWhileDecisionClaimsAndRemoteAvailabilityFailClosed() {
        val pending = requireNotNull(MonitorEvent.fromWireJson(wire("approval_requested", "pending")))
        assertEquals(ApprovalSource.CODEX, pending.approval?.source)
        assertEquals(REQUEST_ID, pending.approval?.requestId)
        assertEquals(pending, MonitorEvent.fromWireJson(pending.toWireJson()))
        val resolved = requireNotNull(MonitorEvent.fromWireJson(wire("approval_resolved", "resolved")))
        assertEquals(ApprovalStatus.RESOLVED, resolved.approval?.status)
        assertEquals("Handled on computer", approvalTitle(requireNotNull(resolved.approval).status))
        assertNull(MonitorEvent.fromWireJson(wire("approval_requested", "pending").replace("false", "true")))
        listOf("approved", "denied").forEach { invalid ->
            assertNull(MonitorEvent.fromWireJson(wire("approval_resolved", invalid)))
        }
        assertNull(MonitorEvent.fromWireJson(wire("approval_resolved", "resolved").replace("\"codex\"", "\"claude_code\"")))
        val snapshot = MonitorEvent(MonitorEventType.SNAPSHOT, snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE,
            lastSequence = 2, approvals = listOf(summary())))
        assertEquals(ApprovalSource.CODEX, MonitorEvent.fromWireJson(snapshot.toWireJson())?.snapshot?.approvals?.single()?.source)
    }

    @Test fun nativeAuthorityRecoveryKeepsThePendingDeadlineAndFirstResolutionStartsFifteenSeconds() {
        var state = ApprovalPresentationReducer.reduce(ApprovalPresentationState(), snapshot(summary()), 100L)
        val originalDeadline = state.deadlineMs
        state = ApprovalPresentationReducer.reduce(state, snapshot(summary().copy(status = ApprovalStatus.UNKNOWN)), 1_000L)
        assertEquals(ApprovalStatus.UNKNOWN, state.active?.status)
        state = ApprovalPresentationReducer.reduce(state, requireNotNull(MonitorEvent.fromWireJson(wire("approval_requested", "pending", 3))), 1_500L)
        assertEquals(ApprovalStatus.UNKNOWN, state.active?.status)
        state = ApprovalPresentationReducer.reduce(state, snapshot(summary()), 2_000L)
        assertEquals(ApprovalStatus.PENDING, state.active?.status)
        assertFalse(requireNotNull(state.active).canRespond)
        assertEquals(originalDeadline, state.deadlineMs)
        state = ApprovalPresentationReducer.reduce(state, requireNotNull(MonitorEvent.fromWireJson(wire("approval_resolved", "resolved", 3))), 200_000L)
        assertEquals(ApprovalStatus.RESOLVED, state.active?.status)
        assertEquals(215_000L, state.deadlineMs)
        assertEquals(15_000L, ApprovalPresentationReducer.reminder(state, 200_000L)?.remainingMs)
        state = ApprovalPresentationReducer.reduce(state, snapshot(summary()), 210_000L)
        state = ApprovalPresentationReducer.reduce(state, requireNotNull(MonitorEvent.fromWireJson(wire("approval_resolved", "resolved", 4))), 212_000L)
        assertEquals(ApprovalStatus.RESOLVED, state.active?.status)
        assertEquals(215_000L, state.deadlineMs)
        assertNull(ApprovalPresentationReducer.reminder(state, 215_000L))

        var recovered = ApprovalPresentationReducer.reduce(ApprovalPresentationState(), snapshot(summary()), 100L)
        recovered = ApprovalPresentationReducer.reduce(recovered, snapshot(summary().copy(status = ApprovalStatus.UNKNOWN)), 300_100L)
        recovered = ApprovalPresentationReducer.reduce(recovered, snapshot(summary()), 350_000L)
        assertNull(recovered.active)
        assertTrue(recovered.requests[REQUEST_ID]?.isPending == true)
    }

    @Test fun codexSourceCannotSendAnyPhoneDecisionEvenIfAnInMemorySummaryClaimsAvailability() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val queuedEvents = Channel<MonitorEvent>(Channel.UNLIMITED)
            val sent = mutableListOf<MonitorCommand>()
            val client = object : MonitorClient {
                override val events = queuedEvents.receiveAsFlow()
                override val isConnected = MutableStateFlow(false)
                override fun connect() {
                    isConnected.value = true
                    queuedEvents.trySend(snapshot(summary().copy(canRespond = true)))
                }
                override fun disconnect() { isConnected.value = false }
                override fun send(command: MonitorCommand) { sent += command }
            }
            val vm = MonitorViewModel(client) { testScheduler.currentTime }.also { store.put("native", it) }
            runCurrent()
            ApprovalDecision.entries.forEach { vm.decideApproval(REQUEST_ID, it) }
            assertTrue(sent.isEmpty())
            assertTrue(vm.uiState.value.approvalDecisionsInFlight.isEmpty())
            assertEquals(ApprovalSource.CODEX, vm.uiState.value.approvalReminder?.request?.source)
        } finally { store.clear(); kotlinx.coroutines.Dispatchers.resetMain() }
    }

    private fun summary() = ApprovalSummary(REQUEST_ID, "codex:native-session", "codex:native-turn", "Current native task",
        2, AT, ApprovalStatus.PENDING, false, source = ApprovalSource.CODEX)
    private fun snapshot(summary: ApprovalSummary) = MonitorEvent(MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, lastSequence = 3, approvals = listOf(summary)))
    private fun wire(type: String, status: String, sequence: Long = 2) = """{"type":"event","event_type":"$type","sequence":$sequence,"session_id":"codex:native-session","task_id":"codex:native-turn","occurred_at":"$AT","payload":{"request_id":"$REQUEST_ID","source":"codex","status":"$status","can_respond":false}}"""

    companion object {
        private const val REQUEST_ID = "11111111-1111-5111-8111-111111111111"
        private const val AT = "2026-10-07T01:00:00Z"
    }
}
