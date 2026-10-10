import { identifyProject } from "./project.ts";
import { runProcess } from "./process.ts";
import { codexDaemonInfo, CodexAppServerClient } from "./transports/codex.ts";
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

export async function discoverAllNativePeers(): Promise<Peer[]> {
  const [codex, claude] = await Promise.all([
    discoverNativeCodexPeers(),
    discoverNativeClaudePeers(),
  ]);
  return [...codex, ...claude].sort((left, right) => left.address.localeCompare(right.address));
}
