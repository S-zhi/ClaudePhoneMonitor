#!/usr/bin/env bash
# One-command trusted-LAN launcher for the Claude Phone Monitor.
# It starts Relay + Collector in the foreground; Ctrl-C stops processes started here.

set -Eeuo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
CURL_BIN="${CURL_BIN:-curl}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
NODE_BIN="${NODE_BIN:-node}"

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${CLAUDE_PHONE_MONITOR_HOME:-$HOME/.claude-phone-monitor}"
PORT="${RELAY_PORT:-8787}"
PAIR=0
INSTALL_HOOKS=0
OPEN_QR=0
WATCH_CODEX=0
CODEX_CHOICE=""
WATCH_USAGE=0
USAGE_CHOICE=""
APPROVAL_CHOICE=""
APPROVAL_BRIDGE=0
CONFIGURE_USAGE=0
RELAY_PID=""
COLLECTOR_PID=""
RELAY_STARTED=0
PAIRING_EXPIRES_AT=""
PAIRING_QR=""
PAIR_HELPER="$ROOT/skills/claude-monitor/scripts/lib/real_pair.py"

usage() {
  cat <<'USAGE'
Usage: start-lan-monitor.sh [options]

Starts the Relay and macOS Collector for the trusted-LAN MVP. The first run
creates a bootstrap secret, creates a one-time pairing, and writes a QR image.

Options:
  --pair            create a fresh one-time pairing QR
  --install-hooks   merge monitor-owned Claude Code Hooks (real settings change)
  --watch-codex     enable Codex lifecycle monitoring and save this choice
  --no-watch-codex  disable Codex watching and save this choice (overrides environment)
  --configure-usage ask for a Usage preference on first interactive launch
  --watch-usage     enable Usage and save this choice for future launches
  --no-watch-usage  disable Usage and save this choice (overrides environment)
  --approval-bridge opt in to paired-phone Claude permissions; install the bridge Hook
  --no-approval-bridge restore telemetry-only Hook and save this choice
  --open-qr         open pairing.png in Preview after pairing
  --no-build        do not build relay/collector before starting
  -h, --help        show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pair) PAIR=1; shift ;;
    --install-hooks) INSTALL_HOOKS=1; shift ;;
    --watch-codex) CODEX_CHOICE=1; shift ;;
    --no-watch-codex) CODEX_CHOICE=0; shift ;;
    --configure-usage) CONFIGURE_USAGE=1; shift ;;
    --watch-usage) USAGE_CHOICE=1; shift ;;
    --no-watch-usage) USAGE_CHOICE=0; shift ;;
    --approval-bridge) APPROVAL_CHOICE=1; INSTALL_HOOKS=1; shift ;;
    --no-approval-bridge) APPROVAL_CHOICE=0; INSTALL_HOOKS=1; shift ;;
    --open-qr) OPEN_QR=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

NO_BUILD="${NO_BUILD:-0}"
mkdir -p "$STATE_DIR/logs" "$STATE_DIR/run"
chmod 700 "$STATE_DIR" 2>/dev/null || true

# Reuse an existing generated env file so the Relay secret remains stable.
read_monitor_env() {
  "$PYTHON_BIN" "$PAIR_HELPER" --state-dir "$STATE_DIR" --read-env "$1"
}

# Do not silently start a second Collector against the same IPC socket. Probe
# only by connecting and closing; the existing process receives no command.
COLLECTOR_SOCKET_PATH="${COLLECTOR_SOCKET_PATH:-$(read_monitor_env COLLECTOR_SOCKET_PATH)}"
COLLECTOR_SOCKET_PATH="${COLLECTOR_SOCKET_PATH:-$STATE_DIR/collector.sock}"
check_collector_socket() {
  local result=0
  "$PYTHON_BIN" - "$COLLECTOR_SOCKET_PATH" <<'PY' || result=$?
import errno
import socket
import sys

path = sys.argv[1]
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(0.5)
try:
    client.connect(path)
except OSError as error:
    if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
        raise SystemExit(0)
    print("Unable to verify the configured Collector socket safely; refusing to start.", file=sys.stderr)
    raise SystemExit(2)
else:
    print("A Collector is already listening on the configured socket. Stop it before starting this launcher.", file=sys.stderr)
    raise SystemExit(1)
finally:
    client.close()
PY
  case "$result" in
    0) return 0 ;;
    1|2) return "$result" ;;
    *) printf 'Unable to verify the configured Collector socket safely; refusing to start.\n' >&2; return 2 ;;
  esac
}

if ! check_collector_socket; then
  exit 1
fi

