import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverCodexPeers, discoverNativeCodexPeers } from "../src/discovery.ts";
import { identifyProject } from "../src/project.ts";

function thread(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, cwd: process.cwd(), name: id, source: "cli", status: { type: "idle" }, ...fields };
}

describe("Codex live session discovery", () => {
  it("finds a session opened after prior discovery even without saved history", async () => {
    const live = new Map([["first", thread("first")]]);
    const client = {
      async request(method: string, params: Record<string, unknown>): Promise<unknown> {
        if (method === "thread/loaded/list") return { data: [...live.keys()], nextCursor: null };
        if (method === "thread/list") return { data: [thread("first")] };
        assert.equal(method, "thread/read");
        assert.equal(params.includeTurns, false);
        return { thread: live.get(String(params?.threadId)) };
      },
    };
    assert.deepEqual((await discoverCodexPeers(client)).map(peer => peer.sessionId), ["first"]);

    live.set("second", thread("second", { name: null, source: "vscode" }));
    const peers = await discoverCodexPeers(client);
    assert.deepEqual(peers.map(peer => peer.address), ["codex:first", "codex:second"]);
    assert.equal(peers[1]?.name, "Codex second");
    assert.equal(peers[1]?.projectId, identifyProject(process.cwd()).id);
    assert.equal(peers[1]?.threadId, "second");
  });

  it("discovers all loaded pages, including sessions beyond the first hundred", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `thread-${String(index).padStart(3, "0")}`);
    const cursors: unknown[] = [];
    const peers = await discoverCodexPeers({
      async request(method, params) {
        if (method === "thread/loaded/list") {
          cursors.push(params?.cursor);
          return params?.cursor === "page-2"
            ? { data: [ids[99], ids[100]], nextCursor: null }
            : { data: ids.slice(0, 100), nextCursor: "page-2" };
        }
        assert.equal(method, "thread/read");
        return { thread: thread(String(params?.threadId)) };
      },
    });
    assert.deepEqual(cursors, [undefined, "page-2"]);
    assert.deepEqual(peers.map(peer => peer.sessionId), ids);
  });

  it("keeps healthy sessions when another closes and excludes non-interactive threads", async () => {
    const threads = new Map([
      ["healthy", thread("healthy")],
      ["unloaded", thread("unloaded", { status: { type: "notLoaded" } })],
      ["exec", thread("exec", { source: "exec" })],
      ["child", thread("child", { source: { subAgent: { thread_spawn: {} } } })],
    ]);
    const peers = await discoverCodexPeers({
      async request(method, params) {
        if (method === "thread/loaded/list") return { data: [...threads.keys(), "closed"] };
        if (params?.threadId === "closed") throw new Error("thread no longer exists");
        return { thread: threads.get(String(params?.threadId)) };
      },
    });
    assert.deepEqual(peers.map(peer => peer.sessionId), ["healthy"]);
  });

  it("rejects a repeated pagination cursor instead of hanging", async () => {
    await assert.rejects(discoverCodexPeers({
      async request() { return { data: [], nextCursor: "same-page" }; },
    }), /repeated a loaded-thread pagination cursor/u);
  });

  it("reports daemon unavailability when diagnostics request strict discovery", async () => {
    const previous = process.env.ORCODE_CODEX_BIN;
    process.env.ORCODE_CODEX_BIN = "/orcode-test-missing-codex-binary";
    try {
      assert.deepEqual(await discoverNativeCodexPeers(), []);
      await assert.rejects(discoverNativeCodexPeers({ strict: true }), /daemon is unavailable/u);
    } finally {
      if (previous === undefined) delete process.env.ORCODE_CODEX_BIN;
      else process.env.ORCODE_CODEX_BIN = previous;
    }
  });
});
