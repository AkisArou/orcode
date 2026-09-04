import { discoverPeers } from "./discovery.ts";
import { createEnvelope, serializeEnvelope } from "./envelope.ts";
import { OrcodeError } from "./errors.ts";
import { SessionRegistry } from "./registry.ts";
import { sendClaudeMessage } from "./transports/claude.ts";
import { sendCodexMessage } from "./transports/codex.ts";
import type { Peer, SelfContext, SendResult } from "./types.ts";

export interface PeerServiceDependencies {
  registry?: SessionRegistry;
  discover?: typeof discoverPeers;
  deliverCodex?: typeof sendCodexMessage;
  deliverClaude?: typeof sendClaudeMessage;
}

export class PeerService {
  private readonly registry: SessionRegistry;
  private readonly discover: typeof discoverPeers;
  private readonly deliverCodex: typeof sendCodexMessage;
  private readonly deliverClaude: typeof sendClaudeMessage;
  private readonly self: SelfContext;

  constructor(
    self: SelfContext,
    dependencies: PeerServiceDependencies = {},
  ) {
    this.self = self;
    this.registry = dependencies.registry ?? new SessionRegistry();
    this.discover = dependencies.discover ?? discoverPeers;
    this.deliverCodex = dependencies.deliverCodex ?? sendCodexMessage;
    this.deliverClaude = dependencies.deliverClaude ?? sendClaudeMessage;
  }

  async listPeers(allProjects = false): Promise<Peer[]> {
    return await this.discover(this.self, this.registry, { allProjects });
  }

  async send(to: string, message: string, replyTo?: string): Promise<SendResult> {
    if (to === this.self.address || to === this.self.name) {
      throw new OrcodeError("SELF_TARGET", "A session cannot message itself.");
    }
    const peer = this.resolvePeer(await this.listPeers(false), to);
    const envelope = createEnvelope(this.self, peer, message, replyTo);
    const payload = serializeEnvelope(envelope);
    if (peer.provider === "codex") {
      await this.deliverCodex(peer, payload);
    } else {
      await this.deliverClaude(peer, payload);
    }
    return { messageId: envelope.id, status: "accepted", peer };
  }

  private resolvePeer(peers: Peer[], target: string): Peer {
    const matches = peers.filter(
      (peer) => peer.address === target || (!target.includes(":") && peer.name === target),
    );
    if (matches.length === 0) {
      throw new OrcodeError(
        "PEER_NOT_FOUND",
        `No live peer matches ${target} in this project.`,
      );
    }
    if (matches.length > 1) {
      throw new OrcodeError(
        "PEER_AMBIGUOUS",
        `More than one peer matches ${target}; use an exact address.`,
        { candidates: matches.map((peer) => peer.address) },
      );
    }
    return matches[0] as Peer;
  }
}
