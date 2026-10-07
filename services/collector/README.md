# macOS Collector

The collector is a small Node.js daemon that keeps Claude Code Hook delivery local and fail-open in the default telemetry mode. The explicitly enabled [optional approval bridge](../../docs/issue-23-approval-reminder.md) instead holds `PermissionRequest` for up to ten minutes while awaiting a paired-phone decision or a return to the native computer flow. It can also opt into a read-only Codex sessions watcher that sends only allowlisted lifecycle metadata through the same Collector and Relay.

## Build and test

Use Node.js 24.13.0 (pinned in `.node-version`); see [CI and local reproduction](../../docs/ci.md) for the full environment. From the repository root:

```bash
npm ci --prefix services/collector
npm --prefix services/collector run typecheck
npm --prefix services/collector run build
npm --prefix services/collector test
```

## Hook adapter smoke test

The adapter reads one JSON Hook event from stdin and sends it to a local Unix socket. It never calls the remote Relay directly and exits successfully when the collector/socket is unavailable.

```bash
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"demo-session"}' | node services/collector/dist/cli.js --event --socket /tmp/claude-phone-monitor-missing.sock
```

## Run the daemon

```bash
COLLECTOR_RELAY_URL=ws://127.0.0.1:8787/ws/collector \
COLLECTOR_DATA_DIR="$HOME/.claude-phone-monitor" \
npm --prefix services/collector run start -- --collector --watch-codex --watch-usage
```

Codex watching is opt-in. Use `COLLECTOR_WATCH_CODEX=1` instead of the CLI flag
when launching the daemon from another supervisor; `--no-watch-codex` overrides
that environment setting. The watcher reads `$CODEX_HOME/sessions`, or
`~/.codex/sessions` when `CODEX_HOME` is unset. Set
`COLLECTOR_CODEX_SESSIONS_DIR` to use another local sessions directory. Its
checkpoint is stored as `codex-checkpoint.json` under `COLLECTOR_DATA_DIR` with
hashed identities and offsets, not transcript content.

Native Codex names come from the configured sessions root's parent by default.
`COLLECTOR_CODEX_METADATA_DIR`, `--codex-metadata-root PATH`, or the runtime's
`codexMetadataRoot` option selects another metadata root explicitly. The reader
only inspects that root and its `sqlite/` child; it does not search other Codex
homes. It opens existing `state_*.sqlite` databases read-only and prefers the
root's highest-version authority before nested copies. The displayed name comes
from safe `threads.name`, then the latest same-UUID `session_index.jsonl`
`thread_name`, then legacy `threads.title` when no native name exists. Index
recency uses `updated_at` (or `updatedAt`), with the later line winning ties.

An explicit nonempty but unsafe canonical name retracts the previous display
instead of falling back to an old index or derived title. An unsafe latest index
name similarly blocks old derived titles unless SQLite supplies a valid native
name. Names must pass the shared 64-character/path/URL/control/credential checks;
otherwise the existing `Codex` plus short identity hash remains the safe fallback.
Transient read failures and SQLite locks retain the last validated safe value.
No prompt, first user message, preview, body, or cwd becomes a title source.

Title-only changes are polled even when rollout files do not grow. They produce
`session_title_updated` with an empty payload and the matching current/terminal
task identity, without replaying lifecycle events. Session/task starts and task
finishes carry the current safe native name. Only RAM holds title values and
rename digests; checkpoint serialization uses an explicit lifecycle-field
allowlist and never writes names or raw UUIDs. Reads are bounded by line length,
tail bytes, candidate entry counts, database bytes and 64-session SQL batches;
title caches are also capped across polls.

