package com.example.claudephonemonitor.monitor

import org.json.JSONObject
import java.time.OffsetDateTime
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
    APPROVAL_DECISION_ACK("approval_decision_ack"),
    UNKNOWN("unknown"),
}

enum class MonitorEventName(val wireValue: String) {
    TASK_STARTED("task_started"),
    TOOL_STARTED("tool_started"),
    TOOL_FINISHED("tool_finished"),
    TOOL_FAILED("tool_failed"),
    WAITING("waiting"),
    APPROVAL_REQUESTED("approval_requested"),
    APPROVAL_RESOLVED("approval_resolved"),
    TASK_FINISHED("task_finished"),
    TASK_FAILED("task_failed"),
    SESSION_STARTED("session_started"),
    SESSION_TITLE_UPDATED("session_title_updated"),
    SESSION_ENDED("session_ended"),
    SESSION_CLASSIFICATION_UPDATED("session_classification_updated"),
    UNKNOWN("unknown"),
}

enum class SessionKind(val wireValue: String) { MAIN("main"), SUBAGENT("subagent") }

data class MonitorSnapshot(
    val installationId: String = "demo-installation",
    val computerState: ComputerState = ComputerState.OFFLINE,
    val claudeState: ClaudeState = ClaudeState.IDLE,
    val activity: String? = null,
    val lastSequence: Long = 0L,
    val updatedAt: String = "",
    /** Present only on new Relay snapshots. Its presence means the list is authoritative. */
    val sessions: List<SessionSummary>? = null,
    val mainRunningCount: Int? = null,
    val mainSessionCount: Int? = null,
    val totalRunningCount: Int? = null,
    val runningCount: Int? = null,
    val sessionCount: Int? = null,
    val recentCompletion: RecentCompletion? = null,
    /** Optional, absolute server-authoritative usage aggregate. */
    val usage: UsageAggregate? = null,
    /** All current main tasks, independently of the five visible session rows. */
    val activeTasks: List<ActiveTask>? = null,
    /** Explicit, identity-bound approval bridge state; absent on older sources. */
    val approvals: List<ApprovalSummary>? = null,
)

enum class ApprovalStatus(val wireValue: String) {
    PENDING("pending"), APPROVED("approved"), DENIED("denied"), UNKNOWN("unknown"), RESOLVED("resolved"),
}

enum class ApprovalSource(val wireValue: String) { CLAUDE_CODE("claude_code"), CODEX("codex") }

enum class ApprovalDecision(val wireValue: String) { ALLOW("allow"), DENY("deny"), COMPUTER("computer") }

data class ApprovalSummary(
    val requestId: String,
    val sessionId: String,
    val taskId: String? = null,
    val displayName: String,
    val sequence: Long,
    val requestedAt: String,
    val status: ApprovalStatus,
    val canRespond: Boolean,
    val toolName: String? = null,
    val expiresAt: String? = null,
    val resolvedAt: String? = null,
    val source: ApprovalSource = ApprovalSource.CLAUDE_CODE,
) {
    val isPending: Boolean get() = status == ApprovalStatus.PENDING
    val isHandled: Boolean get() = status in setOf(ApprovalStatus.APPROVED, ApprovalStatus.DENIED, ApprovalStatus.RESOLVED)
}

data class ApprovalEventMetadata(
    val requestId: String,
    val status: ApprovalStatus,
    val canRespond: Boolean,
    val toolName: String? = null,
    val expiresAt: String? = null,
    val source: ApprovalSource = ApprovalSource.CLAUDE_CODE,
)

data class ApprovalDecisionAck(
    val requestId: String,
    val decisionId: String,
    val accepted: Boolean,
    val reason: String? = null,
)

data class ActiveTask(
    val sessionId: String,
    val taskId: String? = null,
    val startedAt: String,
    val elapsedMs: Long,
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
    val sessionKind: SessionKind? = null,
    val waitingReason: String? = null,
)

