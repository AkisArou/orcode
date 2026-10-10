#!/usr/bin/env node

import { ensureBroker, runBrokerDaemon, stopBroker } from "./broker.ts";
import { discoverAllNativePeers } from "./discovery.ts";
import { doctor } from "./doctor.ts";
import { errorPayload, OrcodeError } from "./errors.ts";
import { runMcpServer } from "./mcp.ts";
import { setup, uninstall } from "./setup.ts";
import type { Provider } from "./types.ts";

const VERSION = "0.2.0";
const HELP = `orcode - durable Codex CLI <-> Claude Code CLI messaging

Setup:
  orcode setup [--force]     Configure both CLIs once
  orcode uninstall           Remove Orcode MCP configuration
  orcode doctor              Verify versions, configuration, and broker

Diagnostics:
  orcode peers [--json]
  orcode status
  orcode cancel <message-id>

After setup, launch Codex and Claude normally. No Orcode name is required:
  codex
  claude

Internal:
  orcode mcp --host codex|claude
  orcode daemon run|stop`;

function hostOption(args: string[]): Provider {
  const index = args.indexOf("--host");
  const host = index < 0 ? undefined : args[index + 1];
  if (host !== "codex" && host !== "claude") {
    throw new OrcodeError("INVALID_ARGUMENT", "--host must be codex or claude.");
  }
  return host;
}

async function main(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "setup": {
      const force = rest.includes("--force");
      if (rest.some((argument) => argument !== "--force")) {
        throw new OrcodeError("INVALID_ARGUMENT", "setup only accepts --force.");
      }
      for (const result of await setup(force)) {
        process.stdout.write(`${result.host}: ${result.action} (${result.detail})\n`);
      }
      await stopBroker();
      await ensureBroker();
      process.stdout.write("Done. Restart open Codex and Claude sessions, then launch them normally.\n");
      return 0;
    }
    case "uninstall": {
      if (rest.length > 0) throw new OrcodeError("INVALID_ARGUMENT", "uninstall takes no options.");
      for (const result of await uninstall()) {
        process.stdout.write(`${result.host}: ${result.action} (${result.detail})\n`);
      }
      return 0;
    }
    case "codex":
    case "claude":
      throw new OrcodeError(
        "INVALID_ARGUMENT",
        `The orcode ${command} wrapper was removed. Run 'orcode setup' once, then launch '${command}' directly.`,
      );
    case "peers": {
      const json = rest.includes("--json");
      if (rest.some((argument) => argument !== "--json")) {
        throw new OrcodeError("INVALID_ARGUMENT", "peers only accepts --json.");
      }
      const peers = await discoverAllNativePeers();
      if (json) process.stdout.write(`${JSON.stringify({ peers }, null, 2)}\n`);
      else if (peers.length === 0) process.stdout.write("No reachable peers.\n");
      else {
        for (const peer of peers) {
          process.stdout.write(`${peer.name}\t${peer.address}\t${peer.projectRoot}\n`);
        }
      }
      return 0;
    }
    case "status": {
      if (rest.length > 0) throw new OrcodeError("INVALID_ARGUMENT", "status takes no options.");
      const client = await ensureBroker();
      const hello = await client.request<{ protocolVersion: number }>("hello");
      process.stdout.write(`broker: running (protocol ${hello.protocolVersion})\n`);
      return 0;
    }
    case "cancel": {
      if (rest.length !== 1) {
        throw new OrcodeError("INVALID_ARGUMENT", "Usage: orcode cancel <message-id>.");
      }
      const client = await ensureBroker();
      const status = await client.request<{ state: string }>("cancel", { messageId: rest[0] });
      process.stdout.write(`message ${rest[0]}: ${status.state}\n`);
      return 0;
    }
    case "doctor": {
      if (rest.length > 0) throw new OrcodeError("INVALID_ARGUMENT", "doctor takes no options.");
      const checks = await doctor();
      for (const check of checks) {
        process.stdout.write(`${check.ok ? "ok" : "FAIL"}\t${check.name}\t${check.detail}\n`);
      }
      return checks.every((check) => check.ok) ? 0 : 1;
    }
    case "mcp":
      await runMcpServer(hostOption(rest));
      return 0;
    case "daemon":
      if (rest.length === 1 && rest[0] === "run") return await runBrokerDaemon();
      if (rest.length === 1 && rest[0] === "stop") {
        process.stdout.write((await stopBroker()) ? "broker: stopped\n" : "broker: not running\n");
        return 0;
      }
      throw new OrcodeError("INVALID_ARGUMENT", "Usage: orcode daemon run|stop.");
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}\n`);
      return 0;
    case "--version":
    case "-V":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    default:
      throw new OrcodeError("INVALID_ARGUMENT", `Unknown command ${command}.`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const payload = errorPayload(error).error as { code?: string; message?: string };
    process.stderr.write(`${payload.code ?? "ERROR"}: ${payload.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
