import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OrcodeError } from "../errors.ts";
import type { Peer } from "../types.ts";

export function museDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.ORCODE_MUSE_DATA_DIR && isAbsolute(environment.ORCODE_MUSE_DATA_DIR)) {
    return environment.ORCODE_MUSE_DATA_DIR;
  }
  if (environment.XDG_DATA_HOME && isAbsolute(environment.XDG_DATA_HOME)) {
    return join(environment.XDG_DATA_HOME, "muse");
  }
  return join(homedir(), ".local", "share", "muse");
}

export class MuseTransport {
  async send(peer: Peer, payload: string, messageId: string): Promise<void> {
    const databasePath = peer.nativeTarget;
    if (!existsSync(databasePath)) {
      throw new OrcodeError(
        "PEER_OFFLINE",
        `Muse session ${peer.address} has no scheduler database at ${databasePath}.`,
      );
    }
    const jobId = `orcode-${messageId}`;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath);
      database.exec("PRAGMA busy_timeout=5000;");
      const existing = database
        .prepare("SELECT id FROM cron_jobs WHERE id = ?")
        .get(jobId) as { id: string } | undefined;
      if (existing) return;
      const now = Date.now();
      database
        .prepare(`
          INSERT INTO cron_jobs (
            id, session_id, cron_expr, prompt, recurring, fire_when_active_run,
            kind, created_at_ms, next_fire_at_ms, status
          ) VALUES (?, ?, '* * * * *', ?, 0, 1, 'user', ?, ?, 'active')
        `)
        .run(jobId, peer.sessionId, payload, now, now);
    } catch (error) {
      if (error instanceof OrcodeError) throw error;
      throw new OrcodeError(
        "PEER_OFFLINE",
        `Could not schedule the message in Muse session ${peer.address}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      database?.close();
    }
  }

  async close(): Promise<void> {}
}

const defaultTransport = new MuseTransport();

export async function sendMuseMessage(
  peer: Peer,
  payload: string,
  messageId: string,
): Promise<void> {
  await defaultTransport.send(peer, payload, messageId);
}
