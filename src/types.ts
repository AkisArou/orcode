export type Provider = "codex" | "claude";

export interface ProjectIdentity {
  id: string;
  root: string;
  commonDirectory: string;
  kind: "git" | "directory";
}

export interface SessionRecord {
  version: 1;
  id: string;
  provider: Provider;
  name: string;
  address: string;
  nativeTarget: string;
  pid: number;
  cwd: string;
  projectId: string;
  projectRoot: string;
  createdAt: string;
  socketPath?: string;
  threadId?: string;
}

export interface Peer {
  provider: Provider;
  name: string;
  address: string;
  projectRoot: string;
  status: "reachable";
  managed: boolean;
  nativeTarget: string;
  socketPath?: string;
  threadId?: string;
}

export interface SelfContext {
  provider?: Provider;
  name: string;
  address: string;
  cwd: string;
  projectId: string;
  projectRoot: string;
}

export interface PeerMessageEnvelope {
  protocol: "orcode.peer-message";
  version: 1;
  id: string;
  from: {
    provider: Provider;
    name: string;
    address: string;
  };
  to: string;
  sentAt: string;
  replyTo?: string;
  body: string;
}

export interface SendResult {
  messageId: string;
  status: "accepted";
  peer: Peer;
}
