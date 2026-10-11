package com.example.claudephonemonitor.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionSourceTest {
    @Test
    fun codexSessionIdsUseCodexSource() {
        assertEquals(SessionSource.CODEX, sessionSource("codex:sess:${"a".repeat(64)}"))
    }

    @Test
    fun nonCodexSessionIdsUseClaudeSource() {
        assertEquals(SessionSource.CLAUDE, sessionSource("session-123"))
        assertEquals(SessionSource.CLAUDE, sessionSource(""))
    }

    @Test
    fun malformedCodexPrefixesRemainClaudeSource() {
        assertEquals(SessionSource.CLAUDE, sessionSource("codex:sess:${"a".repeat(63)}"))
        assertEquals(SessionSource.CLAUDE, sessionSource("codex:sess:${"A".repeat(64)}"))
    }
}
