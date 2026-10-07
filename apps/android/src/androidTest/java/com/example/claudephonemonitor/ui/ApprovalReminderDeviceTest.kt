package com.example.claudephonemonitor.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.claudephonemonitor.monitor.ApprovalDecision
import com.example.claudephonemonitor.monitor.ApprovalReminderUi
import com.example.claudephonemonitor.monitor.ApprovalStatus
import com.example.claudephonemonitor.monitor.ApprovalSummary
import com.example.claudephonemonitor.monitor.AwaitingUserAction
import com.example.claudephonemonitor.monitor.ClaudeState
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.MonitorClient
import com.example.claudephonemonitor.monitor.MonitorCommand
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorSnapshot
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Production ViewModel/screen; injected monotonic time covers five minutes without a real wait. */
@RunWith(AndroidJUnit4::class)
class ApprovalReminderDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun exactFiveMinuteDeadlineRestoresUsageAndKeepsAnApprovalEntry() = withMonitor { vm, client, clock ->
        compose.runOnUiThread { vm.showUsagePage(); client.emit(request()); client.emit(approvalSnapshot()) }
        compose.waitUntil(2_000L) { vm.uiState.value.approvalReminder != null }
        refreshScreen()
        compose.onNodeWithTag("approval-title").assertTextEquals("Awaiting approval")
        compose.onNodeWithTag("approval-task").assertTextEquals("Device approval task")
        compose.onNodeWithTag("approval-allow").performScrollTo().assertIsDisplayed()

