import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionRegistry } from "../src/registry.ts";
import type { SessionRecord } from "../src/types.ts";

const roots: string[] = [];

function registry(): SessionRegistry {
  const root = mkdtempSync(join(tmpdir(), "orcode-registry-test-"));
  roots.push(root);
  return new SessionRegistry(root);
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const id = randomUUID();
  return {
    version: 1,
    id,
    provider: "claude",
    name: "reviewer",
    address: "claude:reviewer",
    nativeTarget: "reviewer",
    pid: process.pid,
    cwd: process.cwd(),
    projectId: "project",
    projectRoot: process.cwd(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionRegistry", () => {
  it("atomically registers and unregisters live metadata", () => {
    const sessions = registry();
    const value = record();
    sessions.register(value);
    assert.equal(sessions.assertPrivate(), true);
    assert.deepEqual(sessions.list(), [value]);
    sessions.unregister(value.id);
    assert.deepEqual(sessions.list(), []);
  });

  it("requires a live socket for managed Codex records", () => {
    const sessions = registry();
    const socketPath = join(sessions.root, "sockets", "test.sock");
    closeSync(openSync(socketPath, "w", 0o600));
    const value = record({
      provider: "codex",
      name: "implementer",
      address: "codex:implementer",
      nativeTarget: "thread",
      socketPath,
      threadId: "thread",
    });
    sessions.register(value);
    assert.equal(sessions.list().length, 1);
    rmSync(socketPath);
    assert.deepEqual(sessions.list(), []);
  });
});
