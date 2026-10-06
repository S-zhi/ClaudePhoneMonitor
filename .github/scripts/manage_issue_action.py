#!/usr/bin/env python3
"""Assign one action after a configured TypeSafe Jev review; never execute an agent."""
import argparse
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path

import yaml
from sync_labels import ValidationError, load_and_validate

FAILED_STATE = "state:agent-failed"


def exact_fields(value, fields, context):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError(f"{context} must contain exactly the documented fields")


def load_policy():
    with Path(".github/action-policy.yaml").open(encoding="utf-8") as stream:
        policy = yaml.safe_load(stream)
    exact_fields(policy, {"reviewer", "agents"}, "Policy")
    reviewer = policy["reviewer"]
    exact_fields(reviewer, {"name", "model", "command", "timeout_seconds"}, "Reviewer")
    if reviewer["name"] != "TypeSafe" or not isinstance(reviewer["model"], str) or not reviewer["model"].strip():
        raise ValueError("Reviewer must be TypeSafe with a nonempty model name")
    command = reviewer["command"]
    if not isinstance(command, list) or any(not isinstance(x, str) or not x.strip() for x in command):
        raise ValueError("Reviewer command must be a list of nonempty strings")
    timeout = reviewer["timeout_seconds"]
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 3600:
        raise ValueError("Reviewer timeout_seconds must be positive and at most 3600")
    if not isinstance(policy["agents"], list) or any(not isinstance(x, dict) for x in policy["agents"]):
        raise ValueError("Agents must be a list of provider capability objects")
    # Ensure arbitrary capability metadata is valid JSON, without logging it.
    json.dumps(policy["agents"], allow_nan=False)
    return policy


