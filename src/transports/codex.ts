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

export class CodexAppServerClient {
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;

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
      this.failAll(
        new OrcodeError(
          "PROVIDER_UNAVAILABLE",
          "Codex app-server WebSocket connection closed.",
        ),
      );
    });
  }

  static async connect(socketPath: string): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(socketPath);
    try {
      await client.ready;
    } catch (error) {
      throw new OrcodeError(
        "PROVIDER_UNAVAILABLE",
        `Could not connect to Codex app-server at ${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await client.request("initialize", {
      clientInfo: { name: "orcode", title: "Orcode", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    client.notify("initialized", {});
    return client;
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
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  close(): void {
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
      // Ignore non-protocol frames. A matching request will still time out clearly.
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
      return;
    }
    request.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function extractLoadedThreadIds(result: unknown): string[] {
  if (!result || typeof result !== "object") {
    throw new OrcodeError("PROTOCOL_ERROR", "Codex did not return loaded threads.");
  }
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data) || !data.every((id) => typeof id === "string")) {
    throw new OrcodeError(
      "PROTOCOL_ERROR",
      "Codex returned invalid loaded-thread metadata.",
    );
  }
  return data;
}

export async function waitForCodexThread(
  socketPath: string,
  name: string,
  isTerminalAlive: () => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const client = await CodexAppServerClient.connect(socketPath);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isTerminalAlive()) {
        throw new OrcodeError(
          "PROVIDER_UNAVAILABLE",
          "Codex CLI exited before loading its thread.",
        );
      }
      const result = await client.request("thread/loaded/list", {});
      const threadIds = extractLoadedThreadIds(result);
      if (threadIds.length === 1) {
        const threadId = threadIds[0] as string;
        await client.request("thread/name/set", { threadId, name });
        return threadId;
      }
      if (threadIds.length > 1) {
        throw new OrcodeError(
          "PROTOCOL_ERROR",
          "The dedicated Codex app-server loaded more than one bootstrap thread.",
          { threadIds },
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new OrcodeError(
      "PROVIDER_UNAVAILABLE",
      "Timed out waiting for the Codex TUI to load its thread.",
    );
  } finally {
    client.close();
  }
}

export async function sendCodexMessage(peer: Peer, payload: string): Promise<void> {
  if (!peer.socketPath || !peer.threadId) {
    throw new OrcodeError(
      "PEER_OFFLINE",
      `${peer.address} is not a managed Codex peer and has no queue endpoint.`,
    );
  }
  const codex = process.env.ORCODE_CODEX_BIN ?? "codex";
  const result = await runProcess(
    codex,
    [
      "queue",
      "--remote",
      `unix://${peer.socketPath}`,
      "--thread",
      peer.threadId,
      "--message",
      payload,
    ],
    { timeoutMs: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new OrcodeError(
      "PEER_OFFLINE",
      `Codex rejected the message for ${peer.address}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
  }
}
