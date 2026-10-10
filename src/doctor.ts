import { accessSync, chmodSync, constants, mkdirSync, statSync } from "node:fs";
import { ensureBroker } from "./broker.ts";
import { commandVersion, runProcess } from "./process.ts";
import { ensureRuntimeRoot } from "./runtime.ts";
import { configuredHosts } from "./setup.ts";
import { stateRoot } from "./storage.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function numericVersion(text: string | undefined): number[] | undefined {
  const match = text?.match(/(\d+)\.(\d+)\.(\d+)/u);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function atLeast(found: number[] | undefined, required: number[]): boolean {
  if (!found) return false;
  for (let index = 0; index < required.length; index += 1) {
    const actual = found[index] ?? 0;
    const minimum = required[index] ?? 0;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

function privateWritableDirectory(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export async function doctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeVersion = process.versions.node;
  checks.push({
    name: "Node.js",
    ok: atLeast(numericVersion(nodeVersion), [24, 0, 0]),
    detail: `v${nodeVersion} (requires >=24)`,
  });

  const codexVersion = commandVersion(process.env.ORCODE_CODEX_BIN ?? "codex");
  checks.push({
    name: "Codex CLI",
    ok: atLeast(numericVersion(codexVersion), [0, 162, 1]),
    detail: `${codexVersion ?? "not found"} (requires >=0.162.1)`,
  });

  const claudeVersion = commandVersion(process.env.ORCODE_CLAUDE_BIN ?? "claude");
  checks.push({
    name: "Claude Code",
    ok: atLeast(numericVersion(claudeVersion), [2, 1, 163]),
    detail: `${claudeVersion ?? "not found"} (requires >=2.1.163)`,
  });

  const runtime = ensureRuntimeRoot();
  checks.push({
    name: "Runtime directory",
    ok: privateWritableDirectory(runtime),
    detail: runtime,
  });
  const state = stateRoot();
  checks.push({
    name: "State directory",
    ok: privateWritableDirectory(state),
    detail: state,
  });

  try {
    const configured = await configuredHosts();
    checks.push({
      name: "Codex MCP",
      ok: configured.codex,
      detail: configured.codex ? "orcode is configured" : "run orcode setup",
    });
    checks.push({
      name: "Claude MCP",
      ok: configured.claude,
      detail: configured.claude ? "orcode is configured at user scope" : "run orcode setup",
    });
  } catch (error) {
    checks.push({
      name: "MCP configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (claudeVersion) {
    try {
      const result = await runProcess(
        process.env.ORCODE_CLAUDE_BIN ?? "claude",
        ["agents", "--json"],
        { timeoutMs: 5_000 },
      );
      checks.push({
        name: "Claude session discovery",
        ok: result.exitCode === 0,
        detail: result.exitCode === 0 ? "claude agents --json is available" : result.stderr.trim(),
      });
    } catch (error) {
      checks.push({
        name: "Claude session discovery",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const broker = await ensureBroker();
    const hello = await broker.request<{ protocolVersion: number }>("hello");
    checks.push({
      name: "Orcode broker",
      ok: hello.protocolVersion === 1,
      detail: `protocol ${hello.protocolVersion}`,
    });
  } catch (error) {
    checks.push({
      name: "Orcode broker",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return checks;
}
