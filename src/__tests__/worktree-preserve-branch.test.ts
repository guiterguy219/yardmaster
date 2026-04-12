/**
 * Tests for the `preserveBranch` option added to `cleanupWorktree` in
 * src/worktree.ts.
 *
 * Covers:
 *  - When preserveBranch is true the local branch is NOT deleted.
 *  - When preserveBranch is false (or omitted) the local branch IS deleted.
 *  - The worktree directory is always removed regardless of preserveBranch.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vitest hoists them
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock("../db.js", () => ({
  getTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  getDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { cleanupWorktree } from "../worktree.js";
import type { Worktree } from "../worktree.js";
import type { RepoConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(): RepoConfig {
  return {
    name: "test-repo",
    localPath: "/tmp/test-repo",
    githubOrg: "acme",
    githubRepo: "test-repo",
    defaultBranch: "main",
  };
}

function makeWorktree(): Worktree {
  return {
    path: "/tmp/worktrees/ym-abc123",
    branch: "ym/ym-abc123",
    taskId: "ym-abc123",
  };
}

function getBranchDeleteCalls(branch: string): string[][] {
  return vi.mocked(execSync).mock.calls
    .map(([cmd]) => cmd as string)
    .filter((cmd) => cmd.includes("branch -D") && cmd.includes(branch))
    .map((cmd) => [cmd]);
}

function getWorktreeRemoveCalls(): string[][] {
  return vi.mocked(execSync).mock.calls
    .map(([cmd]) => cmd as string)
    .filter((cmd) => cmd.includes("worktree remove"))
    .map((cmd) => [cmd]);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cleanupWorktree — preserveBranch: true", () => {
  it("does NOT delete the local branch", () => {
    cleanupWorktree(makeRepo(), makeWorktree(), { preserveBranch: true });
    expect(getBranchDeleteCalls(makeWorktree().branch)).toHaveLength(0);
  });

  it("still removes the worktree directory", () => {
    cleanupWorktree(makeRepo(), makeWorktree(), { preserveBranch: true });
    expect(getWorktreeRemoveCalls()).toHaveLength(1);
  });

  it("passes the worktree path to git worktree remove", () => {
    const worktree = makeWorktree();
    cleanupWorktree(makeRepo(), worktree, { preserveBranch: true });
    const [removeCall] = getWorktreeRemoveCalls();
    expect(removeCall[0]).toContain(worktree.path);
  });
});

describe("cleanupWorktree — preserveBranch: false", () => {
  it("deletes the local branch", () => {
    const worktree = makeWorktree();
    cleanupWorktree(makeRepo(), worktree, { preserveBranch: false });
    expect(getBranchDeleteCalls(worktree.branch)).toHaveLength(1);
  });
});

describe("cleanupWorktree — default options (preserveBranch omitted)", () => {
  it("deletes the local branch", () => {
    const worktree = makeWorktree();
    cleanupWorktree(makeRepo(), worktree);
    expect(getBranchDeleteCalls(worktree.branch)).toHaveLength(1);
  });

  it("removes the worktree directory", () => {
    cleanupWorktree(makeRepo(), makeWorktree());
    expect(getWorktreeRemoveCalls()).toHaveLength(1);
  });
});
