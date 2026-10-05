#!/usr/bin/env python3
"""Pair one Android device with a local Relay without exposing long-lived tokens."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


def private_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    try:
        with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def lan_address() -> str:
    for device in ("en1", "en0"):
        try:
            value = subprocess.check_output(("ipconfig", "getifaddr", device), text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            continue
        try:
            socket.inet_aton(value)
        except OSError:
            continue
        if not value.startswith("127."):
            return value
    raise ValueError("No Mac LAN IPv4 address found; pass --public-url http://<MAC_LAN_IP>:8787")


def validated_url(value: str, schemes: tuple[str, ...], *, phone: bool = False) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in schemes or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"Invalid Relay URL: expected {'/'.join(schemes)}://host[:port] without credentials or query")
    if phone and parsed.hostname in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
        raise ValueError("Android cannot reach Mac localhost; use the Mac's LAN address")
    return value.rstrip("/")


def post_json(url: str, body: dict[str, str], bootstrap_secret: str) -> dict[str, object]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {bootstrap_secret}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            if response.status != 201:
                raise ValueError(f"Relay pairing returned HTTP {response.status}")
            content = response.read(16_384)
    except urllib.error.HTTPError as error:
        raise ValueError(f"Relay rejected pairing (HTTP {error.code}); check bootstrap secret and Relay state") from None
    except urllib.error.URLError:
        raise ValueError("Cannot connect to the local Relay; start it on this Mac first") from None
    result = json.loads(content)
    if not isinstance(result, dict):
        raise ValueError("Relay pairing response is not a JSON object")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a single-use QR pairing for a trusted LAN Relay")
    parser.add_argument("--state-dir", default=str(Path.home() / ".claude-phone-monitor"))
    parser.add_argument("--relay-http", default="http://127.0.0.1:8787")
    parser.add_argument("--relay-ws", default="ws://127.0.0.1:8787/ws/collector")
    parser.add_argument("--public-url")
    parser.add_argument("--installation-id")
    parser.add_argument("--bootstrap-secret", help="Prefer RELAY_BOOTSTRAP_SECRET or state/monitor.env to avoid shell history")
    parser.add_argument("--json", action="store_true", help="Print non-token pairing metadata")
    options = parser.parse_args()

    state = Path(options.state_dir).expanduser().resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    env_file = state / "monitor.env"
    existing: dict[str, str] = {}
    if env_file.is_file():
        # Only parse shell assignments we own; never execute the file as code.
        for line in env_file.read_text(encoding="utf-8").splitlines():
            match = re.fullmatch(r"(?:export )?([A-Z_]+)=([A-Za-z0-9_./:\-]+)", line.strip())
            if match:
                existing[match.group(1)] = match.group(2)
    secret = options.bootstrap_secret or os.environ.get("RELAY_BOOTSTRAP_SECRET") or existing.get("RELAY_BOOTSTRAP_SECRET")
    if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_\-.]{24,512}", secret):
        raise ValueError("Set RELAY_BOOTSTRAP_SECRET to a URL-safe value of at least 24 characters")
    relay_http = validated_url(options.relay_http, ("http", "https"))
    relay_ws = validated_url(options.relay_ws, ("ws", "wss"))
    public_url = validated_url(options.public_url or f"http://{lan_address()}:8787", ("http", "https"), phone=True)
    identity_file = state / "installation_id"
    if options.installation_id:
        installation_id = options.installation_id
    elif identity_file.is_file():
        installation_id = identity_file.read_text(encoding="utf-8").strip()
    else:
        installation_id = str(uuid.uuid4())
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", installation_id):
        raise ValueError("Invalid installation ID")

    response = post_json(f"{relay_http}/v1/pairing", {"installation_id": installation_id, "relay_url": public_url}, secret)
    required = ("pairing_id", "code", "expires_at", "qr_payload", "collector_token", "installation_id", "ws_url")
    if any(not isinstance(response.get(field), str) or not response[field] for field in required):
        raise ValueError("Relay pairing response is incomplete")
    if response["installation_id"] != installation_id:
        raise ValueError("Relay pairing installation ID mismatch")
    qr_payload = response["qr_payload"]
    qr = json.loads(qr_payload)
    if not isinstance(qr, dict) or qr.get("version") != 1 or qr.get("installation_id") != installation_id:
        raise ValueError("Relay QR payload is invalid")
    if qr.get("pairing_code") != response["code"] or qr.get("pairing_id") != response["pairing_id"]:
        raise ValueError("Relay QR payload does not match pairing response")
    validated_url(qr.get("relay_http_url", ""), ("http", "https"), phone=True)
    validated_url(qr.get("relay_ws_url", ""), ("ws", "wss"), phone=True)

    private_write(identity_file, installation_id + "\n")
    # The launch agent sources this file. Quote every value as one shell word.
    # Keep the generated file safe to source even if a server returns unusual URL text.
    token = response["collector_token"]
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_\-.]{24,512}", token):
        raise ValueError("Relay returned invalid collector token")
    lines = [
        "# Generated by claude-phone-monitor real pairing; mode 0600.",
        f"RELAY_BOOTSTRAP_SECRET={shlex.quote(secret)}",
        f"COLLECTOR_RELAY_URL={shlex.quote(relay_ws)}",
        f"COLLECTOR_RELAY_TOKEN={shlex.quote(token)}",
        f"COLLECTOR_INSTALLATION_ID={shlex.quote(installation_id)}",
        f"COLLECTOR_DATA_DIR={shlex.quote(str(state))}",
        f"COLLECTOR_SOCKET_PATH={shlex.quote(str(state / 'collector.sock'))}",
        f"RELAY_PUBLIC_URL={shlex.quote(public_url)}",
        f"RELAY_DB_PATH={shlex.quote(str(state / 'relay.sqlite'))}",
    ]
    if any("\n" in line or "\r" in line for line in lines):
        raise ValueError("A pairing value contains a newline")
    private_write(env_file, "\n".join(lines) + "\n")
    metadata = {
        "pairing_id": response["pairing_id"],
        "expires_at": response["expires_at"],
        "installation_id": installation_id,
        "relay_http_url": qr["relay_http_url"],
        "relay_ws_url": qr["relay_ws_url"],
        "qr_payload": qr_payload,
    }
    private_write(state / "pairing.json", json.dumps(metadata, indent=2, ensure_ascii=False) + "\n")
    launch_agent = Path.home() / "Library" / "LaunchAgents" / "com.claude.phone-monitor.plist"
    if launch_agent.is_file() and sys.platform == "darwin":
        subprocess.run(
            ("launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.claude.phone-monitor"),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    qr_png = state / "pairing.png"
    renderer = Path(__file__).resolve().parent.parent / "render-qr.swift"
    try:
        subprocess.run(("swift", str(renderer), str(state / "pairing.json"), str(qr_png)), check=True, timeout=45, stdout=subprocess.DEVNULL)
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        qr_png = None
    if options.json:
        print(json.dumps({key: value for key, value in metadata.items() if key != "qr_payload"}, ensure_ascii=False))
    else:
        print(f"Pairing ready; expires {metadata['expires_at']}")
        print(f"QR image: {qr_png if qr_png else 'not generated (pairing.json contains the QR data)'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f"pair: {error}", file=sys.stderr)
        raise SystemExit(1)
