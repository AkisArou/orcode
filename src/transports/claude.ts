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

type Recipient = { name: string; ref: string };

// ListAgents answers with JSON: sections of rows, each a recipient's name and
// the ref SendMessage takes beside it.
function recipients(listing: unknown): Recipient[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolErrorText(listing) ?? "");
  } catch {
    throw new OrcodeError("PROTOCOL_ERROR", "Claude Code returned an unreadable recipient listing.");
  }
  const sections = (parsed as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections)) {
    throw new OrcodeError("PROTOCOL_ERROR", "Claude Code's recipient listing has no sections.");
  }
  const rows: Recipient[] = [];
  for (const section of sections) {
    const sectionRows = (section as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(sectionRows)) continue;
    for (const row of sectionRows) {
      const { name, ref } = (row ?? {}) as { name?: unknown; ref?: unknown };
      if (typeof name === "string" && typeof ref === "string") rows.push({ name, ref });
    }
  }
  return rows;
}

// `claude agents` and ListAgents name a session alike but need not give it the
// same ref: a session running in the background was `MainClaude [8d094110]`
// to the one and `MainClaude [a06aa1]` to the other, and SendMessage takes only
// the second. So the address is the listing's own row for the session's name.
function recipientAddress(peer: Peer, rows: Recipient[]): string {
  const named = rows.filter((row) => row.name === peer.name);
  const addresses = named.map((row) => `${row.name} [${row.ref}]`);
  if (addresses.includes(peer.nativeTarget)) return peer.nativeTarget;
  const [only, ...others] = addresses;
  if (only !== undefined && others.length === 0) return only;
  if (only === undefined) {
    throw new OrcodeError("PEER_OFFLINE", `${peer.address} is not in Claude Code's recipient listing.`);
  }
  throw new OrcodeError(
    "PEER_AMBIGUOUS",
    `${addresses.length} Claude sessions are named ${peer.name}; rename one so messages reach the right one.`,
  );
}

// SendMessage reports an unreachable recipient as an ordinary result carrying
// `"success": false`, not as a tool error. Only an explicit success counts.
function reportsSuccess(reply: string): boolean {
  try {
    return (JSON.parse(reply) as { success?: unknown } | null)?.success === true;
  } catch {
    return false;
  }
}

export class ClaudeTransport {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

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
      // Claude resolves recipients against its native listing. Read it on this
      // connection so later sessions and renames are visible.
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
          to: recipientAddress(peer, recipients(listing)),
          message: payload,
          summary: `Orcode message to ${peer.name}`,
        },
      });
      const reply = toolErrorText(result) ?? "";
      if (result.isError || !reportsSuccess(reply)) {
        throw new OrcodeError(
          "PEER_OFFLINE",
          `Claude Code did not deliver the message for ${peer.address}: ${reply || "unknown error"}`,
        );
      }
    };
    try {
      await invoke();
    } catch {
      await this.close();
      try {
        await invoke();
      } catch (secondError) {
        throw secondError;
      }
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}

const defaultTransport = new ClaudeTransport();

export async function sendClaudeMessage(peer: Peer, payload: string): Promise<void> {
  await defaultTransport.send(peer, payload);
}
