import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pet_assets", ROOT / "scripts/validate-pet-assets.py")
ASSETS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSETS)


class PetAssetValidationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.plan_path = self.root / "plan.jsonl"
        self.ledger_path = self.root / "ledger.jsonl"
        self.plan = copy.deepcopy(ASSETS.read_jsonl(ROOT / "docs/pet-assets/pending-prompts.jsonl")[0])
        self.plan["approval_status"] = "pending"
        self.plan["reference_paths"] = ["reference.png"]
        png = (ROOT / "apps/android/src/main/assets/clawd/Clawd-Still.png").read_bytes()
        (self.root / "reference.png").write_bytes(png)
        (self.root / "generated.png").write_bytes(png)
        self.generated = {
            "schema_version": 1,
            "record_type": "generated",
            "generation_id": "idle-rest-attempt-1",
            "action_id": self.plan["action_id"],
            "prompt": self.plan["prompt"],
            "reference_paths": ["reference.png"],
            "image_path": "generated.png",
            "generated_at": "2026-10-07T00:00:00Z",
            "review_status": "pending",
        }

    def validate(self, plans=None, generated=None):
        for path, records in (
            (self.plan_path, [self.plan] if plans is None else plans),
            (self.ledger_path, [] if generated is None else generated),
        ):
            path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        return ASSETS.validate(self.root, self.plan_path, self.ledger_path)

    def test_empty_fixture_and_repository_records_are_valid(self):
        self.assertEqual((1, 0), self.validate())
        ASSETS.validate(
            ROOT, ROOT / "docs/pet-assets/pending-prompts.jsonl", ROOT / "docs/pet-assets/generated-assets.jsonl"
        )

    def test_planned_records_cannot_claim_generated_images(self):
        self.plan["image_path"] = "generated.png"
        with self.assertRaisesRegex(ValueError, "plan must not contain"):
            self.validate()
        del self.plan["image_path"]
        self.plan["processed_image_path"] = "generated.png"
        with self.assertRaisesRegex(ValueError, "plan must not contain"):
            self.validate()
        del self.plan["processed_image_path"]
        self.plan["runtime_asset_path"] = "generated.png"
        with self.assertRaisesRegex(ValueError, "plan must not contain"):
            self.validate()
        del self.plan["runtime_asset_path"]
        self.plan["approval_status"] = "approved"
        with self.assertRaisesRegex(ValueError, "record_type generated"):
            self.validate(generated=[self.plan])

    def test_generated_ledger_retains_rejected_and_accepted_attempts(self):
        self.plan["approval_status"] = "approved"
        self.generated["review_status"] = "rejected"
        retry = dict(self.generated, generation_id="idle-rest-attempt-2", review_status="accepted")
        retry["prompt"] += " Keep both feet edges fully visible."
        self.assertEqual((1, 2), self.validate(generated=[self.generated, retry]))

    def test_unapproved_unknown_or_missing_generated_images_fail(self):
        with self.assertRaisesRegex(ValueError, "approved before generation"):
            self.validate(generated=[self.generated])
        self.plan["approval_status"] = "approved"
        for update, expected in (
            ({"action_id": "unknown"}, "has no plan"),
            ({"image_path": "not-created.png"}, "does not exist"),
            ({"prompt": ""}, "prompt must be nonempty"),
            ({"generated_at": ""}, "generated_at must be nonempty"),
        ):
            with self.subTest(update=update), self.assertRaisesRegex(ValueError, expected):
                self.validate(generated=[dict(self.generated, **update)])

    def test_reference_paths_are_real_pngs_inside_the_repository(self):
        outside = self.root.parent / "outside.png"
        outside.write_bytes((self.root / "reference.png").read_bytes())
        (self.root / "escaped.png").symlink_to(outside)
        (self.root / "wrong.png").write_text("not an image", encoding="utf-8")
        for reference in ("missing.png", "../outside.png", "escaped.png", str(outside), "wrong.png"):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                self.plan["reference_paths"] = [reference]
                self.validate()

    def test_processed_image_paths_are_real_pngs_inside_the_repository(self):
        self.plan["approval_status"] = "approved"
        self.generated["processed_image_path"] = "generated.png"
        self.assertEqual((1, 1), self.validate(generated=[self.generated]))
        outside = self.root.parent / "outside.png"
        outside.write_bytes((self.root / "reference.png").read_bytes())
        (self.root / "escaped.png").symlink_to(outside)
        (self.root / "wrong.png").write_text("not an image", encoding="utf-8")
        for processed in ("", "missing.png", "../outside.png", "escaped.png", str(outside), "wrong.png"):
            with self.subTest(processed=processed), self.assertRaises(ValueError):
                self.generated["processed_image_path"] = processed
                self.validate(generated=[self.generated])

    def test_runtime_asset_paths_are_real_pngs_inside_the_repository(self):
        self.plan["approval_status"] = "approved"
        self.generated["runtime_asset_path"] = "generated.png"
        self.assertEqual((1, 1), self.validate(generated=[self.generated]))
        outside = self.root.parent / "outside.png"
        outside.write_bytes((self.root / "reference.png").read_bytes())
        (self.root / "escaped.png").symlink_to(outside)
        (self.root / "wrong.png").write_text("not an image", encoding="utf-8")
        for runtime in ("", "missing.png", "../outside.png", "escaped.png", str(outside), "wrong.png"):
            with self.subTest(runtime=runtime), self.assertRaises(ValueError):
                self.generated["runtime_asset_path"] = runtime
                self.validate(generated=[self.generated])

    def test_runtime_asset_must_match_processed_source(self):
        self.plan["approval_status"] = "approved"
        self.generated["processed_image_path"] = "generated.png"
        self.generated["runtime_asset_path"] = "runtime.png"
        runtime = self.root / "runtime.png"
        runtime.write_bytes((self.root / "generated.png").read_bytes())
        self.assertEqual((1, 1), self.validate(generated=[self.generated]))
        runtime.write_bytes((self.root / "generated.png").read_bytes() + b"different copy")
        with self.assertRaisesRegex(ValueError, "must match its source image byte-for-byte"):
            self.validate(generated=[self.generated])

    def test_malformed_json_reports_file_and_line(self):
        self.plan_path.write_text('{"action_id":\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "plan.jsonl:1: invalid JSON"):
            ASSETS.read_jsonl(self.plan_path)


if __name__ == "__main__":
    unittest.main()
