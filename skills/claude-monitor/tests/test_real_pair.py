import contextlib
import datetime
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import socketserver
import sys
import tempfile
import threading
import unittest
from unittest import mock
import urllib.parse


ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "skills/claude-monitor/scripts/lib/real_pair.py"
spec = importlib.util.spec_from_file_location("real_pair", MODULE_PATH)
real_pair = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(real_pair)


def make_payload(pairing_id, installation_id, public_url, code):
    parsed = urllib.parse.urlparse(public_url)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    ws_url = urllib.parse.urlunparse(parsed._replace(scheme=ws_scheme, path="/ws/android", params="", query="", fragment=""))
    return json.dumps({
        "version": 1,
        "relay_http_url": public_url,
        "relay_ws_url": ws_url,
        "pairing_id": pairing_id,
        "pairing_code": code,
        "installation_id": installation_id,
    }, separators=(",", ":"))


class FakeRelay(http.server.BaseHTTPRequestHandler):
    pairing_status = "expired"
    pairing_expiry = None
    missing_pairing = False
    invalid_token = False
    pair_posts = []
    token_validations = []
    next_pair_id = "new-pair-id"
    next_token = "collector-token-stable-123456789"

    def log_message(self, *_args):
        pass

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))

    def _json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self._body()
        if self.path == "/v1/collector-token/validate":
            type(self).token_validations.append(body)
            if type(self).invalid_token:
                return self._json(401, {"error": "invalid_collector_token"})
            return self._json(200, {"valid": True, "installation_id": body["installation_id"]})
        if self.path == "/v1/pairing":
            type(self).pair_posts.append(body)
            installation_id = body["installation_id"]
            public_url = body["public_url"]
            pairing_id = type(self).next_pair_id
            code = "NEWTST34"
            expires = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
            parsed = urllib.parse.urlparse(public_url)
            ws_url = urllib.parse.urlunparse(parsed._replace(scheme="wss" if parsed.scheme == "https" else "ws", path="", params="", query="", fragment=""))
            return self._json(201, {
                "pairing_id": pairing_id,
                "code": code,
                "expires_at": expires,
                "qr_payload": make_payload(pairing_id, installation_id, public_url, code),
                "collector_token": body.get("collector_token", type(self).next_token),
                "installation_id": installation_id,
                "ws_url": ws_url,
            })
        return self._json(404, {})

    def do_GET(self):
        if self.path.endswith("/old-pair-id") and type(self).missing_pairing:
            return self._json(404, {"error": "not_found"})
        expiry = type(self).pairing_expiry or (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        return self._json(200, {
            "pairing_id": "old-pair-id",
            "status": type(self).pairing_status,
            "expires_at": expiry,
            "installation_id": "fixture-installation",
            "ws_url": "ws://192.0.2.20:8787",
        })


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class RealPairTests(unittest.TestCase):
    def setUp(self):
        FakeRelay.pairing_status = "expired"
        FakeRelay.pairing_expiry = None
        FakeRelay.missing_pairing = False
        FakeRelay.invalid_token = False
        FakeRelay.pair_posts = []
        FakeRelay.token_validations = []
        FakeRelay.next_pair_id = "new-pair-id"
        self.server = Server(("127.0.0.1", 0), FakeRelay)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state with spaces $literal"
        self.state.mkdir(mode=0o700)
        self.installation_id = "fixture-installation"
        self.token = "collector-token-stable-123456789"
        self.secret = "bootstrap-secret-for-tests-123456789"
        self.public_url = "http://192.0.2.20:8787"
        self.relay_ws = "ws://192.0.2.20:8787/ws/collector"
        self.db_path = Path(self.temp.name) / "custom relay.sqlite"
        self.db_path.write_bytes(b"relay fixture")
        self.usage_path = self.state / "usage.sqlite"
        self.usage_path.write_bytes(b"usage epoch fixture")
        self._write_existing_pairing()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def _write_existing_pairing(self, status="expired", public_url=None):
        pairing_id = "old-pair-id"
        public_url = public_url or self.public_url
        payload = make_payload(pairing_id, self.installation_id, public_url, "OLDTST34")
        meta = {
            "pairing_id": pairing_id,
            "expires_at": "2026-10-06T08:20:20.722Z",
            "installation_id": self.installation_id,
            "relay_http_url": public_url,
            "relay_ws_url": "ws://192.0.2.20:8787/ws/android",
            "qr_payload": payload,
        }
        (self.state / "pairing.json").write_text(json.dumps(meta))
        (self.state / "pairing.png").write_bytes(b"old png")
        (self.state / "installation_id").write_text(self.installation_id + "\n")
        assignments = {
            "RELAY_BOOTSTRAP_SECRET": self.secret,
            "COLLECTOR_RELAY_URL": self.relay_ws,
            "COLLECTOR_RELAY_TOKEN": self.token,
            "COLLECTOR_INSTALLATION_ID": self.installation_id,
            "COLLECTOR_DATA_DIR": str(self.state),
            "COLLECTOR_SOCKET_PATH": str(self.state / "collector.sock"),
            "RELAY_PUBLIC_URL": self.public_url,
            "RELAY_DB_PATH": str(self.db_path),
        }
        (self.state / "monitor.env").write_text("\n".join(f"{k}={shlex.quote(v)}" for k, v in assignments.items()) + "\n")

    def _run(self, force_new=False, public_url=None, render_fails=False):
        selected_public_url = public_url or self.public_url
        parsed = urllib.parse.urlparse(selected_public_url)
        selected_relay_ws = urllib.parse.urlunparse(parsed._replace(
            scheme="wss" if parsed.scheme == "https" else "ws", path="/ws/collector", params="", query="", fragment=""))
        argv = ["pair", "--state-dir", str(self.state), "--relay-http", self.base,
                "--relay-ws", selected_relay_ws, "--public-url", selected_public_url,
                "--db-path", str(self.db_path), "--json"]
        if force_new:
            argv.append("--force-new")
        rendered = []
        def fake_run(command, **kwargs):
            self.assertEqual(command[0], "swift")
            rendered.append(command[2])
            if render_fails:
                raise real_pair.subprocess.CalledProcessError(1, command)
            Path(command[3]).write_bytes(b"\x89PNG\r\n\x1a\nfixture")
            return mock.Mock(returncode=0)
        output = io.StringIO()
        with mock.patch.object(sys, "argv", argv), mock.patch.object(real_pair.subprocess, "run", fake_run), \
             contextlib.redirect_stdout(output):
            result = real_pair.main()
        return result, json.loads(output.getvalue()), rendered

    def test_expired_qr_refresh_reuses_token_installation_database_and_usage_epoch(self):
        result, output, rendered = self._run()
        self.assertEqual(result, 0)
        self.assertEqual(len(FakeRelay.pair_posts), 1)
        request = FakeRelay.pair_posts[0]
        self.assertEqual(request["installation_id"], self.installation_id)
        self.assertEqual(request["collector_token"], self.token)
        self.assertEqual(request["public_url"], self.public_url)
        self.assertEqual(output["pairing_id"], "new-pair-id")
        self.assertNotIn("qr_payload", output)
        self.assertEqual((self.state / "pairing.png").read_bytes(), b"\x89PNG\r\n\x1a\nfixture")
        self.assertEqual((self.state / "usage.sqlite").read_bytes(), b"usage epoch fixture")
        self.assertEqual(self.db_path.read_bytes(), b"relay fixture")
        env = real_pair.parse_shell_env(self.state / "monitor.env")
        self.assertEqual(env["COLLECTOR_RELAY_TOKEN"], self.token)
        self.assertEqual(env["COLLECTOR_INSTALLATION_ID"], self.installation_id)
        self.assertEqual(env["RELAY_DB_PATH"], str(self.db_path.resolve()))
        self.assertEqual(len(rendered), 1)

    def test_real_pair_preserves_bridge_choice_and_private_custom_socket(self):
        env_path = self.state / "monitor.env"
        custom_socket = str(self.state / "private custom.sock")
        env_path.write_text(env_path.read_text() + "COLLECTOR_APPROVAL_BRIDGE=1\n" +
                            f"COLLECTOR_SOCKET_PATH={shlex.quote(custom_socket)}\n")
        self._run(force_new=True)
        saved = real_pair.parse_shell_env(env_path)
        self.assertEqual(saved["COLLECTOR_APPROVAL_BRIDGE"], "1")
        self.assertEqual(saved["COLLECTOR_SOCKET_PATH"], custom_socket)

    def test_current_pending_qr_is_reused_without_minting_another(self):
        FakeRelay.pairing_status = "pending"
        FakeRelay.pairing_expiry = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        metadata_path = self.state / "pairing.json"
        metadata = json.loads(metadata_path.read_text())
        metadata["expires_at"] = FakeRelay.pairing_expiry
        metadata_path.write_text(json.dumps(metadata))
        result, output, _ = self._run()
        self.assertEqual(result, 0)
        self.assertEqual(FakeRelay.pair_posts, [])
        self.assertEqual(output["pairing_id"], "old-pair-id")
        self.assertEqual(len(FakeRelay.token_validations), 1)

    def test_claimed_qr_refreshes_and_preserves_existing_collector_identity(self):
        FakeRelay.pairing_status = "claimed"
        result, output, _ = self._run()
        self.assertEqual(result, 0)
        self.assertEqual(output["pairing_id"], "new-pair-id")
        self.assertEqual(len(FakeRelay.pair_posts), 1)
        self.assertEqual(FakeRelay.pair_posts[0]["collector_token"], self.token)

    def test_first_pairing_mints_token_and_commits_state_after_render(self):
        fresh = self.state / "first install"
        fresh.mkdir(mode=0o700)
        argv = ["pair", "--state-dir", str(fresh), "--relay-http", self.base,
                "--relay-ws", self.relay_ws, "--public-url", self.public_url,
                "--db-path", str(self.db_path), "--json"]
        FakeRelay.pair_posts = []
        rendered = []
        def fake_run(command, **_kwargs):
            rendered.append(command[2])
            Path(command[3]).write_bytes(b"\x89PNG\r\n\x1a\nfixture")
            return mock.Mock(returncode=0)
        output = io.StringIO()
        with mock.patch.object(sys, "argv", argv), mock.patch.object(real_pair.subprocess, "run", fake_run), \
             mock.patch.dict(os.environ, {"RELAY_BOOTSTRAP_SECRET": self.secret}), contextlib.redirect_stdout(output):
            self.assertEqual(real_pair.main(), 0)
        result = json.loads(output.getvalue())
        env = real_pair.parse_shell_env(fresh / "monitor.env")
        self.assertTrue(result["installation_id"])
        self.assertNotIn("collector_token", result)
        self.assertNotIn("collector_token", FakeRelay.pair_posts[0])
        self.assertEqual(env["COLLECTOR_RELAY_TOKEN"], FakeRelay.next_token)
        self.assertEqual((fresh / "installation_id").read_text().strip(), result["installation_id"])
        self.assertTrue((fresh / "pairing.png").is_file())
        self.assertEqual(len(rendered), 1)

    def test_relay_database_404_fails_closed_and_preserves_existing_files(self):
        FakeRelay.missing_pairing = True
        before = {name: (self.state / name).read_bytes() for name in ("monitor.env", "pairing.json", "pairing.png", "installation_id")}
        with mock.patch.object(sys, "argv", ["pair", "--state-dir", str(self.state), "--relay-http", self.base,
                "--relay-ws", self.relay_ws, "--public-url", self.public_url]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "pairing_record_missing"):
                real_pair.main()
        self.assertEqual(FakeRelay.pair_posts, [])
        self.assertEqual(before, {name: (self.state / name).read_bytes() for name in before})

    def test_address_change_refreshes_pairing_but_not_collector_identity(self):
        new_url = "http://192.0.2.21:8787"
        result, _, _ = self._run(public_url=new_url)
        self.assertEqual(result, 0)
        self.assertEqual(len(FakeRelay.pair_posts), 1)
        self.assertEqual(FakeRelay.pair_posts[0]["installation_id"], self.installation_id)
        self.assertEqual(FakeRelay.pair_posts[0]["collector_token"], self.token)
        self.assertEqual(real_pair.parse_shell_env(self.state / "monitor.env")["RELAY_PUBLIC_URL"], new_url)

    def test_qr_render_failure_preserves_old_env_metadata_and_image(self):
        before = {name: (self.state / name).read_bytes() for name in ("monitor.env", "pairing.json", "pairing.png", "installation_id")}
        with self.assertRaisesRegex(ValueError, "qr_render_failed"):
            self._run(render_fails=True)
        self.assertEqual(before, {name: (self.state / name).read_bytes() for name in before})

    def test_invalid_collector_token_fails_closed_without_replacing_files(self):
        FakeRelay.invalid_token = True
        before = {name: (self.state / name).read_bytes() for name in ("monitor.env", "pairing.json", "pairing.png", "installation_id")}
        with mock.patch.object(sys, "argv", ["pair", "--state-dir", str(self.state), "--relay-http", self.base,
                "--relay-ws", self.relay_ws, "--public-url", self.public_url]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "invalid_collector_token"):
                real_pair.main()
        self.assertEqual(FakeRelay.pair_posts, [])
        self.assertEqual(before, {name: (self.state / name).read_bytes() for name in before})

    def test_atomic_staging_failure_removes_secret_temp_files_and_preserves_destinations(self):
        first = self.state / "first.env"
        second = self.state / "second.env"
        first.write_bytes(b"old first")
        second.write_bytes(b"old second")
        actual_chmod = os.chmod
        def fail_on_second(path, mode):
            if Path(path).name.startswith(".second.env.tmp-"):
                raise OSError("fixture write failure")
            return actual_chmod(path, mode)
        with mock.patch.object(real_pair.os, "chmod", side_effect=fail_on_second):
            with self.assertRaises(OSError):
                real_pair.atomic_commit({first: b"new first", second: b"new second"})
        self.assertEqual(first.read_bytes(), b"old first")
        self.assertEqual(second.read_bytes(), b"old second")
        self.assertEqual(
            sorted(path.name for path in self.state.iterdir() if ".tmp-" in path.name),
            [],
        )


if __name__ == "__main__":
    unittest.main()
