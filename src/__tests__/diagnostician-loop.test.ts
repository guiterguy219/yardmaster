import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use these modules
// ---------------------------------------------------------------------------

vi.mock("../agents/diagnostician.js", () => ({
  runDiagnostician: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
    })),
  })),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => "https://github.com/acme/repo/issues/42\n"),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { execSync, execFileSync } from "node:child_process";
import { runDiagnostician } from "../agents/diagnostician.js";
import { runDiagnosticLoop } from "../diagnostician.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";

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

function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "myrepo",
    localPath: "/tmp/myrepo",
    githubOrg: "acme",
    githubRepo: "myrepo",
    defaultBranch: "main",
    checkCommand: "npx tsc --noEmit",
    testCommand: "npm test",
    ...overrides,
  };
}

function diagnosticianResult(
  type: string,
  extra: Record<string, unknown> = {},
  diagnosis = "Test diagnosis",
  category = "unknown"
) {
  return {
    diagnosis,
    category,
    action: { type, ...extra },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDiagnosticLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: execSync returns empty string (git commands succeed)
    vi.mocked(execSync).mockReturnValue("" as any);
  });

  describe("action: retry", () => {
    it("returns recovered: true with action 'retry'", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("retry", { fixes: ["Fixed .gitignore"] }) as any
      );
      const result = await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "Convergence failed", "Fix the bug"
      );
      expect(result.recovered).toBe(true);
      expect(result.action).toBe("retry");
      expect(result.newSpec).toBeUndefined();
    });

    it("preserves diagnosis text", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("retry", { fixes: [] }, "Gitignore blocked output files") as any
      );
      const result = await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err", "desc"
      );
      expect(result.diagnosis).toBe("Gitignore blocked output files");
    });
  });

  describe("action: retry_with_spec", () => {
    it("returns recovered: true with action 'retry_with_spec' and newSpec", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("retry_with_spec", { newSpec: "More specific task description" }) as any
      );
      const result = await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err", "vague task"
      );
      expect(result.recovered).toBe(true);
      expect(result.action).toBe("retry_with_spec");
      expect(result.newSpec).toBe("More specific task description");
    });
  });

  describe("action: give_up", () => {
    it("returns recovered: false with action 'give_up'", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("give_up", { reason: "Unrecoverable state" }) as any
      );
      const result = await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "check_command", "Check failed", "task"
      );
      expect(result.recovered).toBe(false);
      expect(result.action).toBe("give_up");
    });
  });

  describe("action: create_issue", () => {
    it("returns recovered: false and calls gh to create an issue", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("create_issue", { title: "TSC fails", body: "Details here" }) as any
      );
      const result = await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "final_check", "Check failed", "task"
      );
      expect(result.recovered).toBe(false);
      expect(result.action).toBe("create_issue");
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["issue", "create", "--repo", "acme/myrepo", "--title", "TSC fails"]),
        expect.anything()
      );
    });

    it("includes 'Created by Yardmaster diagnostician' in issue body", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("create_issue", { title: "Bug", body: "Root cause analysis" }) as any
      );
      await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "test_loop", "Tests failed", "task"
      );
      const calls = vi.mocked(execFileSync).mock.calls;
      const bodyArg = calls[0][1] as string[];
      const bodyIdx = bodyArg.indexOf("--body");
      const bodyValue = bodyArg[bodyIdx + 1];
      expect(bodyValue).toContain("Root cause analysis");
      expect(bodyValue).toContain("Created by Yardmaster diagnostician");
    });

    it("does not throw when gh command fails", async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error("gh: command not found");
      });
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("create_issue", { title: "Bug", body: "Details" }) as any
      );
      await expect(
        runDiagnosticLoop(makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "check_command", "err", "task")
      ).resolves.not.toThrow();
    });
  });

  describe("escalation logic", () => {
    it("escalates to opus when sonnet returns escalate action", async () => {
      vi.mocked(runDiagnostician)
        .mockResolvedValueOnce(
          diagnosticianResult("escalate", { reason: "Too complex for me" }) as any
        )
        .mockResolvedValueOnce(
          diagnosticianResult("give_up", { reason: "Still unrecoverable" }, "Deeper analysis") as any
        );

      await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err", "task"
      );

      expect(vi.mocked(runDiagnostician)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(runDiagnostician)).toHaveBeenNthCalledWith(
        1, expect.anything(), expect.anything(), "sonnet"
      );
      expect(vi.mocked(runDiagnostician)).toHaveBeenNthCalledWith(
        2, expect.anything(), expect.anything(), "opus"
      );
    });

    it("passes priorDiagnosis to opus when escalating", async () => {
      vi.mocked(runDiagnostician)
        .mockResolvedValueOnce(
          diagnosticianResult("escalate", { reason: "Need deeper look" }, "Sonnet's initial findings") as any
        )
        .mockResolvedValueOnce(
          diagnosticianResult("give_up", { reason: "Giving up" }) as any
        );

      await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err", "task"
      );

      const opusCallContext = vi.mocked(runDiagnostician).mock.calls[1][1];
      expect(opusCallContext.priorDiagnosis).toBe("Sonnet's initial findings");
    });

    it("prevents double escalation — opus escalate falls back to give_up", async () => {
      vi.mocked(runDiagnostician)
        .mockResolvedValueOnce(
          diagnosticianResult("escalate", { reason: "need opus" }) as any
        )
        .mockResolvedValueOnce(
          // opus also tries to escalate
          diagnosticianResult("escalate", { reason: "still need more" }) as any
        );

      const result = await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err", "task"
      );

      // Must not call a third time
      expect(vi.mocked(runDiagnostician)).toHaveBeenCalledTimes(2);
      // Result should be give_up, not escalate
      expect(result.recovered).toBe(false);
      expect(result.action).toBe("give_up");
    });

    it("opus returning retry results in recovered: true", async () => {
      vi.mocked(runDiagnostician)
        .mockResolvedValueOnce(
          diagnosticianResult("escalate", { reason: "need opus" }) as any
        )
        .mockResolvedValueOnce(
          diagnosticianResult("retry", { fixes: ["Applied opus fix"] }) as any
        );

      const result = await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err", "task"
      );

      expect(result.recovered).toBe(true);
      expect(result.action).toBe("retry");
    });

    it("does not escalate when sonnet does not return escalate", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("give_up", { reason: "done" }) as any
      );

      await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err", "task"
      );

      expect(vi.mocked(runDiagnostician)).toHaveBeenCalledTimes(1);
    });
  });

  describe("context gathering", () => {
    it("passes task description to diagnostician context", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("give_up", { reason: "done" }) as any
      );

      await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err msg", "Fix the auth bug"
      );

      const context = vi.mocked(runDiagnostician).mock.calls[0][1];
      expect(context.taskDescription).toBe("Fix the auth bug");
    });

    it("passes failureStage and errorMessage to diagnostician context", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("give_up", { reason: "done" }) as any
      );

      await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "check_command", "TSC type error", "task"
      );

      const context = vi.mocked(runDiagnostician).mock.calls[0][1];
      expect(context.failureStage).toBe("check_command");
      expect(context.errorMessage).toBe("TSC type error");
    });

    it("passes worktreePath to diagnostician context", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("give_up", { reason: "done" }) as any
      );

      await runDiagnosticLoop(
        makeConfig(), makeRepo(), "ym-abc", "/tmp/worktrees/ym-xyz", "review_loop", "err", "task"
      );

      const context = vi.mocked(runDiagnostician).mock.calls[0][1];
      expect(context.worktreePath).toBe("/tmp/worktrees/ym-xyz");
    });

    it("includes repo config name, checkCommand, testCommand in context", async () => {
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("give_up", { reason: "done" }) as any
      );
      const repo = makeRepo({ checkCommand: "tsc", testCommand: "jest" });

      await runDiagnosticLoop(makeConfig(), repo, "ym-abc", "/tmp/wt", "review_loop", "err", "task");

      const context = vi.mocked(runDiagnostician).mock.calls[0][1];
      expect(context.repoConfig.name).toBe("myrepo");
      expect(context.repoConfig.checkCommand).toBe("tsc");
      expect(context.repoConfig.testCommand).toBe("jest");
    });

    it("handles git command failures gracefully (safeExec)", async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("not a git repo");
      });
      vi.mocked(runDiagnostician).mockResolvedValue(
        diagnosticianResult("give_up", { reason: "done" }) as any
      );

      await expect(
        runDiagnosticLoop(makeConfig(), makeRepo(), "ym-abc", "/tmp/wt", "review_loop", "err", "task")
      ).resolves.not.toThrow();

      const context = vi.mocked(runDiagnostician).mock.calls[0][1];
      expect(context.gitStatus).toBe("(command failed)");
      expect(context.gitDiffStat).toBe("(command failed)");
      expect(context.gitLog).toBe("(command failed)");
    });
  });
});
