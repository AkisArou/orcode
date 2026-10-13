import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { identifyProject } from "./project.ts";
import { runProcess } from "./process.ts";
import { codexDaemonInfo, CodexAppServerClient } from "./transports/codex.ts";
import { museDataRoot } from "./transports/muse.ts";
import type { Peer } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

function stringField(record: UnknownRecord, fields: string[]): string | undefined {
  for (const field of fields) {
    if (typeof record[field] === "string" && record[field] !== "") {
      return record[field] as string;
    }
  }
  return undefined;
}

function sessionArray(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is UnknownRecord => item !== null && typeof item === "object");
  }
  if (value && typeof value === "object") {
    const record = value as UnknownRecord;
    for (const key of ["sessions", "agents", "items", "data"]) {
      if (Array.isArray(record[key])) return sessionArray(record[key]);
    }
  }
  return [];
}

export async function discoverNativeClaudePeers(): Promise<Peer[]> {
  const command = process.env.ORCODE_CLAUDE_BIN ?? "claude";
  try {
    const result = await runProcess(command, ["agents", "--json"], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) return [];
    const sessions = sessionArray(JSON.parse(result.stdout) as unknown);
    const peers: Peer[] = [];
    for (const session of sessions) {
      const sessionId = stringField(session, ["sessionId", "session_id"]);
      const id = stringField(session, ["id", "ref"]);
      const cwd = stringField(session, ["cwd", "projectPath", "workingDirectory"]);
      if (!sessionId || !cwd) continue;
      const name =
        stringField(session, ["name", "sessionName", "agentName"]) ??
        `Claude ${sessionId.slice(0, 8)}`;
      const project = identifyProject(cwd);
      const pid = typeof session.pid === "number" ? session.pid : undefined;
      peers.push({
        provider: "claude",
        sessionId,
        name,
        address: `claude:${sessionId}`,
        cwd,
        projectId: project.id,
        projectRoot: project.root,
        status: "reachable",
        nativeTarget: id ? `${name} [${id}]` : name,
        ...(pid === undefined ? {} : { hostPid: pid }),
      });
    }
    return peers;
  } catch {
    return [];
  }
}

export async function discoverNativeCodexPeers(): Promise<Peer[]> {
  const info = await codexDaemonInfo();
  if (!info) return [];
  let client: CodexAppServerClient | undefined;
  try {
    client = await CodexAppServerClient.connect(info.socketPath);
    const loadedResult = (await client.request("thread/loaded/list", {})) as {
      data?: unknown;
    };
    const loaded = new Set(
      Array.isArray(loadedResult.data)
        ? loadedResult.data.filter((id): id is string => typeof id === "string")
        : [],
    );
    const listResult = await client.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode"],
    });
    const peers: Peer[] = [];
    for (const thread of sessionArray(listResult)) {
      const sessionId = stringField(thread, ["id"]);
      const cwd = stringField(thread, ["cwd"]);
      if (!sessionId || !cwd || !loaded.has(sessionId)) continue;
      const name = stringField(thread, ["name"]) ?? `Codex ${sessionId.slice(0, 8)}`;
      const project = identifyProject(cwd);
      peers.push({
        provider: "codex",
        sessionId,
        name,
        address: `codex:${sessionId}`,
        cwd,
        projectId: project.id,
        projectRoot: project.root,
        status: "reachable",
        nativeTarget: sessionId,
        threadId: sessionId,
      });
    }
    return peers;
  } catch {
    return [];
  } finally {
    client?.close();
  }
}

interface MuseLogFacts {
  cwd?: string;
  name?: string;
  pid?: number;
}

