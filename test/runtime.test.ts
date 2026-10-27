import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runtimeRoot, runtimeRoots } from "../src/runtime.ts";

describe("runtime root", () => {
  it("reaches the same broker whether or not a host passes XDG_RUNTIME_DIR", () => {
    const userRuntimeDir = mkdtempSync(join(tmpdir(), "orcode-runtime-test-"));
    try {
      const shared = join(userRuntimeDir, "orcode");
      assert.equal(runtimeRoot({ XDG_RUNTIME_DIR: userRuntimeDir }, userRuntimeDir), shared);
      // Codex starts MCP servers without the variable.
      assert.equal(runtimeRoot({}, userRuntimeDir), shared);
      assert.equal(runtimeRoot({ ORCODE_RUNTIME_DIR: "/explicit" }, userRuntimeDir), "/explicit");
      assert.match(runtimeRoot({}, join(userRuntimeDir, "missing")), /^\/tmp\/orcode-/u);
    } finally {
      rmSync(userRuntimeDir, { recursive: true, force: true });
    }
  });

  it("lists every place a broker of this user may be running", () => {
    const userRuntimeDir = mkdtempSync(join(tmpdir(), "orcode-runtime-test-"));
    try {
      assert.deepEqual(runtimeRoots({ XDG_RUNTIME_DIR: "/xdg" }, userRuntimeDir), [
        "/xdg/orcode", join(userRuntimeDir, "orcode"), `/tmp/orcode-${process.getuid?.() ?? "user"}`,
      ]);
    } finally {
      rmSync(userRuntimeDir, { recursive: true, force: true });
    }
  });
});
