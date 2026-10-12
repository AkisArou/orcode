import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import {
  CodexAppServerClient,
  CodexTransport,
} from "../src/transports/codex.ts";
import type { Peer } from "../src/types.ts";

const roots: string[] = [];

const peer: Peer = {
  provider: "codex",
  sessionId: "thread-1",
  threadId: "thread-1",
  name: "MainCodex",
  address: "codex:thread-1",
  cwd: "/project",
  projectId: "project",
  projectRoot: "/project",
  status: "reachable",
  nativeTarget: "thread-1",
};

type RpcRequest = { id?: number; method?: string; params?: Record<string, unknown> };
type RpcReply = { result?: unknown; error?: { code: number; message: string } };

async function withAppServer(
  respond: (request: RpcRequest) => RpcReply,
  run: (
    client: CodexAppServerClient,
    socketPath: string,
    messages: RpcRequest[],
  ) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "orcode-codex-transport-test-"));
  roots.push(root);
  const socketPath = join(root, "app-server.sock");
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ server: httpServer });
  const messages: RpcRequest[] = [];
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as RpcRequest;
      messages.push(message);
      if (message.id === undefined) return;
      socket.send(JSON.stringify({ id: message.id, ...respond(message) }));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(socketPath, resolveListen);
  });
  const client = await CodexAppServerClient.connect(socketPath);
  try {
    await run(client, socketPath, messages);
  } finally {
    client.close();
    for (const connection of webSocketServer.clients) connection.terminate();
    await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  }
}

function transportWithClient(
  client: CodexAppServerClient,
  socketPath: string,
): CodexTransport {
  const transport = new CodexTransport();
  Object.assign(transport, { client, socketPath });
  return transport;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex app-server transport", () => {
  it("uses WebSocket framing and sends a stable queue request", async () => {
    await withAppServer(
      () => ({ result: {} }),
      async (client, _socketPath, messages) => {
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
        assert.equal(messages[2]?.params?.clientUserMessageId, "message-1");
      },
    );
  });

  it("steers a correlated reply into the active turn", async () => {
    await withAppServer(
      (request) => {
        if (request.method === "thread/turns/list") {
          return {
            result: {
              data: [{ id: "turn-1", status: "inProgress", items: [] }],
            },
          };
        }
        if (request.method === "turn/steer") return { result: { turnId: "turn-1" } };
        return { result: {} };
      },
      async (client, socketPath, messages) => {
        const transport = transportWithClient(client, socketPath);
        await transport.send(peer, "reply", "message-2", { preferSteer: true });

        assert.deepEqual(messages.map((message) => message.method), [
          "initialize",
          "initialized",
          "thread/turns/list",
          "turn/steer",
        ]);
        assert.deepEqual(messages[3]?.params, {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "reply", textElements: [] }],
          clientUserMessageId: "message-2",
        });
      },
    );
  });

  it("falls back to the durable queue when the active turn rejects steering", async () => {
    await withAppServer(
      (request) => {
        if (request.method === "thread/turns/list") {
          return {
            result: {
              data: [{ id: "turn-1", status: "inProgress", items: [] }],
            },
          };
        }
        if (request.method === "turn/steer") {
          return { error: { code: -32600, message: "active turn changed" } };
        }
        return { result: {} };
      },
      async (client, socketPath, messages) => {
        const transport = transportWithClient(client, socketPath);
        await transport.send(peer, "reply", "message-3", { preferSteer: true });

        assert.deepEqual(messages.map((message) => message.method), [
          "initialize",
          "initialized",
          "thread/turns/list",
          "turn/steer",
          "thread/queue/add",
        ]);
        assert.equal(messages[4]?.params?.clientUserMessageId, "message-3");
      },
    );
  });
});
