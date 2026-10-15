import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import {
  discoverAllNativePeers,
  discoverNativeClaudePeers,
  discoverNativeMusePeers,
} from "./discovery.ts";
import { createEnvelope, serializeEnvelope } from "./envelope.ts";
import { errorPayload, OrcodeError } from "./errors.ts";
import { ensureRuntimeRoot, runtimeRoot } from "./runtime.ts";
import { MessageStore } from "./storage.ts";
import { ClaudeTransport } from "./transports/claude.ts";
import { CodexTransport } from "./transports/codex.ts";
import { MuseTransport } from "./transports/muse.ts";
import type { MessageStatus, Peer, SelfContext, SendResult } from "./types.ts";

export const BROKER_PROTOCOL_VERSION = 1;

export interface BrokerDependencies {
  store?: MessageStore;
  discover?: typeof discoverAllNativePeers;
  discoverClaude?: typeof discoverNativeClaudePeers;
  discoverMuse?: typeof discoverNativeMusePeers;
  deliverCodex?: (
    peer: Peer,
    payload: string,
    messageId: string,
    preferSteer: boolean,
  ) => Promise<void>;
  deliverClaude?: (peer: Peer, payload: string) => Promise<void>;
  deliverMuse?: (peer: Peer, payload: string, messageId: string) => Promise<void>;
}

function asPeer(self: SelfContext): Peer {
  return {
    ...self,
    status: "reachable",
    nativeTarget: self.sessionId,
    ...(self.provider === "codex" ? { threadId: self.sessionId } : {}),
  };
}

function retryDelay(attempts: number): number {
  const schedule = [100, 500, 2_000, 5_000, 15_000, 30_000, 60_000];
  const base = schedule[Math.min(Math.max(attempts - 1, 0), schedule.length - 1)] as number;
  return base + Math.floor(Math.random() * Math.min(1_000, base / 5));
}

export class Broker {
  readonly store: MessageStore;
  private readonly discover: typeof discoverAllNativePeers;
  private readonly discoverClaude: typeof discoverNativeClaudePeers;
  private readonly discoverMuse: typeof discoverNativeMusePeers;
  private readonly codexTransport: CodexTransport;
  private readonly claudeTransport: ClaudeTransport;
  private readonly museTransport: MuseTransport;
  private readonly deliverCodex: (
    peer: Peer,
    payload: string,
    messageId: string,
    preferSteer: boolean,
  ) => Promise<void>;
  private readonly deliverClaude: (peer: Peer, payload: string) => Promise<void>;
  private readonly deliverMuse: (peer: Peer, payload: string, messageId: string) => Promise<void>;
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private discovering: Promise<Peer[]> | undefined;
  private claudePeers: Peer[] = [];
  private claudeDiscoveryAt = 0;
  private discoveringClaude: Promise<Peer[]> | undefined;
  private musePeers: Peer[] = [];
  private museDiscoveryAt = 0;
  private discoveringMuse: Promise<Peer[]> | undefined;
  private processing: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(dependencies: BrokerDependencies = {}) {
    this.store = dependencies.store ?? new MessageStore();
    this.discover = dependencies.discover ?? discoverAllNativePeers;
    this.discoverClaude = dependencies.discoverClaude ?? discoverNativeClaudePeers;
    this.discoverMuse = dependencies.discoverMuse ?? discoverNativeMusePeers;
    this.codexTransport = new CodexTransport();
    this.claudeTransport = new ClaudeTransport();
    this.museTransport = new MuseTransport();
    this.deliverCodex =
      dependencies.deliverCodex ??
      ((peer, payload, messageId, preferSteer) =>
        this.codexTransport.send(peer, payload, messageId, { preferSteer }));
    this.deliverClaude =
      dependencies.deliverClaude ??
      ((peer, payload) => this.claudeTransport.send(peer, payload));
    this.deliverMuse =
      dependencies.deliverMuse ??
      ((peer, payload, messageId) => this.museTransport.send(peer, payload, messageId));
    this.store.pruneDelivered();
    this.wake();
  }