data class RecentCompletion(
    val sessionId: String,
    val taskId: String? = null,
    val sequence: Long,
    val occurredAt: String,
    val displayName: String,
    val durationMs: Long? = null,
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
    val sessionKind: SessionKind? = null,
    val durationMs: Long? = null,
    val waitingReason: String? = null,
    val approval: ApprovalEventMetadata? = null,
    val approvalDecisionAck: ApprovalDecisionAck? = null,
    val toolName: String? = null,
    val correlationId: String? = null,
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
        sessionKind?.let { put("session_kind", it.wireValue) }
        taskId?.let { put("task_id", it) }
        correlationId?.let { put("correlation_id", it) }
        sessionTitle?.let { put("session_title", it) }
        if (occurredAt.isNotBlank()) put("occurred_at", occurredAt)
        if (durationMs != null || waitingReason != null || approval != null || toolName != null) {
            put("payload", JSONObject().apply {
                durationMs?.let { put("duration_ms", it) }
                waitingReason?.let { put("reason", it) }
                toolName?.let { put("tool_name", it) }
                approval?.let {
                    put("request_id", it.requestId)
                    put("source", it.source.wireValue)
                    put("status", it.status.wireValue)
                    put("can_respond", it.canRespond)
                    it.toolName?.let { name -> put("tool_name", name) }
                    it.expiresAt?.let { expiry -> put("expires_at", expiry) }
                }
            })
        }
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
            val sessionKind = root.sessionKindOrNull()
            if (eventName == MonitorEventName.SESSION_CLASSIFICATION_UPDATED && sessionKind == null) return null
            val approval = if (eventName in setOf(MonitorEventName.APPROVAL_REQUESTED, MonitorEventName.APPROVAL_RESOLVED)) {
                val metadata = root.optJSONObject("payload")?.let(::approvalMetadataFromJson) ?: return null
                if (root.stringOrNull("session_id").let { it == null || it == "unknown" }) return null
                if ((eventName == MonitorEventName.APPROVAL_REQUESTED) != (metadata.status == ApprovalStatus.PENDING)) return null
                metadata
            } else null
            val approvalAck = if (type == MonitorEventType.APPROVAL_DECISION_ACK) {
                val requestId = root.uuidOrNull("request_id") ?: return null
                val decisionId = root.uuidOrNull("decision_id") ?: return null
                val accepted = root.opt("accepted") as? Boolean ?: return null
                ApprovalDecisionAck(requestId, decisionId, accepted, root.stringOrNull("reason"))
            } else null
            MonitorEvent(
                sessionKind = sessionKind,
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
                durationMs = root.optJSONObject("payload")?.durationOrNull("duration_ms"),
                waitingReason = root.optJSONObject("payload")?.stringOrNull("reason")
                    ?.takeIf { it in WAITING_REASONS },
                approval = approval,
                approvalDecisionAck = approvalAck,
                toolName = root.optJSONObject("payload")?.stringOrNull("tool_name"),
                correlationId = root.stringOrNull("correlation_id"),
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
                                sessionKind = item.sessionKindOrNull(),
                                title = item.optString("title").ifBlank { fallbackSessionTitle(id) },
                                claudeState = state,
                                lastActivitySequence = item.longOrNull("last_activity_sequence") ?: 0L,
                                waitingReason = item.stringOrNull("waiting_reason")
                                    ?.takeIf { state == ClaudeState.WAITING && it in USER_ACTION_WAITING_REASONS },
                            ),
                        )
                    }
                }
            },
            mainRunningCount = json.intOrNull("main_running_count"),
            mainSessionCount = json.intOrNull("main_session_count"),
            totalRunningCount = json.intOrNull("total_running_count"),
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
                    displayName = completion.optString("display_name").ifBlank { fallbackSessionTitle(id) },
                    durationMs = completion.durationOrNull("duration_ms"),
                )
            },
            usage = json.optJSONObject("usage")?.let(::usageFromJson),
            activeTasks = json.optJSONArray("active_tasks")?.let { array ->
                buildList {
                    for (index in 0 until array.length()) {
                        val item = array.optJSONObject(index) ?: continue
                        val id = item.stringOrNull("session_id") ?: continue
                        val startedAt = item.stringOrNull("started_at") ?: continue
                        val elapsedMs = item.durationOrNull("elapsed_ms") ?: continue
                        if (wireTimestampMillis(startedAt) == null) continue
                        add(ActiveTask(id, item.stringOrNull("task_id"), startedAt, elapsedMs))
                    }
                }
            },
            approvals = json.optJSONArray("approvals")?.let { array ->
                val records = buildList {
                    for (index in 0 until array.length()) {
                        val item = array.optJSONObject(index) ?: continue
                        val metadata = approvalMetadataFromJson(item) ?: continue
                        val id = item.stringOrNull("session_id")?.takeUnless { it == "unknown" } ?: continue
                        val sequence = item.safeIntegerOrNull("sequence") ?: continue
                        val requestedAt = item.stringOrNull("requested_at")?.takeIf { wireTimestampMillis(it) != null } ?: continue
                        val resolvedAt = item.stringOrNull("resolved_at")
                        if (resolvedAt != null && wireTimestampMillis(resolvedAt) == null) continue
                        add(ApprovalSummary(metadata.requestId, id, item.stringOrNull("task_id"),
                            item.optString("display_name").ifBlank { fallbackSessionTitle(id) }, sequence,
                            requestedAt, metadata.status, metadata.canRespond, metadata.toolName, metadata.expiresAt, resolvedAt, metadata.source))
                    }
                }
                // Ambiguous identities never expose an approval action.
                records.groupBy { it.requestId }.values.mapNotNull { it.singleOrNull() }
            },
        )

        private fun approvalMetadataFromJson(json: JSONObject): ApprovalEventMetadata? {
            val source = ApprovalSource.entries.firstOrNull { it.wireValue == json.optString("source") } ?: return null
            val requestId = json.uuidOrNull("request_id") ?: return null
            val status = ApprovalStatus.entries.firstOrNull { it.wireValue == json.optString("status") } ?: return null
            val canRespond = json.opt("can_respond") as? Boolean ?: return null
            if (canRespond && status != ApprovalStatus.PENDING) return null
            if (source == ApprovalSource.CODEX && (canRespond || status in setOf(ApprovalStatus.APPROVED, ApprovalStatus.DENIED))) return null
            if (source == ApprovalSource.CLAUDE_CODE && status == ApprovalStatus.RESOLVED) return null
            val expiresAt = json.stringOrNull("expires_at")
            if (expiresAt != null && wireTimestampMillis(expiresAt) == null) return null
            return ApprovalEventMetadata(requestId, status, canRespond,
                json.stringOrNull("tool_name")?.takeIf { it.length <= 128 }, expiresAt, source)
        }

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
                    session.sessionKind?.let { put("session_kind", it.wireValue) }
                    put("title", session.title)
                    put("claude_state", session.claudeState.wireValue)
                    put("last_activity_sequence", session.lastActivitySequence)
                    session.waitingReason?.takeIf { session.claudeState == ClaudeState.WAITING }?.let { put("waiting_reason", it) }
                })
            }
        })
    }
    mainRunningCount?.let { put("main_running_count", it) }
    mainSessionCount?.let { put("main_session_count", it) }
    totalRunningCount?.let { put("total_running_count", it) }
    runningCount?.let { put("running_count", it) }
    sessionCount?.let { put("session_count", it) }
    recentCompletion?.let { completion ->
        put("recent_completion", JSONObject().apply {
            put("session_id", completion.sessionId)
            completion.taskId?.let { put("task_id", it) }
            put("sequence", completion.sequence)
            put("occurred_at", completion.occurredAt)
            put("display_name", completion.displayName)
            completion.durationMs?.let { put("duration_ms", it) }
        })
    }
    usage?.let { aggregate ->
        put("usage", aggregate.toJson())
    }
    activeTasks?.let { tasks ->
        put("active_tasks", org.json.JSONArray().apply {
            tasks.forEach { task ->
                put(JSONObject().apply {
                    put("session_id", task.sessionId)
                    task.taskId?.let { put("task_id", it) }
                    put("started_at", task.startedAt)
                    put("elapsed_ms", task.elapsedMs)
                })
            }
        })
    }
    approvals?.let { requests ->
        put("approvals", org.json.JSONArray().apply {
            requests.forEach { request -> put(JSONObject().apply {
                put("request_id", request.requestId)
                put("session_id", request.sessionId)
                request.taskId?.let { put("task_id", it) }
                put("display_name", request.displayName)
                put("sequence", request.sequence)
                put("requested_at", request.requestedAt)
                request.resolvedAt?.let { put("resolved_at", it) }
                put("source", request.source.wireValue)
                put("status", request.status.wireValue)
                put("can_respond", request.canRespond)
                request.toolName?.let { put("tool_name", it) }
                request.expiresAt?.let { put("expires_at", it) }
            }) }
        })
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
internal const val MAX_TASK_DURATION_MS = 86_400_000L
private val WAITING_REASONS = setOf("permission", "question", "approval", "input", "unknown")
internal val USER_ACTION_WAITING_REASONS = setOf("permission", "question", "approval", "input")
private val WIRE_TIMESTAMP = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$")

internal fun wireTimestampMillis(value: String): Long? =
    if (!WIRE_TIMESTAMP.matches(value)) null else runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()

internal fun Long?.validTaskDuration(): Long? = this?.takeIf { it in 0..MAX_TASK_DURATION_MS }

private fun JSONObject.durationOrNull(key: String): Long? = safeIntegerOrNull(key).validTaskDuration()

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

private val APPROVAL_UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
private fun JSONObject.uuidOrNull(key: String): String? = stringOrNull(key)?.takeIf { APPROVAL_UUID.matches(it) }

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

    data class DecideApproval(
        val installationId: String,
        val requestId: String,
        val decisionId: String,
        val decision: ApprovalDecision,
    ) : MonitorCommand {
        override fun toWireJson(): String = JSONObject().apply {
            put("type", "approval_decision")
            put("schema_version", 1)
            put("installation_id", installationId)
            put("request_id", requestId)
            put("decision_id", decisionId)
            put("decision", decision.wireValue)
        }.toString()
    }
}

