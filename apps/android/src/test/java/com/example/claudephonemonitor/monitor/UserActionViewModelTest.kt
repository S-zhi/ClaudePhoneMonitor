package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModelStore
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class UserActionViewModelTest {
    @Test fun questionRemainsAfterFifteenSecondReminderAndNeverOffersRemoteDecisions() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = FixtureClient()
            val vm = MonitorViewModel(client) { testScheduler.currentTime }.also { store.put("question", it) }
            runCurrent()
            vm.showUsagePage()
            client.emit("""{"type":"event","event_type":"waiting","session_id":"target","task_id":"task-target","sequence":2,"occurred_at":"2026-10-07T01:00:00Z","correlation_id":"question-call","payload":{"reason":"question","tool_name":"AskUserQuestion"}}""")
            runCurrent()
            assertEquals(ReminderStrength.STRONG, vm.uiState.value.stateChange?.strength)
            assertEquals("Awaiting answer", vm.uiState.value.stateChange?.userAction?.title)
            assertEquals("Target task", vm.uiState.value.userActions.single().displayName)
            assertNull(vm.uiState.value.approvalReminder)
            assertTrue(vm.uiState.value.approvals.isEmpty())
            advanceTimeBy(15_000L)
            runCurrent()
            assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))
            assertNull(vm.uiState.value.stateChange)
            assertEquals("Awaiting answer", vm.uiState.value.userActions.single().title)
            client.emit("""{"type":"event","event_type":"tool_finished","session_id":"target","task_id":"task-target","sequence":3,"correlation_id":"question-call","payload":{"tool_name":"AskUserQuestion"}}""")
            runCurrent()
            assertTrue(vm.uiState.value.userActions.isEmpty())
            assertTrue(client.commands.isEmpty())
        } finally { store.clear(); kotlinx.coroutines.Dispatchers.resetMain() }
    }

    @Test fun questionDuringPinnedApprovalCannotSwitchItsPageOrResetItsDeadline() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = FixtureClient()
            val vm = MonitorViewModel(client) { testScheduler.currentTime }.also { store.put("question", it) }
            runCurrent()
            vm.showUsagePage()
            client.emit("""{"type":"event","event_type":"approval_requested","session_id":"other","sequence":2,"occurred_at":"2026-10-07T01:00:00Z","payload":{"request_id":"${ApprovalPresentationTest.REQUEST_A}","source":"claude_code","status":"pending","can_respond":false}}""")
            runCurrent()
            advanceTimeBy(1_000L)
            client.emit("""{"type":"event","event_type":"waiting","session_id":"target","task_id":"task-target","sequence":3,"payload":{"reason":"input"}}""")
            runCurrent()
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(vm.uiState.value))
            assertEquals(299_000L, vm.uiState.value.approvalReminder?.remainingMs)
            assertEquals("Awaiting input", vm.uiState.value.userActions.single().title)
            advanceTimeBy(299_000L)
            runCurrent()
            assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))
            assertEquals("Awaiting input", vm.uiState.value.userActions.single().title)
        } finally { store.clear(); kotlinx.coroutines.Dispatchers.resetMain() }
    }

    private class FixtureClient : MonitorClient {
        private val channel = Channel<MonitorEvent>(Channel.UNLIMITED)
        override val events = channel.receiveAsFlow()
        override val isConnected = MutableStateFlow(false)
        val commands = mutableListOf<MonitorCommand>()
        override fun connect() {
            isConnected.value = true
            emit("""{"type":"snapshot","snapshot":{"computer_state":"online","claude_state":"working","last_sequence":1,"main_running_count":1,"total_running_count":1,"sessions":[{"session_id":"target","title":"Target task","claude_state":"working","last_activity_sequence":1}],"active_tasks":[{"session_id":"target","task_id":"task-target","started_at":"2026-10-07T00:50:00Z","elapsed_ms":600000}]}}""")
        }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) { commands += command }
        fun emit(wire: String) { check(channel.trySend(requireNotNull(MonitorEvent.fromWireJson(wire))).isSuccess) }
    }
}
