/**
 * Tests for the test-quality check-fix loop added to executeTask.
 *
 * After the test-quality agent writes test files, if repo.checkCommand is
 * configured the pipeline now runs the check command to catch type errors in
 * the newly-written tests. If the check fails it invokes runCoder (up to
 * MAX_TQ_FIX_ATTEMPTS = 2 times) to fix the test files. Crucially this loop
 * is SOFT-FAIL: even if all fix attempts are exhausted the task is NOT
 * terminated — execution continues and the existing final-check gate will
 * catch any remaining errors.
 *
 * These tests verify:
 *  - TQ check is skipped when repo.testCommand is not configured.
 *  - TQ check is skipped when the test-quality agent returns wrote=false.
 *  - TQ check is skipped when repo.checkCommand is not configured.
 *  - When TQ check passes immediately, runCoder is not called.
 *  - When TQ check fails once and passes after the 1st fix, runCoder is called
 *    exactly once and the task still succeeds.
 *  - When TQ check fails twice and passes after the 2nd fix, runCoder is called
 *    exactly twice and the task still succeeds.
 *  - When all TQ fix attempts are exhausted the task continues (soft-fail):
 *    runCoder is called exactly twice, the task succeeds, updateTask is NOT
 *    called with status "failed", and notifyFailed is NOT called.
 *  - The fix prompt passed to runCoder includes the task description, the check
 *    command, and a snippet of the check output.
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
  runCoder: vi.fn().mockResolvedValue({ success: true, result: "", durationMs: 0 }),
}));

vi.mock("../agents/test-quality.js", () => ({
  // Default: agent wrote test files — this triggers the TQ check path
  runTestQualityAgent: vi.fn().mockResolvedValue({ summary: "Tests written.", wrote: true }),
}));

vi.mock("../integration/runner.js", () => ({
  runIntegrationTests: vi.fn().mockResolvedValue({ ran: false, passed: false, attempts: 0, output: "not configured" }),
}));

vi.mock("../browser-validation.js", () => ({
  runBrowserValidation: vi.fn().mockResolvedValue({ ran: false, passed: false, output: "not configured" }),
}));

vi.mock("../diagnostician.js", () => ({
  runDiagnosticLoop: vi.fn().mockResolvedValue({ recovered: false, diagnosis: "test", action: "give_up" }),
}));

vi.mock("../agents/git-agent.js", () => ({
  commitAndPush: vi.fn().mockReturnValue({ committed: true, prUrl: "https://github.com/acme/repo/pull/1", error: null }),
}));

vi.mock("../failure-analysis.js", () => ({
  analyzeFailure: vi.fn().mockResolvedValue("unknown"),
}));

vi.mock("../issue-lifecycle.js", () => ({
  notifyStarted: vi.fn(),
  notifyPrCreated: vi.fn(),
  notifyFailed: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { loadConfig, getRepo } from "../config.js";
import { updateTask } from "../db.js";
import { notifyFailed } from "../issue-lifecycle.js";
import { runCoder } from "../agents/coder.js";
import { runTestQualityAgent } from "../agents/test-quality.js";
import { executeTask } from "../task-runner.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHECK_CMD = "npx tsc --noEmit";
const STDERR_OUTPUT = "src/__tests__/foo.test.ts(5,3): error TS2345: Argument of type 'string' is not assignable";
/** Non-empty diff so the TQ agent is invoked (the code gates on diff.length > 0) */
const DIFF_OUTPUT = "diff --git a/src/__tests__/foo.test.ts b/src/__tests__/foo.test.ts\n+it('works', () => { expect(1).toBe(1); });";

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
    testCommand: "npm test",
    checkCommand: CHECK_CMD,
    ...overrides,
  };
}

/**
 * Set up execSync so `git diff --cached` returns a non-empty diff and CHECK_CMD
 * calls are individually controlled via a predicate.
 *
 * @param shouldFail - Called with the 1-based ordinal of each CHECK_CMD invocation.
 *   Return true to make that invocation throw (stderr = STDERR_OUTPUT).
 *   Call #1 is the initial post-review check; call #2 is the TQ check; calls
 *   #3 and #4 are TQ fix checks; call #5 is the final check before PR.
 */
function setupExecSync(shouldFail?: (checkCallNum: number) => boolean): void {
  let checkCallCount = 0;
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (cmd === "git diff --cached") {
      return Buffer.from(DIFF_OUTPUT);
    }
    if (cmd === CHECK_CMD) {
      checkCallCount++;
      if (shouldFail && shouldFail(checkCallCount)) {
        const err: any = new Error("Type error");
        err.stderr = Buffer.from(STDERR_OUTPUT);
        throw err;
      }
    }
    return Buffer.from("");
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockReturnValue(makeConfig());
  vi.mocked(getRepo).mockReturnValue(makeRepo());
  // Re-establish defaults that prior tests may have overridden via mockResolvedValue
  vi.mocked(runTestQualityAgent).mockResolvedValue({ summary: "Tests written.", wrote: true });
  vi.mocked(runCoder).mockResolvedValue({ success: true, result: "", durationMs: 0 });
  // Default: non-empty diff so TQ agent path is reachable
  setupExecSync();
});

