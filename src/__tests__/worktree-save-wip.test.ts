/**
 * Tests for `preserveBranchName` and the updated `saveWipWork` in src/worktree.ts.
 *
 * New behaviour added by the diff:
 *  - `preserveBranchName(taskId)` returns `ym-failed/<taskId>`.
 *  - When `saveWipWork` successfully commits WIP it now:
 *      1. Creates a local `ym-failed/<taskId>` branch pointing at the commit.
 *      2. Attempts to push it to origin with `--force-with-lease`.
 *      3. Returns `{ saved, method, ref, preserveBranch, pushed, remoteRef }`.
 *  - If the push fails (inner catch), `pushed` is false and `remoteRef` is
 *    undefined, but `preserveBranch` is still returned.
 *  - If branch creation itself fails (outer catch), the function falls back to
 *    the original return shape `{ saved: true, method: "commit", ref }` with
 *    no `preserveBranch`.
 *  - Stash path and no-changes path are unaffected (regression guard).
 *
 * Covers:
 *  - preserveBranchName — correct branch name format.
 *  - saveWipWork — no changes → saved:false.
 *  - saveWipWork — commit + push succeed → full result with pushed:true.
 *  - saveWipWork — commit succeeds, push fails → pushed:false, branch still set.
 *  - saveWipWork — commit succeeds, branch creation fails → legacy return shape.
 *  - saveWipWork — commit fails, stash succeeds → method:"stash".
 *  - saveWipWork — commit fails, stash fails → saved:false.
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
import { preserveBranchName, saveWipWork } from "../worktree.js";
import type { Worktree } from "../worktree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASK_ID = "ym-abc123";
const FAKE_SHA = "deadbeefdeadbeefdeadbeefdeadbeef";

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: "/tmp/worktrees/ym-abc123",
    branch: "ym/ym-abc123",
    taskId: TASK_ID,
    ...overrides,
  };
}

/**
 * Build a mock `execSync` that sequences through per-call implementations.
 * Each entry in `calls` receives (cmd, opts) and can return a value or throw.
 * If more calls arrive than entries, the last entry is repeated.
 */
function setupExecSyncSequence(
  calls: Array<(cmd: string) => Buffer | string | void>
): void {
  let idx = 0;
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    const handler = calls[Math.min(idx++, calls.length - 1)];
    return handler(cmd) as ReturnType<typeof execSync>;
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// preserveBranchName
// ---------------------------------------------------------------------------

describe("preserveBranchName", () => {
  it("returns ym-failed/<taskId>", () => {
    expect(preserveBranchName("ym-abc123")).toBe("ym-failed/ym-abc123");
  });

  it("works with arbitrary task IDs", () => {
    expect(preserveBranchName("ym-xyz999")).toBe("ym-failed/ym-xyz999");
  });
});

// ---------------------------------------------------------------------------
// saveWipWork — no changes
// ---------------------------------------------------------------------------

describe("saveWipWork — no changes", () => {
  beforeEach(() => {
    // git status --porcelain returns empty string → no changes
    vi.mocked(execSync).mockReturnValue("" as unknown as ReturnType<typeof execSync>);
  });

  it("returns saved:false and method:none", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result).toEqual({ saved: false, method: "none" });
  });

  it("does not call git add", () => {
    saveWipWork(makeWorktree(), "fix the bug");
    const addCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) =>
      (cmd as string).includes("git add")
    );
    expect(addCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// saveWipWork — commit + push both succeed
// ---------------------------------------------------------------------------

describe("saveWipWork — commit succeeds, push succeeds", () => {
  beforeEach(() => {
    setupExecSyncSequence([
      () => "M src/foo.ts",               // git status --porcelain → has changes
      () => undefined,                     // git add -A
      () => undefined,                     // git commit
      () => FAKE_SHA,                      // git rev-parse HEAD
      () => undefined,                     // git branch -f "ym-failed/..." sha
      () => undefined,                     // git push -u --force-with-lease origin "ym-failed/..."
    ]);
  });

  it("returns saved:true and method:commit", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.saved).toBe(true);
    expect(result.method).toBe("commit");
  });

  it("returns the commit SHA in ref", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.ref).toBe(FAKE_SHA);
  });

  it("returns the correct preserveBranch name", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.preserveBranch).toBe(`ym-failed/${TASK_ID}`);
  });

  it("returns pushed:true", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.pushed).toBe(true);
  });

  it("returns remoteRef pointing to origin/<preserveBranch>", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.remoteRef).toBe(`origin/ym-failed/${TASK_ID}`);
  });

  it("creates the preservation branch with force-create", () => {
    saveWipWork(makeWorktree(), "fix the bug");
    const branchCalls = vi.mocked(execSync).mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.includes("git branch -f"));
    expect(branchCalls).toHaveLength(1);
    expect(branchCalls[0]).toContain(`ym-failed/${TASK_ID}`);
  });

  it("pushes with --force-with-lease to origin", () => {
    saveWipWork(makeWorktree(), "fix the bug");
    const pushCalls = vi.mocked(execSync).mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.includes("git push"));
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toContain("--force-with-lease");
    expect(pushCalls[0]).toContain("origin");
    expect(pushCalls[0]).toContain(`ym-failed/${TASK_ID}`);
  });
});

