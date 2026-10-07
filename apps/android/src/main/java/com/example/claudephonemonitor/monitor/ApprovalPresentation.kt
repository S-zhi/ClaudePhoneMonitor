package com.example.claudephonemonitor.monitor

/** Local first display owns the pending deadline; the first handled result gets fifteen seconds. */
internal data class ApprovalPresentationState(
    val requests: Map<String, ApprovalSummary> = emptyMap(),
    val displayedRequestIds: Set<String> = emptySet(),
    val active: ApprovalSummary? = null,
    val deadlineMs: Long? = null,
    val pendingDecisions: Map<String, PendingApprovalDecision> = emptyMap(),
    val uncertainDecisions: Set<String> = emptySet(),
    val decisionErrors: Set<String> = emptySet(),
)

internal data class PendingApprovalDecision(val decisionId: String, val decision: ApprovalDecision)

data class ApprovalReminderUi(
    val request: ApprovalSummary,
    val remainingMs: Long,
    val decisionPending: Boolean = false,
    val decisionFailed: Boolean = false,
    val decisionUncertain: Boolean = false,
)

internal object ApprovalPresentationReducer {
    const val DISPLAY_DURATION_MS = 300_000L
    const val RESULT_DISPLAY_DURATION_MS = 15_000L

    fun reduce(state: ApprovalPresentationState, event: MonitorEvent, nowMs: Long): ApprovalPresentationState {
        var current = expire(state, nowMs, activateNext = false)
        val records = current.requests.toMutableMap()
        event.snapshot?.approvals?.let { approvals ->
            // A current snapshot is authoritative for the normal view. The pinned copy
            // survives pruning or omission until its current local deadline.
            records.clear()
            approvals.forEach { incoming ->
                val previous = current.requests[incoming.requestId] ?: current.active?.takeIf { it.requestId == incoming.requestId }
                merge(previous, incoming, allowCodexRecovery = true)?.let { records[it.requestId] = it }
            }
        }
        val metadata = event.approval
        if (event.type == MonitorEventType.EVENT && metadata != null && event.sessionId != null) {
            val previous = records[metadata.requestId] ?: current.active?.takeIf { it.requestId == metadata.requestId }
            if (event.name == MonitorEventName.APPROVAL_REQUESTED && metadata.status == ApprovalStatus.PENDING && event.sequence != null) {
                val snapshotRequest = event.snapshot?.approvals?.firstOrNull { it.requestId == metadata.requestId }
                val incoming = snapshotRequest ?: ApprovalSummary(metadata.requestId, event.sessionId, event.taskId,
                    event.snapshot?.approvals?.firstOrNull { it.requestId == metadata.requestId }?.displayName
                        ?: event.snapshot?.sessions?.firstOrNull { it.sessionId == event.sessionId }?.title
                        ?: event.sessionTitle?.takeIf { it.isNotBlank() } ?: fallbackSessionTitle(event.sessionId),
                    // Only a Relay snapshot backed by live ownership enables decisions.
                    event.sequence, event.occurredAt, metadata.status, false, metadata.toolName, metadata.expiresAt,
                    source = metadata.source)
                if (event.snapshot?.approvals == null || snapshotRequest != null) {
                    merge(previous, incoming, allowCodexRecovery = snapshotRequest != null)?.let { records[it.requestId] = it }
                }
            } else if (event.name == MonitorEventName.APPROVAL_RESOLVED && previous != null &&
                metadata.status != ApprovalStatus.PENDING && previous.source == metadata.source && previous.sessionId == event.sessionId &&
                (event.taskId == null || previous.taskId == null || previous.taskId == event.taskId) &&
                (event.sequence == null || event.sequence >= previous.sequence)
            ) {
                // Results alone never create a new strong reminder or queue entry.
                merge(previous, previous.copy(status = metadata.status, canRespond = false))?.let { records[it.requestId] = it }
            }
        }
        if (event.type == MonitorEventType.DISCONNECTED) {
            // Losing the transport does not prove a native decision. Disable remote
            // actions immediately; a fresh Relay snapshot proves availability again.
            records.replaceAll { _, request -> request.copy(canRespond = false) }
            current = current.copy(uncertainDecisions = current.uncertainDecisions + current.pendingDecisions.keys)
        }
        val active = current.active?.let { pinned ->
            records[pinned.requestId]?.takeIf { it.sessionId == pinned.sessionId }
                ?: if (event.snapshot?.approvals != null) pinned.copy(canRespond = false) else pinned
        }?.let { if (event.type == MonitorEventType.DISCONNECTED) it.copy(canRespond = false) else it }
        val pendingDecisions = current.pendingDecisions.filterKeys { records[it]?.let { request -> request.isPending } != false }
        // Durable handled states cannot revert to pending, so this transition
        // happens once for the visible request. Results received after expiry or
        // while queued never open a page. A late result still gets all fifteen seconds.
        val deadline = if (active?.isHandled == true && current.active?.isHandled == false) {
            nowMs + RESULT_DISPLAY_DURATION_MS
        } else current.deadlineMs
        current = current.copy(requests = records, active = active, deadlineMs = deadline, pendingDecisions = pendingDecisions,
            uncertainDecisions = current.uncertainDecisions.intersect(pendingDecisions.keys),
            decisionErrors = current.decisionErrors.filterTo(linkedSetOf()) { records[it]?.isPending == true })
        return startNext(current, nowMs)
    }

