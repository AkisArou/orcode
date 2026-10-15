import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { OrcodeError } from "./errors.ts";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function cleanEnvironment(
  additions: Record<string, string> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...additions };
}

export async function runProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const { timeoutMs = 15_000, ...spawnOptions } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new OrcodeError(
          "PROVIDER_UNAVAILABLE",
          `${command} timed out after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new OrcodeError(
          "PROVIDER_UNAVAILABLE",
          `Could not start ${command}: ${error.message}`,
        ),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export function commandVersion(command: string, args = ["--version"]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (result.status !== 0) return undefined;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || undefined;
}
