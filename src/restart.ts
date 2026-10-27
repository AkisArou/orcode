import { brokerSocketPath, ensureBroker, stopBroker } from "./broker.ts";
import { runProcess } from "./process.ts";
import { runtimeRoot, runtimeRoots } from "./runtime.ts";
import { CodexTransport } from "./transports/codex.ts";
import type { Provider } from "./types.ts";

export interface RestartOptions {
  roots?: string[];
  reloadCodex?: () => Promise<void>;
  serversStartedBefore?: (since: number) => Promise<Map<Provider, number[]>>;
}

const NEXT_STEP: Record<Provider, string> = {
  codex: "Codex replaces them when asked to reload; restart the Codex session if one stays",
  claude: "run /mcp in that Claude session and reconnect orcode",
  muse: "restart Orcode's MCP server in that Muse session",
};

async function reloadCodex(): Promise<void> {
  const transport = new CodexTransport();
  try {
    const client = await transport.clientForDaemon();
    await client.request("config/mcpServer/reload");
  } finally {
    transport.close();
  }
}

// Orcode MCP servers a host started before `since`, by host. Each still runs
// the code it started with, and only its host can replace it.
async function serversStartedBefore(since: number): Promise<Map<Provider, number[]>> {
  const servers = new Map<Provider, number[]>();
  const listing = await runProcess("ps", ["-eo", "pid=,etimes=,args="]).catch(() => undefined);
  if (!listing || listing.exitCode !== 0) return servers;
  const minimumAge = (Date.now() - since) / 1000;
  for (const line of listing.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+\S*node\S*\s+\S*(?:\/orcode|cli\.ts)\s+mcp\s+--host\s+(codex|claude|muse)\b/u
      .exec(line);
    if (!match || Number(match[2]) < minimumAge) continue;
    const host = match[3] as Provider;
    servers.set(host, [...(servers.get(host) ?? []), Number(match[1])]);
  }
  return servers;
}

// Restarts every broker of this user on the current code, then asks the hosts
// to restart their Orcode servers. Returns what it did, one line each.
export async function restart(options: RestartOptions = {}): Promise<string[]> {
  const since = Date.now();
  const lines: string[] = [];
  const running: string[] = [];
  for (const root of options.roots ?? runtimeRoots()) {
    if (await stopBroker(brokerSocketPath(root))) running.push(root);
  }
  const canonical = runtimeRoot();
  await ensureBroker(canonical);
  lines.push(`broker: running at ${canonical}`);

  try {
    await (options.reloadCodex ?? reloadCodex)();
    lines.push("codex: asked the app-server to reload its MCP servers");
  } catch (error) {
    lines.push(`codex: not reloaded (${error instanceof Error ? error.message : String(error)})`);
  }

  // A server started earlier keeps the broker path it chose then. While one
  // remains, keep a broker wherever one was running; once none does, those
  // other places are retired.
  const servers = await (options.serversStartedBefore ?? serversStartedBefore)(since);
  for (const root of running) {
    if (root === canonical) continue;
    if (servers.size > 0) {
      await ensureBroker(root);
      lines.push(`broker: also running at ${root}, for servers started before this restart`);
    } else {
      lines.push(`broker: retired ${root}`);
    }
  }
  for (const [host, pids] of servers) {
    lines.push(`${host}: ${pids.length} Orcode server(s) from before (pid ${pids.join(", ")}): ${NEXT_STEP[host]}`);
  }
  return lines;
}