fun MonitorEventName.toPetState(): PetState = when (this) {
    MonitorEventName.WAITING, MonitorEventName.APPROVAL_REQUESTED -> PetState.WAITING
    MonitorEventName.TASK_FINISHED -> PetState.FINISH
    MonitorEventName.TASK_FAILED,
    MonitorEventName.TOOL_FAILED -> PetState.ERROR
    MonitorEventName.TASK_STARTED,
    MonitorEventName.TOOL_STARTED,
    MonitorEventName.TOOL_FINISHED -> PetState.WORKING
    MonitorEventName.SESSION_STARTED,
    MonitorEventName.SESSION_TITLE_UPDATED,
    MonitorEventName.SESSION_CLASSIFICATION_UPDATED,
    MonitorEventName.SESSION_ENDED,
    MonitorEventName.APPROVAL_RESOLVED,
    MonitorEventName.UNKNOWN -> PetState.IDLE
}

fun String?.toActivityVariation(): ActivityVariation = when (this?.lowercase(Locale.US)) {
    "think", "thinking", "session_started", "task_started" -> ActivityVariation.THINK
    "tool", "working", "tool_started", "tool_finished" -> ActivityVariation.TOOL
    "wait", "waiting", "approval_requested" -> ActivityVariation.WAIT
    "celebrate", "finish", "finished", "task_finished" -> ActivityVariation.CELEBRATE
    "alert", "error", "failed", "task_failed", "tool_failed" -> ActivityVariation.ALERT
    else -> ActivityVariation.BREATH
}

private fun JSONObject.sessionKindOrNull(): SessionKind? =
    SessionKind.entries.firstOrNull { it.wireValue == stringOrNull("session_kind") }