# Resolve preferences only after the duplicate-Collector guard. Pairing may
# rewrite monitor.env, so persistent watcher choices live in their own files.
WATCH_PREFERENCE_HELPER="$ROOT/scripts/usage-preference.py"
if [[ -n "$CODEX_CHOICE" ]]; then
  WATCH_CODEX="$CODEX_CHOICE"
  if ! "$PYTHON_BIN" "$WATCH_PREFERENCE_HELPER" --state-dir "$STATE_DIR" --feature codex --write "$CODEX_CHOICE"; then
    printf 'Codex choice applies to this launch only; it could not be saved.\n' >&2
  fi
elif [[ -n "${COLLECTOR_WATCH_CODEX:-}" ]]; then
  case "$COLLECTOR_WATCH_CODEX" in
    0|1) WATCH_CODEX="$COLLECTOR_WATCH_CODEX" ;;
    *) printf 'COLLECTOR_WATCH_CODEX must be 0 or 1.\n' >&2; exit 2 ;;
  esac
else
  SAVED_CODEX=""
  if ! SAVED_CODEX="$("$PYTHON_BIN" "$WATCH_PREFERENCE_HELPER" --state-dir "$STATE_DIR" --feature codex)"; then
    printf 'Codex preference is unavailable; Codex watching stays disabled for this launch.\n' >&2
  elif [[ -n "$SAVED_CODEX" ]]; then
    WATCH_CODEX="$SAVED_CODEX"
  fi
fi

if [[ -n "$USAGE_CHOICE" ]]; then
  WATCH_USAGE="$USAGE_CHOICE"
  if ! "$PYTHON_BIN" "$WATCH_PREFERENCE_HELPER" --state-dir "$STATE_DIR" --write "$USAGE_CHOICE"; then
    printf 'Usage choice applies to this launch only; it could not be saved.\n' >&2
  fi
elif [[ -n "${COLLECTOR_WATCH_USAGE:-}" ]]; then
  case "$COLLECTOR_WATCH_USAGE" in
    0|1) WATCH_USAGE="$COLLECTOR_WATCH_USAGE" ;;
    *) printf 'COLLECTOR_WATCH_USAGE must be 0 or 1.\n' >&2; exit 2 ;;
  esac
else
  SAVED_USAGE=""
  USAGE_PREFERENCE_VALID=1
  if ! SAVED_USAGE="$("$PYTHON_BIN" "$WATCH_PREFERENCE_HELPER" --state-dir "$STATE_DIR")"; then
    USAGE_PREFERENCE_VALID=0
  fi
  if [[ "$USAGE_PREFERENCE_VALID" -eq 0 ]]; then
    printf 'Usage preference is unavailable; Usage stays disabled for this launch.\n' >&2
  elif [[ -n "$SAVED_USAGE" ]]; then
    WATCH_USAGE="$SAVED_USAGE"
  elif [[ "$CONFIGURE_USAGE" -eq 1 && -t 0 ]]; then
    printf 'Usage reads local Claude/Codex transcripts and sends only token totals.\n'
    printf 'The private ledger keeps its first-enable start; historical usage is not backfilled.\n'
    while true; do
      ANSWER=""
      if ! read -r -p 'Enable Usage monitoring and save this preference? [y/N] ' ANSWER; then
        printf '\nUsage preference was not saved.\n'
        break
      fi
      case "$ANSWER" in
        y|Y|yes|YES) WATCH_USAGE=1 ;;
        n|N|no|NO|'') WATCH_USAGE=0 ;;
        *) printf 'Please enter y or n.\n'; continue ;;
      esac
      if ! "$PYTHON_BIN" "$WATCH_PREFERENCE_HELPER" --state-dir "$STATE_DIR" --write "$WATCH_USAGE"; then
        printf 'Usage choice applies to this launch only; it could not be saved.\n' >&2
      fi
      break
    done
  else
    printf 'Usage has not been configured; it stays disabled. Enable and save it with:\n'
    printf '  "%s/scripts/start-lan-monitor.sh" --watch-usage\n' "$ROOT"
  fi
fi

RELAY_BOOTSTRAP_SECRET="${RELAY_BOOTSTRAP_SECRET:-$(read_monitor_env RELAY_BOOTSTRAP_SECRET)}"
COLLECTOR_INSTALLATION_ID="${COLLECTOR_INSTALLATION_ID:-$(read_monitor_env COLLECTOR_INSTALLATION_ID)}"
COLLECTOR_RELAY_TOKEN="${COLLECTOR_RELAY_TOKEN:-$(read_monitor_env COLLECTOR_RELAY_TOKEN)}"
COLLECTOR_RELAY_URL="${COLLECTOR_RELAY_URL:-$(read_monitor_env COLLECTOR_RELAY_URL)}"
RELAY_DB_PATH="${RELAY_DB_PATH:-$(read_monitor_env RELAY_DB_PATH)}"

