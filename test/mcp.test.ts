import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanEnvironment } from "../src/process.ts";

describe("Orcode MCP server", () => {
  it("negotiates stdio and exposes the delivery tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("src/cli.ts"), "mcp", "--host", "claude"],
      cwd: process.cwd(),
      env: cleanEnvironment({
        CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-000000000001",
      }),
      stderr: "pipe",
    });
    const client = new Client({ name: "orcode-test", version: "0.2.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        "ack_message",
        "list_peers",
        "message_status",
        "send_message",
      ]);
    } finally {
      await client.close();
    }
  });
});
