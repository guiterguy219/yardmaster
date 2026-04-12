/**
 * Tests for the parallel vs sequential reviewer dispatch logic added in
 * src/review-loop.ts.
 *
 * Key invariants:
 *  - When maxConcurrentAgents >= 2 AND neither reviewer is skipped, both
 *    style and logic reviewers are launched via Promise.all (in parallel).
 *  - When maxConcurrentAgents < 2, reviewers run sequentially even when
 *    both are needed.
 *
 * Parallelism is measured by tracking how many reviewer promises are
 * simultaneously in-flight.  With Promise.all both async functions execute
 * their synchronous prefix (including the in-flight counter increment) before
 * either suspends, so maxInFlight reaches 2.  With sequential calls only one
 * is ever live at a time, so maxInFlight stays at 1.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that touch the modules
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  // git add -A         → void (return value ignored)
  // git diff --cached  → non-empty diff so the empty-diff guard does NOT fire
  // git diff --cached --name-only → list of changed files
  // cat .gitignore     → contents (only reached in empty-diff scenarios)
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === "git diff --cached") return "+ some changes\n";
    if (cmd === "git diff --cached --name-only") return "src/foo.ts\n";
    return "";
  }),
  execFileSync: vi.fn().mockReturnValue("+ some changes\n"),
}));

vi.mock("../db.js", () => ({
  getDb: vi.fn(),
  logAgentRun: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  getTask: vi.fn(),
  getRecentTasks: vi.fn().mockReturnValue([]),
}));

vi.mock("../diff-ledger.js", () => ({
  logReviewRound: vi.fn(),
  getReviewHistory: vi.fn().mockReturnValue([]),
  getReviewSummaries: vi.fn().mockReturnValue([]),
}));

vi.mock("../oscillation.js", () => ({
  detectOscillation: vi.fn().mockReturnValue({ detected: false }),
}));

vi.mock("../alignment-gate.js", () => ({
  checkAlignment: vi.fn().mockResolvedValue({ aligned: true }),
}));

vi.mock("../agents/tools-agent.js", () => ({
  runToolsAgent: vi.fn().mockResolvedValue("NO_ADVICE_NEEDED"),
}));

vi.mock("../agents/planner.js", () => ({
  runPlanner: vi.fn().mockResolvedValue([
    { description: "implement feature", files: [], reason: "" },
  ]),
}));

vi.mock("../agents/coder.js", () => ({
  runCoder: vi.fn().mockResolvedValue({ result: "done", durationMs: 50, success: true }),
}));

vi.mock("../agents/judge.js", () => ({
  runJudge: vi.fn().mockResolvedValue({
    overallVerdict: "ship",
    summary: "looks good",
    decisions: [],
  }),
}));

vi.mock("../agents/style-reviewer.js", () => ({
  runStyleReviewer: vi.fn().mockResolvedValue({
    result: '{"verdict":"approve","issues":[]}',
    durationMs: 10,
    success: true,
  }),
}));

vi.mock("../agents/logic-reviewer.js", () => ({
  runLogicReviewer: vi.fn().mockResolvedValue({
    result: '{"verdict":"approve","issues":[]}',
    durationMs: 10,
    success: true,
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are declared so vitest uses the stubs)
// ---------------------------------------------------------------------------

import { runReviewLoop } from "../review-loop.js";
import { runStyleReviewer } from "../agents/style-reviewer.js";
import { runLogicReviewer } from "../agents/logic-reviewer.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(maxConcurrentAgents: number): YardmasterConfig {
  return {
    repos: [],
    dataDir: "/tmp/test-data",
    worktreeBaseDir: "/tmp/test-data/worktrees",
    claudeBinary: "claude",
    defaultModel: "sonnet",
    maxConcurrentAgents,
    timeouts: { coder: 60_000, reviewer: 60_000, gitAgent: 60_000 },
  };
}

const REPO: RepoConfig = {
  name: "test-repo",
  localPath: "/tmp/test-repo",
  githubOrg: "acme",
  githubRepo: "test-repo",
  defaultBranch: "main",
};

/** Returns a reviewer mock implementation that tracks concurrent in-flight calls. */
function makeConcurrencyTracker(): {
  impl: () => Promise<{ result: string; durationMs: number; success: boolean }>;
  getMaxInFlight: () => number;
} {
  let inFlight = 0;
  let maxInFlight = 0;

  const impl = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Yield — allows all synchronous work queued by Promise.all to run
    // before any of the promises resolve.
    await new Promise<void>((resolve) => setImmediate(resolve));
    inFlight--;
    return { result: '{"verdict":"approve","issues":[]}', durationMs: 10, success: true };
  };

  return { impl, getMaxInFlight: () => maxInFlight };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Reset reviewer mocks to the default approving stub before each test
  vi.mocked(runStyleReviewer).mockResolvedValue({
    result: '{"verdict":"approve","issues":[]}',
    durationMs: 10,
    success: true,
  });
  vi.mocked(runLogicReviewer).mockResolvedValue({
    result: '{"verdict":"approve","issues":[]}',
    durationMs: 10,
    success: true,
  });
});

