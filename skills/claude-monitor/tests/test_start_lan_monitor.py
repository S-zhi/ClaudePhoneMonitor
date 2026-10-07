import datetime
import http.server
import json
import os
from pathlib import Path
import shutil
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
        return self._send(404, {})

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size))
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
            return self._send(201, {
                "pairing_id": "fixture-pair", "code": "TESTCODE", "expires_at": expiry,
                "qr_payload": payload, "collector_token": "collector-fixture-token-123456789",
                "installation_id": body["installation_id"], "ws_url": ws_origin,
            })
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

    def tearDown(self):
        self.temp.cleanup()

    def _env(self, port):
        python = sys.executable
        env = os.environ.copy()
        env.update({
            "CLAUDE_PHONE_MONITOR_HOME": str(self.state),
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
            result = subprocess.run([str(SCRIPT), "--no-build", "--pair", "--install-hooks"], env=env,
                                    text=True, capture_output=True, timeout=8)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("A Collector is already listening", result.stderr)
            self.assertFalse((self.state / "monitor.env").exists())
            self.assertFalse((self.state / "bootstrap.secret").exists())
            self.assertFalse((self.state / "pairing.json").exists())
            self.assertFalse((self.state / "pairing.png").exists())
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
