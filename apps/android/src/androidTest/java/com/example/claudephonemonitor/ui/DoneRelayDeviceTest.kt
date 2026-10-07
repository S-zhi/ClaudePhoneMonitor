package com.example.claudephonemonitor.ui

import android.graphics.Bitmap
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.ReminderStrength
import com.example.claudephonemonitor.monitor.SessionDisplayState
import com.example.claudephonemonitor.monitor.WebSocketMonitorClient
import com.example.claudephonemonitor.monitor.displayState
import com.example.claudephonemonitor.monitor.sortedTopSessions
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Production Relay/WebSocket/ViewModel/Compose; isolated synthetic metadata and pairing only.
 * Long source duration is synthetic, while reminder expiry uses the real device monotonic clock.
 * Host: tests/device-done-relay.mjs, adb reverse tcp:18887 tcp:18887, deviceRelayUrl argument.
 */
@RunWith(AndroidJUnit4::class)
class DoneRelayDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test(timeout = 120_000L) fun persistentDoneAcrossRealReminderReconnectAndNextTask() {
        val base = InstrumentationRegistry.getArguments().getString("deviceRelayUrl")
        assumeTrue("Start tests/device-done-relay.mjs and pass deviceRelayUrl", base != null)
        val fixture = Fixture(requireNotNull(base).trimEnd('/'))
        compose.mainClock.autoAdvance = false
        val keptOn = compose.activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
        try {
            compose.runOnUiThread { compose.activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            compose.setContent {
                val model = fixture.model.value
                if (model != null) {
                    val state by model.uiState.collectAsState()
                    PhoneMonitorTheme { MonitorScreen(state, {}, {}, {}, {}, model::reconnect, {}) }
                }
            }
            fixture.connect()
            fixture.control("start")
            fixture.row("alpha", SessionDisplayState.WORKING)
            fixture.row("beta", SessionDisplayState.WORKING)
            fixture.row("running", SessionDisplayState.WORKING)
            fixture.row("waiting", SessionDisplayState.WAITING)
            fixture.row("unused", SessionDisplayState.IDLE)
            assertEquals(3, fixture.vm.uiState.value.snapshot.mainRunningCount)
            fixture.capture("00-working-waiting-unused.png")

            fixture.control("finish_alpha")
            fixture.await { fixture.vm.uiState.value.stateChange?.status == PetState.FINISH }
            val observedAt = SystemClock.elapsedRealtime()
            val reminder = requireNotNull(fixture.vm.uiState.value.stateChange)
            assertEquals(ReminderStrength.STRONG, reminder.strength)
            assertEquals("Completed Alpha", reminder.completionName)
            assertTrue("A new strong reminder starts with fifteen real seconds", reminder.remainingMs in 13_000L..15_000L)
            val deadline = observedAt + reminder.remainingMs
            assertEquals(MonitorPage.STATE_CHANGE, selectMonitorPage(fixture.vm.uiState.value))
            fixture.render()
            compose.onNodeWithTag("state-change-title").assert(hasContentDescription("DONE")).assertIsDisplayed()
            fixture.capture("01-strong-done-page.png")
            fixture.captureGreen("state-change-title", "01-green-done-title.png")
            fixture.noFinishLabel()

            fixture.control("finish_beta")
            val beforeTtl = SystemClock.elapsedRealtime()
            fixture.await(8_000L) { SystemClock.elapsedRealtime() - beforeTtl > 5_500L }
            val expiredSnapshot = fixture.control("refresh").getJSONObject("snapshot")
            assertFalse("Relay transient completion must expire", expiredSnapshot.has("recent_completion"))
            assertNull(fixture.vm.uiState.value.snapshot.recentCompletion)
            listOf("alpha", "beta").forEach { key ->
                val row = fixture.vm.uiState.value.snapshot.sessions.orEmpty().single { it.sessionId == "issue27-$key" }
                assertEquals(true, row.taskCompleted)
                assertEquals(SessionDisplayState.DONE, row.displayState(fixture.vm.uiState.value.recentSessionCompletion))
            }
            assertEquals("Completed Alpha", fixture.vm.uiState.value.stateChange?.completionName)
            assertTrue("TTL refresh must keep the first reminder deadline",
                abs(SystemClock.elapsedRealtime() + requireNotNull(fixture.vm.uiState.value.stateChange).remainingMs - deadline) <= 750L)
            fixture.capture("02-done-after-relay-ttl.png")

            fixture.control("settle")
            fixture.await(20_000L) { fixture.vm.uiState.value.stateChange == null }
            val expiredAt = SystemClock.elapsedRealtime()
            assertTrue("The strong reminder expires at the original real deadline", expiredAt in (deadline - 500L)..(deadline + 2_000L))
            assertEquals(PetState.FINISH, fixture.vm.uiState.value.petState)
            assertEquals(MonitorPage.STATUS, selectMonitorPage(fixture.vm.uiState.value))
            fixture.render()
            listOf("alpha", "beta", "waiting").forEach { fixture.row(it, SessionDisplayState.DONE) }
            fixture.row("running", SessionDisplayState.IDLE) // Failed tasks cannot acquire DONE.
            fixture.row("unused", SessionDisplayState.IDLE)
            compose.onNodeWithContentDescription("Clawd animation: DONE").assertIsDisplayed()
            compose.onNodeWithTag("state-change-title").assertDoesNotExist()
            fixture.capture("03-persistent-multiple-done.png")
            fixture.captureGreen("session-issue27-alpha", "03-green-done-row.png")
            fixture.noFinishLabel()
            InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                putString("stream", "issue27_real_reminder_elapsed_ms=${expiredAt - observedAt} synthetic_source_task_ms=300001\n")
            })

