/**
 * Tests for src/agents/integration-advisor.ts
 *
 * Covers:
 *  - runIntegrationAdvisor: failure path (with/without error string)
 *  - CONFIG_CREATED sentinel detection (exact and embedded)
 *  - NOT_APPLICABLE sentinel detection (exact and embedded)
 *  - No decision marker → failed outcome with truncated summary
 *  - runAgent invocation parameters (model, timeout, tools, prompts)
 *  - buildIntegrationAdvisorPrompt called with correct arguments
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that transitively use these modules
// ---------------------------------------------------------------------------

vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

// Mock the prompt builder so agent tests are independent of prompt logic
vi.mock("../prompts/integration-advisor.js", () => ({
  INTEGRATION_ADVISOR_SYSTEM_PROMPT: "mock-advisor-system-prompt",
  buildIntegrationAdvisorPrompt: vi.fn().mockReturnValue("mock-advisor-prompt"),
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
import { buildIntegrationAdvisorPrompt } from "../prompts/integration-advisor.js";
import { runIntegrationAdvisor } from "../agents/integration-advisor.js";
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

const WORKTREE = "/data/worktrees/ym-abc123";
const CONFIG_PATH = "/home/user/code/gibson-ops/yardmaster/data/integration/test-repo.yml";
const DESCRIPTION = "add postgres-backed session store";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildIntegrationAdvisorPrompt).mockReturnValue("mock-advisor-prompt");
});

// ---------------------------------------------------------------------------
// Failure path
// ---------------------------------------------------------------------------

describe("runIntegrationAdvisor — failure path", () => {
  it("returns outcome=failed when runAgent reports failure with an error string", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: false,
      error: "claude process timed out",
      result: "",
      durationMs: 100,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("claude process timed out");
  });

  it("returns fallback summary when runAgent fails without an error string", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: false,
      error: undefined,
      result: "",
      durationMs: 100,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("failed");
    expect(result.summary).toBe("Integration advisor agent failed");
  });
});

// ---------------------------------------------------------------------------
// CONFIG_CREATED sentinel
// ---------------------------------------------------------------------------

describe("runIntegrationAdvisor — CONFIG_CREATED sentinel", () => {
  it("returns outcome=config_created when result contains CONFIG_CREATED", async () => {
    const text = "Analyzed repo — it uses postgres and redis. Wrote config file. CONFIG_CREATED";
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: text,
      durationMs: 5000,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("config_created");
    expect(result.summary).toBe(text);
  });

  it("returns outcome=config_created when result is exactly the bare sentinel", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "CONFIG_CREATED",
      durationMs: 100,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("config_created");
  });

  it("CONFIG_CREATED takes priority over NOT_APPLICABLE when both are present", async () => {
    // Edge case: agent emits both markers (malformed output). CONFIG_CREATED checked first.
    const text = "NOT_APPLICABLE: initially thought so, but actually CONFIG_CREATED";
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: text,
      durationMs: 100,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("config_created");
  });
});

// ---------------------------------------------------------------------------
// NOT_APPLICABLE sentinel
// ---------------------------------------------------------------------------

describe("runIntegrationAdvisor — NOT_APPLICABLE sentinel", () => {
  it("returns outcome=not_applicable when result contains NOT_APPLICABLE", async () => {
    const text = "This is a pure CLI utility with no external services. NOT_APPLICABLE: no integration surface";
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: text,
      durationMs: 3000,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("not_applicable");
    expect(result.summary).toBe(text);
  });

  it("returns outcome=not_applicable when result is exactly the bare sentinel", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "NOT_APPLICABLE",
      durationMs: 100,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("not_applicable");
  });
});

// ---------------------------------------------------------------------------
// No decision marker
// ---------------------------------------------------------------------------

describe("runIntegrationAdvisor — no decision marker", () => {
  it("returns outcome=failed when agent returns no known marker", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "I inspected the codebase but could not determine the right course of action.",
      durationMs: 2000,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("failed");
    expect(result.summary).toContain("Advisor returned no decision marker");
  });

  it("truncates long agent output in the failure summary to 200 chars", async () => {
    const longText = "a".repeat(500);
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: longText,
      durationMs: 100,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("failed");
    // The raw text (500 chars) should be truncated — summary must not contain all 500 'a's
    expect(result.summary).not.toContain("a".repeat(201));
  });

  it("returns failed with no-decision message when result is empty string", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "",
      durationMs: 100,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("failed");
    expect(result.summary).toContain("Advisor returned no decision marker");
  });

  it("returns failed when result is undefined (null-coalesced to empty string)", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: undefined as unknown as string,
      durationMs: 100,
    });

    const result = await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(result.outcome).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// runAgent invocation parameters
// ---------------------------------------------------------------------------

describe("runIntegrationAdvisor — runAgent call parameters", () => {
  beforeEach(() => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      error: undefined,
      result: "CONFIG_CREATED",
      durationMs: 100,
    });
  });

  it("invokes runAgent with sonnet model and 180s timeout", async () => {
    await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(runAgent).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({
        model: "sonnet",
        timeout: 180_000,
        workingDir: WORKTREE,
      })
    );
  });

  it("invokes runAgent with the expected allowed tools", async () => {
    await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(runAgent).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({
        allowedTools: ["Bash", "Read", "Write", "Glob", "Grep"],
      })
    );
  });

  it("passes the built prompt and system prompt to runAgent", async () => {
    vi.mocked(buildIntegrationAdvisorPrompt).mockReturnValue("the-built-advisor-prompt");

    await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(runAgent).toHaveBeenCalledWith(
      CONFIG,
      expect.objectContaining({
        prompt: "the-built-advisor-prompt",
        systemPrompt: "mock-advisor-system-prompt",
      })
    );
  });

  it("calls buildIntegrationAdvisorPrompt with repo, worktreePath, configPath, description", async () => {
    await runIntegrationAdvisor(CONFIG, REPO, WORKTREE, CONFIG_PATH, DESCRIPTION);

    expect(buildIntegrationAdvisorPrompt).toHaveBeenCalledWith(
      REPO,
      WORKTREE,
      CONFIG_PATH,
      DESCRIPTION
    );
  });
});
