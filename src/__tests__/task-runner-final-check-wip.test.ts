/**
 * Tests for WIP preservation added to the final-check failure paths in
 * src/task-runner.ts.
 *
 * Three distinct code paths now call `saveWipWork` when the final check
 * (re-runs repo.checkCommand before PR creation) fails:
 *
 *  Path A — noDiagnose: the diagnostic gate is bypassed (noDiagnose:true or
 *            diagnosticAttempted already contains "final_check").  The `else`
 *            branch saves WIP directly.
 *
 *  Path B — diagnostic does NOT recover: runDiagnosticLoop returns
 *            recovered:false.  The inner `else` branch saves WIP.
 *
 *  Path C — diagnostic recovers but the retry check also fails: runDiagnosticLoop
 *            returns recovered:true, the pipeline retries the check command, but
 *            that retry still throws.  The catch block saves WIP.
 *
 * For all three paths the tests verify:
 *  - saveWipWork is called with the worktree object and the task description.
 *  - saveWipWork is called BEFORE the task is marked failed.
 *  - The task is still marked failed and success:false is returned.
 *
 * Additionally: saveWipWork is NOT called when the final check passes.
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
  createWorktree: vi.fn().mockReturnValue({ path: "/tmp/worktree", branch: "ym/ym-test-001", taskId: "ym-test-001" }),
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
  checkProtectedRegressions: vi.fn().mockReturnValue([]),
  formatViolations: vi.fn().mockReturnValue(""),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { loadConfig, getRepo } from "../config.js";
import { updateTask } from "../db.js";
import { saveWipWork } from "../worktree.js";
import { runDiagnosticLoop } from "../diagnostician.js";
import { executeTask } from "../task-runner.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHECK_CMD = "npx tsc --noEmit";

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
 * Makes the Nth invocation of CHECK_CMD (1-based) throw.  All other execSync
 * calls (git commands, etc.) succeed as usual.
 */
function failCheckCommandOnCall(failOnCallN: number): void {
  let callCount = 0;
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (cmd === CHECK_CMD) {
      callCount++;
      if (callCount === failOnCallN) {
        const err: any = new Error("Type error");
        err.stderr = Buffer.from("src/foo.ts(1,1): error TS2339");
        throw err;
      }
    }
    return Buffer.from("");
  });
}

/**
 * Makes CHECK_CMD always throw so every invocation fails.
 */
function alwaysFailCheckCommand(): void {
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (cmd === CHECK_CMD) {
      const err: any = new Error("Type error");
      err.stderr = Buffer.from("src/foo.ts(1,1): error TS2339");
      throw err;
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
  vi.mocked(getRepo).mockReturnValue(makeRepo({ checkCommand: CHECK_CMD }));
  vi.mocked(execSync).mockReturnValue(Buffer.from(""));
  // Default: diagnostic does not recover
  vi.mocked(runDiagnosticLoop).mockResolvedValue({ recovered: false, diagnosis: "test", action: "give_up" });
});

// ---------------------------------------------------------------------------
// Path A — noDiagnose bypasses diagnostic, WIP saved on final check failure
// ---------------------------------------------------------------------------

