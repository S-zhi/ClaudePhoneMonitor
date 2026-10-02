import { startRelayServer } from "./server.js";

const { app, relay } = await startRelayServer();

const shutdown = async (signal: string): Promise<void> => {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", message: "relay_shutdown", signal })}\n`);
  relay.stop();
  await app.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

process.stdout.write(
  `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    message: "relay_started",
    host: relay.config.host,
    port: relay.config.port,
  })}\n`,
);
