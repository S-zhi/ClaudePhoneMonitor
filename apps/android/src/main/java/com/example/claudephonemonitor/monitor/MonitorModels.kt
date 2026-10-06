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
    /** Optional, absolute server-authoritative usage aggregate. */
    val usage: UsageAggregate? = null,
)

enum class UsageQuality(val wireValue: String) {
    COMPLETE("complete"),
    PARTIAL("partial"),
    UNAVAILABLE("unavailable"),
}

enum class UsageCoverageStatus(val wireValue: String) {
    READY("ready"),
    PARTIAL("partial"),
    UNAVAILABLE("unavailable"),
}

data class UsageMetric(val value: Long?, val quality: UsageQuality)

data class UsageProviderCoverage(
    val status: UsageCoverageStatus,
    val observedResponses: Long,
    val completeResponses: Long,
)

data class UsageCacheHit(
    val numerator: Long?,
    val denominator: Long?,
    val quality: UsageQuality,
)

data class UsageQuota(
    val startRemaining: Long?,
    val currentRemaining: Long?,
    val unit: String?,
    val resetAt: String?,
    val availability: String,
)

data class UsageAggregate(
    val epochId: String,
    val startedAt: String,
    val revision: Long,
    val observedResponses: Long,
    val completeResponses: Long,
    val claudeCoverage: UsageProviderCoverage,
    val codexCoverage: UsageProviderCoverage,
    val newInput: UsageMetric,
    val cachedInput: UsageMetric,
    val output: UsageMetric,
    val actual: UsageMetric,
    val totalInput: UsageMetric,
    val cacheHit: UsageCacheHit,
    val quota: UsageQuota,
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
            // Relay event envelopes also contain installation_id. Only actual
            // state fields identify a legacy top-level snapshot.
            json.has("computer_state") || json.has("claude_state")

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
            usage = json.optJSONObject("usage")?.let(::usageFromJson),
        )

        private fun usageFromJson(json: JSONObject): UsageAggregate? = runCatching {
            val epochId = json.stringOrNull("epoch_id") ?: return null
            val startedAt = json.stringOrNull("started_at") ?: return null
            val revision = json.safeIntegerOrNull("revision") ?: return null
            val observedResponses = json.safeIntegerOrNull("observed_responses") ?: return null
            val completeResponses = json.safeIntegerOrNull("complete_responses") ?: return null
            if (completeResponses > observedResponses) return null
            val coverage = json.optJSONObject("provider_coverage") ?: return null
            val quotaJson = json.optJSONObject("quota") ?: return null
            val quotaAvailability = quotaJson.stringOrNull("availability") ?: return null
            if (quotaAvailability != "unavailable") return null
            if (!quotaJson.hasValidNullableInteger("start_remaining") ||
                !quotaJson.hasValidNullableInteger("current_remaining") ||
                !quotaJson.has("unit") || !quotaJson.has("reset_at")
            ) return null
            val quota = UsageQuota(
                startRemaining = quotaJson.safeIntegerOrNull("start_remaining"),
                currentRemaining = quotaJson.safeIntegerOrNull("current_remaining"),
                unit = quotaJson.stringOrNull("unit"),
                resetAt = quotaJson.stringOrNull("reset_at"),
                availability = quotaAvailability,
            )
            if (quota.startRemaining != null || quota.currentRemaining != null || quota.unit != null || quota.resetAt != null) {
                return null
            }
            UsageAggregate(
                epochId = epochId,
                startedAt = startedAt,
                revision = revision,
                observedResponses = observedResponses,
                completeResponses = completeResponses,
                claudeCoverage = parseCoverage(coverage.optJSONObject("claude")) ?: return null,
                codexCoverage = parseCoverage(coverage.optJSONObject("codex")) ?: return null,
                newInput = parseMetric(json.optJSONObject("new_input")) ?: return null,
                cachedInput = parseMetric(json.optJSONObject("cached_input")) ?: return null,
                output = parseMetric(json.optJSONObject("output")) ?: return null,
                actual = parseMetric(json.optJSONObject("actual")) ?: return null,
                totalInput = parseMetric(json.optJSONObject("total_input")) ?: return null,
                cacheHit = parseCacheHit(json.optJSONObject("cache_hit")) ?: return null,
                quota = quota,
            )
        }.getOrNull()

        private fun parseCoverage(json: JSONObject?): UsageProviderCoverage? = runCatching {
            json ?: return null
            val status = UsageCoverageStatus.entries.firstOrNull {
                it.wireValue == json.optString("status")
            } ?: return null
            val observed = json.safeIntegerOrNull("observed_responses") ?: return null
            val complete = json.safeIntegerOrNull("complete_responses") ?: return null
            if (complete > observed) return null
            UsageProviderCoverage(status, observed, complete)
        }.getOrNull()

        private fun parseMetric(json: JSONObject?): UsageMetric? = runCatching {
            json ?: return null
            val quality = parseUsageQuality(json.optString("quality")) ?: return null
            if (!json.hasValidNullableInteger("value")) return null
            val value = json.safeIntegerOrNull("value")
            if ((quality == UsageQuality.UNAVAILABLE) != (value == null)) return null
            UsageMetric(value, quality)
        }.getOrNull()

        private fun parseCacheHit(json: JSONObject?): UsageCacheHit? = runCatching {
            json ?: return null
            val quality = parseUsageQuality(json.optString("quality")) ?: return null
            if (!json.hasValidNullableInteger("numerator") || !json.hasValidNullableInteger("denominator")) return null
            val numerator = json.safeIntegerOrNull("numerator")
            val denominator = json.safeIntegerOrNull("denominator")
            if (quality == UsageQuality.UNAVAILABLE && (numerator != null || denominator != null)) return null
            if (numerator != null && denominator != null && numerator > denominator) return null
            if (quality == UsageQuality.COMPLETE && (numerator == null || denominator == null || denominator == 0L)) return null
            UsageCacheHit(numerator, denominator, quality)
        }.getOrNull()

        private fun parseUsageQuality(value: String): UsageQuality? =
            UsageQuality.entries.firstOrNull { it.wireValue == value }
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
    usage?.let { aggregate ->
        put("usage", aggregate.toJson())
    }
}

