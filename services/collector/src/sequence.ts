import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";

export interface SequenceOptions {
  initialValue?: number;
}

/** Persistent, process-local monotonic sequence generator. */
export class LocalSequence {
  private loaded = false;
  private value = 0;
  private operation: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly options: SequenceOptions = {},
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = Number.parseInt(text.trim(), 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) this.value = parsed;
      else this.value = this.options.initialValue ?? 0;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") {
        // A corrupted local counter should never crash a hook/collector. Start
        // from the configured floor; the old file is kept for diagnostics.
        const quarantine = `${this.filePath}.corrupt-${process.pid}-${Date.now()}`;
        await rename(this.filePath, quarantine).catch(() => undefined);
      }
      this.value = this.options.initialValue ?? 0;
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${this.value}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async next(): Promise<number> {
    return this.serialize(async () => {
      await this.load();
      if (this.value >= Number.MAX_SAFE_INTEGER) throw new Error("sequence_exhausted");
      this.value += 1;
      await this.persist();
      return this.value;
    });
  }

  public async current(): Promise<number> {
    return this.serialize(async () => {
      await this.load();
      return this.value;
    });
  }
}

export type SequenceGenerator = LocalSequence;

/** Stable installation id persisted separately from the event sequence. */
export class InstallationIdentity {
  private operation: Promise<unknown> = Promise.resolve();
  private value: string | undefined;

  public constructor(private readonly filePath: string) {}

  public async get(): Promise<string> {
    const result = this.operation.then(async () => {
      if (this.value) return this.value;
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      try {
        const existing = (await readFile(this.filePath, "utf8")).trim();
        if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(existing)) {
          this.value = existing;
          return existing;
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
        if (code !== "ENOENT") throw error;
      }

      const generated = randomUUID();
      const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, `${generated}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        await chmod(temporary, 0o600);
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.value = generated;
      return generated;
    });
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export type DeviceIdentity = InstallationIdentity;

export function eventId(installationId: string, sequence: number): string {
  return `${installationId}:${sequence}`;
}

export const makeEventId = eventId;
