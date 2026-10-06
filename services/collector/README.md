# macOS Collector

The collector is a small Node.js daemon that keeps Claude Code Hook delivery local and fail-open.

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
npm --prefix services/collector run start -- --collector
```

The exact launchd template is in `launchd/com.claude.phone-monitor.collector.plist.template`; the Skill under `skills/claude-monitor/` renders and installs it without modifying unrelated launch agents.

## Privacy boundary

The normalizer is an allowlist. It retains only canonical lifecycle metadata, safe tool names, bounded duration/exit code, waiting reason, safe IDs, and timestamps. On `SessionStart`, it may also retain Claude's explicit `session_title` after rejecting paths, URLs, control characters, credential-like values, and titles longer than 64 characters. `prompt_id` is used as `task_id` only when an explicit `task_id` is absent. Prompt text, assistant messages, tool input/result, command arguments, paths, stdout/stderr, secrets and unknown fields are discarded before the local outbox.
