import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { CodexAppServerClient } from "../src/transports/codex.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex app-server client", () => {
  it("uses WebSocket framing and sends a stable queue request", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcode-codex-transport-test-"));
    roots.push(root);
    const socketPath = join(root, "app-server.sock");
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    const messages: Record<string, unknown>[] = [];
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number } & Record<string, unknown>;
        messages.push(message);
        if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: {} }));
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(socketPath, resolveListen);
    });
    const client = await CodexAppServerClient.connect(socketPath);
    try {
      await client.request("thread/queue/add", {
        threadId: "thread-1",
        input: [{ type: "text", text: "hello", textElements: [] }],
        clientUserMessageId: "message-1",
      });
      assert.deepEqual(messages.map((message) => message.method), [
        "initialize",
        "initialized",
        "thread/queue/add",
      ]);
      assert.equal(
        (messages[2]?.params as { clientUserMessageId?: string }).clientUserMessageId,
        "message-1",
      );
    } finally {
      client.close();
      for (const connection of webSocketServer.clients) connection.terminate();
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    }
  });
});