describe("reviewer dispatch — parallel execution", () => {
  it("runs style and logic reviewers in parallel when maxConcurrentAgents >= 2", async () => {
    const tracker = makeConcurrencyTracker();

    vi.mocked(runStyleReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());
    vi.mocked(runLogicReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());

    await runReviewLoop(makeConfig(2), REPO, "ym-parallel-test", "/worktree", "add feature");

    // Both promises should have been in flight simultaneously
    expect(tracker.getMaxInFlight()).toBe(2);
    expect(runStyleReviewer).toHaveBeenCalledTimes(1);
    expect(runLogicReviewer).toHaveBeenCalledTimes(1);
  });

  it("still calls both reviewers exactly once (parallel path, maxConcurrentAgents = 2)", async () => {
    await runReviewLoop(makeConfig(2), REPO, "ym-parallel-calls", "/worktree", "add feature");

    expect(runStyleReviewer).toHaveBeenCalledTimes(1);
    expect(runLogicReviewer).toHaveBeenCalledTimes(1);
  });
});

describe("reviewer dispatch — sequential execution", () => {
  it("runs style and logic reviewers sequentially when maxConcurrentAgents is 1 (default)", async () => {
    const tracker = makeConcurrencyTracker();

    vi.mocked(runStyleReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());
    vi.mocked(runLogicReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());

    await runReviewLoop(makeConfig(1), REPO, "ym-sequential-test", "/worktree", "add feature");

    // With sequential execution the in-flight count never exceeds 1
    expect(tracker.getMaxInFlight()).toBe(1);
    expect(runStyleReviewer).toHaveBeenCalledTimes(1);
    expect(runLogicReviewer).toHaveBeenCalledTimes(1);
  });

  it("runs style then logic reviewer sequentially when maxConcurrentAgents is 0", async () => {
    const tracker = makeConcurrencyTracker();

    vi.mocked(runStyleReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());
    vi.mocked(runLogicReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());

    await runReviewLoop(makeConfig(0), REPO, "ym-sequential-zero", "/worktree", "add feature");

    expect(tracker.getMaxInFlight()).toBe(1);
  });
});

