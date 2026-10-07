package com.example.claudephonemonitor.monitor

import com.example.claudephonemonitor.monitor.ApprovalPresentationTest.Companion.AT
import com.example.claudephonemonitor.monitor.ApprovalPresentationTest.Companion.EXPIRES
import com.example.claudephonemonitor.monitor.ApprovalPresentationTest.Companion.REQUEST_A
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ApprovalWireTest {
    @Test fun lifecycleAndSnapshotsParseAndRoundTripWithoutOperationContent() {
        val request = requireNotNull(MonitorEvent.fromWireJson(requestWire()))
        assertEquals(MonitorEventName.APPROVAL_REQUESTED, request.name)
        assertEquals(REQUEST_A, request.approval?.requestId)
        assertEquals(ApprovalStatus.PENDING, request.approval?.status)
        assertEquals(request, MonitorEvent.fromWireJson(request.toWireJson()))
        val snapshot = requireNotNull(MonitorEvent.fromWireJson(snapshotWire()))
        assertEquals(ApprovalStatus.UNKNOWN, snapshot.snapshot?.approvals?.single()?.status)
        assertFalse(requireNotNull(snapshot.snapshot?.approvals?.single()).canRespond)
        assertEquals(snapshot, MonitorEvent.fromWireJson(snapshot.toWireJson()))
    }

    @Test fun invalidLifecycleIdentitySourceOrActionAvailabilityCannotEnableApproval() {
        listOf(requestWire().replace(REQUEST_A, "session-a"), requestWire().replace("claude_code", "codex"),
            requestWire().replace("pending", "approved"), requestWire().replace("true", "\"true\""),
            requestWire().replace(EXPIRES, "invalid"), requestWire().replace("session-a", "unknown"))
            .forEach { assertNull(MonitorEvent.fromWireJson(it)) }
        val invalidResolved = requestWire().replace("approval_requested", "approval_resolved")
            .replace("pending", "denied") // can_respond must be false for all result states.
        assertNull(MonitorEvent.fromWireJson(invalidResolved))
    }

    @Test fun resultOnlySnapshotDoesNotCreateAStrongPageAndAmbiguousIdsExposeNoAction() {
        val snapshot = requireNotNull(MonitorEvent.fromWireJson(snapshotWire()))
        assertNull(ApprovalPresentationReducer.reduce(ApprovalPresentationState(), snapshot, 0L).active)
        val duplicateRecord = snapshotWire().substringAfter("\"approvals\":[").substringBeforeLast("]")
        val ambiguous = snapshotWire().replace("\"approvals\":[$duplicateRecord]", "\"approvals\":[$duplicateRecord,$duplicateRecord]")
        assertEquals(emptyList<ApprovalSummary>(), MonitorEvent.fromWireJson(ambiguous)?.snapshot?.approvals)
    }

    private fun requestWire() = """{"type":"event","event_type":"approval_requested","sequence":2,"session_id":"session-a","task_id":"task-a","occurred_at":"$AT","payload":{"request_id":"$REQUEST_A","source":"claude_code","status":"pending","can_respond":true,"tool_name":"Bash","expires_at":"$EXPIRES"}}"""
    private fun snapshotWire() = """{"type":"snapshot","snapshot":{"computer_state":"online","claude_state":"working","last_sequence":3,"approvals":[{"request_id":"$REQUEST_A","session_id":"session-a","task_id":"task-a","display_name":"Task A","sequence":2,"requested_at":"$AT","resolved_at":"$AT","source":"claude_code","status":"unknown","can_respond":false}]}}"""
}
