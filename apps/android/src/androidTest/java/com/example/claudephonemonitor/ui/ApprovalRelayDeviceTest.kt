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
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.claudephonemonitor.monitor.ApprovalStatus
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.WebSocketMonitorClient
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real Android -> production WebSocket/ViewModel/UI -> isolated paired Relay/Collector/Hook.
 * Pass deviceRelayUrl=http://127.0.0.1:18883 after adb reverse; no user pairing store is used.
 */
@RunWith(AndroidJUnit4::class)
class ApprovalRelayDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun questionLifecycle() = withFixture { fixture ->
        fixture.resetMonitor()
        val question = fixture.control("native_question")
        val sessionId = question.getString("session_id")
        fixture.await { fixture.vm.uiState.value.userActions.any { it.sessionId == sessionId && it.reason == "question" } }
        fixture.render()
        assertEquals(MonitorPage.STATUS, selectMonitorPage(fixture.vm.uiState.value))
        compose.onNodeWithTag("user-action-banner").assertIsDisplayed()
        compose.onNodeWithTag("user-action-waiting-icon").assertIsDisplayed()
        compose.onNodeWithText("Awaiting answer").assertIsDisplayed()
        compose.onNodeWithTag("approval-allow").assertDoesNotExist()
        compose.onNodeWithTag("approval-deny").assertDoesNotExist()
        fixture.capture("question-status.png")

        compose.runOnUiThread { fixture.vm.showUsagePage() }
        fixture.render()
        compose.onNodeWithText("Usage 用量消耗").assertIsDisplayed()
        compose.onNodeWithTag("user-action-banner").assertIsDisplayed()
        fixture.control("unrelated_progress")
        fixture.await { fixture.vm.uiState.value.userActions.any { it.sessionId == sessionId && it.reason == "question" } }
        assertEquals("Device question task", fixture.vm.uiState.value.userActions.first { it.sessionId == sessionId }.displayName)
        fixture.render()
        fixture.capture("question-usage-parallel.png")

        fixture.control("disconnect_phone")
        fixture.await { !fixture.vm.uiState.value.isConnected }
        fixture.await { fixture.vm.uiState.value.isConnected && fixture.vm.uiState.value.userActions.any { it.sessionId == sessionId } }
        // A new ViewModel has no cached waiting events: the explicit snapshot must restore it.
        fixture.connectMonitor()
        fixture.await { fixture.vm.uiState.value.userActions.any { it.sessionId == sessionId && it.reason == "question" } }
        assertNull(fixture.vm.uiState.value.userActions.first { it.sessionId == sessionId }.correlationId)
        fixture.render()
        compose.onNodeWithTag("user-action-waiting-icon").assertIsDisplayed()
        fixture.capture("question-reconnect-snapshot.png")

