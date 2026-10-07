package com.example.claudephonemonitor.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UserActionPresentationTest {
    @Test fun onlyExplicitIdentifiedHumanWaitsCreateTheCue() {
        mapOf("question" to "Awaiting answer", "input" to "Awaiting input",
            "approval" to "Awaiting approval", "permission" to "Awaiting approval").forEach { (reason, title) ->
            val state = reduce(UserActionPresentationState(), waiting(reason))
            assertEquals(title, state.actions["target"]?.title)
            assertEquals("Target task", state.actions["target"]?.displayName)
        }
        listOf(null, "unknown", "stale", "working").forEach { reason ->
            assertTrue(reduce(UserActionPresentationState(), waiting(reason)).actions.isEmpty())
        }
        assertTrue(reduce(UserActionPresentationState(), waiting("question").copy(sessionId = "unknown")).actions.isEmpty())
    }

    @Test fun matchingQuestionToolResultClearsButParallelBashAndAnotherTaskDoNot() {
        val initial = reduce(UserActionPresentationState(), waiting("question"))
        val result = MonitorEvent(MonitorEventType.EVENT, name = MonitorEventName.TOOL_FINISHED,
            sequence = 3, sessionId = "target", taskId = "task-target", toolName = "AskUserQuestion", correlationId = "question-call")
        assertTrue(reduce(initial, result).actions.isEmpty())
        listOf(result.copy(sessionId = "other"), result.copy(taskId = "another-task"),
            result.copy(toolName = "Bash", correlationId = "bash-call")).forEach {
            assertEquals(initial.actions, reduce(initial, it).actions)
        }
    }

    @Test fun snapshotRecoversExplicitReasonEvenWhileAnotherTaskWorks() {
        val state = reduce(UserActionPresentationState(), snapshot(100,
            row(2, ClaudeState.WAITING, "question"), row(99, ClaudeState.WORKING, id = "other")))
        assertEquals("Awaiting answer", state.actions["target"]?.title)
        assertEquals(1, state.actions.size)
        val generic = reduce(UserActionPresentationState(), snapshot(100, row(2, ClaudeState.WAITING)))
        assertTrue(generic.actions.isEmpty())
    }

    @Test fun topFiveOmissionMissingReasonAndOrdinaryWaitingCannotProveAnAnswer() {
        val initial = reduce(UserActionPresentationState(), waiting("question"))
        val missingRow = reduce(initial, snapshot(100, row(99, ClaudeState.WORKING, id = "other")))
        assertEquals(initial.actions, missingRow.actions)
        val missingReason = reduce(initial, snapshot(101, row(99, ClaudeState.WAITING)))
        assertEquals(initial.actions, missingReason.actions)
        assertEquals(initial.actions, reduce(initial, waiting("unknown", 100)).actions)
        assertEquals(initial.actions, reduce(initial, MonitorEvent(MonitorEventType.DISCONNECTED)).actions)
    }

    @Test fun olderRowsCannotClearANewerQuestionOrReviveAClearedQuestion() {
        var state = reduce(UserActionPresentationState(), waiting("question", 10))
        state = reduce(state, snapshot(100, row(2, ClaudeState.WORKING)))
        assertEquals(10L, state.actions["target"]?.sequence)
        state = reduce(state, MonitorEvent(MonitorEventType.EVENT, name = MonitorEventName.TOOL_FINISHED,
            sequence = 11, sessionId = "target", taskId = "task-target", correlationId = "question-call"))
        assertTrue(state.actions.isEmpty())
        state = reduce(state, snapshot(200, row(10, ClaudeState.WAITING, "question")))
        assertTrue(state.actions.isEmpty())
        state = reduce(state, waiting("question", 11))
        assertTrue(state.actions.isEmpty())
        state = reduce(state, waiting("input", 12))
        assertEquals("Awaiting input", state.actions["target"]?.title)
    }

    @Test fun newInputAndSessionLifecycleClearTheCueWithoutClaimingAnAnswerResult() {
        val initial = reduce(UserActionPresentationState(), waiting("input").copy(toolName = null, correlationId = null))
        val unrelatedTool = MonitorEvent(MonitorEventType.EVENT, name = MonitorEventName.TOOL_FINISHED,
            sessionId = "target", taskId = "task-target", sequence = 3, toolName = "Bash")
        assertEquals(initial.actions, reduce(initial, unrelatedTool).actions)
        listOf(MonitorEventName.TASK_STARTED, MonitorEventName.TASK_FINISHED, MonitorEventName.SESSION_ENDED).forEach { name ->
            assertTrue(reduce(initial, unrelatedTool.copy(name = name,
                taskId = if (name == MonitorEventName.TASK_STARTED) "new-task" else "task-target")).actions.isEmpty())
        }
    }

    @Test fun repeatedExplicitTaskStartKeepsTheQuestionAndDoesNotCreateAClearTombstone() {
        val start = MonitorEvent(MonitorEventType.EVENT, name = MonitorEventName.TASK_STARTED,
            sessionId = "target", taskId = "task-target", sequence = 11)
        var state = reduce(UserActionPresentationState(), waiting("question", 10))
        state = reduce(state, start)
        assertEquals("Awaiting answer", state.actions["target"]?.title)
        assertTrue(state.clearedThroughSequence.isEmpty())
        val cold = UserActionPresentationReducer.reduce(UserActionPresentationState(), start,
            knownTaskIds = mapOf("target" to "task-target"))
        val recovered = reduce(cold, snapshot(100, row(10, ClaudeState.WAITING, "question")))
        assertEquals("Awaiting answer", recovered.actions["target"]?.title)
    }

    @Test fun completedLifecycleBeforeTheFirstQuestionSnapshotPreventsStaleRecovery() {
        listOf(MonitorEventName.TASK_STARTED, MonitorEventName.TASK_FINISHED, MonitorEventName.TOOL_FINISHED).forEach { name ->
            val completed = MonitorEvent(MonitorEventType.EVENT, name = name, sequence = 11,
                sessionId = "target", toolName = "AskUserQuestion")
            val state = reduce(reduce(UserActionPresentationState(), completed),
                snapshot(100, row(10, ClaudeState.WAITING, "question")))
            assertTrue("$name must prevent an older row from restoring the finished question", state.actions.isEmpty())
        }
        val bash = MonitorEvent(MonitorEventType.EVENT, name = MonitorEventName.TOOL_FINISHED,
            sequence = 11, sessionId = "target", toolName = "Bash")
        assertEquals("Awaiting answer", reduce(reduce(UserActionPresentationState(), bash),
            snapshot(100, row(10, ClaudeState.WAITING, "question"))).actions["target"]?.title)
    }

    @Test fun bridgeResolutionDoesNotLeaveADuplicateNativeApprovalCue() {
        var state = reduce(UserActionPresentationState(), waiting("permission"))
        state = reduce(state, MonitorEvent(MonitorEventType.EVENT, name = MonitorEventName.APPROVAL_RESOLVED,
            sessionId = "target", taskId = "task-target", sequence = 3,
            approval = ApprovalEventMetadata(ApprovalPresentationTest.REQUEST_A, ApprovalStatus.UNKNOWN, false)))
        assertTrue(state.actions.isEmpty())
        state = reduce(state, snapshot(4, row(2, ClaudeState.WAITING, "permission")))
        assertTrue(state.actions.isEmpty())
    }

    @Test fun wireReasonIsRestoredOnlyForWaitingRowsAndKeepsToolCorrelation() {
        val wire = """{"type":"event","event_type":"waiting","session_id":"target","task_id":"task-target","sequence":2,"correlation_id":"question-call","payload":{"reason":"question","tool_name":"AskUserQuestion"}}"""
        val event = requireNotNull(MonitorEvent.fromWireJson(wire))
        assertEquals("AskUserQuestion", event.toolName)
        assertEquals("question-call", event.correlationId)
        assertEquals(event, MonitorEvent.fromWireJson(event.toWireJson()))
        val snapshotWire = """{"type":"snapshot","snapshot":{"computer_state":"online","claude_state":"working","last_sequence":3,"sessions":[{"session_id":"target","title":"Target task","claude_state":"waiting","last_activity_sequence":2,"waiting_reason":"question"},{"session_id":"other","title":"Other task","claude_state":"working","last_activity_sequence":3,"waiting_reason":"input"}]}}"""
        val rows = requireNotNull(MonitorEvent.fromWireJson(snapshotWire)?.snapshot?.sessions)
        assertEquals("question", rows[0].waitingReason)
        assertEquals(null, rows[1].waitingReason)
    }

    private fun waiting(reason: String?, sequence: Long = 2) = MonitorEvent(MonitorEventType.EVENT,
        name = MonitorEventName.WAITING, sessionId = "target", taskId = "task-target", sessionTitle = "Target task",
        sequence = sequence, waitingReason = reason, toolName = "AskUserQuestion", correlationId = "question-call")
    private fun row(sequence: Long, state: ClaudeState, reason: String? = null, id: String = "target") =
        SessionSummary(id, "Target task", state, sequence, waitingReason = reason)
    private fun snapshot(sequence: Long, vararg rows: SessionSummary) = MonitorEvent(MonitorEventType.SNAPSHOT,
        snapshot = MonitorSnapshot(computerState = ComputerState.ONLINE, claudeState = ClaudeState.WORKING,
            lastSequence = sequence, sessions = rows.toList()))
    private fun reduce(state: UserActionPresentationState, event: MonitorEvent) = UserActionPresentationReducer.reduce(state, event)
}
