/**
 * Tests for the protected-files regression gate added to executeTask in
 * src/task-runner.ts.
 *
 * After the review loop (and before check / test / PR stages), the pipeline
 * calls checkProtectedRegressions. If violations are found the task is marked
 * failed immediately and no PR is created. If ran=false (no protected lists
 * configured), or ran=true with no violations, execution continues normally.
 *
 * These tests verify:
 *  - When violations exist, the task returns success=false with a
 *    "Protected regression detected:" error and does NOT create a PR.
 *  - When violations exist and an issueRef is provided, notifyFailed is called
 *    with the issueRef and the regression error message.
 *  - When violations exist but no issueRef, notifyFailed is NOT called
 *    (notifyTaskFailed is used instead).
 *  - When ran=false (no config), execution continues to PR creation.
 *  - When ran=true and violations=[],  updatePipelineStage("protected_check_complete")
 *    is called and execution continues to PR creation.
 *  - When ran=true and violations=[], updateTask is NOT called with status "failed".
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
  createWorktree: vi.fn().mockReturnValue({ path: "/tmp/worktree", branch: "ym-test-001" }),
  cleanupWorktree: vi.fn(),
  saveWipWork: vi.fn().mockReturnValue({ saved: false }),
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

vi.mock("../agents/coder.js", () => ({
  runCoder: vi.fn().mockResolvedValue({ success: true, output: "" }),
}));

vi.mock("../agents/test-quality.js", () => ({
  runTestQualityAgent: vi.fn().mockResolvedValue({ summary: "NO_TESTS_NEEDED", wrote: false }),
}));

vi.mock("../integration/runner.js", () => ({
  runIntegrationTests: vi.fn().mockResolvedValue({ ran: false, passed: false, attempts: 0, output: "not configured" }),
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

vi.mock("../ci-preflight.js", () => ({
  runCIPreflight: vi.fn().mockResolvedValue({ ran: false, passed: true, attempts: 0, output: "no workflow files found", skippedJobs: [] }),
}));

vi.mock("../issue-lifecycle.js", () => ({
  notifyStarted: vi.fn(),
  notifyPrCreated: vi.fn(),
  notifyFailed: vi.fn(),
}));

vi.mock("../telegram/notify.js", () => ({
  notifyTaskStarted: vi.fn(),
  notifyTaskCompleted: vi.fn(),
  notifyTaskFailed: vi.fn(),
  notifyPipelineStage: vi.fn(),
}));

vi.mock("../protected-regressions.js", () => ({
  checkProtectedRegressions: vi.fn(),
  formatViolations: vi.fn((violations) =>
    violations.map((v: any) =>
      v.function ? `${v.file}::${v.function} — ${v.reason}` : `${v.file} — ${v.reason}`
    ).join("; ")
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { loadConfig, getRepo } from "../config.js";
import { updateTask, updatePipelineStage } from "../db.js";
import { notifyFailed } from "../issue-lifecycle.js";
import { notifyTaskFailed } from "../telegram/notify.js";
import { commitAndPush } from "../agents/git-agent.js";
import { checkProtectedRegressions } from "../protected-regressions.js";
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockReturnValue(makeConfig());
  vi.mocked(getRepo).mockReturnValue(makeRepo());
  // Default: no protected lists configured — gate is a no-op
  vi.mocked(checkProtectedRegressions).mockReturnValue({ ran: false, violations: [] });
});

// ---------------------------------------------------------------------------
// Tests: violations detected
// ---------------------------------------------------------------------------

describe("protected regression gate — violations detected", () => {
  const VIOLATION = {
    file: "src/integration/docker.ts",
    reason: "file is marked protected",
  };

  beforeEach(() => {
    vi.mocked(checkProtectedRegressions).mockReturnValue({
      ran: true,
      violations: [VIOLATION],
    });
  });

  it("returns success=false with a 'Protected regression detected:' error", async () => {
    const result = await executeTask("test-repo", "refactor something");

    expect(result.success).toBe(false);
    expect(result.prUrl).toBeNull();
    expect(result.error).toMatch(/^Protected regression detected:/);
  });

  it("includes the formatted violation in the error message", async () => {
    const result = await executeTask("test-repo", "refactor something");

    expect(result.error).toContain("src/integration/docker.ts — file is marked protected");
  });

  it("marks the task as failed in the database", async () => {
    await executeTask("test-repo", "refactor something");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);
    const [, patch] = failedCalls[failedCalls.length - 1];
    expect((patch as any).error).toMatch(/^Protected regression detected:/);
  });

  it("does NOT create a PR", async () => {
    await executeTask("test-repo", "refactor something");

    expect(commitAndPush).not.toHaveBeenCalled();
  });

  it("calls notifyFailed with the issueRef when one is provided", async () => {
    await executeTask("test-repo", "refactor something", { issueRef: "acme/test-repo#7" });

    expect(notifyFailed).toHaveBeenCalledWith(
      "acme/test-repo#7",
      "ym-test-001",
      expect.stringMatching(/^Protected regression detected:/)
    );
  });

  it("does NOT call notifyFailed when no issueRef is provided", async () => {
    await executeTask("test-repo", "refactor something");

    const regressionCalls = vi.mocked(notifyFailed).mock.calls.filter(
      ([, , msg]) => typeof msg === "string" && msg.startsWith("Protected regression detected:")
    );
    expect(regressionCalls).toHaveLength(0);
  });

  it("calls notifyTaskFailed when no issueRef is provided", async () => {
    await executeTask("test-repo", "refactor something");

    expect(notifyTaskFailed).toHaveBeenCalledWith(
      "ym-test-001",
      "test-repo",
      expect.stringMatching(/^Protected regression detected:/)
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: no violations (ran=true)
// ---------------------------------------------------------------------------

describe("protected regression gate — ran=true, no violations", () => {
  beforeEach(() => {
    vi.mocked(checkProtectedRegressions).mockReturnValue({ ran: true, violations: [] });
  });

  it("continues to PR creation", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });

  it("calls updatePipelineStage('protected_check_complete')", async () => {
    await executeTask("test-repo", "add a feature");

    expect(updatePipelineStage).toHaveBeenCalledWith("ym-test-001", "protected_check_complete");
  });

  it("does NOT mark the task failed", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: gate skipped (ran=false)
// ---------------------------------------------------------------------------

describe("protected regression gate — ran=false (no config)", () => {
  it("continues to PR creation without marking protected_check_complete", async () => {
    vi.mocked(checkProtectedRegressions).mockReturnValue({
      ran: false,
      violations: [],
      reason: "no protected files/functions configured",
    });

    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");

    const stageCalls = vi.mocked(updatePipelineStage).mock.calls.filter(
      ([, stage]) => stage === "protected_check_complete"
    );
    expect(stageCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: baseBranch forwarding
// ---------------------------------------------------------------------------

describe("protected regression gate — baseBranch forwarding", () => {
  it("passes baseBranch option through to checkProtectedRegressions", async () => {
    vi.mocked(checkProtectedRegressions).mockReturnValue({ ran: false, violations: [] });

    await executeTask("test-repo", "add a feature", { baseBranch: "release-2.0" });

    expect(checkProtectedRegressions).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test-repo" }),
      "/tmp/worktree",
      "release-2.0"
    );
  });

  it("passes undefined baseBranch when option is omitted", async () => {
    vi.mocked(checkProtectedRegressions).mockReturnValue({ ran: false, violations: [] });

    await executeTask("test-repo", "add a feature");

    expect(checkProtectedRegressions).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test-repo" }),
      "/tmp/worktree",
      undefined
    );
  });
});
