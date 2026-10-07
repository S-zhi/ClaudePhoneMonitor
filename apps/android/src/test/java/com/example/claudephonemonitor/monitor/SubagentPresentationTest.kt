package com.example.claudephonemonitor.monitor

import org.junit.Assert.*
import org.junit.Test

class SubagentPresentationTest {
    @Test fun explicitCountersAndClassificationRoundTripWithoutInventingLegacyCounts() {
        val old = MonitorEvent.fromWireJson("""{"type":"snapshot","computer_state":"offline","running_count":9,"session_count":8}""")!!.snapshot!!
        assertNull(old.mainRunningCount)
        assertNull(old.mainSessionCount)
        assertNull(old.totalRunningCount)
        val snapshot = MonitorSnapshot(mainRunningCount = 0, mainSessionCount = 7, totalRunningCount = 12,
            sessions = listOf(SessionSummary("child", "Child", ClaudeState.WORKING, 1, SessionKind.SUBAGENT)))
        val decoded = MonitorEvent.fromWireJson(MonitorEvent(MonitorEventType.SNAPSHOT, snapshot = snapshot).toWireJson())!!.snapshot!!
        assertEquals(snapshot, decoded)
        assertNull(MonitorEvent.fromWireJson("""{"type":"event","event_type":"session_classification_updated","session_id":"child"}"""))
    }

    @Test fun classificationCorrectionClearsOnlyItsOwnOutcomeAndChildClassificationIsSticky() {
        var state = MonitorPresentationReducer.reduce(MonitorPresentationState(), MonitorEvent(MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, lastSequence = 1)), 0).state
        state = MonitorPresentationReducer.reduce(state, MonitorEvent(MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED, sessionId = "child", sessionTitle = "Wrong result", sequence = 2), 100).state
        assertEquals(PetState.FINISH, state.changeStatus)
        state = MonitorPresentationReducer.reduce(state, MonitorEvent(MonitorEventType.EVENT,
            name = MonitorEventName.SESSION_CLASSIFICATION_UPDATED, sessionId = "child", sessionKind = SessionKind.SUBAGENT,
            sequence = 3), 200).state
        assertNull(state.changeStatus)
        assertNull(state.completionName)
        assertNull(state.recentSessionCompletion)
        state = MonitorPresentationReducer.reduce(state, MonitorEvent(MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FAILED, sessionId = "child", sessionKind = SessionKind.MAIN, sequence = 4), 300).state
        assertEquals(SessionKind.SUBAGENT, state.sessionKinds["child"])
        assertNull(state.changeStatus)
        state = MonitorPresentationReducer.reduce(state, MonitorEvent(MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, lastSequence = 5,
                sessions = listOf(SessionSummary("child", "Child", ClaudeState.WORKING, 5, SessionKind.MAIN)))), 400).state
        assertEquals(SessionKind.SUBAGENT, state.sessionKinds["child"])
        assertEquals(PetState.IDLE, state.baseState)
    }

    @Test fun mainFilteringPrecedesCapAndChildOnlyIsIdle() {
        val rows = (1..8).map { SessionSummary("main$it", "Main $it", ClaudeState.IDLE, it.toLong()) }
        val snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, claudeState = ClaudeState.WORKING,
            mainRunningCount = 0, mainSessionCount = 8, totalRunningCount = 20,
            sessions = (1..20).map { SessionSummary("child$it", "Child", ClaudeState.WORKING, 100L + it, SessionKind.SUBAGENT) } + rows)
        assertEquals(listOf("main8", "main7", "main6", "main5", "main4"), snapshot.sortedTopSessions().map { it.sessionId })
        assertEquals(PetState.IDLE, snapshot.aggregatePetState())
    }

    @Test fun childAndMetadataAdvanceWatermarkWithoutChangingCompletionOrDeadlines() {
        var state = MonitorPresentationReducer.reduce(MonitorPresentationState(), MonitorEvent(MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, lastSequence = 1)), 0).state
        state = MonitorPresentationReducer.reduce(state, MonitorEvent(MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED, sequence = 2, sessionId = "main", sessionTitle = "Main result"), 100).state
        val result = state.recentSessionCompletion
        val deadline = state.changeDeadlineMs
        val completionDeadline = state.sessionCompletionDeadlineMs
        val metadata = MonitorEvent(MonitorEventType.EVENT, name = MonitorEventName.SESSION_CLASSIFICATION_UPDATED,
            sequence = 3, sessionId = "child", sessionKind = SessionKind.SUBAGENT)
        state = MonitorPresentationReducer.reduce(state, metadata, 200).state
        MonitorEventName.entries.filter { it in listOf(MonitorEventName.TASK_STARTED, MonitorEventName.WAITING,
            MonitorEventName.TASK_FAILED, MonitorEventName.TOOL_FAILED, MonitorEventName.TASK_FINISHED) }.forEachIndexed { i, name ->
            state = MonitorPresentationReducer.reduce(state, MonitorEvent(MonitorEventType.EVENT, name = name,
                sequence = 4L + i, sessionId = "child", sessionTitle = "Child result"), 300L + i).state
            assertEquals(deadline, state.changeDeadlineMs)
            assertEquals(completionDeadline, state.sessionCompletionDeadlineMs)
            assertEquals(result, state.recentSessionCompletion)
            assertEquals("Main result", state.completionName)
        }
        assertEquals(8L, state.lastSequence)
        val stale = MonitorPresentationReducer.reduce(state, metadata, 500)
        assertFalse(stale.accepted)
        val refresh = MonitorPresentationReducer.reduce(state, MonitorEvent(MonitorEventType.SNAPSHOT,
            snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, lastSequence = 8,
                mainRunningCount = 0, totalRunningCount = 1)), 600).state
        val child = MonitorPresentationReducer.reduce(refresh, MonitorEvent(MonitorEventType.EVENT,
            name = MonitorEventName.TASK_FINISHED, sessionId = "child", sequence = 9), 700).state
        assertEquals(deadline, child.changeDeadlineMs)
        assertEquals(result, child.recentSessionCompletion)
    }
}