            fixture.control("disconnect_phone")
            fixture.await { !fixture.vm.uiState.value.isConnected }
            fixture.await { fixture.vm.uiState.value.isConnected && fixture.vm.uiState.value.petState == PetState.FINISH }
            fixture.control("refresh")
            assertTrue("Reconnect must not replay DONE reminder", fixture.vm.uiState.value.stateChange?.status != PetState.FINISH)
            fixture.await(8_000L) { fixture.vm.uiState.value.stateChange == null }
            fixture.render()
            fixture.row("alpha", SessionDisplayState.DONE)
            fixture.row("beta", SessionDisplayState.DONE)
            compose.onNodeWithContentDescription("Clawd animation: DONE").assertIsDisplayed()
            fixture.capture("04-websocket-reconnected-done.png")

            fixture.connect() // Fresh ViewModel/client has no cached completion or event watermark.
            fixture.control("refresh")
            assertNull("A cold authoritative snapshot must not replay an expired reminder", fixture.vm.uiState.value.stateChange)
            assertEquals(PetState.FINISH, fixture.vm.uiState.value.petState)
            fixture.row("alpha", SessionDisplayState.DONE)
            fixture.row("beta", SessionDisplayState.DONE)
            fixture.capture("05-cold-viewmodel-done.png")

            fixture.control("restart_alpha")
            assertEquals(PetState.WORKING, fixture.vm.uiState.value.petState)
            fixture.row("alpha", SessionDisplayState.WORKING)
            fixture.row("beta", SessionDisplayState.DONE)
            fixture.capture("06-same-session-new-working.png")
            fixture.control("wait_alpha")
            assertEquals(PetState.WAITING, fixture.vm.uiState.value.petState)
            fixture.row("alpha", SessionDisplayState.WAITING)
            fixture.capture("07-same-session-waiting.png")
            fixture.control("finish_alpha_again")
            fixture.await { fixture.vm.uiState.value.stateChange?.status == PetState.FINISH }
            assertEquals(ReminderStrength.WEAK, fixture.vm.uiState.value.stateChange?.strength)
            fixture.row("alpha", SessionDisplayState.DONE)
            fixture.await(8_000L) { fixture.vm.uiState.value.stateChange == null }
            fixture.render()
            assertEquals(PetState.FINISH, fixture.vm.uiState.value.petState)
            compose.onNodeWithContentDescription("Clawd animation: DONE").assertIsDisplayed()
            fixture.row("alpha", SessionDisplayState.DONE)
            fixture.capture("08-next-task-done-again.png")
            fixture.noFinishLabel()
        } finally {
            fixture.close()
            if (!keptOn) compose.runOnUiThread { compose.activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        }
    }

    private inner class Fixture(private val base: String) {
        private val http = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()
        private var store = ViewModelStore()
        val model = mutableStateOf<MonitorViewModel?>(null)
        val vm: MonitorViewModel get() = requireNotNull(model.value)

        fun connect() {
            val config = request(Request.Builder().url("$base/device-test/config").build())
            val installationId = config.getString("installation_id")
            val client = WebSocketMonitorClient(config.getString("ws_url"), installationId,
                config.getString("android_token"), clientId = "issue27-isolated-device")
            compose.runOnUiThread {
                model.value = null
                store.clear()
                store = ViewModelStore()
                model.value = MonitorViewModel(client).also { store.put("issue27-device", it) }
            }
            await { vm.uiState.value.isConnected && vm.uiState.value.snapshot.installationId == installationId }
            render()
        }

        fun control(operation: String): JSONObject {
            val count = vm.uiState.value.eventCount
            val body = JSONObject().put("operation", operation).toString().toRequestBody("application/json".toMediaType())
            val result = request(Request.Builder().url("$base/device-test/control").post(body).build())
            if (operation != "disconnect_phone") {
                val expected = result.getJSONObject("snapshot")
                val rows = expected.getJSONArray("sessions")
                await {
                    val snapshot = vm.uiState.value.snapshot
                    snapshot.lastSequence >= expected.getLong("last_sequence") &&
                        snapshot.mainRunningCount == expected.getInt("main_running_count") &&
                        (0 until rows.length()).all { index ->
                            val row = rows.getJSONObject(index)
                            snapshot.sessions.orEmpty().any { it.sessionId == row.getString("session_id") &&
                                it.claudeState.wireValue == row.getString("claude_state") &&
                                it.taskCompleted == row.getBoolean("task_completed") }
                        } && (operation != "refresh" || vm.uiState.value.eventCount > count)
                }
                render()
            }
            return result
        }

        private fun request(request: Request): JSONObject = http.newCall(request).execute().use { response ->
            assertTrue("Isolated DONE fixture returned HTTP ${response.code}", response.isSuccessful)
            // Response bodies can contain temporary credentials; never print them.
            JSONObject(requireNotNull(response.body).string())
        }

        fun await(timeoutMs: Long = 12_000L, predicate: () -> Boolean) = compose.waitUntil(timeoutMs, predicate)
        fun render() { compose.mainClock.advanceTimeBy(100L); compose.waitForIdle() }

        fun row(key: String, expected: SessionDisplayState) {
            render()
            val state = vm.uiState.value
            val rows = state.snapshot.sortedTopSessions()
            val index = rows.indexOfFirst { it.sessionId == "issue27-$key" }
            assertTrue("Fixture session $key must remain visible", index >= 0)
            assertEquals(expected, rows[index].displayState(state.recentSessionCompletion))
            compose.onNodeWithTag("session-issue27-$key")
                .assert(hasContentDescription("Session ${index + 1}: ${expected.label}")).assertIsDisplayed()
        }

        fun noFinishLabel() {
            compose.onNodeWithText("FINISH").assertDoesNotExist()
            compose.onNodeWithContentDescription("FINISH").assertDoesNotExist()
            compose.onNodeWithContentDescription("Clawd animation: FINISH").assertDoesNotExist()
        }

        fun capture(name: String) = save(compose.onNodeWithTag("monitor-stage").captureToImage().asAndroidBitmap(), name)
        fun captureGreen(tag: String, name: String) {
            render()
            val bitmap = compose.onNodeWithTag(tag).captureToImage().asAndroidBitmap()
            var green = 0
            for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
                if (bitmap.getPixel(x, y) and 0x00FFFFFF == 0x0093BE81) green++
            }
            assertTrue("DONE lettering must contain the exact green #93BE81 pixels", green > 20)
            save(bitmap, name)
        }

        private fun save(bitmap: Bitmap, name: String) {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val directory = requireNotNull(context.getExternalFilesDir("issue27-screenshots"))
            directory.mkdirs()
            File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }

        fun close() {
            compose.runOnUiThread { model.value = null; store.clear() }
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }
}