        fixture.control("question_answer")
        fixture.await { fixture.vm.uiState.value.userActions.none { it.sessionId == sessionId } }
        fixture.render()
        compose.onNodeWithTag("user-action-banner").assertDoesNotExist()
        fixture.capture("question-answered.png")
    }

    @Test fun bridgeDecisions() = withFixture { fixture ->
        listOf("allow", "deny", "computer").forEach { decision ->
            fixture.resetMonitor()
            val requestId = fixture.control("approval_request").getString("request_id")
            fixture.await { fixture.vm.uiState.value.approvalReminder?.request?.let {
                it.requestId == requestId && it.status == ApprovalStatus.PENDING && it.canRespond
            } == true }
            fixture.render()
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(fixture.vm.uiState.value))
            compose.onNodeWithTag("approval-title").assertIsDisplayed()
            compose.onNodeWithTag("approval-$decision").performScrollTo().assertIsEnabled()
            fixture.capture("$decision-pending.png")
            compose.onNodeWithTag("approval-$decision").performClick()
            val expected = when (decision) {
                "allow" -> ApprovalStatus.APPROVED
                "deny" -> ApprovalStatus.DENIED
                else -> ApprovalStatus.UNKNOWN
            }
            fixture.await { fixture.vm.uiState.value.approvalReminder?.request?.status == expected }
            fixture.awaitHookResult(requestId, expected.wireValue, decision)
            fixture.render()
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(fixture.vm.uiState.value))
            assertFalse(requireNotNull(fixture.vm.uiState.value.approvalReminder).request.canRespond)
            compose.onNodeWithTag("approval-allow").assertDoesNotExist()
            compose.onNodeWithTag("approval-deny").assertDoesNotExist()
            compose.onNodeWithTag("approval-computer").assertDoesNotExist()
            fixture.capture("$decision-result.png")
        }
    }

    /** This uses the production monotonic clock and waits five real minutes. */
    @Test(timeout = 420_000L) fun fiveMinutePin() = withFixture { fixture ->
        fixture.resetMonitor()
        compose.runOnUiThread { fixture.vm.showUsagePage() }
        val requestId = fixture.control("approval_request").getString("request_id")
        fixture.await { fixture.vm.uiState.value.approvalReminder?.request?.let {
            it.requestId == requestId && it.canRespond
        } == true }
        fixture.render()
        val firstObservedAt = SystemClock.elapsedRealtime()
        val initialRemaining = requireNotNull(fixture.vm.uiState.value.approvalReminder).remainingMs
        assertTrue("The newly displayed page must start with five minutes", initialRemaining in 295_000L..300_000L)
        val originalDeadline = firstObservedAt + initialRemaining
        fixture.progress(firstObservedAt, originalDeadline)
        fixture.capture("five-minute-pending.png")

        fixture.control("duplicate")
        fixture.control("refresh")
        fixture.control("unrelated_progress")
        fixture.await { fixture.vm.uiState.value.petState == PetState.WORKING }
        assertOriginalDeadline(fixture.vm, originalDeadline)
        assertEquals(MonitorPage.APPROVAL, selectMonitorPage(fixture.vm.uiState.value))
        assertNull(fixture.vm.uiState.value.stateChange)
        while (originalDeadline - SystemClock.elapsedRealtime() > 5_000L) {
            val checkpoint = minOf(SystemClock.elapsedRealtime() + 30_000L, originalDeadline - 5_000L)
            compose.waitUntil(35_000L) { SystemClock.elapsedRealtime() >= checkpoint }
            fixture.control("refresh")
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(fixture.vm.uiState.value))
            assertEquals(requestId, fixture.vm.uiState.value.approvalReminder?.request?.requestId)
            assertEquals(ApprovalStatus.PENDING, fixture.vm.uiState.value.approvalReminder?.request?.status)
            assertOriginalDeadline(fixture.vm, originalDeadline)
            fixture.progress(firstObservedAt, originalDeadline)
        }
        fixture.render()
        compose.onNodeWithTag("approval-page").assertIsDisplayed()
        fixture.capture("five-minute-before-expiry.png")
        fixture.await(8_000L) { fixture.vm.uiState.value.approvalReminder == null }
        val expiredAt = SystemClock.elapsedRealtime()
        assertTrue("Expiry must use the first display deadline", expiredAt in (originalDeadline - 500L)..(originalDeadline + 2_000L))
        assertEquals(MonitorPage.USAGE, selectMonitorPage(fixture.vm.uiState.value))
        assertEquals(PetState.WORKING, fixture.vm.uiState.value.petState)
        fixture.render()
        compose.onNodeWithTag("approval-page").assertDoesNotExist()
        compose.onNodeWithText("Usage 用量消耗").assertIsDisplayed()
        compose.onNodeWithTag("pending-approval-banner").assertIsDisplayed()
        fixture.capture("five-minute-latest-usage.png")
        fixture.progress(firstObservedAt, originalDeadline)
    }

    /** A real delivered decision replaces the pending window with fifteen real seconds. */
    @Test(timeout = 90_000L) fun handledResultWindow() = withFixture { fixture ->
        fixture.resetMonitor()
        compose.runOnUiThread { fixture.vm.showUsagePage() }
        val requestId = fixture.control("approval_request").getString("request_id")
        fixture.await { fixture.vm.uiState.value.approvalReminder?.request?.let {
            it.requestId == requestId && it.canRespond
        } == true }
        fixture.control("unrelated_progress")
        fixture.render()
        compose.onNodeWithTag("approval-allow").performScrollTo().assertIsEnabled().performClick()
        fixture.await { fixture.vm.uiState.value.approvalReminder?.request?.status == ApprovalStatus.APPROVED }
        val firstResultObservedAt = SystemClock.elapsedRealtime()
        val initialRemaining = requireNotNull(fixture.vm.uiState.value.approvalReminder).remainingMs
        assertTrue("A handled result must start with fifteen seconds", initialRemaining in 13_000L..15_000L)
        val resultDeadline = firstResultObservedAt + initialRemaining
        fixture.awaitHookResult(requestId, "approved", "allow")
        fixture.control("duplicate")
        fixture.control("refresh")
        fixture.control("unrelated_progress")
        assertOriginalDeadline(fixture.vm, resultDeadline)
        assertEquals(MonitorPage.APPROVAL, selectMonitorPage(fixture.vm.uiState.value))
        assertEquals(ApprovalStatus.APPROVED, fixture.vm.uiState.value.approvalReminder?.request?.status)
        assertNull(fixture.vm.uiState.value.stateChange)
        fixture.render()
        compose.onNodeWithTag("approval-title").assertTextEquals("Approval sent")
        compose.onNodeWithTag("approval-allow").assertDoesNotExist()
        fixture.capture("fifteen-second-result.png")

        compose.waitUntil(20_000L) { SystemClock.elapsedRealtime() >= resultDeadline - 2_000L }
        fixture.control("refresh")
        assertEquals(MonitorPage.APPROVAL, selectMonitorPage(fixture.vm.uiState.value))
        assertOriginalDeadline(fixture.vm, resultDeadline)
        fixture.await(5_000L) { fixture.vm.uiState.value.approvalReminder == null }
        val expiredAt = SystemClock.elapsedRealtime()
        assertTrue("Handled result expiry must use its first display", expiredAt in (resultDeadline - 500L)..(resultDeadline + 2_000L))
        assertEquals(MonitorPage.USAGE, selectMonitorPage(fixture.vm.uiState.value))
        assertEquals(PetState.WORKING, fixture.vm.uiState.value.petState)
        fixture.control("refresh")
        assertNull(fixture.vm.uiState.value.approvalReminder)
        fixture.render()
        compose.onNodeWithTag("approval-page").assertDoesNotExist()
        compose.onNodeWithText("Usage 用量消耗").assertIsDisplayed()
        fixture.capture("fifteen-second-latest-usage.png")
    }

    private fun assertOriginalDeadline(vm: MonitorViewModel, originalDeadline: Long) {
        val remaining = requireNotNull(vm.uiState.value.approvalReminder).remainingMs
        val observed = SystemClock.elapsedRealtime() + remaining
        assertTrue("Repeated state refresh must not move the active display deadline", abs(observed - originalDeadline) <= 750L)
    }

    private fun withFixture(test: (Fixture) -> Unit) {
        val arguments = InstrumentationRegistry.getArguments()
        val base = arguments.getString("deviceRelayUrl") ?: arguments.getString("fixture_base_url")
        assumeTrue("Start the isolated device-approval-relay fixture and pass deviceRelayUrl", base != null)
        val fixture = Fixture(requireNotNull(base).trimEnd('/'))
        compose.mainClock.autoAdvance = false
        val alreadyKeptOn = compose.activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
        try {
            compose.runOnUiThread { compose.activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            compose.setContent {
                val vm = fixture.model.value
                if (vm != null) {
                    val state by vm.uiState.collectAsState()
                    PhoneMonitorTheme {
                        MonitorScreen(state, vm::toggleControls, { vm.setControlsVisible(false) },
                            vm::showUsagePage, vm::showStatusPage, vm::reconnect, {},
                            vm::decideApproval, vm::retryApprovalDecision)
                    }
                }
            }
            test(fixture)
        } finally {
            fixture.close()
            if (!alreadyKeptOn) compose.runOnUiThread { compose.activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        }
    }

    private inner class Fixture(private val base: String) {
        private val http = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()
        private var store = ViewModelStore()
        val model = mutableStateOf<MonitorViewModel?>(null)
        val vm: MonitorViewModel get() = requireNotNull(model.value)

        fun resetMonitor() {
            compose.runOnUiThread { model.value = null; store.clear(); store = ViewModelStore() }
            control("reset")
            connectMonitor()
        }

        fun connectMonitor() {
            val config = get("config")
            fun configString(key: String): String = (config.opt(key) as? String)?.takeIf { it.isNotBlank() }
                ?: throw AssertionError("fixture_config_invalid_fields")
            val installationId = configString("installation_id")
            val client = WebSocketMonitorClient(configString("ws_url"), installationId,
                configString("android_token"), clientId = "issue23-isolated-device")
            compose.runOnUiThread {
                model.value = null
                store.clear()
                store = ViewModelStore()
                // No clock injection: the real timing test uses this production constructor.
                model.value = MonitorViewModel(client).also { store.put("issue23-device", it) }
            }
            await { vm.uiState.value.isConnected && vm.uiState.value.snapshot.installationId == installationId }
            render()
        }

        fun control(operation: String, body: JSONObject = JSONObject()): JSONObject {
            val beforeEvents = model.value?.uiState?.value?.eventCount
            val request = Request.Builder().url("$base/device-test/control")
                .post(body.put("operation", operation).toString().toRequestBody("application/json".toMediaType())).build()
            val result = execute(request, operation)
            if (model.value != null && operation !in setOf("reset", "disconnect_phone")) {
                val snapshot = requireNotNull(result.optJSONObject("snapshot")) { "Fixture $operation must return a snapshot watermark" }
                val sequence = snapshot.getLong("last_sequence")
                await { vm.uiState.value.snapshot.lastSequence >= sequence }
                if (operation == "refresh" && beforeEvents != null) await { vm.uiState.value.eventCount > beforeEvents }
            }
            return result
        }

        private fun get(operation: String) = execute(Request.Builder().url("$base/device-test/$operation").build(), operation)

        private fun execute(request: Request, operation: String): JSONObject = http.newCall(request).execute().use { response ->
            // Never include configuration response bodies or tokens in failure diagnostics.
            assertTrue("Isolated fixture $operation returned HTTP ${response.code}", response.isSuccessful)
            val body = response.body?.string() ?: throw AssertionError("fixture_${operation}_missing_body")
            try { JSONObject(body) } catch (_: JSONException) {
                throw AssertionError("fixture_${operation}_invalid_json")
            }
        }

        fun await(timeoutMs: Long = 12_000L, predicate: () -> Boolean) = compose.waitUntil(timeoutMs, predicate)

        fun awaitHookResult(requestId: String, status: String, decision: String) {
            val deadline = SystemClock.elapsedRealtime() + 12_000L
            while (SystemClock.elapsedRealtime() < deadline) {
                val results = get("state").optJSONArray("hook_results")
                if (results != null) for (index in 0 until results.length()) {
                    val result = results.optJSONObject(index) ?: continue
                    if (result.optString("request_id") != requestId || result.optString("status") != status ||
                        result.optString("decision") != decision) continue
                    assertEquals("The real Hook CLI must exit successfully", 0, result.optInt("child_exit_code", -1))
                    if (decision == "computer") {
                        assertTrue("Native fallback must leave the real Hook stdout empty", result.optBoolean("stdout_empty", false))
                        assertFalse("Native fallback must not output a permission decision", result.has("stdout_json"))
                    } else {
                        val output = requireNotNull(result.optJSONObject("stdout_json")) { "The real Hook must output decision JSON" }
                        val specific = requireNotNull(output.optJSONObject("hookSpecificOutput")) { "The Hook output must use the official decision shape" }
                        assertEquals("PermissionRequest", specific.optString("hookEventName"))
                        assertEquals(decision, specific.optJSONObject("decision")?.optString("behavior"))
                    }
                    return
                }
                SystemClock.sleep(100L)
            }
            throw AssertionError("The isolated Hook must confirm the selected $decision delivery")
        }

        fun render() { compose.mainClock.advanceTimeBy(100L); compose.waitForIdle() }

        fun capture(name: String) {
            render()
            val bitmap = compose.onNodeWithTag("monitor-stage").captureToImage().asAndroidBitmap()
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val directory = requireNotNull(context.getExternalFilesDir("issue23-screenshots"))
            directory.mkdirs()
            File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }

        fun progress(startedAt: Long, deadline: Long) {
            val now = SystemClock.elapsedRealtime()
            InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                putString("stream", "issue23_real_5min elapsed_ms=${now - startedAt} time_left_ms=${(deadline - now).coerceAtLeast(0L)}\n")
            })
        }

        fun close() {
            compose.runOnUiThread { model.value = null; store.clear() }
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }
}
