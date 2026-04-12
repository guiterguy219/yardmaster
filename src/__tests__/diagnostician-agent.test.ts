import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock agent-runner before importing the module under test
// ---------------------------------------------------------------------------
vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from "../agent-runner.js";
import { runDiagnostician } from "../agents/diagnostician.js";
import type { YardmasterConfig } from "../config.js";
import type { DiagnosticContext } from "../prompts/diagnostician.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): YardmasterConfig {
  return {
    repos: [],
    dataDir: "/tmp/data",
    worktreeBaseDir: "/tmp/worktrees",
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

function makeContext(overrides: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    taskDescription: "Fix the login bug",
    failureStage: "review_loop",
    errorMessage: "Review loop ended without convergence",
    taskLogs: [],
    repoConfig: { name: "myrepo" },
    worktreePath: "/tmp/worktrees/ym-abc123",
    gitStatus: "M src/auth.ts",
    gitDiffStat: "1 file changed, 5 insertions(+), 2 deletions(-)",
    gitLog: "abc123 fix auth\ndef456 add tests",
    ...overrides,
  };
}

function agentSuccess(json: object) {
  return { success: true, result: JSON.stringify(json), error: null };
}

function agentFailure(error: string) {
  return { success: false, result: "", error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDiagnostician", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("model and timeout selection", () => {
    it("uses diagnostician timeout for sonnet model", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "ok", category: "unknown", action: { type: "give_up", reason: "test" } })
      );
      const config = makeConfig();
      await runDiagnostician(config, makeContext(), "sonnet");
      expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
        config,
        expect.objectContaining({ model: "sonnet", timeout: 180_000 })
      );
    });

    it("uses diagnosticianEscalated timeout for opus model", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "ok", category: "unknown", action: { type: "give_up", reason: "test" } })
      );
      const config = makeConfig();
      await runDiagnostician(config, makeContext(), "opus");
      expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
        config,
        expect.objectContaining({ model: "opus", timeout: 300_000 })
      );
    });

    it("defaults to sonnet when model is not specified", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "ok", category: "unknown", action: { type: "give_up", reason: "test" } })
      );
      const config = makeConfig();
      await runDiagnostician(config, makeContext());
      expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
        config,
        expect.objectContaining({ model: "sonnet" })
      );
    });
  });

  describe("agent failure handling", () => {
    it("returns give_up when agent fails", async () => {
      vi.mocked(runAgent).mockResolvedValue(agentFailure("timed out"));
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.category).toBe("unknown");
      expect(result.action.type).toBe("give_up");
      expect(result.diagnosis).toContain("Diagnostician failed");
      expect(result.diagnosis).toContain("timed out");
    });

    it("handles undefined error in agent failure", async () => {
      vi.mocked(runAgent).mockResolvedValue({ success: false, result: "", error: undefined as any });
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("give_up");
      expect(result.diagnosis).toContain("Diagnostician failed");
    });
  });

  describe("output parsing — valid JSON", () => {
    it("parses a valid give_up response", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({
          diagnosis: "Unrecoverable type error",
          category: "pipeline_bug",
          action: { type: "give_up", reason: "Cannot be fixed automatically" },
        })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.diagnosis).toBe("Unrecoverable type error");
      expect(result.category).toBe("pipeline_bug");
      expect(result.action).toEqual({ type: "give_up", reason: "Cannot be fixed automatically" });
    });

    it("parses a retry response with fixes array", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({
          diagnosis: "Gitignore issue",
          category: "gitignore",
          action: { type: "retry", fixes: ["Added *.ts to whitelist", "Updated .gitignore"] },
        })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("retry");
      if (result.action.type === "retry") {
        expect(result.action.fixes).toEqual(["Added *.ts to whitelist", "Updated .gitignore"]);
      }
    });

    it("parses a retry_with_spec response", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({
          diagnosis: "Task spec too vague",
          category: "task_spec",
          action: { type: "retry_with_spec", newSpec: "Fix the login form validation in src/auth/login.ts" },
        })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("retry_with_spec");
      if (result.action.type === "retry_with_spec") {
        expect(result.action.newSpec).toBe("Fix the login form validation in src/auth/login.ts");
      }
    });

    it("parses a create_issue response", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({
          diagnosis: "Recurring type error needs human attention",
          category: "pipeline_bug",
          action: { type: "create_issue", title: "TSC fails on auth.ts", body: "Detailed description" },
        })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("create_issue");
      if (result.action.type === "create_issue") {
        expect(result.action.title).toBe("TSC fails on auth.ts");
        expect(result.action.body).toBe("Detailed description");
      }
    });

    it("parses an escalate response", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({
          diagnosis: "Complex environment issue",
          category: "environment",
          action: { type: "escalate", reason: "Need deeper analysis" },
        })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("escalate");
      if (result.action.type === "escalate") {
        expect(result.action.reason).toBe("Need deeper analysis");
      }
    });

    it("parses JSON wrapped in markdown fences", async () => {
      vi.mocked(runAgent).mockResolvedValue({
        success: true,
        result: "```json\n" + JSON.stringify({
          diagnosis: "test",
          category: "unknown",
          action: { type: "give_up", reason: "done" },
        }) + "\n```",
        error: null,
      });
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.diagnosis).toBe("test");
      expect(result.action.type).toBe("give_up");
    });
  });

  describe("output parsing — invalid or edge-case JSON", () => {
    it("returns give_up when output is not valid JSON", async () => {
      vi.mocked(runAgent).mockResolvedValue({
        success: true,
        result: "This is plain text, not JSON.",
        error: null,
      });
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.category).toBe("unknown");
      expect(result.action.type).toBe("give_up");
      if (result.action.type === "give_up") {
        expect(result.action.reason).toContain("not valid JSON");
      }
      // diagnosis should be truncated plain text
      expect(result.diagnosis).toContain("This is plain text");
    });

    it("truncates long plain-text output to 500 chars in diagnosis", async () => {
      const longText = "A".repeat(600);
      vi.mocked(runAgent).mockResolvedValue({ success: true, result: longText, error: null });
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.diagnosis.length).toBeLessThanOrEqual(500);
    });
  });

  describe("category validation", () => {
    it("preserves valid categories", async () => {
      const validCategories = [
        "environment", "gitignore", "task_spec",
        "pipeline_bug", "agent_behavior", "external", "unknown",
      ] as const;

      for (const category of validCategories) {
        vi.mocked(runAgent).mockResolvedValue(
          agentSuccess({ diagnosis: "test", category, action: { type: "give_up", reason: "test" } })
        );
        const result = await runDiagnostician(makeConfig(), makeContext());
        expect(result.category).toBe(category);
      }
    });

    it("falls back to 'unknown' for unrecognized category", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "bogus_category", action: { type: "give_up", reason: "test" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.category).toBe("unknown");
    });

    it("falls back to 'unknown' when category is missing", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", action: { type: "give_up", reason: "test" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.category).toBe("unknown");
    });
  });

  describe("action validation — edge cases", () => {
    it("gives up when action is null", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "unknown", action: null })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("give_up");
      if (result.action.type === "give_up") {
        expect(result.action.reason).toContain("Invalid action");
      }
    });

    it("gives up when action has unknown type", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "unknown", action: { type: "teleport" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("give_up");
      if (result.action.type === "give_up") {
        expect(result.action.reason).toContain("Unknown action type");
      }
    });

    it("retry with non-array fixes defaults to empty array", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "unknown", action: { type: "retry", fixes: "not an array" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("retry");
      if (result.action.type === "retry") {
        expect(result.action.fixes).toEqual([]);
      }
    });

    it("retry_with_spec with non-string newSpec defaults to empty string", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "unknown", action: { type: "retry_with_spec", newSpec: 42 } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("retry_with_spec");
      if (result.action.type === "retry_with_spec") {
        expect(result.action.newSpec).toBe("");
      }
    });

    it("create_issue with missing title defaults to 'Pipeline failure'", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "unknown", action: { type: "create_issue", body: "details" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      if (result.action.type === "create_issue") {
        expect(result.action.title).toBe("Pipeline failure");
      }
    });

    it("create_issue with missing body defaults to 'No details provided'", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "unknown", action: { type: "create_issue", title: "Bug" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      if (result.action.type === "create_issue") {
        expect(result.action.body).toBe("No details provided");
      }
    });

    it("escalate with missing reason defaults to 'Needs deeper analysis'", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "unknown", action: { type: "escalate" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("escalate");
      if (result.action.type === "escalate") {
        expect(result.action.reason).toBe("Needs deeper analysis");
      }
    });

    it("give_up with missing reason defaults to 'Unrecoverable'", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "test", category: "unknown", action: { type: "give_up" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.action.type).toBe("give_up");
      if (result.action.type === "give_up") {
        expect(result.action.reason).toBe("Unrecoverable");
      }
    });

    it("uses 'No diagnosis provided' when diagnosis field is missing", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ category: "unknown", action: { type: "give_up", reason: "test" } })
      );
      const result = await runDiagnostician(makeConfig(), makeContext());
      expect(result.diagnosis).toBe("No diagnosis provided");
    });
  });

  describe("agent invocation", () => {
    it("passes allowed tools including Bash, Read, Glob, Grep", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "ok", category: "unknown", action: { type: "give_up", reason: "done" } })
      );
      await runDiagnostician(makeConfig(), makeContext());
      expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          allowedTools: ["Bash", "Read", "Glob", "Grep"],
        })
      );
    });

    it("uses worktreePath as workingDir", async () => {
      vi.mocked(runAgent).mockResolvedValue(
        agentSuccess({ diagnosis: "ok", category: "unknown", action: { type: "give_up", reason: "done" } })
      );
      const ctx = makeContext({ worktreePath: "/tmp/worktrees/ym-xyz" });
      await runDiagnostician(makeConfig(), ctx);
      expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workingDir: "/tmp/worktrees/ym-xyz" })
      );
    });
  });
});
