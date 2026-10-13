import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, mock } from "node:test";
import { Broker } from "../src/broker.ts";
import { resolveSelfContext } from "../src/context.ts";
import { discoverNativeMusePeers } from "../src/discovery.ts";
import { identifyProject } from "../src/project.ts";
import { MessageStore } from "../src/storage.ts";
import { MuseTransport } from "../src/transports/muse.ts";
import type { Peer, SelfContext } from "../src/types.ts";

const SESSION_ID = "01a1360f-5ef8-74d2-ac58-96553d792ee6";
const roots: string[] = [];

function fixture(): { root: string; peer: Peer } {
  const root = mkdtempSync(join(tmpdir(), "orcode-muse-test-"));
  roots.push(root);
  mkdirSync(join(root, "runtime", "muse", "sessions"), { recursive: true });
  writeFileSync(join(root, "runtime", "muse", "ms-test.sock"), "");
  writeFileSync(
    join(root, "runtime", "muse", "sessions", `${SESSION_ID}.json`),
    JSON.stringify({
      schema_version: 1,
      session_id: SESSION_ID,
      session_name: null,
      endpoint_hint: "ms-test.sock",
      workspace_label: "project",
      target_eligibility: "message_capable",
      process_generation_hint: "pid=4242",
    }),
  );
  const sessionDir = join(root, "sessions", "2026", "01", "02", SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(root, "sessions", ".msp-maintenance-owner.lock"), "");
  const nested = {
    retained_frame: "session_event",
    children: [
      {
        record_json: JSON.stringify({
          payload_type: "runtime.session.metadata",
          payload: { kind: "metadata", record: { workspace_root: "/project" } },
        }),
      },
    ],
  };
  const named = {
    payload_type: "session.name.changed",
    payload: { new_name: "probe-muse", session_id: SESSION_ID },
  };
  writeFileSync(
    join(sessionDir, "session.jsonl"),
    `${JSON.stringify(nested)}\n${JSON.stringify(named)}\n`,
  );
  const database = new DatabaseSync(join(sessionDir, "cron.db"));
  database.exec(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 1,
      fire_when_active_run INTEGER NOT NULL DEFAULT 1,
      agent_id TEXT,
      kind TEXT NOT NULL DEFAULT 'user',
      permanent INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER,
      next_fire_at_ms INTEGER NOT NULL,
      last_fired_at_ms INTEGER,
      fire_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_claim_ms INTEGER,
      last_fire_run_id TEXT
    );
  `);
  database.close();
  const peer: Peer = {
    provider: "muse",
    sessionId: SESSION_ID,
    name: "probe-muse",
    address: `muse:${SESSION_ID}`,
    cwd: "/project",
    projectId: identifyProject("/project").id,
    projectRoot: "/project",
    status: "reachable",
    nativeTarget: join(sessionDir, "cron.db"),
    hostPid: 4242,
  };
  return { root, peer };
}

afterEach(() => {
  delete process.env.ORCODE_MUSE_DATA_DIR;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Muse provider", () => {
  it("discovers live sessions from the runtime registry", async () => {
    const { root, peer } = fixture();
    process.env.ORCODE_MUSE_DATA_DIR = root;
    const peers = await discoverNativeMusePeers();
    assert.deepEqual(peers, [peer]);
  });

  it("resolves self context from the Muse session environment", async () => {
    const { root } = fixture();
    process.env.ORCODE_MUSE_DATA_DIR = root;
    const self = await resolveSelfContext("muse", {}, {
      MUSE_SESSION_ID: SESSION_ID,
    });
    assert.equal(self.address, `muse:${SESSION_ID}`);
    assert.equal(self.name, "probe-muse");
    assert.equal(self.projectRoot, "/project");
  });

  it("schedules delivery as a one-shot cron job, idempotently", async () => {
    const { peer } = fixture();
    const transport = new MuseTransport();
    await transport.send(peer, "hello muse", "message-1");
    await transport.send(peer, "hello muse", "message-1");
    const database = new DatabaseSync(peer.nativeTarget);
    const rows = database
      .prepare("SELECT id, session_id, prompt, recurring, status FROM cron_jobs")
      .all() as Record<string, unknown>[];
    database.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "orcode-message-1");
    assert.equal(rows[0]?.session_id, SESSION_ID);
    assert.equal(rows[0]?.prompt, "hello muse");
    assert.equal(rows[0]?.recurring, 0);
    assert.equal(rows[0]?.status, "active");
  });

  it("delivers through the broker to a muse peer", async () => {
    const { peer } = fixture();
    const deliverMuse = mock.fn(
      async (_peer: Peer, _payload: string, _messageId: string) => undefined,
    );
    const root = mkdtempSync(join(tmpdir(), "orcode-muse-broker-"));
    roots.push(root);
    const broker = new Broker({
      store: new MessageStore(root),
      discover: async () => [peer],
      discoverMuse: async () => [peer],
      deliverMuse,
    });
    const self: SelfContext = {
      provider: "codex",
      sessionId: "codex-session",
      name: "MainCodex",
      address: "codex:codex-session",
      cwd: "/project",
      projectId: identifyProject("/project").id,
      projectRoot: "/project",
    };
    try {
      const sent = await broker.send(self, peer.address, "Please review.");
      assert.equal(sent.state, "delivered");
      assert.equal(deliverMuse.mock.callCount(), 1);
      assert.match(deliverMuse.mock.calls[0]?.arguments[1] ?? "", /Please review\./u);
      const listed = await broker.listPeers(self);
      assert.deepEqual(
        listed.map((candidate) => candidate.address),
        [peer.address],
      );
    } finally {
      await broker.close();
    }
  });
});
