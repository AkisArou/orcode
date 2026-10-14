import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { Broker } from "../src/broker.ts";
import { createEnvelope } from "../src/envelope.ts";
import { MessageStore } from "../src/storage.ts";
import type { Peer, SelfContext } from "../src/types.ts";

const roots: string[] = [];
const self: SelfContext = {
  provider: "codex",
  sessionId: "codex-session",
  name: "MainCodex",
  address: "codex:codex-session",
  cwd: "/project",
  projectId: "project",
  projectRoot: "/project",
};
const claude: Peer = {
  provider: "claude",
  sessionId: "claude-session",
  name: "Reviewer",
  address: "claude:claude-session",
  cwd: "/project",
  projectId: "project",
  projectRoot: "/project",
  status: "reachable",
  nativeTarget: "Reviewer [claude-s]",
};
const codex: Peer = {
  provider: "codex",
  sessionId: "codex-session",
  threadId: "codex-session",
  name: "MainCodex",
  address: "codex:codex-session",
  cwd: "/project",
  projectId: "project",
  projectRoot: "/project",
  status: "reachable",
  nativeTarget: "codex-session",
};

function store(): MessageStore {
  const root = mkdtempSync(join(tmpdir(), "orcode-store-test-"));
  roots.push(root);
  return new MessageStore(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable broker", () => {
  it("persists, delivers, and acknowledges messages", async () => {
    const deliverClaude = mock.fn(async (_peer: Peer, _payload: string) => undefined);
    const broker = new Broker({
      store: store(),
      discover: async () => [claude],
      discoverClaude: async () => [claude],
      deliverClaude,
    });
    try {
      const sent = await broker.send(self, claude.address, "Please review.");
      assert.equal(sent.state, "delivered");
      assert.equal(deliverClaude.mock.callCount(), 1);
      const payload = deliverClaude.mock.calls[0]?.arguments[1] ?? "";
      assert.match(payload, /Please review\./u);

      const claudeSelf: SelfContext = {
        provider: "claude",
        sessionId: claude.sessionId,
        name: claude.name,
        address: claude.address,
        cwd: claude.cwd,
        projectId: claude.projectId,
        projectRoot: claude.projectRoot,
      };
      assert.equal(broker.acknowledge(claudeSelf, sent.messageId).state, "acknowledged");
    } finally {
      await broker.close();
    }
  });

  it("keeps transient delivery failures queued with their error", async () => {
    const broker = new Broker({
      store: store(),
      discover: async () => [claude],
      discoverClaude: async () => [claude],
      deliverClaude: async () => {
        throw new Error("temporary disconnect");
      },
    });
    try {
      const sent = await broker.send(self, claude.address, "Try later.");
      assert.equal(sent.state, "queued");
      assert.equal(sent.attempts, 1);
      assert.match(sent.lastError ?? "", /temporary disconnect/u);
    } finally {
      await broker.close();
    }
  });

  it("holds later messages for one recipient without blocking another recipient", async () => {
    const other: Peer = {
      ...claude,
      sessionId: "other-session",
      name: "Other reviewer",
      address: "claude:other-session",
      nativeTarget: "Other reviewer [other-se]",
    };
    const attempts: string[] = [];
    const broker = new Broker({
      store: store(),
      discover: async () => [claude, other],
      discoverClaude: async () => [claude, other],
      deliverClaude: async (peer) => {
        attempts.push(peer.address);
        if (peer.address === claude.address) throw new Error("recipient is busy");
      },
    });
    try {
      const first = await broker.send(self, claude.address, "First blocked message.");
      const second = await broker.send(self, claude.address, "Second blocked message.");
      const unrelated = await broker.send(self, other.address, "Independent message.");
      assert.equal(first.state, "queued");
      assert.equal(second.state, "queued");
      assert.equal(second.attempts, 0);
      assert.equal(unrelated.state, "delivered");
      assert.deepEqual(attempts, [claude.address, other.address]);
    } finally {
      await broker.close();
    }
  });

  it("serializes overlapping sends in FIFO attempt order", async () => {
    const delivered: string[] = [];
    let releaseFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    const broker = new Broker({
      store: store(),
      discover: async () => [claude],
      discoverClaude: async () => [claude],
      deliverClaude: async (_peer, payload) => {
        delivered.push(payload);
        if (delivered.length === 1) {
          markFirstStarted();
          await firstGate;
        }
      },
    });
    try {
      const first = broker.send(self, claude.address, "First message.");
      await firstStarted;
      const second = broker.send(self, claude.address, "Second message.");
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      assert.equal(delivered.length, 1);
      releaseFirst();
      await Promise.all([first, second]);
      assert.match(delivered[0] ?? "", /First message\./u);
      assert.match(delivered[1] ?? "", /Second message\./u);
    } finally {
      releaseFirst();
      await broker.close();
    }
  });

  it("requeues a delivery interrupted by a broker restart", () => {
    const root = mkdtempSync(join(tmpdir(), "orcode-store-test-"));
    roots.push(root);
    const first = new MessageStore(root);
    const envelope = createEnvelope(self, claude, "Survive restart.", undefined, "restart-message");
    first.insertMessage(envelope);
    assert.equal(first.markDelivering(envelope.id), true);
    first.close();

    const recovered = new MessageStore(root);
    try {
      const status = recovered.status(envelope.id);
      assert.equal(status?.state, "queued");
      assert.match(status?.lastError ?? "", /Broker restarted/u);
    } finally {
      recovered.close();
    }
  });

  it("makes both replies and new messages eligible for Codex steering", async () => {
    const deliverCodex = mock.fn(
      async (
        _peer: Peer,
        _payload: string,
        _messageId: string,
        _preferSteer: boolean,
      ) => undefined,
    );
    const broker = new Broker({
      store: store(),
      discover: async () => [codex, claude],
      discoverClaude: async () => [claude],
      deliverCodex,
      deliverClaude: async () => undefined,
    });
    const claudeSelf: SelfContext = {
      provider: "claude",
      sessionId: claude.sessionId,
      name: claude.name,
      address: claude.address,
      cwd: claude.cwd,
      projectId: claude.projectId,
      projectRoot: claude.projectRoot,
    };
    try {
      const request = await broker.send(self, claude.address, "Please review this.");
      await broker.send(claudeSelf, codex.address, "Here is the review.", request.messageId);
      await broker.send(claudeSelf, codex.address, "An unrelated note.");

      assert.equal(deliverCodex.mock.callCount(), 2);
      assert.equal(deliverCodex.mock.calls[0]?.arguments[3], true);
      assert.equal(deliverCodex.mock.calls[1]?.arguments[3], true);
    } finally {
      await broker.close();
    }
  });
});
