import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function uid(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}

export function runtimeRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.ORCODE_RUNTIME_DIR && isAbsolute(environment.ORCODE_RUNTIME_DIR)) {
    return environment.ORCODE_RUNTIME_DIR;
  }
  if (environment.XDG_RUNTIME_DIR && isAbsolute(environment.XDG_RUNTIME_DIR)) {
    return join(environment.XDG_RUNTIME_DIR, "orcode");
  }
  return `/tmp/orcode-${uid()}`;
}

export function ensureRuntimeRoot(root = runtimeRoot()): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}
