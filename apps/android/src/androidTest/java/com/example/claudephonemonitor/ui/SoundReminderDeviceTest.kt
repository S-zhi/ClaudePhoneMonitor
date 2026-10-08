package com.example.claudephonemonitor.ui

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.app.KeyguardManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.os.Vibrator
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.example.claudephonemonitor.monitor.AndroidReminderCueLedger
import com.example.claudephonemonitor.monitor.AndroidReminderCuePlayer
import com.example.claudephonemonitor.monitor.MonitorClient
import com.example.claudephonemonitor.monitor.MonitorCommand
import com.example.claudephonemonitor.monitor.MonitorEvent
import com.example.claudephonemonitor.monitor.MonitorViewModel
import com.example.claudephonemonitor.monitor.ReminderCue
import com.example.claudephonemonitor.monitor.ReminderStrength
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Uses the real SoundPool and monitor ViewModel with anonymous, local-only event fixtures. */
@RunWith(AndroidJUnit4::class)
class SoundReminderDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val displayedViewModel = mutableStateOf<MonitorViewModel?>(null)
    private var screenInstalled = false

    @Test
    fun aPreviouslyUnseenPendingApprovalInTheFirstSnapshotPlaysOnce() = withOriginalAudioState { original ->
        prepareAudibleState(original)
        val installationId = UUID.randomUUID().toString()
        val requestId = UUID.randomUUID().toString()
        val observations = CopyOnWriteArrayList<NativePlayback>()
        val rig = createRig(installationId, observations, initialApprovals = listOf(
            approvalJson(requestId, "fixture-initial-codex", 1, "codex"),
        ))
        try {
            awaitPlaybackCount(observations, 1)
            assertEquals(requestId, rig.vm.uiState.value.approvals.single().requestId)
            rig.emitApprovalSnapshot(requestId, "fixture-initial-codex", rig.nextSequence())
            noNewPlayback(observations, 1)
            writeSummary("first-snapshot-approval", original, observations,
                rig.playbackProbe.notificationUsageCallbacks.get())
        } finally {
            rig.close()
        }
    }

    @Test
    fun nativePlaybackThresholdDedupeQueueSnapshotAndRecreation() = withOriginalAudioState { original ->
        prepareAudibleState(original)
        val installationId = UUID.randomUUID().toString()
        val observations = CopyOnWriteArrayList<NativePlayback>()
        val usageEvidence = AtomicInteger()
        var rig = createRig(installationId, observations, usageEvidence)
        try {
            rig.emitFinish("fixture-short-299000", 299_000L)
            rig.waitSequence(2)
            noNewPlayback(observations, 0)
            rig.emitFinish("fixture-short-299999", 299_999L)
            rig.waitSequence(3)
            noNewPlayback(observations, 0)

            rig.vm.showUsagePage()
            rig.emitFinish("fixture-exact-five-minutes", 300_000L)
            rig.waitSequence(4)
            awaitPlaybackCount(observations, 1)
            assertEquals(ReminderStrength.WEAK, rig.vm.uiState.value.stateChange?.strength)
            assertEquals(MonitorPage.USAGE, selectMonitorPage(rig.vm.uiState.value))
            refreshScreen()
            saveScreen("normal-threshold.png")

            val exactIdentity = CompletionIdentity("fixture-exact-five-minutes", "task-fixture-exact-five-minutes", 4, 300_000L)
            rig.client.emit(finishJson(installationId, exactIdentity))
            rig.emitCompletionSnapshot(exactIdentity)
            awaitSequence(rig, 5)
            noNewPlayback(observations, 1)

            // A near-simultaneous long completion and new Claude request exercise the real cue queue.
            rig.emitFinish("fixture-long-300001", 300_001L)
            val claudeRequestId = UUID.randomUUID().toString()
            val claudeSequence = rig.nextSequence()
            rig.client.emit(approvalEventJson(installationId, claudeRequestId, "fixture-claude-approval", claudeSequence,
                source = "claude_code"))
            awaitPlaybackCount(observations, 3)
            assertTrue("Queued native sounds must not overlap the 440ms WAV",
                observations[2].atMs - observations[1].atMs >= WAV_DURATION_MS)
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(rig.vm.uiState.value))

            // A newly accepted finish remains audible while a separate approval owns the page.
            rig.emitFinish("fixture-finish-under-approval", 300_100L)
            awaitPlaybackCount(observations, 4)
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(rig.vm.uiState.value))

            // Codex is represented by a pending request in the initial snapshot for this identity.
            val codexRequestId = UUID.randomUUID().toString()
            val codexSequence = rig.nextSequence()
            rig.emitApprovalSnapshot(codexRequestId, "fixture-codex-approval", codexSequence)
            awaitPlaybackCount(observations, 5)
            val countAfterSources = observations.size
            rig.emitApprovalSnapshot(codexRequestId, "fixture-codex-approval", rig.nextSequence())
            rig.emitCompletionSnapshot(exactIdentity, rig.nextSequence())
            rig.vm.showStatusPage()
            rig.vm.showUsagePage()
            rig.client.emit("""{"type":"disconnected"}""")
            rig.client.emit("""{"type":"connected"}""")
            rig.emitCompletionSnapshot(exactIdentity, rig.nextSequence())
            noNewPlayback(observations, countAfterSources)

            // Ordinary failures and waits are not sound candidates.
            rig.emit("""{"type":"event","event_type":"waiting","session_id":"fixture-wait","sequence":${rig.nextSequence()},"payload":{"reason":"question","duration_ms":900000}}""")
            rig.emit("""{"type":"event","event_type":"tool_failed","session_id":"fixture-tool-failure","sequence":${rig.nextSequence()},"payload":{"duration_ms":900000}}""")
            rig.emit("""{"type":"event","event_type":"task_failed","session_id":"fixture-task-failure","sequence":${rig.nextSequence()},"payload":{"duration_ms":900000}}""")
            rig.waitSequence(rig.lastSequence)
            noNewPlayback(observations, countAfterSources)

            // Duration can be recovered when Relay later enriches the same completion identity.
            val recovered = CompletionIdentity("fixture-recovered-completion", "task-fixture-recovered-completion",
                rig.nextSequence(), 300_000L)
            rig.client.emit(finishJson(installationId, recovered.copy(durationMs = null)))
            awaitSequence(rig, recovered.sequence)
            noNewPlayback(observations, countAfterSources)
            rig.emitCompletionSnapshot(recovered)
            awaitPlaybackCount(observations, countAfterSources + 1)
            rig.emitCompletionSnapshot(recovered, rig.nextSequence())
            noNewPlayback(observations, countAfterSources + 1)

            writeSummary("native-playback", original, observations, usageEvidence.get())

            // A fresh VM and a fresh Android preferences wrapper must retain dedupe identities.
            val replayWatermark = rig.lastSequence + 1L
            rig.close()
            rig = createRig(installationId, observations, usageEvidence)
            rig.emitReplaySnapshot(exactIdentity, claudeRequestId, claudeSequence, codexRequestId, codexSequence,
                lastSequence = replayWatermark)
            noNewPlayback(observations, countAfterSources + 1)
            rig.emitFinish("fixture-new-after-recreation", 300_000L)
            awaitPlaybackCount(observations, countAfterSources + 2)
            assertEquals(countAfterSources + 2, observations.size)
            writeSummary("recreated-ledger", original, observations, usageEvidence.get())
        } finally {
            rig.close()
        }
    }

    @Test fun silentRingerConsumesCueAndDoesNotReplayAfterRestore() = verifyMutedIdentity(
        "ringer-silent",
        mute = { state -> assumeTrue("SKIP: unable to set silent ringer mode", setRingerMode(AudioManager.RINGER_MODE_SILENT)) },
        restoreMute = { state -> setRingerMode(state.ringerMode) },
    )

    @Test fun manualAudibilityPreviewRequiresExplicitOptIn() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Pass -e issue26_manual_audio notification-preview to play the three-cue preview",
            args.getString("issue26_manual_audio") == "notification-preview")
        val requestedPreviewVolume = args.getString("issue26_preview_volume")?.toIntOrNull() ?: 12
        assumeTrue("issue26_preview_volume must be an integer from 1 through 15", requestedPreviewVolume in 1..15)

        withOriginalAudioState { original ->
            prepareAudibleState(original)
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val notificationIndexBefore = audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION)
            val ringIndexBefore = audio.getStreamVolume(AudioManager.STREAM_RING)
            val notificationMuteBefore = audio.isStreamMute(AudioManager.STREAM_NOTIFICATION)
            val ringMuteBefore = audio.isStreamMute(AudioManager.STREAM_RING)
            val alreadyKeptOn = compose.activity.window.attributes.flags and
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
            val observations = CopyOnWriteArrayList<NativePlayback>()
            var player: AndroidReminderCuePlayer? = null
            var previewFailure: Throwable? = null

            compose.runOnUiThread { compose.activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            try {
                val notificationTarget = minOf(requestedPreviewVolume, audio.getStreamMaxVolume(AudioManager.STREAM_NOTIFICATION))
                val notificationChanged = setStreamVolumeDirect(AudioManager.STREAM_NOTIFICATION, notificationTarget) &&
                    waitUntilStable(2_000L) {
                        audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == notificationTarget
                    }
                if (!notificationChanged) {
                    val ringTarget = minOf(requestedPreviewVolume, audio.getStreamMaxVolume(AudioManager.STREAM_RING))
                    setStreamVolumeDirect(AudioManager.STREAM_RING, ringTarget)
                    waitUntilStable(2_000L) {
                        audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == notificationTarget
                    }
                }
                val actualNotification = audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION)
                val actualRing = audio.getStreamVolume(AudioManager.STREAM_RING)
                val actualInternalMode = parseInternalRingerMode(shell("dumpsys audio"))
                assumeTrue(
                    "SKIP: could not raise/read back notification index $notificationTarget with NORMAL, DND off, and unmuted streams; " +
                        "notification=$actualNotification, ring=$actualRing, ringer=${audio.ringerMode}, " +
                        "internal=$actualInternalMode, filter=${notifications.currentInterruptionFilter}, " +
                        "notificationMuted=${audio.isStreamMute(AudioManager.STREAM_NOTIFICATION)}, ringMuted=${audio.isStreamMute(AudioManager.STREAM_RING)}",
                    actualNotification == notificationTarget && audio.ringerMode == AudioManager.RINGER_MODE_NORMAL &&
                        actualInternalMode == AudioManager.RINGER_MODE_NORMAL &&
                        notifications.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALL &&
                        !audio.isStreamMute(AudioManager.STREAM_NOTIFICATION) && !audio.isStreamMute(AudioManager.STREAM_RING),
                )

                SystemClock.sleep(3_000L)
                val activePlayer = AndroidReminderCuePlayer(context) { cue, streamId ->
                    observations += NativePlayback(cue, streamId, SystemClock.elapsedRealtime())
                }
                player = activePlayer
                repeat(3) { index ->
                    activePlayer.play(ReminderCue.APPROVAL_PENDING)
                    awaitNativePlaybackCount(observations, index + 1, 5_000L)
                    if (index < 2) SystemClock.sleep(1_000L)
                }
                SystemClock.sleep(520L)
                check(observations.size == 3 && observations.all { it.streamId != 0 })
                val evidence = buildString {
                    appendLine("scenario=manual-notification-audibility-preview")
                    appendLine("requested_preview_volume=$requestedPreviewVolume")
                    appendLine("original_external_ringer_mode=${original.ringerMode}")
                    appendLine("original_internal_ringer_mode=${original.internalRingerMode}:${ringerModeName(original.internalRingerMode)}")
                    appendLine("original_notification_volume=${original.notificationVolume}")
                    appendLine("original_notification_muted=${original.notificationStreamMuted}")
                    appendLine("preview_notification_index_before=$notificationIndexBefore")
                    appendLine("preview_ring_index_before=$ringIndexBefore")
                    appendLine("preview_notification_mute_before=$notificationMuteBefore")
                    appendLine("preview_ring_mute_before=$ringMuteBefore")
                    appendLine("preview_notification_index_actual=$actualNotification")
                    appendLine("preview_ring_index_actual=$actualRing")
                    appendLine("preview_internal_ringer_mode_actual=$actualInternalMode")
                    appendLine("preview_external_ringer_mode_actual=${audio.ringerMode}")
                    appendLine("preview_notification_mute_actual=${audio.isStreamMute(AudioManager.STREAM_NOTIFICATION)}")
                    appendLine("preview_ring_mute_actual=${audio.isStreamMute(AudioManager.STREAM_RING)}")
                    appendLine("preview_interruption_filter_actual=${notifications.currentInterruptionFilter}")
                    appendLine("native_successful_stream_count=${observations.size}")
                    observations.forEach { appendLine("native_cue=${it.cue},stream_id=${it.streamId},elapsed_realtime_ms=${it.atMs}") }
                }
                val directory = requireNotNull(context.getExternalFilesDir("issue26-evidence"))
                directory.mkdirs()
                File(directory, "manual-notification-audibility-preview.txt").writeText(evidence)
                android.util.Log.i(TAG, "Issue26 manual audio preview evidence:\n$evidence")
            } catch (failure: Throwable) {
                previewFailure = failure
            } finally {
                observations.lastOrNull()?.let { last ->
                    val tailMs = WAV_DURATION_MS + 80L - (SystemClock.elapsedRealtime() - last.atMs)
                    if (tailMs > 0L) SystemClock.sleep(tailMs)
                }
                runCatching { player?.close() }.onFailure { previewFailure?.addSuppressed(it) ?: run { previewFailure = it } }
                val restoreFailure = runCatching {
                    restoreManualPreviewAudioState(
                        audio, notifications, notificationIndexBefore, ringIndexBefore,
                        notificationMuteBefore, ringMuteBefore,
                    )
                }.exceptionOrNull()
                if (restoreFailure != null) {
                    previewFailure?.addSuppressed(restoreFailure) ?: run { previewFailure = restoreFailure }
                }
                if (!alreadyKeptOn) compose.runOnUiThread {
                    compose.activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
            previewFailure?.let { throw it }
        }
    }

    @Test fun vibrateRingerConsumesCueAndDoesNotReplayAfterRestore() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        assumeTrue("SKIP: device has no vibrator hardware (hasVibrator=${vibrator.hasVibrator()})", vibrator.hasVibrator())
        verifyMutedIdentity(
            "ringer-vibrate",
            mute = { _ -> assumeTrue("SKIP: unable to set vibrate ringer mode", setRingerMode(AudioManager.RINGER_MODE_VIBRATE)) },
            restoreMute = { state -> setRingerMode(state.ringerMode) },
        )
    }

    @Test fun zeroNotificationVolumeConsumesCueAndDoesNotReplayAfterRestore() {
        var muteAtAudibleBaseline = false
        verifyMutedIdentity(
            "notification-volume-zero",
            mute = { _ ->
                val context = InstrumentationRegistry.getInstrumentation().targetContext
                val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                muteAtAudibleBaseline = audio.isStreamMute(AudioManager.STREAM_NOTIFICATION)
                setNotificationVolume(0)
                var readZero = waitUntilStable(1_500L) {
                    audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == 0
                }
                if (!readZero) {
                    setNotificationStreamMuted(true)
                    readZero = waitUntilStable(1_500L) {
                        audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == 0 &&
                            audio.isStreamMute(AudioManager.STREAM_NOTIFICATION)
                    }
                }
                assumeTrue("SKIP: notification mute did not read back as zero while ringer NORMAL and DND off; " +
                    "volume=${audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION)}, " +
                    "ringer=${audio.ringerMode}, filter=${notifications.currentInterruptionFilter}",
                    readZero && audio.ringerMode == AudioManager.RINGER_MODE_NORMAL &&
                        notifications.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALL)
            },
            restoreMute = {
                check(setNotificationStreamMuted(muteAtAudibleBaseline)) {
                    "Could not restore notification stream mute bit captured with DND off"
                }
            },
        )
    }

    @Test fun doNotDisturbConsumesCueAndDoesNotReplayAfterRestore() = verifyMutedIdentity(
        "dnd-none",
        mute = { _ -> assumeTrue("SKIP: cmd notification could not enable DND", setDnd("none")) },
        restoreMute = { _ -> assumeTrue("SKIP: cmd notification could not restore normal interruption filter", setDnd("all")) },
    )

    private fun verifyMutedIdentity(
        label: String,
        mute: (OriginalAudioState) -> Unit,
        restoreMute: (OriginalAudioState) -> Unit,
    ) = withOriginalAudioState { original ->
        prepareAudibleState(original)
        val installationId = UUID.randomUUID().toString()
        val observations = CopyOnWriteArrayList<NativePlayback>()
        val usageEvidence = AtomicInteger()
        var rig = createRig(installationId, observations, usageEvidence)
        val completion = CompletionIdentity("fixture-muted-$label", "task-muted-$label", 2, 300_000L)
        var muteNeedsRestore = false
        var silentPhaseNativeCount = -1
        var mutePhaseVolume = -1
        var mutePhaseStreamMuted: Boolean? = null
        try {
            muteNeedsRestore = true
            mute(original)
            val audio = InstrumentationRegistry.getInstrumentation().targetContext
                .getSystemService(Context.AUDIO_SERVICE) as AudioManager
            mutePhaseVolume = audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION)
            mutePhaseStreamMuted = audio.isStreamMute(AudioManager.STREAM_NOTIFICATION)
            rig.client.emit(finishJson(installationId, completion))
            rig.waitSequence(completion.sequence)
            SystemClock.sleep(900L)
            assertEquals("No native stream may be requested while $label is active", 0, observations.size)
            silentPhaseNativeCount = observations.size

            restoreMute(original)
            muteNeedsRestore = false
            assumeTrue("SKIP: unable to restore non-DND state before replay", setDnd("all"))
            assumeTrue("SKIP: unable to restore an audible state before replay", setRingerMode(AudioManager.RINGER_MODE_NORMAL))
            assumeTrue("SKIP: unable to restore nonzero notification volume before replay",
                setNotificationVolume(maxOf(original.notificationVolume, 1)))

            rig.close()
            rig = createRig(installationId, observations, usageEvidence) // new VM/player and fresh ledger over the isolated test preferences
            rig.emitCompletionSnapshot(completion, lastSequence = 2)
            noNewPlayback(observations, 0)
            rig.emitFinish("fixture-audible-after-$label", 300_000L)
            awaitPlaybackCount(observations, 1)
            assertEquals("Only the new identity should play after the muted replay", 1, observations.size)
            writeSummary(label, original, observations, usageEvidence.get(), mapOf(
                "silent_phase_native_count" to silentPhaseNativeCount.toString(),
                "mute_phase_notification_volume" to mutePhaseVolume.toString(),
                "mute_phase_isStreamMute" to mutePhaseStreamMuted.toString(),
                "restored_fresh_count" to (observations.size - silentPhaseNativeCount).toString(),
            ))
        } finally {
            try {
                if (muteNeedsRestore) runCatching { restoreMute(original) }
            } finally {
                rig.close()
            }
        }
    }

    private fun createRig(
        installationId: String,
        observations: CopyOnWriteArrayList<NativePlayback> = CopyOnWriteArrayList(),
        usageEvidence: AtomicInteger = AtomicInteger(),
        initialApprovals: List<String> = emptyList(),
    ): Rig {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val targetContext = instrumentation.targetContext
        val testContext = IsolatedTestLedgerContext(targetContext)
        val playbackProbe = AudioPlaybackProbe(targetContext, usageEvidence)
        val player = AndroidReminderCuePlayer(targetContext) { cue, streamId ->
            observations += NativePlayback(cue, streamId, SystemClock.elapsedRealtime())
        }
        val ledger = AndroidReminderCueLedger(testContext)
        val client = DeviceFixtureClient(installationId, initialApprovals)
        val store = ViewModelStore()
        lateinit var viewModel: MonitorViewModel
        compose.runOnUiThread {
            compose.activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            viewModel = MonitorViewModel(client, player, ledger, installationId) { SystemClock.elapsedRealtime() }
                .also { store.put("issue26-sound", it) }
            displayedViewModel.value = viewModel
        }
        compose.waitUntil(5_000L) { viewModel.uiState.value.isConnected && viewModel.uiState.value.snapshot.lastSequence == 1L }
        if (!screenInstalled) {
            compose.mainClock.autoAdvance = false
            compose.setContent {
                val currentViewModel = displayedViewModel.value
                if (currentViewModel != null) {
                    val state by currentViewModel.uiState.collectAsState()
                    PhoneMonitorTheme {
                        MonitorScreen(state, currentViewModel::toggleControls,
                            { currentViewModel.setControlsVisible(false) }, currentViewModel::showUsagePage,
                            currentViewModel::showStatusPage, currentViewModel::reconnect, {})
                    }
                }
            }
            screenInstalled = true
        }
        compose.waitUntil(5_000L) {
            runCatching { compose.onRoot().fetchSemanticsNode(); true }.getOrDefault(false)
        }
        refreshScreen()
        return Rig(installationId, client, viewModel, store, observations, playbackProbe)
    }

    private inner class Rig(
        val installationId: String,
        val client: DeviceFixtureClient,
        val vm: MonitorViewModel,
        private val store: ViewModelStore,
        val observations: CopyOnWriteArrayList<NativePlayback>,
        val playbackProbe: AudioPlaybackProbe,
    ) {
        private var isClosed = false
        private var sequence = 1L
        val lastSequence: Long get() = sequence

        fun nextSequence(): Long = ++sequence

        fun emit(raw: String) {
            client.emit(raw)
            val parsedSequence = MonitorEvent.fromWireJson(raw)?.sequence
            if (parsedSequence != null) sequence = maxOf(sequence, parsedSequence)
            if (raw.contains("\"snapshot\"")) {
                Regex("\"last_sequence\"\\s*:\\s*(\\d+)").find(raw)?.groupValues?.get(1)?.toLongOrNull()
                    ?.let { sequence = maxOf(sequence, it) }
            }
            compose.waitUntil(3_000L) { vm.uiState.value.snapshot.lastSequence >= sequence }
        }

        fun emitFinish(sessionId: String, durationMs: Long) {
            val seq = nextSequence()
            emit(finishJson(installationId, CompletionIdentity(sessionId, "task-$sessionId", seq, durationMs)))
        }

        fun emitCompletionSnapshot(result: CompletionIdentity, lastSequence: Long = nextSequence()) {
            sequence = maxOf(sequence, lastSequence)
            emit(completionSnapshotJson(installationId, result, lastSequence))
        }

        fun emitApprovalSnapshot(requestId: String, sessionId: String, eventSequence: Long) {
            sequence = maxOf(sequence, eventSequence)
            emit(approvalSnapshotJson(installationId, requestId, sessionId, eventSequence))
        }

        fun emitReplaySnapshot(
            completion: CompletionIdentity,
            claudeRequestId: String,
            claudeSequence: Long,
            codexRequestId: String,
            codexSequence: Long,
            lastSequence: Long,
        ) {
            val raw = """{"type":"snapshot","snapshot":{"installation_id":"$installationId","computer_state":"online","claude_state":"idle","last_sequence":$lastSequence,"recent_completion":${completionJson(completion)},"approvals":[${approvalJson(claudeRequestId,"fixture-claude-approval",claudeSequence,"claude_code")},${approvalJson(codexRequestId,"fixture-codex-approval",codexSequence,"codex")}]}}"""
            emit(raw)
        }

        fun waitSequence(value: Long) { compose.waitUntil(3_000L) { vm.uiState.value.snapshot.lastSequence >= value } }

        fun close() {
            if (isClosed) return
            isClosed = true
            observations.lastOrNull()?.let { lastPlayback ->
                val tailMs = WAV_DURATION_MS + 80L - (SystemClock.elapsedRealtime() - lastPlayback.atMs)
                if (tailMs > 0L) SystemClock.sleep(tailMs)
            }
            compose.runOnUiThread {
                if (displayedViewModel.value === vm) displayedViewModel.value = null
                store.clear()
                compose.activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            playbackProbe.close()
        }
    }

    private class DeviceFixtureClient(
        private val installationId: String,
        private val initialApprovals: List<String>,
    ) : MonitorClient {
        private val channel = Channel<MonitorEvent>(Channel.UNLIMITED)
        override val events = channel.receiveAsFlow()
        override val isConnected = MutableStateFlow(false)

        override fun connect() {
            isConnected.value = true
            val approvals = if (initialApprovals.isEmpty()) "" else ",\"approvals\":[${initialApprovals.joinToString(",")}]"
            emit("""{"type":"snapshot","snapshot":{"installation_id":"$installationId","computer_state":"online","claude_state":"idle","last_sequence":1,"sessions":[]$approvals}}""")
        }

        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) = Unit
        fun emit(raw: String) { check(channel.trySend(requireNotNull(MonitorEvent.fromWireJson(raw))).isSuccess) }
    }

    /** Routes production-ledger reads/writes to a test-only preference file in the target app. */
    private class IsolatedTestLedgerContext(context: Context) : ContextWrapper(context) {
        override fun getApplicationContext(): Context = this
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
            baseContext.getSharedPreferences("issue26_device_fixture_$name", mode)
    }

    private class AudioPlaybackProbe(context: Context, val notificationUsageCallbacks: AtomicInteger) : AutoCloseable {
        private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        private val callback = object : AudioManager.AudioPlaybackCallback() {
            override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) {
                if (configs.any { it.audioAttributes.usage == AudioAttributes.USAGE_NOTIFICATION_EVENT }) {
                    notificationUsageCallbacks.incrementAndGet()
                }
            }
        }
        init { audioManager.registerAudioPlaybackCallback(callback, Handler(Looper.getMainLooper())) }
        override fun close() { audioManager.unregisterAudioPlaybackCallback(callback) }
    }

    private data class CompletionIdentity(
        val sessionId: String,
        val taskId: String,
        val sequence: Long,
        val durationMs: Long?,
    )

    private data class NativePlayback(val cue: ReminderCue, val streamId: Int, val atMs: Long)
    private data class OriginalAudioState(
        val internalRingerMode: Int,
        val ringerMode: Int,
        val notificationVolume: Int,
        val notificationStreamMuted: Boolean,
        val interruptionFilter: Int,
        val zenMode: String,
        val policyAccessGranted: Boolean,
        val stayOnWhilePluggedIn: String,
        val screenOffTimeoutMs: String,
    )

    private fun finishJson(installationId: String, result: CompletionIdentity): String =
        """{"type":"event","installation_id":"$installationId","event_type":"task_finished","session_id":"${result.sessionId}","task_id":"${result.taskId}","session_kind":"main","sequence":${result.sequence},"occurred_at":"2026-10-08T00:00:00Z"${result.durationMs?.let { ",\"payload\":{\"duration_ms\":$it}" } ?: ""}}"""

    private fun completionSnapshotJson(installationId: String, result: CompletionIdentity, lastSequence: Long) =
        """{"type":"snapshot","snapshot":{"installation_id":"$installationId","computer_state":"online","claude_state":"idle","last_sequence":$lastSequence,"recent_completion":${completionJson(result)}}}"""

    private fun completionJson(result: CompletionIdentity): String =
        """{"session_id":"${result.sessionId}","task_id":"${result.taskId}","sequence":${result.sequence},"occurred_at":"2026-10-08T00:00:00Z","display_name":"Fixture task"${result.durationMs?.let { ",\"duration_ms\":$it" } ?: ""}}"""

    private fun approvalEventJson(installationId: String, requestId: String, sessionId: String, sequence: Long, source: String) =
        """{"type":"event","installation_id":"$installationId","event_type":"approval_requested","session_id":"$sessionId","task_id":"task-$sessionId","session_kind":"main","sequence":$sequence,"occurred_at":"2026-10-08T00:00:00Z","payload":{"request_id":"$requestId","source":"$source","status":"pending","can_respond":false,"tool_name":"FixtureTool"}}"""

    private fun approvalJson(requestId: String, sessionId: String, sequence: Long, source: String) =
        """{"request_id":"$requestId","session_id":"$sessionId","task_id":"task-$sessionId","display_name":"Fixture approval","sequence":$sequence,"requested_at":"2026-10-08T00:00:00Z","source":"$source","status":"pending","can_respond":false,"tool_name":"FixtureTool"}"""

    private fun approvalSnapshotJson(installationId: String, requestId: String, sessionId: String, sequence: Long) =
        """{"type":"snapshot","snapshot":{"installation_id":"$installationId","computer_state":"online","claude_state":"idle","last_sequence":$sequence,"approvals":[${approvalJson(requestId, sessionId, sequence, "codex")}]}}"""

    private fun awaitPlaybackCount(observations: List<NativePlayback>, count: Int) {
        compose.waitUntil(6_000L) { observations.size >= count }
        assertTrue(observations.take(count).all { it.streamId != 0 })
    }

    private fun noNewPlayback(observations: List<NativePlayback>, expectedCount: Int) {
        SystemClock.sleep(650L)
        assertEquals(expectedCount, observations.size)
    }

    private fun awaitSequence(rig: Rig, value: Long) = rig.waitSequence(value)

    private fun refreshScreen() {
        compose.mainClock.advanceTimeBy(100L)
        compose.waitForIdle()
    }

    private fun saveScreen(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = requireNotNull(context.getExternalFilesDir("issue26-evidence"))
        directory.mkdirs()
        val file = File(directory, name)
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        file.outputStream().use { stream -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream) }
        android.util.Log.i(TAG, "Anonymous fixture screenshot: ${file.absolutePath}")
    }

    private fun withOriginalAudioState(test: (OriginalAudioState) -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        assumeTrue("SKIP: device is locked; unlock it before running audio fixtures", !keyguard.isKeyguardLocked)
        val internalRingerMode = parseInternalRingerMode(shell("dumpsys audio"))
        assumeTrue("SKIP: unable to read internal AudioService ringer mode before changing settings", internalRingerMode != null)
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val original = OriginalAudioState(
            internalRingerMode = requireNotNull(internalRingerMode),
            ringerMode = audio.ringerMode,
            notificationVolume = audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION),
            notificationStreamMuted = audio.isStreamMute(AudioManager.STREAM_NOTIFICATION),
            interruptionFilter = notifications.currentInterruptionFilter,
            zenMode = shell("settings get global zen_mode").trim(),
            policyAccessGranted = notifications.isNotificationPolicyAccessGranted,
            stayOnWhilePluggedIn = shell("settings get global stay_on_while_plugged_in").trim(),
            screenOffTimeoutMs = shell("settings get system screen_off_timeout").trim(),
        )
        val temporarilyGrantedPolicyAccess = !original.policyAccessGranted &&
            setNotificationPolicyAccess(context.packageName, true)
        var testFailure: Throwable? = null
        try {
            assumeTrue("SKIP: test APK could not temporarily obtain notification policy access",
                original.policyAccessGranted || temporarilyGrantedPolicyAccess)
            test(original)
        } catch (failure: Throwable) {
            testFailure = failure
        }

        val cleanupProblems = mutableListOf<String>()
        var restoredRinger = false
        var wroteOriginalVolume = false
        var restoredDnd = false
        var revokedTemporaryAccess = original.policyAccessGranted
        var actualRinger = Int.MIN_VALUE
        var actualVolume = Int.MIN_VALUE
        var actualStreamMuted: Boolean? = null
        var actualInterruptionFilter = Int.MIN_VALUE
        var actualStayOn: String? = null
        var actualScreenTimeout: String? = null
        var actualPolicyAccess = original.policyAccessGranted
        var actualInternalRinger: Int? = null
        try {
            // Restore AudioService's internal mode because Huawei exposes the DND proxy externally.
            val dndCleared = runCatching { setDnd("all") }.getOrDefault(false)
            val dndOffSettled = runCatching { awaitStableAudioReadings(audio, notifications) }.getOrDefault(false)
            restoredDnd = dndCleared && dndOffSettled
            restoredRinger = runCatching {
                setRingerMode(original.internalRingerMode) && waitUntilStable(2_000L) {
                    parseInternalRingerMode(shell("dumpsys audio")) == original.internalRingerMode
                }
            }.getOrDefault(false)
            // Write the underlying notification index before restoring DND, then verify stable final readbacks.
            wroteOriginalVolume = runCatching {
                writeNotificationVolume(original.notificationVolume)
                waitUntilStable(2_000L) {
                    audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == original.notificationVolume
                }
            }.getOrDefault(false)
            val originalDndRestored = runCatching {
                setDnd(dndNameFor(original.zenMode, original.interruptionFilter))
            }.getOrDefault(false)
            val originalAudioSettled = runCatching { awaitStableAudioReadings(audio, notifications) }.getOrDefault(false)
            restoredDnd = restoredDnd && originalDndRestored && originalAudioSettled
        } finally {
            try {
                // Even when audio restoration fails, always revoke our temporary access.
                if (!original.policyAccessGranted) {
                    revokedTemporaryAccess = runCatching {
                        setNotificationPolicyAccess(context.packageName, false)
                    }.getOrDefault(false)
                }
            } finally {
                try {
                    actualRinger = runCatching { audio.ringerMode }.getOrDefault(Int.MIN_VALUE)
                    actualVolume = runCatching { audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) }
                        .getOrDefault(Int.MIN_VALUE)
                    actualStreamMuted = runCatching { audio.isStreamMute(AudioManager.STREAM_NOTIFICATION) }
                        .getOrNull()
                    actualInterruptionFilter = runCatching { notifications.currentInterruptionFilter }
                        .getOrDefault(Int.MIN_VALUE)
                    actualStayOn = runCatching { shell("settings get global stay_on_while_plugged_in").trim() }
                        .getOrNull()
                    actualScreenTimeout = runCatching { shell("settings get system screen_off_timeout").trim() }
                        .getOrNull()
                    actualPolicyAccess = runCatching { notifications.isNotificationPolicyAccessGranted }
                        .getOrDefault(!original.policyAccessGranted)
                    actualInternalRinger = runCatching { parseInternalRingerMode(shell("dumpsys audio")) }
                        .getOrNull()
                } finally {
                    runCatching {
                        InstrumentationRegistry.getInstrumentation().targetContext
                            .getSharedPreferences("issue26_device_fixture_reminder_cue_ledger", Context.MODE_PRIVATE)
                            .edit().clear().commit()
                    }.onFailure { cleanupProblems += "Could not clear isolated test ledger: $it" }
                }
            }
        }

        if (!restoredRinger) cleanupProblems += "Could not restore original ringer mode ${original.ringerMode}"
        if (!wroteOriginalVolume) cleanupProblems += "Could not write original notification volume ${original.notificationVolume}"
        if (!restoredDnd) cleanupProblems += "Could not restore original DND state ${original.zenMode}"
        if (!revokedTemporaryAccess) cleanupProblems += "Could not revoke temporary notification policy access"
        if (actualInternalRinger != original.internalRingerMode) cleanupProblems += "Internal ringer readback was $actualInternalRinger, expected ${original.internalRingerMode}"
        if (actualRinger != original.ringerMode) cleanupProblems += "External ringer readback was $actualRinger, expected ${original.ringerMode}"
        if (actualVolume != original.notificationVolume) cleanupProblems += "Notification volume readback was $actualVolume, expected ${original.notificationVolume}"
        if (actualStreamMuted != original.notificationStreamMuted) cleanupProblems += "Notification mute readback was $actualStreamMuted, expected ${original.notificationStreamMuted}"
        if (actualInterruptionFilter != original.interruptionFilter) cleanupProblems += "DND filter readback was $actualInterruptionFilter, expected ${original.interruptionFilter}"
        if (actualStayOn != original.stayOnWhilePluggedIn) cleanupProblems += "stay_on_while_plugged_in readback changed to $actualStayOn"
        if (actualScreenTimeout != original.screenOffTimeoutMs) cleanupProblems += "screen_off_timeout readback changed to $actualScreenTimeout"
        if (actualPolicyAccess != original.policyAccessGranted) cleanupProblems += "Notification policy access readback was $actualPolicyAccess"
        val originalFailure = testFailure
        if (originalFailure != null) {
            cleanupProblems.forEach { originalFailure.addSuppressed(AssertionError(it)) }
            throw originalFailure
        }
        if (cleanupProblems.isNotEmpty()) throw AssertionError(cleanupProblems.joinToString("; "))
    }

    private fun prepareAudibleState(original: OriginalAudioState) {
        assumeTrue("SKIP: unable to disable DND for normal playback", setDnd("all"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        assumeTrue("SKIP: audio state did not settle after disabling DND", awaitStableAudioReadings(audio, notifications))
        assumeTrue("SKIP: unable to set normal ringer mode", setRingerMode(AudioManager.RINGER_MODE_NORMAL))
        assumeTrue("SKIP: normal ringer mode did not settle", waitUntilStable(2_000L) {
            parseInternalRingerMode(shell("dumpsys audio")) == AudioManager.RINGER_MODE_NORMAL &&
                audio.ringerMode == AudioManager.RINGER_MODE_NORMAL
        })
        val maxVolume = audio.getStreamMaxVolume(AudioManager.STREAM_NOTIFICATION)
        val baselineVolume = original.notificationVolume.coerceIn(1, maxVolume.coerceAtLeast(1))
        assumeTrue("SKIP: unable to set nonzero notification volume", setNotificationVolume(baselineVolume))
        assumeTrue("SKIP: notification volume did not settle", waitUntilStable(2_000L) {
            audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == baselineVolume
        })
    }

    private fun parseInternalRingerMode(dump: String): Int? {
        val label = Regex("mode \\(internal\\) = (NORMAL|SILENT|VIBRATE)")
            .find(dump)?.groupValues?.get(1) ?: return null
        return when (label) {
            "NORMAL" -> AudioManager.RINGER_MODE_NORMAL
            "SILENT" -> AudioManager.RINGER_MODE_SILENT
            "VIBRATE" -> AudioManager.RINGER_MODE_VIBRATE
            else -> null
        }
    }

    private fun waitUntilStable(timeoutMs: Long, predicate: () -> Boolean): Boolean {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        var consecutive = 0
        while (SystemClock.elapsedRealtime() < deadline) {
            consecutive = if (runCatching(predicate).getOrDefault(false)) consecutive + 1 else 0
            if (consecutive >= 3) return true
            SystemClock.sleep(100L)
        }
        return false
    }

    private fun awaitStableAudioReadings(audio: AudioManager, notifications: NotificationManager): Boolean {
        return waitUntilStable(2_000L) {
            val internal = parseInternalRingerMode(shell("dumpsys audio"))
            val external = audio.ringerMode
            val volume = audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION)
            val filter = notifications.currentInterruptionFilter
            SystemClock.sleep(100L)
            internal == parseInternalRingerMode(shell("dumpsys audio")) && external == audio.ringerMode &&
                volume == audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) &&
                filter == notifications.currentInterruptionFilter
        }.also { if (it) SystemClock.sleep(300L) }
    }

    private fun setRingerMode(mode: Int): Boolean {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val audio = instrumentation.targetContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        var adopted = false
        return try {
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.MODIFY_AUDIO_SETTINGS)
            adopted = true
            audio.ringerMode = mode
            audio.ringerMode == mode
        } catch (_: SecurityException) {
            false
        } finally {
            if (adopted) instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }

    private fun setStreamVolumeDirect(stream: Int, volume: Int): Boolean {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val audio = instrumentation.targetContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val safeVolume = volume.coerceIn(0, audio.getStreamMaxVolume(stream))
        var adopted = false
        return try {
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.MODIFY_AUDIO_SETTINGS)
            adopted = true
            audio.setStreamVolume(stream, safeVolume, 0)
            waitUntilStable(2_000L) { audio.getStreamVolume(stream) == safeVolume }
        } catch (_: SecurityException) {
            false
        } finally {
            if (adopted) instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }

    private fun setStreamMuteDirect(stream: Int, muted: Boolean): Boolean {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val audio = instrumentation.targetContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        var adopted = false
        return try {
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.MODIFY_AUDIO_SETTINGS)
            adopted = true
            audio.adjustStreamVolume(
                stream,
                if (muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE,
                0,
            )
            waitUntilStable(1_500L) { audio.isStreamMute(stream) == muted }
        } catch (_: SecurityException) {
            false
        } finally {
            if (adopted) instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }

    private fun restoreManualPreviewAudioState(
        audio: AudioManager,
        notifications: NotificationManager,
        notificationVolume: Int,
        ringVolume: Int,
        notificationMuted: Boolean,
        ringMuted: Boolean,
    ) {
        val failures = mutableListOf<String>()
        fun attempt(label: String, block: () -> Unit) {
            runCatching(block).onFailure { failures += "$label: $it" }
        }
        attempt("disable DND") { check(setDnd("all")) }
        attempt("settle DND off") { check(awaitStableAudioReadings(audio, notifications)) }
        attempt("set NORMAL") { check(setRingerMode(AudioManager.RINGER_MODE_NORMAL)) }
        attempt("restore ring volume") { check(setStreamVolumeDirect(AudioManager.STREAM_RING, ringVolume)) }
        attempt("restore notification volume") { check(setStreamVolumeDirect(AudioManager.STREAM_NOTIFICATION, notificationVolume)) }
        attempt("restore notification mute") { check(setStreamMuteDirect(AudioManager.STREAM_NOTIFICATION, notificationMuted)) }
        attempt("restore ring mute") { check(setStreamMuteDirect(AudioManager.STREAM_RING, ringMuted)) }
        attempt("settle restored audio") { check(awaitStableAudioReadings(audio, notifications)) }
        attempt("verify notification volume") {
            check(audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == notificationVolume) {
                "${audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION)} != $notificationVolume"
            }
        }
        attempt("verify ring volume") {
            check(audio.getStreamVolume(AudioManager.STREAM_RING) == ringVolume) {
                "${audio.getStreamVolume(AudioManager.STREAM_RING)} != $ringVolume"
            }
        }
        attempt("verify notification mute") {
            check(audio.isStreamMute(AudioManager.STREAM_NOTIFICATION) == notificationMuted)
        }
        attempt("verify ring mute") { check(audio.isStreamMute(AudioManager.STREAM_RING) == ringMuted) }
        attempt("verify audible DND-off baseline") {
            check(audio.ringerMode == AudioManager.RINGER_MODE_NORMAL &&
                parseInternalRingerMode(shell("dumpsys audio")) == AudioManager.RINGER_MODE_NORMAL &&
                notifications.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALL)
        }
        check(failures.isEmpty()) { failures.joinToString("; ") }
    }

    private fun awaitNativePlaybackCount(observations: List<NativePlayback>, count: Int, timeoutMs: Long) {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < deadline && observations.size < count) SystemClock.sleep(25L)
        check(observations.size >= count) { "Timed out waiting for native stream callback $count" }
        check(observations.take(count).all { it.streamId != 0 }) { "SoundPool did not return nonzero native stream IDs" }
    }

    private fun setNotificationPolicyAccess(packageName: String, enabled: Boolean): Boolean {
        val command = if (enabled) "allow_dnd" else "disallow_dnd"
        shell("cmd notification $command $packageName")
        val notifications = InstrumentationRegistry.getInstrumentation().targetContext
            .getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val expected = enabled
        val deadline = SystemClock.elapsedRealtime() + 1_500L
        while (SystemClock.elapsedRealtime() < deadline && notifications.isNotificationPolicyAccessGranted != expected) {
            SystemClock.sleep(50L)
        }
        return notifications.isNotificationPolicyAccessGranted == expected
    }

    private fun setNotificationVolume(volume: Int): Boolean {
        val audio = InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val safeVolume = volume.coerceIn(0, audio.getStreamMaxVolume(AudioManager.STREAM_NOTIFICATION))
        writeNotificationVolume(safeVolume)
        return audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == safeVolume
    }

    private fun writeNotificationVolume(volume: Int) {
        val audio = InstrumentationRegistry.getInstrumentation().targetContext
            .getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val safeVolume = volume.coerceIn(0, audio.getStreamMaxVolume(AudioManager.STREAM_NOTIFICATION))
        shell("cmd media_session volume --stream 5 --set $safeVolume --get")
    }

    private fun setNotificationStreamMuted(muted: Boolean): Boolean {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val audio = instrumentation.targetContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        var adopted = false
        return try {
            instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.MODIFY_AUDIO_SETTINGS)
            adopted = true
            audio.adjustStreamVolume(
                AudioManager.STREAM_NOTIFICATION,
                if (muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE,
                0,
            )
            waitUntilStable(1_500L) {
                audio.isStreamMute(AudioManager.STREAM_NOTIFICATION) == muted &&
                    (!muted || audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == 0)
            }
        } catch (_: SecurityException) {
            false
        } finally {
            if (adopted) instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }

    private fun setDnd(mode: String): Boolean {
        val expected = when (mode) {
            "all" -> NotificationManager.INTERRUPTION_FILTER_ALL
            "priority" -> NotificationManager.INTERRUPTION_FILTER_PRIORITY
            "alarms" -> NotificationManager.INTERRUPTION_FILTER_ALARMS
            "none" -> NotificationManager.INTERRUPTION_FILTER_NONE
            else -> return false
        }
        shell("cmd notification set_dnd $mode")
        val notifications = InstrumentationRegistry.getInstrumentation().targetContext
            .getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val deadline = SystemClock.elapsedRealtime() + 1_500L
        while (SystemClock.elapsedRealtime() < deadline && notifications.currentInterruptionFilter != expected) {
            SystemClock.sleep(50L)
        }
        return notifications.currentInterruptionFilter == expected
    }

    private fun dndNameFor(zenMode: String, interruptionFilter: Int): String = when (zenMode) {
        "0" -> "all"
        "1" -> "priority"
        "2" -> "none"
        "3" -> "alarms"
        else -> when (interruptionFilter) {
            NotificationManager.INTERRUPTION_FILTER_ALL -> "all"
            NotificationManager.INTERRUPTION_FILTER_PRIORITY -> "priority"
            NotificationManager.INTERRUPTION_FILTER_ALARMS -> "alarms"
            NotificationManager.INTERRUPTION_FILTER_NONE -> "none"
            else -> "all"
        }
    }

    private fun shell(command: String): String {
        val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
    }

    private fun writeSummary(
        scenario: String,
        original: OriginalAudioState,
        observations: List<NativePlayback>,
        audioPlaybackUsageCallbacks: Int,
        extraEvidence: Map<String, String> = emptyMap(),
    ) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        val directory = requireNotNull(context.getExternalFilesDir("issue26-evidence"))
        directory.mkdirs()
        val text = buildString {
            appendLine("scenario=$scenario")
            appendLine("original_internal_ringer_mode=${original.internalRingerMode}:${ringerModeName(original.internalRingerMode)}")
            appendLine("original_ringer_mode=${original.ringerMode}")
            appendLine("original_notification_stream_volume=${original.notificationVolume}")
            appendLine("original_notification_stream_muted=${original.notificationStreamMuted}")
            appendLine("original_isStreamMute=${original.notificationStreamMuted}")
            appendLine("hardware_has_vibrator=${vibrator.hasVibrator()}")
            appendLine("original_interruption_filter=${original.interruptionFilter}")
            appendLine("original_zen_mode=${original.zenMode}")
            appendLine("original_policy_access_granted=${original.policyAccessGranted}")
            appendLine("original_stay_on_while_plugged_in=${original.stayOnWhilePluggedIn}")
            appendLine("original_screen_off_timeout_ms=${original.screenOffTimeoutMs}")
            appendLine("native_cue_count=${observations.size}")
            appendLine("audio_playback_notification_usage_callbacks=$audioPlaybackUsageCallbacks")
            extraEvidence.forEach { (key, value) -> appendLine("$key=$value") }
            observations.forEach { appendLine("native_cue=${it.cue},stream_id=${it.streamId},elapsed_realtime_ms=${it.atMs}") }
        }
        File(directory, "$scenario.txt").writeText(text)
        android.util.Log.i(TAG, "Issue26 evidence: ${File(directory, "$scenario.txt").absolutePath}\n$text")
    }

    private fun ringerModeName(mode: Int): String = when (mode) {
        AudioManager.RINGER_MODE_NORMAL -> "NORMAL"
        AudioManager.RINGER_MODE_SILENT -> "SILENT"
        AudioManager.RINGER_MODE_VIBRATE -> "VIBRATE"
        else -> "UNKNOWN"
    }

    private companion object {
        const val WAV_DURATION_MS = 440L
        const val TAG = "Issue26SoundTest"
    }
}
