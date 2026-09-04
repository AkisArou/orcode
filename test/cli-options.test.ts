import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWrapperOptions } from "../src/cli-options.ts";
import { OrcodeError } from "../src/errors.ts";
import { resolvePeerName } from "../src/wrappers.ts";

const SESSION_ID = "a3f29c10-1234-4567-89ab-0123456789ab";

describe("wrapper options", () => {
  it("allows the peer name to be omitted", () => {
    assert.deepEqual(parseWrapperOptions([]), { forwarded: [] });
    assert.deepEqual(parseWrapperOptions(["--", "--model", "test-model"]), {
      forwarded: ["--model", "test-model"],
    });
  });

  it("preserves explicit names, resume identifiers, and forwarded options", () => {
    assert.deepEqual(
      parseWrapperOptions([
        "--name",
        "reviewer",
        "--resume",
        "session-id",
        "--",
        "--model",
        "opus",
      ]),
      {
        name: "reviewer",
        resume: "session-id",
        forwarded: ["--model", "opus"],
      },
    );
  });

  it("still requires values for options that are present", () => {
    assert.throws(
      () => parseWrapperOptions(["--name"]),
      (error: unknown) =>
        error instanceof OrcodeError &&
        error.code === "INVALID_ARGUMENT" &&
        error.message === "--name requires a value.",
    );
  });
});

describe("peer names", () => {
  it("generates provider-prefixed names from the session identifier", () => {
    assert.equal(resolvePeerName("codex", undefined, SESSION_ID), "codex-a3f29c10");
    assert.equal(resolvePeerName("claude", undefined, SESSION_ID), "claude-a3f29c10");
  });

  it("preserves and validates explicit names", () => {
    assert.equal(resolvePeerName("codex", "implementer", SESSION_ID), "implementer");
    assert.throws(
      () => resolvePeerName("claude", "invalid name", SESSION_ID),
      (error: unknown) =>
        error instanceof OrcodeError && error.code === "INVALID_ARGUMENT",
    );
  });
});
