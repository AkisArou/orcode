import { chmodSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function uid(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}

function ownDirectory(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isDirectory() && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  } catch {
    return false;
  }
}

export function runtimeRoot(
  environment: NodeJS.ProcessEnv = process.env,
  userRuntimeDir = `/run/user/${uid()}`,
): string {
  if (environment.ORCODE_RUNTIME_DIR && isAbsolute(environment.ORCODE_RUNTIME_DIR)) {
    return environment.ORCODE_RUNTIME_DIR;
  }
  if (environment.XDG_RUNTIME_DIR && isAbsolute(environment.XDG_RUNTIME_DIR)) {
    return join(environment.XDG_RUNTIME_DIR, "orcode");
  }
  // Hosts start Orcode with environments of their own: Codex gives MCP servers
  // no XDG_RUNTIME_DIR. Falling back to /tmp there gave one user two brokers,
  // one per environment, each with its own Claude bridge. Every process of the
  // user must reach the same broker, so use the directory the variable names
  // whenever it exists.
  if (ownDirectory(userRuntimeDir)) return join(userRuntimeDir, "orcode");
  return `/tmp/orcode-${uid()}`;
}

// Every root a broker of this user may be running at: this process's, and the
// ones a process with another environment, or an older Orcode, chose.
export function runtimeRoots(
  environment: NodeJS.ProcessEnv = process.env,
  userRuntimeDir = `/run/user/${uid()}`,
): string[] {
  const roots = [runtimeRoot(environment, userRuntimeDir)];
  if (environment.XDG_RUNTIME_DIR && isAbsolute(environment.XDG_RUNTIME_DIR)) {
    roots.push(join(environment.XDG_RUNTIME_DIR, "orcode"));
  }
  if (ownDirectory(userRuntimeDir)) roots.push(join(userRuntimeDir, "orcode"));
  roots.push(`/tmp/orcode-${uid()}`);
  return [...new Set(roots)];
}

export function ensureRuntimeRoot(root = runtimeRoot()): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}
