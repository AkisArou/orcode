import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ProjectIdentity } from "./types.ts";

function realpathOrResolve(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function identifyProject(cwd = process.cwd()): ProjectIdentity {
  const realCwd = realpathOrResolve(cwd);
  const result = spawnSync(
    "git",
    ["-C", realCwd, "rev-parse", "--show-toplevel", "--git-common-dir"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );

  if (result.status === 0 && typeof result.stdout === "string") {
    const [topLevel, commonDirectory] = result.stdout.trim().split(/\r?\n/u);
    if (topLevel && commonDirectory) {
      const root = realpathOrResolve(topLevel);
      const common = realpathOrResolve(
        commonDirectory.startsWith("/")
          ? commonDirectory
          : resolve(realCwd, commonDirectory),
      );
      return {
        id: hash(`git:${common}`),
        root,
        commonDirectory: common,
        kind: "git",
      };
    }
  }

  return {
    id: hash(`directory:${realCwd}`),
    root: realCwd,
    commonDirectory: realCwd,
    kind: "directory",
  };
}
