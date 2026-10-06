import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { FileOutbox } from "../src/outbox.ts";

test("durable outbox retries after a delay and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-outbox-"));
  const filePath = join(directory, "outbox.json");
  let clock = 1_000;
  try {
    const outbox = new FileOutbox<{ safe: true }>(filePath, {
      clock: () => clock,
      idFactory: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });
    const record = await outbox.enqueue({
      id: "event-1",
      sequence: 1,
      payload: { safe: true },
      created_at: new Date(clock).toISOString(),
    });
    assert.equal(record.attempts, 0);
    assert.equal((await outbox.peek()).length, 1);

    clock = 2_000;
    assert.equal(
      await outbox.retry("event-1", new Error("SECRET /Users/alice/private.txt"), 3_000),
      true,
    );
    assert.equal((await outbox.peek()).length, 0);
    const persisted = await readFile(filePath, "utf8");
    assert.equal(persisted.includes("SECRET"), false);
    assert.equal(persisted.includes("/Users/alice"), false);

    const restarted = new FileOutbox<{ safe: true }>(filePath, { clock: () => clock });
    clock = 4_999;
    assert.equal((await restarted.peek()).length, 0);
    clock = 5_000;
    const available = await restarted.peek();
    assert.equal(available.length, 1);
    assert.equal(available[0]?.attempts, 1);
    assert.equal(await restarted.ack(1), true);
    assert.equal(await restarted.size(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("outbox acknowledges by event id or sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-outbox-"));
  try {
    const outbox = new FileOutbox<{ value: number }>(join(directory, "outbox.json"));
    await outbox.enqueue({ id: "event-a", sequence: 10, payload: { value: 1 } });
    await outbox.enqueue({ id: "event-b", sequence: 11, payload: { value: 2 } });
    assert.equal(await outbox.ack("event-a"), true);
    assert.equal(await outbox.ack(11), true);
    assert.equal(await outbox.ack("missing"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enqueue persistence failure rolls back memory so the same id and sequence can retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collector-outbox-"));
  const filePath = join(directory, "outbox.json");
  try {
    const outbox = new FileOutbox<{ value: number }>(filePath);
    assert.equal(await outbox.size(), 0); // Load before inducing a transient rename failure.
    await mkdir(filePath);

    await assert.rejects(
      outbox.enqueue({ id: "stable-event", sequence: 7, payload: { value: 3 } }),
    );
    assert.deepEqual(await outbox.snapshot(), []);

    await rm(filePath, { recursive: true });
    const retried = await outbox.enqueue({ id: "stable-event", sequence: 7, payload: { value: 3 } });
    assert.equal(retried.id, "stable-event");
    assert.equal(retried.sequence, 7);
    assert.equal((await outbox.snapshot()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
