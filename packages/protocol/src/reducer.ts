import {
  ERROR_DURATION_MS,
  EVENT_TYPES,
  FINISH_DURATION_MS,
  MONITOR_STATUS,
  TRANSIENT_DURATIONS_MS,
} from "./constants.js";
import { classifyEvent, classifySnapshot } from "./activity.js";
import { acceptSequence } from "./sequence.js";
import type {
  BaseMonitorStatus,
  EventEnvelope,
  MonitorAction,
  MonitorState,
  MonitorStatus,
  Snapshot,
  Timestamp,
  TransientMonitorStatus,
  TransientOverlay,
  WireTimestamp,
} from "./types.js";

export const INITIAL_MONITOR_STATE: MonitorState = Object.freeze({
  base_status: MONITOR_STATUS.IDLE,
  overlay: null,
  last_sequence: 0,
  updated_at: 0,
});

export const initialMonitorState = INITIAL_MONITOR_STATE;

export function createInitialMonitorState(
  updated_at = 0,
  last_sequence = 0,
): MonitorState {
  return {
    base_status: MONITOR_STATUS.IDLE,
    overlay: null,
    last_sequence,
    updated_at,
  };
}

export function isOverlayActive(
  overlay: TransientOverlay | null,
  at: Timestamp,
): overlay is TransientOverlay {
  return overlay !== null && at < overlay.expires_at;
}

export function effectiveMonitorStatus(
  state: MonitorState,
  at = state.updated_at,
): MonitorStatus {
  // OFFLINE is a durable connection condition and always wins.
  if (state.base_status === MONITOR_STATUS.OFFLINE) return MONITOR_STATUS.OFFLINE;
  if (!isOverlayActive(state.overlay, at)) return state.base_status;
  // ERROR wins over every other visible status. FINISH is the only other overlay.
  if (state.overlay.status === MONITOR_STATUS.ERROR) return MONITOR_STATUS.ERROR;
  return MONITOR_STATUS.FINISH;
}

export const getEffectiveStatus = effectiveMonitorStatus;
export const monitorStatus = effectiveMonitorStatus;

export function nextOverlayExpiry(state: MonitorState): Timestamp | null {
  return state.overlay?.expires_at ?? null;
}

export function transientRemainingMs(
  state: MonitorState,
  at = state.updated_at,
): number {
  if (!isOverlayActive(state.overlay, at)) return 0;
  return state.overlay.expires_at - at;
}

export function expireOverlay(state: MonitorState, at: Timestamp): MonitorState {
  if (!state.overlay || state.overlay.expires_at > at) return state;
  return { ...state, overlay: null, updated_at: Math.max(state.updated_at, at) };
}

export function monitorReducer(
  state: MonitorState,
  action: MonitorAction,
): MonitorState {
  switch (action.type) {
    case "event":
      return reduceEvent(state, action.event);
    case "snapshot":
      return reduceSnapshot(state, action.snapshot);
    case "tick":
      return expireOverlay(state, action.at);
    case "base":
      return reduceBase(state, action.status, action.at, action.sequence);
    case "overlay":
      return reduceOverlay(state, action.status, action.at, action.message, action.sequence);
    case "reset":
      return {
        base_status: MONITOR_STATUS.IDLE,
        overlay: null,
        last_sequence: action.sequence ?? 0,
        updated_at: action.at,
      };
  }
}

export const reduceMonitorState = monitorReducer;

export function reduceEvent(state: MonitorState, event: EventEnvelope): MonitorState {
  const decision = acceptSequence(state.last_sequence, event.sequence);
  if (!decision.accepted) return state;

  if (event.session_kind === "subagent" || event.event_type === EVENT_TYPES.SESSION_CLASSIFICATION_UPDATED) {
    return { ...state, last_sequence: event.sequence };
  }
  const classification = classifyEvent(event);
  const eventAt = timestampToMillis(event.occurred_at);
  const at = Math.max(state.updated_at, eventAt);
  if (event.event_type === EVENT_TYPES.SESSION_TITLE_UPDATED) {
    return { ...state, last_sequence: event.sequence, updated_at: at };
  }
  let next: MonitorState = {
    ...state,
    base_status: classification.base_status,
    last_sequence: event.sequence,
    updated_at: at,
  };

  if (classification.overlay) {
    next = reduceOverlay(
      next,
      classification.overlay,
      eventAt,
      undefined,
      undefined,
    );
  }
  return next;
}

export function reduceSnapshot(
  _state: MonitorState,
  snapshot: Snapshot,
): MonitorState {
  const classification = classifySnapshot(snapshot);
  return {
    base_status: classification.base_status,
    overlay: null,
    last_sequence: snapshot.last_sequence ?? 0,
    updated_at: timestampToMillis(snapshot.updated_at),
  };
}

function reduceBase(
  state: MonitorState,
  status: BaseMonitorStatus,
  at: Timestamp,
  sequence: number | undefined,
): MonitorState {
  if (!acceptOptionalSequence(state.last_sequence, sequence)) return state;
  return {
    ...state,
    base_status: status,
    last_sequence: sequence ?? state.last_sequence,
    updated_at: Math.max(state.updated_at, at),
  };
}

function reduceOverlay(
  state: MonitorState,
  status: TransientMonitorStatus,
  at: Timestamp,
  message: string | undefined,
  sequence: number | undefined,
): MonitorState {
  if (!acceptOptionalSequence(state.last_sequence, sequence)) return state;

  const previous = isOverlayActive(state.overlay, at) ? state.overlay : null;
  // An active ERROR should not be hidden by a later FINISH flash.
  if (
    previous?.status === MONITOR_STATUS.ERROR &&
    status === MONITOR_STATUS.FINISH
  ) {
    return {
      ...state,
      last_sequence: sequence ?? state.last_sequence,
      updated_at: Math.max(state.updated_at, at),
    };
  }

  const duration = TRANSIENT_DURATIONS_MS[status];
  const overlay: TransientOverlay = {
    status,
    started_at: at,
    expires_at: at + duration,
    ...(message === undefined ? {} : { message }),
  };
  return {
    ...state,
    overlay,
    last_sequence: sequence ?? state.last_sequence,
    updated_at: Math.max(state.updated_at, at),
  };
}

function acceptOptionalSequence(
  previous: number,
  incoming: number | undefined,
): boolean {
  if (incoming === undefined) return true;
  return acceptSequence(previous, incoming).accepted;
}

export function statusToBase(status: MonitorStatus): BaseMonitorStatus {
  switch (status) {
    case MONITOR_STATUS.OFFLINE:
      return MONITOR_STATUS.OFFLINE;
    case MONITOR_STATUS.WAITING:
      return MONITOR_STATUS.WAITING;
    case MONITOR_STATUS.WORKING:
      return MONITOR_STATUS.WORKING;
    case MONITOR_STATUS.IDLE:
    case MONITOR_STATUS.FINISH:
    case MONITOR_STATUS.ERROR:
    default:
      return MONITOR_STATUS.IDLE;
  }
}

export function snapshotStatus(snapshot: Snapshot): MonitorStatus {
  const state = reduceSnapshot(INITIAL_MONITOR_STATE, snapshot);
  return effectiveMonitorStatus(state, state.updated_at);
}

export function timestampToMillis(value: WireTimestamp): Timestamp {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

export function overlayDurationMs(status: TransientMonitorStatus): number {
  return status === MONITOR_STATUS.FINISH ? FINISH_DURATION_MS : ERROR_DURATION_MS;
}

// Keep event constants in generated declarations for consumers using action factories.
void EVENT_TYPES;