  async listPeers(self: SelfContext, allProjects = false): Promise<Peer[]> {
    this.store.upsertPeer(asPeer(self));
    const live = await this.refreshPeers();
    return live
      .filter((peer) => peer.address !== self.address)
      .filter((peer) => allProjects || peer.projectId === self.projectId)
      .sort((left, right) => left.address.localeCompare(right.address));
  }

  async send(
    self: SelfContext,
    to: string,
    message: string,
    replyTo?: string,
  ): Promise<SendResult> {
    if (to === self.address) {
      throw new OrcodeError("SELF_TARGET", "A session cannot message itself.");
    }
    this.store.upsertPeer(asPeer(self));
    const live = await this.refreshPeers();
    const peer = this.resolvePeer(self, live, to);
    if (replyTo) {
      const original = this.store.status(replyTo);
      if (!original) throw new OrcodeError("MESSAGE_NOT_FOUND", `Unknown message ${replyTo}.`);
      if (original.to !== self.address) {
        throw new OrcodeError("MESSAGE_NOT_OWNED", "Only the recipient can reply to a message.");
      }
    }
    const envelope = createEnvelope(self, peer, message, replyTo, randomUUID());
    this.store.insertMessage(envelope);
    if (replyTo) this.store.markReplied(replyTo, self.address);
    await this.scheduleDelivery(envelope.id);
    this.wake();
    const status = this.store.status(envelope.id) as MessageStatus;
    return { ...status, peer };
  }

  status(self: SelfContext, messageId: string): MessageStatus {
    const status = this.store.status(messageId);
    if (!status) throw new OrcodeError("MESSAGE_NOT_FOUND", `Unknown message ${messageId}.`);
    if (status.from !== self.address && status.to !== self.address) {
      throw new OrcodeError("MESSAGE_NOT_OWNED", "This session is not part of that message.");
    }
    return status;
  }

  acknowledge(self: SelfContext, messageId: string): MessageStatus {
    return this.store.acknowledge(messageId, self.address);
  }

