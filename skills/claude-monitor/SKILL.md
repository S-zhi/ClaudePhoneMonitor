---
name: claude-monitor
description: Set up and operate the local macOS phone monitor for Claude Code and optional read-only Codex session monitoring, including safe user-level Hook registration, pairing, diagnostics, and uninstall.
---

# Claude phone monitor

This Skill is the **setup and operator surface** for the Claude phone monitor MVP. It
is deliberately separate from Claude Code's hook lifecycle:

- **Skill setup** is manual and stateful. Run `scripts/monitor-setup setup` (or the
  individual `install`, `pair`, `doctor`, `status`, and `uninstall` helpers) to
  create/update the user-level installation.
- **Hook lifecycle delivery** is automatic. `install` writes one command hook for
  each supported Claude Code event. Claude Code invokes the generated adapter
  command with the event JSON on stdin. The command is not `monitor-setup`, never
  changes settings, and is fail-open (`|| true`) so a phone/collector outage cannot
  block a Claude Code turn.

The default adapter is:

```text
services/collector/dist/cli.js --event EVENT
```

The generated launchd agent runs the same Collector binary with `--collector` so
Hook events have a local Unix socket daemon to receive them. The generated command
uses the configured Node executable and safely quotes the adapter path and event.
Override it with `--adapter`, `--node`, or `--hook-command` when developing from
another checkout.

## Quick start (macOS)

From the repository root:

```bash
skills/claude-monitor/scripts/monitor-setup setup
skills/claude-monitor/scripts/status
skills/claude-monitor/scripts/doctor
```

`setup` installs Hooks and the launchd Collector, then calls the real Relay pairing
API by default. Set `RELAY_BOOTSTRAP_SECRET` and pass a LAN Relay HTTP URL; the
pair command writes a one-time QR payload and collector token into the private
state directory. Use the explicit `--development` flag only for fixture tests.

```bash
RELAY_BOOTSTRAP_SECRET='replace-with-a-long-secret' \
skills/claude-monitor/scripts/pair \
  --relay-http http://127.0.0.1:8787 \
  --relay-ws ws://192.168.1.3:8787/ws/collector \
  --public-url http://192.168.1.3:8787
```

The QR payload must contain the Mac LAN address, not `127.0.0.1`, because Android's
localhost points to the phone itself. The current LAN MVP uses trusted `ws://`; use
WSS/TLS before exposing the Relay outside a trusted network.

For fixture or CI tests, use:

```bash
skills/claude-monitor/scripts/pair --development --state-dir "$TMP/state" --code TEST1234 --json
```

Pairing tokens are never printed. The generated `pairing.png`, `pairing.json`, and
`monitor.env` are mode `0600`.

```bash
skills/claude-monitor/scripts/install \
  --settings "$TMP/settings.json" \
  --state-dir "$TMP/state" \
  --launch-agents-dir "$TMP/LaunchAgents" \
  --no-load
```

## Optional Codex session monitoring

To monitor local Codex Desktop and CLI turns through the same Relay and Android
status page, start the foreground LAN service with:

```bash
scripts/start-lan-monitor.sh --watch-codex
```

The equivalent collector controls are `--watch-codex` or
`COLLECTOR_WATCH_CODEX=1`; `--no-watch-codex` disables it. The watcher reads
`$CODEX_HOME/sessions`, defaulting to `~/.codex/sessions`; set
`COLLECTOR_CODEX_SESSIONS_DIR` to point at another local sessions root. It is
read-only and does not install Codex Hooks or edit Codex settings.

The observed desktop app version is 26.930.61225 with embedded runtime 0.160.0;
the standalone CLI binary is 0.159.3. These are distinct execution forms and
version values. The local JSONL
format can change across releases. The watcher reports new turns as WORKING,
verified normal completion as FINISH, and only the exact verified
`server_overloaded` error enum as ERROR. Aborts and unknown errors reset to a
neutral state. It does not infer WAITING from a pause or claim complete tool and
approval visibility.

