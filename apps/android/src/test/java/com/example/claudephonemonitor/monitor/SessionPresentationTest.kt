package com.example.claudephonemonitor.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionPresentationTest {
    @Test
    fun topFiveUsesLatestSequenceAndStableIdOrder() {
        val snapshot = MonitorSnapshot(sessions = listOf(
            session("z", 2), session("b", 8), session("old", 1), session("a", 8),
            session("c", 7), session("d", 6), session("e", 5),
        ))

        assertEquals(listOf("a", "b", "c", "d", "e"), snapshot.sortedTopSessions().map { it.sessionId })
        assertEquals(7, snapshot.sessions?.size) // Sorting is a projection, not a snapshot mutation.
    }

    @Test
    fun workingCountIncludesTasksOutsideTopFiveAndLatestIdleOutranksOlderWaiting() {
        val snapshot = MonitorSnapshot(
            computerState = ComputerState.ONLINE,
            claudeState = ClaudeState.WAITING,
            sessions = listOf(session("older", 4, ClaudeState.WAITING), session("latest", 8)),
            runningCount = 0,
            sessionCount = 2,
        )
        assertEquals(PetState.IDLE, snapshot.aggregatePetState())
        assertEquals(PetState.WORKING, snapshot.copy(runningCount = 1, sessionCount = 6).aggregatePetState())
        assertEquals(PetState.WAITING, snapshot.copy(sessions = listOf(
            session("latest", 9, ClaudeState.WAITING), session("older", 8),
        )).aggregatePetState())
        assertEquals(PetState.WORKING, snapshot.copy(sessions = snapshot.sessions.orEmpty() +
            session("background", 1, ClaudeState.WORKING)).aggregatePetState())
        assertEquals(PetState.OFFLINE, snapshot.copy(computerState = ComputerState.OFFLINE, runningCount = 1).aggregatePetState())
    }

    @Test
    fun doneUsesOnlyMatchingSessionAndDoesNotCoverLaterWorkOrWaiting() {
        val completion = RecentCompletion("done", "task", 10, "", "Release")
        assertEquals(SessionDisplayState.DONE, session("done", 9, ClaudeState.WORKING).displayState(completion))
        assertEquals(SessionDisplayState.DONE, session("done", 12).displayState(completion)) // Idle stop tail.
        assertEquals(SessionDisplayState.WORKING, session("done", 11, ClaudeState.WORKING).displayState(completion))
        assertEquals(SessionDisplayState.WAITING, session("done", 11, ClaudeState.WAITING).displayState(completion))
        assertEquals(SessionDisplayState.IDLE, session("other", 9).displayState(completion))
        assertEquals(SessionDisplayState.IDLE, session("done", 9).displayState(null))
    }

    @Test
    fun fallbackLabelsUseStableAnonymousSuffixesAndPreserveCodexHashes() {
        // SHA-256("session") ends in fd9175, independent of any raw identifier suffix.
        assertEquals("会话 fd9175", fallbackSessionTitle("session"))
        val codexId = "codex:sess:" + "a".repeat(58) + "12abcd"
        assertEquals("Codex 12abcd", fallbackSessionTitle(codexId))
        assertTrue(fallbackSessionTitle("private-project-secret").matches(Regex("会话 [0-9a-f]{6}")))
    }

    private fun session(id: String, sequence: Long, state: ClaudeState = ClaudeState.IDLE) =
        SessionSummary(id, id, state, sequence)
}
