import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";

import { loadConfig, type RelayConfig } from "./config.js";
import { JsonLogger } from "./logger.js";
import { Relay, type RelayOptions } from "./relay.js";
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

interface ClaimBody {
  code?: string;
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
    auth: { mode: "development", placeholder: true },
    storage: "memory",
    uptime_ms: Math.round(process.uptime() * 1000),
  }));

  app.get("/health", async (_request, reply) => {
    return reply.redirect("/healthz");
  });

  app.get("/readyz", async () => ({
    status: "ready",
    service: "relay",
    storage: "memory",
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

  app.post("/v1/pairing", async (_request, reply) => {
    return reply.code(201).send(relay.createPairing());
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
      if (!code || !relay.claimPairing(request.params.pairing_id, code)) {
        return reply.code(400).send({ error: "invalid_pairing" });
      }
      return reply.code(204).send();
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
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
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
