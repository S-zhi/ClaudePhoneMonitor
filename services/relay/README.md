# Claude Phone Monitor Relay

The service accepts Claude activity events from a macOS collector, tracks per-installation sequence state, persists pairing/events when `RELAY_DB_PATH` is configured, and broadcasts compact snapshots to Android clients. Fastify provides HTTP, `@fastify/websocket` provides the two WebSocket gateways, and the repository boundary supports both SQLite and in-memory test storage.

## Run locally

Use Node.js 24.13.0 (pinned in the root `.node-version`); see [CI and local reproduction](../../docs/ci.md) for the full environment. From this directory:

```bash
npm ci
npm run dev
```

The default listener is `0.0.0.0:8787`.

`npm start` runs compiled output, so build first:

```bash
npm run build
npm start
```

Run checks separately:

```bash
npm test
npm run typecheck
```

Environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `RELAY_HOST` | `0.0.0.0` | HTTP/WebSocket bind host |
| `RELAY_PORT` or `PORT` | `8787` | HTTP/WebSocket bind port |
| `RELAY_PUBLIC_URL` | unset | LAN HTTP/WS base URL placed into pairing QR |
| `RELAY_AUTH_MODE` | `development` | Use `paired` for token enforcement; a bootstrap secret forces paired mode |
| `RELAY_BOOTSTRAP_SECRET` | unset | Required bearer for creating a real pairing; use 24+ URL-safe characters |
| `RELAY_DB_PATH` | unset | SQLite file path; unset uses in-memory storage for tests/development |
| `RELAY_STALE_AFTER_MS` | `15000` | Time without a collector heartbeat before `stale` |
| `RELAY_OFFLINE_AFTER_MS` | `60000` | Time without a collector heartbeat before `offline` |
| `RELAY_BOOKKEEPING_INTERVAL_MS` | `1000` | Status and heartbeat timer interval |
| `RELAY_HEARTBEAT_INTERVAL_MS` | `10000` | Server heartbeat interval |
| `RELAY_PROBE_TIMEOUT_MS` | `5000` | Probe challenge deadline |
| `RELAY_MAX_MESSAGE_BYTES` | `262144` | WebSocket message limit |
| `RELAY_MAX_STORED_EVENTS` | `10000` | Event history limit |
| `RELAY_PAIRING_TTL_MS` | `600000` | One-time pairing code lifetime |

## Health and pairing HTTP API

- `GET /healthz` reports the selected auth mode and storage kind.
- `GET /health` redirects to `/healthz`.
- `GET /readyz` returns readiness and connection counters.
- `GET /v1/snapshot` returns `{ "schema_version": 1, "snapshots": [...] }`.
- `GET /v1/snapshot?installation_id=<id>` limits the response to one installation.
- `POST /v1/pairing` creates a pairing only when `RELAY_BOOTSTRAP_SECRET` is configured and the request has `Authorization: Bearer <secret>`. Body:

```json
{
  "installation_id": "mac-installation-id",
  "relay_url": "http://192.168.1.3:8787"
}
```

The response includes `pairing_id`, one-time `code`, `collector_token`, `ws_url`, and `qr_payload`. The QR payload contains only:

```json
{
  "version": 1,
  "relay_http_url": "http://192.168.1.3:8787",
  "relay_ws_url": "ws://192.168.1.3:8787/ws/android",
  "pairing_id": "...",
  "pairing_code": "...",
  "installation_id": "..."
}
```

- `POST /v1/pairing/:pairing_id/claim` with `{ "code": "...", "device_name": "Android" }` returns the one-time `android_token` and invalidates the code.
- `GET /v1/pairing/:pairing_id` returns pairing status without returning codes or tokens.

Do not put `127.0.0.1` in the QR payload: Android's localhost is the phone itself. The LAN MVP uses `ws://` only on a trusted network; use WSS/TLS before exposing Relay beyond that network.

## WebSocket gateways

- `ws://<host>:<port>/ws/collector` is the collector gateway.
- `ws://<host>:<port>/ws/android` is the Android gateway.

A collector authenticates with its role-scoped token in `hello`; Android authenticates with its own token in `hello` and `subscribe`. Tokens are never query parameters:

```json
{
  "type": "hello",
  "schema_version": 1,
  "role": "collector",
  "client_id": "collector-mac",
  "installation_id": "install-123",
  "token": "col_..."
}
```

Android then sends:

```json
{
  "type": "subscribe",
  "schema_version": 1,
  "installation_id": "install-123",
  "token": "and_...",
  "last_sequence": 0
}
```

The relay responds with `hello_ack` and then snapshots. In paired mode an invalid
role token receives an `unauthorized` error and cannot ingest or subscribe.

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

`src/repository.ts` defines `RelayRepository`, with an in-memory implementation for tests and a built-in `node:sqlite` implementation for LAN deployment. Set `RELAY_DB_PATH` to retain pairings, tokens, event history and snapshots across process restarts. Do not use the in-memory default for a real installation.

## Logging and security

Logs are newline-delimited JSON. The logger omits or sanitizes authorization tokens, API keys, pairing values, secrets, payloads, raw content, prompts, transcript fields, and bearer-like strings. Event logs contain only event type, sequence metadata, gateway, and duplicate status; raw event payloads and user text are never logged. Event payloads are also redacted before the repository stores them or the relay broadcasts them. HTTP logs record only the URL path, never query strings.

The development auth mode remains available for local tests only (`RELAY_AUTH_MODE=development` without a bootstrap secret). A real LAN install must set `RELAY_BOOTSTRAP_SECRET` and `RELAY_DB_PATH`, then use the one-time pairing flow. `ws://` is trusted-LAN-only; use encrypted transport and a certificate trust plan for any wider network.
