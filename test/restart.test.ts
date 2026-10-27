import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BrokerClient, brokerSocketPath, ensureBroker, stopBroker } from "../src/broker.ts";
import { processIsAlive } from "../src/process.ts";
import { restart } from "../src/restart.ts";

const roots: string[] = [];
const originalRuntime = process.env.ORCODE_RUNTIME_DIR;
const originalState = process.env.ORCODE_STATE_DIR;

function tempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `orcode-${name}-`));
  roots.push(root);
  return root;
}

async function brokerPid(root: string): Promise<number> {
  return (await new BrokerClient(brokerSocketPath(root)).request<{ pid: number }>("hello")).pid;
}

afterEach(async () => {
  for (const root of roots) await stopBroker(brokerSocketPath(root)).catch(() => false);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalRuntime === undefined) delete process.env.ORCODE_RUNTIME_DIR;
  else process.env.ORCODE_RUNTIME_DIR = originalRuntime;
  if (originalState === undefined) delete process.env.ORCODE_STATE_DIR;
  else process.env.ORCODE_STATE_DIR = originalState;
});

describe("restart", () => {
  it("stops a broker even while a client holds a connection open", async () => {
    process.env.ORCODE_STATE_DIR = tempRoot("state");
    const root = tempRoot("runtime");
    await ensureBroker(root);
    const pid = await brokerPid(root);
    const held = createConnection(brokerSocketPath(root));
    await new Promise((resolveConnect) => held.once("connect", resolveConnect));
    try {
      assert.equal(await stopBroker(brokerSocketPath(root)), true);
      assert.equal(processIsAlive(pid), false);
    } finally {
      held.destroy();
    }
  });

  it("restarts every broker, and retires the extra ones once no older server remains", async () => {
    process.env.ORCODE_STATE_DIR = tempRoot("state");
    const canonical = tempRoot("canonical");
    const legacy = tempRoot("legacy");
    process.env.ORCODE_RUNTIME_DIR = canonical;
    await ensureBroker(canonical);
    await ensureBroker(legacy);
    const before = [await brokerPid(canonical), await brokerPid(legacy)];
    let reloads = 0;
    const lines = await restart({
      roots: [canonical, legacy],
      reloadCodex: async () => {
        reloads++;
      },
      serversStartedBefore: async () => new Map([["codex", [4242]]]),
    });
    const after = [await brokerPid(canonical), await brokerPid(legacy)];
    assert.equal(reloads, 1);
    assert.ok(before.every((pid) => !processIsAlive(pid)));
    assert.ok(after.every((pid, index) => pid !== before[index]));
    assert.ok(lines.includes(`broker: also running at ${legacy}, for servers started before this restart`));

    const retired = await restart({
      roots: [canonical, legacy],
      reloadCodex: async () => undefined,
      serversStartedBefore: async () => new Map(),
    });
    assert.ok(retired.includes(`broker: retired ${legacy}`));
    assert.equal(await stopBroker(brokerSocketPath(legacy)), false);
  });
});
