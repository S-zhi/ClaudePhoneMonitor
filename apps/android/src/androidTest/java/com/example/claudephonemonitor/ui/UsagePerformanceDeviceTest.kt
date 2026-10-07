package com.example.claudephonemonitor.ui

import android.app.UiAutomation
import android.graphics.Bitmap
import android.os.SystemClock
import android.os.Build
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.neverEqualPolicy
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorSnapshot
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.WebSocketMonitorClient
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises real Activity frame timing with either a production Relay or a local aggregate sample. */
@RunWith(AndroidJUnit4::class)
class UsagePerformanceDeviceTest {
    @Test fun rendersUsageForThirtySecondsOnTheRealFrameClock() {
        val relayUrl = InstrumentationRegistry.getArguments().getString("deviceRelayUrl")
        if (relayUrl != null) {
            renderRealRelay(relayUrl)
        } else {
            val path = InstrumentationRegistry.getArguments().getString("usageSnapshotPath")
            assumeNotNull(path)
            renderAggregate(path)
        }
    }

    private fun renderAggregate(path: String?) {
        val firstSnapshot = readSnapshot(path)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val fallbackState = mutableStateOf(
            MonitorUiState(isConnected = true, snapshot = firstSnapshot.copy(computerState = ComputerState.ONLINE)),
            neverEqualPolicy<MonitorUiState>(),
        )

        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                keepScreenAwakeForTest(activity)
                activity.setContent {
                    PhoneMonitorTheme {
                        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                            UsagePerformanceContent(null, fallbackState)
                        }
                    }
                }
            }
            val beforeBitmap = waitForClawdScene(instrumentation.uiAutomation)
            val before = fallbackState.value
            runForPerformanceDuration()
            val after = fallbackState.value
            val afterBitmap = takeScreenshot(instrumentation.uiAutomation)
            val pixelChanges = changedScenePixels(beforeBitmap, afterBitmap)
            saveReport("aggregate-renderer", before, after, pixelChanges, beforeBitmap, afterBitmap)
            assertTrue("Usage Clawd sprite pixels did not move during the real-time run", pixelChanges.motionMask >= 100)
        }
    }

    private fun renderRealRelay(baseUrl: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val store = ViewModelStore()
        val client = WebSocketMonitorClient(
            baseUrl.trimEnd('/').replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/ws/android",
            "issue28-readonly-probe",
            "fixture-development-token",
            clientId = "issue28-usage-performance-device",
        )
        lateinit var viewModel: MonitorViewModel

        try {
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    keepScreenAwakeForTest(activity)
                    viewModel = MonitorViewModel(client).also { store.put("issue28-usage", it) }
                    activity.setContent {
                        PhoneMonitorTheme {
                            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                                UsagePerformanceContent(viewModel, null)
                            }
                        }
                    }
                }
                waitForRealUsage(viewModel)
                val beforeBitmap = waitForClawdScene(instrumentation.uiAutomation)
                val before = viewModel.uiState.value
                runForPerformanceDuration()
                val after = viewModel.uiState.value
                val afterBitmap = takeScreenshot(instrumentation.uiAutomation)
                val pixelChanges = changedScenePixels(beforeBitmap, afterBitmap)
                saveReport("production-relay", before, after, pixelChanges, beforeBitmap, afterBitmap)

                assertTrue("Relay disconnected during the performance run", after.isConnected)
                val beforeUsage = requireNotNull(before.snapshot.usage)
                val afterUsage = requireNotNull(after.snapshot.usage)
                assertTrue(
                    "No Relay snapshot or usage revision arrived during the run",
                    after.snapshot.lastSequence > before.snapshot.lastSequence || afterUsage.revision > beforeUsage.revision,
                )
                assertNonDecreasing("observed responses", beforeUsage.observedResponses, afterUsage.observedResponses)
                assertNonDecreasing("complete responses", beforeUsage.completeResponses, afterUsage.completeResponses)
                assertNonDecreasing("new input tokens", beforeUsage.newInput.value, afterUsage.newInput.value)
                assertNonDecreasing("cache input tokens", beforeUsage.cacheHit.numerator, afterUsage.cacheHit.numerator)
                assertNonDecreasing("total input tokens", beforeUsage.cacheHit.denominator, afterUsage.cacheHit.denominator)
                assertNonDecreasing("actual tokens", beforeUsage.actual.value, afterUsage.actual.value)
                assertTrue("Usage Clawd sprite pixels did not move during the real-time run", pixelChanges.motionMask >= 100)
            }
        } finally {
            store.clear()
            client.disconnect()
        }
    }

    private fun keepScreenAwakeForTest(activity: ComponentActivity) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) activity.setTurnScreenOn(true)
    }

    private fun waitForRealUsage(viewModel: MonitorViewModel) {
        val deadline = SystemClock.elapsedRealtime() + 30_000L
        while (SystemClock.elapsedRealtime() < deadline) {
            val state = viewModel.uiState.value
            if (state.isConnected && state.snapshot.usage?.quota?.availability == "available") return
            SystemClock.sleep(50L)
        }
        val state = viewModel.uiState.value
        assertTrue("Production Relay did not connect", state.isConnected)
        assertTrue("Relay did not deliver available Codex quota", state.snapshot.usage?.quota?.availability == "available")
    }

    private fun waitForClawdScene(uiAutomation: UiAutomation): Bitmap {
        val deadline = SystemClock.elapsedRealtime() + 10_000L
        var screenshot = takeScreenshot(uiAutomation)
        while (SystemClock.elapsedRealtime() < deadline) {
            if (countClawdPixels(screenshot) >= 100) return screenshot
            screenshot.recycle()
            SystemClock.sleep(100L)
            screenshot = takeScreenshot(uiAutomation)
        }
        val matchingPixels = countClawdPixels(screenshot)
        val screenshotDirectory = requireNotNull(
            InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir("issue28-screenshots"),
        )
        check(screenshotDirectory.isDirectory || screenshotDirectory.mkdirs())
        saveBitmap(
            File(screenshotDirectory, "usage-scene-not-ready.png"),
            screenshot,
        )
        screenshot.recycle()
        assertTrue(
            "Clawd Usage sprite is not visible in the scene region; matchingPixels=$matchingPixels; failure screenshot saved locally",
            matchingPixels >= 100,
        )
        error("Unreachable")
    }

    private fun countClawdPixels(bitmap: Bitmap): Int {
        // The DBR-W00 test device is landscape: the Usage playground occupies 55%-90% of screen height.
        val top = (bitmap.height * 0.55f).toInt()
        val bottom = (bitmap.height * 0.90f).toInt()
        val pixels = IntArray(bitmap.width * (bottom - top))
        bitmap.getPixels(pixels, 0, bitmap.width, 0, top, bitmap.width, bottom - top)
        var matchCount = 0
        for (color in pixels) {
            val red = color shr 16 and 0xFF
            val green = color shr 8 and 0xFF
            val blue = color and 0xFF
            if (red > 170 && green in 80..150 && blue in 50..125) {
                matchCount++
                if (matchCount >= 100) return matchCount
            }
        }
        return matchCount
    }

    private fun runForPerformanceDuration() {
        val requested = InstrumentationRegistry.getArguments().getString("performanceDurationMs")
            ?.toLongOrNull() ?: 30_000L
        require(requested in 30_000L..180_000L) {
            "performanceDurationMs must be between 30000 and 180000"
        }
        val started = SystemClock.elapsedRealtime()
        while (SystemClock.elapsedRealtime() - started < requested) {
            SystemClock.sleep(1_000L)
        }
    }

    private data class ScenePixelChanges(val rawRegion: Int, val motionMask: Int)

    private fun changedScenePixels(before: Bitmap, after: Bitmap): ScenePixelChanges {
        require(before.width == after.width && before.height == after.height)
        val beforePixels = IntArray(before.width * before.height)
        val afterPixels = IntArray(after.width * after.height)
        before.getPixels(beforePixels, 0, before.width, 0, 0, before.width, before.height)
        after.getPixels(afterPixels, 0, after.width, 0, 0, after.width, after.height)
        // Keep the diff inside the DBR-W00 landscape playground viewport, away from metrics and footer.
        val top = (before.height * 0.55f).toInt()
        val bottom = (before.height * 0.90f).toInt()
        val start = top * before.width
        val end = bottom * before.width
        var rawRegion = 0
        var motionMask = 0
        for (index in start until end) {
            if (beforePixels[index] == afterPixels[index]) continue
            rawRegion++
            if (isClawdMotionPixel(beforePixels[index]) || isClawdMotionPixel(afterPixels[index])) motionMask++
        }
        return ScenePixelChanges(rawRegion, motionMask)
    }

    private fun isClawdMotionPixel(color: Int): Boolean {
        val red = color shr 16 and 0xFF
        val green = color shr 8 and 0xFF
        val blue = color and 0xFF
        val isClawdOrange = red > 170 && green in 80..150 && blue in 50..125
        val isBallGreen = green > 80 && green > red * 1.15 && green > blue * 1.1 && red in 45..150
        return isClawdOrange || isBallGreen
    }

    private fun assertNonDecreasing(label: String, before: Long?, after: Long?) {
        if (before != null && after != null) assertTrue("$label decreased during Usage sampling", after >= before)
    }

    private fun takeScreenshot(uiAutomation: UiAutomation): Bitmap =
        requireNotNull(uiAutomation.takeScreenshot()) { "Could not capture the running Usage screen" }

    private fun saveReport(
        mode: String,
        before: MonitorUiState,
        after: MonitorUiState,
        pixelChanges: ScenePixelChanges,
        beforeBitmap: Bitmap,
        afterBitmap: Bitmap,
    ) {
        val directory = requireNotNull(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir("issue28-screenshots"))
        check(directory.isDirectory || directory.mkdirs()) { "Screenshot directory unavailable" }
        saveBitmap(File(directory, "usage-runtime-before.png"), beforeBitmap)
        saveBitmap(File(directory, "usage-runtime-after.png"), afterBitmap)
        beforeBitmap.recycle()
        afterBitmap.recycle()
        val report = JSONObject().apply {
            put("mode", mode)
            put("initial", stateReport(before))
            put("final", stateReport(after))
            put("scene_changed_pixels_raw_region", pixelChanges.rawRegion)
            put("scene_changed_pixels_clawd_orange_and_ball_green", pixelChanges.motionMask)
            put("scene_sample_region", "55%-90% of DBR-W00 landscape screenshot height; motion count uses Clawd orange and ball green pixels")
        }
        File(directory, "runtime-report.json").writeText(report.toString(2))
    }

    private fun saveBitmap(file: File, bitmap: Bitmap) {
        file.outputStream().use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "Could not save ${file.name}" }
        }
    }

    private fun stateReport(state: MonitorUiState): JSONObject {
        val usage = state.snapshot.usage
        val cache = usage?.cacheHit
        val denominator = cache?.denominator
        val cacheRate = if (denominator != null && denominator > 0L && cache.numerator != null) {
            cache.numerator.toDouble() / denominator.toDouble()
        } else null
        return JSONObject().apply {
            put("connected", state.isConnected)
            put("last_sequence", state.snapshot.lastSequence)
            if (usage == null) return@apply
            put("usage_revision", usage.revision)
            put("observed_responses", usage.observedResponses)
            put("complete_responses", usage.completeResponses)
            put("new_input", usage.newInput.value ?: JSONObject.NULL)
            put("actual", usage.actual.value ?: JSONObject.NULL)
            put("cache_numerator", cache?.numerator ?: JSONObject.NULL)
            put("cache_denominator", denominator ?: JSONObject.NULL)
            put("cache_hit_rate_fraction", cacheRate ?: JSONObject.NULL)
            put("quota_availability", usage.quota.availability)
            put("quota_current", usage.quota.currentRemaining ?: JSONObject.NULL)
            put("quota_window", usage.quota.window ?: JSONObject.NULL)
            put("quota_window_minutes", usage.quota.windowMinutes ?: JSONObject.NULL)
            put("quota_reset_at", usage.quota.resetAt ?: JSONObject.NULL)
        }
    }

    private fun readSnapshot(path: String?): MonitorSnapshot {
        val raw = path?.let { File(it).readText() } ?: error("usageSnapshotPath is required")
        val provided = JSONObject(raw)
        val wire = if (provided.optString("type") == "snapshot") {
            provided
        } else {
            val fixtureRaw = InstrumentationRegistry.getInstrumentation().context.assets
                .open("usage-relay-snapshot.json").bufferedReader().use { it.readText() }
            JSONObject(fixtureRaw).put("usage", provided)
        }
        return requireNotNull(MonitorEvent.fromWireJson(wire.toString())).snapshot!!
    }
}

@Composable
private fun UsagePerformanceContent(
    viewModel: MonitorViewModel?,
    fallbackState: MutableState<MonitorUiState>?,
) {
    val relayState = viewModel?.uiState?.collectAsState()
    val state = relayState?.value ?: fallbackState?.value ?: MonitorUiState()
    UsageMonitorScreen(state, onReturnToStatus = {}, compact = false)
}
