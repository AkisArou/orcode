import { accessSync, constants } from "node:fs";
import { commandVersion, runProcess } from "./process.ts";
import { SessionRegistry } from "./registry.ts";

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
    ok: atLeast(numericVersion(codexVersion), [0, 151, 0]),
    detail: `${codexVersion ?? "not found"} (requires >=0.151.0)`,
  });

  const claudeVersion = commandVersion(process.env.ORCODE_CLAUDE_BIN ?? "claude");
  checks.push({
    name: "Claude Code CLI",
    ok: atLeast(numericVersion(claudeVersion), [2, 1, 236]),
    detail: `${claudeVersion ?? "not found"} (requires >=2.1.236)`,
  });

  const registry = new SessionRegistry();
  let runtimeWritable = registry.assertPrivate();
  try {
    accessSync(registry.root, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    runtimeWritable = false;
  }
  checks.push({
    name: "Runtime directory",
    ok: runtimeWritable,
    detail: `${registry.root} (${runtimeWritable ? "private and writable" : "permissions invalid"})`,
  });

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

  return checks;
}
