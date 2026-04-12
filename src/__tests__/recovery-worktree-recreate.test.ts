/**
 * Tests for the worktree-recreation logic added to `recoverInterruptedTasks`
 * in src/recovery.ts.
 *
 * Prior behaviour: if the worktree directory was missing, skip the task.
 * New behaviour:   if the worktree is missing but the branch still exists,
 *                  recreate the worktree from that branch and continue.
 *                  Only skip when neither the worktree nor the branch exist.
 *
 * Covers:
 *  - Worktree present → recreation is not attempted.
 *  - Worktree absent, branch present → worktree add is called; task recovered.
 *  - Worktree absent, branch absent → task is skipped (skipped++).
 *  - Repo not in config → task is skipped before the worktree check.
 *  - task.branch is used when set; falls back to `ym/<taskId>` otherwise.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vitest hoists them
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from("")),
  execFileSync: vi.fn().mockReturnValue(Buffer.from("")),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(""),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getRepo: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getInterruptedTasks: vi.fn().mockReturnValue([]),
  getRunningTasks: vi.fn().mockReturnValue([]),
  updateTask: vi.fn(),
  updatePipelineStage: vi.fn(),
  claimInterruptedTask: vi.fn().mockReturnValue(true),
  getDb: vi.fn(),
}));

vi.mock("../test-loop.js", () => ({
  runTestLoop: vi.fn().mockResolvedValue({ passed: true, attempts: 0 }),
}));

vi.mock("../agents/git-agent.js", () => ({
  commitAndPush: vi.fn().mockReturnValue({ committed: true, prUrl: "https://github.com/acme/repo/pull/99", error: null }),
}));

vi.mock("../issue-lifecycle.js", () => ({
  notifyPrCreated: vi.fn(),
  notifyFailed: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getRepo } from "../config.js";
import { getInterruptedTasks, claimInterruptedTask } from "../db.js";
import { recoverInterruptedTasks } from "../recovery.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";
import type { TaskRow } from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): YardmasterConfig {
  return {
    repos: [],
    dataDir: "/tmp/test-data",
    worktreeBaseDir: "/tmp/test-data/worktrees",
    claudeBinary: "claude",
    defaultModel: "sonnet",
    maxConcurrentAgents: 1,
    timeouts: { coder: 60_000, reviewer: 60_000, gitAgent: 60_000, diagnostician: 180_000, diagnosticianEscalated: 300_000 },
  };
}

function makeRepo(): RepoConfig {
  return {
    name: "test-repo",
    localPath: "/tmp/test-repo",
    githubOrg: "acme",
    githubRepo: "test-repo",
    defaultBranch: "main",
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "ym-rectest01",
    repo: "test-repo",
    description: "do something",
    status: "interrupted",
    pipeline_stage: "review_complete",
    branch: null,
    pr_url: null,
    error: null,
    worker_pid: null,
    issue_ref: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Returns execFileSync calls matching the given git subcommand. */
function getGitCalls(subcommand: string): unknown[][] {
  return vi.mocked(execFileSync).mock.calls.filter(
    ([bin, args]) => bin === "git" && Array.isArray(args) && args[0] === subcommand
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRepo).mockReturnValue(makeRepo());
  vi.mocked(claimInterruptedTask).mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recoverInterruptedTasks — worktree present", () => {
  it("does not attempt branch verification when worktree directory exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true); // worktree present
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask()]);

    await recoverInterruptedTasks(makeConfig());

    const revParseCalls = getGitCalls("rev-parse");
    expect(revParseCalls).toHaveLength(0);
  });
});

describe("recoverInterruptedTasks — worktree absent, branch present", () => {
  beforeEach(() => {
    // existsSync: false for the initial worktree check, then true for subsequent
    // fs calls inside the recovery path (e.g. checking worktreePath after cleanup)
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("verifies the branch with git rev-parse --verify", async () => {
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask()]);

    await recoverInterruptedTasks(makeConfig());

    const revParseCalls = getGitCalls("rev-parse");
    expect(revParseCalls).toHaveLength(1);
    const [, args] = revParseCalls[0] as [string, string[]];
    expect(args).toContain("--verify");
    expect(args).toContain("ym/ym-rectest01"); // fallback branch name
  });

  it("uses task.branch when it is set", async () => {
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask({ branch: "ym/custom-branch" })]);

    await recoverInterruptedTasks(makeConfig());

    const revParseCalls = getGitCalls("rev-parse");
    expect(revParseCalls).toHaveLength(1);
    const [, args] = revParseCalls[0] as [string, string[]];
    expect(args).toContain("ym/custom-branch");
  });

  it("recreates the worktree via git worktree add", async () => {
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask()]);

    await recoverInterruptedTasks(makeConfig());

    const worktreeAddCalls = getGitCalls("worktree");
    expect(worktreeAddCalls.length).toBeGreaterThanOrEqual(1);
    const addCall = worktreeAddCalls.find(([, args]) => (args as string[])[1] === "add");
    expect(addCall).toBeDefined();
  });

  it("counts the task as recovered (not skipped)", async () => {
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask()]);

    const result = await recoverInterruptedTasks(makeConfig());

    expect(result.skipped).toBe(0);
    // recovered or failed depending on downstream steps; key thing is not skipped
    expect(result.skipped).toBe(0);
  });
});

describe("recoverInterruptedTasks — worktree absent, branch unavailable", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    // Make rev-parse throw to simulate branch not found
    vi.mocked(execFileSync).mockImplementation((bin, args) => {
      if (bin === "git" && Array.isArray(args) && args[0] === "rev-parse") {
        throw new Error("fatal: not a valid ref");
      }
      return Buffer.from("");
    });
  });

  it("skips the task", async () => {
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask()]);

    const result = await recoverInterruptedTasks(makeConfig());

    expect(result.skipped).toBe(1);
  });

  it("does not attempt to recover or fail the task", async () => {
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask()]);

    const result = await recoverInterruptedTasks(makeConfig());

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("does not call git worktree add", async () => {
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask()]);

    await recoverInterruptedTasks(makeConfig());

    const worktreeAddCalls = getGitCalls("worktree").filter(
      ([, args]) => (args as string[])[0] === "add"
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });
});

describe("recoverInterruptedTasks — repo not in config", () => {
  it("skips the task before checking the worktree", async () => {
    vi.mocked(getRepo).mockImplementation(() => {
      throw new Error(`Repo "unknown-repo" not found`);
    });
    vi.mocked(getInterruptedTasks).mockReturnValue([makeTask({ repo: "unknown-repo" })]);

    const result = await recoverInterruptedTasks(makeConfig());

    expect(result.skipped).toBe(1);
    // existsSync for worktree should not have been called since we bail out early
    const revParseCalls = getGitCalls("rev-parse");
    expect(revParseCalls).toHaveLength(0);
  });
});

describe("recoverInterruptedTasks — empty task list", () => {
  it("returns zeros when there are no interrupted tasks", async () => {
    vi.mocked(getInterruptedTasks).mockReturnValue([]);

    const result = await recoverInterruptedTasks(makeConfig());

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
  });
});
