import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { identifyProject } from "../src/project.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "orcode-project-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("identifyProject", () => {
  it("uses the real directory outside Git", () => {
    const directory = temporaryDirectory();
    const nested = join(directory, "nested");
    mkdirSync(nested);
    const project = identifyProject(nested);
    assert.equal(project.kind, "directory");
    assert.equal(project.root, realpathSync.native(nested));
  });

  it("gives linked Git worktrees the same project id", () => {
    const parent = temporaryDirectory();
    const repository = join(parent, "main");
    const worktree = join(parent, "worktree");
    mkdirSync(repository);
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Orcode Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@orcode.invalid"], { cwd: repository });
    writeFileSync(join(repository, "README"), "test\n");
    execFileSync("git", ["add", "README"], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repository });
    execFileSync("git", ["worktree", "add", "--quiet", "-b", "secondary", worktree], {
      cwd: repository,
    });

    const primaryIdentity = identifyProject(repository);
    const worktreeIdentity = identifyProject(worktree);
    assert.equal(primaryIdentity.kind, "git");
    assert.equal(primaryIdentity.id, worktreeIdentity.id);
    assert.notEqual(primaryIdentity.root, worktreeIdentity.root);
  });
});