private fun UsageAggregate.toJson(): JSONObject = JSONObject().apply {
    put("epoch_id", epochId)
    put("started_at", startedAt)
    put("revision", revision)
    put("observed_responses", observedResponses)
    put("complete_responses", completeResponses)
    put("provider_coverage", JSONObject().apply {
        put("claude", claudeCoverage.toJson())
        put("codex", codexCoverage.toJson())
    })
    put("new_input", newInput.toJson())
    put("cached_input", cachedInput.toJson())
    put("output", output.toJson())
    put("actual", actual.toJson())
    put("total_input", totalInput.toJson())
    put("cache_hit", JSONObject().apply {
        put("numerator", cacheHit.numerator ?: JSONObject.NULL)
        put("denominator", cacheHit.denominator ?: JSONObject.NULL)
        put("quality", cacheHit.quality.wireValue)
    })
    put("quota", JSONObject().apply {
        put("start_remaining", quota.startRemaining ?: JSONObject.NULL)
        put("current_remaining", quota.currentRemaining ?: JSONObject.NULL)
        put("unit", quota.unit ?: JSONObject.NULL)
        put("reset_at", quota.resetAt ?: JSONObject.NULL)
        put("availability", quota.availability)
    })
}

private fun UsageProviderCoverage.toJson(): JSONObject = JSONObject().apply {
    put("status", status.wireValue)
    put("observed_responses", observedResponses)
    put("complete_responses", completeResponses)
}

private fun UsageMetric.toJson(): JSONObject = JSONObject().apply {
    put("value", value ?: JSONObject.NULL)
    put("quality", quality.wireValue)
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

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

private fun JSONObject.safeIntegerOrNull(key: String): Long? {
    if (!has(key) || isNull(key)) return null
    val value = opt(key) as? Number ?: return null
    val numeric = value.toDouble()
    if (!numeric.isFinite() || numeric < 0.0 || numeric > MAX_SAFE_INTEGER || numeric % 1.0 != 0.0) return null
    return numeric.toLong()
}

private fun JSONObject.hasValidNullableInteger(key: String): Boolean =
    has(key) && (isNull(key) || safeIntegerOrNull(key) != null)

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
