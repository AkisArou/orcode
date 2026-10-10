export type Provider = "codex" | "claude";

export interface ProjectIdentity {
  id: string;
  root: string;
  commonDirectory: string;
  kind: "git" | "directory";
}

export type PeerStatus = "reachable" | "offline";

export interface Peer {
  provider: Provider;
  sessionId: string;
  name: string;
  address: string;
  cwd: string;
  projectId: string;
  projectRoot: string;
  status: PeerStatus;
  nativeTarget: string;
  hostPid?: number;
  threadId?: string;
}

export interface SelfContext {
  provider: Provider;
  sessionId: string;
  name: string;
  address: string;
  hostPid?: number;
  cwd: string;
  projectId: string;
  projectRoot: string;
}

export interface PeerMessageEnvelope {
  protocol: "orcode.peer-message";
  version: 2;
  id: string;
  from: {
    provider: Provider;
    sessionId: string;
    name: string;
    address: string;
  };
  to: string;
  sentAt: string;
  replyTo?: string;
  body: string;
}

export type MessageState =
  | "queued"
  | "delivering"
  | "delivered"
  | "held"
  | "acknowledged"
  | "replied"
  | "failed"
  | "cancelled";

export interface MessageStatus {
  messageId: string;
  state: MessageState;
  from: string;
  to: string;
  attempts: number;
  queuedAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  repliedAt?: string;
  lastError?: string;
}

export interface SendResult extends MessageStatus {
  peer: Peer;
}
