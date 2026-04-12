/**
 * Tests for buildDiagnosticianPrompt (src/prompts/diagnostician.ts).
 *
 * This is a pure function — no mocks needed.
 */

import { describe, it, expect } from "vitest";
import { buildDiagnosticianPrompt, type DiagnosticContext, type TaskLogEntry } from "../prompts/diagnostician.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<DiagnosticContext> = {}): DiagnosticContext {
  return {
    taskDescription: "Add a caching layer to the API",
    failureStage: "check_command",
    error: "src/api.ts(12,3): error TS2339: Property 'x' does not exist",
    taskLogs: [],
    repoName: "myrepo",
    worktreePath: "/tmp/worktrees/ym-abc123",
    gitState: "$ git status --short\nM src/api.ts",
    ...overrides,
  };
}

function makeLogEntry(overrides: Partial<TaskLogEntry> = {}): TaskLogEntry {
  return {
    agent: "coder",
    round: 1,
    prompt_summary: "Task description",
    result_summary: "Added caching layer",
    duration_ms: 4500,
    success: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Core content
// ---------------------------------------------------------------------------

describe("buildDiagnosticianPrompt — core content", () => {
  it("includes task description", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("Add a caching layer to the API");
  });

  it("includes failure stage", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("check_command");
  });

  it("includes error message", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("TS2339: Property 'x' does not exist");
  });

  it("includes repo name", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("name: myrepo");
  });

  it("includes working directory path", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("/tmp/worktrees/ym-abc123");
  });

  it("includes git state", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("M src/api.ts");
  });

  it("ends with the investigation instruction", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).toContain("Investigate the failure and return your diagnosis as JSON.");
  });
});

// ---------------------------------------------------------------------------
// Repo config fields
// ---------------------------------------------------------------------------

describe("buildDiagnosticianPrompt — repo config fields", () => {
  it("includes checkCommand when provided", () => {
    const prompt = buildDiagnosticianPrompt(makeContext({ checkCommand: "npx tsc --noEmit" }));
    expect(prompt).toContain("checkCommand: npx tsc --noEmit");
  });

  it("includes testCommand when provided", () => {
    const prompt = buildDiagnosticianPrompt(makeContext({ testCommand: "npm test" }));
    expect(prompt).toContain("testCommand: npm test");
  });

  it("omits checkCommand section when not provided", () => {
    const prompt = buildDiagnosticianPrompt(makeContext({ checkCommand: undefined }));
    expect(prompt).not.toContain("checkCommand:");
  });

  it("omits testCommand section when not provided", () => {
    const prompt = buildDiagnosticianPrompt(makeContext({ testCommand: undefined }));
    expect(prompt).not.toContain("testCommand:");
  });

  it("includes both checkCommand and testCommand when both are provided", () => {
    const prompt = buildDiagnosticianPrompt(
      makeContext({ checkCommand: "npx tsc --noEmit", testCommand: "npm test" })
    );
    expect(prompt).toContain("checkCommand: npx tsc --noEmit");
    expect(prompt).toContain("testCommand: npm test");
  });
});

// ---------------------------------------------------------------------------
// Task log entries
// ---------------------------------------------------------------------------

describe("buildDiagnosticianPrompt — task log entries", () => {
  it("shows '(no agent runs logged)' when taskLogs is empty", () => {
    const prompt = buildDiagnosticianPrompt(makeContext({ taskLogs: [] }));
    expect(prompt).toContain("(no agent runs logged)");
  });

  it("formats a log entry with agent name, round, success, duration and result summary", () => {
    const log = makeLogEntry({
      agent: "logic-reviewer",
      round: 2,
      success: 0,
      duration_ms: 12000,
      result_summary: "Found critical issue",
    });
    const prompt = buildDiagnosticianPrompt(makeContext({ taskLogs: [log] }));
    expect(prompt).toContain("[logic-reviewer]");
    expect(prompt).toContain("round=2");
    expect(prompt).toContain("success=0");
    expect(prompt).toContain("duration=12000ms");
    expect(prompt).toContain("Found critical issue");
  });

  it("shows '(no summary)' when result_summary is null", () => {
    const log = makeLogEntry({ result_summary: null });
    const prompt = buildDiagnosticianPrompt(makeContext({ taskLogs: [log] }));
    expect(prompt).toContain("(no summary)");
  });

  it("truncates result_summary to 150 characters", () => {
    const longSummary = "A".repeat(200);
    const log = makeLogEntry({ result_summary: longSummary });
    const prompt = buildDiagnosticianPrompt(makeContext({ taskLogs: [log] }));
    // Should contain the first 150 chars
    expect(prompt).toContain("A".repeat(150));
    // Should not contain more than 150 A's in sequence
    expect(prompt).not.toContain("A".repeat(151));
  });

  it("includes multiple log entries", () => {
    const logs = [
      makeLogEntry({ agent: "planner", round: 0 }),
      makeLogEntry({ agent: "coder", round: 1 }),
      makeLogEntry({ agent: "style-reviewer", round: 1 }),
    ];
    const prompt = buildDiagnosticianPrompt(makeContext({ taskLogs: logs }));
    expect(prompt).toContain("[planner]");
    expect(prompt).toContain("[coder]");
    expect(prompt).toContain("[style-reviewer]");
  });
});

// ---------------------------------------------------------------------------
// Error truncation
// ---------------------------------------------------------------------------

describe("buildDiagnosticianPrompt — error truncation", () => {
  it("truncates errors longer than 3000 characters", () => {
    const longError = "E".repeat(3100);
    const prompt = buildDiagnosticianPrompt(makeContext({ error: longError }));
    // First 3000 chars should be present
    expect(prompt).toContain("E".repeat(3000));
    // Characters beyond 3000 should not appear
    expect(prompt).not.toContain("E".repeat(3001));
  });

  it("includes errors that are exactly 3000 characters without truncation", () => {
    const exactError = "F".repeat(3000);
    const prompt = buildDiagnosticianPrompt(makeContext({ error: exactError }));
    expect(prompt).toContain(exactError);
  });
});

// ---------------------------------------------------------------------------
// Prior diagnosis (escalation path)
// ---------------------------------------------------------------------------

describe("buildDiagnosticianPrompt — prior diagnosis", () => {
  it("does not include a Prior Diagnosis section when priorDiagnosis is absent", () => {
    const prompt = buildDiagnosticianPrompt(makeContext());
    expect(prompt).not.toContain("Prior Diagnosis");
  });

  it("includes prior diagnosis section when priorDiagnosis is provided", () => {
    const prompt = buildDiagnosticianPrompt(
      makeContext({ priorDiagnosis: "The git config was missing user.email" })
    );
    expect(prompt).toContain("Prior Diagnosis (from sonnet)");
    expect(prompt).toContain("The git config was missing user.email");
  });

  it("includes the escalation note when priorDiagnosis is provided", () => {
    const prompt = buildDiagnosticianPrompt(
      makeContext({ priorDiagnosis: "Some prior diagnosis" })
    );
    expect(prompt).toContain("The prior diagnostician could not resolve this");
  });
});
