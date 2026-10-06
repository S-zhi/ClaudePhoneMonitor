package com.example.claudephonemonitor.monitor

import org.json.JSONObject
import java.util.Locale

/** The six visual states exposed by the phone monitor. */
enum class PetState(
    val title: String,
    val shortLabel: String,
    val color: Long,
) {
    IDLE("IDLE", "REST", 0xFF8A90A8),
    WORKING("WORKING", "WORK", 0xFF8DE6A8),
    WAITING("WAITING", "WAIT", 0xFFF6C76D),
    FINISH("FINISH", "DONE", 0xFF8FE1FF),
    ERROR("ERROR", "ERR", 0xFFFF7B85),
    OFFLINE("OFFLINE", "DOWN", 0xFF65718B),
}

enum class ComputerState(val wireValue: String) {
    ONLINE("online"),
    STALE("stale"),
    OFFLINE("offline"),
}

enum class ClaudeState(val wireValue: String) {
    IDLE("idle"),
    WORKING("working"),
    WAITING("waiting"),
}

enum class ActivityVariation(val wireValue: String, val label: String) {
    BREATH("breath", "BREATH"),
    THINK("think", "THINK"),
    TOOL("tool", "TOOL"),
    WAIT("wait", "WAIT"),
    CELEBRATE("celebrate", "CELEBRATE"),
    ALERT("alert", "ALERT"),
}

enum class MonitorEventType(val wireValue: String) {
    SNAPSHOT("snapshot"),
    EVENT("event"),
    PROBE_RESULT("probe_result"),
    CONNECTED("connected"),
    DISCONNECTED("disconnected"),
    UNKNOWN("unknown"),
}

enum class MonitorEventName(val wireValue: String) {
    TASK_STARTED("task_started"),
    TOOL_STARTED("tool_started"),
    TOOL_FINISHED("tool_finished"),
    TOOL_FAILED("tool_failed"),
    WAITING("waiting"),
    TASK_FINISHED("task_finished"),
    TASK_FAILED("task_failed"),
    SESSION_STARTED("session_started"),
    SESSION_ENDED("session_ended"),
    UNKNOWN("unknown"),
}

data class MonitorSnapshot(
    val installationId: String = "demo-installation",
    val computerState: ComputerState = ComputerState.OFFLINE,
    val claudeState: ClaudeState = ClaudeState.IDLE,
    val activity: String? = null,
    val lastSequence: Long = 0L,
    val updatedAt: String = "",
    /** Present only on new Relay snapshots. Its presence means the list is authoritative. */
    val sessions: List<SessionSummary>? = null,
    val runningCount: Int? = null,
    val sessionCount: Int? = null,
    val recentCompletion: RecentCompletion? = null,
)

data class SessionSummary(
    val sessionId: String,
    val title: String,
    val claudeState: ClaudeState,
    val lastActivitySequence: Long,
)

data class RecentCompletion(
    val sessionId: String,
    val taskId: String? = null,
    val sequence: Long,
    val occurredAt: String,
    val displayName: String,
) {
    /** Stable across live event + authoritative snapshot delivery and reconnects. */
    val identity: String get() = "$sessionId|${taskId.orEmpty()}|$sequence"
}

