import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import WebSocket from "ws";

import { loadConfig, type RelayConfig } from "./config.js";
import { JsonLogger } from "./logger.js";
import { InvalidCollectorTokenError, Relay, type RelayOptions } from "./relay.js";
import { RELAY_SCHEMA_VERSION } from "./types.js";

interface GatewayQuery {
  client_id?: string;
  installation_id?: string;
  pairing_id?: string;
  pairing_code?: string;
}

interface SnapshotQuery {
  installation_id?: string;
}

interface PairingParams {
  pairing_id: string;
}

interface PairingBody {
  installation_id: string;
  relay_url: string;
  public_url?: string;
  collector_token?: string;
}

interface CollectorTokenValidationBody {
  installation_id?: string;
  collector_token?: string;
}

interface ClaimBody {
  code?: string;
  device_name?: string;
}

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function pathname(rawUrl: string | undefined): string {
  if (!rawUrl) return "/";
  try {
    return new URL(rawUrl, "http://relay.local").pathname;
  } catch {
    return "/";
  }
}

export interface RelayServerOptions {
  config?: Partial<RelayConfig>;
  relay?: Relay;
  relayOptions?: Omit<RelayOptions, "config">;
  logger?: JsonLogger;
}

export function createRelayServer(options: RelayServerOptions = {}): {
  app: FastifyInstance;
  relay: Relay;
} {
  const config = loadConfig(undefined, options.config);
  const logger = options.logger ?? new JsonLogger();
  const relay =
    options.relay ??
    new Relay({
      ...(options.relayOptions ?? {}),
      config,
      logger,
    });
  const app = Fastify({ logger: false });

  // Invalid upgrade paths use Fastify's HTTP fallback; the peer can reset that raw socket before its response completes.
  app.server.on("upgrade", (request, socket) => {
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const errorCode = typeof error.code === "string" ? error.code : "unknown";
      const context = {
        method: request.method,
        error_code: errorCode,
        error_name: error.name,
      };
      if (errorCode === "ECONNRESET" || errorCode === "EPIPE") {
        logger.debug("websocket_socket_error", context);
      } else {
        logger.error("websocket_socket_error", context);
      }
    });
  });

  app.addHook("onRequest", async (request) => {
    logger.debug("http_request", {
      method: request.method,
      path: pathname(request.raw.url),
    });
  });

  app.get("/healthz", async () => ({
    status: "ok",
    service: "relay",
    schema_version: RELAY_SCHEMA_VERSION,
    auth: { mode: config.authMode },
    storage: relay.repository.storageKind ?? "memory",
    capabilities: ["usage_snapshot_v1", "usage_scoped_cache_v1", "codex_quota_v1", "pairing_collector_reuse_v1"],
    uptime_ms: Math.round(process.uptime() * 1000),
  }));

  app.get("/health", async (_request, reply) => {
    return reply.redirect("/healthz");
  });

  app.get("/readyz", async () => ({
    status: "ready",
    service: "relay",
    storage: relay.repository.storageKind ?? "memory",
    gateways: ["collector", "android"],
    ...relay.stats(),
  }));

  app.get<{ Querystring: SnapshotQuery }>(
    "/v1/snapshot",
    async (request) => ({
      schema_version: RELAY_SCHEMA_VERSION,
      snapshots: relay.snapshots(queryString(request.query.installation_id)),
    }),
  );

  app.post<{ Body: PairingBody }>("/v1/pairing", async (request, reply) => {
    if (config.bootstrapSecret) {
      const authorization = request.headers.authorization ?? "";
      const bearer = authorization.match(/^Bearer (.+)$/i)?.[1];
      if (!bearer || !safeEqualText(bearer, config.bootstrapSecret)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    } else if (config.authMode === "paired" || request.body?.collector_token !== undefined) {
      return reply.code(503).send({ error: "pairing_unavailable" });
    }
    const body = request.body as PairingBody | undefined;
    if (body?.collector_token !== undefined &&
      (typeof body.collector_token !== "string" || !body.collector_token.trim() || body.collector_token.length > 512 ||
        typeof body.installation_id !== "string" || !body.installation_id.trim())) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      const pairing = relay.createPairing(body ?? {} as PairingBody);
      return reply.code(201).send(pairing);
    } catch (error) {
      if (error instanceof InvalidCollectorTokenError) {
        return reply.code(401).send({ error: "invalid_collector_token" });
      }
      throw error;
    }
  });

  app.post<{ Body: CollectorTokenValidationBody }>("/v1/collector-token/validate", async (request, reply) => {
    if (!config.bootstrapSecret) return reply.code(503).send({ error: "pairing_unavailable" });
    const authorization = request.headers.authorization ?? "";
    const bearer = authorization.match(/^Bearer (.+)$/i)?.[1];
    if (!bearer || !safeEqualText(bearer, config.bootstrapSecret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = request.body as CollectorTokenValidationBody | undefined;
    if (
      typeof body?.installation_id !== "string" || !body.installation_id.trim() || body.installation_id.length > 256 ||
      typeof body.collector_token !== "string" || !body.collector_token.trim() || body.collector_token.length > 512
    ) return reply.code(400).send({ error: "invalid_request" });
    if (!relay.isCollectorTokenValid(body.installation_id, body.collector_token)) {
      return reply.code(401).send({ error: "invalid_collector_token" });
    }
    return reply.send({ valid: true, installation_id: body.installation_id });
  });

  app.get<{ Params: PairingParams }>(
    "/v1/pairing/:pairing_id",
    async (request, reply) => {
      const pairing = relay.getPairing(request.params.pairing_id);
      if (!pairing) return reply.code(404).send({ error: "not_found" });
      return pairing;
    },
  );

  app.post<{ Params: PairingParams; Body: ClaimBody }>(
    "/v1/pairing/:pairing_id/claim",
    async (request, reply) => {
      const code = queryString(request.body?.code);
      if (!code) return reply.code(400).send({ error: "invalid_pairing" });
      const claimed = relay.claimPairingResult(
        request.params.pairing_id,
        code,
        queryString(request.body?.device_name),
      );
      if (!claimed) return reply.code(400).send({ error: "invalid_pairing" });
      return reply.code(200).send(claimed);
    },
  );

  app.register(async (instance) => {
    await instance.register(websocket, {
      options: { maxPayload: config.maxMessageBytes },
    });

    instance.get<{ Querystring: GatewayQuery }>(
      "/ws/collector",
      { websocket: true },
      (socket, request) => attachSocket("collector", socket, request, relay),
    );

    instance.get<{ Querystring: GatewayQuery }>(
      "/ws/android",
      { websocket: true },
      (socket, request) => attachSocket("android", socket, request, relay),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const errorDetails = error as {
      statusCode?: unknown;
      code?: unknown;
    };
    const statusCode =
      typeof errorDetails.statusCode === "number" ? errorDetails.statusCode : 500;
    logger.error("http_error", {
      method: request.method,
      path: pathname(request.raw.url),
      status_code: statusCode,
      error_code: typeof errorDetails.code === "string" ? errorDetails.code : "unknown",
      error_name: error instanceof Error ? error.name : "unknown",
    });
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "internal_error" : "bad_request",
    });
  });

  app.addHook("onClose", async () => {
    relay.stop();
  });

  return { app, relay };
}

