package com.example.claudephonemonitor.ui

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.ClaudeState
import com.example.claudephonemonitor.monitor.ComputerState
import com.example.claudephonemonitor.monitor.MonitorSnapshot
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.RecentCompletion
import com.example.claudephonemonitor.monitor.SessionSummary
import com.example.claudephonemonitor.monitor.StateChangeUi
import java.io.File
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Test-only fixtures render the production screen without a network client or pairing changes. */
@RunWith(AndroidJUnit4::class)
class MonitorReferenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Before fun freezeAnimationClock() {
        // The debug manifest fixes the host direction before launch, so setContent cannot be lost
        // to an asynchronous orientation recreation during the first test in the process.
        compose.mainClock.autoAdvance = false
    }

    @Test fun statusShowsAllFiveRowsAndGlobalCounts() {
        render(fixture())
        assertAllTitles()
        compose.onNodeWithText("Main Sessions · 06").assertIsDisplayed()
        compose.onNodeWithText("Main Running · 03").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 1: Working").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 3: Waiting").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 4: Idle").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 5: Done").assertIsDisplayed()
        compose.onNodeWithText("Total Running · 08 · Includes subagents").assertIsDisplayed()
        capture("status.png")
    }

    @Test fun legacyCountersRemainUnavailable() {
        val state = fixture()
        render(state.copy(snapshot = state.snapshot.copy(mainRunningCount = null, mainSessionCount = null, totalRunningCount = null)))
        compose.onNodeWithText("Main Sessions · —").assertIsDisplayed()
        compose.onNodeWithText("Main Running · —").assertIsDisplayed()
        compose.onNodeWithText("Total Running · — · Includes subagents").assertIsDisplayed()
    }

    @Test fun childRowsDoNotDisplaceMainRows() {
        val state = fixture()
        val child = SessionSummary("child", "Hidden child", ClaudeState.WORKING, 1000,
            com.example.claudephonemonitor.monitor.SessionKind.SUBAGENT)
        render(state.copy(snapshot = state.snapshot.copy(sessions = listOf(child) + state.snapshot.sessions.orEmpty())))
        assertAllTitles()
        compose.onNodeWithText("Hidden child").assertDoesNotExist()
    }

    @Test fun completionRetainsWorkingAnimationAndNamesTheMatchingRow() {
        render(fixture().copy(stateChange = StateChangeUi(PetState.FINISH, 15_000L, titles.last())))
        assertAllTitles()
        compose.onNodeWithText("任务完成：${titles.last()}").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 5: Done").assertIsDisplayed()
        compose.onNodeWithContentDescription("Clawd animation: WORKING").assertIsDisplayed()
        capture("state-change.png")
    }

    @Test fun shortLandscapeKeepsAllFiveRowsVisible() {
        render(fixture(), short = true)
        assertAllTitles()
        capture("status-short.png")
    }

    @Test fun largeFontsKeepTheFinalSessionReachable() {
        render(fixture(), short = true, fontScale = 2f)
        // Scroll requests a new measure/layout frame. Let the clock advance until the action and
        // assertion settle, then freeze again so the captured sprite does not move between frames.
        compose.mainClock.autoAdvance = true
        compose.onNodeWithText(titles.last()).performScrollTo().assertIsDisplayed()
        compose.mainClock.autoAdvance = false
        capture("status-large-font.png")
    }

    private fun render(state: MonitorUiState, short: Boolean = false, fontScale: Float = 1f) {
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                PhoneMonitorTheme {
                    Box(if (short) Modifier.size(720.dp, 320.dp) else Modifier) {
                        MonitorScreen(
                            uiState = state,
                            onToggleControls = {}, onHideControls = {}, onOpenUsage = {},
                            onReturnToStatus = {}, onReconnect = {}, onRePair = {},
                        )
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(100L)
        compose.waitForIdle()
    }

    private fun assertAllTitles() = titles.forEach { compose.onNodeWithText(it).assertIsDisplayed() }

    private fun capture(name: String) {
        val bitmap = compose.onNodeWithTag("monitor-stage").captureToImage().asAndroidBitmap()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = requireNotNull(context.getExternalFilesDir("issue4-screenshots"))
        directory.mkdirs()
        File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    companion object {
        private val titles = listOf(
            "Support Chinese",
            "优化 Session 排序：保留中文会话名称与最近活动优先级",
            "Fix Relay reconnect after a temporarily unavailable network",
            "整理项目文档",
            "验证移动端布局",
        )

        private fun fixture(): MonitorUiState {
            val completion = RecentCompletion("done", sequence = 65, occurredAt = "", displayName = titles.last())
            val sessions = listOf(
                SessionSummary("first", titles[0], ClaudeState.WORKING, 100),
                SessionSummary("second", titles[1], ClaudeState.WORKING, 90),
                SessionSummary("waiting", titles[2], ClaudeState.WAITING, 80),
                SessionSummary("idle", titles[3], ClaudeState.IDLE, 70),
                SessionSummary("done", titles[4], ClaudeState.IDLE, 60),
                SessionSummary("outside-top-five", "Older task still running", ClaudeState.WORKING, 10),
            )
            return MonitorUiState(
                snapshot = MonitorSnapshot(
                    computerState = ComputerState.ONLINE,
                    claudeState = ClaudeState.WORKING,
                    sessions = sessions, runningCount = 3, sessionCount = 6,
                    mainRunningCount = 3, mainSessionCount = 6, totalRunningCount = 8,
                    recentCompletion = completion,
                ),
                petState = PetState.WORKING, activity = ActivityVariation.TOOL,
                isConnected = true, recentSessionCompletion = completion,
            )
        }
    }
}
