import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OrcodeError } from "../errors.ts";
import { cleanEnvironment } from "../process.ts";
import type { Peer } from "../types.ts";

function toolErrorText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

// A `claude mcp serve` kept for days stops resolving recipients correctly and
// still reports success: one five days old told every sender "delivered" for a
// session that had restarted as a background job, while a fresh process
// reached that session at once. So a bridge lives only through a burst of
// sends, and the first send after a quiet interval starts a new one.
const DEFAULT_IDLE_MS = 30_000;

export class ClaudeTransport {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private readonly idleMs: number;
  private sending = 0;
  private idle: NodeJS.Timeout | undefined;

  constructor(options: { idleMs?: number } = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  private async connectedClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return await this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<Client> {
    const command = process.env.ORCODE_CLAUDE_BIN ?? "claude";
    const transport = new StdioClientTransport({
      command,
      args: ["mcp", "serve"],
      env: cleanEnvironment({ CLAUDE_CODE_SAFE_MODE: "1" }),
      stderr: "pipe",
    });
    const client = new Client({ name: "orcode", version: "0.2.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async send(peer: Peer, payload: string): Promise<void> {
    const invoke = async () => {
      const client = await this.connectedClient();
      // Claude resolves session references against its native recipient listing.
      // Refresh it on this connection so later sessions and renames are visible.
      const listing = await client.callTool({ name: "ListAgents", arguments: {} });
      if (listing.isError) {
        throw new OrcodeError(
          "PROVIDER_UNAVAILABLE",
          `Claude Code could not refresh recipients: ${toolErrorText(listing) ?? "unknown error"}`,
        );
      }
      const result = await client.callTool({
        name: "SendMessage",
        arguments: {
          to: peer.nativeTarget,
          message: payload,
          summary: `Orcode message to ${peer.name}`,
        },
      });
      if (result.isError) {
        throw new OrcodeError(
          "PEER_OFFLINE",
          `Claude Code rejected the message for ${peer.address}: ${toolErrorText(result) ?? "unknown error"}`,
        );
      }
    };
    this.sending++;
    clearTimeout(this.idle);
    try {
      await invoke();
    } catch {
      await this.close();
      try {
        await invoke();
      } catch (secondError) {
        throw secondError;
      }
    } finally {
      this.sending--;
      if (this.sending === 0) {
        this.idle = setTimeout(() => void this.close(), this.idleMs);
        this.idle.unref();
      }
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.idle);
    this.idle = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}

const defaultTransport = new ClaudeTransport();

export async function sendClaudeMessage(peer: Peer, payload: string): Promise<void> {
  await defaultTransport.send(peer, payload);
}
