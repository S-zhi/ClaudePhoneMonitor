#!/usr/bin/env python3
"""Translate the internal review protocol to TypeSafe System One (no retries)."""
import json
import math
import os
import socket
import sys
from pathlib import Path
import urllib.error
import urllib.request

import yaml

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
ERRORS = {2: "invalid internal review request", 3: "TYPESAFE_API_KEY is missing",
          4: "TypeSafe authentication failed (HTTP 401/403)",
          5: "TypeSafe rate limit reached (HTTP 429)", 6: "TypeSafe HTTP request failed",
          7: "TypeSafe network request failed", 8: "TypeSafe request timed out",
          9: "invalid TypeSafe response"}
STAGES = {"state:needs-triage": "判断需求是否清晰、是否有必要处理",
          "state:assess-plan": "提出实现方案及验证方式",
          "state:coding": "修改代码、测试验证并创建或更新关联 PR",
          "state:code-review": "检查需求与方案符合性、测试、缺陷和风险",
          "state:wait-auto-merge": "跟进检查及合并条件，直至关联 PR 实际合并"}


def fields(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("unexpected fields")


def string(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("expected nonempty string")


def parse_json(value):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = item
        return result
    return json.loads(value, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite number")))


def validate_request(request):
    fields(request, {"protocol_version", "request_id", "repository", "issue", "reviewer", "agents"})
    if request["protocol_version"] != "1":
        raise ValueError("unsupported protocol")
    string(request["request_id"])
    string(request["repository"])
    issue = request["issue"]
    fields(issue, {"number", "title", "body", "comments", "labels", "state", "updated_at"})
    if type(issue["number"]) is not int or issue["number"] <= 0:
        raise ValueError("invalid issue number")
    if not isinstance(issue["title"], str) or not isinstance(issue["body"], str):
        raise ValueError("invalid issue text")
    string(issue["updated_at"])
    if not isinstance(issue["comments"], list):
        raise ValueError("invalid comments")
    seen_comments = set()
    for comment in issue["comments"]:
        fields(comment, {"id", "author", "body", "created_at", "updated_at"})
        if type(comment["id"]) is not int or comment["id"] <= 0 or comment["id"] in seen_comments:
            raise ValueError("invalid comment id")
        seen_comments.add(comment["id"])
        if comment["author"] is not None:
            string(comment["author"])
        if not isinstance(comment["body"], str):
            raise ValueError("invalid comment body")
        string(comment["created_at"])
        string(comment["updated_at"])
    if not isinstance(issue["state"], str) or issue["state"] not in STAGES:
        raise ValueError("invalid stage")
    if not isinstance(issue["labels"], list) or any(not isinstance(x, str) for x in issue["labels"]):
        raise ValueError("invalid labels")
    if [x for x in issue["labels"] if x.startswith("state:")] != [issue["state"]] or any(x.startswith("action:") for x in issue["labels"]):
        raise ValueError("ineligible labels")
    fields(request["reviewer"], {"name", "model"})
    if request["reviewer"]["name"] != "TypeSafe":
        raise ValueError("invalid reviewer")
    string(request["reviewer"]["model"])
    if not isinstance(request["agents"], list) or any(not isinstance(x, dict) for x in request["agents"]):
        raise ValueError("invalid agents")
    json.dumps(request, allow_nan=False)


def load_prompts():
    path = Path(__file__).resolve().parents[1] / "prompts" / "state-review.yaml"
    with path.open(encoding="utf-8") as stream:
        prompts = yaml.safe_load(stream)
    fields(prompts, {"instructions", "criteria", "stages"})
    string(prompts["instructions"])
    fields(prompts["criteria"], {"current_model", "stronger_model"})
    fields(prompts["stages"], STAGES)
    for value in [*prompts["criteria"].values(), *prompts["stages"].values()]:
        string(value)
    return prompts


def payload(request):
    prompts = load_prompts()
    stage = request["issue"]["state"]
    return {"model": request["reviewer"]["model"],
            "state": {"repository": request["repository"], "issue": request["issue"],
                      "stage_task": STAGES[stage], "agents": request["agents"]},
            "questions": {"assignment": {"type": "choice",
                "instructions": prompts["instructions"] + "\n当前阶段：" + prompts["stages"][stage],
                "criteria": prompts["criteria"]}}}


def probability(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("invalid probability")


def translate(request, response):
    json.dumps(response, allow_nan=False)
    fields(response, {"model", "answers", "usage"})
    string(response["model"])
    if not isinstance(response["usage"], dict):
        raise ValueError("invalid usage")
    fields(response["answers"], {"assignment"})
    answer = response["answers"]["assignment"]
    fields(answer, {"type", "choice", "confidence", "probabilities"})
    mapping = {"current_model": "agent", "stronger_model": "human"}
    if answer["type"] != "choice" or answer["choice"] not in mapping:
        raise ValueError("invalid choice")
    probability(answer["confidence"])
    fields(answer["probabilities"], mapping)
    for value in answer["probabilities"].values():
        probability(value)
    if not math.isclose(sum(answer["probabilities"].values()), 1, abs_tol=1e-6):
        raise ValueError("probabilities must sum to one")
    decision = mapping[answer["choice"]]
    reason = f"TypeSafe Jev 选择 {answer['choice']}，映射到 action:{decision}，置信度 {answer['confidence']:.3f}；此说明由适配器生成。"
    return {"protocol_version": "1", "request_id": request["request_id"],
            "issue_number": request["issue"]["number"], "expected_state": request["issue"]["state"],
            "decision": decision, "reason": reason}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fail(code):
    print(f"Error: {ERRORS[code]}", file=sys.stderr)
    return code


def main():
    try:
        request = parse_json(sys.stdin.read())
        validate_request(request)
        outgoing_payload = payload(request)
    except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError):
        return fail(2)
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        return fail(3)
    try:
        outgoing = urllib.request.Request(ENDPOINT, data=json.dumps(outgoing_payload, ensure_ascii=False, allow_nan=False).encode("utf-8"),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"}, method="POST")
        with urllib.request.build_opener(NoRedirect()).open(outgoing, timeout=60) as result:
            raw = result.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            return fail(9)
    except urllib.error.HTTPError as exc:
        return fail(4 if exc.code in (401, 403) else 5 if exc.code == 429 else 6)
    except (TimeoutError, socket.timeout):
        return fail(8)
    except urllib.error.URLError as exc:
        return fail(8 if isinstance(exc.reason, (TimeoutError, socket.timeout)) else 7)
    except (OSError, ValueError):
        return fail(7)
    try:
        response = translate(request, parse_json(raw))
    except (ValueError, TypeError, KeyError, UnicodeError):
        return fail(9)
    print(json.dumps(response, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
