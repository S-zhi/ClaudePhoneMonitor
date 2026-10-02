# Approved real-LAN deployment checklist

This checklist is for validating the relay on one Mac and an Android phone on the
same trusted local network. It is intentionally a development/deployment gate for
the approved pairing contract, not an Internet-facing production deployment.

The opt-in integration test is [`tests/real-lan-contract.test.mjs`](../tests/real-lan-contract.test.mjs).
It uses only Node's built-in `fetch` and WebSocket when available (or the relay
package's existing `ws` dependency), and a synthetic event fixture. It does not
contact Claude, send prompts, or require a cloud credential.

## Contract under test

### Bootstrap pairing

The Mac operator creates a pairing record with a bootstrap bearer. The bearer is
sent in the HTTP `Authorization` header, never in a URL or JSON body:

```http
POST /v1/pairing
Authorization: Bearer <RELAY_BOOTSTRAP_SECRET>
Content-Type: application/json
```

```json
{
  "installation_id": "mac-installation-1",
  "relay_url": "http://192.168.1.42:8787"
}
```

A successful response is HTTP `201` and contains the contract fields below.
Optional metadata may be added without breaking the test.

```json
{
  "pairing_id": "pairing-...",
  "code": "one-time-code",
  "expires_at": "2026-10-02T12:10:00.000Z",
  "qr_payload": "{\"version\":1,...}",
  "collector_token": "opaque-collector-token",
  "installation_id": "mac-installation-1",
  "ws_url": "ws://192.168.1.42:8787"
}
```

The `qr_payload` may be a JSON string or an already-decoded JSON object. Its
required content is:

```json
{
  "version": 1,
  "relay_http_url": "http://192.168.1.42:8787",
  "relay_ws_url": "ws://192.168.1.42:8787",
  "pairing_id": "pairing-...",
  "pairing_code": "one-time-code",
  "installation_id": "mac-installation-1"
}
```

A bad bootstrap bearer must be rejected with an HTTP `401` or `403`. The response
must not create a usable pairing record.

### Android claim

The Android-side claim consumes the code exactly once:

```http
POST /v1/pairing/<pairing_id>/claim
Content-Type: application/json
```

```json
{
  "code": "one-time-code",
  "device_name": "living-room-phone"
}
```

The successful response contains:

```json
{
  "installation_id": "mac-installation-1",
  "android_token": "opaque-android-token",
  "ws_url": "ws://192.168.1.42:8787",
  "expires_at": "2026-10-02T12:10:00.000Z"
}
```

The collector and Android tokens are role-scoped and must be different opaque
values. A wrong code and a second claim with the original code must both be
rejected (`400`, `401`, `403`, or `409` are acceptable rejection statuses). Do
not print either token or the pairing code in a shared terminal transcript.

### WebSocket authentication and data path

Tokens are sent in the first role-specific JSON message. They are **not** query
parameters.

Collector (`/ws/collector`):

```json
{
  "type": "hello",
  "schema_version": 1,
  "role": "collector",
  "installation_id": "mac-installation-1",
  "token": "<collector_token>"
}
```

Android (`/ws/android`) authenticates its subscription:

```json
{
  "type": "subscribe",
  "schema_version": 1,
  "installation_id": "mac-installation-1",
  "token": "<android_token>",
  "last_sequence": 0
}
```

A collector event is acknowledged by the relay and results in a compact relay
`snapshot` for the Android subscriber. The Android reconnect path supplies its
last sequence and receives the current snapshot/replay rather than starting from
an assumed zero cursor. A collector token on the Android gateway, or an Android
token on the collector gateway, must be rejected with an error or a closed
WebSocket.

The relay must redact private payload probes before any event data can cross the
phone boundary. The integration fixture deliberately includes fake prompt,
tool input/result, stdout/stderr, bearer, and absolute-path markers. Those
markers must not appear in Android messages. The fixture values are synthetic and
are not claims about a particular Hook payload schema.

## Mac setup

1. Put the Mac and the Android device on the same trusted Wi-Fi or wired LAN.
2. Install Node.js 20 or newer and the relay dependencies:

   ```bash
   npm install --prefix services/relay
   ```

3. Find the Mac's LAN address. On a typical Wi-Fi Mac:

   ```bash
   ipconfig getifaddr en0
   # If en0 is not Wi-Fi on this Mac, inspect: ifconfig
   ```

   Record an address such as `192.168.1.42`. **Do not use `127.0.0.1` in
   Android configuration.** `127.0.0.1` inside Android means the Android device
   itself, not the Mac running the relay.