BOOTSTRAP_SECRET="${RELAY_BOOTSTRAP_SECRET:-}"
if [[ -z "$BOOTSTRAP_SECRET" ]]; then
  SECRET_FILE="$STATE_DIR/bootstrap.secret"
  if [[ -s "$SECRET_FILE" ]]; then
    BOOTSTRAP_SECRET="$(<"$SECRET_FILE")"
  else
    BOOTSTRAP_SECRET="$(openssl rand -hex 32)"
    printf '%s\n' "$BOOTSTRAP_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
fi

LAN_IP="${RELAY_LAN_IP:-}"
if [[ -z "$LAN_IP" ]]; then
  for interface in en1 en0; do
    LAN_IP="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
    [[ -n "$LAN_IP" ]] && break
  done
fi
[[ -n "$LAN_IP" ]] || { printf 'Could not determine Mac LAN address. Set RELAY_LAN_IP.\n' >&2; exit 1; }

PUBLIC_URL="${RELAY_PUBLIC_URL:-http://$LAN_IP:$PORT}"
DB_PATH="${RELAY_DB_PATH:-$STATE_DIR/relay.sqlite}"
RELAY_HTTP_LOCAL="http://127.0.0.1:$PORT"
RELAY_WS_LAN="ws://$LAN_IP:$PORT/ws/collector"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$COLLECTOR_PID" ]]; then
    if kill -0 "$COLLECTOR_PID" 2>/dev/null; then kill -TERM "$COLLECTOR_PID" 2>/dev/null || true; fi
    wait "$COLLECTOR_PID" 2>/dev/null || true
  fi
  if [[ "$RELAY_STARTED" -eq 1 && -n "$RELAY_PID" ]]; then
    if kill -0 "$RELAY_PID" 2>/dev/null; then kill -TERM "$RELAY_PID" 2>/dev/null || true; fi
    wait "$RELAY_PID" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$NO_BUILD" -eq 0 ]]; then
  npm --prefix "$ROOT/services/relay" run build
  npm --prefix "$ROOT/services/collector" run build
fi

if ! "$CURL_BIN" --fail --silent --max-time 2 "$RELAY_HTTP_LOCAL/healthz" >/dev/null 2>&1; then
  RELAY_HOST=0.0.0.0 \
  RELAY_PORT="$PORT" \
  RELAY_PUBLIC_URL="$PUBLIC_URL" \
  RELAY_BOOTSTRAP_SECRET="$BOOTSTRAP_SECRET" \
  RELAY_DB_PATH="$DB_PATH" \
    "$NODE_BIN" "$ROOT/services/relay/dist/src/index.js" >> "$STATE_DIR/logs/relay.log" 2>&1 &
  RELAY_PID=$!
  RELAY_STARTED=1
  for _ in {1..30}; do
    "$CURL_BIN" --fail --silent --max-time 1 "$RELAY_HTTP_LOCAL/healthz" >/dev/null 2>&1 && break
    sleep 1
  done
fi
"$CURL_BIN" --fail --silent --max-time 2 "$RELAY_HTTP_LOCAL/healthz" >/dev/null 2>&1 || {
  printf 'Relay did not become healthy. See %s/logs/relay.log\n' "$STATE_DIR" >&2
  exit 1
}

HEALTH_JSON="$("$CURL_BIN" --fail --silent --max-time 2 "$RELAY_HTTP_LOCAL/healthz")" || exit 1
if ! "$PYTHON_BIN" - "$HEALTH_JSON" <<'PY'
import json,sys
try:
    value=json.loads(sys.argv[1])
    caps=value.get("capabilities")
    okay=(value.get("service")=="relay" and value.get("storage")=="sqlite"
          and value.get("auth",{}).get("mode")=="paired"
          and isinstance(caps,list)
          and {"usage_snapshot_v1","pairing_collector_reuse_v1"}.issubset(caps))
except (ValueError,AttributeError,TypeError):
    okay=False
raise SystemExit(0 if okay else 1)
PY
then
  printf 'Relay on port %s is an older or incompatible instance. Stop that instance explicitly, then rerun this command. It was left running.\n' "$PORT" >&2
  exit 1
fi

PAIR_ARGS=(--state-dir "$STATE_DIR" --relay-http "$RELAY_HTTP_LOCAL" --relay-ws "$RELAY_WS_LAN" --public-url "$PUBLIC_URL" --db-path "$DB_PATH")
if [[ "$PAIR" -eq 1 ]]; then PAIR_ARGS+=(--force-new); fi
PAIR_RESULT="$(RELAY_BOOTSTRAP_SECRET="$BOOTSTRAP_SECRET" "$PYTHON_BIN" "$PAIR_HELPER" "${PAIR_ARGS[@]}" --json)" || {
  printf 'Pairing state could not be safely validated or refreshed. Check the status message above; no old QR was displayed.\n' >&2
  exit 1
}
PAIRING_EXPIRES_AT="$("$PYTHON_BIN" -c 'import json,sys; print(json.loads(sys.argv[1])["expires_at"])' "$PAIR_RESULT")"
PAIRING_QR="$STATE_DIR/pairing.png"

