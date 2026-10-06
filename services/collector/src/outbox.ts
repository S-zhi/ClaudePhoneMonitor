import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import type { EnqueueInput, Outbox, OutboxRecord } from "./types.js";

export type { EnqueueInput, Outbox, OutboxRecord } from "./types.js";

interface PersistedOutbox<T> {
  version: 1;
  records: OutboxRecord<T>[];
}

export interface FileOutboxOptions {
  clock?: () => number;
  idFactory?: () => string;
  defaultRetryDelayMs?: number;
  maxErrorLength?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRecord<T>(value: unknown): value is OutboxRecord<T> {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    Number.isSafeInteger(value.sequence) &&
    "payload" in value &&
    typeof value.created_at === "string" &&
    typeof value.attempts === "number" &&
    Number.isInteger(value.attempts) &&
    value.attempts >= 0 &&
    typeof value.available_at === "number" &&
    Number.isFinite(value.available_at)
  );
}

/**
 * A small, dependency-free durable outbox.
 *
 * State is rewritten through a temporary file and rename. This is slower than
 * a database but keeps the collector installable with Node's standard library
 * only, and the write is atomic on the same macOS filesystem.
 */
export class FileOutbox<T> implements Outbox<T> {
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly defaultRetryDelayMs: number;
  private readonly maxErrorLength: number;
  private records: OutboxRecord<T>[] = [];
  private loaded = false;
  private operation: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    options: FileOutboxOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? randomUUID;
    this.defaultRetryDelayMs = Math.max(0, options.defaultRetryDelayMs ?? 1_000);
    this.maxErrorLength = Math.max(0, options.maxErrorLength ?? 96);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (
        isRecord(parsed) &&
        parsed.version === 1 &&
        Array.isArray(parsed.records) &&
        parsed.records.every((record) => validRecord<T>(record))
      ) {
        this.records = parsed.records as OutboxRecord<T>[];
      } else {
        await this.quarantineCorruptFile();
      }
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      if (code !== "ENOENT") await this.quarantineCorruptFile();
    }
    this.loaded = true;
  }

  private async quarantineCorruptFile(): Promise<void> {
    const quarantine = `${this.filePath}.corrupt-${process.pid}-${Date.now()}`;
    try {
      await rename(this.filePath, quarantine);
    } catch {
      // A missing file or an already-quarantined file is equivalent to empty.
    }
    this.records = [];
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.tmp-${process.pid}-${this.idFactory()}`;
    const document: PersistedOutbox<T> = { version: 1, records: this.records };
    await writeFile(temporary, JSON.stringify(document), { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private findIndex(idOrSequence: string | number): number {
    return this.records.findIndex((record) =>
      typeof idOrSequence === "number" ? record.sequence === idOrSequence : record.id === idOrSequence,
    );
  }

  public async enqueue(input: EnqueueInput<T>): Promise<OutboxRecord<T>> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const now = this.clock();
      const record: OutboxRecord<T> = {
        id: input.id ?? this.idFactory(),
        sequence: input.sequence ?? this.nextSequence(),
        payload: input.payload,
        created_at: input.created_at ?? new Date(now).toISOString(),
        attempts: 0,
        available_at: now,
      };
      if (this.records.some((existing) => existing.id === record.id || existing.sequence === record.sequence)) {
        throw new Error("outbox_duplicate_id_or_sequence");
      }
      const previousRecords = this.records;
      this.records = [...previousRecords, record].sort((left, right) => left.sequence - right.sequence);
      try {
        await this.persist();
      } catch (error) {
        // Do not retain a record that was never durably written. Callers such
        // as UsageWatcher retry the same stable id and sequence in-process.
        this.records = previousRecords;
        throw error;
      }
      return { ...record };
    });
  }

  private nextSequence(): number {
    const last = this.records.at(-1);
    return last ? last.sequence + 1 : 1;
  }

  public async peek(limit = 1, now = this.clock()): Promise<OutboxRecord<T>[]> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      if (!Number.isFinite(limit) || limit <= 0) return [];
      return this.records
        .filter((record) => record.available_at <= now)
        .slice(0, Math.floor(limit))
        .map((record) => ({ ...record }));
    });
  }

  public async ack(idOrSequence: string | number): Promise<boolean> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const index = this.findIndex(idOrSequence);
      if (index < 0) return false;
      this.records.splice(index, 1);
      await this.persist();
      return true;
    });
  }

  public async retry(
    idOrSequence: string | number,
    error?: unknown,
    delayMs = this.defaultRetryDelayMs,
  ): Promise<boolean> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const index = this.findIndex(idOrSequence);
      if (index < 0) return false;
      const record = this.records[index];
      if (!record) return false;
      record.attempts += 1;
      record.available_at = this.clock() + Math.max(0, Number.isFinite(delayMs) ? delayMs : this.defaultRetryDelayMs);
      record.last_error = this.safeError(error);
      await this.persist();
      return true;
    });
  }

  private safeError(error: unknown): string | undefined {
    if (error === undefined || error === null) return undefined;
    // Error messages can contain URLs, paths, or server payloads. Persist only
    // the class/name, never the message or stack, so the outbox stays private.
    const name = error instanceof Error && error.name ? error.name : "relay_error";
    return name.slice(0, this.maxErrorLength);
  }

  public async size(): Promise<number> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      return this.records.length;
    });
  }

  public async clear(): Promise<void> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      this.records = [];
      await this.persist();
    });
  }

  public async close(): Promise<void> {
    await this.operation;
  }

  /** Exposed for diagnostics/tests; callers receive a copy. */
  public async snapshot(): Promise<OutboxRecord<T>[]> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      return this.records.map((record) => ({ ...record }));
    });
  }
}

export type DurableOutbox<T> = FileOutbox<T>;

export function outboxFilePath(dataDir: string): string {
  return join(dataDir, "outbox.json");
}
