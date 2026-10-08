package com.example.claudephonemonitor.monitor

enum class ReminderCue { LONG_TASK_COMPLETED, APPROVAL_PENDING }

/** Audio is an event side effect; presentation redraws never call this interface. */
interface ReminderCuePlayer : AutoCloseable {
    fun play(cue: ReminderCue)
    fun cancelPending() = Unit
    override fun close() = Unit
}

object NoOpReminderCuePlayer : ReminderCuePlayer {
    override fun play(cue: ReminderCue) = Unit
}

/** Used when durable storage is unavailable; suppress cues to prevent replay after recreation. */
object SilentReminderCueLedger : ReminderCueLedger {
    override fun consumeIfNew(identity: String): Boolean = false
}

/** Returns true only for the first consumption of an identity. Implementations persist hashes. */
interface ReminderCueLedger {
    fun consumeIfNew(identity: String): Boolean
}

class InMemoryReminderCueLedger : ReminderCueLedger {
    private val consumed = mutableSetOf<String>()

    @Synchronized
    override fun consumeIfNew(identity: String): Boolean = consumed.add(identity)
}
