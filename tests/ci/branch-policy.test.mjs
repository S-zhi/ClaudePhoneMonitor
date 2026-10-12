import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowPath = new URL("../../.github/workflows/branch-policy.yml", import.meta.url);
const workflow = await readFile(workflowPath, "utf8");

function isAllowed(head, base) {
  const magpieHead = head === "dev/magpie" || head.startsWith("dev/magpie-") || head.startsWith("codex/magpie-");
  return !magpieHead || base === "dev/magpie";
}

test("branch policy runs on metadata-changing pull request events", () => {
  for (const event of ["opened", "synchronize", "reopened", "edited", "ready_for_review"]) {
    assert.match(workflow, new RegExp(`\\b${event}\\b`));
  }
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
});

test("Magpie branch directions are explicit", () => {
  const cases = [
    ["dev/magpie", "main", false],
    ["dev/magpie", "dev/magpie", true],
    ["dev/magpie-feature", "main", false],
    ["dev/magpie-feature", "dev/magpie", true],
    ["codex/magpie-review", "main", false],
    ["codex/magpie-review", "dev/magpie", true],
    ["feature/unrelated", "main", true],
  ];
  for (const [head, base, expected] of cases) assert.equal(isAllowed(head, base), expected, `${head} -> ${base}`);
  assert.ok(workflow.includes("dev/magpie-*") && workflow.includes("codex/magpie-*"));
  assert.match(workflow, /Prevent dev\/magpie to main/);
});
