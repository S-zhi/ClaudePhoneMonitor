export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;
export type LogSink = (line: string) => void;

const SENSITIVE_KEY = /(?:authorization|(?:auth|access|refresh)?[_-]?token|api[_-]?key|secret|password|pairing(?:[_-]?code)?|payload|raw|content|prompt|user[_-]?text|transcript|cookie|^message$|^text$)/i;
const BEARER_VALUE = /bearer\s+[a-z0-9._~+\-/]+=*/gi;
const API_KEY_VALUE = /sk-ant-[a-z0-9_-]+/gi;

function sanitizeString(value: string): string {
  return value.replace(BEARER_VALUE, "[omitted]").replace(API_KEY_VALUE, "[omitted]");
}

export function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function sanitizeForLog(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveLogKey(key)) return undefined;
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item)).filter((item) => item !== undefined);
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeForLog(childValue, childKey);
    if (sanitized !== undefined) output[childKey] = sanitized;
  }
  return output;
}

export class JsonLogger {
  private readonly sink: LogSink;
  private readonly clock: () => Date;

  constructor(options: { sink?: LogSink; clock?: () => Date } = {}) {
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.clock = options.clock ?? (() => new Date());
  }

  log(level: LogLevel, message: string, context: LogContext = {}): void {
    const safeContext = sanitizeForLog(context) as Record<string, unknown>;
    const entry = {
      timestamp: this.clock().toISOString(),
      level,
      message: sanitizeString(message),
      ...safeContext,
    };
    this.sink(JSON.stringify(entry));
  }

  debug(message: string, context?: LogContext): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log("error", message, context);
  }
}