function attachSocket(
  gateway: "collector" | "android",
  socket: WebSocket,
  request: FastifyRequest<{ Querystring: GatewayQuery }>,
  relay: Relay,
): void {
  const query = request.query ?? {};
  const connected = relay.connect({
    gateway,
    transport: {
      send(message) {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("websocket_closed");
        socket.send(JSON.stringify(message));
      },
    },
    client_id: queryString(query.client_id),
    installation_id: queryString(query.installation_id),
    pairing_id: queryString(query.pairing_id),
    pairing_code: queryString(query.pairing_code),
  });
  const connectionId = connected.connection_id;

  socket.on("message", (data) => {
    if (typeof data === "string" || Buffer.isBuffer(data)) {
      relay.receive(connectionId, data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      relay.receive(connectionId, new Uint8Array(data));
      return;
    }
    relay.receive(connectionId, String(data));
  });
  socket.on("pong", () => {
    relay.receiveMessage(connectionId, {
      type: "heartbeat",
      schema_version: RELAY_SCHEMA_VERSION,
      heartbeat_id: "ws-pong",
      acknowledged: true,
    });
  });
  socket.on("close", () => relay.disconnect(connectionId));
  socket.on("error", () => relay.disconnect(connectionId));
}

export async function startRelayServer(options: RelayServerOptions = {}): Promise<{
  app: FastifyInstance;
  relay: Relay;
}> {
  const server = createRelayServer(options);
  await server.app.listen({
    host: server.relay.config.host,
    port: server.relay.config.port,
  });
  return server;
}
