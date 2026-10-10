export type OrcodeErrorCode =
  | "INVALID_ARGUMENT"
  | "MESSAGE_TOO_LARGE"
  | "PEER_NOT_FOUND"
  | "PEER_AMBIGUOUS"
  | "PEER_OFFLINE"
  | "SELF_TARGET"
  | "PROVIDER_UNAVAILABLE"
  | "PROTOCOL_ERROR"
  | "SELF_NOT_IDENTIFIED"
  | "MESSAGE_NOT_FOUND"
  | "MESSAGE_NOT_OWNED"
  | "SETUP_CONFLICT";

export class OrcodeError extends Error {
  public readonly code: OrcodeErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(
    code: OrcodeErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OrcodeError";
    this.code = code;
    this.details = details;
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof OrcodeError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  return {
    error: {
      code: "PROTOCOL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