describe("reviewer dispatch — concurrency boundary", () => {
  it("uses parallel path at the threshold (maxConcurrentAgents === 2)", async () => {
    const tracker = makeConcurrencyTracker();

    vi.mocked(runStyleReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());
    vi.mocked(runLogicReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());

    await runReviewLoop(makeConfig(2), REPO, "ym-boundary-2", "/worktree", "add feature");

    expect(tracker.getMaxInFlight()).toBe(2);
  });

  it("uses sequential path just below the threshold (maxConcurrentAgents === 1)", async () => {
    const tracker = makeConcurrencyTracker();

    vi.mocked(runStyleReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());
    vi.mocked(runLogicReviewer).mockImplementation((_c, _r, _d, _w, _p) => tracker.impl());

    await runReviewLoop(makeConfig(1), REPO, "ym-boundary-1", "/worktree", "add feature");

    expect(tracker.getMaxInFlight()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty-diff guard
// ---------------------------------------------------------------------------
// These tests cover the guard added after Step 2 (get diff) in
// runSubTaskReviewLoop:  when the coder reports success but git diff --cached
// produces an empty (or whitespace-only) string, the loop should bail out
// immediately without calling any reviewers and return converged: false.
// ---------------------------------------------------------------------------

describe("empty-diff guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset reviewer mocks to the default approving stub
    vi.mocked(runStyleReviewer).mockResolvedValue({
      result: '{"verdict":"approve","issues":[]}',
      durationMs: 10,
      success: true,
    });
    vi.mocked(runLogicReviewer).mockResolvedValue({
      result: '{"verdict":"approve","issues":[]}',
      durationMs: 10,
      success: true,
    });
  });

  it("returns converged:false when git diff --cached is empty", async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === "git diff --cached") return "";
      if ((cmd as string).startsWith("cat")) return "node_modules/\ndist/\n";
      return "";
    });

    const result = await runReviewLoop(
      makeConfig(1),
      REPO,
      "ym-empty-diff-test",
      "/worktree",
      "add feature"
    );

    expect(result.converged).toBe(false);
  });

  it("returns converged:false when git diff --cached is whitespace-only", async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === "git diff --cached") return "   \n\t  ";
      if ((cmd as string).startsWith("cat")) return "node_modules/\n";
      return "";
    });

    const result = await runReviewLoop(
      makeConfig(1),
      REPO,
      "ym-whitespace-diff-test",
      "/worktree",
      "add feature"
    );

    expect(result.converged).toBe(false);
  });

  it("does NOT call style or logic reviewers when diff is empty", async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === "git diff --cached") return "";
      return "";
    });

    await runReviewLoop(
      makeConfig(1),
      REPO,
      "ym-empty-diff-no-reviewers",
      "/worktree",
      "add feature"
    );

    expect(runStyleReviewer).not.toHaveBeenCalled();
    expect(runLogicReviewer).not.toHaveBeenCalled();
  });

  it("includes an empty-diff message in reviewSummary", async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === "git diff --cached") return "";
      return "";
    });

    const result = await runReviewLoop(
      makeConfig(1),
      REPO,
      "ym-empty-diff-summary",
      "/worktree",
      "add feature"
    );

    expect(result.converged).toBe(false);
    expect(result.reviewSummary).toMatch(/empty diff/i);
  });

  it("handles missing .gitignore gracefully (no throw)", async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === "git diff --cached") return "";
      // Simulate .gitignore not found by throwing
      if ((cmd as string).startsWith("cat")) {
        throw new Error("cat: .gitignore: No such file or directory");
      }
      return "";
    });

    // Should not throw — the guard catches the error and continues
    await expect(
      runReviewLoop(
        makeConfig(1),
        REPO,
        "ym-no-gitignore",
        "/worktree",
        "add feature"
      )
    ).resolves.toMatchObject({ converged: false });
  });

  it("proceeds normally and calls reviewers when diff is non-empty", async () => {
    // Confirm the guard is bypassed for a non-empty diff
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === "git diff --cached") return "+ some real change\n";
      if (cmd === "git diff --cached --name-only") return "src/foo.ts\n";
      return "";
    });

    await runReviewLoop(
      makeConfig(1),
      REPO,
      "ym-nonempty-diff",
      "/worktree",
      "add feature"
    );

    expect(runStyleReviewer).toHaveBeenCalledTimes(1);
    expect(runLogicReviewer).toHaveBeenCalledTimes(1);
  });
});
