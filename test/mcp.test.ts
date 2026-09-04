import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanEnvironment } from "../src/process.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Orcode MCP server", () => {
  it("negotiates stdio and lists peers with structured output", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcode-mcp-test-"));
    roots.push(root);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("src/cli.ts"), "mcp", "--host", "claude"],
      cwd: process.cwd(),
      env: cleanEnvironment({
        ORCODE_RUNTIME_DIR: root,
        ORCODE_PROVIDER: "claude",
        ORCODE_NAME: "reviewer",
        ORCODE_ADDRESS: "claude:reviewer",
      }),
      stderr: "pipe",
    });
    const client = new Client({ name: "orcode-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        "list_peers",
        "send_message",
      ]);
      const result = await client.callTool({ name: "list_peers", arguments: {} });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent, { peers: [] });
    } finally {
      await client.close();
    }
  });
});
