#!/usr/bin/env python3
"""Safely merge the monitor's hook entries into Claude Code settings.

This file deliberately knows only about the monitor marker.  It never rewrites or
normalizes unrelated hook entries beyond the JSON formatting required for an
atomic write.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import pathlib
import re
import shlex
import stat
import sys
import tempfile
from typing import Any, Iterator

DEFAULT_MARKER = "claude-phone-monitor:v1"


def _die(message: str) -> "NoReturn":
    print(f"settings: {message}", file=sys.stderr)
    raise SystemExit(1)


def _read(path: pathlib.Path) -> tuple[dict[str, Any], int]:
    if not path.exists():
        return {}, 0o600
    try:
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw) if raw.strip() else {}
    except (OSError, json.JSONDecodeError) as exc:
        _die(f"cannot read valid JSON from {path}: {exc}")
    if not isinstance(value, dict):
        _die(f"settings root must be an object: {path}")
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        mode = 0o600
    return value, mode


@contextlib.contextmanager
def _lock(path: pathlib.Path) -> Iterator[None]:
    """Serialize edits without requiring a third-party JSON tool."""
    lock_path = pathlib.Path(str(path) + ".claude-phone-monitor.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        try:
            import fcntl  # type: ignore

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            # The atomic replace below is still safe on platforms without flock.
            pass
        yield
    finally:
        try:
            import fcntl  # type: ignore

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except (ImportError, OSError):
            pass
        handle.close()
        # The lock is ours, and removing it avoids leaving a visible settings
        # artifact. Failure is harmless if another process opened it meanwhile.
        try:
            lock_path.unlink()
        except OSError:
            pass


def _is_owned_hook(value: Any, marker: str) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("claudePhoneMonitorMarker") == marker:
        return True
    command = value.get("command", "")
    return (
        value.get("type") == "command"
        and isinstance(command, str)
        and re.search(r"(?:^|\s)#\s*" + re.escape(marker) + r"\s*$", command)
        is not None
    )


def remove_owned(root: dict[str, Any], marker: str) -> int:
    hooks = root.get("hooks")
    if not isinstance(hooks, dict):
        return 0
    removed = 0
    for event in list(hooks.keys()):
        groups = hooks.get(event)
        if not isinstance(groups, list):
            continue
        new_groups: list[Any] = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                new_groups.append(group)
                continue
            old_hooks = group["hooks"]
            new_hooks = []
            for hook in old_hooks:
                if _is_owned_hook(hook, marker):
                    removed += 1
                else:
                    new_hooks.append(hook)
            if len(new_hooks) == len(old_hooks):
                new_groups.append(group)
            elif new_hooks:
                # Preserve the group and every non-monitor hook in it.
                copy = dict(group)
                copy["hooks"] = new_hooks
                new_groups.append(copy)
            else:
                # The group contained only our hooks.  Do not leave an empty
                # matcher/group behind.
                extra_keys = set(group) - {"hooks", "matcher", "timeout"}
                if extra_keys:
                    copy = dict(group)
                    copy["hooks"] = []
                    new_groups.append(copy)
        if new_groups:
            hooks[event] = new_groups
        else:
            del hooks[event]
    return removed


def _quote_command(command: str) -> str:
    """Quote a command's executable and arguments as separate shell words."""
    try:
        words = shlex.split(command)
    except ValueError:
        # A malformed override is still kept literal rather than interpreted.
        return shlex.quote(command)
    if not words:
        return shlex.quote(command)
    return " ".join(shlex.quote(word) for word in words)


def _command(hook_command: str, event: str, marker: str) -> str:
    # The event names are fixed today, but quote both values so future names or
    # installation paths cannot turn into shell syntax.  `|| true` is the
    # fail-open contract: a broken phone monitor must never block Claude Code.
    return (
        f"{_quote_command(hook_command)} --event {shlex.quote(event)} "
        f"|| true # {marker}"
    )


def add_owned(
    root: dict[str, Any], hook_command: str, events: list[str], marker: str
) -> int:
    hooks = root.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        _die("settings.hooks must be an object")
    remove_owned(root, marker)
    count = 0
    for event in events:
        if not event:
            continue
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            _die(f"settings.hooks.{event} must be an array")
        groups.append(
            {
                "matcher": "",
                "hooks": [
                    {
                        "type": "command",
                        "command": _command(hook_command, event, marker),
                        "timeout": 5,
                    }
                ]
            }
        )
        count += 1
    return count


def _write(path: pathlib.Path, root: dict[str, Any], mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = pathlib.Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(root, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _parse_events(value: str) -> list[str]:
    result: list[str] = []
    for event in value.split(","):
        event = event.strip()
        if event and event not in result:
            result.append(event)
    return result


def _inspect(root: dict[str, Any], marker: str) -> dict[str, Any]:
    events: dict[str, int] = {}
    hooks = root.get("hooks")
    if isinstance(hooks, dict):
        for event, groups in hooks.items():
            if not isinstance(groups, list):
                continue
            count = 0
            for group in groups:
                if isinstance(group, dict) and isinstance(group.get("hooks"), list):
                    count += sum(_is_owned_hook(item, marker) for item in group["hooks"])
            if count:
                events[str(event)] = count
    return {"count": sum(events.values()), "events": events}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("add", "remove", "inspect"))
    parser.add_argument("--settings", required=True)
    parser.add_argument("--hook-command", default="")
    parser.add_argument("--events", default="")
    parser.add_argument("--marker", default=DEFAULT_MARKER)
    args = parser.parse_args()
    path = pathlib.Path(args.settings).expanduser()
    if args.action == "inspect":
        # Inspect is intentionally read-only: status/doctor must not create a
        # lock file or parent directory when no settings file exists.
        root, _ = _read(path)
        print(json.dumps(_inspect(root, args.marker), sort_keys=True))
        return 0
    with _lock(path):
        root, mode = _read(path)
        if args.action == "add":
            if not args.hook_command:
                _die("--hook-command is required for add")
            count = add_owned(root, args.hook_command, _parse_events(args.events), args.marker)
            _write(path, root, mode)
            print(json.dumps({"added": count, **_inspect(root, args.marker)}, sort_keys=True))
            return 0
        removed = remove_owned(root, args.marker)
        if removed:
            _write(path, root, mode)
        print(json.dumps({"removed": removed, **_inspect(root, args.marker)}, sort_keys=True))
        return 0


if __name__ == "__main__":
    main()
