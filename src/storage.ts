import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OrcodeError } from "./errors.ts";
import type {
  MessageState,
  MessageStatus,
  Peer,
  PeerMessageEnvelope,
} from "./types.ts";

export function stateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.ORCODE_STATE_DIR && isAbsolute(environment.ORCODE_STATE_DIR)) {
    return environment.ORCODE_STATE_DIR;
  }
  if (environment.XDG_STATE_HOME && isAbsolute(environment.XDG_STATE_HOME)) {
    return join(environment.XDG_STATE_HOME, "orcode");
  }
  return join(homedir(), ".local", "state", "orcode");
}

type MessageRow = {
  id: string;
  from_address: string;
  to_address: string;
  state: MessageState;
  attempts: number;
  created_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  replied_at: string | null;
  last_error: string | null;
  envelope_json: string;
  next_attempt_at: number;
};

function peerRow(peer: Peer): Record<string, string | number | null> {
  return {
    address: peer.address,
    provider: peer.provider,
    session_id: peer.sessionId,
    name: peer.name,
    cwd: peer.cwd,
    project_id: peer.projectId,
    project_root: peer.projectRoot,
    native_target: peer.nativeTarget,
    host_pid: peer.hostPid ?? null,
    thread_id: peer.threadId ?? null,
    last_seen_at: new Date().toISOString(),
  };
}

function rowToPeer(row: Record<string, unknown>, reachable: boolean): Peer {
  return {
    provider: row.provider as Peer["provider"],
    sessionId: String(row.session_id),
    name: String(row.name),
    address: String(row.address),
    cwd: String(row.cwd),
    projectId: String(row.project_id),
    projectRoot: String(row.project_root),
    status: reachable ? "reachable" : "offline",
    nativeTarget: String(row.native_target),
    ...(typeof row.host_pid === "number" ? { hostPid: row.host_pid } : {}),
    ...(typeof row.thread_id === "string" ? { threadId: row.thread_id } : {}),
  };
}

