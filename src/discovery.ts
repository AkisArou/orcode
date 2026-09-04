import type { Peer, SelfContext } from "./types.ts";
import { identifyProject } from "./project.ts";
import { runProcess } from "./process.ts";
import { recordToPeer, SessionRegistry } from "./registry.ts";

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
    for (const key of ["sessions", "agents", "items"]) {
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
      const name = stringField(session, ["name", "sessionName", "agentName"]);
      const nativeTarget = name ?? stringField(session, ["agentId", "sessionId", "id"]);
      const cwd = stringField(session, ["cwd", "projectPath", "workingDirectory"]);
      if (!name || !nativeTarget || !cwd) continue;
      const project = identifyProject(cwd);
      peers.push({
        provider: "claude",
        name,
        address: `claude:${name}`,
        projectRoot: project.root,
        status: "reachable",
        managed: false,
        nativeTarget,
      });
    }
    return peers;
  } catch {
    return [];
  }
}

export interface DiscoveryOptions {
  allProjects?: boolean;
  includeNativeClaude?: boolean;
}

export async function discoverPeers(
  self: SelfContext,
  registry: SessionRegistry,
  options: DiscoveryOptions = {},
): Promise<Peer[]> {
  const records = registry
    .list()
    .filter((record) => options.allProjects || record.projectId === self.projectId)
    .filter((record) => record.address !== self.address)
    .filter((record) => self.provider === undefined || record.provider !== self.provider);

  const managed = records.map(recordToPeer);
  const native =
    options.includeNativeClaude !== false && self.provider !== "claude"
      ? await discoverNativeClaudePeers()
      : [];
  const combined = [...managed];
  for (const peer of native) {
    if (!options.allProjects && identifyProject(peer.projectRoot).id !== self.projectId) continue;
    if (!combined.some((candidate) => candidate.address === peer.address)) combined.push(peer);
  }
  return combined.sort((left, right) => left.address.localeCompare(right.address));
}
