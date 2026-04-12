/**
 * Tests for the check-command fix-attempt loop added to executeTask.
 *
 * After the review loop, if repo.checkCommand is configured and fails, the
 * pipeline now invokes runCoder (up to MAX_CHECK_FIX_ATTEMPTS = 2 times) to
 * fix the errors before giving up. These tests verify:
 *
 *  - When the initial check passes, runCoder is never called.
 *  - When the initial check fails but passes after the 1st fix, the task
 *    succeeds and runCoder is called exactly once.
 *  - When the initial check fails but passes after the 2nd fix, the task
 *    succeeds and runCoder is called exactly twice.
 *  - When all attempts (initial + 2 fixes) fail, the task is marked failed
 *    with an error message that includes "after 2 fix attempts".
 *  - The fix prompt passed to runCoder includes the task description, the
 *    check command name, and a snippet of the check output.
 *  - updatePipelineStage("check_complete") is called only when the check
 *    eventually passes.
 *  - notifyFailed is called with the issueRef when all attempts fail.
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
  runIntegrationPipeline: vi.fn().mockResolvedValue({ ran: false, passed: false, attempts: 0, output: "not configured" }),
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
import { updateTask, updatePipelineStage } from "../db.js";
import { notifyFailed } from "../issue-lifecycle.js";
import { runCoder } from "../agents/coder.js";
import { executeTask } from "../task-runner.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHECK_CMD = "npx tsc --noEmit";
const STDERR_OUTPUT = "src/foo.ts(10,5): error TS2339: Property 'x' does not exist on type 'Foo'";

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

/**
 * Makes the first `failCount` invocations of CHECK_CMD throw, then succeed.
 * Other execSync calls (e.g. git add, git diff) always succeed.
 */
function failCheckCommandFirstN(failCount: number): void {
  let checkCallCount = 0;
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (cmd === CHECK_CMD) {
      checkCallCount++;
      if (checkCallCount <= failCount) {
        const err: any = new Error("Type error");
        err.stderr = Buffer.from(STDERR_OUTPUT);
        throw err;
      }
    }
    return Buffer.from("");
  });
}

/** Makes every invocation of CHECK_CMD throw. */
function alwaysFailCheckCommand(): void {
  failCheckCommandFirstN(Infinity);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockReturnValue(makeConfig());
  vi.mocked(getRepo).mockReturnValue(makeRepo({ checkCommand: CHECK_CMD }));
  vi.mocked(execSync).mockReturnValue(Buffer.from(""));
});

// ---------------------------------------------------------------------------
// Tests: check passes on first attempt
// ---------------------------------------------------------------------------

describe("check-fix loop — initial check passes", () => {
  it("does not call runCoder when the initial check passes", async () => {
    // execSync always succeeds (default mock)
    await executeTask("test-repo", "add a feature");

    expect(runCoder).not.toHaveBeenCalled();
  });

  it("returns a successful result when the initial check passes", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });

  it("marks check_complete when the initial check passes", async () => {
    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(updatePipelineStage)).toHaveBeenCalledWith(
      "ym-test-001",
      "check_complete"
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: check fails then passes after 1st fix
// ---------------------------------------------------------------------------

describe("check-fix loop — check fails, passes after 1st fix attempt", () => {
  beforeEach(() => {
    // 1st check call fails, 2nd succeeds
    failCheckCommandFirstN(1);
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

  it("marks check_complete after the fix succeeds", async () => {
    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(updatePipelineStage)).toHaveBeenCalledWith(
      "ym-test-001",
      "check_complete"
    );
  });

  it("does NOT mark the task failed", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls).toHaveLength(0);
  });

  it("passes a fix prompt to runCoder containing the task description, check command, and error output", async () => {
    const description = "add a feature";
    await executeTask("test-repo", description);

    const [, , promptArg] = vi.mocked(runCoder).mock.calls[0];
    expect(promptArg).toContain(description);
    expect(promptArg).toContain(CHECK_CMD);
    expect(promptArg).toContain(STDERR_OUTPUT);
  });
});

// ---------------------------------------------------------------------------
// Tests: check fails then passes after 2nd fix
// ---------------------------------------------------------------------------

describe("check-fix loop — check fails, passes after 2nd fix attempt", () => {
  beforeEach(() => {
    // 1st and 2nd check calls fail, 3rd succeeds
    failCheckCommandFirstN(2);
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

  it("marks check_complete after the second fix succeeds", async () => {
    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(updatePipelineStage)).toHaveBeenCalledWith(
      "ym-test-001",
      "check_complete"
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: all check attempts fail
// ---------------------------------------------------------------------------

describe("check-fix loop — all check attempts fail", () => {
  beforeEach(() => {
    alwaysFailCheckCommand();
  });

  it("calls runCoder exactly twice (one per fix attempt)", async () => {
    await executeTask("test-repo", "add a feature");

    expect(vi.mocked(runCoder)).toHaveBeenCalledTimes(2);
  });

  it("returns success=false with checkCommand in the error field", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(false);
    expect(result.prUrl).toBeNull();
    expect(result.error).toContain(CHECK_CMD);
  });

  it("marks the task failed with an error message referencing '2 fix attempts'", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);

    const [, patch] = failedCalls[failedCalls.length - 1];
    expect((patch as any).error).toMatch(/after 2 fix attempts/);
  });

  it("truncates the check output in the failure error to 200 chars", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    const [, patch] = failedCalls[failedCalls.length - 1];
    const prefix = "Check failed after 2 fix attempts: ";
    const errorBody = (patch as any).error.slice(prefix.length);
    expect(errorBody.length).toBeLessThanOrEqual(200);
  });

  it("does NOT call updatePipelineStage with 'check_complete'", async () => {
    await executeTask("test-repo", "add a feature");

    const checkCompleteCalls = vi.mocked(updatePipelineStage).mock.calls.filter(
      ([, stage]) => stage === "check_complete"
    );
    expect(checkCompleteCalls).toHaveLength(0);
  });

  it("calls notifyFailed when an issueRef is provided", async () => {
    await executeTask("test-repo", "add a feature", { issueRef: "acme/test-repo#42" });

    const checkFailCalls = vi.mocked(notifyFailed).mock.calls.filter(
      ([, , msg]) => typeof msg === "string" && /after 2 fix attempts/.test(msg)
    );
    expect(checkFailCalls.length).toBeGreaterThanOrEqual(1);
    expect(checkFailCalls[0][0]).toBe("acme/test-repo#42");
    expect(checkFailCalls[0][1]).toBe("ym-test-001");
  });

  it("does NOT call notifyFailed when no issueRef is provided", async () => {
    await executeTask("test-repo", "add a feature");

    const checkFailCalls = vi.mocked(notifyFailed).mock.calls.filter(
      ([, , msg]) => typeof msg === "string" && /after 2 fix attempts/.test(msg)
    );
    expect(checkFailCalls).toHaveLength(0);
  });

  it("does NOT attempt to create a PR after all check attempts fail", async () => {
    const { commitAndPush } = await import("../agents/git-agent.js");
    await executeTask("test-repo", "add a feature");

    expect(commitAndPush).not.toHaveBeenCalled();
  });
});
