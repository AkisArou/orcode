import { randomUUID } from "node:crypto";
import { OrcodeError } from "./errors.ts";
import type { Peer, PeerMessageEnvelope, SelfContext } from "./types.ts";

export const MAX_MESSAGE_BYTES = 64 * 1024;

export function createEnvelope(
  self: SelfContext,
  peer: Peer,
  body: string,
  replyTo?: string,
  id: string = randomUUID(),
): PeerMessageEnvelope {
  if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) {
    throw new OrcodeError(
      "MESSAGE_TOO_LARGE",
      `Message exceeds the ${MAX_MESSAGE_BYTES}-byte UTF-8 limit.`,
    );
  }
  if (body.length === 0) {
    throw new OrcodeError("INVALID_ARGUMENT", "Message must not be empty.");
  }
  return {
    protocol: "orcode.peer-message",
    version: 2,
    id,
    from: {
      provider: self.provider,
      sessionId: self.sessionId,
      name: self.name,
      address: self.address,
    },
    to: peer.address,
    sentAt: new Date().toISOString(),
    ...(replyTo === undefined ? {} : { replyTo }),
    body,
  };
}

export function serializeEnvelope(envelope: PeerMessageEnvelope): string {
  const sentAt = new Date(envelope.sentAt).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const reply = envelope.replyTo ? ` · replyTo=\`${envelope.replyTo}\`` : "";
  return [
    `## ${envelope.from.name} (${sentAt})`,
    "",
    envelope.body,
    "",
    "---",
    `Orcode · id=\`${envelope.id}\` · from=\`${envelope.from.address}\`${reply}`,
  ].join("\n");
}
