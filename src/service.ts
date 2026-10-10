import { ensureBroker, type BrokerClient } from "./broker.ts";
import type { MessageStatus, Peer, SelfContext, SendResult } from "./types.ts";

export class PeerService {
  private readonly self: SelfContext;
  private readonly broker: BrokerClient | undefined;

  constructor(
    self: SelfContext,
    broker?: BrokerClient,
  ) {
    this.self = self;
    this.broker = broker;
  }

  private async client(): Promise<BrokerClient> {
    return this.broker ?? (await ensureBroker());
  }

  async listPeers(allProjects = false): Promise<Peer[]> {
    return await (await this.client()).request<Peer[]>("listPeers", {
      self: this.self,
      allProjects,
    });
  }

  async send(to: string, message: string, replyTo?: string): Promise<SendResult> {
    return await (await this.client()).request<SendResult>("send", {
      self: this.self,
      to,
      message,
      ...(replyTo === undefined ? {} : { replyTo }),
    });
  }

  async messageStatus(messageId: string): Promise<MessageStatus> {
    return await (await this.client()).request<MessageStatus>("status", {
      self: this.self,
      messageId,
    });
  }

  async acknowledge(messageId: string): Promise<MessageStatus> {
    return await (await this.client()).request<MessageStatus>("acknowledge", {
      self: this.self,
      messageId,
    });
  }
}
