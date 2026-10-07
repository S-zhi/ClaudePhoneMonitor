#!/bin/bash
# Fixture-only integration tests for the macOS helper scripts.
# Every settings path is under mktemp; this test never reads or writes ~/.claude.

set -u
set -o pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/claude-monitor-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
mkdir -p "$HOME"

SETTINGS="$TMP/settings.json"
STATE="$TMP/state"
AGENTS="$TMP/LaunchAgents"
ADAPTER_DIR="$TMP/adapter dir"
ADAPTER="$ADAPTER_DIR/hook adapter.js"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
assert() {
  "$@" || fail "assertion failed: $*"
}

# A fixture adapter consumes stdin and fails. The generated `|| true` must still
# make the hook command return success, including when the adapter path has spaces.
mkdir -p "$ADAPTER_DIR"
printf '%s\n' 'process.stdin.resume(); process.stdin.on("end", () => process.exit(37));' > "$ADAPTER"
printf '%s\n' '{"permissions":{"allow":["Bash(*)"]},"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"echo unrelated"},{"type":"command","command":"echo marker text claude-phone-monitor:v1"}]}],"Stop":[{"hooks":[{"type":"command","command":"echo keep"}]}]},"customSetting":{"keep":true}}' > "$SETTINGS"

"$SCRIPTS/install" \
  --settings "$SETTINGS" \
  --state-dir "$STATE" \
  --launch-agents-dir "$AGENTS" \
  --adapter "$ADAPTER" \
  --no-load >/dev/null || fail "install"

python3 - "$SETTINGS" "$STATE" "$AGENTS" <<'PY'
import json
import pathlib
import sys
settings, state, agents = map(pathlib.Path, sys.argv[1:])
data = json.loads(settings.read_text())
assert data["customSetting"] == {"keep": True}
assert data["hooks"]["SessionStart"][0]["hooks"][0]["command"] == "echo unrelated"
assert data["hooks"]["SessionStart"][0]["hooks"][1]["command"] == "echo marker text claude-phone-monitor:v1"
assert sum(len(group.get("hooks", [])) for groups in data["hooks"].values() for group in groups) == 13
owned = [hook["command"] for groups in data["hooks"].values() for group in groups for hook in group.get("hooks", []) if "# claude-phone-monitor:v1" in hook.get("command", "")]
assert len(owned) == 10, owned
assert set(data["hooks"]) >= {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd"}
assert all("--event " in command and "|| true # claude-phone-monitor:v1" in command for command in owned)
assert all("--approval-bridge" not in command for command in owned)
assert (state / "launchd.template.plist").is_file()
plist = (agents / "com.claude.phone-monitor.plist").read_text()
assert "__CM_" not in plist
assert "claude-phone-monitor:v1" in plist
PY

# Opt-in changes only PermissionRequest. Private custom socket and bridge mode
# survive reinstall; explicit off restores short, telemetry-only handlers.
BRIDGE_SETTINGS="$TMP/bridge-settings.json"
BRIDGE_STATE="$TMP/bridge-state"
BRIDGE_SOCKET="$TMP/private socket.sock"
"$SCRIPTS/monitor-setup" install --settings "$BRIDGE_SETTINGS" --state-dir "$BRIDGE_STATE" \
  --socket "$BRIDGE_SOCKET" --adapter "$ADAPTER" --no-launchd --approval-bridge >/dev/null || fail "bridge install"
python3 - "$BRIDGE_SETTINGS" "$BRIDGE_STATE" "$BRIDGE_SOCKET" <<'PY' || fail "bridge hook configuration"
import json,pathlib,shlex,sys
settings,state,socket=sys.argv[1:]
socket=str(pathlib.Path(socket).resolve())
hooks=json.loads(pathlib.Path(settings).read_text())["hooks"]
for event,groups in hooks.items():
    owned=[h for g in groups for h in g["hooks"] if h["command"].endswith("# claude-phone-monitor:v1")]
    assert len(owned)==1
    command=shlex.split(owned[0]["command"])
    assert pathlib.Path(command[command.index("--socket")+1]).resolve()==pathlib.Path(socket)
    assert ("--approval-bridge" in command)==(event=="PermissionRequest")
    assert owned[0]["timeout"]==(610 if event=="PermissionRequest" else 5)
assert json.loads((pathlib.Path(state)/"install.json").read_text())["approval_bridge"] is True
PY
"$SCRIPTS/install" --settings "$BRIDGE_SETTINGS" --state-dir "$BRIDGE_STATE" --adapter "$ADAPTER" --no-launchd >/dev/null || fail "bridge reinstall"
python3 - "$BRIDGE_SETTINGS" "$BRIDGE_STATE" "$BRIDGE_SOCKET" <<'PY' || fail "bridge preference preservation"
import json,pathlib,shlex,sys
settings,state,socket=sys.argv[1:]
socket=str(pathlib.Path(socket).resolve())
h=json.loads(pathlib.Path(settings).read_text())["hooks"]["PermissionRequest"][0]["hooks"][0]
assert "--approval-bridge" in h["command"]
command=shlex.split(h["command"])
assert pathlib.Path(command[command.index("--socket")+1]).resolve()==pathlib.Path(socket)
assignments={line.split("=",1)[0]:shlex.split(line.split("=",1)[1])[0] for line in (pathlib.Path(state)/"monitor.env").read_text().splitlines() if "=" in line and not line.startswith("#")}
assert assignments["COLLECTOR_APPROVAL_BRIDGE"]=="1"
assert pathlib.Path(assignments["COLLECTOR_SOCKET_PATH"]).resolve()==pathlib.Path(socket)
PY
"$SCRIPTS/install" --settings "$BRIDGE_SETTINGS" --state-dir "$BRIDGE_STATE" --adapter "$ADAPTER" --no-launchd --no-approval-bridge >/dev/null || fail "bridge disable"
python3 - "$BRIDGE_SETTINGS" "$BRIDGE_STATE" <<'PY' || fail "bridge disabled configuration"
import json,pathlib,sys
settings,state=map(pathlib.Path,sys.argv[1:])
hooks=json.loads(settings.read_text())["hooks"]
assert all("--approval-bridge" not in h["command"] and h["timeout"]==5 for groups in hooks.values() for g in groups for h in g["hooks"])
assert json.loads((state/"install.json").read_text())["approval_bridge"] is False
PY

# Idempotence: the second install does not duplicate owned entries or alter the
# unrelated marker-looking command.
"$SCRIPTS/install" \
  --settings "$SETTINGS" \
  --state-dir "$STATE" \
  --launch-agents-dir "$AGENTS" \
  --adapter "$ADAPTER" \
  --no-load >/dev/null || fail "second install"
python3 - "$SETTINGS" <<'PY'
import json
import pathlib
import sys
data = json.loads(pathlib.Path(sys.argv[1]).read_text())
owned = [hook for groups in data["hooks"].values() for group in groups for hook in group.get("hooks", []) if hook.get("command", "").endswith("# claude-phone-monitor:v1")]
assert len(owned) == 10, len(owned)
assert any(hook.get("command") == "echo marker text claude-phone-monitor:v1" for group in data["hooks"]["SessionStart"] for hook in group["hooks"])
PY

# Execute one generated hook command with a failing adapter and JSON stdin.
COMMAND="$(python3 - "$SETTINGS" <<'PY'
import json
import pathlib
import sys
data=json.loads(pathlib.Path(sys.argv[1]).read_text())
print(next(h["command"] for group in data["hooks"]["SessionStart"] for h in group["hooks"] if "# claude-phone-monitor:v1" in h.get("command", "")))
PY
)"
printf '%s\n' '{"session_id":"fixture"}' | /bin/sh -c "$COMMAND" || fail "hook was not fail-open"