4. Choose a high-entropy bootstrap secret and keep it in the shell environment
   rather than a checked-in file. Start the relay on all LAN interfaces:

   ```bash
   export RELAY_HOST=0.0.0.0
   export RELAY_PORT=8787
   export RELAY_BOOTSTRAP_SECRET='replace-with-a-long-random-value'
   npm --prefix services/relay run start
   ```

   If the relay is started by another process manager, preserve the same
   `RELAY_HOST`, `RELAY_PORT`, and `RELAY_BOOTSTRAP_SECRET` values there.

5. From the Mac, verify the process first:

   ```bash
   curl --fail http://127.0.0.1:8787/healthz
   ```

6. Verify LAN reachability using the Mac LAN address (and, if available, from a
   second device on the same network):

   ```bash
   curl --fail http://192.168.1.42:8787/healthz
   ```

   If this fails, check the macOS application firewall, the selected network
   interface, the relay bind address, and whether the Wi-Fi network isolates
   clients. Do not solve it by changing the Android endpoint to localhost.

## Pair and run the Node integration gate

The test creates a fresh installation ID, so it does not reuse a code from a
previous run. Set the HTTP base URL to the Mac LAN address and run:

```bash
RELAY_BASE_URL=http://192.168.1.42:8787 \
RELAY_BOOTSTRAP_SECRET="$RELAY_BOOTSTRAP_SECRET" \
node --test tests/real-lan-contract.test.mjs
```

The default run, without these environment variables, runs the dependency-free
fixture check and marks the live test as skipped. With the variables set, the
live test must report two passing tests and zero failures. It verifies, in one
flow:

- bootstrap bearer rejection and successful `201` pairing;
- QR payload fields and the absence of query-string tokens;
- wrong-code rejection and one-time claim semantics;
- separate collector and Android tokens;
- authenticated collector event -> relay snapshot -> Android subscriber;
- redaction at the Android boundary;
- Android disconnect, event accumulation, reconnect, and resume;
- rejection of a role-mismatched token on each WebSocket gateway.

The test is a contract gate, not a replacement for exercising the actual Android
APK. It does not silently fall back to the old unauthenticated development relay:
when enabled, an authentication or token failure is a test failure.

## Manual Android checklist

- [ ] Android and Mac are on the same LAN; the phone can reach the Mac LAN IP.
- [ ] Relay is listening on `0.0.0.0:8787` (not only `127.0.0.1`).
- [ ] `http://<MAC_LAN_IP>:8787/healthz` responds from a second LAN device.
- [ ] `POST /v1/pairing` uses the bootstrap bearer and returns `201`.
- [ ] The QR payload contains version, HTTP URL, WebSocket URL, pairing ID/code,
      and installation ID; no token is in either URL.
- [ ] The Android claim returns an Android token and the token differs from the
      collector token.
- [ ] Reusing the pairing code is rejected.
- [ ] The macOS collector connects to `ws://<MAC_LAN_IP>:8787/ws/collector`,
      sends its collector token in `hello`, and receives an accepted response.
- [ ] The Android app connects to `ws://<MAC_LAN_IP>:8787/ws/android` and sends
      its Android token in `subscribe`; it does **not** use `127.0.0.1` and does
      **not** append a token to the URL.
- [ ] A synthetic collector event changes the Android snapshot to the expected
      state.
- [ ] Disconnecting Android, sending another event, and reconnecting with the
      previous `last_sequence` resumes at the current snapshot/replay.
- [ ] A collector token on Android and an Android token on the collector are both
      rejected.
- [ ] Prompt/tool content, output, bearer-like values, and absolute paths do not
      appear in Android messages or relay logs.
- [ ] Tokens, pairing codes, and the bootstrap secret are removed from shell
      history/log attachments after the test if the machine is shared.

## Trusted-LAN `ws://` limitation and the later WSS step

This approved first deployment uses `ws://` for a **trusted LAN only**. WebSocket
traffic, including event metadata and bearer tokens sent in JSON, is not
confidential on that network. Anyone who can observe or join the LAN may inspect
or interfere with the connection. `ws://` is not acceptable on public Wi-Fi,
across the Internet, through port forwarding, or across an untrusted/VPN peer.
The bootstrap secret and role tokens still protect accidental clients, but they
do not turn plaintext transport into encryption.

The later hardening step is WSS:

1. terminate TLS at the relay or a local reverse proxy;
2. advertise `https://` and `wss://` URLs in pairing and QR payloads;
3. provision a certificate whose hostname/IP matches the Mac endpoint (or install
   a controlled local CA on the Android device);
4. configure Android's network security/trust policy for that certificate;
5. keep tokens out of query strings, rotate bootstrap and role tokens, and test
   expiry/revocation over the encrypted path; and
6. only then consider access beyond a trusted LAN, together with persistent
   storage, firewall policy, rate limiting, and operational audit logs.

Until that WSS step is complete, treat the relay as a same-network development
service and shut it down when the validation window ends.
