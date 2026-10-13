import {
  discoverNativeClaudePeers,
  discoverNativeCodexPeers,
  discoverNativeMusePeers,
} from "./discovery.ts";
import { OrcodeError } from "./errors.ts";
import { identifyProject } from "./project.ts";
import type { Provider, SelfContext } from "./types.ts";

type HandlerExtra = { _meta?: Record<string, unknown> };

function requestThreadId(extra: HandlerExtra): string | undefined {
  const meta = extra._meta;
  return typeof meta?.threadId === "string" && meta.threadId !== ""
    ? meta.threadId
    : undefined;
}

function explicitSessionId(provider: Provider, environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.ORCODE_SESSION_ID;
  if (!value) return undefined;
  const prefix = `${provider}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export async function resolveSelfContext(
  provider: Provider,
  extra: HandlerExtra,
  environment: NodeJS.ProcessEnv = process.env,
  hostPid = process.ppid,
): Promise<SelfContext> {
  if (provider === "codex") {
    const sessionId = requestThreadId(extra) ?? explicitSessionId(provider, environment);
    if (!sessionId) {
      throw new OrcodeError(
        "SELF_NOT_IDENTIFIED",
        "Codex did not attach a threadId to this MCP call. Update Codex and restart the session.",
      );
    }
    const peer = (await discoverNativeCodexPeers()).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (peer) return { ...peer, hostPid };
    const cwd = environment.ORCODE_CWD ?? process.cwd();
    const project = identifyProject(cwd);
    return {
      provider,
      sessionId,
      name: `Codex ${sessionId.slice(0, 8)}`,
      address: `codex:${sessionId}`,
      hostPid,
      cwd,
      projectId: project.id,
      projectRoot: project.root,
    };
  }

  if (provider === "muse") {
    const peers = await discoverNativeMusePeers();
    const environmentId =
      environment.MUSE_SESSION_ID ??
      environment.MUSE_THREAD_ID ??
      explicitSessionId(provider, environment);
    const peer =
      (environmentId
        ? peers.find((candidate) => candidate.sessionId === environmentId)
        : undefined) ?? peers.find((candidate) => candidate.hostPid === hostPid);
    if (peer) return { ...peer, hostPid };
    if (environmentId) {
      const cwd = environment.ORCODE_CWD ?? process.cwd();
      const project = identifyProject(cwd);
      return {
        provider,
        sessionId: environmentId,
        name: `Muse ${environmentId.slice(0, 8)}`,
        address: `muse:${environmentId}`,
        hostPid,
        cwd,
        projectId: project.id,
        projectRoot: project.root,
      };
    }
    throw new OrcodeError(
      "SELF_NOT_IDENTIFIED",
      "Muse did not expose a session ID for this MCP process. Update Muse and restart the session.",
    );
  }

  const peers = await discoverNativeClaudePeers();
  const environmentId =
    environment.CLAUDE_CODE_SESSION_ID ?? explicitSessionId(provider, environment);
  const peer =
    peers.find((candidate) => candidate.hostPid === hostPid) ??
    (environmentId
      ? peers.find((candidate) => candidate.sessionId === environmentId)
      : undefined);
  if (peer) return { ...peer, hostPid };
  if (environmentId) {
    const cwd = environment.CLAUDE_PROJECT_DIR ?? environment.ORCODE_CWD ?? process.cwd();
    const project = identifyProject(cwd);
    return {
      provider,
      sessionId: environmentId,
      name: `Claude ${environmentId.slice(0, 8)}`,
      address: `claude:${environmentId}`,
      hostPid,
      cwd,
      projectId: project.id,
      projectRoot: project.root,
    };
  }
  throw new OrcodeError(
    "SELF_NOT_IDENTIFIED",
    "Claude did not expose a session ID for this MCP process. Update Claude Code and restart the session.",
  );
}