COLLECTOR_RELAY_URL="$(read_monitor_env COLLECTOR_RELAY_URL)"
COLLECTOR_RELAY_TOKEN="$(read_monitor_env COLLECTOR_RELAY_TOKEN)"
COLLECTOR_INSTALLATION_ID="$(read_monitor_env COLLECTOR_INSTALLATION_ID)"
APPROVAL_BRIDGE="$(read_monitor_env COLLECTOR_APPROVAL_BRIDGE)"
if [[ -n "$APPROVAL_CHOICE" ]]; then APPROVAL_BRIDGE="$APPROVAL_CHOICE"; fi
if [[ "$APPROVAL_BRIDGE" != "1" ]]; then APPROVAL_BRIDGE=0; fi

COLLECTOR_RELAY_URL="${COLLECTOR_RELAY_URL:-$RELAY_WS_LAN}"
COLLECTOR_RELAY_TOKEN="${COLLECTOR_RELAY_TOKEN:-}"
COLLECTOR_INSTALLATION_ID="${COLLECTOR_INSTALLATION_ID:-}"
[[ -n "$COLLECTOR_RELAY_TOKEN" && -n "$COLLECTOR_INSTALLATION_ID" ]] || {
  printf 'Pairing is incomplete; run with --pair.\n' >&2
  exit 1
}

if [[ "$INSTALL_HOOKS" -eq 1 ]]; then
  INSTALL_ARGS=(--state-dir "$STATE_DIR" --socket "$COLLECTOR_SOCKET_PATH" --no-launchd --no-load)
  if [[ "$APPROVAL_BRIDGE" == "1" ]]; then INSTALL_ARGS+=(--approval-bridge); else INSTALL_ARGS+=(--no-approval-bridge); fi
  "$ROOT/skills/claude-monitor/scripts/install" "${INSTALL_ARGS[@]}"
fi

COLLECTOR_ARGS=(--collector)
if [[ "$WATCH_CODEX" == "1" ]]; then
  COLLECTOR_ARGS+=(--watch-codex)
fi
if [[ "$WATCH_USAGE" == "1" ]]; then
  COLLECTOR_ARGS+=(--watch-usage)
fi

# Recheck immediately before spawn to catch a Collector started during pairing
# or hook installation. This is deliberately not a payload-bearing IPC probe.
if ! check_collector_socket; then
  exit 1
fi

COLLECTOR_RELAY_URL="$COLLECTOR_RELAY_URL" \
COLLECTOR_RELAY_TOKEN="$COLLECTOR_RELAY_TOKEN" \
COLLECTOR_INSTALLATION_ID="$COLLECTOR_INSTALLATION_ID" \
COLLECTOR_WATCH_CODEX="$WATCH_CODEX" \
COLLECTOR_WATCH_USAGE="$WATCH_USAGE" \
COLLECTOR_APPROVAL_BRIDGE="$APPROVAL_BRIDGE" \
COLLECTOR_DATA_DIR="${COLLECTOR_DATA_DIR:-$STATE_DIR}" \
COLLECTOR_SOCKET_PATH="$COLLECTOR_SOCKET_PATH" \
  "$NODE_BIN" "$ROOT/services/collector/dist/cli.js" "${COLLECTOR_ARGS[@]}" \
  >> "$STATE_DIR/logs/collector.log" 2>&1 &
COLLECTOR_PID=$!

if [[ "$OPEN_QR" -eq 1 && -f "$PAIRING_QR" ]]; then
  open "$PAIRING_QR" >/dev/null 2>&1 || true
fi
if [[ "$WATCH_USAGE" == "1" ]]; then
  printf 'Usage monitoring: enabled (local read-only transcripts; private response ledger)\n'
else
  printf 'Usage monitoring: disabled\n'
fi

printf '\nClaude Phone Monitor is running on the trusted LAN.\n'
printf 'Relay: %s\n' "$PUBLIC_URL"
printf 'Pairing QR: %s (valid until %s; refresh an expired QR with --pair)\n' "$PAIRING_QR" "$PAIRING_EXPIRES_AT"
printf 'Collector log: %s/logs/collector.log\n' "$STATE_DIR"
if [[ "$WATCH_CODEX" == "1" ]]; then
  printf 'Codex session monitoring: enabled (read-only; no Codex config or hooks changed)\n'
else
  printf 'Codex session monitoring: disabled\n'
fi
printf 'Press Ctrl-C to stop processes started by this script.\n\n'
wait "$COLLECTOR_PID"
