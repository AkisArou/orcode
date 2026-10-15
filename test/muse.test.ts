import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function fixture(options: { root?: string; sessionId?: string; name?: string; pid?: number } = {}): {
  root: string; peer: Peer; logPath: string;
} {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "orcode-muse-test-"));
  if (!options.root) roots.push(root);
  const sessionId = options.sessionId ?? SESSION_ID;
  const name = options.name ?? "probe-muse";
  const pid = options.pid ?? process.pid;
  const endpoint = `ms-${sessionId}.sock`;
  mkdirSync(join(root, "runtime", "muse", "sessions"), { recursive: true });
  writeFileSync(join(root, "runtime", "muse", endpoint), "");
  writeFileSync(
    join(root, "runtime", "muse", "sessions", `${sessionId}.json`),
    JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      session_name: null,
      endpoint_hint: endpoint,
      workspace_label: "project",
      target_eligibility: "message_capable",
      process_generation_hint: `pid=${pid}`,
    }),
  );
  const sessionDir = join(root, "sessions", "2026", "01", "02", sessionId);
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
    payload: { new_name: name, session_id: sessionId },
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
    sessionId,
    name,
    address: `muse:${sessionId}`,
    cwd: "/project",
    projectId: identifyProject("/project").id,
    projectRoot: "/project",
    status: "reachable",
    nativeTarget: join(sessionDir, "cron.db"),
    hostPid: pid,
  };
  return { root, peer, logPath: join(sessionDir, "session.jsonl") };
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

  it("keeps an explicit new identity when another session shares the host process", async () => {
    const { root } = fixture();
    process.env.ORCODE_MUSE_DATA_DIR = root;
    const self = await resolveSelfContext("muse", {}, {
      MUSE_SESSION_ID: "not-yet-registered",
      ORCODE_CWD: "/project",
    }, process.pid);
    assert.equal(self.address, "muse:not-yet-registered");
  });

  it("uses the current registry process after a session resumes under a new process", async () => {
    const { root, logPath } = fixture();
    process.env.ORCODE_MUSE_DATA_DIR = root;
    appendFileSync(logPath, JSON.stringify({
      payload_type: "runtime.session.route_facts",
      payload: { record: { pid: 2_147_483_647, cwd: "/project" } },
    }) + "\n");
    const [peer] = await discoverNativeMusePeers();
    assert.equal(peer?.hostPid, process.pid);
  });

  it("tracks renames beyond the first 512 KiB and across partial UTF-8 writes", async () => {
    const { root, logPath } = fixture();
    process.env.ORCODE_MUSE_DATA_DIR = root;
    assert.equal((await discoverNativeMusePeers())[0]?.name, "probe-muse");
    appendFileSync(logPath, JSON.stringify({ trace: "x".repeat(600 * 1024) }) + "\n");
    const rename = Buffer.from(JSON.stringify({
      payload_type: "session.name.changed",
      payload: { new_name: "Νέο όνομα", session_id: SESSION_ID },
    }) + "\n");
    const splitAt = rename.indexOf(Buffer.from("Ν")) + 1;
    appendFileSync(logPath, rename.subarray(0, splitAt));
    assert.equal((await discoverNativeMusePeers())[0]?.name, "probe-muse");
    appendFileSync(logPath, rename.subarray(splitAt));
    assert.equal((await discoverNativeMusePeers())[0]?.name, "Νέο όνομα");
    appendFileSync(logPath, JSON.stringify({
      payload_type: "session.name.changed",
      payload: { new_name: "Child session name", session_id: "another-session" },
    }) + "\n");
    assert.equal((await discoverNativeMusePeers())[0]?.name, "Νέο όνομα");
  });

  it("does not discover or schedule into a dead host with stale registry files", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    try {
      const { root, peer } = fixture({ pid: child.pid as number });
      process.env.ORCODE_MUSE_DATA_DIR = root;
      assert.equal((await discoverNativeMusePeers()).length, 1);
      const exited = once(child, "exit");
      child.kill();
      await exited;
      assert.deepEqual(await discoverNativeMusePeers(), []);
      await assert.rejects(new MuseTransport().send(peer, "never delivered", "dead-host"), {
        code: "PEER_OFFLINE",
      });
      const database = new DatabaseSync(peer.nativeTarget);
      try {
        assert.equal((database.prepare("SELECT COUNT(*) AS count FROM cron_jobs").get() as { count: number }).count, 0);
      } finally {
        database.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it("discovers and schedules into a Muse session opened after the first delivery", async () => {
    const { root, peer: first } = fixture();
    process.env.ORCODE_MUSE_DATA_DIR = root;
    const brokerRoot = mkdtempSync(join(tmpdir(), "orcode-muse-lifecycle-"));
    roots.push(brokerRoot);
    const transport = new MuseTransport();
    const broker = new Broker({
      store: new MessageStore(brokerRoot),
      discover: discoverNativeMusePeers,
      discoverMuse: discoverNativeMusePeers,
      deliverMuse: (peer, payload, id) => transport.send(peer, payload, id),
    });
    const self: SelfContext = {
      provider: "codex", sessionId: "sender", name: "sender", address: "codex:sender",
      cwd: first.cwd, projectId: first.projectId, projectRoot: first.projectRoot,
    };
    try {
      assert.equal((await broker.send(self, first.address, "First delivery.")).state, "delivered");
      const { peer: second } = fixture({
        root, sessionId: "01a1360f-5ef8-74d2-ac58-96553d792ee7", name: "second-muse",
      });
      const sent = await broker.send(self, second.name, "Second delivery.");
      assert.equal(sent.state, "delivered");
      assert.equal(sent.to, second.address);
      const database = new DatabaseSync(second.nativeTarget);
      try {
        const row = database.prepare("SELECT session_id, prompt FROM cron_jobs").get() as {
          session_id: string; prompt: string;
        };
        assert.equal(row.session_id, second.sessionId);
        assert.match(row.prompt, /Second delivery\./u);
      } finally {
        database.close();
      }
    } finally {
      await broker.close();
    }
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
