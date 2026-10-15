import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { OrcodeError } from "./errors.ts";
import { identifyProject } from "./project.ts";
import { processIsAlive, runProcess } from "./process.ts";
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
      if (pid !== undefined && !processIsAlive(pid)) continue;
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

export async function discoverCodexPeers(
  client: Pick<CodexAppServerClient, "request">,
): Promise<Peer[]> {
  const loaded = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.request("thread/loaded/list", {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    }) as { data?: unknown; nextCursor?: unknown } | undefined;
    if (!page || !Array.isArray(page.data)) {
      throw new OrcodeError("PROTOCOL_ERROR", "Codex returned an invalid loaded-thread list.");
    }
    for (const id of page.data) {
      if (typeof id === "string" && id !== "") loaded.add(id);
    }
    cursor = typeof page.nextCursor === "string" && page.nextCursor !== ""
      ? page.nextCursor
      : undefined;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) {
        throw new OrcodeError("PROTOCOL_ERROR", "Codex repeated a loaded-thread pagination cursor.");
      }
      cursors.add(cursor);
    }
  } while (cursor !== undefined);

  const peers: Peer[] = [];
  const projects = new Map<string, ReturnType<typeof identifyProject>>();
  const ids = [...loaded];
  // Read live metadata directly: newly opened threads may have no saved
  // history yet, and older loaded threads may be beyond thread/list's first page.
  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = await Promise.all(ids.slice(offset, offset + 8).map(async (sessionId) => {
      try {
        const result = await client.request("thread/read", {
          threadId: sessionId,
          includeTurns: false,
        }) as { thread?: UnknownRecord };
        const thread = result?.thread;
        if (!thread || thread.id !== sessionId) return undefined;
        if (thread.source !== "cli" && thread.source !== "vscode") return undefined;
        const status = thread.status as UnknownRecord | undefined;
        if (status?.type === "notLoaded") return undefined;
        const cwd = stringField(thread, ["cwd"]);
        if (!cwd) return undefined;
        let project = projects.get(cwd);
        if (!project) {
          project = identifyProject(cwd);
          projects.set(cwd, project);
        }
        return {
          provider: "codex",
          sessionId,
          name: stringField(thread, ["name"]) ?? `Codex ${sessionId.slice(0, 8)}`,
          address: `codex:${sessionId}`,
          cwd,
          projectId: project.id,
          projectRoot: project.root,
          status: "reachable",
          nativeTarget: sessionId,
          threadId: sessionId,
        } satisfies Peer;
      } catch {
        // A thread can close between enumeration and reading its metadata.
        return undefined;
      }
    }));
    for (const peer of batch) {
      if (peer) peers.push(peer);
    }
  }
  return peers.sort((left, right) => left.address.localeCompare(right.address));
}

export async function discoverNativeCodexPeers(
  options: { strict?: boolean } = {},
): Promise<Peer[]> {
  const info = await codexDaemonInfo();
  if (!info) {
    if (options.strict) {
      throw new OrcodeError(
        "PROVIDER_UNAVAILABLE",
        "The shared Codex app-server daemon is unavailable. Run 'codex app-server daemon start' and connect Codex sessions to it.",
      );
    }
    return [];
  }
  let client: CodexAppServerClient | undefined;
  try {
    client = await CodexAppServerClient.connect(info.socketPath);
    return await discoverCodexPeers(client);
  } catch (error) {
    if (options.strict) throw error;
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

interface MuseLogCursor {
  device: number;
  inode: number;
  offset: number;
  modifiedAt: number;
  pending: string;
  decoder: StringDecoder;
  facts: MuseLogFacts;
}

const museLogCursors = new Map<string, MuseLogCursor>();

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

function museLogFacts(logPath: string, sessionId: string): MuseLogFacts {
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const stat = fstatSync(fd);
    let cursor = museLogCursors.get(logPath);
    if (!cursor || cursor.device !== stat.dev || cursor.inode !== stat.ino ||
        stat.size < cursor.offset || (stat.size === cursor.offset && stat.mtimeMs !== cursor.modifiedAt)) {
      cursor = {
        device: stat.dev, inode: stat.ino, offset: 0, modifiedAt: stat.mtimeMs,
        pending: "", decoder: new StringDecoder("utf8"), facts: {},
      };
      museLogCursors.set(logPath, cursor);
    }
    const facts = cursor.facts;
    const buffer = Buffer.alloc(64 * 1024);
    while (cursor.offset < stat.size) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - cursor.offset), cursor.offset);
      if (bytesRead === 0) break;
      cursor.offset += bytesRead;
      const lines = (cursor.pending + cursor.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      cursor.pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!/runtime\.session\.(metadata|route_facts)|session\.name\.changed/u.test(line)) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        walkRecords(parsed, (record) => {
          const payload = record.payload as UnknownRecord | undefined;
          if (!payload || typeof payload !== "object") return;
          if (typeof payload.session_id === "string" && payload.session_id !== sessionId) return;
          if (record.payload_type === "session.name.changed") {
            if (typeof payload.new_name === "string" && payload.new_name !== "") {
              facts.name = payload.new_name;
            }
            return;
          }
          const inner = payload.record as UnknownRecord | undefined;
          if (!inner || typeof inner !== "object") return;
          if (typeof inner.session_id === "string" && inner.session_id !== sessionId) return;
          if (record.payload_type === "runtime.session.metadata") {
            if (typeof inner.workspace_root === "string" && inner.workspace_root !== "") {
              facts.cwd = inner.workspace_root;
            }
          }
          if (record.payload_type === "runtime.session.route_facts") {
            if (typeof inner.cwd === "string" && inner.cwd !== "") facts.cwd = inner.cwd;
            if (typeof inner.pid === "number") facts.pid = inner.pid;
          }
        });
      }
    }
    cursor.modifiedAt = stat.mtimeMs;
    return { ...facts };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
  const activeLogs = new Set<string>();
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
      const hintPid = /pid=(\d+)/u.exec(
        stringField(registered, ["process_generation_hint"]) ?? "",
      )?.[1];
      if (hintPid && !processIsAlive(Number(hintPid))) continue;
      const logPath = findMuseLogPath(dataRoot, sessionId);
      if (!logPath) continue;
      activeLogs.add(logPath);
      const facts = museLogFacts(logPath, sessionId);
      if (!facts.cwd) continue;
      const project = identifyProject(facts.cwd);
      const pid = hintPid ? Number(hintPid) : facts.pid;
      if (pid === undefined || !processIsAlive(pid)) continue;
      peers.push({
        provider: "muse",
        sessionId,
        name: stringField(registered, ["session_name"]) ?? facts.name ?? `Muse ${sessionId.slice(0, 8)}`,
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
  for (const logPath of museLogCursors.keys()) {
    if (!activeLogs.has(logPath)) museLogCursors.delete(logPath);
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
