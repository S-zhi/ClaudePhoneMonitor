package com.example.claudephonemonitor.ui

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.SessionKind
import com.example.claudephonemonitor.monitor.WebSocketMonitorClient
import java.io.File
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real device -> production WebSocket client -> isolated production Relay and Collector.
 * The host fixture supplies synthetic rollouts; it never touches the phone's pairing store.
 */
@RunWith(AndroidJUnit4::class)
class SubagentRelayDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun childLifecycleDoesNotReplaceMainCompletionOverRealWebSocket() {
        val base = InstrumentationRegistry.getArguments().getString("deviceRelayUrl")
        assumeTrue("Start tests/device-subagent-relay.mjs and pass deviceRelayUrl", base != null)
        val url = requireNotNull(base).trimEnd('/')
        val store = ViewModelStore()
        val http = OkHttpClient.Builder().callTimeout(12, TimeUnit.SECONDS).build()
        val client = WebSocketMonitorClient(url.replaceFirst("http://", "ws://") + "/ws/android",
            "issue19-device-fixture", "fixture-development-token", clientId = "issue19-real-device")
        lateinit var vm: MonitorViewModel
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnUiThread { vm = MonitorViewModel(client).also { store.put("device", it) } }
            compose.setContent {
                val state by vm.uiState.collectAsState()
                PhoneMonitorTheme {
                    MonitorScreen(state, {}, {}, {}, {}, {}, {})
                }
            }
            compose.waitUntil(10_000) { vm.uiState.value.isConnected && vm.uiState.value.snapshot.computerState.name == "ONLINE" }
            fun control(operation: String) {
                val body = JSONObject().put("operation", operation).toString().toRequestBody("application/json".toMediaType())
                val snapshot = http.newCall(Request.Builder().url("$url/device-test/control").post(body).build()).execute().use {
                    assertTrue("Host operation $operation must succeed", it.isSuccessful)
                    JSONObject(requireNotNull(it.body).string())
                }
                val sequence = snapshot.getLong("last_sequence")
                compose.waitUntil(10_000) {
                    val value = vm.uiState.value.snapshot
                    value.lastSequence >= sequence && value.mainRunningCount == snapshot.getInt("main_running_count") &&
                        value.totalRunningCount == snapshot.getInt("total_running_count")
                }
                compose.mainClock.advanceTimeBy(100)
                compose.waitForIdle()
            }
            fun counts(main: Int, total: Int) {
                assertEquals(main, vm.uiState.value.snapshot.mainRunningCount)
                assertEquals(total, vm.uiState.value.snapshot.totalRunningCount)
                assertEquals(2, vm.uiState.value.snapshot.mainSessionCount)
                assertEquals(2, vm.uiState.value.snapshot.sessions.orEmpty().size)
                assertTrue(vm.uiState.value.snapshot.sessions.orEmpty().none { it.sessionKind == SessionKind.SUBAGENT })
                compose.onNodeWithText("Main Running · ${main.toString().padStart(2, '0')}").assertIsDisplayed()
                compose.onNodeWithText("Total Running · ${total.toString().padStart(2, '0')} · Includes subagents").assertIsDisplayed()
            }

            control("start")
            counts(2, 5)
            compose.onNodeWithText("Main Alpha").assertIsDisplayed()
            compose.onNodeWithText("Main Beta").assertIsDisplayed()
            capture("two-main-three-child.png")
            val initialChange = vm.uiState.value.stateChange
            control("child_finish")
            counts(2, 4)
            assertEquals(initialChange?.status, vm.uiState.value.stateChange?.status)
            assertNull(vm.uiState.value.recentSessionCompletion)

            control("main_finish")
            counts(1, 3)
            val completion = requireNotNull(vm.uiState.value.recentSessionCompletion)
            val remaining = requireNotNull(vm.uiState.value.stateChange).remainingMs
            val beforeChildren = SystemClock.elapsedRealtime()
            assertEquals("Main Alpha", completion.displayName)
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            control("child_fail")
            counts(1, 2)
            control("child_wait")
            counts(1, 1)
            assertEquals(completion, vm.uiState.value.recentSessionCompletion)
            assertEquals("Main Alpha", vm.uiState.value.stateChange?.completionName)
            assertEquals(PetState.FINISH, vm.uiState.value.stateChange?.status)
            val elapsed = SystemClock.elapsedRealtime() - beforeChildren
            val after = requireNotNull(vm.uiState.value.stateChange).remainingMs
            assertTrue("Child events must not restart the main deadline", after <= remaining && after >= remaining - elapsed - 500)
            capture("main-finish-child-silent.png")

            control("last_main_finish")
            val lastMainAt = SystemClock.elapsedRealtime()
            assertEquals("Main Beta", vm.uiState.value.stateChange?.completionName)
            control("children_only")
            counts(0, 8)
            assertEquals(PetState.IDLE, vm.uiState.value.petState)
            assertEquals("Main Beta", vm.uiState.value.stateChange?.completionName)
            compose.waitUntil(20_000) { vm.uiState.value.stateChange == null }
            assertTrue("Real monotonic presentation lasts approximately 15 seconds", SystemClock.elapsedRealtime() - lastMainAt >= 14_500)
            compose.mainClock.advanceTimeBy(100)
            compose.waitForIdle()
            assertEquals(MonitorPage.STATUS, selectMonitorPage(vm.uiState.value))
            counts(0, 8)
            capture("children-only-main-idle.png")

            compose.runOnUiThread { vm.reconnect() }
            compose.waitUntil(10_000) { vm.uiState.value.isConnected && vm.uiState.value.snapshot.totalRunningCount == 8 }
            // Allow the new hello/snapshot/resume exchange to arrive.
            Thread.sleep(500)
            assertEquals(PetState.IDLE, vm.uiState.value.petState)
            assertTrue(vm.uiState.value.stateChange?.status in listOf(null, PetState.IDLE, PetState.OFFLINE))
            assertNull(vm.uiState.value.recentSessionCompletion)
        } finally {
            compose.runOnUiThread { store.clear() }
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }

    private fun capture(name: String) {
        val bitmap = compose.onNodeWithTag("monitor-stage").captureToImage().asAndroidBitmap()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = requireNotNull(context.getExternalFilesDir("issue19-screenshots"))
        directory.mkdirs()
        File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