  cancel(messageId: string): MessageStatus {
    return this.store.cancel(messageId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.processing;
    await Promise.all(this.deliveryTails.values());
    this.codexTransport.close();
    await this.claudeTransport.close();
    await this.museTransport.close();
    this.store.close();
  }

  private async refreshPeers(): Promise<Peer[]> {
    if (this.discovering) return await this.discovering;
    this.discovering = this.discover().then((live) => {
      this.store.upsertPeers(live);
      const discoveryAt = Date.now();
      this.claudePeers = live.filter((peer) => peer.provider === "claude");
      this.claudeDiscoveryAt = discoveryAt;
      this.musePeers = live.filter((peer) => peer.provider === "muse");
      this.museDiscoveryAt = discoveryAt;
      return live;
    });
    try {
      return await this.discovering;
    } finally {
      this.discovering = undefined;
    }
  }

  private async refreshClaudePeers(): Promise<Peer[]> {
    if (Date.now() - this.claudeDiscoveryAt < 1_000) return this.claudePeers;
    if (this.discoveringClaude) return await this.discoveringClaude;
    this.discoveringClaude = this.discoverClaude().then((live) => {
      this.store.upsertPeers(live);
      this.claudePeers = live;
      this.claudeDiscoveryAt = Date.now();
      return live;
    });
    try {
      return await this.discoveringClaude;
    } finally {
      this.discoveringClaude = undefined;
    }
  }

  private async refreshMusePeers(): Promise<Peer[]> {
    if (Date.now() - this.museDiscoveryAt < 1_000) return this.musePeers;
    if (this.discoveringMuse) return await this.discoveringMuse;
    this.discoveringMuse = this.discoverMuse().then((live) => {
      this.store.upsertPeers(live);
      this.musePeers = live;
      this.museDiscoveryAt = Date.now();
      return live;
    });
    try {
      return await this.discoveringMuse;
    } finally {
      this.discoveringMuse = undefined;
    }
  }

  private resolvePeer(self: SelfContext, live: Peer[], target: string): Peer {
    const relevant = live.filter(
      (peer) => peer.address !== self.address && peer.projectId === self.projectId,
    );
    const matches = target.includes(":")
      ? relevant.filter((peer) => peer.address === target)
      : relevant.filter((peer) => peer.name === target);
    if (matches.length > 1) {
      throw new OrcodeError(
        "PEER_AMBIGUOUS",
        `More than one peer matches ${target}; use an exact address.`,
        { candidates: matches.map((peer) => peer.address) },
      );
    }
    if (matches.length === 1) return matches[0] as Peer;
    if (target === self.name) {
      throw new OrcodeError("SELF_TARGET", "A session cannot message itself.");
    }
    if (target.includes(":")) {
      const known = this.store.peer(target);
      if (known) return known;
    }
    throw new OrcodeError(
      "PEER_NOT_FOUND",
      `No peer matches ${target} in this project. Use list_peers for current addresses.`,
    );
  }

  private async deliverOne(messageId: string): Promise<void> {
    if (!this.store.markDelivering(messageId)) return;
    const envelope = this.store.envelope(messageId);
    if (!envelope) return;
    try {
      let peer = this.store.peer(envelope.to);
      if (!peer) throw new OrcodeError("PEER_NOT_FOUND", `Unknown target ${envelope.to}.`);
      if (peer.provider === "claude") {
        const live = await this.refreshClaudePeers();
        peer = live.find((candidate) => candidate.address === envelope.to);
        if (!peer) {
          throw new OrcodeError("PEER_OFFLINE", `${envelope.to} is not currently reachable.`);
        }
        await this.deliverClaude(peer, serializeEnvelope(envelope));
      } else if (peer.provider === "muse") {
        const live = await this.refreshMusePeers();
        peer = live.find((candidate) => candidate.address === envelope.to);
        if (!peer) {
          throw new OrcodeError("PEER_OFFLINE", `${envelope.to} is not currently reachable.`);
        }
        await this.deliverMuse(peer, serializeEnvelope(envelope), envelope.id);
      } else {
        await this.deliverCodex(
          peer,
          serializeEnvelope(envelope),
          envelope.id,
          true,
        );
      }
      this.store.markDelivered(messageId);
    } catch (error) {
      const status = this.store.status(messageId);
      const text = error instanceof Error ? error.message : String(error);
      this.store.retry(messageId, text, retryDelay(status?.attempts ?? 1));
    }
  }

  private scheduleDelivery(messageId: string): Promise<void> {
    const recipient = this.store.envelope(messageId)?.to ?? messageId;
    const previous = this.deliveryTails.get(recipient) ?? Promise.resolve();
    const delivery = previous.then(() => this.deliverOne(messageId));
    const tail = delivery.catch(() => undefined).finally(() => {
      if (this.deliveryTails.get(recipient) === tail) this.deliveryTails.delete(recipient);
    });
    this.deliveryTails.set(recipient, tail);
    return delivery;
  }

  private wake(): void {
    if (this.closed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.processing) {
      this.processing = this.processDue().finally(() => {
        this.processing = undefined;
        if (this.closed) return;
        this.retryTimer = setTimeout(() => this.wake(), this.store.nextDueDelay());
        this.retryTimer.unref();
      });
    }
  }

  private async processDue(): Promise<void> {
    for (;;) {
      const due = this.store.due();
      if (due.length === 0) return;
      await Promise.all(due.map((messageId) => this.scheduleDelivery(messageId)));
    }
  }
}

type BrokerRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type BrokerResponse = {
  id: string;
  result?: unknown;
  error?: Record<string, unknown>;
};

export function brokerSocketPath(root = runtimeRoot()): string {
  return resolve(root, "broker.sock");
}

async function dispatch(broker: Broker, request: BrokerRequest): Promise<unknown> {
  const params = request.params ?? {};
  if (request.method === "hello") {
    return { protocolVersion: BROKER_PROTOCOL_VERSION, version: "0.2.0", pid: process.pid };
  }
  if (request.method === "shutdown") {
    const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
    timer.unref();
    return { stopping: true };
  }
  if (request.method === "listPeers") {
    return await broker.listPeers(
      params.self as unknown as SelfContext,
      params.allProjects === true,
    );
  }
  if (request.method === "send") {
    return await broker.send(
      params.self as unknown as SelfContext,
      String(params.to),
      String(params.message),
      typeof params.replyTo === "string" ? params.replyTo : undefined,
    );
  }
  if (request.method === "status") {
    return broker.status(params.self as unknown as SelfContext, String(params.messageId));
  }
  if (request.method === "acknowledge") {
    return broker.acknowledge(params.self as unknown as SelfContext, String(params.messageId));
  }
  if (request.method === "cancel") return broker.cancel(String(params.messageId));
  throw new OrcodeError("INVALID_ARGUMENT", `Unknown broker method ${request.method}.`);
}

function attachSocket(socket: Socket, broker: Broker): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      void (async () => {
        let request: BrokerRequest | undefined;
        try {
          request = JSON.parse(line) as BrokerRequest;
          const result = await dispatch(broker, request);
          const response: BrokerResponse = { id: request.id, result };
          socket.write(`${JSON.stringify(response)}\n`);
        } catch (error) {
          const response: BrokerResponse = {
            id: request?.id ?? "invalid",
            error: errorPayload(error).error as Record<string, unknown>,
          };
          socket.write(`${JSON.stringify(response)}\n`);
        }
      })();
    }
  });
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return await new Promise((resolveLive) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveLive(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveLive(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveLive(false);
    });
  });
}