Collector stderr uses fixed diagnostic code identifiers only. For
example, `codex_watch_start_failed` means the configured sessions root could
not be opened; `codex_jsonl_unsupported_shape` or
`codex_source_read_failed` suggests the local format or access needs review.
Diagnostics print code identifiers only and never include counters, a path,
session row, prompt, command, or error message. A missing event is not evidence
that the Codex session is idle. A source session without file growth or mtime
change for 30 minutes ends neutrally; that stale threshold never means
completion, error, or WAITING, and is shorter than Relay's two-hour working
session TTL.

## Supported lifecycle events

The default set is exactly:

```text
SessionStart
UserPromptSubmit
PreToolUse
PostToolUse
PostToolUseFailure
PermissionRequest
Notification
Stop
StopFailure
SessionEnd
```

Each event is represented by one monitor-owned command hook. `--events CSV` can
narrow or extend the set for development, but the default should be used for the
MVP.

## Safe settings behavior

The installer edits only the user-level settings file at
`~/.claude/settings.json` (or the explicit `--settings` path). Every generated
command contains the stable marker `claude-phone-monitor:v1`.

- Install removes and recreates only commands containing that marker, so rerunning
  install cannot duplicate monitor entries.
- It preserves unrelated event groups, matchers, hook commands, permissions, and
  unknown settings fields. If a group contains both monitor and unrelated hooks,
  only the monitor command is removed.
- Uninstall uses the same marker and leaves every unrelated hook untouched. It also
  refuses to delete an unmarked launchd plist.
- Writes are atomic and retain the existing settings file mode. A malformed settings
  file is reported instead of being overwritten.

Use a temporary `--settings` file for tests. The repository test harness never
points at a real home directory.

## launchd and state

`install` copies the checked-in template
`config/com.claude.phone-monitor.plist.template` into the monitor state directory,
then renders:

```text
~/Library/LaunchAgents/com.claude.phone-monitor.plist
```

The generated agent keeps a small background health heartbeat under the state
directory. Hook delivery remains independent of that process. On macOS the helper
attempts a per-user `launchctl bootstrap`; if launchctl is unavailable or rejects
the agent, setup still succeeds and reports the generated plist path.

Default state files are under `~/.claude-phone-monitor`:

- `install.json` — paths and event set used by the current installation;
- `monitor.env` — generated local configuration;
- `pairing.json` — development pairing code, mode `0600`;
- `launchd.template.plist` and the rendered plist;
- `logs/` and `events.jsonl` — retained on ordinary uninstall.

`uninstall` removes marker-owned hooks and generated launchd files. It keeps event
logs by default; add `--purge-state` when the state directory is disposable and its
contents should be deleted.

## Operator commands

All helpers support `--help`, explicit fixture paths, and repeated invocation.

- `monitor-setup setup` — Skill setup: install and pair.
- `install` — merge hooks, write state, render the launchd plist, and optionally
  load it.
- `pair` — create/show the stable development code (`--rotate` to replace it).
- `status` — read-only state, hook count, pairing presence, adapter, plist, and queue
  summary (`--show-code` is opt-in).
- `doctor` — read-only checks. Missing build output is a warning unless `--strict`
  is used; malformed settings or missing owned hooks are errors.
- `uninstall` — remove only monitor-owned hooks and artifacts.

## Failure mode and security notes

The hook command is intentionally fail-open. It sends the event to the adapter and
then returns success even when Node, the adapter, the collector, or the network is
unavailable. This protects Claude Code's lifecycle and tool execution. Diagnose
lost delivery with `doctor` and `status`; do not make the hook blocking as a local
workaround.

The real pairing flow uses a bootstrap bearer only for the Relay's pairing API and
returns separate opaque collector/Android tokens. Tokens are stored with mode `0600`
and are never printed or placed in the QR payload. The explicit `--development`
flag is reserved for fixture tests. The LAN MVP uses trusted `ws://`; use WSS/TLS
before exposing the Relay beyond the local network.
