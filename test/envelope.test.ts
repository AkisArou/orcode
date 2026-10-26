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
  it("renders a local sender/date heading, the body once, and complete reply metadata", (context) => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Europe/Athens";
    context.after(() => {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    });
    const body = "Please review the patch.\nKeep this line unchanged.";
    const replyId = "ffc88e6b-1234-4000-8000-123456789abc";
    for (const replyTo of [undefined, replyId]) {
      const envelope = {
        ...createEnvelope(self, peer, body, replyTo, "message-1"),
        sentAt: "2026-10-26T06:52:41.006Z",
      };
      const text = serializeEnvelope(envelope);
      assert.match(text, /^## MainCodex \(26 Oct 2026, 08:52 EET\)\n\n/u);
      assert.ok(text.includes(`\n\n${body}\n\n`));
      assert.equal(text.split("Please review the patch.").length, 2);
      const footer = text.split("\n").at(-1) ?? "";
      assert.ok(footer.includes("Orcode · id=`message-1` · from=`codex:codex-session`"));
      if (replyTo) assert.ok(footer.includes(`replyTo=\`${replyId}\``));
      else assert.doesNotMatch(footer, /replyTo=/u);
      assert.doesNotMatch(text, /Orcode from|## Message|"protocol":/u);
    }
  });
});
