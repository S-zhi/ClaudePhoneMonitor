# Local monitor MVP harness

This repository currently has a dependency-free, in-memory smoke harness for the phone-monitor workstream. It tests the protocol boundary without opening a WebSocket, starting a relay process, contacting Claude, or reading a real Hook installation.

For the approved same-LAN deployment flow (bootstrap bearer pairing, one-time Android claim, role-scoped WebSocket tokens, reconnect/resume, redaction, and the Mac-to-Android LAN checklist), see [real-LAN deployment](real-lan-deployment.md). Its live integration gate is opt-in and runs with `RELAY_BASE_URL` plus `RELAY_BOOTSTRAP_SECRET`; it must use the Mac's LAN IP for Android, never `127.0.0.1`. The checklist also records the trusted-LAN-only `ws://` limitation and the later WSS hardening step.

## Run locally

From the repository root:

```sh
node --test tests/monitor-mvp-harness.test.mjs
```

The harness uses only Node's built-in `node:test`, `node:assert`, and file APIs. It needs no `ANTHROPIC_API_KEY`, OAuth profile, network access, database, or running Claude process. A passing run reports six tests and exits with status 0.

## What the harness covers

`tests/monitor-mvp-harness.test.mjs` wires a fake event publisher, an in-memory relay, and a fake phone subscriber together. The tests cover:

- event publication through the relay to a subscribed phone;
- `session_started`, task/tool start and finish/failure, `waiting`, `heartbeat`, and `session_ended` state transitions;
- event-id/installation-sequence deduplication and `event_ack` responses;
- subscriber disconnect, reconnect, and replay strictly after its last sequence;
- `probe` -> `challenge` -> `challenge_ack`, plus an unacknowledged probe becoming `stale` and returning `PROBE_TIMEOUT`;
- redaction before relay storage and subscriber delivery.

The fake relay records the message vocabulary listed by the MVP contract: `hello`, `hello_ack`, `event`, `event_ack`, `heartbeat`, `subscribe`, `snapshot`, `resume`, `probe`, `challenge`, `challenge_ack`, and `error`.

## Fixture boundary

`tests/fixtures/simulated-events.json` contains synthetic event envelopes. Each envelope has:

```json
{
  "type": "event",
  "schema_version": 1,
  "event_id": "...",
  "installation_id": "...",
  "session_id": "...",
  "task_id": "...",
  "sequence": 1,
  "occurred_at": "2026-10-02T09:00:00Z",
  "event_type": "session_started",
  "payload": {}
}
```

`task_id` and `correlation_id` are optional. The payload is deliberately treated as opaque JSON. The fixture does **not** claim that any of these payload fields are emitted by a current Claude Hook.

`tests/fixtures/privacy-payload.json` is a separate synthetic-only input for the privacy test. Its `prompt`, `tool_input`, `tool_result`, `stdout`, and `stderr` keys are arbitrary redaction probes, not a statement about supported Hook fields. They contain fake marker values and fake credentials only.

When a real Hook adapter is available, add versioned, redacted fixtures from the verified Hook payload documentation before changing the harness assertions. Do not infer fields from this test fixture or silently forward unknown Hook data.

## Relay and snapshot expectations

The harness models a client sending `hello`, then `resume` and `subscribe`. Events use the envelope above and are acknowledged with `event_ack`. A resume request supplies the highest applied `last_sequence`; replay includes only events with a greater sequence. Replayed events are followed by a snapshot from the current relay state.

Snapshots contain these required fields:

- `installation_id`;
- `computer_state`: `online`, `stale`, or `offline`;
- `claude_state`: `idle`, `working`, or `waiting`;
- optional `activity`;
- `last_sequence`;
- `updated_at`.

A probe sends a challenge to the subscriber. An acknowledged challenge keeps the installation online. A timeout marks the snapshot `stale` and emits a retryable `error` with code `PROBE_TIMEOUT`.

## Privacy rule exercised by the test

The phone boundary redacts values under sensitive keys, including prompt/tool input/result and stdout/stderr, then removes secret-like tokens and absolute paths from remaining strings. Redaction happens before the relay stores an event and before it broadcasts the event. Treat this as a conservative MVP policy; production should keep an allowlist of fields that are safe to send rather than expanding a raw payload allowlist from observed examples.

## Operator checklist

1. Run the command above in a clean checkout.
2. Confirm all six tests pass and there is no credential/network setup step.
3. If a test fails after protocol changes, inspect the envelope/message contract first; do not make the synthetic fixture look like a live Hook payload.
4. Before wiring real Hooks, capture a version-pinned fixture, remove private data, document the source/version, and add an adapter-level test separately from this transport harness.
