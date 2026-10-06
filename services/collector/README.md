# macOS Collector

The collector is a small Node.js daemon that keeps Claude Code Hook delivery local and fail-open. It can also opt into a read-only Codex sessions watcher that sends only allowlisted lifecycle metadata through the same Collector and Relay.

## Build and test

From the repository root:

```bash
npm install --prefix services/collector
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
npm --prefix services/collector run start -- --collector --watch-codex
```

Codex watching is opt-in. Use `COLLECTOR_WATCH_CODEX=1` instead of the CLI flag
when launching the daemon from another supervisor; `--no-watch-codex` overrides
that environment setting. The watcher reads `$CODEX_HOME/sessions`, or
`~/.codex/sessions` when `CODEX_HOME` is unset. Set
`COLLECTOR_CODEX_SESSIONS_DIR` to use another local sessions directory. Its
checkpoint is stored as `codex-checkpoint.json` under `COLLECTOR_DATA_DIR` with
hashed identities and offsets, not transcript content.

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
