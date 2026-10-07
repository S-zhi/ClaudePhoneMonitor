package com.example.claudephonemonitor.monitor

import java.security.MessageDigest

/** The visual result is local presentation state; the wire session state stays unchanged. */
enum class SessionDisplayState(val label: String) {
    IDLE("Idle"),
    WORKING("Working"),
    WAITING("Waiting"),
    DONE("Done"),
}

fun MonitorSnapshot.sortedTopSessions(): List<SessionSummary> =
    sessions.orEmpty().filter { it.sessionKind != SessionKind.SUBAGENT }.sortedWith(
        compareByDescending<SessionSummary> { it.lastActivitySequence }.thenBy { it.sessionId },
    ).take(5)

fun SessionSummary.displayState(completion: RecentCompletion?): SessionDisplayState = when {
    completion?.sessionId == sessionId &&
        (lastActivitySequence <= completion.sequence || claudeState == ClaudeState.IDLE) -> SessionDisplayState.DONE
    claudeState == ClaudeState.WORKING -> SessionDisplayState.WORKING
    claudeState == ClaudeState.WAITING -> SessionDisplayState.WAITING
    else -> SessionDisplayState.IDLE
}

private val codexSessionId = Regex("^codex:sess:([0-9a-f]{64})$")

internal fun fallbackSessionTitle(sessionId: String): String {
    codexSessionId.matchEntire(sessionId)?.groupValues?.get(1)?.let { return "Codex ${it.takeLast(6)}" }
    val suffix = MessageDigest.getInstance("SHA-256").digest(sessionId.toByteArray(Charsets.UTF_8))
        .takeLast(3).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    return "会话 $suffix"
}

/** Stop hooks may omit task_id; only the matching authoritative result may fill it in. */
internal fun RecentCompletion.matchesCompletion(other: RecentCompletion?): Boolean =
    other != null && sessionId == other.sessionId && sequence == other.sequence &&
        (taskId == null || other.taskId == null || taskId == other.taskId)

internal fun MonitorSnapshot.aggregatePetState(): PetState = when {
    computerState == ComputerState.OFFLINE -> PetState.OFFLINE
    mainRunningCount?.let { it > 0 } == true -> PetState.WORKING
    mainRunningCount == null && sessions?.any { it.sessionKind != SessionKind.SUBAGENT && it.claudeState == ClaudeState.WORKING } == true -> PetState.WORKING
    mainRunningCount == null && sessions?.any { it.sessionKind == SessionKind.SUBAGENT } != true &&
        runningCount?.let { it > 0 } == true -> PetState.WORKING
    mainRunningCount == null && sessions == null && runningCount == null && claudeState == ClaudeState.WORKING -> PetState.WORKING
    computerState == ComputerState.STALE -> PetState.WAITING
    sessions != null -> when (sortedTopSessions().firstOrNull()?.claudeState) {
        ClaudeState.WORKING -> if (mainRunningCount == 0) PetState.IDLE else PetState.WORKING
        ClaudeState.WAITING -> PetState.WAITING
        else -> PetState.IDLE
    }
    claudeState == ClaudeState.WAITING -> PetState.WAITING
    else -> PetState.IDLE
}
