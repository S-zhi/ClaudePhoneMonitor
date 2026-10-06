package com.example.claudephonemonitor.ui

import androidx.lifecycle.ViewModelStore
import com.example.claudephonemonitor.monitor.MonitorClient
import com.example.claudephonemonitor.monitor.MonitorCommand
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorEventType
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.UsageCoverageStatus
import com.example.claudephonemonitor.monitor.UsageQuality
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class UsageRelayWireIntegrationTest {
    @Test
    fun relaySerializedSnapshotFlowsThroughAndroidViewModelUsagePageAndFormatting() = runTest {
        val rawUsageSnapshot = requireNotNull(javaClass.getResource("/usage-relay-snapshot.json"))
            .readText()
        val wireEvent = requireNotNull(MonitorEvent.fromWireJson(rawUsageSnapshot))
        assertEquals(MonitorEventType.SNAPSHOT, wireEvent.type)
        val wireUsage = requireNotNull(wireEvent.snapshot?.usage)
        assertEquals(1L, wireUsage.revision)
        assertEquals(UsageCoverageStatus.READY, wireUsage.claudeCoverage.status)
        assertEquals(UsageCoverageStatus.READY, wireUsage.codexCoverage.status)
        assertEquals(UsageQuality.COMPLETE, wireUsage.actual.quality)
        assertEquals("unavailable", wireUsage.quota.availability)
        assertNull(wireUsage.quota.startRemaining)
        assertNull(wireUsage.quota.currentRemaining)

        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        try {
            var monotonicMs = 100L
            val client = UsageWireMonitorClient()
            val vm = MonitorViewModel(client) { monotonicMs }.also { store.put("usage-relay-wire", it) }
            runCurrent()
            client.emit("""{"type":"snapshot","computer_state":"online","claude_state":"idle","last_sequence":1}""")
            runCurrent()
            client.emit("""{"type":"event","event_type":"task_finished","session_id":"finished-session","task_id":"finished-turn","sequence":2,"occurred_at":"2026-10-07T01:00:00Z"}""")
            runCurrent()
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            val finishDeadline = monotonicMs + requireNotNull(vm.uiState.value.stateChange).remainingMs

            monotonicMs = 1_100L
            client.emit(rawUsageSnapshot)
            runCurrent()
            val usage = requireNotNull(vm.uiState.value.snapshot.usage)
            assertEquals(1L, usage.revision)
            assertEquals(90L, usage.newInput.value)
            assertEquals(10L, usage.cachedInput.value)
            assertEquals(20L, usage.output.value)
            assertEquals(110L, usage.actual.value)
            assertEquals("90", formatUsageMetric(usage.newInput))
            assertEquals("110", formatUsageMetric(usage.actual))
            assertEquals("10.0%", formatCacheHitRate(usage))
            assertEquals("2", formatObservedResponses(usage))
            assertTrue(usage.quota.startRemaining == null && usage.quota.currentRemaining == null)

            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            assertEquals(finishDeadline, monotonicMs + requireNotNull(vm.uiState.value.stateChange).remainingMs)
            vm.showUsagePage()
            assertEquals(MonitorPage.USAGE, selectMonitorPage(vm.uiState.value))
            assertEquals(1L, vm.uiState.value.snapshot.usage?.revision)

            vm.showStatusPage()
            assertEquals(MonitorPage.STATE_CHANGE, selectMonitorPage(vm.uiState.value))
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            assertEquals(finishDeadline, monotonicMs + requireNotNull(vm.uiState.value.stateChange).remainingMs)
        } finally {
            store.clear()
            Dispatchers.resetMain()
        }
    }

    private class UsageWireMonitorClient : MonitorClient {
        private val mutableEvents = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 8)
        override val events = mutableEvents
        override val isConnected = MutableStateFlow(false)
        override fun connect() { isConnected.value = true }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) = Unit

        fun emit(rawJson: String) {
            val parsed = requireNotNull(MonitorEvent.fromWireJson(rawJson))
            check(parsed.type == MonitorEventType.EVENT || parsed.type == MonitorEventType.SNAPSHOT)
            check(mutableEvents.tryEmit(parsed))
        }
    }
}
