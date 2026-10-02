# Claude Phone Monitor Relay

Minimal workstream-B relay for the Claude phone monitor MVP. The service accepts Claude activity events from a collector, tracks per-installation sequence state, and broadcasts compact snapshots to Android clients. It is intentionally dependency-light: Fastify provides HTTP, `@fastify/websocket` provides the two WebSocket gateways, and the repository is an in-memory implementation behind a persistence-ready interface.

## Run locally

From this directory:

```bash
npm install
npm run dev
```

The default listener is `0.0.0.0:8787`.

```bash
npm start
npm test
npm run typecheck
npm run build
```

Environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `RELAY_HOST` | `0.0.0.0` | HTTP/WebSocket bind host |
| `RELAY_PORT` or `PORT` | `8787` | HTTP/WebSocket bind port |
| `RELAY_STALE_AFTER_MS` | `15000` | Time without a collector heartbeat before `stale` |
| `RELAY_OFFLINE_AFTER_MS` | `60000` | Time without a collector heartbeat before `offline` |
| `RELAY_BOOKKEEPING_INTERVAL_MS` | `1000` | Status and heartbeat timer interval |
| `RELAY_HEARTBEAT_INTERVAL_MS` | `10000` | Server heartbeat interval |
| `RELAY_PROBE_TIMEOUT_MS` | `5000` | Probe challenge deadline |
| `RELAY_MAX_MESSAGE_BYTES` | `262144` | WebSocket message limit |
| `RELAY_MAX_STORED_EVENTS` | `10000` | In-memory event history limit |
| `RELAY_PAIRING_TTL_MS` | `600000` | Development pairing code lifetime |

## Health and pairing HTTP API

- `GET /healthz` returns process health, schema version, development-auth mode, and storage mode.
- `GET /health` redirects to `/healthz`.
- `GET /readyz` returns readiness and connection counters.
- `GET /v1/snapshot` returns `{ "schema_version": 1, "snapshots": [...] }`.
- `GET /v1/snapshot?installation_id=<id>` limits the response to one installation.
- `POST /v1/pairing` creates a development pairing record and returns its code.
- `GET /v1/pairing/:pairing_id` returns pairing status without returning the code.
- `POST /v1/pairing/:pairing_id/claim` with `{ "code": "..." }` claims a development pairing code.

Pairing and authentication are deliberately placeholders for the MVP. WebSocket connections are accepted in development mode; the supplied token/pairing fields are not treated as production credentials. Replace the auth boundary before exposing this relay to an untrusted network.

## WebSocket gateways

- `ws://<host>:<port>/ws/collector` is the collector gateway.
- `ws://<host>:<port>/ws/android` is the Android gateway.

The query parameters `installation_id`, `client_id`, `pairing_id`, and `pairing_code` are accepted for development convenience. A client can also send `hello` immediately after connecting:

```json
{
  "type": "hello",
  "schema_version": 1,
  "client_id": "collector-dev",
  "installation_id": "install-123",
  "pairing_id": "development-pairing",
  "pairing_code": "development-code"
}
```

The relay responds with `hello_ack`. The first `hello_ack` is sent on connection and a second one is sent when a client changes its identity. It contains the canonical acceptance and server-time fields; development pairing remains a placeholder exposed by the health and pairing endpoints:

```json
{
  "type": "hello_ack",
  "schema_version": 1,
  "connection_id": "conn-...",
  "accepted": true,
  "server_time": "2026-10-02T12:00:00.000Z",
  "installation_id": "install-123"
}
```

## Event envelope

Collectors send only schema version 1 event envelopes. `event_type` is intentionally closed to the v1 contract so snapshots can derive Claude state consistently.

```json
{
  "type": "event",
  "schema_version": 1,
  "event_id": "evt-0001",
  "installation_id": "install-123",
  "session_id": "session-abc",
  "task_id": "task-xyz",
  "sequence": 42,
  "occurred_at": "2026-10-02T12:00:00.000Z",
  "event_type": "tool_finished",
  "payload": { "tool_name": "Read" },
  "correlation_id": "corr-0001"
}
```

Valid `event_type` values are:

- `session_started`
- `task_started`
- `tool_started`
- `tool_finished`
- `tool_failed`
- `waiting`
- `task_finished`
- `task_failed`
- `session_ended`

The relay deduplicates globally by `event_id`. A repeated event is acknowledged as `duplicate` and is not broadcast or applied a second time. Sequences are tracked per `installation_id`:

