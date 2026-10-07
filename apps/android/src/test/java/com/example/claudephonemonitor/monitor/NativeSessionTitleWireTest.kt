package com.example.claudephonemonitor.monitor

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NativeSessionTitleWireTest {
    @Test
    fun nativeTaskStartedTitleNamesTheSameSessionWhenCompletionWireOmitsItsTitle() = withMonitor { fixture ->
        fixture.client.emit(snapshot(1, session(SID_A, "Codex aaaaaa", "idle", 1)))
        runCurrent()
        fixture.nowMs = 100
        fixture.client.emit(event(2, "task_started", title = "实现中文任务名称显示"))
        runCurrent()
        fixture.nowMs = 200
        fixture.client.emit(event(3, "task_finished"))
        runCurrent()
        assertEquals("实现中文任务名称显示", fixture.viewModel.uiState.value.stateChange?.completionName)
        assertEquals(SID_A, fixture.viewModel.uiState.value.recentSessionCompletion?.sessionId)
        assertEquals(TASK_A, fixture.viewModel.uiState.value.recentSessionCompletion?.taskId)
    }

    @Test
    fun nativeStartedAndUpdatedTitlesReplaceCodexWithoutChangingWorkingOrItsDeadline() = withMonitor { fixture ->
        fixture.client.emit(snapshot(1, session(SID_A, "Codex aaaaaa", "idle", 1), activity = "breath"))
        runCurrent()
        fixture.nowMs = 100
        fixture.client.emit(event(2, "task_started", title = "修复安卓多会话布局"))
        runCurrent()
        fixture.nowMs = 200
        fixture.client.emit(event(3, "tool_started"))
        runCurrent()
        val before = fixture.viewModel.uiState.value
        assertEquals(ActivityVariation.TOOL, before.activity)

        fixture.nowMs = 1_000
        fixture.client.emit(event(4, "session_title_updated", title = "修复安卓多会话布局并验证"))
        runCurrent()
        val updated = fixture.viewModel.uiState.value
        assertEquals(PetState.WORKING, updated.petState)
        assertEquals(before.activity, updated.activity)
        assertEquals(before.snapshot.activity, updated.snapshot.activity)
        assertEquals(before.stateChange?.status, updated.stateChange?.status)
        assertEquals(5_100L, fixture.nowMs + requireNotNull(updated.stateChange).remainingMs)
        assertEquals(before.eventCount + 1, updated.eventCount)

        fixture.nowMs = 1_100
        fixture.client.emit(event(5, "task_finished")) // The exact session's cached native title fills older wire.
        runCurrent()
        assertEquals("修复安卓多会话布局并验证", fixture.viewModel.uiState.value.stateChange?.completionName)
        assertEquals(SID_A, fixture.viewModel.uiState.value.recentSessionCompletion?.sessionId)
    }

    @Test
    fun interleavedNativeTitlesAndCompletionsStayWithTheirOwnSessions() = withMonitor { fixture ->
        fixture.client.emit(snapshot(1,
            session(SID_A, "Codex aaaaaa", "idle", 1), session(SID_B, "Codex bbbbbb", "idle", 1),
        ))
        runCurrent()
        fixture.nowMs = 100
        fixture.client.emit(event(2, "task_finished", title = "支持中文任务名称"))
        runCurrent()
        fixture.nowMs = 200
        fixture.client.emit(event(3, "session_title_updated", SID_B, TASK_B, "验证移动端布局"))
        runCurrent()
        assertEquals("支持中文任务名称", fixture.viewModel.uiState.value.stateChange?.completionName)
        assertEquals(15_100L, fixture.nowMs + requireNotNull(fixture.viewModel.uiState.value.stateChange).remainingMs)

        fixture.nowMs = 300
        fixture.client.emit(event(4, "task_finished", SID_B, TASK_B))
        runCurrent()
        assertEquals("验证移动端布局", fixture.viewModel.uiState.value.stateChange?.completionName)
        fixture.client.emit(snapshot(4, completion = completion(SID_A, TASK_A, 2, "支持中文任务名称")))
        runCurrent()
        assertEquals("验证移动端布局", fixture.viewModel.uiState.value.stateChange?.completionName)
        assertEquals(SID_B, fixture.viewModel.uiState.value.recentSessionCompletion?.sessionId)
    }

    @Test
    fun lateNativeCompletionNameFillsSameIdentityAndKeepsDoneUntilTheOriginalDeadline() = withMonitor { fixture ->
        fixture.client.emit(snapshot(1, session(SID_A, "Codex aaaaaa", "idle", 1)))
        runCurrent()
        fixture.nowMs = 100
        fixture.client.emit(event(2, "task_finished"))
        runCurrent()
        assertEquals("Codex aaaaaa", fixture.viewModel.uiState.value.stateChange?.completionName)
        val activity = fixture.viewModel.uiState.value.activity
        fixture.nowMs = 1_000
        fixture.client.emit(event(3, "session_title_updated", title = "完成名称归属修复"))
        runCurrent()
        assertEquals(activity, fixture.viewModel.uiState.value.activity)
        assertEquals(15_100L, fixture.nowMs + requireNotNull(fixture.viewModel.uiState.value.stateChange).remainingMs)

        fixture.client.emit(snapshot(3,
            session(SID_A, "完成名称归属修复", "idle", 2),
            completion = completion(SID_A, TASK_A, 2, "完成名称归属修复"), activity = "task_finished",
        ))
        runCurrent()
        val named = fixture.viewModel.uiState.value
        assertEquals("完成名称归属修复", named.stateChange?.completionName)
        assertEquals("完成名称归属修复", named.recentSessionCompletion?.displayName)
        assertEquals(SessionDisplayState.DONE, named.snapshot.sessions!!.single().displayState(named.recentSessionCompletion))
        assertEquals(15_100L, fixture.nowMs + requireNotNull(named.stateChange).remainingMs)

        fixture.nowMs = 6_000
        fixture.client.emit(snapshot(4, session(SID_A, "完成名称归属修复", "idle", 2)))
        runCurrent()
        assertEquals("完成名称归属修复", fixture.viewModel.uiState.value.recentSessionCompletion?.displayName)
        fixture.nowMs = 15_100
        advanceTimeBy(100)
        runCurrent()
        assertNull(fixture.viewModel.uiState.value.recentSessionCompletion)
        assertNull(fixture.viewModel.uiState.value.stateChange)
    }

    @Test
    fun newTaskKeepsItsNativeTitleWhenAnOlderCompletionSnapshotArrives() = withMonitor { fixture ->
        fixture.client.emit(snapshot(1, session(SID_A, "Codex aaaaaa", "idle", 1)))
        runCurrent()
        fixture.nowMs = 100
        fixture.client.emit(event(2, "task_finished", title = "旧任务名称"))
        runCurrent()
        fixture.nowMs = 200
        fixture.client.emit(event(3, "task_started", SID_A, TASK_B, "新任务原生名称"))
        runCurrent()
        assertNull(fixture.viewModel.uiState.value.recentSessionCompletion)
        fixture.client.emit(snapshot(3,
            session(SID_A, "新任务原生名称", "working", 3),
            completion = completion(SID_A, TASK_A, 2, "旧任务名称"), activity = "task_started",
        ))
        runCurrent()
        assertEquals(PetState.WORKING, fixture.viewModel.uiState.value.petState)
        assertEquals(PetState.FINISH, fixture.viewModel.uiState.value.stateChange?.status)
        assertNull(fixture.viewModel.uiState.value.recentSessionCompletion)
        fixture.nowMs = 300
        fixture.client.emit(event(4, "task_finished", SID_A, TASK_B))
        runCurrent()
        assertEquals("新任务原生名称", fixture.viewModel.uiState.value.stateChange?.completionName)
        assertEquals(TASK_B, fixture.viewModel.uiState.value.recentSessionCompletion?.taskId)
    }

    @Test
    fun nativeTitleAfterRelayFiveSecondCleanupNamesLocalFinishUntilItsOriginalFifteenSecondDeadline() = withMonitor { fixture ->
        fixture.client.emit(snapshot(1, session(SID_A, "Codex aaaaaa", "idle", 1)))
        runCurrent()
        fixture.nowMs = 100
        fixture.client.emit(event(2, "task_finished"))
        runCurrent()
        val originalCompletion = requireNotNull(fixture.viewModel.uiState.value.recentSessionCompletion)

        fixture.nowMs = 6_000
        fixture.client.emit(snapshot(3, session(SID_A, "Codex aaaaaa", "idle", 2), activity = "task_finished"))
        runCurrent()
        assertNull(fixture.viewModel.uiState.value.snapshot.recentCompletion)
        val originalActivity = fixture.viewModel.uiState.value.activity
        fixture.client.emit(event(4, "session_title_updated", title = "迟到的原生任务标题"))
        runCurrent()
        val titled = fixture.viewModel.uiState.value
        assertEquals("迟到的原生任务标题", titled.stateChange?.completionName)
        assertEquals(originalCompletion.copy(displayName = "迟到的原生任务标题"), titled.recentSessionCompletion)
        assertEquals(originalActivity, titled.activity)
        assertEquals(15_100L, fixture.nowMs + requireNotNull(titled.stateChange).remainingMs)
        assertEquals(SessionDisplayState.DONE, titled.snapshot.sessions!!.single().displayState(titled.recentSessionCompletion))

        fixture.client.emit(snapshot(4, session(SID_A, "迟到的原生任务标题", "idle", 2), activity = "task_finished"))
        runCurrent()
        assertEquals("迟到的原生任务标题", fixture.viewModel.uiState.value.recentSessionCompletion?.displayName)
        fixture.nowMs = 15_100
        advanceTimeBy(100)
        runCurrent()
        assertNull(fixture.viewModel.uiState.value.recentSessionCompletion)
        assertNull(fixture.viewModel.uiState.value.stateChange)
        fixture.client.emit(event(5, "session_title_updated", title = "截止后的更新不恢复完成"))
        runCurrent()
        assertNull(fixture.viewModel.uiState.value.recentSessionCompletion)
        assertNull(fixture.viewModel.uiState.value.stateChange)
    }

    @Test
    fun differentTaskOrSessionMetadataCannotRenameActiveFinishAndOldTaskCannotReviveItAfterNewStart() = withMonitor { fixture ->
        fixture.client.emit(snapshot(1, session(SID_A, "原任务名称", "idle", 1)))
        runCurrent()
        fixture.nowMs = 100
        fixture.client.emit(event(2, "task_finished"))
        runCurrent()
        val original = requireNotNull(fixture.viewModel.uiState.value.recentSessionCompletion)
        fixture.nowMs = 6_000
        fixture.client.emit(snapshot(3, session(SID_A, "原任务名称", "idle", 2), activity = "task_finished"))
        runCurrent()
        fixture.client.emit(event(4, "session_title_updated", SID_A, TASK_B, "另一任务名称"))
        runCurrent()
        assertEquals("原任务名称", fixture.viewModel.uiState.value.stateChange?.completionName)
        assertEquals(original, fixture.viewModel.uiState.value.recentSessionCompletion)
        fixture.client.emit(event(5, "session_title_updated", SID_B, TASK_A, "另一会话名称"))
        runCurrent()
        assertEquals("原任务名称", fixture.viewModel.uiState.value.stateChange?.completionName)
        assertEquals(original, fixture.viewModel.uiState.value.recentSessionCompletion)
        assertEquals(15_100L, fixture.nowMs + requireNotNull(fixture.viewModel.uiState.value.stateChange).remainingMs)

        fixture.client.emit(event(6, "task_started", SID_A, TASK_B, "新任务名称"))
        runCurrent()
        assertNull(fixture.viewModel.uiState.value.recentSessionCompletion)
        fixture.client.emit(event(7, "session_title_updated", SID_A, TASK_A, "旧完成的迟到标题"))
        runCurrent()
        assertNull(fixture.viewModel.uiState.value.recentSessionCompletion)
        assertEquals(PetState.FINISH, fixture.viewModel.uiState.value.stateChange?.status)
        assertEquals("原任务名称", fixture.viewModel.uiState.value.stateChange?.completionName)
    }

    private fun withMonitor(test: suspend TestScope.(Fixture) -> Unit) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val store = ViewModelStore()
        try {
            val fixture = Fixture()
            store.put("native-title", fixture.viewModel)
            runCurrent()
            test(fixture)
        } finally {
            store.clear()
            Dispatchers.resetMain()
        }
    }

    private fun event(
        sequence: Long,
        type: String,
        sessionId: String = SID_A,
        taskId: String = TASK_A,
        title: String? = null,
    ): String = JSONObject().apply {
        put("type", "event")
        put("schema_version", 1)
        put("event_id", "event-$sequence")
        put("installation_id", "install")
        put("session_id", sessionId)
        put("task_id", taskId)
        put("sequence", sequence)
        put("occurred_at", "2026-10-07T01:00:00Z")
        put("event_type", type)
        put("payload", JSONObject().apply {
            if (type == "task_finished") put("duration_ms", 300_001)
        })
        title?.let { put("session_title", it) }
    }.toString()

    private fun session(id: String, title: String, state: String, sequence: Long) = JSONObject()
        .put("session_id", id).put("title", title).put("claude_state", state).put("last_activity_sequence", sequence)

    private fun completion(id: String, taskId: String, sequence: Long, title: String) = JSONObject()
        .put("session_id", id).put("task_id", taskId).put("sequence", sequence)
        .put("occurred_at", "2026-10-07T01:00:00Z").put("display_name", title)

    private fun snapshot(
        sequence: Long,
        vararg sessions: JSONObject,
        completion: JSONObject? = null,
        activity: String = "breath",
    ): String = JSONObject().apply {
        put("type", "snapshot")
        put("installation_id", "install")
        put("computer_state", "online")
        put("claude_state", if (sessions.any { it.getString("claude_state") == "working" }) "working" else "idle")
        put("last_sequence", sequence)
        put("sessions", JSONArray(sessions.toList()))
        put("running_count", sessions.count { it.getString("claude_state") == "working" })
        put("session_count", sessions.size)
        put("activity", activity)
        completion?.let { put("recent_completion", it) }
    }.toString()

    private class Fixture {
        var nowMs = 0L
        val client = WireClient()
        val viewModel = MonitorViewModel(client) { nowMs }
    }

    private class WireClient : MonitorClient {
        override val events = MutableSharedFlow<MonitorEvent>(extraBufferCapacity = 8)
        override val isConnected = MutableStateFlow(false)
        override fun connect() { isConnected.value = true }
        override fun disconnect() { isConnected.value = false }
        override fun send(command: MonitorCommand) = Unit
        fun emit(json: String) { check(events.tryEmit(requireNotNull(MonitorEvent.fromWireJson(json)))) }
    }

    private companion object {
        val SID_A = "codex:sess:" + "a".repeat(64)
        val SID_B = "codex:sess:" + "b".repeat(64)
        val TASK_A = "codex:turn:" + "c".repeat(64)
        val TASK_B = "codex:turn:" + "d".repeat(64)
    }
}