// ---------------------------------------------------------------------------
// saveWipWork — commit succeeds, push fails
// ---------------------------------------------------------------------------

describe("saveWipWork — commit succeeds, push fails", () => {
  beforeEach(() => {
    setupExecSyncSequence([
      () => "M src/foo.ts",               // git status --porcelain
      () => undefined,                     // git add -A
      () => undefined,                     // git commit
      () => FAKE_SHA,                      // git rev-parse HEAD
      () => undefined,                     // git branch -f succeeds
      () => { throw new Error("network error"); }, // git push fails
    ]);
  });

  it("returns saved:true and method:commit", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.saved).toBe(true);
    expect(result.method).toBe("commit");
  });

  it("returns pushed:false", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.pushed).toBe(false);
  });

  it("returns preserveBranch even when push fails", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.preserveBranch).toBe(`ym-failed/${TASK_ID}`);
  });

  it("returns remoteRef as undefined", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.remoteRef).toBeUndefined();
  });

  it("still returns the commit SHA in ref", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.ref).toBe(FAKE_SHA);
  });
});

// ---------------------------------------------------------------------------
// saveWipWork — commit succeeds, branch creation fails
// ---------------------------------------------------------------------------

describe("saveWipWork — commit succeeds, branch creation fails", () => {
  beforeEach(() => {
    setupExecSyncSequence([
      () => "M src/foo.ts",               // git status --porcelain
      () => undefined,                     // git add -A
      () => undefined,                     // git commit
      () => FAKE_SHA,                      // git rev-parse HEAD
      () => { throw new Error("cannot create branch"); }, // git branch -f fails
    ]);
  });

  it("returns saved:true and method:commit", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.saved).toBe(true);
    expect(result.method).toBe("commit");
  });

  it("returns the commit SHA in ref", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.ref).toBe(FAKE_SHA);
  });

  it("does not return preserveBranch", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.preserveBranch).toBeUndefined();
  });

  it("does not return pushed", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.pushed).toBeUndefined();
  });

  it("does not return remoteRef", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.remoteRef).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// saveWipWork — commit fails, stash succeeds (regression guard)
// ---------------------------------------------------------------------------

describe("saveWipWork — commit fails, stash succeeds", () => {
  beforeEach(() => {
    setupExecSyncSequence([
      () => "M src/foo.ts",               // git status --porcelain
      () => undefined,                     // git add -A
      () => { throw new Error("nothing to commit"); }, // git commit fails
      () => undefined,                     // git stash push
    ]);
  });

  it("returns saved:true and method:stash", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.saved).toBe(true);
    expect(result.method).toBe("stash");
  });

  it("does NOT attempt to create a preservation branch", () => {
    saveWipWork(makeWorktree(), "fix the bug");
    const branchCalls = vi.mocked(execSync).mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.includes("git branch"));
    expect(branchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// saveWipWork — commit fails, stash also fails (regression guard)
// ---------------------------------------------------------------------------

describe("saveWipWork — commit fails, stash fails", () => {
  beforeEach(() => {
    setupExecSyncSequence([
      () => "M src/foo.ts",               // git status --porcelain
      () => undefined,                     // git add -A
      () => { throw new Error("nothing to commit"); }, // git commit fails
      () => { throw new Error("stash failed"); }, // git stash push fails
    ]);
  });

  it("returns saved:false and method:none", () => {
    const result = saveWipWork(makeWorktree(), "fix the bug");
    expect(result.saved).toBe(false);
    expect(result.method).toBe("none");
  });
});
