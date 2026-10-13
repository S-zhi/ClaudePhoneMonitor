#!/usr/bin/env bash
# Standalone Magpie runtime entrypoint. Keep this environment separate from the original monitor.
set -Eeuo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export PATH="${PATH:+$PATH:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
STATE_DIR="${MAGPIE_MONITOR_HOME:-$HOME/.claude-phone-monitor-magpie}"
PORT="${MAGPIE_RELAY_PORT:-8788}"
LAN_IP="${MAGPIE_RELAY_LAN_IP:-}"
MAGPIE_BIN="${MAGPIE_BIN:-magpie}"

usage() {
  cat <<'USAGE'
Usage: scripts/start-magpie-monitor.sh [--check] [--pair] [--open-qr] [--watch-codex|--no-watch-codex]

Starts the standalone Magpie Relay and Collector on a trusted LAN. Magpie
session metadata and native Codex activity watching are enabled by default.
State: ~/.claude-phone-monitor-magpie; Relay port: 8788.

--check            read-only prerequisite and installed-dependency check
--pair             create a fresh one-time pairing QR
--open-qr          open the pairing QR after startup
--watch-codex      enable and remember native Codex watching
--no-watch-codex   disable and remember native Codex watching
-h, --help        show this help

Overrides: MAGPIE_MONITOR_HOME, MAGPIE_RELAY_PORT, MAGPIE_RELAY_LAN_IP,
MAGPIE_BIN. No Claude Hooks or service settings are installed.
USAGE
}

CHECK=0
CODEX_CHOICE=""
FORWARD=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --check) CHECK=1 ;;
    --pair|--open-qr) FORWARD+=("$arg") ;;
    --watch-codex|--no-watch-codex) CODEX_CHOICE="$arg" ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { printf 'MAGPIE_RELAY_PORT must be a valid port.\n' >&2; exit 2; }
[[ "$PORT" != 8787 ]] || { printf 'Port 8787 belongs to the original monitor; choose another port.\n' >&2; exit 2; }
[[ "$STATE_DIR" = /* ]] || { printf 'MAGPIE_MONITOR_HOME must be an absolute path.\n' >&2; exit 2; }
command -v python3 >/dev/null || { printf 'Python 3 is required.\n' >&2; exit 1; }
python3 - "$STATE_DIR" "$HOME/.claude-phone-monitor" "${CLAUDE_PHONE_MONITOR_HOME:-}" <<'PY' || { printf 'Magpie state must not overlap the original monitor state; choose a separate directory.\n' >&2; exit 2; }
import os
import sys
magpie_state = os.path.realpath(sys.argv[1])
original_states = [os.path.realpath(path) for path in sys.argv[2:] if path]
def overlaps(left, right):
    common = os.path.commonpath((left, right))
    return common == left or common == right
raise SystemExit(1 if any(overlaps(magpie_state, original) for original in original_states) else 0)
PY

node_check() {
  node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number); process.exit(major===24 && (minor>13 || minor===13 && patch>=0) ? 0 : 1)' 2>/dev/null
}

runtime_check() {
  node - "$ROOT" <<'NODE'
const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const root = process.argv[2];
const requiredFiles = [
  'packages/protocol/dist/index.js',
  'services/collector/dist/cli.js',
  'services/relay/dist/src/index.js',
];
for (const file of requiredFiles) {
  if (!existsSync(path.join(root, file))) {
    console.error(`Compiled runtime file is missing: ${file}`);
    process.exit(1);
  }
}
const fromRelay = createRequire(path.join(root, 'services/relay/package.json'));
for (const dependency of ['fastify', '@fastify/websocket', 'ws']) {
  try {
    fromRelay(dependency);
  } catch (error) {
    console.error(`Cannot load Relay runtime dependency ${dependency}: ${error.message}`);
    process.exit(1);
  }
}
NODE
}

require_runtime() {
  runtime_check || {
    printf 'Magpie runtime files or Relay production dependencies are missing. Run scripts/setup-magpie-monitor.sh while online, then retry.\n' >&2
    return 1
  }
}

if [[ "$CHECK" -eq 1 ]]; then
  command -v node >/dev/null && node_check || { printf 'Node 24.13.0 through 24.x is required.\n' >&2; exit 1; }
  for tool in npm python3 curl openssl swift "$MAGPIE_BIN"; do
    command -v "$tool" >/dev/null || { printf 'Missing prerequisite: %s\n' "$tool" >&2; exit 1; }
  done
  require_runtime || exit 1
  printf 'Magpie runtime prerequisites are present. State: %s; port: %s\n' "$STATE_DIR" "$PORT"
  exit 0
fi

command -v node >/dev/null && node_check || { printf 'Node 24.13.0 through 24.x is required.\n' >&2; exit 1; }
command -v "$MAGPIE_BIN" >/dev/null || { printf 'Magpie CLI is required for session metadata.\n' >&2; exit 1; }
require_runtime || exit 1
python3 - "$PORT" <<'PY' || { printf 'The Magpie port is already in use; choose another MAGPIE_RELAY_PORT or stop that service explicitly.\n' >&2; exit 1; }
import socket
import sys
with socket.socket() as client:
    client.settimeout(0.3)
    raise SystemExit(1 if client.connect_ex(('127.0.0.1', int(sys.argv[1]))) == 0 else 0)
PY

if [[ -z "$CODEX_CHOICE" ]]; then
  SAVED="$(python3 "$ROOT/scripts/usage-preference.py" --state-dir "$STATE_DIR" --feature codex 2>/dev/null || true)"
  if [[ -z "$SAVED" ]]; then CODEX_CHOICE=--watch-codex; fi
fi
if [[ -n "$CODEX_CHOICE" ]]; then FORWARD+=("$CODEX_CHOICE"); fi

# env -i prevents original Relay/Collector credentials, socket, DB, URLs and
# watcher settings from crossing into this independent runtime.
exec env -i HOME="$HOME" USER="${USER:-}" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  CLAUDE_PHONE_MONITOR_HOME="$STATE_DIR" RELAY_PORT="$PORT" RELAY_LAN_IP="$LAN_IP" \
  COLLECTOR_WATCH_MAGPIE_SESSIONS=1 COLLECTOR_MAGPIE_BIN="$MAGPIE_BIN" \
  "$ROOT/scripts/start-lan-monitor.sh" --no-build "${FORWARD[@]}"
