/**
 * Tests for the WIP-preservation logic added to the `executeTask` finally
 * block in src/task-runner.ts.
 *
 * When a task ends in a non-terminal failure state ("failed", "partial", or
 * "interrupted"), the pipeline now:
 *   1. Calls `saveWipWork` to commit or stash in-progress edits.
 *   2. Calls `cleanupWorktree` with `{ preserveBranch: true }` so the branch
 *      survives and the work can be inspected or recovered via `ym recover`.
 *
 * When a task succeeds ("completed"), neither preservation step is triggered:
 *   - `saveWipWork` is NOT called.
 *   - `cleanupWorktree` is called with `{ preserveBranch: false }` (or a
 *     falsy preserveBranch).
 *
 * Covers:
 *  - status "failed"      → WIP saved, branch preserved.
 *  - status "partial"     → WIP saved, branch preserved.
 *  - status "interrupted" → WIP saved, branch preserved.
 *  - status "completed"   → WIP NOT saved, branch NOT preserved.
 *  - status undefined     → WIP NOT saved, branch NOT preserved.
 *  - saveWipWork error is swallowed; cleanupWorktree is still called.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vitest hoists them
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from("")),
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(),
  getRepo: vi.fn(),
}));

vi.mock("../db.js", () => ({
  createTask: vi.fn().mockReturnValue("ym-test-001"),
  updateTask: vi.fn(),
  updatePipelineStage: vi.fn(),
  getDb: vi.fn(),
  logAgentRun: vi.fn(),
  getTask: vi.fn(),
  getRecentTasks: vi.fn().mockReturnValue([]),
}));

vi.mock("../capacity.js", () => ({
  checkCapacity: vi.fn().mockReturnValue({ canProceed: true, isUsingOverage: false }),
}));

vi.mock("../worktree.js", () => ({
  createWorktree: vi.fn().mockReturnValue({
    path: "/tmp/worktree",
    branch: "ym/ym-test-001",
    taskId: "ym-test-001",
  }),
  cleanupWorktree: vi.fn(),
  saveWipWork: vi.fn().mockReturnValue({ saved: false, method: "none" }),
}));

vi.mock("../ingestor.js", () => ({
  ingestRepo: vi.fn().mockResolvedValue({ filesChanged: 0, filesScanned: 0, chunksUpserted: 0, depsUpserted: 0 }),
}));

vi.mock("../review-loop.js", () => ({
  runReviewLoop: vi.fn().mockResolvedValue({
    converged: true,
    finalVerdict: "approve",
    rounds: 1,
    reviewSummary: "All good.",
  }),
}));

vi.mock("../test-loop.js", () => ({
  runTestLoop: vi.fn().mockResolvedValue({ passed: true, attempts: 0 }),
}));

vi.mock("../agents/test-quality.js", () => ({
  runTestQualityAgent: vi.fn().mockResolvedValue({ summary: "NO_TESTS_NEEDED", wrote: false }),
}));

vi.mock("../integration/runner.js", () => ({
  runIntegrationPipeline: vi.fn().mockResolvedValue({ ran: false, passed: false, attempts: 0, output: "not configured" }),
}));

vi.mock("../browser-validation.js", () => ({
  runBrowserValidation: vi.fn().mockResolvedValue({ ran: false, passed: false, output: "not configured" }),
}));

vi.mock("../agents/git-agent.js", () => ({
  commitAndPush: vi.fn().mockReturnValue({ committed: true, prUrl: "https://github.com/acme/repo/pull/1", error: null }),
}));

vi.mock("../failure-analysis.js", () => ({
  analyzeFailure: vi.fn().mockResolvedValue("unknown"),
}));

vi.mock("../diagnostician.js", () => ({
  runDiagnosticLoop: vi.fn().mockResolvedValue({ recovered: false, diagnosis: "test", action: "give_up" }),
}));

vi.mock("../issue-lifecycle.js", () => ({
  notifyStarted: vi.fn(),
  notifyPrCreated: vi.fn(),
  notifyFailed: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { loadConfig, getRepo } from "../config.js";
import { getTask } from "../db.js";
import { cleanupWorktree, saveWipWork } from "../worktree.js";
import { runReviewLoop } from "../review-loop.js";
import { executeTask } from "../task-runner.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";

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

function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "test-repo",
    localPath: "/tmp/test-repo",
    githubOrg: "acme",
    githubRepo: "test-repo",
    defaultBranch: "main",
    ...overrides,
  };
}

/** Returns the options argument passed to the last cleanupWorktree call. */
function lastCleanupOptions(): Record<string, unknown> | undefined {
  const calls = vi.mocked(cleanupWorktree).mock.calls;
  if (calls.length === 0) return undefined;
  return calls[calls.length - 1][2] as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockReturnValue(makeConfig());
  vi.mocked(getRepo).mockReturnValue(makeRepo());
  // Default: task is completed (successful path)
  vi.mocked(getTask).mockReturnValue({
    id: "ym-test-001",
    repo: "test-repo",
    description: "add a feature",
    status: "completed",
    branch: "ym/ym-test-001",
    pr_url: null,
    error: null,
    worker_pid: null,
    issue_ref: null,
    pipeline_stage: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  });
});

