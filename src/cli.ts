#!/usr/bin/env node

import { selfContext } from "./context.ts";
import { hostOption, parseWrapperOptions } from "./cli-options.ts";
import { doctor } from "./doctor.ts";
import { errorPayload, OrcodeError } from "./errors.ts";
import { runMcpServer } from "./mcp.ts";
import { PeerService } from "./service.ts";
import { runClaudeWrapper, runCodexWrapper } from "./wrappers.ts";

const HELP = `orcode - local Codex CLI <-> Claude Code CLI peer messaging

Usage:
  orcode codex [--name <name>] [--resume <thread-id>] -- [codex-options]
  orcode claude [--name <name>] [--resume <session-id>] -- [claude-options]
  orcode peers [--all-projects] [--json]
  orcode doctor

Internal:
  orcode mcp --host codex|claude

Messages are explicit, one-to-one, limited to 64 KiB, and are not persisted by
Orcode. Managed peers are visible only within the same Git project by default.`;

async function main(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "codex":
      return await runCodexWrapper(parseWrapperOptions(rest));
    case "claude":
      return await runClaudeWrapper(parseWrapperOptions(rest));
    case "peers": {
      const allProjects = rest.includes("--all-projects");
      const json = rest.includes("--json");
      const unknown = rest.filter(
        (argument) => argument !== "--all-projects" && argument !== "--json",
      );
      if (unknown.length > 0) {
        throw new OrcodeError("INVALID_ARGUMENT", `Unknown peers option ${unknown[0]}.`);
      }
      const peers = await new PeerService(selfContext()).listPeers(allProjects);
      if (json) {
        process.stdout.write(`${JSON.stringify({ peers }, null, 2)}\n`);
      } else if (peers.length === 0) {
        process.stdout.write("No reachable peers.\n");
      } else {
        for (const peer of peers) {
          process.stdout.write(
            `${peer.address}\t${peer.status}\t${peer.managed ? "managed" : "native"}\t${peer.projectRoot}\n`,
          );
        }
      }
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
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}\n`);
      return 0;
    case "--version":
    case "-V":
      process.stdout.write("0.1.0\n");
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
    process.stderr.write(`${JSON.stringify(errorPayload(error), null, 2)}\n`);
    process.exitCode = 1;
  });