    private fun merge(previous: ApprovalSummary?, incoming: ApprovalSummary, allowCodexRecovery: Boolean = false): ApprovalSummary? {
        if (previous == null) return incoming
        if (previous.source != incoming.source || previous.sessionId != incoming.sessionId ||
            (previous.taskId != null && incoming.taskId != null && previous.taskId != incoming.taskId)) return null
        // Durable terminal results cannot be turned back into actionable requests by replay.
        val codexAuthorityRestored = allowCodexRecovery && previous.source == ApprovalSource.CODEX &&
            previous.status == ApprovalStatus.UNKNOWN && incoming.isPending
        if (!previous.isPending && incoming.isPending && !codexAuthorityRestored) return previous
        if (previous.status in setOf(ApprovalStatus.APPROVED, ApprovalStatus.DENIED, ApprovalStatus.RESOLVED)) {
            return previous.copy(displayName = incoming.displayName)
        }
        return incoming.copy(sequence = previous.sequence, requestedAt = previous.requestedAt,
            taskId = previous.taskId ?: incoming.taskId)
    }

    fun expire(state: ApprovalPresentationState, nowMs: Long, activateNext: Boolean = true): ApprovalPresentationState {
        val expired = state.deadlineMs?.let { nowMs >= it } == true
        val current = if (expired) state.copy(active = null, deadlineMs = null) else state
        return if (activateNext) startNext(current, nowMs) else current
    }

    private fun startNext(state: ApprovalPresentationState, nowMs: Long): ApprovalPresentationState {
        if (state.active != null) return state
        val next = state.requests.values.filter { it.isPending && it.requestId !in state.displayedRequestIds }
            .minWithOrNull(compareBy<ApprovalSummary> { it.sequence }.thenBy { it.requestId }) ?: return state
        return state.copy(active = next, deadlineMs = nowMs + DISPLAY_DURATION_MS,
            displayedRequestIds = state.displayedRequestIds + next.requestId)
    }

    fun reminder(state: ApprovalPresentationState, nowMs: Long): ApprovalReminderUi? {
        val current = expire(state, nowMs, activateNext = false)
        val request = current.active ?: return null
        val remainingMs = (current.deadlineMs ?: return null) - nowMs
        return if (remainingMs > 0L) ApprovalReminderUi(request, remainingMs,
            request.requestId in current.pendingDecisions && request.requestId !in current.uncertainDecisions,
            request.requestId in current.decisionErrors, request.requestId in current.uncertainDecisions) else null
    }

    fun acknowledge(state: ApprovalPresentationState, ack: ApprovalDecisionAck): ApprovalPresentationState {
        if (state.pendingDecisions[ack.requestId]?.decisionId != ack.decisionId) return state
        // Forwarded is deliberately kept busy until the Hook delivery result arrives.
        if (ack.accepted) return state.copy(uncertainDecisions = state.uncertainDecisions - ack.requestId)
        return state.copy(uncertainDecisions = state.uncertainDecisions + ack.requestId,
            decisionErrors = state.decisionErrors + ack.requestId)
    }
}
