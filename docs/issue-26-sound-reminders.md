# Issue #26: Android sound reminders

The Android monitor plays one short, soft notification sound for each newly observed pending approval and for a `task_finished` result whose trusted duration is at least 300,000 ms. Completion duration is taken from the event, a matching Relay `recent_completion`, or the previously observed active-task timing. Unknown duration stays eligible for a later matching snapshot; a known short duration is consumed silently. This audio threshold is inclusive and does not change the existing visual reminder threshold or timing.

Cue decisions run only after the monitor accepts an event. They do not depend on Compose redraws, current page, or whether an approval reminder hides the status page. Completion identity is installation + session + sequence; approval identity is installation + source + request ID. The exact identities are SHA-256 hashed before they are stored in app-private preferences. The hash set is retained for the paired installation lifetime without eviction, so an old replay cannot become audible again; task names and raw session/request IDs are not stored. A fresh, previously unseen pending approval in an initial snapshot is audible once, including queued requests.

Playback uses a preloaded sub-second `SoundPool` sample with notification-event audio attributes. Every cue checks normal ringer mode, nonzero notification-stream volume, and `INTERRUPTION_FILTER_ALL`; silent, vibrate, zero-volume, and active Do Not Disturb states consume the cue without changing system settings or retrying after unmute. Audio and storage failures fail silently. The cue queue spaces sounds to avoid overlap and is released with the ViewModel. Sounds are produced by foreground WebSocket events and snapshots; this change does not add background push delivery.

JVM event tests exercise threshold boundaries, event/snapshot replay, queued Claude and Codex approvals, unknown-duration recovery, subagent suppression, and ViewModel recreation with a shared ledger. Device playback and subjective sound level require a separate handset check.

## Validation (2026-10-08)

Command: `./gradlew --no-daemon :apps:android:lintDebug :apps:android:testDebugUnitTest :apps:android:assembleDebug`

The full Gradle command completed with `BUILD SUCCESSFUL`. The Android JVM suite reported 191 tests: 190 passed, 0 failed, and 1 expected real-Codex recording test skipped because `CODEX_LIVE_WIRE_PATH` was not provided. `lintDebug` reported 0 errors and 20 warnings, matching the pre-change baseline count and categories. `assembleDebug` succeeded. The generated WAV is 440 ms, mono PCM16 at 22,050 Hz, with no clipping. Actual playback on a handset, perceived loudness, and behavior while changing ringer, notification-volume, and Do Not Disturb settings have not yet been checked on-device.