- `initial` — first event observed for the installation.
- `in_order` — exactly the next sequence.
- `gap` — sequence is higher than the next expected sequence.
- `out_of_order` — sequence is lower than the highest sequence already observed.

The collector receives an `event_ack` for every valid or duplicate event:

```json
{
  "type": "event_ack",
  "schema_version": 1,
  "event_id": "evt-0001",
  "sequence": 42,
  "accepted": true,
  "duplicate": false,
  "status": "accepted",
  "sequence_status": "in_order",
  "last_sequence": 42,
  "next_sequence": 43,
  "received_at": "2026-10-02T12:00:01.000Z"
}
```

Invalid envelopes receive a rejected `event_ack` when an event ID can be safely recovered, followed by an `error` message. Android clients cannot ingest events.

## Snapshot contract

The relay broadcasts one `snapshot` message per installation to subscribed Android clients after a newly accepted event and whenever a collector connection changes liveness. A snapshot has the canonical v1 shape:

```json
{
  "type": "snapshot",
  "schema_version": 1,
  "installation_id": "install-123",
  "computer_state": "online",
  "claude_state": "working",
  "activity": {
    "event_type": "tool_finished",
    "session_id": "session-abc",
    "task_id": "task-xyz",
    "occurred_at": "2026-10-02T12:00:00.000Z"
  },
  "last_sequence": 42,
  "updated_at": "2026-10-02T12:00:01.000Z"
}
```

`computer_state` is `online`, `stale`, or `offline`, based on the collector connection for that installation. `claude_state` is derived from event type:

- `session_started` -> `idle`
- `task_started`, `tool_started` -> `working`
- `waiting` -> `waiting`
- `tool_finished` -> `working`
- `tool_failed`, `task_finished`, `task_failed`, `session_ended` -> `idle`

An Android connection subscribes to all installations by default. It can narrow the stream with:

```json
{
  "type": "subscribe",
  "schema_version": 1,
  "installation_ids": ["install-123"]
}
```

Use `{ "type": "subscribe", "schema_version": 1, "all": true }` to return to all installations. `resume` replays the retained in-memory event envelopes after a supplied sequence and then sends the current snapshot:

```json
{
  "type": "resume",
  "schema_version": 1,
  "installation_id": "install-123",
  "last_sequence": 40
}
```

## Probe and challenge routing

A `probe` creates a routed `challenge`; the target answers with `challenge_ack`, and the acknowledgement is routed back to the connection that originated the probe. The relay routes to the opposite gateway by default. Set `target_installation_id`, `target_gateway`, or `target_connection_id` to narrow the route.

```json
{
  "type": "probe",
  "schema_version": 1,
  "probe_id": "probe-1",
  "nonce": "nonce-1",
  "timeout_ms": 5000,
  "target_installation_id": "install-123"
}
```

The target receives:

```json
{
  "type": "challenge",
  "schema_version": 1,
  "probe_id": "probe-1",
  "nonce": "nonce-1",
  "expires_at": "2026-10-02T12:00:05.000Z"
}
```

A missing target produces an `error` with `target_not_found`. If the target does not acknowledge before the deadline, the installation snapshot becomes `stale` and the requester receives a retryable `PROBE_TIMEOUT` error. An acknowledgement for an expired or unknown challenge produces `route_not_found`.

`heartbeat` is handled on either gateway. The server emits periodic heartbeat messages with `heartbeat_id`/`nonce`; a client may echo them. Any valid inbound message also refreshes liveness. A disconnected or silent collector is retained in bookkeeping so snapshots can transition to `stale` and then `offline`.

## Storage boundary

`src/repository.ts` defines `RelayRepository`, which separates relay behavior from persistence. `InMemoryRelayRepository` is the default and stores connections, installation state, recent events, dedupe keys, and development pairing records in maps. A future SQLite adapter can implement the same interface without changing WebSocket handlers or protocol logic. The MVP intentionally does not load a native SQLite dependency.

## Logging and security

Logs are newline-delimited JSON. The logger omits or sanitizes authorization tokens, API keys, pairing values, secrets, payloads, raw content, prompts, transcript fields, and bearer-like strings. Event logs contain only event type, sequence metadata, gateway, and duplicate status; raw event payloads and user text are never logged. Event payloads are also redacted before the repository stores them or the relay broadcasts them. HTTP logs record only the URL path, never query strings.

This is development infrastructure, not a production authentication boundary. Add real identity verification, encrypted transport, persistence, replay retention policy, and authorization checks before deployment.
