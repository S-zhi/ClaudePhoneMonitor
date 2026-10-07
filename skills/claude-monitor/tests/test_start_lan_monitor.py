import datetime
import http.server
import json
import os
import pty
from pathlib import Path
import shutil
import shlex
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts/start-lan-monitor.sh"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class HealthHandler(http.server.BaseHTTPRequestHandler):
    compatible = False
    pair_requests = 0
    pairing = None

    def log_message(self, *_args):
        pass

    def _send(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/healthz":
            body = {"status": "ok", "service": "relay", "storage": "sqlite", "auth": {"mode": "paired"}}
            if type(self).compatible:
                body["capabilities"] = ["usage_snapshot_v1", "pairing_collector_reuse_v1"]
            return self._send(200, body)
        if self.path == "/v1/pairing/fixture-pair" and type(self).pairing:
            return self._send(200, {**type(self).pairing, "status": "pending"})
        return self._send(404, {})

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size))
        if self.path == "/v1/collector-token/validate":
            return self._send(200, {"valid": True, "installation_id": body["installation_id"]})
        if self.path == "/v1/pairing":
            type(self).pair_requests += 1
            public = urllib.parse.urlparse(body["public_url"])
            ws_origin = urllib.parse.urlunparse(public._replace(scheme="wss" if public.scheme == "https" else "ws", path="", params="", query="", fragment=""))
            android_ws = urllib.parse.urlunparse(public._replace(scheme="wss" if public.scheme == "https" else "ws", path="/ws/android", params="", query="", fragment=""))
            payload = json.dumps({
                "version": 1,
                "relay_http_url": body["public_url"],
                "relay_ws_url": android_ws,
                "pairing_id": "fixture-pair",
                "pairing_code": "TESTCODE",
                "installation_id": body["installation_id"],
            }, separators=(",", ":"))
            expiry = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
            type(self).pairing = {
                "pairing_id": "fixture-pair", "code": "TESTCODE", "expires_at": expiry,
                "qr_payload": payload, "collector_token": "collector-fixture-token-123456789",
                "installation_id": body["installation_id"], "ws_url": ws_origin,
            }
            return self._send(201, type(self).pairing)
        return self._send(404, {})


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class StartLanMonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "state with spaces"
        self.pid_dir = self.root / "pids"
        self.pid_dir.mkdir()
        HealthHandler.compatible = False
        HealthHandler.pair_requests = 0
        HealthHandler.pairing = None

    def tearDown(self):
        self.temp.cleanup()

    def _env(self, port):
        python = sys.executable
        env = os.environ.copy()
        env.pop("COLLECTOR_WATCH_USAGE", None)
        env.pop("COLLECTOR_WATCH_CODEX", None)
        env.update({
            "CLAUDE_PHONE_MONITOR_HOME": str(self.state),
            "CLAUDE_PHONE_MONITOR_SETTINGS": str(self.root / "settings.json"),
            "RELAY_PORT": str(port),
            "RELAY_LAN_IP": "192.0.2.20",
            "NO_BUILD": "1",
            "NODE_BIN": str(self.root / "fake-node"),
            "PYTHON_BIN": python,
            "CURL_BIN": shutil.which("curl") or "/usr/bin/curl",
            "FAKE_RELAY_SERVER": str(self.root / "fake-relay.py"),
            "FAKE_PID_DIR": str(self.pid_dir),
            "CLAUDE_PHONE_MONITOR_SWIFT_BIN": str(self.root / "fake-swift"),
        })
        return env

    def _write_fake_programs(self):
        server = r'''import datetime,json,sys,urllib.parse
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
class H(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def send(self,status,obj):
  data=json.dumps(obj).encode(); self.send_response(status); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
 def do_GET(self):
  if self.path=="/healthz": return self.send(200,{"status":"ok","service":"relay","storage":"sqlite","auth":{"mode":"paired"},"capabilities":["usage_snapshot_v1","pairing_collector_reuse_v1"]})
  return self.send(404,{})
 def do_POST(self):
  n=int(self.headers.get("Content-Length","0")); b=json.loads(self.rfile.read(n))
  if self.path!="/v1/pairing": return self.send(404,{})
  p=urllib.parse.urlparse(b["public_url"]); w=urllib.parse.urlunparse(p._replace(scheme="wss" if p.scheme=="https" else "ws",path="",params="",query="",fragment="")); a=urllib.parse.urlunparse(p._replace(scheme="wss" if p.scheme=="https" else "ws",path="/ws/android",params="",query="",fragment=""))
  q=json.dumps({"version":1,"relay_http_url":b["public_url"],"relay_ws_url":a,"pairing_id":"fake-pair","pairing_code":"TESTCODE","installation_id":b["installation_id"]},separators=(",",":"))
  e=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=10)).isoformat().replace("+00:00","Z")
  return self.send(201,{"pairing_id":"fake-pair","code":"TESTCODE","expires_at":e,"qr_payload":q,"collector_token":"collector-fixture-token-123456789","installation_id":b["installation_id"],"ws_url":w})
HTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()
'''
        (self.root / "fake-relay.py").write_text(server)
        node = f'''#!/bin/bash
if [[ "$1" == *"/services/relay/dist/src/index.js" ]]; then
  echo "$$" > "$FAKE_PID_DIR/relay.pid"
  exec "$PYTHON_BIN" "$FAKE_RELAY_SERVER" "$RELAY_PORT"
fi
echo "$$" > "$FAKE_PID_DIR/collector.pid"
printf '%s' "$COLLECTOR_WATCH_CODEX" > "$FAKE_PID_DIR/codex-choice"
printf '%s\\n' "$@" > "$FAKE_PID_DIR/collector-args"
printf '%s' "$COLLECTOR_WATCH_USAGE" > "$FAKE_PID_DIR/usage-choice"
printf '%s' "$COLLECTOR_APPROVAL_BRIDGE" > "$FAKE_PID_DIR/approval-choice"
printf '%s' "$COLLECTOR_SOCKET_PATH" > "$FAKE_PID_DIR/socket-path"
exec /bin/sleep 120
'''
        node_path = self.root / "fake-node"
        node_path.write_text(node)
        node_path.chmod(0o700)
        swift = self.root / "fake-swift"
        swift.write_text(f'''#!{sys.executable}
import pathlib,sys
pathlib.Path(sys.argv[3]).write_bytes(b"\\x89PNG\\r\\n\\x1a\\nfixture")
''')
        swift.chmod(0o700)

    def test_approval_bridge_opt_in_off_and_custom_socket_survive_relaunch(self):
        self._write_fake_programs()
        HealthHandler.compatible = True
        server = ThreadedServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            selected, _ = self._launch_choice(server.server_port, feature="approval")
            self.assertEqual(selected, "0")
            custom_socket = str((self.root / "private socket.sock").resolve())
            env_path = self.state / "monitor.env"
            env_path.write_text(env_path.read_text() + f"COLLECTOR_SOCKET_PATH={shlex.quote(custom_socket)}\n")
            selected, _ = self._launch_choice(server.server_port, options=("--approval-bridge",), feature="approval")
            self.assertEqual(selected, "1")
            self.assertEqual((self.pid_dir / "socket-path").read_text(), custom_socket)
            hooks = json.loads((self.root / "settings.json").read_text())["hooks"]
            command = hooks["PermissionRequest"][0]["hooks"][0]["command"]
            self.assertIn("--approval-bridge", command)
            words = shlex.split(command)
            self.assertEqual(words[words.index("--socket") + 1], custom_socket)
            selected, _ = self._launch_choice(server.server_port, feature="approval")
            self.assertEqual(selected, "1")
            selected, _ = self._launch_choice(server.server_port, options=("--no-approval-bridge",), feature="approval")
            self.assertEqual(selected, "0")
            hooks = json.loads((self.root / "settings.json").read_text())["hooks"]
            self.assertNotIn("--approval-bridge", hooks["PermissionRequest"][0]["hooks"][0]["command"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def _launch_choice(self, port, options=(), override=None, answer=None, codex_override=None, feature="usage"):
        choice = self.pid_dir / "usage-choice"
        choice.unlink(missing_ok=True)
        (self.pid_dir / "codex-choice").unlink(missing_ok=True)
        (self.pid_dir / "collector-args").unlink(missing_ok=True)
        env = self._env(port)
        if override is not None:
            env["COLLECTOR_WATCH_USAGE"] = override
        if codex_override is not None:
            env["COLLECTOR_WATCH_CODEX"] = codex_override
        master = slave = None
        if answer is not None:
            master, slave = pty.openpty()
        output_path = self.root / "launcher-output"
        with output_path.open("w") as destination:
            process = subprocess.Popen([str(SCRIPT), "--no-build", *options], cwd=ROOT, env=env,
                                       stdin=slave if slave is not None else subprocess.DEVNULL,
                                       stdout=destination, stderr=subprocess.PIPE, text=True)
        if slave is not None:
            os.close(slave)
            os.write(master, (answer + "\n").encode())
        try:
            deadline = time.monotonic() + 10
            started = False
            while time.monotonic() < deadline:
                # Wait for both the fake Collector and the launcher's final status output.
                if (choice.exists() and choice.read_text() in ("0", "1")
                        and "Press Ctrl-C to stop processes started by this script." in output_path.read_text()):
                    started = True
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.02)
            if not started:
                process.terminate()
                _, error = process.communicate(timeout=8)
                self.fail(f"launcher failed to start: {output_path.read_text()} {error}")
            selected = (self.pid_dir / (feature + "-choice")).read_text()
            process.send_signal(signal.SIGINT)
            _, error = process.communicate(timeout=8)
            return selected, output_path.read_text() + error
        finally:
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=8)
            if master is not None:
                os.close(master)

    def test_codex_choice_persists_across_restarts_and_cli_overrides_environment(self):
        self._write_fake_programs()
        HealthHandler.compatible = True
        server = ThreadedServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            selected, _ = self._launch_choice(server.server_port, ["--watch-codex"],
                                              codex_override="0", feature="codex")
            self.assertEqual(selected, "1", "explicit CLI enable wins and saves")
            preference = self.state / "codex.preference"
            self.assertEqual(preference.read_text(), "1\n")
            self.assertEqual(preference.stat().st_mode & 0o777, 0o600)
            self.assertFalse((self.state / "usage.preference").exists(), "watcher choices are independent")
            selected, _ = self._launch_choice(server.server_port, feature="codex")
            self.assertEqual(selected, "1", "ordinary restart keeps the explicit Codex opt-in")
            self.assertIn("--watch-codex", (self.pid_dir / "collector-args").read_text().splitlines())
            selected, _ = self._launch_choice(server.server_port, codex_override="0", feature="codex")
            self.assertEqual(selected, "0", "environment can disable one launch without clearing opt-in")
            self.assertEqual(preference.read_text(), "1\n")
            self.assertNotIn("--watch-codex", (self.pid_dir / "collector-args").read_text().splitlines())
            selected, _ = self._launch_choice(server.server_port, feature="codex")
            self.assertEqual(selected, "1")
            selected, _ = self._launch_choice(server.server_port, ["--no-watch-codex"],
                                              codex_override="1", feature="codex")
            self.assertEqual(selected, "0", "explicit CLI disable wins and saves")
            self.assertEqual(preference.read_text(), "0\n")
            selected, _ = self._launch_choice(server.server_port, feature="codex")
            self.assertEqual(selected, "0", "ordinary restart keeps the explicit disable")
            selected, output = self._launch_choice(server.server_port, codex_override="1", feature="codex")
            self.assertEqual(selected, "1", "environment can enable one launch over a saved disable")
            self.assertEqual(preference.read_text(), "0\n", "environment enable does not change saved disable")
            self.assertIn("--watch-codex", (self.pid_dir / "collector-args").read_text().splitlines())
            self.assertIn("Codex session monitoring: enabled", output)
            selected, _ = self._launch_choice(server.server_port, feature="codex")
            self.assertEqual(selected, "0", "restart still honors the saved disable")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_invalid_codex_environment_is_rejected_without_changing_saved_choice(self):
        self._write_fake_programs()
        self.state.mkdir()
        preference = self.state / "codex.preference"
        preference.write_text("1\n")
        env = self._env(free_port())
        env["COLLECTOR_WATCH_CODEX"] = "true"
        result = subprocess.run([str(SCRIPT), "--no-build"], cwd=ROOT, env=env,
                                text=True, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 2)
        self.assertIn("COLLECTOR_WATCH_CODEX must be 0 or 1.", result.stderr)
        self.assertEqual(preference.read_text(), "1\n")
        self.assertFalse((self.state / "usage.preference").exists())
        self.assertFalse((self.state / "monitor.env").exists())
        self.assertFalse((self.pid_dir / "collector.pid").exists())
        self.assertFalse((self.pid_dir / "relay.pid").exists())

    def test_codex_unconfigured_launch_stays_off_and_environment_is_not_saved(self):
        self._write_fake_programs()
        HealthHandler.compatible = True
        server = ThreadedServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            selected, output = self._launch_choice(server.server_port, ["--watch-usage"], feature="codex")
            self.assertEqual(selected, "0", "Usage opt-in does not opt in to Codex lifecycle monitoring")
            self.assertIn("Codex session monitoring: disabled", output)
            self.assertFalse((self.state / "codex.preference").exists())
            selected, _ = self._launch_choice(server.server_port, codex_override="1", feature="codex")
            self.assertEqual(selected, "1")
            self.assertFalse((self.state / "codex.preference").exists())
            selected, _ = self._launch_choice(server.server_port, feature="codex")
            self.assertEqual(selected, "0")
            self.assertEqual((self.state / "usage.preference").read_text(), "1\n")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_bad_codex_preference_stays_off_and_explicit_choice_repairs_regular_file(self):
        self._write_fake_programs()
        self.state.mkdir()
        preference = self.state / "codex.preference"
        preference.write_text("bad-value\n")
        HealthHandler.compatible = True
        server = ThreadedServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            selected, output = self._launch_choice(server.server_port, feature="codex")
            self.assertEqual(selected, "0")
            self.assertIn("codex_preference_unavailable", output)
            self.assertIn("Claude Phone Monitor is running", output)
            self.assertEqual(preference.read_text(), "bad-value\n")
            selected, _ = self._launch_choice(server.server_port, ["--watch-codex"], feature="codex")
            self.assertEqual(selected, "1")
            self.assertEqual(preference.read_text(), "1\n")
            target = self.root / "unrelated-file"
            target.write_text("keep\n")
            preference.unlink()
            preference.symlink_to(target)
            selected, output = self._launch_choice(server.server_port, ["--watch-codex"], feature="codex")
            self.assertEqual(selected, "1", "explicit runtime choice survives a refused preference write")
            self.assertIn("could not be saved", output)
            self.assertTrue(preference.is_symlink())
            self.assertEqual(target.read_text(), "keep\n")
            selected, output = self._launch_choice(server.server_port, feature="codex")
            self.assertEqual(selected, "0", "unsafe saved preference cannot enable Codex watching")
            self.assertIn("codex_preference_unavailable", output)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_usage_first_interactive_choice_persists_and_environment_only_overrides_one_run(self):
        self._write_fake_programs()
        HealthHandler.compatible = True
        server = ThreadedServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            selected, output = self._launch_choice(server.server_port, ["--configure-usage"], answer="y")
            self.assertEqual(selected, "1")
            self.assertIn("historical usage is not backfilled", output)
            preference = self.state / "usage.preference"
            self.assertEqual(preference.read_text(), "1\n")
            self.assertEqual(preference.stat().st_mode & 0o777, 0o600)
            selected, output = self._launch_choice(server.server_port, ["--configure-usage"])
            self.assertEqual(selected, "1")
            self.assertNotIn("Enable Usage monitoring and save", output)
            selected, _ = self._launch_choice(server.server_port, override="0")
            self.assertEqual(selected, "0")
            self.assertEqual(preference.read_text(), "1\n")
            selected, _ = self._launch_choice(server.server_port)
            self.assertEqual(selected, "1")
            selected, _ = self._launch_choice(server.server_port, ["--no-watch-usage"], override="1")
            self.assertEqual(selected, "0", "explicit CLI disable wins over environment")
            self.assertEqual(preference.read_text(), "0\n")
            selected, _ = self._launch_choice(server.server_port)
            self.assertEqual(selected, "0")
            selected, _ = self._launch_choice(server.server_port, ["--watch-usage"], override="0")
            self.assertEqual(selected, "1", "explicit CLI enable wins and saves")
            self.assertEqual(preference.read_text(), "1\n")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_usage_noninteractive_unconfigured_launch_is_off_and_does_not_save_default(self):
        self._write_fake_programs()
        HealthHandler.compatible = True
        server = ThreadedServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            selected, output = self._launch_choice(server.server_port, ["--configure-usage"])
            self.assertEqual(selected, "0")
            self.assertIn("--watch-usage", output)
            self.assertNotIn("Enable Usage monitoring and save", output)
            self.assertFalse((self.state / "usage.preference").exists())
            selected, _ = self._launch_choice(server.server_port, override="1")
            self.assertEqual(selected, "1")
            self.assertFalse((self.state / "usage.preference").exists())
            selected, _ = self._launch_choice(server.server_port, ["--configure-usage"], answer="n")
            self.assertEqual(selected, "0")
            self.assertEqual((self.state / "usage.preference").read_text(), "0\n")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_bad_usage_preference_does_not_block_monitor_and_explicit_choice_repairs_regular_file(self):
        self._write_fake_programs()
        self.state.mkdir()
        preference = self.state / "usage.preference"
        preference.write_text("bad-value\n")
        HealthHandler.compatible = True
        server = ThreadedServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            selected, output = self._launch_choice(server.server_port, ["--configure-usage"])
            self.assertEqual(selected, "0")
            self.assertIn("usage_preference_unavailable", output)
            self.assertIn("Claude Phone Monitor is running", output)
            self.assertEqual(preference.read_text(), "bad-value\n")
            selected, _ = self._launch_choice(server.server_port, ["--watch-usage"])
            self.assertEqual(selected, "1")
            self.assertEqual(preference.read_text(), "1\n")
            target = self.root / "unrelated-file"
            target.write_text("keep\n")
            preference.unlink()
            preference.symlink_to(target)
            selected, output = self._launch_choice(server.server_port, ["--watch-usage"])
            self.assertEqual(selected, "1", "explicit runtime choice survives a refused preference write")
            self.assertIn("could not be saved", output)
            self.assertTrue(preference.is_symlink())
            self.assertEqual(target.read_text(), "keep\n")
            selected, output = self._launch_choice(server.server_port)
            self.assertEqual(selected, "0", "unsafe saved preference falls back to disabled Usage")
            self.assertIn("usage_preference_unavailable", output)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_legacy_healthy_relay_is_rejected_without_being_killed_or_repaired(self):
        server = ThreadedServer(("127.0.0.1", 0), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_port
        self._write_fake_programs()
        env = self._env(port)
        try:
            result = subprocess.run([str(SCRIPT), "--no-build"], env=env, text=True, capture_output=True, timeout=8)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("older or incompatible instance", result.stderr)
            self.assertEqual(HealthHandler.pair_requests, 0)
            self.assertFalse((self.pid_dir / "relay.pid").exists())
            self.assertTrue(thread.is_alive(), "the unknown existing Relay is left running")
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
                self.assertEqual(response.status, 200)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_live_collector_socket_fails_closed_before_pairing_or_state_changes(self):
        self._write_fake_programs()
        socket_path = self.root / "existing collector.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(socket_path))
        listener.listen()
        listener.settimeout(0.2)
        stopped = threading.Event()
        accepted = []

        def accept_connections():
            while not stopped.is_set():
                try:
                    connection, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                accepted.append(True)
                connection.close()

        thread = threading.Thread(target=accept_connections, daemon=True)
        thread.start()
        env = self._env(free_port())
        env["COLLECTOR_SOCKET_PATH"] = str(socket_path)
        try:
            result = subprocess.run([str(SCRIPT), "--no-build", "--pair", "--install-hooks", "--watch-usage", "--watch-codex"], env=env,
                                    text=True, capture_output=True, timeout=8)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("A Collector is already listening", result.stderr)
            self.assertFalse((self.state / "monitor.env").exists())
            self.assertFalse((self.state / "bootstrap.secret").exists())
            self.assertFalse((self.state / "pairing.json").exists())
            self.assertFalse((self.state / "pairing.png").exists())
            self.assertFalse((self.state / "usage.preference").exists())
            self.assertFalse((self.state / "codex.preference").exists())
            self.assertFalse((self.pid_dir / "collector.pid").exists())
            self.assertFalse((self.pid_dir / "relay.pid").exists())
            self.assertEqual(HealthHandler.pair_requests, 0)

            # The guard sent no protocol payload and left the old service alive.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(1)
                client.connect(str(socket_path))
            self.assertTrue(thread.is_alive())
            accept_deadline = time.monotonic() + 1
            while len(accepted) < 2 and time.monotonic() < accept_deadline:
                time.sleep(0.01)
            self.assertGreaterEqual(len(accepted), 2)
        finally:
            stopped.set()
            listener.close()
            thread.join(timeout=2)

    def test_launcher_owns_direct_node_pids_and_stops_only_those_processes(self):
        self._write_fake_programs()
        port = free_port()
        process = subprocess.Popen(
            [str(SCRIPT), "--no-build", "--watch-codex", "--watch-usage"],
            cwd=ROOT, env=self._env(port), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        stdout = ""
        deadline = time.monotonic() + 15
        try:
            while time.monotonic() < deadline:
                line = process.stdout.readline()
                stdout += line
                if "Press Ctrl-C to stop" in line:
                    break
                if process.poll() is not None:
                    stderr = process.stderr.read()
                    self.fail(f"launcher exited early with {process.returncode}: {stderr}")
            self.assertIn("Claude Phone Monitor is running", stdout)
            pid_deadline = time.monotonic() + 3
            while time.monotonic() < pid_deadline and not (self.pid_dir / "collector.pid").exists():
                time.sleep(0.02)
            self.assertTrue((self.pid_dir / "collector.pid").exists(), f"collector node did not start; output: {stdout}")
            relay_pid = int((self.pid_dir / "relay.pid").read_text().strip())
            collector_pid = int((self.pid_dir / "collector.pid").read_text().strip())
            self.assertTrue((self.state / "pairing.png").is_file())
            self.assertTrue((self.state / "usage.sqlite").is_file() is False, "launcher does not rewrite Usage ledger")
            process.send_signal(signal.SIGINT)
            process.wait(timeout=8)
            process.stdout.close()
            process.stderr.close()
            for pid in (collector_pid, relay_pid):
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=8)
            if process.stdout and not process.stdout.closed:
                process.stdout.close()
            if process.stderr and not process.stderr.closed:
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
