import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEnvelope, serializeEnvelope } from "../src/envelope.ts";
import type { Peer, SelfContext } from "../src/types.ts";

const self: SelfContext = {
  provider: "codex",
  sessionId: "codex-session",
  name: "MainCodex",
  address: "codex:codex-session",
  cwd: "/project",
  projectId: "project",
  projectRoot: "/project",
};

const peer: Peer = {
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

describe("peer envelope", () => {
  it("renders readable text with a stable reply address instead of JSON", () => {
    const envelope = createEnvelope(self, peer, "Please review the patch.", undefined, "message-1");
    const text = serializeEnvelope(envelope);
    assert.match(text, /^Orcode from MainCodex — Please review the patch\./u);
    assert.match(text, /## Message/u);
    assert.match(text, /Please review the patch\./u);
    assert.match(text, /codex:codex-session/u);
    assert.ok(text.includes(`Sent \`${envelope.sentAt}\``));
    assert.doesNotMatch(text, /"protocol":/u);
  });
});