        clock.set(299_999L)
        compose.runOnUiThread { client.emit("""{"type":"event","event_type":"task_failed","session_id":"other","sequence":3,"payload":{"duration_ms":600000}}""") }
        compose.waitUntil(2_000L) { vm.uiState.value.approvalReminder?.remainingMs == 1L }
        assertEquals(MonitorPage.APPROVAL, selectMonitorPage(vm.uiState.value))
        assertNull(vm.uiState.value.stateChange)
        clock.set(300_000L)
        compose.waitUntil(2_000L) { vm.uiState.value.approvalReminder == null }
        refreshScreen()
        assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))
        compose.onNodeWithTag("approval-page").assertDoesNotExist()
        compose.onNodeWithTag("pending-approval-banner").assertIsDisplayed()
        compose.onNodeWithTag("approval-inbox-entry").performClick()
        refreshScreen()
        compose.onNodeWithTag("approval-computer").performScrollTo().assertIsDisplayed().performClick()
        assertEquals(ApprovalDecision.COMPUTER, (client.commands.single() as MonitorCommand.DecideApproval).decision)
    }

    @Test fun handledResultRemovesActionsAndRestoresStatusAfterExactlyFifteenSeconds() = withMonitor { vm, client, clock ->
        compose.runOnUiThread { client.emit(request()) }
        compose.waitUntil(2_000L) { vm.uiState.value.approvalReminder != null }
        clock.set(200_000L)
        compose.runOnUiThread { client.emit(resolved()) }
        compose.waitUntil(2_000L) { vm.uiState.value.approvalReminder?.request?.status == ApprovalStatus.APPROVED }
        refreshScreen()
        compose.onNodeWithTag("approval-title").assertTextEquals("Approval sent")
        compose.onNodeWithTag("approval-result").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("approval-allow").assertDoesNotExist()
        compose.onNodeWithTag("approval-deny").assertDoesNotExist()
        compose.onNodeWithTag("approval-computer").assertDoesNotExist()
        assertEquals(15_000L, vm.uiState.value.approvalReminder?.remainingMs)
        clock.set(214_999L)
        compose.runOnUiThread { client.emit(resolved().replace("\"sequence\":3", "\"sequence\":4")) }
        compose.waitUntil(2_000L) { vm.uiState.value.approvalReminder?.remainingMs == 1L }
        assertEquals(MonitorPage.APPROVAL, selectMonitorPage(vm.uiState.value))
        clock.set(215_000L)
        compose.waitUntil(2_000L) { vm.uiState.value.approvalReminder == null }
        assertEquals(MonitorPage.STATUS, selectMonitorPage(vm.uiState.value))
    }

    @Test fun shortLandscapeAndLargeFontsKeepTheComputerEntryAndDisableAmbiguousApprove() {
        val first = ApprovalSummary(REQUEST_ID, "session-a", "task-a", "Device approval task", 2, AT,
            ApprovalStatus.PENDING, true, "Bash")
        val second = first.copy(requestId = "22222222-2222-4222-8222-222222222222", sequence = 3)
        val ui = MonitorUiState(snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, claudeState = ClaudeState.WORKING),
            petState = PetState.WORKING, isConnected = true, approvals = listOf(first, second),
            approvalReminder = ApprovalReminderUi(first, 300_000L))
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.6f)) {
                PhoneMonitorTheme { Box(Modifier.size(560.dp, 300.dp)) { MonitorScreen(ui, {}, {}, {}, {}, {}, {}) } }
            }
        }
        compose.onNodeWithTag("approval-title").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("approval-allow").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("approval-computer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("approval-ambiguous").performScrollTo().assertIsDisplayed()
    }

    @Test fun explicitQuestionsAndInputsKeepTheWaitingIconOnStatusAndUsageWithoutApprovalButtons() {
        val action = AwaitingUserAction("question-session", "question-task", "Device question task", "question", 2,
            "AskUserQuestion", "question-call")
        val state = MutableStateFlow(MonitorUiState(
            snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, claudeState = ClaudeState.WORKING),
            petState = PetState.WORKING, isConnected = true, userActions = listOf(action)))
        compose.setContent {
            val ui by state.collectAsState()
            PhoneMonitorTheme { MonitorScreen(ui, {}, {}, {}, {}, {}, {}) }
        }
        compose.onNodeWithTag("user-action-waiting-icon").assertIsDisplayed()
        compose.onNodeWithText("Awaiting answer").assertIsDisplayed()
        compose.onNodeWithText("Device question task").assertIsDisplayed()
        compose.onNodeWithTag("approval-allow").assertDoesNotExist()
        compose.onNodeWithTag("approval-deny").assertDoesNotExist()
        compose.onNodeWithTag("user-action-entry").performClick()
        compose.onNodeWithText("等待你处理").assertIsDisplayed()
        compose.onNodeWithText("关闭").performClick()
        compose.runOnUiThread { state.value = state.value.copy(usagePageVisible = true,
            userActions = listOf(action.copy(reason = "input"))) }
        compose.onNodeWithText("Awaiting input").assertIsDisplayed()
        compose.onNodeWithTag("user-action-waiting-icon").assertIsDisplayed()
        compose.onNodeWithText("Usage 用量消耗").assertIsDisplayed()
        compose.onNodeWithTag("approval-page").assertDoesNotExist()
        compose.onNodeWithTag("approval-computer").assertDoesNotExist()
    }

    private fun withMonitor(test: (MonitorViewModel, FixtureClient, AtomicLong) -> Unit) {
        val store = ViewModelStore()
        val client = FixtureClient()
        val clock = AtomicLong(0L)
        lateinit var vm: MonitorViewModel
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnUiThread { vm = MonitorViewModel(client, clock::get).also { store.put("approval-device", it) } }
            compose.waitUntil(2_000L) { vm.uiState.value.snapshot.lastSequence == 1L }
            compose.setContent {
                val ui by vm.uiState.collectAsState()
                PhoneMonitorTheme { MonitorScreen(ui, {}, {}, vm::showUsagePage, vm::showStatusPage, {}, {},
                    vm::decideApproval, vm::retryApprovalDecision) }
            }
            refreshScreen()
            test(vm, client, clock)
        } finally {
            compose.runOnUiThread { store.clear() }
        }
    }

    private fun refreshScreen() { compose.mainClock.advanceTimeBy(100L); compose.waitForIdle() }
    private class FixtureClient : MonitorClient {
        private val channel = Channel<MonitorEvent>(Channel.UNLIMITED)
        override val events = channel.receiveAsFlow()
        override val isConnected = MutableStateFlow(false)
        val commands = mutableListOf<MonitorCommand>()
        override fun connect() {
            isConnected.value = true
            emit("""{"type":"snapshot","snapshot":{"installation_id":"device-installation","computer_state":"online","claude_state":"working","last_sequence":1,"sessions":[{"session_id":"session-a","title":"Device approval task","claude_state":"working","last_activity_sequence":1}],"main_running_count":1,"total_running_count":1}}""")
        }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) { commands += command }
        fun emit(wire: String) { check(channel.trySend(requireNotNull(MonitorEvent.fromWireJson(wire))).isSuccess) }
    }

    companion object {
        private const val REQUEST_ID = "11111111-1111-4111-8111-111111111111"
        private const val AT = "2026-10-07T01:00:00Z"
        private fun request() = """{"type":"event","event_type":"approval_requested","session_id":"session-a","task_id":"task-a","sequence":2,"occurred_at":"$AT","payload":{"request_id":"$REQUEST_ID","source":"claude_code","status":"pending","can_respond":true,"tool_name":"Bash","expires_at":"2026-10-07T01:10:00Z"}}"""
        private fun resolved() = """{"type":"event","event_type":"approval_resolved","session_id":"session-a","task_id":"task-a","sequence":3,"occurred_at":"$AT","payload":{"request_id":"$REQUEST_ID","source":"claude_code","status":"approved","can_respond":false}}"""
        private fun approvalSnapshot() = """{"type":"snapshot","snapshot":{"installation_id":"device-installation","computer_state":"online","claude_state":"working","last_sequence":2,"main_running_count":1,"total_running_count":1,"approvals":[{"request_id":"$REQUEST_ID","session_id":"session-a","task_id":"task-a","display_name":"Device approval task","sequence":2,"requested_at":"$AT","source":"claude_code","status":"pending","can_respond":true,"tool_name":"Bash"}]}}"""
    }
}
