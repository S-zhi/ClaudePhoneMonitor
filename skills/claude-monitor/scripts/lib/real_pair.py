#!/usr/bin/env python3
"""Pair one Android device with a local Relay without exposing long-lived tokens."""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


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


def post_json(url: str, body: dict[str, str], bootstrap_secret: str, *, expected_status: int = 201) -> dict[str, object]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {bootstrap_secret}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            if response.status != expected_status:
                raise ValueError(f"relay_http_{response.status}")
            content = response.read(16_384)
    except urllib.error.HTTPError as error:
        # Never print response bodies: they may contain credential-like data.
        fixed_code = None
        try:
            body = json.loads(error.read(2_048))
            candidate = body.get("error") if isinstance(body, dict) else None
            if isinstance(candidate, str) and candidate in {"unauthorized", "invalid_collector_token", "invalid_request", "pairing_unavailable"}:
                fixed_code = candidate
        except (OSError, json.JSONDecodeError):
            pass
        raise ValueError(fixed_code or f"relay_http_{error.code}") from None
    except urllib.error.URLError:
        raise ValueError("Cannot connect to the local Relay; start it on this Mac first") from None
    result = json.loads(content)
    if not isinstance(result, dict):
        raise ValueError("Relay pairing response is not a JSON object")
    return result


def get_json(url: str) -> tuple[int, dict[str, object] | None]:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            content = response.read(16_384)
            value = json.loads(content)
            return response.status, value if isinstance(value, dict) else None
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return 0, None


def parse_shell_env(path: Path) -> dict[str, str]:
    """Parse only literal single-word assignments; never source/execute this file."""
    if not path.is_file():
        return {}
    allowed = {
        "RELAY_BOOTSTRAP_SECRET", "COLLECTOR_RELAY_URL", "COLLECTOR_RELAY_TOKEN",
        "COLLECTOR_INSTALLATION_ID", "COLLECTOR_DATA_DIR", "COLLECTOR_SOCKET_PATH",
        "RELAY_PUBLIC_URL", "RELAY_DB_PATH",
    }
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Z_]+)=(.*)", stripped)
        if not match or match.group(1) not in allowed:
            continue
        try:
            words = shlex.split(match.group(2), comments=True, posix=True)
        except ValueError:
            raise ValueError("invalid_monitor_env") from None
        if len(words) != 1:
            raise ValueError("invalid_monitor_env")
        result[match.group(1)] = words[0]
    return result


def parse_time(value: object) -> datetime.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(datetime.timezone.utc)
    except ValueError:
        return None


def atomic_write(path: Path, content: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(6)}")
    try:
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def atomic_commit(files: dict[Path, bytes]) -> None:
    """Replace a small related file set and restore prior files if a replace fails."""
    previous: dict[Path, tuple[bytes, int] | None] = {}
    staged: dict[Path, Path] = {}
    try:
        for path, content in files.items():
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if path.exists():
                stat = path.stat()
                previous[path] = (path.read_bytes(), stat.st_mode & 0o777)
            else:
                previous[path] = None
            temp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(6)}")
            staged[path] = temp
            fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temp, 0o600)
    except OSError:
        for temp in staged.values():
            temp.unlink(missing_ok=True)
        raise
    replaced: list[Path] = []
    try:
        for path, temp in staged.items():
            os.replace(temp, path)
            replaced.append(path)
    except OSError:
        for path in reversed(replaced):
            prior = previous[path]
            if prior is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, prior[0], prior[1])
        raise
    finally:
        for temp in staged.values():
            temp.unlink(missing_ok=True)