def run_gh(args):
    result = subprocess.run(["gh", "api", *args], capture_output=True, text=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def issue_snapshot(issue):
    if not isinstance(issue, dict) or not isinstance(issue.get("labels"), list):
        raise ValueError("Invalid live Issue response")
    labels = [item["name"] for item in issue["labels"]]
    if any(not isinstance(name, str) for name in labels):
        raise ValueError("Invalid Issue labels")
    updated = issue.get("updated_at")
    if not isinstance(updated, str) or not updated:
        raise ValueError("Issue updated_at is missing")
    return labels, updated


def read_comments(endpoint):
    """Read every page; reject incomplete or malformed discussion data."""
    pages = run_gh(["--paginate", "--slurp", f"{endpoint}/comments?per_page=100"])
    if not isinstance(pages, list) or not pages or any(not isinstance(page, list) for page in pages):
        raise ValueError("Invalid paginated Issue comments response")
    comments = []
    seen = set()
    for page in pages:
        for item in page:
            if not isinstance(item, dict):
                raise ValueError("Invalid Issue comment")
            comment_id = item.get("id")
            if type(comment_id) is not int or comment_id <= 0 or comment_id in seen:
                raise ValueError("Invalid or duplicate Issue comment id")
            if not isinstance(item.get("body"), str):
                raise ValueError("Invalid Issue comment body")
            for field in ("created_at", "updated_at"):
                if not isinstance(item.get(field), str) or not item[field]:
                    raise ValueError("Missing Issue comment timestamp")
            if "user" not in item:
                raise ValueError("Missing Issue comment author")
            user = item["user"]
            author = None if user is None else user.get("login") if isinstance(user, dict) else None
            if user is not None and (not isinstance(author, str) or not author):
                raise ValueError("Invalid Issue comment author")
            seen.add(comment_id)
            comments.append({"id": comment_id, "author": author, "body": item["body"],
                             "created_at": item["created_at"], "updated_at": item["updated_at"]})
    return sorted(comments, key=lambda comment: comment["id"])


def eligible(issue, normal_states):
    labels, _ = issue_snapshot(issue)
    if issue.get("state") != "open":
        return None, "Issue is not open"
    if FAILED_STATE in labels:
        return None, "Issue is paused in state:agent-failed"
    if any(name.startswith("action:") for name in labels):
        return None, "Issue already has an action label"
    states = [name for name in labels if name.startswith("state:")]
    if len(states) != 1:
        return None, "Issue must have exactly one state label"
    if states[0] not in normal_states:
        return None, "Issue state is not in the normal state chain"
    return states[0], ""


def review(policy, request):
    reviewer = policy["reviewer"]
    if not reviewer["command"]:
        print("Error: TypeSafe reviewer command is not configured in .github/action-policy.yaml", file=sys.stderr)
        raise ValueError("TypeSafe reviewer command is not configured in .github/action-policy.yaml")
    result = subprocess.run(reviewer["command"], input=json.dumps(request, ensure_ascii=False),
                            capture_output=True, text=True, encoding="utf-8",
                            timeout=reviewer["timeout_seconds"], check=False)
    if result.returncode:
        # Never print arbitrary adapter stderr or remote bodies.
        from jev_review import ERRORS
        bundled = reviewer["command"] == ["python", ".github/scripts/jev_review.py"]
        message = ERRORS.get(result.returncode, "reviewer failed") if bundled else "reviewer failed"
        print(f"Error: {message}; no action was assigned", file=sys.stderr)
        raise subprocess.CalledProcessError(result.returncode, reviewer["command"])
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("Reviewer stdout must be one JSON object") from exc
    exact_fields(response, {"protocol_version", "request_id", "issue_number", "expected_state", "decision", "reason"}, "Reviewer response")
    if response["protocol_version"] != "1" or response["request_id"] != request["request_id"]:
        raise ValueError("Reviewer response protocol or request_id does not match")
    if type(response["issue_number"]) is not int or response["issue_number"] != request["issue"]["number"]:
        raise ValueError("Reviewer response issue_number does not match")
    if response["expected_state"] != request["issue"]["state"]:
        raise ValueError("Reviewer response expected_state does not match")
    if response["decision"] not in ("human", "agent"):
        raise ValueError("Reviewer decision must be human or agent")
    if not isinstance(response["reason"], str) or not response["reason"].strip():
        raise ValueError("Reviewer reason must be a nonempty string")
    return response["decision"]


def main():
    parser = argparse.ArgumentParser(description="Review and assign the current Issue action")
    parser.add_argument("--issue-number", required=True, type=int)
    args = parser.parse_args()
    if args.issue_number <= 0:
        parser.error("--issue-number must be positive")
    try:
        repo = os.environ.get("GH_REPO") or os.environ.get("GITHUB_REPOSITORY")
        if not repo or not re.fullmatch(r"[^/\s]+/[^/\s]+", repo):
            raise ValueError("GH_REPO or GITHUB_REPOSITORY must be owner/repo")
        policy = load_policy()
        normal_states = {item["name"] for item in load_and_validate(Path(".github/label.yaml"))
                         if item["name"].startswith("state:") and item["name"] != FAILED_STATE}
        endpoint = f"repos/{repo}/issues/{args.issue_number}"
        issue = run_gh([endpoint])
        state, reason = eligible(issue, normal_states)
        if state is None:
            print(f"Skip: {reason}")
            return 0
        labels, updated = issue_snapshot(issue)
        comments = read_comments(endpoint)
        request = {"protocol_version": "1", "request_id": str(uuid.uuid4()), "repository": repo,
                   "issue": {"number": args.issue_number, "title": issue.get("title", ""),
                             "body": issue.get("body") or "", "labels": labels,
                             "state": state, "updated_at": updated, "comments": comments},
                   "reviewer": {"name": policy["reviewer"]["name"], "model": policy["reviewer"]["model"]},
                   "agents": policy["agents"]}
        decision = review(policy, request)
        current = run_gh([endpoint])
        current_state, reason = eligible(current, normal_states)
        current_labels, current_updated = issue_snapshot(current)
        current_comments = read_comments(endpoint)
        if (current_state != state or current_updated != updated or sorted(current_labels) != sorted(labels)
                or current_comments != comments):
            print("Skip: Issue changed while review was in progress")
            return 0
        if current_state is None:
            print(f"Skip: {reason}")
            return 0
        action = f"action:{decision}"
        run_gh([f"{endpoint}/labels", "--method", "POST", "-f", f"labels[]={action}"])
        print(f"Assigned {action} to issue #{args.issue_number} at {state}")
        return 0
    except subprocess.TimeoutExpired:
        print("Error: TypeSafe review timed out; no action was assigned", file=sys.stderr)
    except subprocess.CalledProcessError as exc:
        print(f"Error: subprocess failed (exit {exc.returncode}); no fallback action assigned", file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError, ValidationError, yaml.YAMLError):
        # Avoid echoing external stdout, Issue content, or secrets in malformed config.
        print("Error: invalid configuration, Issue data, or reviewer response; no fallback action assigned", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
