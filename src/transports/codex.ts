import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { OrcodeError } from "../errors.ts";
import { runProcess } from "../process.ts";
import type { Peer } from "../types.ts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export interface CodexDaemonInfo {
  status: string;
  socketPath: string;
  cliVersion?: string;
  appServerVersion?: string;
}

export async function codexDaemonInfo(): Promise<CodexDaemonInfo | undefined> {
  const command = process.env.ORCODE_CODEX_BIN ?? "codex";
  try {
    const result = await runProcess(command, ["app-server", "daemon", "version"], {
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0) return undefined;
    const value = JSON.parse(result.stdout) as Partial<CodexDaemonInfo>;
    return value.status === "running" && typeof value.socketPath === "string"
      ? (value as CodexDaemonInfo)
      : undefined;
  } catch {
    return undefined;
  }
}

export class CodexAppServerClient {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  private constructor(socketPath: string) {
    this.socket = new WebSocket(`ws+unix://${socketPath}:/`, {
      handshakeTimeout: 5_000,
      perMessageDeflate: false,
    });
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.once("open", resolveReady);
      this.socket.once("error", rejectReady);
    });
    this.socket.on("message", (data) => this.handleData(data));
    this.socket.on("error", (error) => this.failAll(error));
    this.socket.on("close", () => {
      this.closed = true;
      this.failAll(
        new OrcodeError("PROVIDER_UNAVAILABLE", "Codex app-server connection closed."),
      );
    });
  }

  static async connect(socketPath: string): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(socketPath);
    try {
      await client.ready;
      await client.request("initialize", {
        clientInfo: { name: "orcode", title: "Orcode", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      client.close();
      throw new OrcodeError(
        "PROVIDER_UNAVAILABLE",
        `Could not connect to Codex app-server at ${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  isClosed(): boolean {
    return this.closed || this.socket.readyState !== WebSocket.OPEN;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new OrcodeError(
            "PROVIDER_UNAVAILABLE",
            `Codex app-server request ${method} timed out.`,
          ),
        );
      }, 10_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  close(): void {
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    else if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }

  private write(message: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new OrcodeError(
        "PROVIDER_UNAVAILABLE",
        "Codex app-server WebSocket is not open.",
      );
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleData(data: RawData): void {
    try {
      this.handleMessage(JSON.parse(data.toString()) as RpcResponse);
    } catch {
      // A matching request will time out with a useful error.
    }
  }

  private handleMessage(message: RpcResponse): void {
    if (typeof message.id !== "number") return;
    const request = this.pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    if (message.error) {
      request.reject(
        new OrcodeError(
          "PROTOCOL_ERROR",
          message.error.message ?? "Codex app-server returned an error.",
          { rpcCode: message.error.code, data: message.error.data },
        ),
      );
    } else {
      request.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexTransport {
  private client: CodexAppServerClient | undefined;
  private socketPath: string | undefined;

  async clientForDaemon(): Promise<CodexAppServerClient> {
    if (this.client && !this.client.isClosed()) return this.client;
    const info = await codexDaemonInfo();
    if (!info) {
      throw new OrcodeError(
        "PROVIDER_UNAVAILABLE",
        "The shared Codex app-server daemon is not running.",
      );
    }
    if (!this.client || this.client.isClosed() || this.socketPath !== info.socketPath) {
      this.client?.close();
      this.socketPath = info.socketPath;
      this.client = await CodexAppServerClient.connect(info.socketPath);
    }
    return this.client;
  }

  async send(peer: Peer, payload: string, messageId: string): Promise<void> {
    const threadId = peer.threadId ?? peer.sessionId;
    const send = async () => {
      const client = await this.clientForDaemon();
      await client.request("thread/queue/add", {
        threadId,
        input: [{ type: "text", text: payload, textElements: [] }],
        clientUserMessageId: messageId,
      });
    };
    try {
      await send();
    } catch {
      this.client?.close();
      this.client = undefined;
      try {
        await send();
      } catch (secondError) {
        throw secondError;
      }
    }
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
  }
}

const defaultTransport = new CodexTransport();

export async function sendCodexMessage(
  peer: Peer,
  payload: string,
  messageId = randomUUID(),
): Promise<void> {
  await defaultTransport.send(peer, payload, messageId);
}
