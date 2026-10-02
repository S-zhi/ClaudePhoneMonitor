export interface RelayConfig {
  host: string;
  port: number;
  staleAfterMs: number;
  offlineAfterMs: number;
  bookkeepingIntervalMs: number;
  heartbeatIntervalMs: number;
  probeTimeoutMs: number;
  maxMessageBytes: number;
  maxStoredEvents: number;
  pairingTtlMs: number;
  authMode: "development" | "paired";
  bootstrapSecret?: string;
  publicUrl?: string;
  databasePath?: string;
}

const DEFAULTS: RelayConfig = {
  host: "0.0.0.0",
  port: 8787,
  staleAfterMs: 15_000,
  offlineAfterMs: 60_000,
  bookkeepingIntervalMs: 1_000,
  heartbeatIntervalMs: 10_000,
  probeTimeoutMs: 5_000,
  maxMessageBytes: 256 * 1024,
  maxStoredEvents: 10_000,
  pairingTtlMs: 10 * 60_000,
  authMode: "paired",
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<RelayConfig> = {},
): RelayConfig {
  const envBootstrapSecret = nonEmpty(env.RELAY_BOOTSTRAP_SECRET);
  const bootstrapSecret = envBootstrapSecret ?? nonEmpty(overrides.bootstrapSecret);
  const requestedAuthMode =
    overrides.authMode ?? (env.RELAY_AUTH_MODE === "development" ? "development" : "paired");
  const config: RelayConfig = {
    ...DEFAULTS,
    host: env.RELAY_HOST?.trim() || DEFAULTS.host,
    port: positiveInteger(env.RELAY_PORT ?? env.PORT, DEFAULTS.port),
    staleAfterMs: positiveInteger(env.RELAY_STALE_AFTER_MS, DEFAULTS.staleAfterMs),
    offlineAfterMs: positiveInteger(
      env.RELAY_OFFLINE_AFTER_MS,
      DEFAULTS.offlineAfterMs,
    ),
    bookkeepingIntervalMs: positiveInteger(
      env.RELAY_BOOKKEEPING_INTERVAL_MS,
      DEFAULTS.bookkeepingIntervalMs,
    ),
    heartbeatIntervalMs: positiveInteger(
      env.RELAY_HEARTBEAT_INTERVAL_MS,
      DEFAULTS.heartbeatIntervalMs,
    ),
    probeTimeoutMs: positiveInteger(env.RELAY_PROBE_TIMEOUT_MS, DEFAULTS.probeTimeoutMs),
    maxMessageBytes: positiveInteger(
      env.RELAY_MAX_MESSAGE_BYTES,
      DEFAULTS.maxMessageBytes,
    ),
    maxStoredEvents: positiveInteger(
      env.RELAY_MAX_STORED_EVENTS,
      DEFAULTS.maxStoredEvents,
    ),
    pairingTtlMs: positiveInteger(env.RELAY_PAIRING_TTL_MS, DEFAULTS.pairingTtlMs),
    authMode: bootstrapSecret ? "paired" : requestedAuthMode,
    ...(bootstrapSecret ? { bootstrapSecret } : {}),
    ...(nonEmpty(env.RELAY_PUBLIC_URL) ?? nonEmpty(overrides.publicUrl)
      ? { publicUrl: nonEmpty(env.RELAY_PUBLIC_URL) ?? nonEmpty(overrides.publicUrl) }
      : {}),
    ...(nonEmpty(env.RELAY_DB_PATH) ?? nonEmpty(overrides.databasePath)
      ? { databasePath: nonEmpty(env.RELAY_DB_PATH) ?? nonEmpty(overrides.databasePath) }
      : {}),
    ...overrides,
  };

  // A bootstrap secret always turns on paired mode, even if an override asks for
  // development mode. This prevents tests or other callers from bypassing a
  // production secret through RelayConfig overrides.
  if (envBootstrapSecret) {
    config.bootstrapSecret = envBootstrapSecret;
    config.authMode = "paired";
  } else if (config.bootstrapSecret) {
    config.authMode = "paired";
  }

  if (config.offlineAfterMs <= config.staleAfterMs) {
    throw new Error("offlineAfterMs must be greater than staleAfterMs");
  }

  return config;
}
