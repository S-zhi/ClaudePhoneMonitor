#!/usr/bin/env python3
"""Advance an issue through the state labels declared in .github/label.yaml."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

from sync_labels import ValidationError, load_and_validate


FAILED_STATE = "state:agent-failed"


def plan_transition(
    event: dict, live_labels: list[str], state_order: list[str]
) -> tuple[str | None, str | None, str]:
    """Return (label_to_add, label_to_remove, reason); additions/removals may be None."""
    action = event.get("action")
    if action == "opened":
        if any(label.startswith("state:") for label in live_labels):
            return None, None, "Issue already has a state label; skip initialization"
        return (state_order[0], None, "Initialize new issue") if state_order else (
            None, None, "No normal states are configured"
        )

    if action != "unlabeled":
        return None, None, f"Unsupported event action: {action!r}"

    removed = (event.get("label") or {}).get("name")
    if not isinstance(removed, str) or not removed.startswith("action:"):
        return None, None, "Removed label is not an action label; skip"

    payload_labels = event.get("issue_labels", [])
    snapshot_states = [name for name in payload_labels if name.startswith("state:")]
    live_states = [name for name in live_labels if name.startswith("state:")]
    if any(name.startswith("action:") for name in payload_labels) or any(
        name.startswith("action:") for name in live_labels
    ):
        return None, None, "Issue has an action label; skip state advancement"

    if len(snapshot_states) == 1 and len(live_states) == 1:
        if snapshot_states[0] != live_states[0]:
            return None, None, "Event snapshot and live state disagree; skip"
        current = live_states[0]
    else:
        return None, None, "Ambiguous state labels in event snapshot or live issue; skip"

    if current not in state_order:
        return None, None, f"State {current!r} is not in the normal state chain; skip"
    next_index = state_order.index(current) + 1
    if next_index >= len(state_order):
        return None, None, f"State {current!r} is the final state; stop"
    return state_order[next_index], current, "Advance to next state"


def run_gh(args: list[str]) -> str:
    result = subprocess.run(
        ["gh", "api", *args], check=True, capture_output=True, text=True
    )
    return result.stdout


def state_order_from_yaml() -> list[str]:
    return [
        item["name"]
        for item in load_and_validate(Path(".github/label.yaml"))
        if item["name"].startswith("state:") and item["name"] != FAILED_STATE
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="处理指定 Issue 的状态流转")
    parser.add_argument("--issue-number", required=True, type=int, help="本次处理的 Issue 问题号")
    args = parser.parse_args()
    if args.issue_number <= 0:
        parser.error("--issue-number 必须是正整数")
    try:
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY")
        if not event_path:
            raise ValueError("GITHUB_EVENT_PATH is not set")
        if not repo:
            raise ValueError("GH_REPO or GITHUB_REPOSITORY is not set")
        with open(event_path, encoding="utf-8") as stream:
            payload = json.load(stream)
        issue = payload.get("issue")
        if not isinstance(issue, dict) or not issue.get("number"):
            raise ValueError("event payload does not contain an issue number")
        if issue["number"] != args.issue_number:
            raise ValueError("指定的问题号与事件中的 Issue 不一致")
        issue_number = str(args.issue_number)
        print(f"Processing {repo} issue #{issue_number}")
        live_issue = json.loads(run_gh([f"repos/{repo}/issues/{issue_number}"]))
        if live_issue.get("state") == "closed":
            print("Issue is closed; skip state advancement")
            return 0
        live_labels = [label["name"] for label in live_issue.get("labels", [])]
        event = {
            "action": payload.get("action"),
            "issue_labels": [label["name"] for label in issue.get("labels", [])],
            "label": payload.get("label"),
        }
        add, remove, reason = plan_transition(event, live_labels, state_order_from_yaml())
        if not add:
            print(reason)
            return 0

        run_gh(
            [
                f"repos/{repo}/issues/{issue_number}/labels",
                "--method",
                "POST",
                "-f",
                f"labels[]={add}",
            ]
        )
        print(f"Added {add}: {reason}")
        if remove:
            encoded = quote(remove, safe="")
            run_gh(
                [
                    f"repos/{repo}/issues/{issue_number}/labels/{encoded}",
                    "--method",
                    "DELETE",
                ]
            )
            print(f"Removed previous state {remove}")
        output_path = os.environ.get("GITHUB_OUTPUT")
        if output_path:
            with open(output_path, "a", encoding="utf-8") as stream:
                stream.write("state_changed=true\n")
        return 0
    except (OSError, json.JSONDecodeError, ValidationError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        print(f"Error: gh api failed (exit {exc.returncode}): {detail}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
