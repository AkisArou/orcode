import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Broker } from "../src/broker.ts";
import { resolveSelfContext } from "../src/context.ts";
import { discoverNativeClaudePeers } from "../src/discovery.ts";
import { identifyProject } from "../src/project.ts";
import { MessageStore } from "../src/storage.ts";
import { ClaudeTransport } from "../src/transports/claude.ts";
import type { SelfContext } from "../src/types.ts";

const roots: string[] = [];
const originalBinary = process.env.ORCODE_CLAUDE_BIN;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orcode-claude-test-"));
  roots.push(root);
  const sessionsPath = join(root, "sessions.json");
  const deliveriesPath = join(root, "deliveries.jsonl");
  const bridgesPath = join(root, "bridges.txt");
  const command = join(root, "claude.mjs");
  writeFileSync(deliveriesPath, "");
  writeFileSync(bridgesPath, "");
  writeFileSync(command, `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
const sessions = () => JSON.parse(readFileSync(${JSON.stringify(sessionsPath)}, 'utf8'));
if (process.argv[2] === 'agents') {
  console.log(JSON.stringify(sessions()));
} else {
  appendFileSync(${JSON.stringify(bridgesPath)}, process.pid + '\\n');
  const server = new McpServer({name:'native-claude-fixture',version:'1.0.0'});
  let listed = [];
  server.registerTool('ListAgents', {inputSchema:{}}, async () => {
    listed = sessions().map(session => session.name + ' [' + session.id + ']');
    return {content:[{type:'text',text:listed.join('\\n')}]};
  });
  server.registerTool('SendMessage', {inputSchema:{to:z.string(),message:z.string(),summary:z.string()}}, async args => {
    if (!listed.includes(args.to)) return {isError:true,content:[{type:'text',text:'unknown native recipient reference'}]};
    appendFileSync(${JSON.stringify(deliveriesPath)}, JSON.stringify(args) + '\\n');
    return {content:[{type:'text',text:'delivered'}]};
  });
  await server.connect(new StdioServerTransport());
}
`, { mode: 0o755 });
  process.env.ORCODE_CLAUDE_BIN = command;
  const first = {
    sessionId: "00000000-0000-4000-8000-000000000001", id: "first-ref",
    name: "First Claude", cwd: process.cwd(), pid: process.pid,
  };
  const second = {
    ...first, sessionId: "00000000-0000-4000-8000-000000000002",
    id: "second-ref", name: "Second Claude",
  };
  const setSessions = (sessions: object[]) => writeFileSync(sessionsPath, JSON.stringify(sessions));
  setSessions([first]);
  return { root, first, second, setSessions, deliveriesPath, bridgesPath };
}

afterEach(() => {
  if (originalBinary === undefined) delete process.env.ORCODE_CLAUDE_BIN;
  else process.env.ORCODE_CLAUDE_BIN = originalBinary;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Claude session lifecycle", () => {
  it("delivers to later sessions and renamed recipients through a long-lived connection", async () => {
    const { root, first, second, setSessions, deliveriesPath } = fixture();
    const transport = new ClaudeTransport();
    const broker = new Broker({
      store: new MessageStore(join(root, "broker")),
      discover: discoverNativeClaudePeers,
      discoverClaude: discoverNativeClaudePeers,
      deliverClaude: (peer, payload) => transport.send(peer, payload),
    });
    const project = identifyProject(process.cwd());
    const self: SelfContext = {
      provider: "codex", sessionId: "sender", name: "sender", address: "codex:sender",
      cwd: process.cwd(), projectId: project.id, projectRoot: project.root,
    };
    try {
      assert.equal((await broker.send(self, first.name, "First delivery.")).state, "delivered");
      setSessions([first, second]);
      assert.equal((await broker.send(self, second.name, "Later session.")).state, "delivered");
      const renamed = { ...first, name: "Renamed Claude" };
      setSessions([renamed, second]);
      assert.equal((await broker.send(self, `claude:${first.sessionId}`, "After rename.")).state, "delivered");
      setSessions([renamed]);
      const offline = await broker.send(self, `claude:${second.sessionId}`, "Closed session.");
      assert.equal(offline.state, "queued");
      assert.match(offline.lastError ?? "", /not currently reachable/u);
      const deliveries = readFileSync(deliveriesPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(deliveries.map(delivery => delivery.to), [
        `${first.name} [${first.id}]`, `${second.name} [${second.id}]`, `${renamed.name} [${first.id}]`,
      ]);
    } finally {
      await broker.close();
      await transport.close();
    }
  });

  it("keeps one bridge through a burst and starts a fresh one after a quiet interval", async () => {
    const { deliveriesPath, bridgesPath } = fixture();
    const transport = new ClaudeTransport({ idleMs: 50 });
    try {
      const [peer] = await discoverNativeClaudePeers();
      assert.ok(peer);
      await transport.send(peer, "First of a burst.");
      await transport.send(peer, "Second of a burst.");
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      await transport.send(peer, "After a quiet interval.");
      const bridges = readFileSync(bridgesPath, "utf8").trim().split("\n");
      assert.equal(bridges.length, 2);
      assert.notEqual(bridges[0], bridges[1]);
      assert.equal(readFileSync(deliveriesPath, "utf8").trim().split("\n").length, 3);
    } finally {
      await transport.close();
    }
  });

  it("uses explicit identity even when multiple sessions share a PID or registration is pending", async () => {
    const { first, second, setSessions } = fixture();
    setSessions([first, second]);
    const self = await resolveSelfContext("claude", {}, {
      CLAUDE_CODE_SESSION_ID: second.sessionId,
    }, process.pid);
    assert.equal(self.address, `claude:${second.sessionId}`);
    const pending = await resolveSelfContext("claude", {}, {
      CLAUDE_CODE_SESSION_ID: "pending-session", CLAUDE_PROJECT_DIR: process.cwd(),
    }, process.pid);
    assert.equal(pending.address, "claude:pending-session");
  });

  it("excludes a stale process record without hiding healthy Claude sessions", async () => {
    const { first, second, setSessions } = fixture();
    setSessions([first, { ...second, pid: 2_147_483_647 }]);
    assert.deepEqual((await discoverNativeClaudePeers()).map(peer => peer.sessionId), [first.sessionId]);
  });
});