export async function runBrokerDaemon(): Promise<number> {
  const root = ensureRuntimeRoot();
  const socketPath = brokerSocketPath(root);
  if (existsSync(socketPath)) {
    if (await socketIsLive(socketPath)) return 0;
    rmSync(socketPath, { force: true });
  }
  const broker = new Broker();
  const server = createServer((socket) => attachSocket(socket, broker));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  const shutdown = () => {
    server.close(() => {
      void broker.close().finally(() => {
        rmSync(socketPath, { force: true });
        process.exit(0);
      });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return await new Promise<number>(() => undefined);
}

export class BrokerClient {
  readonly socketPath: string;

  constructor(socketPath = brokerSocketPath()) {
    this.socketPath = socketPath;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = randomUUID();
    return await new Promise<T>((resolveRequest, rejectRequest) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        rejectRequest(new OrcodeError("PROVIDER_UNAVAILABLE", `Broker request ${method} timed out.`));
      }, 15_000);
      timer.unref();
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        rejectRequest(error);
      };
      socket.setEncoding("utf8");
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        socket.off("error", fail);
        socket.end();
        const response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse;
        if (response.error) {
          const code = String(response.error.code) as OrcodeError["code"];
          rejectRequest(
            new OrcodeError(
              code,
              String(response.error.message ?? "Broker request failed."),
              response.error.details as Record<string, unknown> | undefined,
            ),
          );
        } else {
          resolveRequest(response.result as T);
        }
      });
    });
  }
}

export async function ensureBroker(): Promise<BrokerClient> {
  const client = new BrokerClient();
  try {
    const hello = await client.request<{ protocolVersion: number }>("hello");
    if (hello.protocolVersion === BROKER_PROTOCOL_VERSION) return client;
    await stopBroker();
  } catch {
    // Start a broker below.
  }
  {
    const entry = resolve(process.argv[1] ?? "src/cli.ts");
    const child = spawn(process.execPath, [entry, "daemon", "run"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    const deadline = Date.now() + 5_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const hello = await client.request<{ protocolVersion: number }>("hello");
        if (hello.protocolVersion !== BROKER_PROTOCOL_VERSION) {
          throw new OrcodeError(
            "PROTOCOL_ERROR",
            `Broker protocol ${hello.protocolVersion} does not match ${BROKER_PROTOCOL_VERSION}.`,
          );
        }
        return client;
      } catch (error) {
        lastError = error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    throw lastError;
  }
}

export async function stopBroker(): Promise<boolean> {
  const socketPath = brokerSocketPath();
  if (!existsSync(socketPath) || !(await socketIsLive(socketPath))) return false;
  const client = new BrokerClient(socketPath);
  await client.request("shutdown");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await socketIsLive(socketPath))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new OrcodeError("PROVIDER_UNAVAILABLE", "The Orcode broker did not stop in time.");
}
