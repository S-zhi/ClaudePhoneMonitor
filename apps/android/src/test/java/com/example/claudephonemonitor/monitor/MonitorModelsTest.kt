package com.example.claudephonemonitor.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitorModelsTest {
    @Test
    fun parsesCanonicalSnapshotFields() {
        val event = MonitorEvent.fromWireJson(
            """
            {
              "type":"snapshot",
              "installation_id":"install-7",
              "computer_state":"online",
              "claude_state":"working",
              "activity":"tool",
              "last_sequence":42,
              "updated_at":"2026-10-02T12:00:00Z"
            }
            """.trimIndent(),
        )

        requireNotNull(event)
        assertEquals(MonitorEventType.SNAPSHOT, event.type)
        assertEquals("install-7", event.snapshot?.installationId)
        assertEquals(ComputerState.ONLINE, event.snapshot?.computerState)
        assertEquals(ClaudeState.WORKING, event.snapshot?.claudeState)
        assertEquals("tool", event.snapshot?.activity)
        assertEquals(42L, event.snapshot?.lastSequence)
    }

    @Test
    fun parsesServerUsageSnapshotAndRoundTripsOptionalAggregate() {
        val parsed = requireNotNull(
            MonitorEvent.fromWireJson(
                usageSnapshotJson(revision = 3, cacheHitQuality = "complete"),
            ),
        ).snapshot

        requireNotNull(parsed)
        val usage = requireNotNull(parsed.usage)
        assertEquals("epoch-1", usage.epochId)
        assertEquals(3L, usage.revision)
        assertEquals(3L, usage.observedResponses)
        assertEquals(2L, usage.completeResponses)
        assertEquals(120L, usage.newInput.value)
        assertEquals(UsageQuality.PARTIAL, usage.actual.quality)
        assertEquals(35L, usage.cacheHit.numerator)
        assertEquals(155L, usage.cacheHit.denominator)
        assertEquals("unavailable", usage.quota.availability)
        assertEquals(null, usage.quota.currentRemaining)

        val roundTrip = requireNotNull(
            MonitorEvent.fromWireJson(
                MonitorEvent(
                    type = MonitorEventType.SNAPSHOT,
                    snapshot = parsed,
                ).toWireJson(),
            ),
        ).snapshot?.usage
        assertEquals(usage, roundTrip)
    }

    @Test
    fun malformedUsageDoesNotInvalidateTheAuthoritativeMonitorSnapshot() {
        val tooLarge = usageSnapshotJson(revision = 9_007_199_254_740_992L, cacheHitQuality = "complete")
        val parsed = requireNotNull(MonitorEvent.fromWireJson(tooLarge)).snapshot
        requireNotNull(parsed)
        assertEquals(ComputerState.ONLINE, parsed.computerState)
        assertEquals(null, parsed.usage)

        val impossibleRatio = usageSnapshotJson(cacheHitQuality = "complete").replace(
            "\"denominator\":155",
            "\"denominator\":0",
        )
        assertEquals(null, requireNotNull(MonitorEvent.fromWireJson(impossibleRatio)).snapshot?.usage)
    }

    @Test
    fun oldSnapshotWithoutUsageKeepsUsageUnavailable() {
        val parsed = requireNotNull(
            MonitorEvent.fromWireJson("""{"type":"snapshot","computer_state":"online","claude_state":"idle","last_sequence":2}"""),
        ).snapshot
        assertEquals(null, parsed?.usage)
    }

    @Test
    fun relayEventInstallationIdAloneDoesNotMasqueradeAsAnIdleSnapshot() {
        val event = requireNotNull(
            MonitorEvent.fromWireJson(
                """{"type":"event","schema_version":1,"event_id":"evt-1","installation_id":"install-7","session_id":"session-1","task_id":"task-1","sequence":8,"occurred_at":"2026-10-07T01:00:00Z","event_type":"task_started","payload":{}}""",
            ),
        )

        assertEquals(MonitorEventType.EVENT, event.type)
        assertEquals(MonitorEventName.TASK_STARTED, event.name)
        assertEquals(8L, event.sequence)
        assertEquals(null, event.snapshot)
    }

    @Test
    fun legacyTopLevelSnapshotWithoutTypeStillParsesItsStateFields() {
        val event = requireNotNull(
            MonitorEvent.fromWireJson(
                """{"installation_id":"install-7","computer_state":"online","claude_state":"working","last_sequence":42}""",
            ),
        )

        assertEquals(ComputerState.ONLINE, event.snapshot?.computerState)
        assertEquals(ClaudeState.WORKING, event.snapshot?.claudeState)
        assertEquals(42L, event.snapshot?.lastSequence)
    }

    @Test
    fun oldSnapshotsKeepLegacyStateWithoutInventingSessionCounts() {
        val parsed = requireNotNull(
            MonitorEvent.fromWireJson(
                """{"type":"snapshot","computer_state":"online","claude_state":"waiting","last_sequence":3}""",
            ),
        ).snapshot

        requireNotNull(parsed)
        assertEquals(null, parsed.sessions)
        assertEquals(null, parsed.runningCount)
        assertEquals(null, parsed.sessionCount)
        assertEquals(ClaudeState.WAITING, parsed.claudeState)
    }

    @Test
    fun parsesAuthoritativeSessionListCompletionAndTopLevelEventIdentity() {
        val parsed = requireNotNull(
            MonitorEvent.fromWireJson(
                """{"type":"snapshot","computer_state":"online","claude_state":"idle","sessions":[],"running_count":0,"session_count":0,"recent_completion":{"session_id":"sess-1","task_id":"task-2","sequence":12,"occurred_at":"2026-10-06T01:02:03Z","display_name":"release prep"}}""",
            ),
        ).snapshot

        requireNotNull(parsed)
        assertEquals(emptyList<SessionSummary>(), parsed.sessions)
        assertEquals(0, parsed.runningCount)
        assertEquals(0, parsed.sessionCount)
        assertEquals("sess-1|task-2|12", parsed.recentCompletion?.identity)
        assertEquals("release prep", parsed.recentCompletion?.displayName)

        val event = requireNotNull(
            MonitorEvent.fromWireJson(
                """{"type":"event","event_type":"task_finished","session_id":"sess-1","task_id":"task-2","session_title":"release prep","sequence":12,"occurred_at":"2026-10-06T01:02:03Z"}""",
            ),
        )
        assertEquals("sess-1", event.sessionId)
        assertEquals("task-2", event.taskId)
        assertEquals("release prep", event.sessionTitle)
        assertEquals("2026-10-06T01:02:03Z", event.occurredAt)
    }

    @Test
    fun aPresentEmptySessionArrayMeansReplaceWithNoSessions() {
        val populated = requireNotNull(
            MonitorEvent.fromWireJson(
                """{"type":"snapshot","computer_state":"online","claude_state":"working","sessions":[{"session_id":"s1","title":"Build","claude_state":"working","last_activity_sequence":7}],"running_count":1,"session_count":1}""",
            ),
        ).snapshot
        val empty = requireNotNull(
            MonitorEvent.fromWireJson(
                """{"type":"snapshot","computer_state":"online","claude_state":"idle","sessions":[],"running_count":0,"session_count":0}""",
            ),
        ).snapshot

        assertEquals("s1", populated?.sessions?.single()?.sessionId)
        assertEquals(emptyList<SessionSummary>(), empty?.sessions)
    }

    @Test
    fun subscribeCommandUsesCanonicalWireKeys() {
        val hello = MonitorCommand.Hello("install-7", "phone-1", "android-token", 40L).toWireJson()
        val payload = MonitorCommand.Subscribe("install-7", "token", 41L).toWireJson()
        assertTrue(hello.contains("\"type\":\"hello\""))
        assertTrue(hello.contains("\"schema_version\":1"))
        assertTrue(hello.contains("\"role\":\"phone\""))
        assertTrue(payload.contains("\"type\":\"subscribe\""))
        assertTrue(payload.contains("\"schema_version\":1"))
        assertTrue(payload.contains("\"installation_id\":\"install-7\""))
        assertTrue(payload.contains("\"last_sequence\":41"))
    }

    @Test
    fun eventNamesCoverTheSixPetStates() {
        assertEquals(6, PetState.entries.size)
        assertEquals(PetState.WORKING, MonitorEventName.TASK_STARTED.toPetState())
        assertEquals(PetState.WORKING, MonitorEventName.TOOL_STARTED.toPetState())
        assertEquals(PetState.WAITING, MonitorEventName.WAITING.toPetState())
        assertEquals(PetState.FINISH, MonitorEventName.TASK_FINISHED.toPetState())
        assertEquals(PetState.ERROR, MonitorEventName.TASK_FAILED.toPetState())
        assertEquals(PetState.ERROR, MonitorEventName.TOOL_FAILED.toPetState())
        assertEquals(PetState.IDLE, MonitorEventName.SESSION_STARTED.toPetState())
        assertEquals(PetState.IDLE, MonitorEventName.SESSION_ENDED.toPetState())
        assertEquals(ActivityVariation.THINK, "task_started".toActivityVariation())
    }

    private fun usageSnapshotJson(
        revision: Long = 3L,
        cacheHitQuality: String,
    ) = """
        {
          "type":"snapshot",
          "computer_state":"online",
          "claude_state":"idle",
          "last_sequence":42,
          "usage":{
            "epoch_id":"epoch-1",
            "started_at":"2026-10-07T00:00:00Z",
            "revision":$revision,
            "observed_responses":3,
            "complete_responses":2,
            "provider_coverage":{
              "claude":{"status":"partial","observed_responses":1,"complete_responses":0},
              "codex":{"status":"ready","observed_responses":2,"complete_responses":2}
            },
            "new_input":{"value":120,"quality":"partial"},
            "cached_input":{"value":35,"quality":"partial"},
            "output":{"value":65,"quality":"partial"},
            "actual":{"value":185,"quality":"partial"},
            "total_input":{"value":155,"quality":"partial"},
            "cache_hit":{"numerator":35,"denominator":155,"quality":"$cacheHitQuality"},
            "quota":{"start_remaining":null,"current_remaining":null,"unit":null,"reset_at":null,"availability":"unavailable"}
          }
        }
    """.trimIndent()
}
