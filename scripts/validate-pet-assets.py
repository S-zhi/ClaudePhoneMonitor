#!/usr/bin/env python3
"""Validate the issue #8 prompt plan and actual generated-image ledger."""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path):
    records = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path.name}:{line_number}: invalid JSON: {error.msg}") from error
        if not isinstance(record, dict):
            raise ValueError(f"{path.name}:{line_number}: expected a JSON object")
        records.append(record)
    return records


def required_text(record, field):
    value = record.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{record.get('action_id', '?')}: {field} must be nonempty text")
    return value


def image_path(root, value):
    if not isinstance(value, str) or not value.strip() or Path(value).is_absolute():
        raise ValueError(f"image path must be repository-relative: {value!r}")
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"image path leaves repository: {value}")
    if not path.is_file():
        raise ValueError(f"image does not exist: {value}")
    if path.suffix.lower() != ".png" or path.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"image must be a PNG: {value}")


def validate_common(root, record, record_type):
    if record.get("schema_version") != 1 or record.get("record_type") != record_type:
        raise ValueError(f"expected schema_version 1 and record_type {record_type}")
    for field in ("action_id", "prompt"):
        required_text(record, field)
    references = record.get("reference_paths")
    if not isinstance(references, list) or not references:
        raise ValueError("reference_paths must contain actual reference images")
    for reference in references:
        image_path(root, reference)


def validate(root, plan_path, ledger_path):
    plans = read_jsonl(plan_path)
    generated = read_jsonl(ledger_path)
    actions = {}
    for record in plans:
        validate_common(root, record, "planned")
        action = record["action_id"]
        if action in actions:
            raise ValueError(f"duplicate planned action_id: {action}")
        if any(field in record for field in ("image_path", "image_paths", "processed_image_path", "runtime_asset_path")):
            raise ValueError(f"{action}: a plan must not contain generated image paths")
        if record.get("approval_status") not in ("pending", "approved"):
            raise ValueError(f"{action}: approval_status must be pending or approved")
        for field in ("visual_state", "action", "switch_rule"):
            required_text(record, field)
        pages = record.get("pages")
        if not isinstance(pages, list) or not pages or any(
            page not in ("STATUS", "STATE_CHANGE", "USAGE") for page in pages
        ):
            raise ValueError(f"{action}: pages must name the applicable monitor pages")
        spec = record.get("output_spec")
        if not isinstance(spec, dict) or not all(
            field in spec for field in ("kind", "format", "transparent_background", "preferred_size", "count")
        ):
            raise ValueError(f"{action}: output_spec is incomplete")
        actions[action] = record
    if not plans:
        raise ValueError("prompt plan must not be empty")

    generation_ids = set()
    for record in generated:
        validate_common(root, record, "generated")
        action = record["action_id"]
        if action not in actions:
            raise ValueError(f"generated action has no plan: {action}")
        if actions[action]["approval_status"] != "approved":
            raise ValueError(f"{action}: plan must be approved before generation")
        generation_id = required_text(record, "generation_id")
        if generation_id in generation_ids:
            raise ValueError(f"duplicate generation_id: {generation_id}")
        generation_ids.add(generation_id)
        required_text(record, "generated_at")
        image_path(root, required_text(record, "image_path"))
        if "processed_image_path" in record:
            image_path(root, required_text(record, "processed_image_path"))
        if "runtime_asset_path" in record:
            runtime_path = required_text(record, "runtime_asset_path")
            image_path(root, runtime_path)
            source_path = record.get("processed_image_path", record["image_path"])
            if (root / runtime_path).read_bytes() != (root / source_path).read_bytes():
                raise ValueError(f"{action}: runtime asset must match its source image byte-for-byte")
        if record.get("review_status") not in ("pending", "accepted", "rejected"):
            raise ValueError(f"{action}: review_status must be pending, accepted or rejected")
    return len(plans), len(generated)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, default=ROOT / "docs/pet-assets/pending-prompts.jsonl")
    parser.add_argument("--ledger", type=Path, default=ROOT / "docs/pet-assets/generated-assets.jsonl")
    args = parser.parse_args()
    try:
        plan_count, generated_count = validate(ROOT, args.plan, args.ledger)
    except (OSError, ValueError) as error:
        print(f"Pet asset validation failed: {error}", file=sys.stderr)
        return 1
    print(f"Pet assets valid: {plan_count} planned actions, {generated_count} generated images.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