// ---------------------------------------------------------------------------
// Tests — failed / partial / interrupted → WIP preserved
// ---------------------------------------------------------------------------

describe("WIP preservation — task status 'failed'", () => {
  beforeEach(() => {
    // Simulate a review loop failure so the pipeline marks the task failed
    vi.mocked(runReviewLoop).mockRejectedValue(new Error("agent crashed"));
    vi.mocked(getTask).mockReturnValue({
      id: "ym-test-001",
      repo: "test-repo",
      description: "add a feature",
      status: "failed",
      branch: "ym/ym-test-001",
      pr_url: null,
      error: "agent crashed",
      worker_pid: null,
      issue_ref: null,
      pipeline_stage: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    });
  });

  it("calls saveWipWork before cleanup", async () => {
    await executeTask("test-repo", "add a feature");
    expect(saveWipWork).toHaveBeenCalled();
  });

  it("calls cleanupWorktree with preserveBranch: true", async () => {
    await executeTask("test-repo", "add a feature");
    expect(lastCleanupOptions()?.preserveBranch).toBe(true);
  });
});

describe("WIP preservation — task status 'partial'", () => {
  beforeEach(() => {
    vi.mocked(runReviewLoop).mockRejectedValue(new Error("partial failure"));
    vi.mocked(getTask).mockReturnValue({
      id: "ym-test-001",
      repo: "test-repo",
      description: "add a feature",
      status: "partial",
      branch: "ym/ym-test-001",
      pr_url: null,
      error: "partial failure",
      worker_pid: null,
      issue_ref: null,
      pipeline_stage: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    });
  });

  it("calls saveWipWork before cleanup", async () => {
    await executeTask("test-repo", "add a feature");
    expect(saveWipWork).toHaveBeenCalled();
  });

  it("calls cleanupWorktree with preserveBranch: true", async () => {
    await executeTask("test-repo", "add a feature");
    expect(lastCleanupOptions()?.preserveBranch).toBe(true);
  });
});

describe("WIP preservation — task status 'interrupted'", () => {
  beforeEach(() => {
    vi.mocked(runReviewLoop).mockRejectedValue(new Error("interrupted"));
    vi.mocked(getTask).mockReturnValue({
      id: "ym-test-001",
      repo: "test-repo",
      description: "add a feature",
      status: "interrupted",
      branch: "ym/ym-test-001",
      pr_url: null,
      error: "interrupted",
      worker_pid: null,
      issue_ref: null,
      pipeline_stage: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    });
  });

  it("calls saveWipWork before cleanup", async () => {
    await executeTask("test-repo", "add a feature");
    expect(saveWipWork).toHaveBeenCalled();
  });

  it("calls cleanupWorktree with preserveBranch: true", async () => {
    await executeTask("test-repo", "add a feature");
    expect(lastCleanupOptions()?.preserveBranch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — completed / undefined → branch NOT preserved
// ---------------------------------------------------------------------------

describe("WIP preservation — task status 'completed'", () => {
  it("does NOT call saveWipWork", async () => {
    // Default mock has status: "completed" and review loop succeeds
    await executeTask("test-repo", "add a feature");
    expect(saveWipWork).not.toHaveBeenCalled();
  });

  it("calls cleanupWorktree without preserveBranch: true", async () => {
    await executeTask("test-repo", "add a feature");
    const opts = lastCleanupOptions();
    expect(opts?.preserveBranch).not.toBe(true);
  });
});

describe("WIP preservation — getTask returns undefined (status unknown)", () => {
  beforeEach(() => {
    vi.mocked(getTask).mockReturnValue(undefined);
  });

  it("does NOT call saveWipWork", async () => {
    await executeTask("test-repo", "add a feature");
    expect(saveWipWork).not.toHaveBeenCalled();
  });

  it("calls cleanupWorktree without preserveBranch: true", async () => {
    await executeTask("test-repo", "add a feature");
    const opts = lastCleanupOptions();
    expect(opts?.preserveBranch).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — saveWipWork error does not prevent cleanup
// ---------------------------------------------------------------------------

describe("WIP preservation — saveWipWork throws", () => {
  beforeEach(() => {
    vi.mocked(runReviewLoop).mockRejectedValue(new Error("pipeline error"));
    vi.mocked(getTask).mockReturnValue({
      id: "ym-test-001",
      repo: "test-repo",
      description: "add a feature",
      status: "failed",
      branch: "ym/ym-test-001",
      pr_url: null,
      error: "pipeline error",
      worker_pid: null,
      issue_ref: null,
      pipeline_stage: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    });
    vi.mocked(saveWipWork).mockImplementation(() => {
      throw new Error("git stash failed");
    });
  });

  it("still calls cleanupWorktree even when saveWipWork throws", async () => {
    await executeTask("test-repo", "add a feature");
    expect(cleanupWorktree).toHaveBeenCalled();
  });

  it("still preserves the branch when saveWipWork throws", async () => {
    await executeTask("test-repo", "add a feature");
    expect(lastCleanupOptions()?.preserveBranch).toBe(true);
  });
});
