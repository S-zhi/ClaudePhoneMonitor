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
    fun subscribeCommandUsesCanonicalWireKeys() {
        val hello = MonitorCommand.Hello("install-7", "phone-1", 40L).toWireJson()
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
}
