# Issue 28: Codex quota and scoped cache usage

Usage snapshots keep the existing response-token ledger and add Codex quota from the read-only `codex app-server` JSON-RPC flow (`initialize`, `initialized`, `account/rateLimits/read`). The collector does not open a thread or submit a model request. It uses only the explicitly labeled `codex` rate-limit bucket, prefers its primary window, and uses the secondary window only when a valid primary window is unavailable. A bucket with an invalid Codex entry never falls back to another provider or account bucket.

Issue 28 requires the updated Relay and Collector to run together. The Relay advertises `codex_quota_v1` and `usage_scoped_cache_v1`; the LAN launcher rejects older Relay processes before pairing. Upgrade or stop the old Relay explicitly, then restart both services with the updated launcher. Updating only the Android app does not add server-side support.

The quota wire object retains `start_remaining`, `current_remaining`, `unit`, `reset_at`, and `availability`. Available samples use percentage points (`unit: "percent"`) and add `limit_id: "codex"`, `source: "codex_app_server"`, `window_minutes`, `sampled_at`, and `window: "primary" | "secondary"`. A startup sample also adds `start_sampled_at` and `start_reset_at`. `accountId` is hashed only in collector memory for continuity checks and never enters the wire. A changed account/window/reset keeps the original start timestamps but clears `start_remaining`; it does not silently establish a new baseline. If the startup quota read fails, later samples report current quota with a null start and never claim a later reading was the startup value. Failed reads retain the last values with `availability: "stale"`; before the first valid read quota remains unavailable.

Cache-hit summaries can carry `providers: ["claude"]`, `["codex"]`, or both when a partial aggregate has complete, conflict-free response samples for those providers. The numerator and denominator use that same provider scope, and `sample_responses` states how many rows contributed. A row with missing fields, an impossible cache total, or an unsafe sum is excluded by itself; other valid rows remain available as a partial scoped ratio. This is a ratio over the reported sample subset, not an estimate of all observed usage. If no valid sample contributes a positive denominator, the ratio is unavailable. Complete ratios still require full provider coverage and every observed response to contribute; legacy unscoped partial ratios remain readable.

The Codex transcript ledger continues to deduplicate `token_usage_record` using the hashed `thread_id` and `response_id` identity. It does not add `token_count.last_token_usage`, because that is a repeated rolling total and would double count records. The persisted usage epoch and token ledger survive collector restarts, while the quota comparison baseline is sampled afresh for each watcher start.

For a live read-only check, run `node --import ./services/collector/node_modules/tsx/dist/loader.mjs tests/usage-live-readonly.mjs` for one aggregate snapshot, or add `--duration-ms 45000` to poll the same temporary ledger copy every five seconds. Add `--relay-port 18880` to start an isolated Relay and Collector and write the full Relay snapshot received over their real WebSocket link; combine it with `--duration-ms 65000` to observe ongoing updates. An optional output path can precede the options. Each validated result atomically replaces `/private/tmp/issue28-live-snapshot.json` by default, and stdout contains only start/end totals. The probe opens the saved usage database read-only, writes to temporary Relay/Collector state, never connects to the running Relay, and removes temporary state when finished.

Validation completed: all 222 Node tests, 21 shell/Python helper tests, and 13 GitHub Python tests pass; lint, typecheck, shell, and workflow checks pass. Android has 193 tests total (192 passed and one optional live test skipped), Android lint has no errors, and the APK builds. The real Collector → temporary production Relay → Android production WebSocket client and `MonitorViewModel` path passed both 30-second and 90-second runs using a read-only copy of the usage ledger and live Codex quota. Observed totals increased during the runs, and the displayed cache numerator/denominator matched the received aggregate. No private usage values, account identifiers, or screenshots are stored in this repository.

The final four-case device layout suite passed in 4.22 seconds, covering real-aggregate large-text glyph rendering, 320 dp short layout, quota-window presentation, and full-screen layout. All five Clawd device tests passed in 47.7 seconds: the 251-frame, eight-second animation cycle endpoints matched; weak notifications leave the Usage animation active; a strong finish signal transitions away; typing is driven by the hands while the laptop stays still; and lifecycle pause, mute, offline state, or leaving the page stops animation.

The animation performance run used the same DBR-W00 device, API 31, debug APK, and production WebSocket path for 90 seconds. After 48 seconds of warmup, two 12.13-second windows were measured. The final `graphicsLayer` implementation had 6 janky frames in each window, compared with 58 and 44 in the draw-only/no-layer windows. CPU values below are one-core-equivalent utilization calculated from `utime + stime` deltas at 100 ticks per second; they are not whole-device CPU percentages. The first unoptimized cold 12-second capture (47.21% jank, 23 ms P95) is retained as a diagnostic observation only; it is not included as a warm-window comparison.

| Rendering path | Window | Janky frames | Frame P95 / P90 | Average CPU / main / RenderThread | GPU P95 | PSS during window |
| --- | --- | ---: | --- | --- | --- | --- |
| Draw-only, no layer | 1 | 58/385 (15.06%) | 19 ms / 18 ms | 55.21% / 32.63% / 18.54% | 3 ms | 177,870 → 173,648 KiB (173.7 → 169.6 MiB) |
| Draw-only, no layer | 2 | 44/383 (11.49%) | 19 ms / 18 ms | 53.06% / 30.94% / 18.73% | 3 ms | 172,684 → 175,112 KiB (168.6 → 171.0 MiB) |
| Isolated `graphicsLayer` | 1 | 6/382 (1.57%) | 15 ms / 14 ms | 40.36% / 21.50% / 15.32% | 3 ms | 172,843 → 176,246 KiB (168.8 → 172.1 MiB) |
| Isolated `graphicsLayer` | 2 | 6/384 (1.56%) | 16 ms / 15 ms | 42.37% / 22.50% / 17.72% | 3 ms | 175,802 → 175,306 KiB (171.7 → 171.2 MiB) |

These are independent warmed windows, not a cold-to-warm A/B comparison. The clock is observed only in the draw phase, while the Canvas owns an independent `graphicsLayer` invalidation path; the measurements show reduced main-thread work. See Android's [Compose graphics modifiers documentation](https://developer.android.com/develop/ui/compose/graphics/draw/modifiers) for the layer behavior. The 32 ms animation sampling interval is the intended design rate (about 31 updates per second), not evidence of dropping half of a 60 Hz stream. The four PSS windows do not establish long-term leak behavior. Physical power use was not validated: the device remained AC-powered at 100%, so this run cannot support a battery-life or power-saving conclusion.

To reproduce the live Collector → Relay → Android path, start the temporary Relay/Collector probe in one terminal, then run device instrumentation in a second terminal while it is active. The probe writes redacted full snapshots atomically to `/private/tmp/issue28-live-snapshot.json`; both processes use temporary state and a read-only usage-ledger copy.

Terminal A:

```bash
adb reverse tcp:18880 tcp:18880
node --import ./services/collector/node_modules/tsx/dist/loader.mjs tests/usage-live-readonly.mjs --duration-ms 120000 --relay-port 18880
```

Terminal B:

```bash
adb shell am instrument -w \
  -e deviceRelayUrl http://127.0.0.1:18880 \
  -e performanceDurationMs 90000 \
  com.example.claudephonemonitor.test/androidx.test.runner.AndroidJUnitRunner
adb reverse --remove tcp:18880
```

`UsagePerformanceDeviceTest` defaults to a 30-second runtime; set `performanceDurationMs` to `90000` for a 90-second run. The instrumentation run above uses the production WebSocket client and `MonitorViewModel`. Physical power use remains unmeasured because the device was AC-powered at 100%.