def render_qr(renderer: Path, metadata_path: Path, output_path: Path) -> bytes:
    temp_png = output_path.with_name(f".{output_path.name}.tmp-{os.getpid()}-{secrets.token_hex(6)}")
    try:
        swift = os.environ.get("CLAUDE_PHONE_MONITOR_SWIFT_BIN", "swift")
        subprocess.run((swift, str(renderer), str(metadata_path), str(temp_png)), check=True, timeout=45,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not temp_png.is_file() or temp_png.stat().st_size < 8:
            raise ValueError("qr_render_failed")
        content = temp_png.read_bytes()
        if not content.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("qr_render_failed")
        return content
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        raise ValueError("qr_render_failed") from None
    finally:
        temp_png.unlink(missing_ok=True)


def url_origin(value: object, schemes: tuple[str, ...]) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = urllib.parse.urlparse(validated_url(value, schemes))
        return f"{parsed.scheme}://{parsed.netloc.lower()}"
    except ValueError:
        return None


def android_ws_url(public_url: str) -> str:
    parsed = urllib.parse.urlparse(public_url)
    parsed = parsed._replace(
        scheme="wss" if parsed.scheme == "https" else "ws",
        path="/ws/android", params="", query="", fragment="",
    )
    return urllib.parse.urlunparse(parsed)


def read_pairing(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def validate_qr_payload(payload: object, installation_id: str, public_url: str, pairing_id: object) -> dict[str, object]:
    if not isinstance(payload, str) or len(payload) > 16_384:
        raise ValueError("invalid_qr_payload")
    try:
        qr = json.loads(payload)
    except json.JSONDecodeError:
        raise ValueError("invalid_qr_payload") from None
    if not isinstance(qr, dict) or qr.get("version") != 1:
        raise ValueError("invalid_qr_payload")
    if qr.get("installation_id") != installation_id or qr.get("pairing_id") != pairing_id:
        raise ValueError("invalid_qr_identity")
    http_url = validated_url(str(qr.get("relay_http_url", "")), ("http", "https"), phone=True)
    ws_url = validated_url(str(qr.get("relay_ws_url", "")), ("ws", "wss"), phone=True)
    if http_url.rstrip("/") != public_url.rstrip("/") or ws_url.rstrip("/") != android_ws_url(public_url).rstrip("/"):
        raise ValueError("pairing_address_mismatch")
    return qr


def prepare_environment(secret: str, collector_url: str, token: str, installation_id: str,
                        state: Path, public_url: str, db_path: Path) -> bytes:
    lines = [
        "# Generated by claude-phone-monitor real pairing; mode 0600.",
        f"RELAY_BOOTSTRAP_SECRET={shlex.quote(secret)}",
        f"COLLECTOR_RELAY_URL={shlex.quote(collector_url)}",
        f"COLLECTOR_RELAY_TOKEN={shlex.quote(token)}",
        f"COLLECTOR_INSTALLATION_ID={shlex.quote(installation_id)}",
        f"COLLECTOR_DATA_DIR={shlex.quote(str(state))}",
        f"COLLECTOR_SOCKET_PATH={shlex.quote(str(state / 'collector.sock'))}",
        f"RELAY_PUBLIC_URL={shlex.quote(public_url)}",
        f"RELAY_DB_PATH={shlex.quote(str(db_path))}",
    ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a single-use QR pairing for a trusted LAN Relay")
    parser.add_argument("--state-dir", default=str(Path.home() / ".claude-phone-monitor"))
    parser.add_argument("--relay-http", default="http://127.0.0.1:8787")
    parser.add_argument("--relay-ws", default="ws://127.0.0.1:8787/ws/collector")
    parser.add_argument("--public-url")
    parser.add_argument("--installation-id")
    parser.add_argument("--db-path")
    parser.add_argument("--force-new", action="store_true", help="create a fresh one-time QR while preserving identity and tokens")
    parser.add_argument("--read-env", metavar="KEY", help=argparse.SUPPRESS)
    parser.add_argument("--bootstrap-secret", help="Prefer RELAY_BOOTSTRAP_SECRET or state/monitor.env to avoid shell history")
    parser.add_argument("--json", action="store_true", help="Print non-token pairing metadata")
    options = parser.parse_args()

    state = Path(options.state_dir).expanduser().resolve()
    env_file = state / "monitor.env"
    if options.read_env:
        values = parse_shell_env(env_file)
        key = options.read_env
        if key not in {"RELAY_BOOTSTRAP_SECRET", "COLLECTOR_RELAY_URL", "COLLECTOR_RELAY_TOKEN", "COLLECTOR_INSTALLATION_ID", "COLLECTOR_DATA_DIR", "COLLECTOR_SOCKET_PATH", "RELAY_PUBLIC_URL", "RELAY_DB_PATH"}:
            raise ValueError("invalid_env_key")
        print(values.get(key, ""), end="")
        return 0
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    existing = parse_shell_env(env_file)
    secret = options.bootstrap_secret or os.environ.get("RELAY_BOOTSTRAP_SECRET") or existing.get("RELAY_BOOTSTRAP_SECRET")
    if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_\-.]{24,512}", secret):
        raise ValueError("bootstrap_secret_unavailable")
    relay_http = validated_url(options.relay_http, ("http", "https"))
    relay_ws = validated_url(options.relay_ws, ("ws", "wss"))
    public_url = validated_url(options.public_url or f"http://{lan_address()}:8787", ("http", "https"), phone=True)
    db_path = Path(options.db_path or existing.get("RELAY_DB_PATH") or state / "relay.sqlite").expanduser().resolve()
    identity_file = state / "installation_id"
    file_identity = identity_file.read_text(encoding="utf-8").strip() if identity_file.is_file() else None
    env_identity = existing.get("COLLECTOR_INSTALLATION_ID")
    if file_identity and env_identity and file_identity != env_identity:
        raise ValueError("installation_identity_mismatch")
    known_identity = options.installation_id or file_identity or env_identity
    if known_identity and any(value and value != known_identity for value in (file_identity, env_identity)):
        raise ValueError("installation_identity_mismatch")
    installation_id = known_identity or str(uuid.uuid4())
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", installation_id):
        raise ValueError("invalid_installation_id")
    existing_token = existing.get("COLLECTOR_RELAY_TOKEN")
    if known_identity and not existing_token:
        raise ValueError("collector_token_missing")
    if existing_token:
        validation = post_json(f"{relay_http}/v1/collector-token/validate", {
            "installation_id": installation_id, "collector_token": existing_token,
        }, secret, expected_status=200)
        if validation.get("valid") is not True or validation.get("installation_id") != installation_id:
            raise ValueError("collector_token_validation_failed")

    metadata_file = state / "pairing.json"
    pairing_png = state / "pairing.png"
    cached = read_pairing(metadata_file)
    cached_id = cached.get("pairing_id") if cached else None
    should_refresh = options.force_new or not cached or not isinstance(cached_id, str) or not cached_id
    response: dict[str, object]
    cached_payload = cached.get("qr_payload") if cached else None
    if cached and not should_refresh:
        if cached.get("installation_id") != installation_id:
            raise ValueError("cached_pairing_identity_mismatch")
        status_code, server_pairing = get_json(f"{relay_http}/v1/pairing/{urllib.parse.quote(cached_id, safe='')}")
        if status_code == 404:
            raise ValueError("pairing_record_missing_restore_relay_database")
        if status_code != 200 or not isinstance(server_pairing, dict):
            raise ValueError("pairing_status_unavailable")
        if server_pairing.get("installation_id") != installation_id:
            raise ValueError("server_pairing_identity_mismatch")
        expiry = parse_time(server_pairing.get("expires_at"))
        qr_matches = False
        try:
            qr = validate_qr_payload(cached_payload, installation_id, public_url, cached_id)
            qr_matches = (
                server_pairing.get("pairing_id") == cached_id
                and cached.get("expires_at") == server_pairing.get("expires_at")
                and url_origin(server_pairing.get("ws_url"), ("ws", "wss")) == url_origin(relay_ws, ("ws", "wss"))
            )
        except ValueError:
            pass
        if server_pairing.get("status") == "pending" and expiry and expiry > datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=60) and qr_matches:
            response = {
                "pairing_id": cached_id,
                "expires_at": server_pairing["expires_at"],
                "installation_id": installation_id,
                "collector_token": existing_token,
                "code": json.loads(cached_payload)["pairing_code"],
                "ws_url": server_pairing.get("ws_url"),
                "qr_payload": cached_payload,
            }
        elif server_pairing.get("status") in {"pending", "expired", "claimed"}:
            should_refresh = True
        else:
            raise ValueError("pairing_status_unrecognized")

    if should_refresh:
        body = {"installation_id": installation_id, "relay_url": public_url, "public_url": public_url}
        if existing_token:
            body["collector_token"] = existing_token
        response = post_json(f"{relay_http}/v1/pairing", body, secret)
    required = ("pairing_id", "code", "expires_at", "qr_payload", "collector_token", "installation_id", "ws_url")
    if any(field not in response or not isinstance(response[field], str) or not response[field] for field in required):
        raise ValueError("pairing_response_incomplete")
    if response["installation_id"] != installation_id:
        raise ValueError("pairing_response_identity_mismatch")
    token = response["collector_token"]
    if not re.fullmatch(r"[A-Za-z0-9_\-.]{24,512}", token):
        raise ValueError("invalid_collector_token")
    if existing_token and token != existing_token:
        raise ValueError("collector_token_changed")
    qr_payload = response["qr_payload"]
    qr = validate_qr_payload(qr_payload, installation_id, public_url, response["pairing_id"])
    if should_refresh and qr.get("pairing_code") != response.get("code"):
        raise ValueError("pairing_code_mismatch")
    if url_origin(response.get("ws_url"), ("ws", "wss")) != url_origin(relay_ws, ("ws", "wss")):
        raise ValueError("collector_relay_address_mismatch")
    expiry = parse_time(response.get("expires_at"))
    if not expiry or expiry <= datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=60):
        raise ValueError("pairing_expiring_too_soon")
    metadata = {
        "pairing_id": response["pairing_id"],
        "expires_at": response["expires_at"],
        "installation_id": installation_id,
        "relay_http_url": qr["relay_http_url"],
        "relay_ws_url": qr["relay_ws_url"],
        "qr_payload": qr_payload,
    }
    temp_metadata = state / f".pairing.json.render-{os.getpid()}-{secrets.token_hex(6)}"
    atomic_write(temp_metadata, (json.dumps(metadata, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    renderer = Path(__file__).resolve().parent.parent / "render-qr.swift"
    try:
        png_content = render_qr(renderer, temp_metadata, pairing_png)
    finally:
        temp_metadata.unlink(missing_ok=True)
    env_content = prepare_environment(secret, relay_ws, token, installation_id, state, public_url, db_path)
    metadata_content = (json.dumps(metadata, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    files = {env_file: env_content, metadata_file: metadata_content, pairing_png: png_content}
    if not identity_file.exists():
        files[identity_file] = (installation_id + "\n").encode("utf-8")
    atomic_commit(files)
    if options.json:
        print(json.dumps({key: value for key, value in metadata.items() if key != "qr_payload"}, ensure_ascii=False))
    else:
        print(f"Pairing ready; expires {metadata['expires_at']}")
        print(f"QR image: {pairing_png}")
        print("This one-time QR expires at the shown time. Refresh it with --pair before scanning if it has expired.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        code = str(error)
        explanations = {
            "invalid_collector_token": "The saved Collector token is not valid for this installation. Restore the matching Relay database and monitor environment; existing credentials were preserved.",
            "pairing_record_missing_restore_relay_database": "Relay does not know the saved pairing. Restore the matching Relay database before retrying; no replacement pairing was created.",
            "qr_render_failed": "The new QR could not be rendered. Existing pairing files were preserved and are not being presented as current.",
            "pairing_status_unavailable": "Relay pairing status could not be verified. No existing pairing files were replaced.",
        }
        print(f"pair: {explanations.get(code, code if re.fullmatch(r'[a-z0-9_]+', code) else 'pairing_failed')}", file=sys.stderr)
        raise SystemExit(1)