function rowToStatus(row: MessageRow): MessageStatus {
  return {
    messageId: row.id,
    state: row.state,
    from: row.from_address,
    to: row.to_address,
    attempts: row.attempts,
    queuedAt: row.created_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
    ...(row.replied_at === null ? {} : { repliedAt: row.replied_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

export class MessageStore {
  readonly root: string;
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(root = stateRoot()) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    this.databasePath = join(root, "orcode.sqlite");
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        address TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        native_target TEXT NOT NULL,
        host_pid INTEGER,
        thread_id TEXT,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS peers_project_provider
        ON peers(project_id, provider, name);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT,
        replied_at TEXT,
        last_error TEXT,
        envelope_json TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_due
        ON messages(state, next_attempt_at, created_at);
    `);
    this.database.prepare(`
      UPDATE messages
      SET state = 'queued',
          last_error = COALESCE(last_error, 'Broker restarted during delivery; retrying.'),
          next_attempt_at = ?
      WHERE state = 'delivering'
    `).run(Date.now());
    chmodSync(this.databasePath, 0o600);
  }

  close(): void {
    this.database.close();
  }

  upsertPeer(peer: Peer): void {
    const row = peerRow(peer);
    this.database.prepare(`
      INSERT INTO peers (
        address, provider, session_id, name, cwd, project_id, project_root,
        native_target, host_pid, thread_id, last_seen_at
      ) VALUES (
        :address, :provider, :session_id, :name, :cwd, :project_id, :project_root,
        :native_target, :host_pid, :thread_id, :last_seen_at
      )
      ON CONFLICT(address) DO UPDATE SET
        name = excluded.name,
        cwd = excluded.cwd,
        project_id = excluded.project_id,
        project_root = excluded.project_root,
        native_target = excluded.native_target,
        host_pid = excluded.host_pid,
        thread_id = excluded.thread_id,
        last_seen_at = excluded.last_seen_at
    `).run(row);
  }

  upsertPeers(peers: Peer[]): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const peer of peers) this.upsertPeer(peer);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  peer(address: string, reachable = false): Peer | undefined {
    const row = this.database
      .prepare("SELECT * FROM peers WHERE address = ?")
      .get(address) as Record<string, unknown> | undefined;
    return row ? rowToPeer(row, reachable) : undefined;
  }

  peers(): Peer[] {
    return (this.database.prepare("SELECT * FROM peers ORDER BY address").all() as Record<string, unknown>[])
      .map((row) => rowToPeer(row, false));
  }

  insertMessage(envelope: PeerMessageEnvelope): void {
    this.database.prepare(`
      INSERT INTO messages (
        id, from_address, to_address, state, created_at, envelope_json, next_attempt_at
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      envelope.id,
      envelope.from.address,
      envelope.to,
      envelope.sentAt,
      JSON.stringify(envelope),
      Date.now(),
    );
  }

  envelope(messageId: string): PeerMessageEnvelope | undefined {
    const row = this.database
      .prepare("SELECT envelope_json FROM messages WHERE id = ?")
      .get(messageId) as { envelope_json: string } | undefined;
    return row ? (JSON.parse(row.envelope_json) as PeerMessageEnvelope) : undefined;
  }

  status(messageId: string): MessageStatus | undefined {
    const row = this.database
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as MessageRow | undefined;
    return row ? rowToStatus(row) : undefined;
  }

  due(limit = 20): string[] {
    return (this.database.prepare(`
      SELECT current.id FROM messages AS current
      WHERE current.state = 'queued'
        AND current.next_attempt_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM messages AS earlier
          WHERE earlier.to_address = current.to_address
            AND earlier.state IN ('queued', 'delivering')
            AND earlier.rowid < current.rowid
        )
      ORDER BY current.created_at ASC, current.rowid ASC LIMIT ?
    `).all(Date.now(), limit) as { id: string }[]).map((row) => row.id);
  }

  nextDueDelay(maximumMs = 1_000): number {
    const row = this.database.prepare(`
      SELECT MIN(current.next_attempt_at) AS next_attempt_at
      FROM messages AS current
      WHERE current.state = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM messages AS earlier
          WHERE earlier.to_address = current.to_address
            AND earlier.state IN ('queued', 'delivering')
            AND earlier.rowid < current.rowid
        )
    `).get() as { next_attempt_at: number | null };
    if (row.next_attempt_at === null) return maximumMs;
    return Math.max(25, Math.min(maximumMs, row.next_attempt_at - Date.now()));
  }

  markDelivering(messageId: string): boolean {
    const result = this.database.prepare(`
      UPDATE messages AS current
      SET state = 'delivering', attempts = attempts + 1
      WHERE current.id = ? AND current.state = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM messages AS earlier
          WHERE earlier.to_address = current.to_address
            AND earlier.state IN ('queued', 'delivering')
            AND earlier.rowid < current.rowid
        )
    `).run(messageId);
    return result.changes === 1;
  }

  markDelivered(messageId: string): void {
    this.database.prepare(`
      UPDATE messages SET state = 'delivered', delivered_at = ?, last_error = NULL
      WHERE id = ? AND state = 'delivering'
    `).run(new Date().toISOString(), messageId);
  }

  retry(messageId: string, error: string, delayMs: number): void {
    this.database.prepare(`
      UPDATE messages
      SET state = 'queued', last_error = ?, next_attempt_at = ?
      WHERE id = ? AND state = 'delivering'
    `).run(error.slice(0, 4_096), Date.now() + delayMs, messageId);
  }

  acknowledge(messageId: string, recipient: string): MessageStatus {
    const current = this.status(messageId);
    if (!current) throw new OrcodeError("MESSAGE_NOT_FOUND", `Unknown message ${messageId}.`);
    if (current.to !== recipient) {
      throw new OrcodeError("MESSAGE_NOT_OWNED", "Only the recipient can acknowledge a message.");
    }
    this.database.prepare(`
      UPDATE messages
      SET state = CASE WHEN state = 'replied' THEN state ELSE 'acknowledged' END,
          acknowledged_at = COALESCE(acknowledged_at, ?)
      WHERE id = ?
    `).run(new Date().toISOString(), messageId);
    return this.status(messageId) as MessageStatus;
  }

  markReplied(messageId: string, recipient: string): void {
    const current = this.status(messageId);
    if (!current) throw new OrcodeError("MESSAGE_NOT_FOUND", `Unknown message ${messageId}.`);
    if (current.to !== recipient) {
      throw new OrcodeError("MESSAGE_NOT_OWNED", "Only the recipient can reply to a message.");
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE messages
      SET state = 'replied', acknowledged_at = COALESCE(acknowledged_at, ?), replied_at = ?
      WHERE id = ?
    `).run(now, now, messageId);
  }

  cancel(messageId: string): MessageStatus {
    const current = this.status(messageId);
    if (!current) throw new OrcodeError("MESSAGE_NOT_FOUND", `Unknown message ${messageId}.`);
    if (current.state === "queued" || current.state === "delivering") {
      this.database.prepare("UPDATE messages SET state = 'cancelled' WHERE id = ?").run(messageId);
    }
    return this.status(messageId) as MessageStatus;
  }

  pruneDelivered(retentionMs = 7 * 24 * 60 * 60 * 1_000): number {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const result = this.database.prepare(`
      DELETE FROM messages
      WHERE state IN ('delivered', 'acknowledged', 'replied', 'failed', 'cancelled')
        AND created_at < ?
    `).run(cutoff);
    return Number(result.changes);
  }
}
