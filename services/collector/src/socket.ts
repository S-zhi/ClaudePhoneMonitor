import net from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface UnixSocketIngestorOptions {
  socketPath: string;
  onMessage: (message: unknown, socket: net.Socket) => Promise<void> | void;
  maxLineBytes?: number;
}

export interface UnixSocketSendOptions {
  timeoutMs?: number;
}

function safeSocketPath(socketPath: string): void {
  if (!socketPath || socketPath.length > 100) throw new Error("invalid_unix_socket_path");
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await lstat(socketPath);
    if (stat.isSocket()) await unlink(socketPath);
    else throw new Error("socket_path_is_not_socket");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

/** Local NDJSON server. It never opens a TCP or WebSocket connection. */
export class UnixSocketIngestor {
  private readonly maxLineBytes: number;
  private server: net.Server | undefined;
  private started = false;
  private readonly connections = new Set<net.Socket>();
  private readonly messages = new Set<Promise<void>>();

  public constructor(private readonly options: UnixSocketIngestorOptions) {
    safeSocketPath(options.socketPath);
    this.maxLineBytes = Math.max(256, options.maxLineBytes ?? 64 * 1024);
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.options.socketPath);

    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.socketPath);
    });
    await chmod(this.options.socketPath, 0o600);
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    socket.once("close", () => this.connections.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let closed = false;
    let processing = Promise.resolve();

    const rejectLine = () => {
      // Drop malformed/oversized input and close the local connection. The hook
      // adapter treats this exactly like any other fail-open delivery failure.
      closed = true;
      socket.destroy();
    };

    socket.on("data", (chunk: string) => {
      if (closed || socket.destroyed) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > this.maxLineBytes * 2) {
        rejectLine();
        return;
      }

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
          rejectLine();
          return;
        }
        if (line) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            newline = buffer.indexOf("\n");
            continue;
          }
          // Preserve order within a held hook connection, including the
          // applied acknowledgement that follows an approval request.
          processing = processing.then(() => this.options.onMessage(parsed, socket)).catch(() => undefined);
          const handled = processing;
          this.messages.add(handled);
          void handled.finally(() => this.messages.delete(handled));
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
  }

  public async stop(): Promise<void> {
    this.started = false;
    const server = this.server;
    this.server = undefined;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    while (this.messages.size > 0) await Promise.all([...this.messages]);
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }).catch(() => undefined);
    }
    await unlink(this.options.socketPath).catch(() => undefined);
  }
}

/** Send one line to the collector's local Unix socket. */
export async function sendUnixSocketPayload(
  socketPath: string,
  payload: unknown,
  options: UnixSocketSendOptions = {},
): Promise<void> {
  safeSocketPath(socketPath);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 250);
  const serialized = `${JSON.stringify(payload)}\n`;

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => settle(new Error("unix_socket_timeout")), timeoutMs);
    socket.once("connect", () => {
      socket.write(serialized, "utf8", () => settle());
    });
    socket.once("error", (error) => settle(error));
    socket.once("close", () => {
      if (!settled) settle(new Error("unix_socket_closed"));
    });
  });
}

export const sendToUnixSocket = sendUnixSocketPayload;
