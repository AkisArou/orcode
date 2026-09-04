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

export async function sendClaudeMessage(peer: Peer, payload: string): Promise<void> {
  const claude = process.env.ORCODE_CLAUDE_BIN ?? "claude";
  const transport = new StdioClientTransport({
    command: claude,
    args: ["mcp", "serve"],
    env: cleanEnvironment({ CLAUDE_CODE_SAFE_MODE: "1" }),
  });
  const client = new Client({ name: "orcode", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "SendMessage",
      arguments: {
        to: peer.nativeTarget,
        message: payload,
        summary: `Orcode message for ${peer.name}`,
      },
    });
    if (result.isError) {
      throw new OrcodeError(
        "PEER_OFFLINE",
        `Claude Code rejected the message for ${peer.address}: ${toolErrorText(result) ?? "unknown error"}`,
      );
    }
  } catch (error) {
    if (error instanceof OrcodeError) throw error;
    throw new OrcodeError(
      "PROVIDER_UNAVAILABLE",
      `Could not deliver through Claude Code: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}
