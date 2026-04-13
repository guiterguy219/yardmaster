/**
 * Tests for the "final check before PR" step added to executeTask in
 * src/task-runner.ts.
 *
 * The final check re-runs repo.checkCommand after browser validation to catch
 * type errors introduced by the test quality agent, integration tests, etc.
 * These tests verify:
 *  - When checkCommand is not configured the final check is skipped.
 *  - When checkCommand is configured and passes, execution continues to PR creation.
 *  - When checkCommand is configured and fails, the task is marked failed and
 *    an error result is returned (with and without an issueRef).
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { loadConfig, getRepo } from "../config.js";
import { updateTask } from "../db.js";
import { notifyFailed } from "../issue-lifecycle.js";
import { executeTask } from "../task-runner.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
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

/** Makes execSync throw on the Nth call matching a given command string. */
function failCheckCommandOnCall(targetCmd: string, failOnCallN: number): void {
  let callCount = 0;
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (cmd === targetCmd) {
      callCount++;
      if (callCount === failOnCallN) {
        const err: any = new Error("Type error: property does not exist");
        err.stderr = Buffer.from("src/foo.ts(10,5): error TS2339: Property 'x' does not exist");
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
  vi.mocked(getRepo).mockReturnValue(makeRepo({ checkCommand: CHECK_CMD }));
  vi.mocked(execSync).mockReturnValue(Buffer.from(""));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("final check before PR — skipped when checkCommand is not configured", () => {
  it("proceeds to PR creation without running a final check", async () => {
    vi.mocked(getRepo).mockReturnValue(makeRepo()); // no checkCommand

    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
    // execSync should NOT have been called with CHECK_CMD at all
    const checkCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) => cmd === CHECK_CMD);
    expect(checkCalls).toHaveLength(0);
  });
});

describe("final check before PR — passes", () => {
  it("returns a successful PR result when the final check passes", async () => {
    // checkCommand configured; execSync always succeeds (default mock)
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/repo/pull/1");
  });

  it("calls execSync with checkCommand twice (initial check + final check)", async () => {
    await executeTask("test-repo", "add a feature");

    const checkCalls = vi.mocked(execSync).mock.calls.filter(([cmd]) => cmd === CHECK_CMD);
    expect(checkCalls).toHaveLength(2);
  });

  it("does NOT mark the task failed when the final check passes", async () => {
    await executeTask("test-repo", "add a feature");

    const failedCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failedCalls).toHaveLength(0);
  });
});

describe("final check before PR — fails", () => {
  beforeEach(() => {
    // The initial check (call #1) passes; the final check (call #2) throws.
    failCheckCommandOnCall(CHECK_CMD, 2);
  });

  it("returns success=false with the checkCommand in the error message", async () => {
    const result = await executeTask("test-repo", "add a feature");

    expect(result.success).toBe(false);
    expect(result.prUrl).toBeNull();
    expect(result.error).toContain("Final check failed");
    expect(result.error).toContain(CHECK_CMD);
  });

  it("updates the task status to 'failed' with a truncated stderr snippet", async () => {
    await executeTask("test-repo", "add a feature");

    const failCalls = vi.mocked(updateTask).mock.calls.filter(
      ([, patch]) => (patch as any).status === "failed"
    );
    expect(failCalls.length).toBeGreaterThanOrEqual(1);

    const [, patch] = failCalls[failCalls.length - 1];
    expect((patch as any).error).toMatch(/^Final check failed:/);
    // Truncated to 200 chars — the full stderr is well under that
    expect((patch as any).error.length).toBeLessThanOrEqual("Final check failed: ".length + 200);
  });

  it("calls notifyFailed when an issueRef is provided", async () => {
    await executeTask("test-repo", "add a feature", { issueRef: "acme/test-repo#42" });

    expect(notifyFailed).toHaveBeenCalledWith(
      "acme/test-repo#42",
      "ym-test-001",
      expect.stringMatching(/^Final check failed:/)
    );
  });

  it("does NOT call notifyFailed when no issueRef is provided", async () => {
    await executeTask("test-repo", "add a feature");

    // notifyFailed must not have been called for a final-check failure
    const finalCheckFailCalls = vi.mocked(notifyFailed).mock.calls.filter(
      ([, , msg]) => typeof msg === "string" && msg.startsWith("Final check failed:")
    );
    expect(finalCheckFailCalls).toHaveLength(0);
  });

  it("does NOT attempt to create a PR after the final check fails", async () => {
    const { commitAndPush } = await import("../agents/git-agent.js");
    await executeTask("test-repo", "add a feature");

    expect(commitAndPush).not.toHaveBeenCalled();
  });
});
