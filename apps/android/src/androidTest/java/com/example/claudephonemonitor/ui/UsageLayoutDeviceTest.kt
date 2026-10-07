package com.example.claudephonemonitor.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import android.graphics.Bitmap
import android.os.Build
import android.view.WindowManager
import java.io.File
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorSnapshot
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.UsageQuota
import org.junit.Rule
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class UsageLayoutDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Before fun freezeFrameClock() {
        compose.mainClock.autoAdvance = false
        compose.runOnUiThread {
            compose.activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) compose.activity.setTurnScreenOn(true)
        }
    }

    @Test fun shortLandscapeKeepsUsageDialMetricsSceneAndFooterOnOneScreen() {
        render(short = true)
        compose.onNodeWithText("Usage 用量消耗").assertIsDisplayed()
        compose.onNodeWithText("Relay 已连接").assertIsDisplayed()
        compose.onNodeWithText("真实消耗 Tokens").assertIsDisplayed()
        compose.onNodeWithText("缓存命中率").assertIsDisplayed()
        compose.onNodeWithText("新增输入 Tokens").assertIsDisplayed()
        compose.onNodeWithText("总请求数").assertIsDisplayed()
        compose.onNodeWithTag("usage-quota").assertIsDisplayed()
        compose.onNodeWithTag("usage-playground").assertIsDisplayed()
        compose.onNodeWithTag("usage-freshness").assertIsDisplayed()
        compose.onNodeWithText("无可信额度源").assertDoesNotExist()
        val scene = compose.onNodeWithTag("usage-playground").fetchSemanticsNode().boundsInRoot
        val footer = compose.onNodeWithTag("usage-freshness").fetchSemanticsNode().boundsInRoot
        assertTrue("Clawd scene must remain above the footer", scene.bottom <= footer.top)
        capture("usage-short.png")
    }

    @Test fun quotaDialUsesTheParsedRemainingPercentAndShowsItsWindow() {
        render(short = true, availableQuota = true)
        compose.onNodeWithText("63%", substring = false).assertIsDisplayed()
        compose.onNodeWithText("启动时 88%", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Codex · 7天额度", substring = true).assertIsDisplayed()
        capture("usage-quota.png")
    }

    @Test fun fullScreenLayoutUsesRemainingHeightForTheClawdScene() {
        render(short = false, fullScreen = true)
        compose.onNodeWithTag("usage-root").assertIsDisplayed()
        compose.onNodeWithTag("usage-playground").assertIsDisplayed()
        capture("usage-full-screen.png")
    }

    @Test fun largeFontScaleStillShowsPrimaryUsageElementsWithoutSourceDetailScroll() {
        val path = InstrumentationRegistry.getArguments().getString("usageSnapshotPath")
        render(short = true, fontScale = 1.5f, availableQuota = path == null, usageSnapshotPath = path)
        val usage = requireNotNull(readSnapshot(path).usage)
        compose.onNodeWithTag("usage-title").assertIsDisplayed()
        compose.onNodeWithTag("usage-quota").assertIsDisplayed()
        compose.onNodeWithTag("usage-metrics").assertIsDisplayed()
        compose.onNodeWithText("缓存命中率").assertIsDisplayed()
        compose.onNodeWithTag("usage-playground").assertIsDisplayed()
        compose.onNodeWithTag("usage-range").assertIsDisplayed()
        capture(if (path == null) "usage-large-font-synthetic.png" else "usage-large-font-redacted.png")
        assertTextFits("usage-value-actual", usage.actual.let(::formatUsageMetric))
        assertTextFits("usage-value-cache-hit", formatCacheHitRate(usage))
        assertTextFits("usage-value-new-input", usage.newInput.let(::formatUsageMetric))
        assertTextFits("usage-value-request-count", formatObservedResponses(usage))
        assertTextFits("usage-quota-percent", null)
        assertTextFits("usage-quota-status", null)
        assertTextFits("usage-quota-start-legend", null)
        assertTextFits("usage-quota-current-legend", null)
        assertTextFits("usage-quota-window", null)
        compose.onNodeWithText("缓存命中 Tokens").assertDoesNotExist()
    }

    private fun render(short: Boolean, fontScale: Float = 1f, availableQuota: Boolean = false, usageSnapshotPath: String? = null, fullScreen: Boolean = false) {
        val parsedSnapshot = readSnapshot(usageSnapshotPath)
        val snapshot = if (availableQuota) {
            val reset = "2026-10-15T00:00:00Z"
            val usage = requireNotNull(parsedSnapshot.usage).copy(quota = UsageQuota(
                startRemaining = 88.0, currentRemaining = 63.0, unit = "percent", resetAt = reset,
                availability = "available", windowMinutes = 10080, window = "primary",
                source = "codex_app_server", limitId = "codex", sampledAt = "2026-10-08T01:05:00Z",
                startSampledAt = "2026-10-08T01:00:00Z", startResetAt = reset,
            ))
            parsedSnapshot.copy(usage = usage)
        } else parsedSnapshot
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                PhoneMonitorTheme {
                    Box(when {
                        short -> Modifier.size(720.dp, 320.dp)
                        fullScreen -> Modifier.fillMaxSize()
                        else -> Modifier.size(800.dp, 640.dp)
                    }) {
                        UsageMonitorScreen(
                            uiState = MonitorUiState(isConnected = true, snapshot = snapshot.copy(computerState = ComputerState.ONLINE)),
                            onReturnToStatus = {}, compact = short,
                        )
                    }
                }
            }
        }
        compose.waitForIdle()
        awaitUsageScene()
    }

    private fun readSnapshot(path: String?): MonitorSnapshot {
        val raw = path?.let { File(it).readText() } ?:
            InstrumentationRegistry.getInstrumentation().context.assets.open("usage-relay-snapshot.json").bufferedReader().use { it.readText() }
        val provided = JSONObject(raw)
        val wire = if (provided.optString("type") == "snapshot") {
            provided
        } else {
            val fixture = JSONObject(
                InstrumentationRegistry.getInstrumentation().context.assets.open("usage-relay-snapshot.json").bufferedReader().use { it.readText() },
            )
            fixture.put("usage", provided)
        }
        return requireNotNull(MonitorEvent.fromWireJson(wire.toString())).snapshot!!
    }

    private fun capture(name: String) {
        val image = compose.onNodeWithTag("usage-root").captureToImage().asAndroidBitmap()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = requireNotNull(context.getExternalFilesDir("issue28-screenshots"))
        directory.mkdirs()
        File(directory, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun awaitUsageScene() {
        val matcher = SemanticsMatcher.expectValue(ClawdKeyPoseKey, ClawdAction.USAGE_BALL.actionId)
        val ready = runCatching {
            compose.waitUntil(5_000L) {
                compose.mainClock.advanceTimeBy(32L)
                compose.onAllNodes(matcher, useUnmergedTree = true)
                    .fetchSemanticsNodes(atLeastOneRootRequired = false)
                    .any { it.config.getOrNull(ClawdImageReadyKey) == true }
            }
        }.isSuccess
        if (!ready) {
            val nodes = compose.onAllNodes(matcher, useUnmergedTree = true)
                .fetchSemanticsNodes(atLeastOneRootRequired = false)
            val diagnostic = nodes.map { node ->
                "ready=${node.config.getOrNull(ClawdImageReadyKey)}, bounds=${node.boundsInRoot}"
            }
            assertTrue("Clawd Usage scene not ready: nodeCount=${nodes.size}, nodes=$diagnostic", ready)
        }
        compose.waitForIdle()
    }

    private fun assertTextFits(tag: String, expectedText: String?) {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action -> action(layouts) }
        assertTrue("Expected a laid out Text for $tag", layouts.isNotEmpty())
        val layout = layouts.last()
        if (expectedText != null) assertEquals("Unexpected displayed value for $tag", expectedText, layout.layoutInput.text.text)
        val diagnostic = "size=${layout.size}, constraints=${layout.layoutInput.constraints}, " +
            "multiParagraph=${layout.multiParagraph.width}x${layout.multiParagraph.height}, " +
            "didOverflowHeight=${layout.didOverflowHeight}, didOverflowWidth=${layout.didOverflowWidth}"
        assertFalse("Text in $tag overflows vertically ($diagnostic)", layout.didOverflowHeight)
        for (line in 0 until layout.lineCount) {
            assertFalse("Text in $tag is ellipsized on line $line ($diagnostic)", layout.isLineEllipsized(line))
            val glyphWidth = layout.getLineRight(line) - layout.getLineLeft(line)
            assertTrue("Text glyphs in $tag exceed laid out width ($diagnostic)", glyphWidth <= layout.size.width + 1f)
        }
    }

}
