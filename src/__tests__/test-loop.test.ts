/**
 * Tests for runTestLoop — specifically the verifyTypesAfterTests behaviour added
 * alongside the extractExecOutput refactor.
 *
 * After tests pass (initially or after a coder fix), the loop now calls
 * verifyCheckOrFix to make sure production code still type-checks. Key
 * contracts:
 *
 *  - The returned TestLoopResult.passed is ALWAYS true when tests pass,
 *    even when the subsequent type check fails (soft-fail like TQ).
 *  - verifyCheckOrFix is invoked once every time tests pass.
 *  - When the check fails and verifyCheckOrFix invokes its fixWith callback,
 *    that callback calls runCoder with a prompt containing the description,
 *    the check command, and the error output.
 *  - When repo.checkCommand is absent, verifyCheckOrFix reports skipped=true
 *    and the result is still passed=true.
 *  - When all tests fail after MAX_FIX_ATTEMPTS, the loop returns
 *    passed=false without calling verifyCheckOrFix.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("../agents/coder.js", () => ({
  runCoder: vi.fn().mockResolvedValue({ success: true, result: "", durationMs: 0 }),
}));

vi.mock("../agents/verify-check.js", () => ({
  verifyCheckOrFix: vi.fn().mockResolvedValue({ passed: true, attempts: 0 }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { runCoder } from "../agents/coder.js";
import { verifyCheckOrFix } from "../agents/verify-check.js";
import { runTestLoop } from "../test-loop.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_CMD = "npm test";
const CHECK_CMD = "npx tsc --noEmit";
const STDERR_OUTPUT = "src/foo.ts(3,1): error TS2322: type mismatch";

function makeConfig(): YardmasterConfig {
  return {
    repos: [],
    dataDir: "/tmp/test-data",
    worktreeBaseDir: "/tmp/test-data/worktrees",
    claudeBinary: "claude",
    defaultModel: "sonnet",
    maxConcurrentAgents: 1,
    timeouts: {
      coder: 60_000,
      reviewer: 60_000,
      gitAgent: 60_000,
      diagnostician: 180_000,
      diagnosticianEscalated: 300_000,
    },
  };
}

function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "test-repo",
    localPath: "/tmp/test-repo",
    githubOrg: "acme",
    githubRepo: "test-repo",
    defaultBranch: "main",
    testCommand: TEST_CMD,
    checkCommand: CHECK_CMD,
    ...overrides,
  };
}

/** Make execSync succeed (tests pass) on every call. */
function setupTestsPass(): void {
  vi.mocked(execSync).mockReturnValue(Buffer.from("PASS"));
}

/** Make execSync throw (tests fail) on every call. */
function setupTestsFail(): void {
  vi.mocked(execSync).mockImplementation(() => {
    const err: { message: string; stderr?: Buffer } = new Error("Tests failed");
    (err as any).stderr = Buffer.from(STDERR_OUTPUT);
    throw err;
  });
}

/** Make execSync fail the first N test runs, then pass. */
function setupTestsFailThenPass(failCount: number): void {
  let calls = 0;
  vi.mocked(execSync).mockImplementation(() => {
    calls++;
    if (calls <= failCount) {
      const err: any = new Error("Tests failed");
      err.stderr = Buffer.from(STDERR_OUTPUT);
      throw err;
    }
    return Buffer.from("PASS");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyCheckOrFix).mockResolvedValue({ passed: true, attempts: 0 });
  vi.mocked(runCoder).mockResolvedValue({ success: true, result: "", durationMs: 0 });
});

// ---------------------------------------------------------------------------
// No testCommand configured
// ---------------------------------------------------------------------------

