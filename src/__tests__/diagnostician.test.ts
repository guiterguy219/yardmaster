/**
 * Tests for:
 *   - src/agents/diagnostician.ts — runDiagnostician (output parsing, timeout selection)
 *   - src/diagnostician.ts — runDiagnosticLoop (action routing: retry, retry_with_spec,
 *     give_up, create_issue, escalate)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vitest hoists them
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from("")),
}));

vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../db.js", () => ({
  logAgentRun: vi.fn(),
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { runAgent } from "../agent-runner.js";
import { logAgentRun, getDb } from "../db.js";
import { runDiagnostician } from "../agents/diagnostician.js";
import { runDiagnosticLoop } from "../diagnostician.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";
import type { DiagnosticContext } from "../prompts/diagnostician.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<YardmasterConfig["timeouts"]> = {}): YardmasterConfig {
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
      ...overrides,
    },
  };
}

function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "myrepo",
    localPath: "/tmp/myrepo",
    githubOrg: "acme",
    githubRepo: "myrepo",
    defaultBranch: "main",
    ...overrides,
  };
}

function makeAgentSuccess(resultJson: object) {
  return {
    success: true,
    result: JSON.stringify(resultJson),
    durationMs: 1234,
    error: undefined,
  };
}

function makeAgentFailure(errorMessage = "claude exited non-zero") {
  return {
    success: false,
    result: "",
    durationMs: 500,
    error: errorMessage,
  };
}

function makeContext(overrides: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    taskDescription: "Fix the login bug",
    failureStage: "check_command",
    error: "tsc: error TS2339",
    taskLogs: [],
    repoName: "myrepo",
    worktreePath: "/tmp/worktrees/ym-test",
    gitState: "$ git status --short\nM src/auth.ts",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default: git commands in gatherContext succeed with empty output
  vi.mocked(execSync).mockReturnValue(Buffer.from(""));

  // Default db mock: returns empty task logs
  vi.mocked(getDb).mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    }),
  } as any);
});

// ===========================================================================
// runDiagnostician — output parsing
// ===========================================================================

describe("runDiagnostician — output parsing", () => {
  it("returns a valid result when agent outputs well-formed JSON", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Missing git user.email config",
        category: "environment",
        action: { type: "retry", fixes: ["Set git user.email"] },
      })
    );

    const result = await runDiagnostician(makeConfig(), "ym-001", makeContext());
    expect(result.diagnosis).toBe("Missing git user.email config");
    expect(result.category).toBe("environment");
    expect(result.action.type).toBe("retry");
  });

  it("returns give_up when agent output is not valid JSON", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      success: true,
      result: "I cannot determine the issue from the information provided.",
      durationMs: 800,
      error: undefined,
    });

    const result = await runDiagnostician(makeConfig(), "ym-001", makeContext());
    expect(result.action.type).toBe("give_up");
    if (result.action.type === "give_up") {
      expect(result.action.reason).toMatch(/not valid JSON/i);
    }
    expect(result.category).toBe("unknown");
  });

  it("returns give_up when agent run fails", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeAgentFailure("timeout after 180s"));

    const result = await runDiagnostician(makeConfig(), "ym-001", makeContext());
    expect(result.action.type).toBe("give_up");
    if (result.action.type === "give_up") {
      expect(result.action.reason).toContain("timeout after 180s");
    }
    expect(result.category).toBe("unknown");
  });

  it("normalizes an unrecognized category to 'unknown'", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Some diagnosis",
        category: "totally_made_up",
        action: { type: "give_up", reason: "can't fix" },
      })
    );

    const result = await runDiagnostician(makeConfig(), "ym-001", makeContext());
    expect(result.category).toBe("unknown");
  });

  it("returns give_up when action type is invalid", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Some diagnosis",
        category: "environment",
        action: { type: "do_something_else" },
      })
    );

    const result = await runDiagnostician(makeConfig(), "ym-001", makeContext());
    expect(result.action.type).toBe("give_up");
    if (result.action.type === "give_up") {
      expect(result.action.reason).toMatch(/invalid action type/i);
    }
  });

  it("preserves all valid action types without modification", async () => {
    const actions = [
      { type: "retry", fixes: ["fix 1"] },
      { type: "retry_with_spec", newSpec: "new spec" },
      { type: "create_issue", title: "Issue title", body: "Issue body" },
      { type: "escalate", reason: "need opus" },
      { type: "give_up", reason: "unrecoverable" },
    ];

    for (const action of actions) {
      vi.mocked(runAgent).mockResolvedValue(
        makeAgentSuccess({ diagnosis: "d", category: "unknown", action })
      );
      const result = await runDiagnostician(makeConfig(), "ym-001", makeContext());
      expect(result.action.type).toBe(action.type);
    }
  });

  it("logs the agent run after success", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "d",
        category: "environment",
        action: { type: "give_up", reason: "r" },
      })
    );

    await runDiagnostician(makeConfig(), "ym-abc", makeContext({ failureStage: "test_loop" }));

    expect(logAgentRun).toHaveBeenCalledWith(
      "ym-abc",
      "diagnostician-sonnet",
      0,
      "stage=test_loop",
      expect.any(String),
      expect.any(Number),
      true
    );
  });

  it("logs the agent run after failure", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeAgentFailure("agent crashed"));

    await runDiagnostician(makeConfig(), "ym-xyz", makeContext());

    expect(logAgentRun).toHaveBeenCalledWith(
      "ym-xyz",
      "diagnostician-sonnet",
      0,
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      false
    );
  });
});

// ===========================================================================
// runDiagnostician — timeout selection
// ===========================================================================

describe("runDiagnostician — timeout selection", () => {
  it("uses config.timeouts.diagnostician for the sonnet model", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({ diagnosis: "d", category: "unknown", action: { type: "give_up", reason: "r" } })
    );

    const config = makeConfig({ diagnostician: 111_000, diagnosticianEscalated: 999_000 });
    await runDiagnostician(config, "ym-001", makeContext(), "sonnet");

    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ timeout: 111_000, model: "sonnet" })
    );
  });

  it("uses config.timeouts.diagnosticianEscalated for the opus model", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({ diagnosis: "d", category: "unknown", action: { type: "give_up", reason: "r" } })
    );

    const config = makeConfig({ diagnostician: 111_000, diagnosticianEscalated: 999_000 });
    await runDiagnostician(config, "ym-001", makeContext(), "opus");

    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ timeout: 999_000, model: "opus" })
    );
  });
});

// ===========================================================================
// runDiagnosticLoop — action routing
// ===========================================================================

describe("runDiagnosticLoop — retry action", () => {
  it("returns recovered=true when diagnostician recommends retry", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Missing git user.email",
        category: "environment",
        action: { type: "retry", fixes: ["git config user.email ci@example.com"] },
      })
    );

    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "check_command", "tsc error", "Fix auth"
    );

    expect(result.recovered).toBe(true);
    expect(result.actionTaken).toContain("retry");
    expect(result.actionTaken).toContain("git config user.email ci@example.com");
  });

  it("returns the diagnosis text from the diagnostician", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Git identity was not configured",
        category: "environment",
        action: { type: "retry", fixes: ["configured git user"] },
      })
    );

    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "check_command", "error", "desc"
    );

    expect(result.diagnosis).toBe("Git identity was not configured");
    expect(result.category).toBe("environment");
  });
});

describe("runDiagnosticLoop — retry_with_spec action", () => {
  it("returns recovered=true with newSpec when diagnostician rewrites the spec", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Task description was too vague",
        category: "task_spec",
        action: { type: "retry_with_spec", newSpec: "Add a rate limiter to POST /api/login" },
      })
    );

    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "review_loop", "no convergence", "Add something"
    );

    expect(result.recovered).toBe(true);
    expect(result.newSpec).toBe("Add a rate limiter to POST /api/login");
    expect(result.actionTaken).toBe("retry_with_spec");
  });
});

describe("runDiagnosticLoop — give_up action", () => {
  it("returns recovered=false when diagnostician gives up", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Unknown root cause",
        category: "unknown",
        action: { type: "give_up", reason: "cannot determine issue" },
      })
    );

    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "test_loop", "tests failed", "desc"
    );

    expect(result.recovered).toBe(false);
    expect(result.actionTaken).toContain("give_up");
    expect(result.actionTaken).toContain("cannot determine issue");
  });
});

describe("runDiagnosticLoop — create_issue action", () => {
  it("returns recovered=false when diagnostician creates an issue", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Recurring type error after test agent runs",
        category: "pipeline_bug",
        action: {
          type: "create_issue",
          title: "Recurring TS error in test quality agent",
          body: "## Diagnosis\n\nThe test quality agent introduces type errors.",
        },
      })
    );

    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "final_check", "tsc error", "desc"
    );

    expect(result.recovered).toBe(false);
    expect(result.actionTaken).toContain("create_issue");
    expect(result.actionTaken).toContain("Recurring TS error in test quality agent");
  });

  it("calls gh issue create with the provided title and body", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Pipeline bug",
        category: "pipeline_bug",
        action: {
          type: "create_issue",
          title: "Pipeline fails on empty diff",
          body: "Detailed body here",
        },
      })
    );

    await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "final_check", "error", "desc"
    );

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("gh issue create"),
      expect.any(Object)
    );
    const call = vi.mocked(execSync).mock.calls.find(([cmd]) =>
      typeof cmd === "string" && cmd.includes("gh issue create")
    );
    expect(call?.[0]).toContain("Pipeline fails on empty diff");
  });

  it("does not throw when gh issue create fails", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Some bug",
        category: "pipeline_bug",
        action: {
          type: "create_issue",
          title: "My issue",
          body: "body",
        },
      })
    );

    // gh issue create fails
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("gh issue create")) {
        throw new Error("gh: not authenticated");
      }
      return Buffer.from("");
    });

    // Should not throw — create_issue failure is best-effort
    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "final_check", "error", "desc"
    );

    expect(result.recovered).toBe(false);
  });

  it("uses yardmaster repo for gh issue create when 'yardmaster' repo is in config", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "Bug",
        category: "pipeline_bug",
        action: { type: "create_issue", title: "Bug title", body: "Bug body" },
      })
    );

    const config = makeConfig();
    config.repos = [
      { name: "yardmaster", localPath: "/tmp/ym", githubOrg: "gibson-ops", githubRepo: "yardmaster", defaultBranch: "main" },
    ];

    await runDiagnosticLoop(
      config, makeRepo(), "ym-001", "/tmp/wt", "final_check", "error", "desc"
    );

    const call = vi.mocked(execSync).mock.calls.find(([cmd]) =>
      typeof cmd === "string" && cmd.includes("gh issue create")
    );
    expect(call?.[0]).toContain("gibson-ops/yardmaster");
  });
});

describe("runDiagnosticLoop — escalate action", () => {
  it("calls runDiagnostician with opus when sonnet escalates", async () => {
    vi.mocked(runAgent)
      // First call: sonnet recommends escalate
      .mockResolvedValueOnce(
        makeAgentSuccess({
          diagnosis: "Complex pipeline interaction — need deeper analysis",
          category: "pipeline_bug",
          action: { type: "escalate", reason: "Requires analysis of yardmaster internals" },
        })
      )
      // Second call: opus recommends give_up
      .mockResolvedValueOnce(
        makeAgentSuccess({
          diagnosis: "The bug is in the review loop convergence logic",
          category: "pipeline_bug",
          action: { type: "give_up", reason: "Cannot auto-fix pipeline code" },
        })
      );

    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "review_loop", "error", "desc"
    );

    // Two calls total: first with sonnet, then with opus
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);

    // Second call should use opus model
    const secondCall = vi.mocked(runAgent).mock.calls[1];
    expect(secondCall[1]).toMatchObject({ model: "opus" });

    expect(result.recovered).toBe(false);
  });

  it("returns the opus result when escalation succeeds with retry", async () => {
    vi.mocked(runAgent)
      .mockResolvedValueOnce(
        makeAgentSuccess({
          diagnosis: "Need opus analysis",
          category: "environment",
          action: { type: "escalate", reason: "complex" },
        })
      )
      .mockResolvedValueOnce(
        makeAgentSuccess({
          diagnosis: "Found and fixed the issue",
          category: "environment",
          action: { type: "retry", fixes: ["Applied opus fix"] },
        })
      );

    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "check_command", "error", "desc"
    );

    expect(result.recovered).toBe(true);
    expect(result.actionTaken).toContain("Applied opus fix");
  });

  it("creates an issue instead of re-escalating when already escalated", async () => {
    vi.mocked(runAgent)
      // sonnet → escalate
      .mockResolvedValueOnce(
        makeAgentSuccess({
          diagnosis: "Need deeper analysis",
          category: "unknown",
          action: { type: "escalate", reason: "first escalation" },
        })
      )
      // opus → also escalate (should not recurse further)
      .mockResolvedValueOnce(
        makeAgentSuccess({
          diagnosis: "Still confused",
          category: "unknown",
          action: { type: "escalate", reason: "second escalation" },
        })
      );

    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "test_loop", "error", "desc"
    );

    // Should have called runAgent exactly twice (sonnet + opus), then stopped
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    // Should not be recovered — fell back to create_issue
    expect(result.recovered).toBe(false);
    expect(result.actionTaken).toContain("create_issue");
  });
});

// ===========================================================================
// runDiagnosticLoop — context gathering
// ===========================================================================

describe("runDiagnosticLoop — context gathering", () => {
  it("queries task logs from the database with the correct task ID", async () => {
    const mockAll = vi.fn().mockReturnValue([]);
    const mockPrepare = vi.fn().mockReturnValue({ all: mockAll });
    vi.mocked(getDb).mockReturnValue({ prepare: mockPrepare } as any);

    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "d",
        category: "unknown",
        action: { type: "give_up", reason: "r" },
      })
    );

    await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-task-42", "/tmp/wt", "test_loop", "error", "desc"
    );

    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("task_logs"));
    expect(mockAll).toHaveBeenCalledWith("ym-task-42");
  });

  it("uses '(could not retrieve git state)' when git commands fail", async () => {
    // All execSync calls throw (simulates git not available)
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not a git repo");
    });

    vi.mocked(runAgent).mockResolvedValue(
      makeAgentSuccess({
        diagnosis: "d",
        category: "unknown",
        action: { type: "give_up", reason: "r" },
      })
    );

    // Should not throw
    const result = await runDiagnosticLoop(
      makeConfig(), makeRepo(), "ym-001", "/tmp/wt", "check_command", "error", "desc"
    );

    // Verify the prompt passed to runAgent reflects the fallback
    const promptArg = vi.mocked(runAgent).mock.calls[0][1].prompt;
    expect(promptArg).toContain("(could not retrieve git state)");
    expect(result).toBeDefined();
  });
});
