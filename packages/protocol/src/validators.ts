import { FORBIDDEN_FORWARD_KEYS, MESSAGE_TYPES } from "./constants.js";
import {
  EVENT_ENVELOPE_SCHEMA,
  EVENT_PAYLOAD_SCHEMAS,
  PROTOCOL_MESSAGE_SCHEMA,
  SNAPSHOT_SCHEMA,
} from "./schemas.js";
import type {
  EventEnvelope,
  EventPayload,
  JsonSchema,
  MonitorEventType,
  ProtocolMessage,
  Snapshot,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[_.-]/g, "");
const forbiddenKeys = new Set<string>(FORBIDDEN_FORWARD_KEYS.map(normalizeKey));

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isWireTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

const pathFor = (path: string, key: string): string =>
  path === "$" ? `$.${key}` : `${path}.${key}`;

const indexPathFor = (path: string, index: number): string => `${path}[${index}]`;

/** Small dependency-free JSON Schema validator for the subset used by this package. */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
): readonly ValidationIssue[] {
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    return [{ path, message: `must equal ${JSON.stringify(schema.const)}` }];
  }

  if (schema.enum && !schema.enum.some((entry) => Object.is(value, entry))) {
    return [{ path, message: `must be one of ${schema.enum.join(", ")}` }];
  }

  if (schema.oneOf) {
    const candidateIssues = schema.oneOf.map((candidate) =>
      validateAgainstSchema(value, candidate, path),
    );
    if (candidateIssues.some((issues) => issues.length === 0)) return [];
    return [
      {
        path,
        message: "must match one of the protocol schemas",
      },
    ];
  }

  if (schema.anyOf) {
    const candidateIssues = schema.anyOf.map((candidate) =>
      validateAgainstSchema(value, candidate, path),
    );
    if (candidateIssues.some((issues) => issues.length === 0)) return [];
    return [
      {
        path,
        message: "must match at least one of the protocol schemas",
      },
    ];
  }

  if (schema.type) {
    const typeMatches = (() => {
      switch (schema.type) {
        case "object":
          return isRecord(value);
        case "array":
          return Array.isArray(value);
        case "string":
          return typeof value === "string";
        case "number":
          return typeof value === "number" && Number.isFinite(value);
        case "integer":
          return typeof value === "number" && Number.isInteger(value);
        case "boolean":
          return typeof value === "boolean";
        case "null":
          return value === null;
      }
    })();
    if (!typeMatches) {
      return [{ path, message: `must be a ${schema.type}` }];
    }
  }

  const issues: ValidationIssue[] = [];

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `must contain at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `must contain at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path, message: "has an invalid format" });
    }
    if (schema.format === "date-time" && !isWireTimestamp(value)) {
      issues.push({ path, message: "must be an ISO-8601 date-time" });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be at least ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be at most ${schema.maximum}` });
    }
  }

  if (Array.isArray(value) && schema.items) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    value.forEach((item, index) => {
      issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, indexPathFor(path, index)));
    });
  }

  if (isRecord(value)) {
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in value)) {
        issues.push({ path: pathFor(path, requiredKey), message: "is required" });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = properties[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          issues.push({ path: pathFor(path, key), message: "is not allowed" });
        } else if (typeof schema.additionalProperties === "object") {
          issues.push(...validateAgainstSchema(childValue, schema.additionalProperties, pathFor(path, key)));
        }
        continue;
      }
      issues.push(...validateAgainstSchema(childValue, childSchema, pathFor(path, key)));
    }
  }

  return issues;
}

const forbiddenForwardingIssues = (value: unknown, path = "$", seen = new Set<object>()): ValidationIssue[] => {
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [{ path, message: "must not contain cyclic data" }];
  seen.add(value);

  const issues: ValidationIssue[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      issues.push(...forbiddenForwardingIssues(entry, indexPathFor(path, index), seen));
    });
    seen.delete(value);
    return issues;
  }

  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(normalizeKey(key))) {
      issues.push({ path: pathFor(path, key), message: "Claude prompt/tool content cannot cross the protocol boundary" });
      continue;
    }
    issues.push(...forbiddenForwardingIssues(child, pathFor(path, key), seen));
  }
  seen.delete(value);
  return issues;
};

const resultFor = <T>(value: unknown, schema: JsonSchema, rejectForwardedContent = true): ValidationResult<T> => {
  const issues = [
    ...validateAgainstSchema(value, schema),
    ...(rejectForwardedContent ? forbiddenForwardingIssues(value) : []),
  ];
  return issues.length === 0
    ? { success: true, data: value as T }
    : { success: false, issues };
};

export function validateEventEnvelope(value: unknown): ValidationResult<EventEnvelope> {
  return resultFor<EventEnvelope>(value, EVENT_ENVELOPE_SCHEMA);
}

export function validateSnapshot(value: unknown): ValidationResult<Snapshot> {
  return resultFor<Snapshot>(value, SNAPSHOT_SCHEMA);
}

export function validateProtocolMessage(value: unknown): ValidationResult<ProtocolMessage> {
  return resultFor<ProtocolMessage>(value, PROTOCOL_MESSAGE_SCHEMA);
}

export function validateEventPayload<T extends MonitorEventType>(
  eventType: T,
  payload: unknown,
): ValidationResult<EventPayload<T>> {
  const schema = EVENT_PAYLOAD_SCHEMAS[eventType];
  if (!schema) {
    return {
      success: false,
      issues: [{ path: "$.event_type", message: "unknown event type" }],
    };
  }
  return resultFor<EventPayload<T>>(payload, schema);
}

export function isEventEnvelope(value: unknown): value is EventEnvelope {
  return validateEventEnvelope(value).success;
}

export function isSnapshot(value: unknown): value is Snapshot {
  return validateSnapshot(value).success;
}

export function isProtocolMessage(value: unknown): value is ProtocolMessage {
  return validateProtocolMessage(value).success;
}

export class ProtocolValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "ProtocolValidationError";
    this.issues = issues;
  }
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
  const result = validateEventEnvelope(value);
  if (!result.success) throw new ProtocolValidationError("Invalid event envelope", result.issues);
  return result.data;
}

export function parseSnapshot(value: unknown): Snapshot {
  const result = validateSnapshot(value);
  if (!result.success) throw new ProtocolValidationError("Invalid snapshot", result.issues);
  return result.data;
}

export function parseProtocolMessage(value: unknown): ProtocolMessage {
  const candidate = typeof value === "string" ? parseJson(value) : value;
  const result = validateProtocolMessage(candidate);
  if (!result.success) throw new ProtocolValidationError("Invalid protocol message", result.issues);
  return result.data;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ProtocolValidationError("Protocol message is not valid JSON", [
      { path: "$", message: "must be valid JSON" },
    ]);
  }
}

/** Return the message discriminator without trusting it as a valid message. */
export function messageType(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  return value.type;
}

export const isEventMessage = isEventEnvelope;
export const isSnapshotMessage = isSnapshot;
export const validateMessage = validateProtocolMessage;
export const parseMessage = parseProtocolMessage;
export const isValidEventEnvelope = isEventEnvelope;
export const isValidSnapshot = isSnapshot;
export const isValidProtocolMessage = isProtocolMessage;

// Keep this import used in generated declaration files when consumers inspect constants.
void MESSAGE_TYPES;
