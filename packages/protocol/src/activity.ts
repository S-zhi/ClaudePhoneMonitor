import {
  CLAUDE_STATES,
  COMPUTER_STATES,
  EVENT_TYPES,
  MONITOR_STATUS,
  TRANSIENT_DURATIONS_MS,
} from "./constants.js";
import type {
  BaseMonitorStatus,
  EventEnvelope,
  MonitorEventType,
  MonitorStatus,
  Snapshot,
  TransientMonitorStatus,
} from "./types.js";

export interface ActivityClassification {
  readonly status: MonitorStatus;
  readonly base_status: BaseMonitorStatus;
  readonly overlay: TransientMonitorStatus | null;
  readonly duration_ms?: number;
}

const baseForClaudeState = (claude_state: Snapshot["claude_state"]): BaseMonitorStatus => {
  switch (claude_state) {
    case CLAUDE_STATES.WORKING:
      return MONITOR_STATUS.WORKING;
    case CLAUDE_STATES.WAITING:
      return MONITOR_STATUS.WAITING;
    case CLAUDE_STATES.IDLE:
    default:
      return MONITOR_STATUS.IDLE;
  }
};

export function classifySnapshot(snapshot: Snapshot): ActivityClassification {
  if (snapshot.computer_state !== COMPUTER_STATES.ONLINE) {
    return {
      status: MONITOR_STATUS.OFFLINE,
      base_status: MONITOR_STATUS.OFFLINE,
      overlay: null,
    };
  }

  const base_status = baseForClaudeState(snapshot.claude_state);
  return { status: base_status, base_status, overlay: null };
}

export function classifyEvent(event: EventEnvelope): ActivityClassification {
  return classifyEventType(event.event_type);
}

export function classifyEventType(event_type: MonitorEventType): ActivityClassification {
  switch (event_type) {
    case EVENT_TYPES.SESSION_STARTED:
    case EVENT_TYPES.SESSION_ENDED:
      return idleClassification();
    case EVENT_TYPES.TASK_STARTED:
    case EVENT_TYPES.TOOL_STARTED:
    case EVENT_TYPES.TOOL_FINISHED:
      return workingClassification();
    case EVENT_TYPES.WAITING:
      return {
        status: MONITOR_STATUS.WAITING,
        base_status: MONITOR_STATUS.WAITING,
        overlay: null,
      };
    case EVENT_TYPES.TOOL_FAILED:
      return errorClassification(MONITOR_STATUS.IDLE);
    case EVENT_TYPES.TASK_FINISHED:
      return finishClassification();
    case EVENT_TYPES.TASK_FAILED:
      return errorClassification(MONITOR_STATUS.IDLE);
    default:
      return idleClassification();
  }
}

function idleClassification(): ActivityClassification {
  return {
    status: MONITOR_STATUS.IDLE,
    base_status: MONITOR_STATUS.IDLE,
    overlay: null,
  };
}

function workingClassification(): ActivityClassification {
  return {
    status: MONITOR_STATUS.WORKING,
    base_status: MONITOR_STATUS.WORKING,
    overlay: null,
  };
}

function finishClassification(): ActivityClassification {
  return {
    status: MONITOR_STATUS.FINISH,
    base_status: MONITOR_STATUS.IDLE,
    overlay: MONITOR_STATUS.FINISH,
    duration_ms: TRANSIENT_DURATIONS_MS[MONITOR_STATUS.FINISH],
  };
}

function errorClassification(base_status: BaseMonitorStatus): ActivityClassification {
  return {
    status: MONITOR_STATUS.ERROR,
    base_status,
    overlay: MONITOR_STATUS.ERROR,
    duration_ms: TRANSIENT_DURATIONS_MS[MONITOR_STATUS.ERROR],
  };
}

/**
 * Resolve simultaneous durable session signals with Working ahead of Waiting.
 * Transient FINISH/ERROR are
 * handled by the reducer overlay; ERROR is accepted here as a convenience for
 * callers that merge already-classified signals.
 */
export function highestPriorityBaseStatus(
  statuses: readonly BaseMonitorStatus[],
): BaseMonitorStatus {
  if (statuses.includes(MONITOR_STATUS.OFFLINE)) return MONITOR_STATUS.OFFLINE;
  if (statuses.includes(MONITOR_STATUS.WORKING)) return MONITOR_STATUS.WORKING;
  if (statuses.includes(MONITOR_STATUS.WAITING)) return MONITOR_STATUS.WAITING;
  return MONITOR_STATUS.IDLE;
}

export function highestPriorityStatus(
  statuses: readonly MonitorStatus[],
): MonitorStatus {
  if (statuses.includes(MONITOR_STATUS.OFFLINE)) return MONITOR_STATUS.OFFLINE;
  if (statuses.includes(MONITOR_STATUS.ERROR)) return MONITOR_STATUS.ERROR;
  if (statuses.includes(MONITOR_STATUS.WORKING)) return MONITOR_STATUS.WORKING;
  if (statuses.includes(MONITOR_STATUS.WAITING)) return MONITOR_STATUS.WAITING;
  if (statuses.includes(MONITOR_STATUS.FINISH)) return MONITOR_STATUS.FINISH;
  return MONITOR_STATUS.IDLE;
}

export function classifyActivity(
  source: EventEnvelope | Snapshot | MonitorEventType,
): ActivityClassification {
  if (typeof source === "string") return classifyEventType(source);
  if ("computer_state" in source) return classifySnapshot(source);
  return classifyEvent(source);
}

export const classifyMonitorEvent = classifyEvent;

export function statusFromClaudeState(
  claude_state: Snapshot["claude_state"],
): BaseMonitorStatus {
  return baseForClaudeState(claude_state);
}

export function eventTypeProducesOverlay(
  event_type: MonitorEventType,
): TransientMonitorStatus | null {
  if (event_type === EVENT_TYPES.TASK_FINISHED) return MONITOR_STATUS.FINISH;
  if (
    event_type === EVENT_TYPES.TASK_FAILED ||
    event_type === EVENT_TYPES.TOOL_FAILED
  ) {
    return MONITOR_STATUS.ERROR;
  }
  return null;
}