data class MonitorEvent(
    val type: MonitorEventType,
    val name: MonitorEventName = MonitorEventName.UNKNOWN,
    val snapshot: MonitorSnapshot? = null,
    val sequence: Long? = null,
    val activity: String? = null,
    val detail: String = "",
    val updatedAt: String = "",
    val probeLatencyMs: Long? = null,
    val sessionId: String? = null,
    val taskId: String? = null,
    val sessionTitle: String? = null,
    val occurredAt: String = "",
) {
    fun toWireJson(): String = JSONObject().apply {
        put("type", type.wireValue)
        if (name != MonitorEventName.UNKNOWN) put("event_type", name.wireValue)
        snapshot?.let { put("snapshot", it.toJson()) }
        sequence?.let { put("sequence", it) }
        activity?.let { put("activity", it) }
        if (detail.isNotBlank()) put("detail", detail)
        if (updatedAt.isNotBlank()) put("updated_at", updatedAt)
        probeLatencyMs?.let { put("latency_ms", it) }
        sessionId?.let { put("session_id", it) }
        taskId?.let { put("task_id", it) }
        sessionTitle?.let { put("session_title", it) }
        if (occurredAt.isNotBlank()) put("occurred_at", occurredAt)
    }.toString()

    companion object {
        fun fromWireJson(raw: String): MonitorEvent? = runCatching {
            val root = JSONObject(raw)
            val typeValue = root.optString("type").lowercase(Locale.US)
            val type = MonitorEventType.entries.firstOrNull { it.wireValue == typeValue }
                ?: when (typeValue) {
                    "challenge", "challenge_ack" -> MonitorEventType.PROBE_RESULT
                    "hello_ack" -> MonitorEventType.CONNECTED
                    else -> MonitorEventType.UNKNOWN
                }
            val snapshotObject = when {
                root.optJSONObject("snapshot") != null -> root.optJSONObject("snapshot")
                hasSnapshotFields(root) -> root
                else -> null
            }
            val snapshot = snapshotObject?.let(::snapshotFromJson)
            val eventValue = root.optString(
                "event_type",
                root.optString("event", root.optString("name", typeValue)),
            ).lowercase(Locale.US)
            val eventName = MonitorEventName.entries.firstOrNull { it.wireValue == eventValue }
                ?: MonitorEventName.UNKNOWN
            val resolvedType = if (type == MonitorEventType.UNKNOWN &&
                eventName != MonitorEventName.UNKNOWN
            ) {
                MonitorEventType.EVENT
            } else {
                type
            }
            MonitorEvent(
                type = resolvedType,
                name = eventName,
                snapshot = snapshot,
                sequence = root.longOrNull("sequence") ?: root.longOrNull("last_sequence"),
                activity = root.activityOrNull() ?: snapshot?.activity,
                detail = root.optString("detail", root.optString("message")),
                updatedAt = root.optString("updated_at", snapshot?.updatedAt.orEmpty()),
                probeLatencyMs = root.longOrNull("latency_ms"),
                sessionId = root.stringOrNull("session_id"),
                taskId = root.stringOrNull("task_id"),
                sessionTitle = root.stringOrNull("session_title"),
                occurredAt = root.optString("occurred_at"),
            )
        }.getOrNull()

        private fun hasSnapshotFields(json: JSONObject): Boolean =
            json.has("installation_id") || json.has("computer_state") || json.has("claude_state")

        private fun snapshotFromJson(json: JSONObject): MonitorSnapshot = MonitorSnapshot(
            installationId = json.optString("installation_id", "demo-installation"),
            computerState = ComputerState.entries.firstOrNull {
                it.wireValue == json.optString("computer_state").lowercase(Locale.US)
            } ?: ComputerState.ONLINE,
            claudeState = ClaudeState.entries.firstOrNull {
                it.wireValue == json.optString("claude_state").lowercase(Locale.US)
            } ?: ClaudeState.IDLE,
            activity = json.activityOrNull(),
            lastSequence = json.longOrNull("last_sequence") ?: json.longOrNull("sequence") ?: 0L,
            updatedAt = json.optString("updated_at"),
            sessions = json.optJSONArray("sessions")?.let { array ->
                buildList {
                    for (index in 0 until array.length()) {
                        val item = array.optJSONObject(index) ?: continue
                        val id = item.stringOrNull("session_id") ?: continue
                        val state = ClaudeState.entries.firstOrNull {
                            it.wireValue == item.optString("claude_state").lowercase(Locale.US)
                        } ?: continue
                        add(
                            SessionSummary(
                                sessionId = id,
                                title = item.optString("title").ifBlank { "会话 ${id.takeLast(4)}" },
                                claudeState = state,
                                lastActivitySequence = item.longOrNull("last_activity_sequence") ?: 0L,
                            ),
                        )
                    }
                }
            },
            runningCount = json.intOrNull("running_count"),
            sessionCount = json.intOrNull("session_count"),
            recentCompletion = json.optJSONObject("recent_completion")?.let { completion ->
                val id = completion.stringOrNull("session_id")
                val sequence = completion.longOrNull("sequence")
                if (id == null || sequence == null) null else RecentCompletion(
                    sessionId = id,
                    taskId = completion.stringOrNull("task_id"),
                    sequence = sequence,
                    occurredAt = completion.optString("occurred_at"),
                    displayName = completion.optString("display_name").ifBlank { "未命名会话已完成" },
                )
            },
        )
    }
}

