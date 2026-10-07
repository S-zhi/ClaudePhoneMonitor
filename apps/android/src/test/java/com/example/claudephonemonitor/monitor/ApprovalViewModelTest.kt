package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModelStore
import com.example.claudephonemonitor.monitor.ApprovalPresentationTest.Companion.AT
import com.example.claudephonemonitor.monitor.ApprovalPresentationTest.Companion.EXPIRES
import com.example.claudephonemonitor.monitor.ApprovalPresentationTest.Companion.REQUEST_A
import com.example.claudephonemonitor.monitor.ApprovalPresentationTest.Companion.REQUEST_B
import com.example.claudephonemonitor.ui.MonitorPage
import com.example.claudephonemonitor.ui.selectMonitorPage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ApprovalViewModelTest {
    @Test fun pinnedWireRequestKeepsLatestStateAndAtFiveMinutesRestoresUsageWithPendingApproval() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = FixtureClient()
            val vm = MonitorViewModel(client) { testScheduler.currentTime }.also { store.put("approval", it) }
            runCurrent()
            vm.showUsagePage()
            client.emit(request())
            runCurrent()
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(vm.uiState.value))
            assertEquals("Target task", vm.uiState.value.approvalReminder?.request?.displayName)
            assertEquals(300_000L, vm.uiState.value.approvalReminder?.remainingMs)

            advanceTimeBy(100_000L)
            client.emit("""{"type":"event","event_type":"task_failed","session_id":"other","task_id":"other-task","sequence":3,"payload":{"duration_ms":600000}}""")
            client.emit(snapshot(3, "working"))
            runCurrent()
            assertEquals(PetState.WORKING, vm.uiState.value.petState)
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(vm.uiState.value))
            assertNull(vm.uiState.value.stateChange)
            vm.showStatusPage()
            vm.showUsagePage()
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(vm.uiState.value))

            advanceTimeBy(199_900L)
            runCurrent()
            assertEquals(100L, vm.uiState.value.approvalReminder?.remainingMs)
            advanceTimeBy(100L)
            runCurrent()
            assertNull(vm.uiState.value.approvalReminder)
            assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))
            assertEquals(PetState.WORKING, vm.uiState.value.petState)
            assertTrue(vm.uiState.value.approvals.single().isPending)

            client.emit(snapshot(3, "working", approvalRecord()))
            runCurrent()
            assertNull(vm.uiState.value.approvalReminder)
            assertTrue(vm.uiState.value.approvals.single().isPending)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test fun handledResultRestoresLatestUsageAfterFifteenSecondsAndCannotBeExtendedOrReopened() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = FixtureClient()
            val vm = MonitorViewModel(client) { testScheduler.currentTime }.also { store.put("approval", it) }
            runCurrent()
            vm.showUsagePage()
            client.emit(request())
            runCurrent()
            advanceTimeBy(240_000L)
            client.emit(resolved("approved", 3))
            runCurrent()
            assertEquals(ApprovalStatus.APPROVED, vm.uiState.value.approvalReminder?.request?.status)
            assertEquals(15_000L, vm.uiState.value.approvalReminder?.remainingMs)
            assertFalse(requireNotNull(vm.uiState.value.approvalReminder).request.canRespond)
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(vm.uiState.value))

            advanceTimeBy(5_000L)
            client.emit(resolved("approved", 4))
            client.emit(snapshot(5, "working", approvalRecord().replace("pending", "approved").replace("true", "false")))
            client.disconnect()
            client.emit("""{"type":"disconnected"}""")
            client.connect()
            client.emit(snapshot(6, "working", approvalRecord().replace("pending", "approved").replace("true", "false")))
            client.emit("""{"type":"event","event_type":"task_failed","session_id":"other","task_id":"other-task","sequence":7,"payload":{"duration_ms":600000}}""")
            client.emit(snapshot(8, "working"))
            runCurrent()
            assertEquals(10_000L, vm.uiState.value.approvalReminder?.remainingMs)
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(vm.uiState.value))
            assertNull(vm.uiState.value.stateChange)
            advanceTimeBy(9_900L)
            runCurrent()
            assertEquals(100L, vm.uiState.value.approvalReminder?.remainingMs)
            advanceTimeBy(100L)
            runCurrent()
            assertNull(vm.uiState.value.approvalReminder)
            assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))
            assertEquals(PetState.WORKING, vm.uiState.value.petState)
            client.emit(resolved("approved", 9))
            runCurrent()
            assertNull(vm.uiState.value.approvalReminder)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test fun snapshotBeforeEqualSequenceRequestCannotRestartThePinAndQueuedResultNeverShows() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = FixtureClient()
            val vm = MonitorViewModel(client) { testScheduler.currentTime }.also { store.put("approval", it) }
            runCurrent()
            client.emit(snapshot(2, "working", approvalRecord()))
            runCurrent()
            advanceTimeBy(5_000L)
            client.emit(request())
            client.emit(request(REQUEST_B, 3))
            client.emit(resolved("denied", 4, REQUEST_B))
            runCurrent()
            assertEquals(REQUEST_A, vm.uiState.value.approvalReminder?.request?.requestId)
            assertEquals(295_000L, vm.uiState.value.approvalReminder?.remainingMs)
            advanceTimeBy(295_000L)
            runCurrent()
            assertNull(vm.uiState.value.approvalReminder)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test fun commandsAreIdentityBoundPreventDoubleClicksAndRetryOnlyTheSameDecisionAfterDisconnect() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = FixtureClient()
            val vm = MonitorViewModel(client) { testScheduler.currentTime }.also { store.put("approval", it) }
            runCurrent()
            client.emit(request())
            client.emit(snapshot(2, "working", approvalRecord()))
            runCurrent()
            vm.decideApproval(REQUEST_A, ApprovalDecision.DENY)
            vm.decideApproval(REQUEST_A, ApprovalDecision.ALLOW)
            assertEquals(1, client.commands.size)
            val first = client.commands.single() as MonitorCommand.DecideApproval
            val wire = JSONObject(first.toWireJson())
            assertEquals("installation-a", wire.getString("installation_id"))
            assertEquals(REQUEST_A, wire.getString("request_id"))
            assertEquals("deny", wire.getString("decision"))
            assertTrue(vm.uiState.value.approvalReminder?.decisionPending == true)

            client.disconnect()
            client.emit("""{"type":"disconnected"}""")
            runCurrent()
            assertTrue(vm.uiState.value.approvalReminder?.decisionUncertain == true)
            assertFalse(vm.uiState.value.approvalReminder?.decisionPending == true)
            vm.decideApproval(REQUEST_A, ApprovalDecision.ALLOW)
            vm.retryApprovalDecision(REQUEST_A)
            assertEquals(1, client.commands.size)

            client.connect()
            client.emit(snapshot(2, "working", approvalRecord()))
            runCurrent()
            vm.decideApproval(REQUEST_A, ApprovalDecision.ALLOW)
            vm.retryApprovalDecision(REQUEST_A)
            assertEquals(2, client.commands.size)
            assertEquals(first, client.commands.last())
            client.emit("""{"type":"approval_decision_ack","request_id":"$REQUEST_A","decision_id":"${first.decisionId}","accepted":true,"reason":"forwarded"}""")
            runCurrent()
            assertEquals(ApprovalStatus.PENDING, vm.uiState.value.approvalReminder?.request?.status)
            client.emit(resolved("denied", 3))
            runCurrent()
            assertFalse(vm.uiState.value.approvalReminder?.decisionPending == true)
            assertTrue(vm.uiState.value.approvalDecisionsInFlight.isEmpty())
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test fun acknowledgementAtThePreviousDeadlinePersistsTheQueuedRequestsFirstDisplayTime() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        var clock = 0L
        try {
            val client = FixtureClient()
            val vm = MonitorViewModel(client) { clock }.also { store.put("approval", it) }
            runCurrent()
            client.emit(request())
            client.emit(request(REQUEST_B, 3))
            runCurrent()
            clock = 300_000L
            client.emit("""{"type":"approval_decision_ack","request_id":"$REQUEST_A","decision_id":"33333333-3333-4333-8333-333333333333","accepted":false}""")
            runCurrent()
            assertEquals(REQUEST_B, vm.uiState.value.approvalReminder?.request?.requestId)
            assertEquals(300_000L, vm.uiState.value.approvalReminder?.remainingMs)
            clock = 300_050L
            advanceTimeBy(100L)
            runCurrent()
            assertEquals(299_950L, vm.uiState.value.approvalReminder?.remainingMs)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    private class FixtureClient : MonitorClient {
        private val channel = Channel<MonitorEvent>(Channel.UNLIMITED)
        override val events = channel.receiveAsFlow()
        override val isConnected = MutableStateFlow(false)
        val commands = mutableListOf<MonitorCommand>()
        override fun connect() {
            isConnected.value = true
            emit(snapshot(1, "working"))
        }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) { commands += command }
        fun emit(wire: String) { check(channel.trySend(requireNotNull(MonitorEvent.fromWireJson(wire))).isSuccess) }
    }

    companion object {
        private fun request(id: String = REQUEST_A, sequence: Long = 2) = """{
          "type":"event","event_type":"approval_requested","session_id":"target","task_id":"target-task",
          "sequence":$sequence,"occurred_at":"$AT",
          "payload":{"request_id":"$id","source":"claude_code","status":"pending","can_respond":true,"tool_name":"Bash","expires_at":"$EXPIRES"}
        }""".trimIndent()
        private fun resolved(status: String, sequence: Long, id: String = REQUEST_A) = """{
          "type":"event","event_type":"approval_resolved","session_id":"target","task_id":"target-task",
          "sequence":$sequence,"occurred_at":"$AT",
          "payload":{"request_id":"$id","source":"claude_code","status":"$status","can_respond":false}
        }""".trimIndent()
        private fun approvalRecord() = """{
          "request_id":"$REQUEST_A","session_id":"target","task_id":"target-task","display_name":"Target task",
          "sequence":2,"requested_at":"$AT","source":"claude_code","status":"pending","can_respond":true,"tool_name":"Bash","expires_at":"$EXPIRES"
        }""".trimIndent()
        private fun snapshot(sequence: Long, state: String, approval: String? = null) = """{
          "type":"snapshot","snapshot":{"installation_id":"installation-a","computer_state":"online","claude_state":"$state",
          "last_sequence":$sequence,"sessions":[{"session_id":"target","title":"Target task","claude_state":"waiting","last_activity_sequence":$sequence}],
          "main_running_count":1,"total_running_count":1${approval?.let { ",\"approvals\":[$it]" } ?: ""}}
        }""".trimIndent()
    }
}
