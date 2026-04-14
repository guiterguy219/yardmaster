/**
 * Tests for the PR-title newline-normalisation change in src/agents/git-agent.ts.
 *
 * The change ensures that multi-line task descriptions are collapsed to a single
 * line before being passed to `gh pr create --title`, so the shell command never
 * contains a literal newline inside the title argument.
 *
 * Strategy: mock `node:child_process.execSync` so we can intercept the exact
 * command string passed to `gh pr create` and assert it is newline-free.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test
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
  localPath: "/repos/test-repo",
  githubOrg: "acme",
  githubRepo: "widget",
  defaultBranch: "main",
};

const WORKTREE: Worktree = {
  path: "/tmp/worktrees/ym-abc123",
  branch: "ym/abc123",
  taskId: "ym-abc123",
};

/** Set up execSync to simulate a successful commit+push+PR sequence. */
function setupSuccessfulExecSync(prUrl = "https://github.com/acme/widget/pull/99"): void {
  const mock = vi.mocked(execSync);
  // Call order:
  //   1. git status --porcelain  → non-empty (changes exist)
  //   2. git add -A              → void
  //   3. git commit -m ...       → void
  //   4. git push -u origin ...  → void
  //   5. gh pr create ...        → PR URL string
  mock
    .mockReturnValueOnce("M src/foo.ts" as any) // git status
    .mockReturnValueOnce(undefined as any)       // git add
    .mockReturnValueOnce(undefined as any)       // git commit
    .mockReturnValueOnce(undefined as any)       // git push
    .mockReturnValueOnce(`${prUrl}\n` as any);   // gh pr create
}

/** Return the command string passed to the `gh pr create` execSync call. */
function captureGhPrCreateCommand(): string | undefined {
  const mock = vi.mocked(execSync);
  for (const call of mock.mock.calls) {
    const cmd = call[0];
    if (typeof cmd === "string" && cmd.includes("gh pr create")) {
      return cmd;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("commitAndPush — PR title newline normalisation", () => {
  it("strips a trailing newline from the task description in the PR title", () => {
    setupSuccessfulExecSync();
    const description = "Fix the login bug\n";
    commitAndPush(REPO, WORKTREE, description);

    const cmd = captureGhPrCreateCommand();
    expect(cmd).toBeDefined();
    // The title portion (between --title and --body) must not contain a raw newline
    const titleMatch = cmd!.match(/--title\s+'([^'\\]|\\.)*'/);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![0]).not.toMatch(/[\r\n]/);
  });

  it("collapses embedded newlines in the task description to spaces in the PR title", () => {
    setupSuccessfulExecSync();
    const multiLine = "Fix the login bug\n\nThis is a multi-line description.\nWith details.";
    commitAndPush(REPO, WORKTREE, multiLine);

    const cmd = captureGhPrCreateCommand();
    expect(cmd).toBeDefined();
    // Raw \n must not appear in the gh pr create command's title argument
    const titleMatch = cmd!.match(/--title\s+'([^'\\]|\\.)*'/);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![0]).not.toMatch(/[\r\n]/);
  });

  it("preserves a single-line description unchanged in the PR title", () => {
    setupSuccessfulExecSync();
    const singleLine = "Add health-check endpoint";
    commitAndPush(REPO, WORKTREE, singleLine);

    const cmd = captureGhPrCreateCommand();
    expect(cmd).toBeDefined();
    expect(cmd).toContain("Add health-check endpoint");
  });

  it("truncates a long (newline-normalised) description to ~60 chars with ellipsis", () => {
    setupSuccessfulExecSync();
    // 80-character description — after normalisation it's still 80 chars, so truncation applies
    const longDesc = "A".repeat(80);
    commitAndPush(REPO, WORKTREE, longDesc);

    const cmd = captureGhPrCreateCommand();
    expect(cmd).toBeDefined();

    // Extract only the --title argument value (single-quoted shell argument)
    const titleMatch = cmd!.match(/--title\s+'((?:[^'\\]|\\.)*)'/);
    expect(titleMatch).not.toBeNull();
    const titleArg = titleMatch![1];

    // After truncation to 60 chars the result ends with "..."
    expect(titleArg).toContain("...");
    // The full 80-char run must not appear inside the title
    expect(titleArg).not.toContain("A".repeat(80));
  });

  it("returns the PR URL on success", () => {
    const expectedUrl = "https://github.com/acme/widget/pull/42";
    setupSuccessfulExecSync(expectedUrl);
    const result = commitAndPush(REPO, WORKTREE, "Some task");
    expect(result.prUrl).toBe(expectedUrl);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
  });

  it("handles a description with only whitespace/newlines (trims to empty)", () => {
    setupSuccessfulExecSync();
    // After replace+trim this collapses to "agent: " — shouldn't crash
    const wsOnly = "\n\n  \r\n  ";
    expect(() => commitAndPush(REPO, WORKTREE, wsOnly)).not.toThrow();

    const cmd = captureGhPrCreateCommand();
    expect(cmd).toBeDefined();

    // Only the --title argument (not the --body) must be free of raw newlines
    const titleMatch = cmd!.match(/--title\s+'((?:[^'\\]|\\.)*)'/);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![1]).not.toMatch(/[\r\n]/);
  });
});

describe("commitAndPush — no changes guard", () => {
  it("returns committed=false when git status is empty", () => {
    vi.mocked(execSync).mockReturnValueOnce("" as any); // git status → empty
    const result = commitAndPush(REPO, WORKTREE, "Some task");
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.prUrl).toBeNull();
  });
});
