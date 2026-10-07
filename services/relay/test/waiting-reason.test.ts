import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryRelayRepository, SqliteRelayRepository, type RelayRepository } from "../src/repository.js";
import type { EventEnvelope } from "../src/types.js";

for (const storage of ["memory", "sqlite"] as const) {
  test(`${storage}: explicit waiting survives parallel tools, other sessions and metadata; only matching progress clears`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "waiting-reason-"));
    const dbPath = join(directory, "relay.sqlite");
    let repository: RelayRepository = storage === "sqlite" ? new SqliteRelayRepository(dbPath) : new InMemoryRelayRepository();
    const at = "2026-10-07T12:00:00.000Z";
    let sequence = 0;
    const record = (event_type: EventEnvelope["event_type"], payload: unknown = {}, correlation_id?: string, session_id = "s1", task_id = "task-1") => {
      sequence += 1;
      repository.recordEvent({ type: "event", schema_version: 1, event_id: `install:${sequence}`, installation_id: "install", session_id,
        task_id, sequence, occurred_at: at, event_type, payload, ...(correlation_id ? { correlation_id } : {}),
        ...(event_type === "session_title_updated" ? { session_title: "Renamed task" } : {}) }, at);
    };
    const row = () => repository.getInstallationState("install", at)!.sessions!.find((row) => row.session_id === "s1")!;
    try {
      record("task_started");
      record("waiting", { tool_name: "AskUserQuestion", reason: "question" }, "question-1");
      const waitingSequence = row().last_activity_sequence;
      record("task_started", {}, undefined, "parallel-session", "other-task");
      assert.equal(repository.getInstallationState("install", at)!.claude_state, "working");
      for (const [event_type, payload, correlation_id] of [
        ["tool_started", { tool_name: "Bash" }, "bash-1"],
        ["tool_finished", { tool_name: "Bash" }, "bash-1"],
        ["tool_failed", { tool_name: "AskUserQuestion" }, "other-question"],
        ["waiting", { reason: "unknown" }, undefined],
        ["waiting", { tool_name: "AskUserQuestion", reason: "question" }, undefined],
        ["approval_requested", { request_id: "parallel-approval" }, undefined],
        ["approval_resolved", { request_id: "parallel-approval", status: "approved" }, undefined],
        ["session_title_updated", {}, undefined],
      ] as const) {
        record(event_type, payload, correlation_id);
        assert.equal(row().claude_state, "waiting", event_type);
        assert.equal(row().waiting_reason, "question", event_type);
        assert.equal(row().last_activity_sequence, waitingSequence, event_type);
      }
      if (storage === "sqlite") {
        repository.close?.();
        repository = new SqliteRelayRepository(dbPath);
        assert.equal(row().waiting_reason, "question", "restart restores the current explicit reason and binding");
        assert.equal(row().last_activity_sequence, waitingSequence);
      }
      record("tool_finished", { tool_name: "AskUserQuestion" }, "question-1");
      assert.equal(row().claude_state, "working");
      assert.equal(row().waiting_reason, undefined);
      record("waiting", { tool_name: "ExitPlanMode", reason: "approval" }, "plan-1");
      record("tool_failed", { tool_name: "ExitPlanMode" }, "plan-1");
      assert.equal(row().claude_state, "idle");
      assert.equal(row().waiting_reason, undefined);
      record("waiting", { tool_name: "AskUserQuestion", reason: "question" }, "question-2");
      record("task_started", {}, undefined, "s1", "task-2");
      assert.equal(row().waiting_reason, undefined, "a clearly new task ends the old question wait");
      record("waiting", { tool_name: "AskUserQuestion", reason: "question" }, "question-3", "s1", "task-2");
      record("task_finished", {}, undefined, "s1", "task-2");
      assert.equal(row().waiting_reason, undefined);
      record("task_started", {}, undefined, "s1", "task-3");
      record("waiting", { reason: "unknown" }, undefined, "s1", "task-3");
      assert.equal(row().waiting_reason, undefined, "unknown never becomes an explicit blocked question");
      record("waiting", { reason: "input" }, undefined, "s1", "task-3");
      record("tool_started", { tool_name: "Bash" }, "parallel-bash", "s1", "task-3");
      record("tool_finished", { tool_name: "Bash" }, "parallel-bash", "s1", "task-3");
      assert.equal(row().waiting_reason, "input", "unbound input cannot be declared answered by an unrelated tool");
      record("task_failed", {}, undefined, "s1", "task-3");
      assert.equal(row().waiting_reason, undefined);
    } finally { repository.close?.(); await rm(directory, { recursive: true, force: true }); }
  });
}
