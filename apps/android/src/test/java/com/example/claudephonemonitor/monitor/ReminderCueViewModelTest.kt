package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import com.example.claudephonemonitor.ui.MonitorPage
import com.example.claudephonemonitor.ui.selectMonitorPage
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ReminderCueViewModelTest {
    @Test
    fun acceptedEventsPlayIndependentCuesOnceAcrossPagesReconnectSnapshotsAndViewModelRecreation() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val ledger = InMemoryReminderCueLedger()
        val player = RecordingCuePlayer()
        val firstStore = ViewModelStore()
        val secondStore = ViewModelStore()
        val firstClient = CueFixtureClient()
        val firstVm = MonitorViewModel(firstClient, player, ledger, "paired-installation") { testScheduler.currentTime }
            .also { firstStore.put("monitor", it) }
        try {
            runCurrent()
            firstVm.showUsagePage()
            firstClient.emit(onlineSnapshot(0))
            firstClient.emit(finished("short-1", 1, 299_000L))
            firstClient.emit(finished("short-2", 2, 299_999L))
            firstClient.emit(finished("long-1", 3, 300_000L))
            firstClient.emit(finished("long-1", 3, 300_000L)) // replay
            runCurrent()
            assertEquals(ReminderStrength.WEAK, firstVm.uiState.value.stateChange?.strength)
            firstClient.emit(pending("claude-approval", 4, ApprovalSource.CLAUDE_CODE))
            firstClient.emit(pending("codex-approval", 5, ApprovalSource.CODEX))
            firstClient.emit(pending("claude-approval", 6, ApprovalSource.CLAUDE_CODE)) // repeat
            firstClient.emit(finished("long-while-pinned", 7, 300_001L))
            firstClient.emit(MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.TASK_FAILED,
                sessionId = "failed", sequence = 8, durationMs = 900_000L))
            firstClient.emit(MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.WAITING,
                sessionId = "waiting", sequence = 9, durationMs = 900_000L, waitingReason = "question"))
            firstClient.emit(snapshotWithCompletion(9, RecentCompletion("long-1", "task-long-1", 3, "", "Long task", 300_000L)))
            runCurrent()

            assertEquals(listOf(
                ReminderCue.LONG_TASK_COMPLETED,
                ReminderCue.APPROVAL_PENDING,
                ReminderCue.APPROVAL_PENDING,
                ReminderCue.LONG_TASK_COMPLETED,
            ), player.played)
            assertEquals(MonitorPage.APPROVAL, selectMonitorPage(firstVm.uiState.value))

            firstClient.disconnect()
            firstClient.emit(MonitorEvent(type = MonitorEventType.DISCONNECTED))
            firstClient.connect()
            firstClient.emit(snapshotWithCompletion(10, RecentCompletion("long-1", "task-long-1", 3, "", "Long task", 300_000L)))
            runCurrent()
            firstStore.clear()

            val secondClient = CueFixtureClient()
            val secondVm = MonitorViewModel(secondClient, player, ledger, "paired-installation") { testScheduler.currentTime }
                .also { secondStore.put("monitor", it) }
            secondClient.emit(snapshotWithCompletion(10, RecentCompletion("long-1", "task-long-1", 3, "", "Long task", 300_000L)))
            runCurrent()
            assertEquals(4, player.played.size)
            secondStore.clear()
        } finally {
            firstStore.clear()
            secondStore.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun snapshotCanSupplyDurationForPreviouslyUnknownCompletionAndSubagentsStaySilent() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = CueFixtureClient()
            val player = RecordingCuePlayer()
            val vm = MonitorViewModel(client, player, InMemoryReminderCueLedger(), "paired-installation") { testScheduler.currentTime }
                .also { store.put("monitor", it) }
            runCurrent()
            client.emit(finished("unknown-first", 1, null))
            client.emit(snapshotWithCompletion(1, RecentCompletion("unknown-first", "task-unknown-first", 1, "", "Task", 300_000L)))
            client.emit(MonitorEvent(
                type = MonitorEventType.SNAPSHOT,
                snapshot = MonitorSnapshot(
                    installationId = "paired-installation",
                    computerState = ComputerState.ONLINE,
                    lastSequence = 2,
                    sessions = listOf(SessionSummary("agent", "Agent", ClaudeState.IDLE, 2, SessionKind.SUBAGENT)),
                    recentCompletion = RecentCompletion("agent", "agent-task", 2, "", "Agent", 900_000L),
                ),
            ))
            runCurrent()
            assertEquals(listOf(ReminderCue.LONG_TASK_COMPLETED), player.played)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun activeTaskTimingInfersDurationAndSameSequenceSnapshotCanFillItLater() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val client = CueFixtureClient()
            val player = RecordingCuePlayer()
            val vm = MonitorViewModel(client, player, InMemoryReminderCueLedger(), "paired-installation") { testScheduler.currentTime }
                .also { store.put("monitor", it) }
            runCurrent()
            client.emit(onlineSnapshot(0))
            client.emit(MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.TASK_STARTED,
                sessionId = "inferred", taskId = "task-inferred", sequence = 1,
                occurredAt = "2026-10-08T00:00:00Z"))
            client.emit(MonitorEvent(type = MonitorEventType.EVENT, name = MonitorEventName.TASK_FINISHED,
                sessionId = "inferred", taskId = "task-inferred", sequence = 2,
                occurredAt = "2026-10-08T00:05:00Z"))
            runCurrent()
            assertEquals(listOf(ReminderCue.LONG_TASK_COMPLETED), player.played)
            assertEquals(ReminderStrength.WEAK, vm.uiState.value.stateChange?.strength)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun pendingSnapshotReplayAfterRecreationStaysSilentButNewRequestPlaysAndMuteConsumes() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val ledger = InMemoryReminderCueLedger()
        val player = RecordingCuePlayer()
        val firstStore = ViewModelStore()
        val secondStore = ViewModelStore()
        try {
            val firstClient = CueFixtureClient()
            MonitorViewModel(firstClient, player, ledger, "paired-installation") { testScheduler.currentTime }
                .also { firstStore.put("monitor", it) }
            runCurrent()
            firstClient.emit(snapshotWithApprovals(1, listOf(approval("same-request", 1))))
            runCurrent()
            assertEquals(listOf(ReminderCue.APPROVAL_PENDING), player.played)
            firstStore.clear()

            player.audible = false
            val secondClient = CueFixtureClient()
            val secondVm = MonitorViewModel(secondClient, player, ledger, "paired-installation") { testScheduler.currentTime }
                .also { secondStore.put("monitor", it) }
            secondClient.emit(snapshotWithApprovals(2, listOf(
                approval("same-request", 1), approval("new-request", 2),
            )))
            secondClient.emit(MonitorEvent(type = MonitorEventType.EVENT,
                name = MonitorEventName.APPROVAL_RESOLVED, sessionId = "session-same-request", sequence = 3,
                approval = ApprovalEventMetadata("same-request", ApprovalStatus.APPROVED, false)))
            runCurrent()
            player.audible = true
            secondClient.emit(snapshotWithApprovals(3, listOf(
                approval("same-request", 1), approval("new-request", 2), approval("fresh-request", 3),
            )))
            runCurrent()
            assertEquals(listOf(ReminderCue.APPROVAL_PENDING, ReminderCue.APPROVAL_PENDING), player.played)
            assertEquals(ApprovalStatus.APPROVED,
                secondVm.uiState.value.approvals.first { it.requestId == "same-request" }.status)
            secondStore.clear()
        } finally {
            firstStore.clear()
            secondStore.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    @Test
    fun acceptedCueSurvivesImmediateDisconnectAndReconnectWhilePlayerQueueIsPending() = runTest {
        kotlinx.coroutines.Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val player = QueueingCuePlayer()
            val client = CueFixtureClient()
            MonitorViewModel(client, player, InMemoryReminderCueLedger(), "paired-installation") { testScheduler.currentTime }
                .also { store.put("monitor", it) }
            runCurrent()
            client.emit(finished("queued-long-task", 1, 300_000L))
            client.emit(MonitorEvent(type = MonitorEventType.DISCONNECTED))
            client.emit(MonitorEvent(type = MonitorEventType.CONNECTED))
            runCurrent()

            assertEquals(listOf(ReminderCue.LONG_TASK_COMPLETED), player.pending)
            assertEquals(0, player.cancelCount)
            player.drain()
            assertEquals(listOf(ReminderCue.LONG_TASK_COMPLETED), player.played)
        } finally {
            store.clear()
            kotlinx.coroutines.Dispatchers.resetMain()
        }
    }

    private fun finished(sessionId: String, sequence: Long, durationMs: Long?) = MonitorEvent(
        type = MonitorEventType.EVENT,
        name = MonitorEventName.TASK_FINISHED,
        sessionId = sessionId,
        taskId = "task-$sessionId",
        sequence = sequence,
        durationMs = durationMs,
    )

    private fun pending(id: String, sequence: Long, source: ApprovalSource) = MonitorEvent(
        type = MonitorEventType.EVENT,
        name = MonitorEventName.APPROVAL_REQUESTED,
        sessionId = "approval-session-$id",
        taskId = "approval-task-$id",
        sequence = sequence,
        approval = ApprovalEventMetadata(id, ApprovalStatus.PENDING, false, "Tool", source = source),
    )

    private fun snapshotWithCompletion(sequence: Long, completion: RecentCompletion) = MonitorEvent(
        type = MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(
            installationId = "wire-installation",
            computerState = ComputerState.ONLINE,
            lastSequence = sequence,
            recentCompletion = completion,
        ),
    )

    private fun onlineSnapshot(sequence: Long) = MonitorEvent(type = MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(installationId = "wire-installation", computerState = ComputerState.ONLINE,
            lastSequence = sequence))

    private fun snapshotWithApprovals(sequence: Long, approvals: List<ApprovalSummary>) = MonitorEvent(
        type = MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(installationId = "wire-installation", computerState = ComputerState.ONLINE,
            lastSequence = sequence, approvals = approvals),
    )

    private fun approval(id: String, sequence: Long) = ApprovalSummary(
        requestId = id, sessionId = "session-$id", taskId = "task-$id", displayName = "Task",
        sequence = sequence, requestedAt = "", status = ApprovalStatus.PENDING, canRespond = false,
        source = ApprovalSource.CLAUDE_CODE,
    )

    private class RecordingCuePlayer : ReminderCuePlayer {
        val played = mutableListOf<ReminderCue>()
        var audible = true
        override fun play(cue: ReminderCue) { if (audible) played += cue }
    }

    private class QueueingCuePlayer : ReminderCuePlayer {
        val pending = mutableListOf<ReminderCue>()
        val played = mutableListOf<ReminderCue>()
        var cancelCount = 0
        override fun play(cue: ReminderCue) { pending += cue }
        override fun cancelPending() { cancelCount += 1; pending.clear() }
        fun drain() { played += pending; pending.clear() }
    }

    private class CueFixtureClient : MonitorClient {
        private val channel = Channel<MonitorEvent>(Channel.UNLIMITED)
        override val events = channel.receiveAsFlow()
        override val isConnected = MutableStateFlow(false)
        override fun connect() { isConnected.value = true }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) = Unit
        fun emit(event: MonitorEvent) { check(channel.trySend(event).isSuccess) }
    }
}