describe("runTestLoop — no testCommand configured", () => {
  it("returns passed=true immediately without running anything", async () => {
    const result = await runTestLoop(
      makeConfig(),
      makeRepo({ testCommand: undefined }),
      "ym-001",
      "/tmp/wt",
      "add a feature",
    );

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(0);
    expect(execSync).not.toHaveBeenCalled();
    expect(verifyCheckOrFix).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests pass immediately — verifyTypesAfterTests is called
// ---------------------------------------------------------------------------

describe("runTestLoop — tests pass immediately", () => {
  beforeEach(() => {
    setupTestsPass();
  });

  it("returns passed=true with attempts=0", async () => {
    const result = await runTestLoop(
      makeConfig(),
      makeRepo(),
      "ym-001",
      "/tmp/wt",
      "add a feature",
    );

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(0);
  });

  it("calls verifyCheckOrFix once after tests pass", async () => {
    await runTestLoop(makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "add a feature");

    expect(verifyCheckOrFix).toHaveBeenCalledTimes(1);
  });

  it("does not call runCoder when check passes", async () => {
    await runTestLoop(makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "add a feature");

    expect(runCoder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests pass but type check fails — still returns passed=true (soft-fail)
// ---------------------------------------------------------------------------

describe("runTestLoop — tests pass but type check fails (soft-fail)", () => {
  beforeEach(() => {
    setupTestsPass();
    // verifyCheckOrFix simulates the check failing after exhausting fix attempts
    vi.mocked(verifyCheckOrFix).mockResolvedValue({
      passed: false,
      attempts: 1,
      output: STDERR_OUTPUT,
    });
  });

  it("returns passed=true even when the type check fails", async () => {
    const result = await runTestLoop(
      makeConfig(),
      makeRepo(),
      "ym-001",
      "/tmp/wt",
      "add a feature",
    );

    expect(result.passed).toBe(true);
  });

  it("returns attempts=0 (the test loop attempt count, not the check attempt count)", async () => {
    const result = await runTestLoop(
      makeConfig(),
      makeRepo(),
      "ym-001",
      "/tmp/wt",
      "add a feature",
    );

    expect(result.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyCheckOrFix receives the correct arguments
// ---------------------------------------------------------------------------

describe("runTestLoop — verifyCheckOrFix arguments", () => {
  beforeEach(() => {
    setupTestsPass();
  });

  it("passes the repo, worktreePath, and 'test-loop' label", async () => {
    const repo = makeRepo();
    const worktreePath = "/tmp/my-worktree";

    await runTestLoop(makeConfig(), repo, "ym-001", worktreePath, "add a feature");

    expect(verifyCheckOrFix).toHaveBeenCalledWith(
      repo,
      worktreePath,
      "test-loop",
      expect.any(Function),
    );
  });

  it("fix callback calls runCoder with a prompt containing description, checkCommand, and error output", async () => {
    const description = "implement the widget";

    // Capture the fixWith callback and call it manually
    let capturedFixWith: ((errorOutput: string) => Promise<void>) | null = null;
    vi.mocked(verifyCheckOrFix).mockImplementation(async (_repo, _wt, _label, fixWith) => {
      capturedFixWith = fixWith;
      return { passed: false, attempts: 1, output: STDERR_OUTPUT };
    });

    await runTestLoop(makeConfig(), makeRepo(), "ym-001", "/tmp/wt", description);

    expect(capturedFixWith).not.toBeNull();
    await capturedFixWith!(STDERR_OUTPUT);

    expect(runCoder).toHaveBeenCalledTimes(1);
    const [, , prompt] = vi.mocked(runCoder).mock.calls[0];
    expect(prompt).toContain(description);
    expect(prompt).toContain(CHECK_CMD);
    expect(prompt).toContain(STDERR_OUTPUT.slice(0, 50));
  });
});

// ---------------------------------------------------------------------------
// Tests fail, then pass after a coder fix — verifyTypesAfterTests still runs
// ---------------------------------------------------------------------------

describe("runTestLoop — tests fail once then pass after coder fix", () => {
  beforeEach(() => {
    setupTestsFailThenPass(1);
  });

  it("calls verifyCheckOrFix after the coder fix makes tests pass", async () => {
    await runTestLoop(makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "add a feature");

    expect(verifyCheckOrFix).toHaveBeenCalledTimes(1);
  });

  it("returns passed=true and attempts=1", async () => {
    const result = await runTestLoop(
      makeConfig(),
      makeRepo(),
      "ym-001",
      "/tmp/wt",
      "add a feature",
    );

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests fail on every attempt — verifyTypesAfterTests is NOT called
// ---------------------------------------------------------------------------

describe("runTestLoop — tests fail on every attempt (MAX_FIX_ATTEMPTS exhausted)", () => {
  beforeEach(() => {
    setupTestsFail();
  });

  it("returns passed=false", async () => {
    const result = await runTestLoop(
      makeConfig(),
      makeRepo(),
      "ym-001",
      "/tmp/wt",
      "add a feature",
    );

    expect(result.passed).toBe(false);
  });

  it("does NOT call verifyCheckOrFix when tests never pass", async () => {
    await runTestLoop(makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "add a feature");

    expect(verifyCheckOrFix).not.toHaveBeenCalled();
  });

  it("returns attempts=2 (MAX_FIX_ATTEMPTS)", async () => {
    const result = await runTestLoop(
      makeConfig(),
      makeRepo(),
      "ym-001",
      "/tmp/wt",
      "add a feature",
    );

    expect(result.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// No checkCommand — verifyCheckOrFix reports skipped, result still passed=true
// ---------------------------------------------------------------------------

describe("runTestLoop — no checkCommand configured", () => {
  beforeEach(() => {
    setupTestsPass();
    vi.mocked(verifyCheckOrFix).mockResolvedValue({
      passed: true,
      attempts: 0,
      skipped: true,
    });
  });

  it("returns passed=true when check is skipped", async () => {
    const result = await runTestLoop(
      makeConfig(),
      makeRepo({ checkCommand: undefined }),
      "ym-001",
      "/tmp/wt",
      "add a feature",
    );

    expect(result.passed).toBe(true);
  });
});
