/**
 * Tests for:
 *  - src/agents/integration-test.ts  (runIntegrationTestAgent)
 *  - src/context/router.ts           (ALL_AGENT_ROLES includes "integration-test",
 *                                     getBudgetForRole("integration-test") === 3072)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that transitively use these modules
// ---------------------------------------------------------------------------

vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

// Mock the prompt builder so agent tests are independent of prompt logic
vi.mock("../prompts/integration-test.js", () => ({
  INTEGRATION_TEST_SYSTEM_PROMPT: "mock-system-prompt",
  buildIntegrationTestPrompt: vi.fn().mockReturnValue("mock-prompt"),
}));

// Mock the DB to prevent SQLite initialisation in the router module
vi.mock("../db.js", () => ({
  getDb: vi.fn(),
  logAgentRun: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  getTask: vi.fn(),
  getRecentTasks: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runAgent } from "../agent-runner.js";
import { buildIntegrationTestPrompt } from "../prompts/integration-test.js";
import { runIntegrationTestAgent } from "../agents/integration-test.js";
import { ALL_AGENT_ROLES, getBudgetForRole } from "../context/router.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: YardmasterConfig = {
  repos: [],
  dataDir: "/tmp/test-data",
  worktreeBaseDir: "/tmp/test-data/worktrees",
  claudeBinary: "claude",
  defaultModel: "sonnet",
  maxConcurrentAgents: 1,
  timeouts: { coder: 60_000, reviewer: 60_000, gitAgent: 60_000, diagnostician: 180_000, diagnosticianEscalated: 300_000 },
};

const REPO: RepoConfig = {
  name: "test-repo",
  localPath: "/repos/test-repo",
  githubOrg: "acme",
  githubRepo: "widget",
  defaultBranch: "main",
};

const DIFF = `diff --git a/src/foo.ts b/src/foo.ts\n+export const x = 1;`;
const WORKTREE = "/data/worktrees/ym-abc123";
const SERVICES = { postgres: "localhost:5432" };
const AUTH = "mock-jwt";

// ---------------------------------------------------------------------------
// router.ts — new "integration-test" role
// ---------------------------------------------------------------------------

describe("ALL_AGENT_ROLES", () => {
  it("includes 'integration-test'", () => {
    expect(ALL_AGENT_ROLES).toContain("integration-test");
  });

  it("still contains all previously existing roles", () => {
    const expectedRoles = ["coder", "style-reviewer", "logic-reviewer", "planner", "tools-agent", "test-quality"];
    for (const role of expectedRoles) {
      expect(ALL_AGENT_ROLES).toContain(role);
    }
  });
});

describe("getBudgetForRole('integration-test')", () => {
  it("returns 3072", () => {
    expect(getBudgetForRole("integration-test")).toBe(3072);
  });
});

// ---------------------------------------------------------------------------
// runIntegrationTestAgent
// ---------------------------------------------------------------------------

describe("runIntegrationTestAgent — failure path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildIntegrationTestPrompt).mockReturnValue("mock-prompt");
  });

  it("returns wrote=false and the error message when runAgent fails with an error string", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: false,
      error: "claude process crashed",
      result: "",
      durationMs: 100,
    });

    const result = await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(result.wrote).toBe(false);
    expect(result.summary).toBe("claude process crashed");
  });

  it("returns fallback message when runAgent fails without an error string", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: false,
      error: undefined,
      result: "",
      durationMs: 100,
    });

    const result = await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(result.wrote).toBe(false);
    expect(result.summary).toBe("Integration test agent failed");
  });
});

describe("runIntegrationTestAgent — NO_INTEGRATION_TESTS_NEEDED sentinel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildIntegrationTestPrompt).mockReturnValue("mock-prompt");
  });

  it("returns wrote=false when result contains the exact sentinel", async () => {
    const sentinel = "NO_INTEGRATION_TESTS_NEEDED";
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: sentinel,
      durationMs: 200,
    });

    const result = await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(result.wrote).toBe(false);
    expect(result.summary).toBe(sentinel);
  });

  it("returns wrote=false when result contains the sentinel with surrounding text", async () => {
    const resultText = "This is a trivial change. NO_INTEGRATION_TESTS_NEEDED";
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: resultText,
      durationMs: 200,
    });

    const result = await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(result.wrote).toBe(false);
    expect(result.summary).toBe(resultText);
  });
});

describe("runIntegrationTestAgent — success path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildIntegrationTestPrompt).mockReturnValue("mock-prompt");
  });

  it("returns wrote=true with the agent summary when tests are written", async () => {
    const summary = "Wrote integration test for auth middleware in src/integration/auth.test.ts";
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: summary,
      durationMs: 5000,
    });

    const result = await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(result.wrote).toBe(true);
    expect(result.summary).toBe(summary);
  });

  it("invokes runAgent with sonnet model and 300s timeout", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "tests written",
      durationMs: 100,
    });

    await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(runAgent).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({
        model: "sonnet",
        timeout: 300_000,
        workingDir: WORKTREE,
      })
    );
  });

  it("invokes runAgent with the expected allowed tools", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "tests written",
      durationMs: 100,
    });

    await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(runAgent).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({
        allowedTools: ["Bash", "Edit", "Read", "Write", "Glob", "Grep"],
      })
    );
  });

  it("passes the built prompt and system prompt to runAgent", async () => {
    vi.mocked(buildIntegrationTestPrompt).mockReturnValue("the-built-prompt");
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "done",
      durationMs: 100,
    });

    await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(runAgent).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({
        prompt: "the-built-prompt",
        systemPrompt: "mock-system-prompt",
      })
    );
  });

  it("calls buildIntegrationTestPrompt with the correct arguments", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "done",
      durationMs: 100,
    });

    await runIntegrationTestAgent(CONFIG, REPO, DIFF, WORKTREE, SERVICES, AUTH);

    expect(buildIntegrationTestPrompt).toHaveBeenCalledWith(
      REPO,
      DIFF,
      WORKTREE,
      SERVICES,
      AUTH
    );
  });
});
