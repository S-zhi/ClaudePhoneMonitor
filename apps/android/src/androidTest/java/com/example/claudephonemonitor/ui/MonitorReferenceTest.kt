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
import androidx.compose.ui.test.isDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
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
import com.example.claudephonemonitor.monitor.ReminderStrength
import com.example.claudephonemonitor.monitor.SessionSummary
import com.example.claudephonemonitor.monitor.StateChangeUi
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Test-only fixtures render the production screen without a network client or pairing changes. */
@RunWith(AndroidJUnit4::class)
class MonitorReferenceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Before fun resetAnimationClock() {
        // The debug manifest fixes the host direction before launch, so setContent cannot be lost
        // to an asynchronous orientation recreation during the first test in the process.
        // Let each fresh Activity finish composing and measuring before freezing its animations.
        compose.mainClock.autoAdvance = true
    }

    @Test fun statusShowsAllFiveRowsAndGlobalCounts() {
        render(fixture())
        assertAllTitles()
        compose.onNodeWithText("Main Sessions · 06").assertIsDisplayed()
        compose.onNodeWithText("Main Running · 03").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 1: Working").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 3: Waiting").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 4: Idle").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session 5: DONE").assertIsDisplayed()
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

    @Test fun completionPosterNamesFinishedSessionWhileOtherTasksKeepWorking() {
        render(fixture().copy(stateChange = StateChangeUi(PetState.FINISH, 15_000L, titles.last(), ReminderStrength.STRONG)))
        assertPosterLayout(titles.last())
        compose.onNodeWithText("仍有 3 项任务运行中").assertIsDisplayed()
        compose.onNodeWithContentDescription("Clawd animation: WORKING").assertIsDisplayed()
        capture("state-change.png")
    }

    @Test fun completedMainTaskUsesFullPosterAndCelebrates() {
        render(completedFixture(titles.first()))
        assertPosterLayout(titles.first())
        compose.onNodeWithContentDescription("Clawd animation: DONE").assertIsDisplayed()
        compose.onNodeWithText("仍有 0 项任务运行中").assertDoesNotExist()
        capture("finish-poster.png", "strong-reminder-screenshots")
    }

    @Test fun strongPosterKeepsLongChineseNameVisibleOnShortLandscape() {
        render(completedFixture(titles[1]), short = true)
        assertPosterLayout(titles[1])
        compose.onNodeWithContentDescription("Clawd animation: DONE").assertIsDisplayed()
        capture("finish-poster-short.png", "strong-reminder-screenshots")
    }

    @Test fun strongPosterHandlesLargeFontsWithoutLosingTitleOrName() {
        render(completedFixture(titles[1]), short = true, fontScale = 2f)
        assertPosterLayout(titles[1])
        compose.onNodeWithContentDescription("Clawd animation: DONE").assertIsDisplayed()
        capture("finish-poster-large-font.png", "strong-reminder-screenshots")
    }

    @Test fun weakCompletionStaysOnStatusPage() {
        render(fixture().copy(stateChange = StateChangeUi(PetState.FINISH, 5_000L, titles.last())))
        compose.onNodeWithTag("session-list").assertIsDisplayed()
        compose.onNodeWithTag("weak-reminder").assertIsDisplayed()
        compose.onNodeWithText("任务完成：${titles.last()}").assertIsDisplayed()
        compose.onNodeWithTag("state-change-title").assertDoesNotExist()
        capture("weak-status.png", "issue17-screenshots")
    }

    @Test fun weakCompletionStaysOnUsagePage() {
        render(fixture().copy(
            usagePageVisible = true,
            stateChange = StateChangeUi(PetState.FINISH, 5_000L, titles.last()),
        ))
        compose.onNodeWithText("Usage 用量消耗").assertIsDisplayed()
        compose.onNodeWithTag("weak-reminder").assertIsDisplayed()
        compose.onNodeWithTag("session-list").assertDoesNotExist()
        capture("weak-usage.png", "issue17-screenshots")
    }

    @Test fun strongCompletionIsVisibleAboveUsagePage() {
        render(fixture().copy(
            usagePageVisible = true,
            stateChange = StateChangeUi(PetState.FINISH, 15_000L, titles.last(), ReminderStrength.STRONG),
        ))
        assertPosterLayout(titles.last())
        compose.onNodeWithText("Usage 用量消耗").assertDoesNotExist()
        capture("strong-from-usage.png", "issue17-screenshots")
    }

    @Test fun shortLandscapeKeepsAllFiveRowsVisible() {
        render(fixture(), short = true)
        compose.waitUntil(5_000L) { titles.all { compose.onNodeWithText(it).isDisplayed() } }
        assertAllTitles()
        capture("status-short.png")
    }

    @Test fun largeFontsKeepTheFinalSessionReachable() {
        render(fixture(), short = true, fontScale = 2f)
        // Scroll requests a new measure/layout frame. Let the clock advance until the action and
        // assertion settle, then freeze again so the captured sprite does not move between frames.
        compose.mainClock.autoAdvance = true
        compose.onNodeWithText(titles.last()).performScrollTo()
        compose.waitUntil(5_000L) { compose.onNodeWithText(titles.last()).isDisplayed() }
        compose.mainClock.autoAdvance = false
        compose.onNodeWithText(titles.last()).assertIsDisplayed()
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
        compose.waitUntil(5_000L) {
            compose.onAllNodesWithTag("monitor-stage")
                .fetchSemanticsNodes(atLeastOneRootRequired = false)
                .any { it.size.width > 0 && it.size.height > 0 }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        compose.mainClock.advanceTimeBy(100L)
        compose.waitForIdle()
    }

    private fun assertAllTitles() = titles.forEach { compose.onNodeWithText(it).assertIsDisplayed() }

    private fun assertPosterLayout(completionName: String) {
        compose.onNodeWithTag("state-change-poster").assertIsDisplayed()
        compose.onNodeWithTag("state-change-title").assertIsDisplayed()
        compose.onNodeWithText(completionName).assertIsDisplayed()
        compose.onNodeWithText("任务完成：$completionName").assertDoesNotExist()
        compose.onNodeWithTag("session-list").assertDoesNotExist()
        val stage = compose.onNodeWithTag("monitor-stage").fetchSemanticsNode().boundsInRoot
        val title = compose.onNodeWithTag("state-change-title").fetchSemanticsNode().boundsInRoot
        val name = compose.onNodeWithTag("state-change-name").fetchSemanticsNode().boundsInRoot
        val clawd = compose.onNodeWithTag("clawd").fetchSemanticsNode().boundsInRoot
        assertTrue("The display title must fill the left side", title.width >= stage.width * 0.30f)
        assertTrue("Clawd must occupy the full right side", clawd.width >= stage.width * 0.45f)
        assertTrue("The title and name must sit to the left of Clawd", title.right <= clawd.left && name.right <= clawd.left)
        assertTrue("The session name must sit below the title", name.top >= title.bottom)
        assertTrue("The title and name must remain inside the short or scaled stage", title.top >= stage.top && name.bottom <= stage.bottom)
    }

    private fun capture(name: String, directoryName: String = "issue4-screenshots") {
        val bitmap = compose.onNodeWithTag("monitor-stage").captureToImage().asAndroidBitmap()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = requireNotNull(context.getExternalFilesDir(directoryName))
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

        private fun completedFixture(name: String): MonitorUiState {
            val completion = RecentCompletion("finished-main", sequence = 65, occurredAt = "", displayName = name)
            return MonitorUiState(
                snapshot = MonitorSnapshot(
                    computerState = ComputerState.ONLINE,
                    claudeState = ClaudeState.IDLE,
                    sessions = listOf(SessionSummary("finished-main", name, ClaudeState.IDLE, 65)),
                    mainRunningCount = 0, mainSessionCount = 1, totalRunningCount = 0,
                    recentCompletion = completion,
                ),
                petState = PetState.IDLE,
                stateChange = StateChangeUi(PetState.FINISH, 15_000L, name, ReminderStrength.STRONG),
                isConnected = true,
                recentSessionCompletion = completion,
            )
        }
    }
}