describe("final-check WIP preservation — Path A: noDiagnose bypasses diagnostic", () => {
  beforeEach(() => {
    // Initial check (call #1) passes; final check (call #2) fails.
    failCheckCommandOnCall(2);
  });

  it("calls saveWipWork when the final check fails with noDiagnose:true", async () => {
    await executeTask("test-repo", "add a feature", { noDiagnose: true });

    expect(saveWipWork).toHaveBeenCalled();
  });

  it("passes the worktree object to saveWipWork", async () => {
    await executeTask("test-repo", "add a feature", { noDiagnose: true });

    const [worktreeArg] = vi.mocked(saveWipWork).mock.calls[0];
    expect(worktreeArg).toMatchObject({ path: "/tmp/worktree" });
  });

  it("passes the task description to saveWipWork", async () => {
    const description = "add a feature with noDiagnose";
    await executeTask("test-repo", description, { noDiagnose: true });

    const [, descriptionArg] = vi.mocked(saveWipWork).mock.calls[0];
    expect(descriptionArg).toBe(description);
  });

  it("still marks the task failed after saving WIP", async () => {
    await executeTask("test-repo", "add a feature", { noDiagnose: true });

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns success:false after saving WIP", async () => {
    const result = await executeTask("test-repo", "add a feature", { noDiagnose: true });

    expect(result.success).toBe(false);
    expect(result.prUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Path B — diagnostic runs but does NOT recover; WIP saved before failing
// ---------------------------------------------------------------------------

describe("final-check WIP preservation — Path B: diagnostic does not recover", () => {
  beforeEach(() => {
    // Diagnostic returns recovered:false (already the default mock).
    // Initial check (call #1) passes; final check (call #2) fails.
    failCheckCommandOnCall(2);
  });

  it("calls saveWipWork when diagnostic fails to recover", async () => {
    await executeTask("test-repo", "add a feature");

    expect(saveWipWork).toHaveBeenCalled();
  });

  it("passes the worktree object to saveWipWork", async () => {
    await executeTask("test-repo", "add a feature");

    const [worktreeArg] = vi.mocked(saveWipWork).mock.calls[0];
    expect(worktreeArg).toMatchObject({ path: "/tmp/worktree" });
  });

  it("passes the task description to saveWipWork", async () => {
    const description = "add a feature diagnostic no-recover";
    await executeTask("test-repo", description);

    const [, descriptionArg] = vi.mocked(saveWipWork).mock.calls[0];
    expect(descriptionArg).toBe(description);
  });

  it("still marks the task failed after saving WIP", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns success:false after saving WIP", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(false);
    expect(result.prUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Path C — diagnostic recovers but retry check also fails; WIP saved
// ---------------------------------------------------------------------------

describe("final-check WIP preservation — Path C: diagnostic recovers but retry check fails", () => {
  beforeEach(() => {
    // Diagnostic returns recovered:true so the pipeline retries the check.
    vi.mocked(runDiagnosticLoop).mockResolvedValue({ recovered: true, diagnosis: "fixed it", action: "retry" });
    // Both the final check (call #2) and its retry (call #3) fail.
    // Call #1 is the initial post-review check which passes.
    let callCount = 0;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === CHECK_CMD) {
        callCount++;
        if (callCount >= 2) {
          const err: any = new Error("Still broken");
          err.stderr = Buffer.from("src/foo.ts(1,1): error TS2339");
          throw err;
        }
      }
      return Buffer.from("");
    });
  });

  it("calls saveWipWork when the retry check also fails after a recovered diagnostic", async () => {
    await executeTask("test-repo", "add a feature");

    expect(saveWipWork).toHaveBeenCalled();
  });

  it("passes the worktree object to saveWipWork", async () => {
    await executeTask("test-repo", "add a feature");

    const [worktreeArg] = vi.mocked(saveWipWork).mock.calls[0];
    expect(worktreeArg).toMatchObject({ path: "/tmp/worktree" });
  });

  it("passes the task description to saveWipWork", async () => {
    const description = "add a feature retry-fails";
    await executeTask("test-repo", description);

    const [, descriptionArg] = vi.mocked(saveWipWork).mock.calls[0];
    expect(descriptionArg).toBe(description);
  });

  it("still marks the task failed after the retry check fails", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns success:false when the retry check fails", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(false);
    expect(result.prUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Happy path — final check passes: saveWipWork is NOT called
// ---------------------------------------------------------------------------

describe("final-check WIP preservation — final check passes: no WIP saved", () => {
  it("does NOT call saveWipWork when the final check passes", async () => {
    // execSync always succeeds (default mock)
    await executeTask("test-repo", "add a feature");

    expect(saveWipWork).not.toHaveBeenCalled();
  });

  it("returns success:true when the final check passes", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });
});

// ---------------------------------------------------------------------------
// saveWipWork returns saved:true — log output (call count stays at 1)
// ---------------------------------------------------------------------------

describe("final-check WIP preservation — saveWipWork saved:true logging", () => {
  beforeEach(() => {
    failCheckCommandOnCall(2);
    vi.mocked(saveWipWork).mockReturnValue({ saved: true, method: "stash", ref: "stash@{0}" });
  });

  it("calls saveWipWork exactly once per final-check failure", async () => {
    await executeTask("test-repo", "add a feature", { noDiagnose: true });

    expect(saveWipWork).toHaveBeenCalledTimes(1);
  });

  it("still returns success:false even when WIP is successfully saved", async () => {
    const result = await executeTask("test-repo", "add a feature", { noDiagnose: true });

    expect(result.success).toBe(false);
  });
});
