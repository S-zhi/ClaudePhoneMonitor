package com.example.claudephonemonitor.monitor

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import android.app.NotificationManager
import android.os.Handler
import android.os.Looper
import com.example.claudephonemonitor.R
import java.security.MessageDigest
import java.util.ArrayDeque

/** Persists only SHA-256 identities, never session names, task IDs, or request IDs. */
class AndroidReminderCueLedger(context: Context) : ReminderCueLedger {
    private val preferences = context.applicationContext.getSharedPreferences("reminder_cue_ledger", Context.MODE_PRIVATE)
    private var consumedCache: MutableSet<String>? = null

    @Synchronized
    override fun consumeIfNew(identity: String): Boolean {
        val hash = sha256(identity)
        val local = consumedCache ?: runCatching {
            preferences.getStringSet(KEY_CONSUMED, emptySet()).orEmpty().toMutableSet()
        }.getOrDefault(mutableSetOf()).also { consumedCache = it }
        if (hash in local) return false
        synchronized(PERSIST_LOCK) {
            // Merge the latest preferences value under a process-wide lock so separate ledger
            // instances cannot overwrite one another's new identities.
            val consumed = runCatching {
                preferences.getStringSet(KEY_CONSUMED, emptySet()).orEmpty().toMutableSet()
            }.getOrDefault(local.toMutableSet())
            consumedCache = consumed
            if (!consumed.add(hash)) return false
            consumedCache = consumed
            // Keep the exact identity set for the installation lifetime so old snapshots can
            // never replay a cue. Entries reveal no source identifiers and remain small hashes.
            val stored = runCatching {
                preferences.edit().putStringSet(KEY_CONSUMED, consumed.toSet()).commit()
            }.getOrDefault(false)
            // Fail silent on storage failure and suppress repeats for this process lifetime.
            return stored
        }
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private companion object {
        const val KEY_CONSUMED = "consumed_sha256"
        val PERSIST_LOCK = Any()
    }
}

/** Short notification sound with a serialized queue and a fresh silence/DND check per cue. */
class AndroidReminderCuePlayer internal constructor(
    context: Context,
    private val onNativePlayback: (ReminderCue, Int) -> Unit = { _, _ -> },
) : ReminderCuePlayer {
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val notificationManager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val handler = Handler(Looper.getMainLooper())
    private val queue = ArrayDeque<ReminderCue>()
    private var loaded = false
    private var closed = false
    private var generation = 0
    private var soundId = 0
    private var nextCue: Runnable? = null
    private val pool = SoundPool.Builder()
        .setMaxStreams(8)
        .setAudioAttributes(AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build())
        .build()

    init {
        pool.setOnLoadCompleteListener { _, sampleId, status ->
            handler.post {
                if (sampleId == soundId && status == 0 && !closed) {
                    loaded = true
                    pump()
                }
            }
        }
        try {
            soundId = pool.load(appContext, R.raw.soft_reminder, 1)
        } catch (_: RuntimeException) {
            loaded = false
        }
    }

    override fun play(cue: ReminderCue) {
        if (closed || !isPlaybackAllowed()) return
        val expectedGeneration = generation
        handler.post {
            if (closed || expectedGeneration != generation || !isPlaybackAllowed()) return@post
            queue.addLast(cue)
            pump()
        }
    }

    override fun cancelPending() {
        generation += 1
        queue.clear()
        nextCue?.let(handler::removeCallbacks)
        nextCue = null
    }

    private fun pump() {
        if (closed || !loaded || queue.isEmpty() || nextCue != null) return
        val expectedGeneration = generation
        val runnable = Runnable {
            nextCue = null
            if (closed || expectedGeneration != generation) return@Runnable
            val cue = queue.pollFirst() ?: return@Runnable
            if (isPlaybackAllowed()) {
                try {
                    val nativeStreamId = pool.play(soundId, 0.45f, 0.45f, 1, 0, 1f)
                    if (nativeStreamId != 0) runCatching { onNativePlayback(cue, nativeStreamId) }
                } catch (_: RuntimeException) { }
            }
            // Keep a cooldown even when the queue is empty so a newly arriving cue cannot
            // overlap the tail of this short WAV.
            nextCue = Runnable {
                nextCue = null
                pump()
            }.also { handler.postDelayed(it, CUE_SPACING_MS) }
        }
        nextCue = runnable
        handler.post(runnable)
    }

    private fun isPlaybackAllowed(): Boolean = try {
        audioManager.ringerMode == AudioManager.RINGER_MODE_NORMAL &&
            audioManager.getStreamVolume(AudioManager.STREAM_NOTIFICATION) > 0 &&
            notificationManager.currentInterruptionFilter == NotificationManager.INTERRUPTION_FILTER_ALL
    } catch (_: RuntimeException) {
        false
    }

    override fun close() {
        if (closed) return
        closed = true
        cancelPending()
        try { pool.release() } catch (_: RuntimeException) { }
    }

    private companion object { const val CUE_SPACING_MS = 520L }
}