function walkRecords(value: unknown, visit: (record: UnknownRecord) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkRecords(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as UnknownRecord;
  visit(record);
  for (const item of Object.values(record)) {
    if (typeof item === "string" && item.startsWith("{")) {
      try {
        walkRecords(JSON.parse(item) as unknown, visit);
      } catch {
        // Not a nested record.
      }
    } else {
      walkRecords(item, visit);
    }
  }
}

function museLogFacts(logPath: string): MuseLogFacts {
  const facts: MuseLogFacts = {};
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const buffer = Buffer.alloc(512 * 1024);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      walkRecords(parsed, (record) => {
        const payload = record.payload as UnknownRecord | undefined;
        if (!payload || typeof payload !== "object") return;
        if (record.payload_type === "session.name.changed") {
          if (typeof payload.new_name === "string" && payload.new_name !== "") {
            facts.name = payload.new_name;
          }
          return;
        }
        const inner = payload.record as UnknownRecord | undefined;
        if (!inner || typeof inner !== "object") return;
        if (record.payload_type === "runtime.session.metadata") {
          if (typeof inner.workspace_root === "string" && inner.workspace_root !== "") {
            facts.cwd ??= inner.workspace_root;
          }
        }
        if (record.payload_type === "runtime.session.route_facts") {
          if (typeof inner.cwd === "string" && inner.cwd !== "") facts.cwd ??= inner.cwd;
          if (typeof inner.pid === "number") facts.pid ??= inner.pid;
        }
      });
      if (facts.cwd && facts.name) break;
    }
  } catch {
    // Facts stay partial; the caller skips peers without a workspace.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return facts;
}

function findMuseLogPath(dataRoot: string, sessionId: string): string | undefined {
  const sessionsRoot = join(dataRoot, "sessions");
  const list = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  for (const year of list(sessionsRoot)) {
    for (const month of list(join(sessionsRoot, year))) {
      for (const day of list(join(sessionsRoot, year, month))) {
        const candidate = join(sessionsRoot, year, month, day, sessionId, "session.jsonl");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

export async function discoverNativeMusePeers(): Promise<Peer[]> {
  const dataRoot = museDataRoot();
  const registryDir = join(dataRoot, "runtime", "muse", "sessions");
  let entries: string[];
  try {
    entries = readdirSync(registryDir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
  const peers: Peer[] = [];
  for (const entry of entries) {
    try {
      const registered = JSON.parse(
        readFileSync(join(registryDir, entry), "utf8"),
      ) as UnknownRecord;
      const sessionId = stringField(registered, ["session_id"]);
      const endpoint = stringField(registered, ["endpoint_hint"]);
      if (!sessionId || !endpoint) continue;
      if (registered.target_eligibility !== "message_capable") continue;
      if (!existsSync(join(dataRoot, "runtime", "muse", endpoint))) continue;
      const logPath = findMuseLogPath(dataRoot, sessionId);
      if (!logPath) continue;
      const facts = museLogFacts(logPath);
      if (!facts.cwd) continue;
      const project = identifyProject(facts.cwd);
      const hintPid = /pid=(\d+)/u.exec(
        stringField(registered, ["process_generation_hint"]) ?? "",
      )?.[1];
      const pid = facts.pid ?? (hintPid ? Number(hintPid) : undefined);
      peers.push({
        provider: "muse",
        sessionId,
        name: facts.name ?? `Muse ${sessionId.slice(0, 8)}`,
        address: `muse:${sessionId}`,
        cwd: facts.cwd,
        projectId: project.id,
        projectRoot: project.root,
        status: "reachable",
        nativeTarget: join(logPath, "..", "cron.db"),
        ...(pid === undefined ? {} : { hostPid: pid }),
      });
    } catch {
      continue;
    }
  }
  return peers.sort((left, right) => left.address.localeCompare(right.address));
}

export async function discoverAllNativePeers(): Promise<Peer[]> {
  const [codex, claude, muse] = await Promise.all([
    discoverNativeCodexPeers(),
    discoverNativeClaudePeers(),
    discoverNativeMusePeers(),
  ]);
  return [...codex, ...claude, ...muse].sort((left, right) =>
    left.address.localeCompare(right.address),
  );
}
