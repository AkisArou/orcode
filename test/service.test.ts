import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { MAX_MESSAGE_BYTES } from "../src/envelope.ts";
import { OrcodeError } from "../src/errors.ts";
import { SessionRegistry } from "../src/registry.ts";
import { PeerService } from "../src/service.ts";
import type { Peer, SelfContext } from "../src/types.ts";

const roots: string[] = [];
const self: SelfContext = {
  provider: "codex",
  name: "implementer",
  address: "codex:implementer",
  cwd: "/project",
  projectId: "project",
  projectRoot: "/project",
};
const peer: Peer = {
  provider: "claude",
  name: "reviewer",
  address: "claude:reviewer",
  projectRoot: "/project",
  status: "reachable",
  managed: true,
  nativeTarget: "reviewer",
};

function temporaryRegistry(): SessionRegistry {
  const root = mkdtempSync(join(tmpdir(), "orcode-service-test-"));
  roots.push(root);
  return new SessionRegistry(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PeerService", () => {
  it("routes one envelope to the opposite provider", async () => {
    const deliverClaude = mock.fn(async (_peer: Peer, _payload: string) => undefined);
    const service = new PeerService(self, {
      registry: temporaryRegistry(),
      discover: async () => [peer],
      deliverClaude,
    });
    const result = await service.send("reviewer", "Please review this patch.");
    assert.equal(result.status, "accepted");
    assert.equal(result.peer.address, "claude:reviewer");
    assert.equal(deliverClaude.mock.callCount(), 1);
    const payload = deliverClaude.mock.calls[0]?.arguments[1] ?? "";
    assert.match(payload, /untrusted peer-provided context/u);
    assert.match(payload, /Please review this patch\./u);
    assert.match(payload, new RegExp(result.messageId, "u"));
  });

  it("rejects oversized UTF-8 bodies before delivery", async () => {
    const deliverClaude = mock.fn(async (_peer: Peer, _payload: string) => undefined);
    const service = new PeerService(self, {
      registry: temporaryRegistry(),
      discover: async () => [peer],
      deliverClaude,
    });
    await assert.rejects(
      service.send(peer.address, "x".repeat(MAX_MESSAGE_BYTES + 1)),
      (error: unknown) =>
        error instanceof OrcodeError && error.code === "MESSAGE_TOO_LARGE",
    );
    assert.equal(deliverClaude.mock.callCount(), 0);
  });

  it("rejects self-targeting and missing peers", async () => {
    const service = new PeerService(self, {
      registry: temporaryRegistry(),
      discover: async () => [],
    });
    await assert.rejects(
      service.send(self.address, "hello"),
      (error: unknown) => error instanceof OrcodeError && error.code === "SELF_TARGET",
    );
    await assert.rejects(
      service.send("missing", "hello"),
      (error: unknown) => error instanceof OrcodeError && error.code === "PEER_NOT_FOUND",
    );
  });
});