// ---------------------------------------------------------------------------
// Tests: TQ check skipped when preconditions are not met
// ---------------------------------------------------------------------------

describe("TQ check-fix loop — skipped when repo.testCommand is not configured", () => {
  it("does not call runTestQualityAgent", async () => {
    vi.mocked(getRepo).mockReturnValue(makeRepo({ testCommand: undefined }));

    await executeTask("test-repo", "add a feature");

    expect(runTestQualityAgent).not.toHaveBeenCalled();
  });

  it("does not call runCoder for TQ fix (task still succeeds)", async () => {
    vi.mocked(getRepo).mockReturnValue(makeRepo({ testCommand: undefined }));

    const result = await executeTask("test-repo", "add a feature");

    expect(vi.mocked(runCoder)).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

describe("TQ check-fix loop — skipped when test-quality agent returns wrote=false", () => {
  it("does not call runCoder when wrote=false", async () => {
    vi.mocked(runTestQualityAgent).mockResolvedValue({ summary: "NO_TESTS_NEEDED", wrote: false });

    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(runCoder)).not.toHaveBeenCalled();
  });

  it("task still succeeds when wrote=false", async () => {
    vi.mocked(runTestQualityAgent).mockResolvedValue({ summary: "NO_TESTS_NEEDED", wrote: false });

    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });
});

describe("TQ check-fix loop — skipped when repo.checkCommand is not configured", () => {
  it("does not invoke the check command via runCoder when checkCommand is absent", async () => {
    vi.mocked(getRepo).mockReturnValue(makeRepo({ checkCommand: undefined }));

    await executeTask("test-repo", "add a feature");

    // runCoder must not have been called for a check-fix purpose
    expect(vi.mocked(runCoder)).not.toHaveBeenCalled();
  });

  it("task still succeeds without a checkCommand", async () => {
    vi.mocked(getRepo).mockReturnValue(makeRepo({ checkCommand: undefined }));

    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });
});

// ---------------------------------------------------------------------------
// Tests: TQ check passes immediately
// ---------------------------------------------------------------------------

describe("TQ check-fix loop — TQ check passes immediately", () => {
  // Default setupExecSync() makes all CHECK_CMD calls pass.

  it("does not call runCoder when TQ check passes on the first try", async () => {
    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(runCoder)).not.toHaveBeenCalled();
  });

  it("returns a successful result", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });
});

// ---------------------------------------------------------------------------
// Tests: TQ check fails once, passes after 1st fix
// ---------------------------------------------------------------------------

describe("TQ check-fix loop — TQ check fails once, passes after 1st fix", () => {
  beforeEach(() => {
    // Call #1 = initial check (pass), call #2 = TQ check (fail), call #3 = fix check (pass)
    setupExecSync((n) => n === 2);
  });

  it("calls runCoder exactly once", async () => {
    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(runCoder)).toHaveBeenCalledTimes(1);
  });

  it("returns success after the fix", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });

  it("does NOT mark the task failed", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls).toHaveLength(0);
  });

  it("passes a fix prompt containing the task description, check command, and error output", async () => {
    const description = "add a feature with tests";
    await executeTask("test-repo", description);

    const [, , promptArg] = vi.mocked(runCoder).mock.calls[0];
    expect(promptArg).toContain(description);
    expect(promptArg).toContain(CHECK_CMD);
    expect(promptArg).toContain(STDERR_OUTPUT.slice(0, 50)); // truncated at 4000 chars in production
  });
});

// ---------------------------------------------------------------------------
// Tests: TQ check fails twice, passes after 2nd fix
// ---------------------------------------------------------------------------

describe("TQ check-fix loop — TQ check fails twice, passes after 2nd fix", () => {
  beforeEach(() => {
    // Call #1 = initial check (pass), calls #2 and #3 fail (TQ check + fix 1),
    // call #4 passes (after fix 2)
    setupExecSync((n) => n === 2 || n === 3);
  });

  it("calls runCoder exactly twice", async () => {
    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(runCoder)).toHaveBeenCalledTimes(2);
  });

  it("returns success after two fixes", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
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
// Tests: all TQ fix attempts exhausted — soft-fail, task continues
// ---------------------------------------------------------------------------

describe("TQ check-fix loop — all fix attempts exhausted (soft-fail)", () => {
  beforeEach(() => {
    // Call #1 = initial check (pass), calls #2/#3/#4 = TQ check + fix checks (all fail),
    // call #5 = final check (pass) — task ultimately succeeds
    setupExecSync((n) => n >= 2 && n <= 4);
  });

  it("calls runCoder exactly twice (one per fix attempt)", async () => {
    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(runCoder)).toHaveBeenCalledTimes(2);
  });

  it("task still SUCCEEDS — the TQ check is soft-fail", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });

  it("does NOT call updateTask with status 'failed' from the TQ path", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls).toHaveLength(0);
  });

  it("does NOT call notifyFailed from the TQ soft-fail path", async () => {
    await executeTask("test-repo", "add a feature", { issueRef: "acme/test-repo#7" });

    // notifyFailed must not have been called for the TQ check exhaustion
    // (it may be called later if the final check fails, but here the final check passes)
    expect(vi.mocked(notifyFailed)).not.toHaveBeenCalled();
  });
});
