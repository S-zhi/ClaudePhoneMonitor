package com.example.claudephonemonitor.ui

import android.graphics.Bitmap
import android.os.Build
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.claudephonemonitor.monitor.ActivityVariation
import com.example.claudephonemonitor.monitor.MonitorUiState
import com.example.claudephonemonitor.monitor.PetState
import com.example.claudephonemonitor.monitor.ReminderStrength
import com.example.claudephonemonitor.monitor.StateChangeUi
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the production PNG renderer / clock. Requires an emulator or connected Android device. */
@RunWith(AndroidJUnit4::class)
class ClawdKeyPoseDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Before fun freezeClock() {
        compose.mainClock.autoAdvance = false
        compose.runOnUiThread {
            compose.activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) compose.activity.setTurnScreenOn(true)
        }
    }

    @Test fun everyMonitorStateDrawsItsBundledKeyPose() {
        val state = mutableStateOf(PetState.IDLE)
        compose.setContent {
            Box(Modifier.size(380.dp, 240.dp).background(Color.Black)) {
                ClawdProceduralView(state.value, ActivityVariation.CELEBRATE, modifier = Modifier.fillMaxSize())
            }
        }
        PetState.entries.forEach { petState ->
            compose.runOnIdle { state.value = petState }
            val action = resolveClawdAction(petState)
            awaitAsset(action)
            pose(action).assertIsDisplayed()
            val pixels = bitmapPixels(capturePose(action, "state-${action.actionId}.png"))
            val bodyColor = if (petState == PetState.OFFLINE) 0xFF6C7685.toInt() else 0xFFD97757.toInt()
            assertTrue("$petState must paint its PNG body", pixels.count { it == bodyColor } > 100)
            if (petState == PetState.ERROR) assertTrue("The red source mark stays visible through its alpha pulse", pixels.any {
                val red = it ushr 16 and 0xFF
                val green = it ushr 8 and 0xFF
                val blue = it and 0xFF
                red > 40 && red > green * 2 && red > blue * 2
            })
            if (petState == PetState.WORKING) {
                assertTrue(pixels.any { it == 0xFFA6A3A0.toInt() })
                assertTrue("Typing must use the original orange palm pixels", pixels.any { it == 0xFFE18B69.toInt() })
            }
        }
    }

    @Test fun typingChangesActualHandPixelsWhileTheRenderedLaptopStaysFixed() {
        compose.setContent {
            Box(Modifier.size(380.dp, 240.dp).background(Color.Black)) {
                ClawdProceduralView(PetState.WORKING, ActivityVariation.TOOL, modifier = Modifier.fillMaxSize())
            }
        }
        awaitAsset(ClawdAction.WORKING_TYPING)
        compose.mainClock.advanceTimeBy(ClawdAction.WORKING_TYPING.cycleMs - clock(ClawdAction.WORKING_TYPING) + 32L)
        compose.waitForIdle()
        val first = capturePose(ClawdAction.WORKING_TYPING, "working-typing-frame-1.png")
        val firstTime = clock(ClawdAction.WORKING_TYPING)
        compose.mainClock.advanceTimeBy(352L)
        compose.waitForIdle()
        val second = capturePose(ClawdAction.WORKING_TYPING, "working-typing-frame-2.png")
        assertNotEquals(firstTime, clock(ClawdAction.WORKING_TYPING))
        assertFalse("Two sampled typing frames must visibly differ", first.sameAs(second))
        val gray = setOf(0xFF686665.toInt(), 0xFFA6A3A0.toInt())
        val firstPixels = bitmapPixels(first)
        val firstGray = firstPixels.indices.filter { firstPixels[it] in gray }.toSet()
        val secondPixels = bitmapPixels(second)
        val secondGray = secondPixels.indices.filter { secondPixels[it] in gray }.toSet()
        assertTrue(firstGray.isNotEmpty())
        assertEquals("Every visible gray laptop pixel must stay at its screen coordinate", firstGray, secondGray)
    }

    @Test fun usageKeepsItsOwnActionThroughWeakRemindersAndStrongFinishKeepsTyping() {
        val state = mutableStateOf(MonitorUiState(petState = PetState.WORKING, usagePageVisible = true))
        compose.setContent {
            PhoneMonitorTheme {
                MonitorScreen(state.value, {}, {}, {}, {}, {}, {})
            }
        }
        awaitAsset(ClawdAction.USAGE_BALL)
        compose.mainClock.advanceTimeBy(176L)
        val initialPlayFrame = capturePose(ClawdAction.USAGE_BALL, "usage-ball-before-weak-reminder.png")
        assertTrue("Usage must paint the separately bundled complete ball", bitmapPixels(initialPlayFrame).any { it == 0xFF526F48.toInt() })
        compose.runOnIdle {
            state.value = state.value.copy(
                petState = PetState.ERROR,
                stateChange = StateChangeUi(PetState.FINISH, 5_000L, "secondary task", ReminderStrength.WEAK),
            )
        }
        compose.mainClock.advanceTimeBy(176L)
        val afterWeakReminder = capturePose(ClawdAction.USAGE_BALL, "usage-ball-after-weak-reminder.png")
        assertFalse("Weak reminders must not replace the independent Usage animation", initialPlayFrame.sameAs(afterWeakReminder))
        pose(ClawdAction.ERROR_ALERT).assertDoesNotExist()
        compose.runOnIdle {
            state.value = state.value.copy(
                petState = PetState.WORKING,
                stateChange = StateChangeUi(PetState.FINISH, 15_000L, "finished main", ReminderStrength.STRONG),
            )
        }
        awaitAsset(ClawdAction.WORKING_TYPING)
        pose(ClawdAction.USAGE_BALL).assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(stateChange = null) }
        awaitAsset(ClawdAction.USAGE_BALL)
        pose(ClawdAction.WORKING_TYPING).assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(usagePageVisible = false) }
        awaitAsset(ClawdAction.WORKING_TYPING)
        pose(ClawdAction.USAGE_BALL).assertDoesNotExist()
    }

    @Test fun exportsACompleteUsageCycleAsControlledDeviceFrames() {
        val action = ClawdAction.USAGE_BALL
        val cycleMs = action.cycleMs
        val sampleStepMs = 32L
        val frameCount = (cycleMs / sampleStepMs).toInt() + 1
        compose.setContent {
            Box(Modifier.size(640.dp, 180.dp).background(Color(0xFF1B1816))) {
                UsagePlayground(Modifier.fillMaxSize())
            }
        }
        awaitAsset(action)
        // The test clock begins at composition time; this controlled timeline samples the
        // rendered scene directly instead of observing a per-frame production semantics value.
        pose(action).assertIsDisplayed()
        val csv = StringBuilder("index,filename,requested_elapsed_ms,compose_clock_ms\n")
        val names = mutableListOf<String>()
        var previousFrame: Bitmap? = null
        var firstFrame: Bitmap? = null
        var changedFrames = 0
        repeat(frameCount) { index ->
            if (index > 0) compose.mainClock.advanceTimeBy(sampleStepMs)
            val name = "usage-cycle/frame-${index.toString().padStart(3, '0')}.png"
            val frame = capturePose(action, name)
            if (previousFrame != null && !previousFrame!!.sameAs(frame)) changedFrames++
            if (firstFrame == null) firstFrame = frame
            previousFrame = frame
            names += name
            csv.append("$index,$name,${index * sampleStepMs},${compose.mainClock.currentTime}\n")
        }
        val directory = screenshotDirectory()
        File(directory, "usage-cycle/samples.csv").writeText(csv.toString())
        val endpointChangedPixels = changedPixelCount(requireNotNull(firstFrame), requireNotNull(previousFrame))
        File(directory, "usage-cycle/capture-metadata.json").writeText(
            """{"source":"Android Compose captureToImage","mode":"controlled Compose test clock","wall_clock_recording":false,"sample_step_ms":$sampleStepMs,"cycle_ms":$cycleMs,"frame_count":$frameCount,"requested_elapsed_ms":$cycleMs,"changed_consecutive_frames":$changedFrames,"first_last_changed_pixels":$endpointChangedPixels}""",
        )
        assertEquals(251, names.size)
        assertTrue("The requested frame timeline must span one complete Usage cycle", (names.size - 1) * sampleStepMs == cycleMs)
        assertTrue("The controlled timeline must produce visible animation", changedFrames > frameCount / 4)
        assertTrue(
            "First and last frames should approximately match after one complete cycle; changedPixels=$endpointChangedPixels",
            endpointChangedPixels <= requireNotNull(firstFrame).width * requireNotNull(firstFrame).height / 50,
        )
        assertTrue(names.all { File(directory, it).isFile && File(directory, it).length() > 0L })
    }

    @Test fun lifecyclePauseOfflineSilentAndPageRemovalStopTheirClock() {
        val owner = TestLifecycleOwner()
        val state = mutableStateOf(PetState.WORKING)
        val visible = mutableStateOf(true)
        val silent = mutableStateOf(false)
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                if (visible.value) {
                    Box(Modifier.size(380.dp, 240.dp)) {
                        ClawdProceduralView(state.value, ActivityVariation.TOOL, silent.value, Modifier.fillMaxSize())
                    }
                }
            }
        }
        awaitAsset(ClawdAction.WORKING_TYPING)
        compose.mainClock.advanceTimeBy(384L)
        assertTrue(clock(ClawdAction.WORKING_TYPING) > 0L)
        compose.runOnIdle { owner.lifecycle.currentState = Lifecycle.State.CREATED }
        compose.mainClock.advanceTimeByFrame()
        val paused = clock(ClawdAction.WORKING_TYPING)
        compose.mainClock.advanceTimeBy(2_000L)
        assertEquals(paused, clock(ClawdAction.WORKING_TYPING))
        compose.runOnIdle { owner.lifecycle.currentState = Lifecycle.State.STARTED }
        compose.mainClock.advanceTimeBy(384L)
        assertNotEquals(paused, clock(ClawdAction.WORKING_TYPING))
        compose.runOnIdle { state.value = PetState.OFFLINE }
        awaitAsset(ClawdAction.OFFLINE_REST)
        compose.mainClock.advanceTimeBy(2_000L)
        assertEquals(0L, clock(ClawdAction.OFFLINE_REST))
        compose.runOnIdle { state.value = PetState.IDLE; silent.value = true }
        awaitAsset(ClawdAction.IDLE_REST)
        compose.mainClock.advanceTimeBy(2_000L)
        assertEquals(0L, clock(ClawdAction.IDLE_REST))
        compose.runOnIdle { state.value = PetState.WORKING; silent.value = false }
        awaitAsset(ClawdAction.WORKING_TYPING)
        compose.runOnIdle { visible.value = false }
        compose.mainClock.advanceTimeBy(2_000L)
        pose(ClawdAction.WORKING_TYPING).assertDoesNotExist()
    }

    private fun pose(action: ClawdAction) = compose.onNode(
        SemanticsMatcher.expectValue(ClawdKeyPoseKey, action.actionId), useUnmergedTree = true,
    )

    private fun clock(action: ClawdAction): Long = pose(action).fetchSemanticsNode().config[ClawdAnimationTimeKey]

    private fun capturePose(action: ClawdAction, filename: String): Bitmap {
        val bitmap = pose(action).captureToImage().asAndroidBitmap()
        val directory = screenshotDirectory()
        val file = File(directory, filename)
        val parent = requireNotNull(file.parentFile)
        assertTrue("Screenshot directory unavailable", parent.isDirectory || parent.mkdirs())
        file.outputStream().use { output ->
            assertTrue("Screenshot could not be saved: $filename", bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        }
        return bitmap
    }

    private fun screenshotDirectory(): File {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = requireNotNull(context.getExternalFilesDir("issue8-screenshots"))
        assertTrue("Screenshot directory unavailable", directory.isDirectory || directory.mkdirs())
        return directory
    }

    private fun changedPixelCount(first: Bitmap, last: Bitmap): Int {
        assertEquals(first.width, last.width)
        assertEquals(first.height, last.height)
        val firstPixels = bitmapPixels(first)
        val lastPixels = bitmapPixels(last)
        return firstPixels.indices.count { firstPixels[it] != lastPixels[it] }
    }

    private fun awaitAsset(action: ClawdAction) {
        compose.waitUntil(5_000L) {
            compose.mainClock.advanceTimeBy(32L)
            compose.onAllNodes(SemanticsMatcher.expectValue(ClawdKeyPoseKey, action.actionId), useUnmergedTree = true)
                .fetchSemanticsNodes(atLeastOneRootRequired = false)
                .any { it.config.getOrNull(ClawdImageReadyKey) == true }
        }
        compose.waitForIdle()
    }
}

private class TestLifecycleOwner : LifecycleOwner {
    override val lifecycle = LifecycleRegistry.createUnsafe(this).apply { currentState = Lifecycle.State.STARTED }
}

private fun bitmapPixels(bitmap: Bitmap): IntArray = IntArray(bitmap.width * bitmap.height).also {
    bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
}