fun MonitorSnapshot.toJson(): JSONObject = JSONObject().apply {
    put("installation_id", installationId)
    put("computer_state", computerState.wireValue)
    put("claude_state", claudeState.wireValue)
    activity?.let { put("activity", it) }
    put("last_sequence", lastSequence)
    put("updated_at", updatedAt)
    sessions?.let { rows ->
        put("sessions", org.json.JSONArray().apply {
            rows.forEach { session ->
                put(JSONObject().apply {
                    put("session_id", session.sessionId)
                    put("title", session.title)
                    put("claude_state", session.claudeState.wireValue)
                    put("last_activity_sequence", session.lastActivitySequence)
                })
            }
        })
    }
    runningCount?.let { put("running_count", it) }
    sessionCount?.let { put("session_count", it) }
    recentCompletion?.let { completion ->
        put("recent_completion", JSONObject().apply {
            put("session_id", completion.sessionId)
            completion.taskId?.let { put("task_id", it) }
            put("sequence", completion.sequence)
            put("occurred_at", completion.occurredAt)
            put("display_name", completion.displayName)
        })
    }
}

private fun JSONObject.activityOrNull(): String? {
    val value = if (has("activity") && !isNull("activity")) opt("activity") else return null
    return when (value) {
        is String -> value.takeIf { it.isNotBlank() }
        is JSONObject -> value.optString("event_type").takeIf { it.isNotBlank() }
        else -> null
    }
}

private fun JSONObject.longOrNull(key: String): Long? =
    if (!has(key) || isNull(key)) null else runCatching { getLong(key) }.getOrNull()

private fun JSONObject.intOrNull(key: String): Int? = longOrNull(key)?.takeIf {
    it in 0..Int.MAX_VALUE.toLong()
}?.toInt()

private fun JSONObject.stringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key).takeIf(String::isNotBlank)

sealed interface MonitorCommand {
    fun toWireJson(): String

    data class Hello(
        val installationId: String,
        val clientId: String,
        val token: String,
        val lastSequence: Long,
    ) : MonitorCommand {
        override fun toWireJson(): String = JSONObject().apply {
            put("type", "hello")
            put("schema_version", 1)
            put("installation_id", installationId)
            put("client_id", clientId)
            put("role", "phone")
            put("token", token)
            put("last_sequence", lastSequence)
        }.toString()
    }

    data class Subscribe(
        val installationId: String,
        val token: String,
        val lastSequence: Long,
    ) : MonitorCommand {
        override fun toWireJson(): String = JSONObject().apply {
            put("type", "subscribe")
            put("schema_version", 1)
            put("installation_id", installationId)
            put("token", token)
            put("last_sequence", lastSequence)
        }.toString()
    }
}

fun MonitorEventName.toPetState(): PetState = when (this) {
    MonitorEventName.WAITING -> PetState.WAITING
    MonitorEventName.TASK_FINISHED -> PetState.FINISH
    MonitorEventName.TASK_FAILED,
    MonitorEventName.TOOL_FAILED -> PetState.ERROR
    MonitorEventName.TASK_STARTED,
    MonitorEventName.TOOL_STARTED,
    MonitorEventName.TOOL_FINISHED -> PetState.WORKING
    MonitorEventName.SESSION_STARTED,
    MonitorEventName.SESSION_ENDED,
    MonitorEventName.UNKNOWN -> PetState.IDLE
}

fun String?.toActivityVariation(): ActivityVariation = when (this?.lowercase(Locale.US)) {
    "think", "thinking", "session_started", "task_started" -> ActivityVariation.THINK
    "tool", "working", "tool_started", "tool_finished" -> ActivityVariation.TOOL
    "wait", "waiting" -> ActivityVariation.WAIT
    "celebrate", "finish", "finished", "task_finished" -> ActivityVariation.CELEBRATE
    "alert", "error", "failed", "task_failed", "tool_failed" -> ActivityVariation.ALERT
    else -> ActivityVariation.BREATH
}
