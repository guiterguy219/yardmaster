import { describe, it, expect } from "vitest";
import {
  buildDiagnosticianPrompt,
  DIAGNOSTICIAN_SYSTEM_PROMPT,
  type DiagnosticContext,
} from "../prompts/diagnostician.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    taskDescription: "Refactor the auth module",
    failureStage: "check_command",
    errorMessage: "TypeScript error: Property 'foo' does not exist on type 'Bar'",
    taskLogs: [],
    repoConfig: {
      name: "myrepo",
      checkCommand: "npx tsc --noEmit",
      testCommand: "npm test",
    },
    worktreePath: "/tmp/worktrees/ym-abc123",
    gitStatus: "M src/auth.ts",
    gitDiffStat: "1 file changed, 10 insertions(+), 3 deletions(-)",
    gitLog: "abc123 fix auth\ndef456 initial commit",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DIAGNOSTICIAN_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof DIAGNOSTICIAN_SYSTEM_PROMPT).toBe("string");
    expect(DIAGNOSTICIAN_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("mentions expected action types", () => {
    expect(DIAGNOSTICIAN_SYSTEM_PROMPT).toContain("retry");
    expect(DIAGNOSTICIAN_SYSTEM_PROMPT).toContain("retry_with_spec");
    expect(DIAGNOSTICIAN_SYSTEM_PROMPT).toContain("create_issue");
    expect(DIAGNOSTICIAN_SYSTEM_PROMPT).toContain("escalate");
    expect(DIAGNOSTICIAN_SYSTEM_PROMPT).toContain("give_up");
  });

  it("instructs returning only JSON", () => {
    expect(DIAGNOSTICIAN_SYSTEM_PROMPT).toContain("Return ONLY a JSON object");
  });
});

describe("buildDiagnosticianPrompt", () => {
  it("includes the task description", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("Refactor the auth module");
  });

  it("includes the failure stage", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("check_command");
  });

  it("includes the error message", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("Property 'foo' does not exist on type 'Bar'");
  });

  it("includes the repo name", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("myrepo");
  });

  it("includes checkCommand and testCommand from repo config", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("npx tsc --noEmit");
    expect(prompt).toContain("npm test");
  });

  it("shows '(none)' for missing checkCommand and testCommand", () => {
    const prompt = buildDiagnosticianPrompt(
      makeContext({ repoConfig: { name: "bare" } })
    );
    expect(prompt).toContain("(none)");
  });

  it("includes the worktree path", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("/tmp/worktrees/ym-abc123");
  });

  it("includes git status output", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("M src/auth.ts");
  });

  it("includes git diff stat output", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("1 file changed, 10 insertions");
  });

  it("includes git log output", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("abc123 fix auth");
  });

  it("shows '(no logs)' when taskLogs is empty", () => {
    const prompt = buildDiagnosticianPrompt(makeContext({ taskLogs: [] }));
    expect(prompt).toContain("(no logs)");
  });

  it("renders task log entries with success marker", () => {
    const prompt = buildDiagnosticianPrompt(
      makeContext({
        taskLogs: [
          { agent: "coder", round: 1, resultSummary: "Made changes to auth.ts", durationMs: 5000, success: 1 },
        ],
      })
    );
    expect(prompt).toContain("coder (round 1)");
    expect(prompt).toContain("✓");
    expect(prompt).toContain("5000ms");
    expect(prompt).toContain("Made changes to auth.ts");
  });

  it("renders task log entries with failure marker", () => {
    const prompt = buildDiagnosticianPrompt(
      makeContext({
        taskLogs: [
          { agent: "style-reviewer", round: 2, resultSummary: "Type errors remain", durationMs: 3000, success: 0 },
        ],
      })
    );
    expect(prompt).toContain("style-reviewer (round 2)");
    expect(prompt).toContain("✗");
  });

  it("truncates long result summaries in log entries to 200 chars", () => {
    const longSummary = "X".repeat(300);
    const prompt = buildDiagnosticianPrompt(
      makeContext({
        taskLogs: [
          { agent: "coder", round: 1, resultSummary: longSummary, durationMs: 1000, success: 1 },
        ],
      })
    );
    // The truncated portion (chars 200+) should not appear
    expect(prompt).not.toContain("X".repeat(201));
    // The first 200 chars should appear
    expect(prompt).toContain("X".repeat(200));
  });

  it("truncates error messages longer than 4000 chars", () => {
    const longError = "E".repeat(4100);
    const prompt = buildDiagnosticianPrompt(makeContext({ errorMessage: longError }));
    // Sentinel after 4000 chars must not appear
    expect(prompt).not.toContain("E".repeat(4001));
    // First 4000 chars must appear
    expect(prompt).toContain("E".repeat(4000));
  });

  describe("prior diagnosis section", () => {
    it("does NOT include prior diagnosis section when not provided", () => {
      const prompt = buildDiagnosticianPrompt(makeContext());
      expect(prompt).not.toContain("Prior Diagnosis");
      expect(prompt).not.toContain("escalated model");
    });

    it("includes prior diagnosis section when provided", () => {
      const prompt = buildDiagnosticianPrompt(
        makeContext({ priorDiagnosis: "Gitignore was blocking file detection" })
      );
      expect(prompt).toContain("Prior Diagnosis");
      expect(prompt).toContain("Gitignore was blocking file detection");
    });

    it("includes escalation notice in prior diagnosis section", () => {
      const prompt = buildDiagnosticianPrompt(
        makeContext({ priorDiagnosis: "some prior analysis" })
      );
      expect(prompt).toContain("escalated model");
    });

    it("prior diagnosis section appears before the closing instruction", () => {
      const prompt = buildDiagnosticianPrompt(
        makeContext({ priorDiagnosis: "previous analysis here" })
      );
      const priorPos = prompt.indexOf("Prior Diagnosis");
      const instructionPos = prompt.indexOf("Investigate the failure");
      expect(priorPos).toBeGreaterThan(-1);
      expect(instructionPos).toBeGreaterThan(-1);
      expect(priorPos).toBeLessThan(instructionPos);
    });
  });

  it("ends with investigation instruction", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt.trimEnd()).toContain("Investigate the failure");
  });

  it("renders multiple log entries in order", () => {
    const prompt = buildDiagnosticianPrompt(
      makeContext({
        taskLogs: [
          { agent: "coder", round: 1, resultSummary: "First change", durationMs: 1000, success: 1 },
          { agent: "style-reviewer", round: 1, resultSummary: "Needs revisions", durationMs: 2000, success: 0 },
          { agent: "coder", round: 2, resultSummary: "Second change", durationMs: 1500, success: 1 },
        ],
      })
    );
    const firstPos = prompt.indexOf("First change");
    const secondPos = prompt.indexOf("Needs revisions");
    const thirdPos = prompt.indexOf("Second change");
    expect(firstPos).toBeLessThan(secondPos);
    expect(secondPos).toBeLessThan(thirdPos);
  });
});
