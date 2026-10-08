package com.example.claudephonemonitor.ui

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.claudephonemonitor.monitor.MonitorClient
import com.example.claudephonemonitor.monitor.MonitorCommand
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.ReminderStrength
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Parsed wire fixtures drive the production ViewModel and screen with their real Android timer. */
@RunWith(AndroidJUnit4::class)
class ReminderTimingDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun fiveMinuteCompletionUsesFiveRealSecondsAndKeepsStatusVisible() = withMonitor { vm, client ->
        val startedAt = finish(vm, client, durationMs = 300_000L)
        assertEquals(ReminderStrength.WEAK, vm.uiState.value.stateChange?.strength)
        assertEquals(MonitorPage.STATUS, selectMonitorPage(vm.uiState.value))
        compose.onNodeWithTag("weak-reminder").assertIsDisplayed()
        compose.onNodeWithTag("session-list").assertIsDisplayed()
        compose.onNodeWithTag("state-change-title").assertDoesNotExist()

        // Compose's animation clock is frozen: only the production monotonic timer can expire this.
        waitUntilElapsed(startedAt, 4_000L)
        assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
        compose.waitUntil(3_000L) { vm.uiState.value.stateChange == null }
        assertRealDuration(startedAt, 5_000L)
        assertEquals("timed-main", vm.uiState.value.recentSessionCompletion?.sessionId)
        refreshScreen()
        compose.onNodeWithTag("weak-reminder").assertDoesNotExist()
        compose.onNodeWithTag("session-list").assertIsDisplayed()
    }

    @Test fun longCompletionUsesFifteenRealSecondsAndRestoresUsageAfterAWeakFailure() = withMonitor(usage = true) { vm, client ->
        val startedAt = finish(vm, client, durationMs = 300_001L)
        assertEquals(ReminderStrength.STRONG, vm.uiState.value.stateChange?.strength)
        assertEquals(MonitorPage.STATE_CHANGE, selectMonitorPage(vm.uiState.value))
        compose.onNodeWithTag("state-change-title").assertIsDisplayed()
        compose.onNodeWithText("Usage 用量消耗").assertDoesNotExist()
        compose.onNodeWithTag("weak-reminder").assertDoesNotExist()
        val firstDeadline = SystemClock.elapsedRealtime() + requireNotNull(vm.uiState.value.stateChange).remainingMs

        waitUntilElapsed(startedAt, 2_000L)
        compose.runOnUiThread {
            client.emit("""{"type":"event","event_type":"tool_failed","session_id":"other-main","task_id":"short-turn","sequence":3,"session_kind":"main","occurred_at":"2026-10-07T01:00:01Z"}""")
        }
        compose.waitUntil(2_000L) { vm.uiState.value.snapshot.lastSequence == 3L }
        val afterFailure = requireNotNull(vm.uiState.value.stateChange)
        assertEquals(PetState.FINISH, afterFailure.status)
        assertEquals(ReminderStrength.STRONG, afterFailure.strength)
        assertEquals("Timed main task", afterFailure.completionName)
        val afterFailureDeadline = SystemClock.elapsedRealtime() + afterFailure.remainingMs
        assertTrue("A weak tool failure must keep the original strong deadline", kotlin.math.abs(afterFailureDeadline - firstDeadline) <= 500L)

        waitUntilElapsed(startedAt, 14_000L)
        assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
        compose.waitUntil(3_000L) { vm.uiState.value.stateChange == null }
        assertRealDuration(startedAt, 15_000L)
        assertEquals("timed-main", vm.uiState.value.recentSessionCompletion?.sessionId)
        assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))
        refreshScreen()
        compose.onNodeWithTag("state-change-title").assertDoesNotExist()
        compose.onNodeWithTag("weak-reminder").assertDoesNotExist()
        compose.onNodeWithText("Usage 用量消耗").assertIsDisplayed()
    }

    private fun withMonitor(usage: Boolean = false, test: (MonitorViewModel, FixtureClient) -> Unit) {
        val store = ViewModelStore()
        val client = FixtureClient()
        lateinit var vm: MonitorViewModel
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnUiThread {
                vm = MonitorViewModel(client).also { store.put("timed-monitor", it) }
                if (usage) vm.showUsagePage()
            }
            compose.waitUntil(2_000L) { vm.uiState.value.isConnected && vm.uiState.value.snapshot.lastSequence == 1L }
            compose.setContent {
                val state by vm.uiState.collectAsState()
                PhoneMonitorTheme { MonitorScreen(state, {}, {}, {}, {}, {}, {}) }
            }
            refreshScreen()
            test(vm, client)
        } finally {
            compose.runOnUiThread { store.clear() }
        }
    }

    private fun finish(vm: MonitorViewModel, client: FixtureClient, durationMs: Long): Long {
        var startedAt = 0L
        compose.runOnUiThread {
            startedAt = SystemClock.elapsedRealtime()
            client.emit("""{"type":"event","event_type":"task_finished","session_id":"timed-main","task_id":"timed-turn","session_title":"Timed main task","session_kind":"main","sequence":2,"occurred_at":"2026-10-07T01:00:00Z","payload":{"duration_ms":$durationMs}}""")
        }
        compose.waitUntil(2_000L) { vm.uiState.value.stateChange?.status == PetState.FINISH }
        refreshScreen()
        return startedAt
    }

    private fun waitUntilElapsed(startedAt: Long, durationMs: Long) {
        compose.waitUntil(durationMs + 2_000L) { SystemClock.elapsedRealtime() - startedAt >= durationMs }
    }

    private fun assertRealDuration(startedAt: Long, expectedMs: Long) {
        val elapsed = SystemClock.elapsedRealtime() - startedAt
        assertTrue("Expected a real ${expectedMs}ms reminder, observed ${elapsed}ms", elapsed in (expectedMs - 500L)..(expectedMs + 2_000L))
    }

    private fun refreshScreen() {
        compose.mainClock.advanceTimeBy(100L)
        compose.waitForIdle()
    }

    private class FixtureClient : MonitorClient {
        private val queuedEvents = Channel<MonitorEvent>(Channel.UNLIMITED)
        override val events = queuedEvents.receiveAsFlow()
        override val isConnected = MutableStateFlow(false)

        override fun connect() {
            isConnected.value = true
            emit("""{"type":"snapshot","snapshot":{"computer_state":"online","claude_state":"idle","last_sequence":1,"sessions":[{"session_id":"timed-main","title":"Timed main task","claude_state":"idle","session_kind":"main","last_activity_sequence":1}],"main_running_count":0,"main_session_count":1,"total_running_count":0}}""")
        }

        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) = Unit

        fun emit(raw: String) {
            check(queuedEvents.trySend(requireNotNull(MonitorEvent.fromWireJson(raw))).isSuccess)
        }
    }
}
