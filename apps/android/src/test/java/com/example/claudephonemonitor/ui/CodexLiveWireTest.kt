package com.example.claudephonemonitor.ui

import androidx.lifecycle.ViewModelStore
import com.example.claudephonemonitor.monitor.MonitorClient
import com.example.claudephonemonitor.monitor.MonitorCommand
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorEventType
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CodexLiveWireTest {
    @Test
    fun sanitizedDesktopWireFlowsThroughParserViewModelAndActualPageSelector() = runTest {
        val fixturePath = System.getProperty("codex.liveWirePath")
            ?.takeIf { it.isNotBlank() }
            ?: System.getenv("CODEX_LIVE_WIRE_PATH")?.takeIf { it.isNotBlank() }
        assumeTrue("Set CODEX_LIVE_WIRE_PATH to run the live Codex wire check", fixturePath != null)

        val fixture = JSONObject(File(fixturePath!!).readText())
        assertTrue(
            "live fixture identifies its source root only by an anonymous hash",
            fixture.optString("source_root_hash").matches(Regex("^[0-9a-f]{16}$")),
        )
        val events = fixture.getJSONArray("events").jsonObjects()
        val snapshots = fixture.getJSONArray("snapshots").jsonObjects()
        val pairs = events.filter { it.optString("event_type") == "task_finished" }
            .mapNotNull { finished ->
                events.firstOrNull { started ->
                    started.optString("event_type") == "task_started" &&
                        started.optString("session_id") == finished.optString("session_id") &&
                        started.optString("task_id") == finished.optString("task_id")
                }?.let { started -> started to finished }
            }
        assertNotNull("live Android wire must include a matching start and verified completion", pairs.firstOrNull())
        val (started, finished) = pairs.first()
        val sessionId = started.getString("session_id")
        val taskId = started.getString("task_id")
        assertTrue(sessionId.matches(Regex("^codex:sess:[0-9a-f]{64}$")))
        assertTrue(taskId.matches(Regex("^codex:turn:[0-9a-f]{64}$")))
        val startedSequence = started.optLong("sequence")
        val finishedSequence = finished.optLong("sequence")
        val baselineSnapshot = snapshots.firstOrNull { snapshot ->
            snapshot.optString("type") == "snapshot" &&
                snapshot.optString("computer_state") == "online" &&
                snapshot.optLong("last_sequence") < startedSequence &&
                snapshot.optJSONArray("sessions")?.jsonObjects()?.any {
                    it.optString("session_id") == sessionId && it.optString("title") == "Codex"
                } == true
        }
        val workingSnapshot = snapshots.firstOrNull { snapshot ->
            snapshot.optString("type") == "snapshot" &&
                snapshot.optString("computer_state") == "online" &&
                snapshot.optLong("last_sequence") >= startedSequence &&
                snapshot.optLong("last_sequence") < finishedSequence &&
                snapshot.optJSONArray("sessions")?.jsonObjects()?.any {
                    it.optString("session_id") == sessionId && it.optString("claude_state") == "working"
                } == true
        }
        val finalSnapshot = snapshots.firstOrNull { snapshot ->
            val completion = snapshot.optJSONObject("recent_completion")
            snapshot.optString("type") == "snapshot" &&
                snapshot.optString("computer_state") == "online" &&
                completion != null &&
                completion.optString("session_id") == sessionId &&
                completion.optString("task_id") == taskId &&
                completion.optLong("sequence") == finishedSequence
        }
        assertNotNull("live Android wire must include an online pre-turn snapshot for the matching Codex session", baselineSnapshot)
        assertNotNull("live Android wire must include the Relay WORKING snapshot after the matching start event", workingSnapshot)
        assertNotNull("live Android wire must include this turn's matching completion snapshot", finalSnapshot)

        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val store = ViewModelStore()
        try {
            var monotonicMs = 100L
            val client = FixtureMonitorClient()
            val vm = MonitorViewModel(client) { monotonicMs }.also { store.put("codex-live-wire", it) }
            runCurrent()

            client.emit(snapshotWire(baselineSnapshot!!))
            runCurrent()
            client.emit(JSONObject(started.toString()).put("type", "event").toString())
            runCurrent()
            assertEquals(startedSequence, vm.uiState.value.snapshot.lastSequence)

            // Relay delivers a separate authoritative snapshot after the raw
            // lifecycle event; the event alone is not the aggregate-state authority.
            client.emit(snapshotWire(workingSnapshot!!))
            runCurrent()
            assertEquals(PetState.WORKING, vm.uiState.value.petState)
            assertTrue(vm.uiState.value.snapshot.sessions.orEmpty().any {
                it.sessionId == sessionId && it.claudeState.name.lowercase() == "working"
            })

            monotonicMs += 100L
            client.emit(JSONObject(finished.toString()).put("type", "event").toString())
            runCurrent()
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            assertEquals(sessionId, vm.uiState.value.snapshot.recentCompletion?.sessionId)
            assertEquals(taskId, vm.uiState.value.snapshot.recentCompletion?.taskId)
            assertEquals(finishedSequence, vm.uiState.value.snapshot.recentCompletion?.sequence)
            assertEquals("Codex", vm.uiState.value.stateChange?.completionName)
            assertEquals(MonitorPage.STATE_CHANGE, selectMonitorPage(vm.uiState.value))

            client.emit(snapshotWire(finalSnapshot!!))
            runCurrent()
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            assertEquals("Codex", vm.uiState.value.stateChange?.completionName)
            assertEquals(sessionId, vm.uiState.value.snapshot.recentCompletion?.sessionId)
            assertEquals(taskId, vm.uiState.value.snapshot.recentCompletion?.taskId)
            assertEquals(finishedSequence, vm.uiState.value.snapshot.recentCompletion?.sequence)
            assertEquals(MonitorPage.STATE_CHANGE, selectMonitorPage(vm.uiState.value))

            monotonicMs += 15_000L
            advanceTimeBy(100L)
            runCurrent()
            assertEquals(MonitorPage.STATUS, selectMonitorPage(vm.uiState.value))
        } finally {
            store.clear()
            Dispatchers.resetMain()
        }
    }

    private fun snapshotWire(snapshot: JSONObject): String = JSONObject()
        .put("type", "snapshot")
        .put("snapshot", snapshot)
        .toString()

    private fun JSONArray.jsonObjects(): List<JSONObject> = buildList {
        for (index in 0 until length()) optJSONObject(index)?.let(::add)
    }

    private class FixtureMonitorClient : MonitorClient {
        private val mutableEvents = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 16)
        override val events = mutableEvents
        override val isConnected = MutableStateFlow(false)
        override fun connect() { isConnected.value = true }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) = Unit

        fun emit(wireJson: String) {
            val parsed = requireNotNull(MonitorEvent.fromWireJson(wireJson))
            check(parsed.type == MonitorEventType.EVENT || parsed.type == MonitorEventType.SNAPSHOT)
            if (parsed.type == MonitorEventType.EVENT) {
                check(parsed.name.wireValue == "task_started" || parsed.name.wireValue == "task_finished")
            }
            check(mutableEvents.tryEmit(parsed))
        }
    }
}
