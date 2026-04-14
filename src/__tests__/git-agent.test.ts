/**
 * Tests for src/agents/git-agent.ts
 *
 * The sanitizeTitle helper is private; its behavior is verified by
 * inspecting the `git commit -m` and `gh pr create --title` command strings
 * that commitAndPush builds.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("../gh-auth.js", () => ({
  ghExecEnv: vi.fn().mockReturnValue({}),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { commitAndPush } from "../agents/git-agent.js";
import type { RepoConfig } from "../config.js";
import type { Worktree } from "../worktree.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO: RepoConfig = {
  name: "test-repo",
  localPath: "/tmp/test",
  githubOrg: "myorg",
  githubRepo: "myrepo",
  defaultBranch: "main",
};

const WORKTREE: Worktree = {
  path: "/tmp/worktrees/ym-abc",
  branch: "ym-abc-branch",
  taskId: "ym-abc",
};

/**
 * Sets up execSync to simulate a repo with changes so commitAndPush
 * proceeds through all stages and creates a PR.
 */
function setupSuccessfulExecSync() {
  vi.mocked(execSync).mockImplementation(((cmd: string | Buffer) => {
    const c = cmd.toString();
    if (c.startsWith("git status")) return "M src/foo.ts";
    if (c.startsWith("gh pr create")) return "https://github.com/myorg/myrepo/pull/42\n";
    // git add, git commit, git push — return empty (treated as void)
    return "";
  }) as typeof execSync);
}

/** Returns the argument passed to the first `git commit -m …` call. */
function captureCommitMsg(): string {
  const call = vi.mocked(execSync).mock.calls.find(
    ([cmd]) => typeof cmd === "string" && cmd.startsWith("git commit")
  );
  return call ? String(call[0]) : "";
}

/** Returns the argument passed to the `gh pr create` call. */
function capturePrCreateCmd(): string {
  const call = vi.mocked(execSync).mock.calls.find(
    ([cmd]) => typeof cmd === "string" && cmd.startsWith("gh pr create")
  );
  return call ? String(call[0]) : "";
}

// ---------------------------------------------------------------------------
// Tests: sanitizeTitle behavior
// ---------------------------------------------------------------------------

describe("sanitizeTitle (via commitAndPush)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessfulExecSync();
  });

  it("strips a leading single-# markdown header", () => {
    commitAndPush(REPO, WORKTREE, "# Add new feature");
    expect(captureCommitMsg()).toContain("Add new feature");
    expect(captureCommitMsg()).not.toMatch(/^.*agent\(code\): #/);
  });

  it("strips a leading multi-# markdown header (## level)", () => {
    commitAndPush(REPO, WORKTREE, "## Fix the bug in auth module");
    const msg = captureCommitMsg();
    expect(msg).toContain("Fix the bug in auth module");
    expect(msg).not.toContain("##");
  });

  it("strips a leading ### header followed by a space", () => {
    commitAndPush(REPO, WORKTREE, "### Refactor the database layer");
    const msg = captureCommitMsg();
    expect(msg).toContain("Refactor the database layer");
    expect(msg).not.toContain("###");
  });

  it("does not strip # that appears mid-string", () => {
    commitAndPush(REPO, WORKTREE, "Fix issue #42 in auth");
    const msg = captureCommitMsg();
    expect(msg).toContain("Fix issue #42 in auth");
  });

  it("replaces newline characters with spaces", () => {
    commitAndPush(REPO, WORKTREE, "Fix bug\nin auth\nmodule");
    const msg = captureCommitMsg();
    expect(msg).toContain("Fix bug in auth module");
    expect(msg).not.toContain("\n");
  });

  it("replaces carriage-return + newline with a single space", () => {
    commitAndPush(REPO, WORKTREE, "Fix bug\r\nin auth");
    const msg = captureCommitMsg();
    expect(msg).toContain("Fix bug in auth");
    expect(msg).not.toContain("\r");
  });

  it("collapses multiple spaces into one", () => {
    commitAndPush(REPO, WORKTREE, "Fix   the   bug");
    const msg = captureCommitMsg();
    expect(msg).toContain("Fix the bug");
    expect(msg).not.toContain("  ");
  });

  it("trims leading and trailing whitespace", () => {
    commitAndPush(REPO, WORKTREE, "  Fix the bug  ");
    const msg = captureCommitMsg();
    // Commit message format: `agent(code): Fix the bug`
    expect(msg).toMatch(/agent\(code\): Fix the bug/);
  });

  it("applies sanitization to the PR title as well", () => {
    commitAndPush(REPO, WORKTREE, "## Add login feature\nwith OAuth support");
    const prCmd = capturePrCreateCmd();
    // Extract the --title value: everything between --title ' and the next '
    const titleMatch = prCmd.match(/--title '([^']+)'/);
    const prTitle = titleMatch?.[1] ?? "";
    expect(prTitle).toContain("Add login feature with OAuth support");
    expect(prTitle).not.toContain("##");
    expect(prTitle).not.toContain("\n");
  });

  it("leaves a plain one-liner title unchanged", () => {
    commitAndPush(REPO, WORKTREE, "Fix null pointer in parser");
    const msg = captureCommitMsg();
    expect(msg).toContain("Fix null pointer in parser");
  });

  it("returns 'No changes to commit' when git status is empty", () => {
    vi.mocked(execSync).mockImplementation(((cmd: string | Buffer) => {
      const c = cmd.toString();
      if (c.startsWith("git status")) return "";
      return "";
    }) as typeof execSync);

    const result = commitAndPush(REPO, WORKTREE, "Some task");
    expect(result.committed).toBe(false);
    expect(result.error).toBe("No changes to commit");
  });
});
