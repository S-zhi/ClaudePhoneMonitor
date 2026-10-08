# Issue #27: durable DONE presentation

Successful completed tasks display green uppercase `DONE` on the completion page, pet status, and session rows. The Android internal `PetState.FINISH` enum remains for existing animation and reminder logic; its visible title and short label are `DONE`.

Relay snapshots expose optional `sessions[].task_completed: boolean`. Relay emits `true` only for a retained successful terminal task whose raw `claude_state` is `idle`; never-used and failed sessions emit `false`. A new session/task clears the prior result, and the next successful completion sets it again. This flag is derived from already persisted session state, so SQLite needs no migration. Each session retains its own result independently.

`recent_completion` still expires after five seconds. It restores a fresh completion reminder, while `task_completed` restores status after heartbeat, reconnect, or application restart without replaying an old reminder. Android keeps a confirmed local result after its reminder expires or transport disconnects. With older Relay versions, a matching local completion can override only session activity at or before its completion sequence; newer work/waiting/idle activity clears that fallback. Title metadata changes preserve completion identity.

Working tasks keep aggregate priority, followed by transport freshness. When online with no main work, the newest main session determines `WAITING`, `DONE`, or `IDLE`; historical completed sessions never override a newer unused session. Subagents and unknown session IDs cannot establish the main task's completion.

Regression coverage includes protocol boolean validation, multiple completed rows, reminder expiration, aggregate precedence, task restart/failure, unknown sessions, snapshot/reconnect, and SQLite reopening. Device test fixtures also assert the uppercase DONE accessibility labels and persistent status after real reminder timers expire.

## Validation — 2026-10-08

Validated locally with Node.js 24.13.0, JDK 21, and Android SDK 35:

- `npm test`: all 217 Node tests and 34 Python tests passed, including helper/CI checks and the live isolated HTTP/WebSocket Relay smoke test.
- `npm run typecheck` and `npm run lint`: passed.
- `./gradlew --offline --no-daemon :apps:android:testDebugUnitTest :apps:android:lintDebug :apps:android:assembleDebug :apps:android:assembleDebugAndroidTest`: passed. Android reports 194 tests, 193 passed and one expected live-recording test skipped; lint reports zero errors and nine warnings.

Debug and instrumentation APKs were built. Physical-device acceptance is recorded in [the device report](device-testing/issue27-2026-10-08.md). All 15 isolated device cases obtained a passing result, including one targeted rerun after a lost Compose test window. Completion-title refinements stay bound to the active reminder's task identity even when a suppressed result updates the latest durable DONE record.

For isolated USB device acceptance, build with `./gradlew -PdeviceTestApplicationIdSuffix=.issue27test :apps:android:assembleDebug :apps:android:assembleDebugAndroidTest`. This changes only the opted-in debug application ID to `com.example.claudephonemonitor.issue27test`; the instrumentation package is `com.example.claudephonemonitor.issue27test.test`. Run `DoneRelayDeviceTest` with `deviceRelayUrl=http://127.0.0.1:18887` and the isolated `tests/device-done-relay.mjs` fixture. The default application ID and namespace remain unchanged.

## Publication baseline

Before opening the PR, the two implementation commits were rebased cleanly onto `main` at `92f1928` (the merged Usage update, PR #29). The combined tree passed typecheck, ESLint, all 228 Node tests and 34 Python tests, and Android lint/build. Android reports 205 JVM tests, 204 passed and one expected live-recording skip. The physical-device screenshots and results above were recorded before this rebase; physical tests were not rerun after integrating the Usage update.
