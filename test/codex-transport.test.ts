import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { waitForCodexThread } from "../src/transports/codex.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex app-server transport", () => {
  it("uses WebSocket framing over the Unix socket and prepares a named thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "orcode-codex-transport-test-"));
    roots.push(root);
    const socketPath = join(root, "app-server.sock");
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    const methods: string[] = [];

    webSocketServer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id?: number;
          method: string;
        };
        methods.push(message.method);
        if (message.id === undefined) return;
        const result =
          message.method === "thread/loaded/list" ? { data: ["thread-1"] } : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      });
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(socketPath, resolveListen);
    });
    try {
      const threadId = await waitForCodexThread(
        socketPath,
        "implementer",
        () => true,
      );
      assert.equal(threadId, "thread-1");
      assert.deepEqual(methods, [
        "initialize",
        "initialized",
        "thread/loaded/list",
        "thread/name/set",
      ]);
    } finally {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose, rejectClose) => {
        httpServer.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    }
  });
});
