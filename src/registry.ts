import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { OrcodeError } from "./errors.ts";
import type { Peer, Provider, SessionRecord } from "./types.ts";

function uid(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}

export function runtimeRoot(environment = process.env): string {
  if (environment.ORCODE_RUNTIME_DIR && isAbsolute(environment.ORCODE_RUNTIME_DIR)) {
    return environment.ORCODE_RUNTIME_DIR;
  }
  if (environment.XDG_RUNTIME_DIR && isAbsolute(environment.XDG_RUNTIME_DIR)) {
    return join(environment.XDG_RUNTIME_DIR, "orcode");
  }
  return `/tmp/orcode-${uid()}`;
}

export function ensureRuntimeRoot(root = runtimeRoot()): string {
  mkdirSync(join(root, "sessions"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "sockets"), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(join(root, "sessions"), 0o700);
  chmodSync(join(root, "sockets"), 0o700);
  return root;
}

function isProvider(value: unknown): value is Provider {
  return value === "codex" || value === "claude";
}

function parseRecord(text: string): SessionRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<SessionRecord>;
    if (
      value.version !== 1 ||
      typeof value.id !== "string" ||
      !isProvider(value.provider) ||
      typeof value.name !== "string" ||
      typeof value.address !== "string" ||
      typeof value.nativeTarget !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.cwd !== "string" ||
      typeof value.projectId !== "string" ||
      typeof value.projectRoot !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      return undefined;
    }
    return value as SessionRecord;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SessionRegistry {
  public readonly root: string;
  private readonly sessionsDirectory: string;

  constructor(root = runtimeRoot()) {
    this.root = ensureRuntimeRoot(root);
    this.sessionsDirectory = join(this.root, "sessions");
  }

  register(record: SessionRecord): void {
    const duplicate = this.list().find(
      (candidate) =>
        candidate.provider === record.provider &&
        candidate.name === record.name &&
        candidate.projectId === record.projectId &&
        candidate.id !== record.id,
    );
    if (duplicate) {
      throw new OrcodeError(
        "INVALID_ARGUMENT",
        `A live ${record.provider} peer named ${record.name} already exists in this project.`,
        { address: duplicate.address },
      );
    }

    const target = this.recordPath(record.id);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, target);
  }

  unregister(id: string): void {
    rmSync(this.recordPath(id), { force: true });
  }

  list(): SessionRecord[] {
    const records: SessionRecord[] = [];
    for (const entry of readdirSync(this.sessionsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(this.sessionsDirectory, entry.name);
      const record = parseRecord(readFileSync(path, "utf8"));
      const stale =
        record === undefined ||
        !isProcessAlive(record.pid) ||
        (record.provider === "codex" &&
          (record.socketPath === undefined || !existsSync(record.socketPath)));
      if (stale) {
        rmSync(path, { force: true });
        continue;
      }
      records.push(record);
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  socketPath(id: string): string {
    const preferred = join(this.root, "sockets", `${id.slice(0, 12)}.sock`);
    if (Buffer.byteLength(preferred) < 96) return preferred;
    const fallbackRoot = `/tmp/orcode-${uid()}`;
    ensureRuntimeRoot(fallbackRoot);
    return join(fallbackRoot, "sockets", `${id.slice(0, 12)}.sock`);
  }

  assertPrivate(): boolean {
    return (statSync(this.root).mode & 0o077) === 0;
  }

  private recordPath(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/u.test(id)) {
      throw new OrcodeError("INVALID_ARGUMENT", "Invalid session record identifier.");
    }
    return join(this.sessionsDirectory, `${id}.json`);
  }
}

export function recordToPeer(record: SessionRecord): Peer {
  return {
    provider: record.provider,
    name: record.name,
    address: record.address,
    projectRoot: record.projectRoot,
    status: "reachable",
    managed: true,
    nativeTarget: record.nativeTarget,
    ...(record.socketPath === undefined ? {} : { socketPath: record.socketPath }),
    ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
  };
}