Usage collection is a separate opt-in from lifecycle monitoring. Enable it with
`--watch-usage` or `COLLECTOR_WATCH_USAGE=1`; `--no-watch-usage` disables it.
The Finder `.command` launcher asks once via `--configure-usage`. Its saved
choice lives in `usage.preference` under `CLAUDE_PHONE_MONITOR_HOME` (default
`~/.claude-phone-monitor`), with mode 600, separately from pairing's generated
environment. The launcher flags `--watch-usage` / `--no-watch-usage` save a new
choice; environment values `1` / `0` override only the current run, and CLI
flags take precedence. Ordinary script launches reuse the saved choice.
An unconfigured noninteractive launch stays disabled and prints the enable
command. Direct Collector launches do not read the launcher's preference file.
An unreadable or damaged preference disables Usage without blocking lifecycle
monitoring. An explicit launcher choice repairs a damaged regular preference
file; unsafe paths are never overwritten, and an unsaved choice applies only
to that launch with a diagnostic.
It reads `~/.claude/projects` and the Codex sessions root above (override the
Claude root with `COLLECTOR_CLAUDE_PROJECTS_DIR`). First enable creates a
persistent start epoch after recording existing file high-water marks; those
historical rows are not backfilled. The private `usage.sqlite` ledger is kept in
`COLLECTOR_DATA_DIR`, mode-restricted, and stores only provider, hashed
session/response/path identities, allowlisted numeric usage, and file cursors.
After restart, it catches up appended rows without resetting the epoch. The
wire sends only a versioned absolute aggregate using the existing sequence and
durable outbox; it does not create lifecycle events. Fixed `usage_*` diagnostic
codes indicate unavailable sources, changed shapes, oversized rows, or local
storage/queue trouble without exposing counts, paths, or source contents.
The page counts deduplicated source response identities, not hidden provider
retries. Claude new input is `input_tokens + cache_creation_input_tokens`;
Codex new input is `input_tokens - cached_input_tokens`. Actual use is new input
plus output, total input adds cached input, and cache-hit tokens use Claude's
cache-read or Codex's cached-input counter. Missing cache fields stay unknown,
including 0/0 assistant messages; only the explicit `<synthetic>` model marker
is filtered. Codex quota comes from the read-only `codex app-server` account/rate
limits endpoint; it is sampled on watcher startup and then at most once per
minute. The wire quota is a percent remaining value with its reset window and
sample timestamps. A baseline is compared only within the same Codex account,
limit window, and reset. If that identity changes, the startup sample and reset
metadata remain available for context while `start_remaining` becomes null. If
the startup quota read fails, a later successful read supplies only the current
value; it never becomes a claimed startup value. Read failures preserve the last
sample as `stale`; no token limits are inferred from transcript rows.

JSONL rows have a 4 MiB hard limit. Both providers receive a read budget large
enough for one allowed row and its newline; allocations use the actual bytes
remaining in each file. The complete JSON row is parsed before classifying
irrelevant records, so ordinary long prompt/tool bodies do not degrade Usage
coverage. Oversized or malformed rows still record a conservative coverage
gap, while later valid records continue counting. Existing permanent gaps
remain partial after upgrades or restarts; the epoch and response ledger are
never reset to hide missing data.

The verified versions were Codex Desktop app 26.930.61225 with embedded runtime
0.160.0, and standalone CLI binary 0.159.3. These are distinct execution forms
and version values and should not be reported as one version. Codex's local JSONL
record shape is version-dependent and may change. The watcher uses only the
documented-in-this-version lifecycle projection: new turns become WORKING,
verified normal completion becomes FINISH, and only the exact verified
`server_overloaded` enum becomes ERROR. An abort, unknown error, or stale active
turn returns to a neutral state. It does not infer WAITING from inactivity or
claim visibility into every tool/approval event. The watcher treats a session
as stale after 30 minutes without source-file growth or modification; this
only emits a neutral `session_ended`, never a completion, error, or WAITING
state. The earlier threshold is intentional because Relay's working-session
TTL is two hours.

Startup problems write only the fixed code `codex_watch_start_failed` to stderr.
While running, stderr reports fixed diagnostic code identifiers only, such as
`codex_source_root_unavailable`, `codex_jsonl_unsupported_shape`,
`codex_jsonl_malformed_row`, `codex_source_read_failed`, or
`codex_active_session_stale`. These indicate an unavailable or changed local
source; they never include a path, JSONL row, prompt, error message, command, or
numeric counters. Check the local Codex version and configured sessions root,
then restart the collector. A zero event count is not evidence that Codex is
idle.

The exact launchd template is in `launchd/com.claude.phone-monitor.collector.plist.template`; the Skill under `skills/claude-monitor/` renders and installs it without modifying unrelated launch agents.

## Privacy boundary

The normalizer is an allowlist. It retains only canonical lifecycle metadata, safe tool names, bounded duration/exit code, waiting reason, safe IDs, and timestamps. On `SessionStart`, it may also retain Claude's explicit `session_title` after rejecting paths, URLs, control characters, credential-like values, and titles longer than 64 characters. `prompt_id` is used as `task_id` only when an explicit `task_id` is absent. Claude identifiers outside the reserved `codex:` namespace remain unchanged; a collision is replaced with a stable SHA-256 namespaced ID. Codex session/task IDs use that reserved namespace and hashed source identities. Prompt text, assistant messages, tool input/result, command arguments, paths, stdout/stderr, secrets and unknown fields are discarded before the local outbox.