CODE1="$($SCRIPTS/pair --development --state-dir "$STATE" --code TEST1234 --json)" || fail "pair"
CODE2="$($SCRIPTS/pair --development --state-dir "$STATE" --json)" || fail "idempotent pair"
python3 - "$CODE1" "$CODE2" "$STATE/pairing.json" <<'PY'
import json
import pathlib
import sys
a, b, record_path = sys.argv[1:]
a = json.loads(a)
b = json.loads(b)
record = pathlib.Path(record_path)
assert a["code"] == b["code"] == "TEST1234"
assert b["development"] is True
assert json.loads(record.read_text())["code"] == "TEST1234"
PY

STATUS="$("$SCRIPTS/status" --settings "$SETTINGS" --state-dir "$STATE" --launch-agents-dir "$AGENTS" --json)" || fail "status"
python3 - "$STATUS" <<'PY'
import json,sys
value=json.loads(sys.argv[1])
assert value["installed"] is True
assert value["hooks"]["count"] == 10
assert value["pairing"]["code"] == "******34"
assert value["launchd"]["plist_exists"] is True
PY

"$SCRIPTS/doctor" --settings "$SETTINGS" --state-dir "$STATE" --launch-agents-dir "$AGENTS" --strict >/dev/null || fail "doctor"
"$SCRIPTS/monitor-daemon" --state-dir "$STATE" --once || fail "daemon once"

"$SCRIPTS/uninstall" --settings "$SETTINGS" --state-dir "$STATE" --launch-agents-dir "$AGENTS" >/dev/null || fail "uninstall"
python3 - "$SETTINGS" "$AGENTS" <<'PY'
import json
import pathlib
import sys
settings, agents = map(pathlib.Path, sys.argv[1:])
data=json.loads(settings.read_text())
assert data["customSetting"] == {"keep": True}
assert data["hooks"]["SessionStart"][0]["hooks"] == [
    {"type":"command","command":"echo unrelated"},
    {"type":"command","command":"echo marker text claude-phone-monitor:v1"},
]
assert data["hooks"]["Stop"][0]["hooks"] == [{"type":"command","command":"echo keep"}]
assert not (agents / "com.claude.phone-monitor.plist").exists()
PY
# Uninstall is idempotent too.
"$SCRIPTS/uninstall" --settings "$SETTINGS" --state-dir "$STATE" --launch-agents-dir "$AGENTS" >/dev/null || fail "second uninstall"

python3 "$ROOT/tests/test_real_pair.py" || fail "real pairing helper fixtures"
python3 "$ROOT/tests/test_start_lan_monitor.py" || fail "launcher fixtures"

printf 'PASS: claude-monitor temp-fixture tests\n'
