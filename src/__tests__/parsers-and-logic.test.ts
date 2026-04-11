import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — must be declared before any imports that transitively use getDb
// ---------------------------------------------------------------------------

vi.mock("../db.js", async () => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:");
  // Disable FK enforcement so we can insert task_logs / review_rounds without
  // a corresponding tasks row in every test.
  db.pragma("foreign_keys = OFF");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      branch TEXT,
      pr_url TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS capacity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resets_at INTEGER,
      rate_limit_type TEXT,
      is_using_overage INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      prompt_summary TEXT,
      result_summary TEXT,
      duration_ms INTEGER,
      success INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS review_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      agent TEXT NOT NULL,
      verdict TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      diff_text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return {
    getDb: () => db,
    createTask: (repo: string, description: string) => {
      const id = `ym-test-${Date.now().toString(36)}`;
      db.prepare(
        "INSERT INTO tasks (id, repo, description, status) VALUES (?, ?, ?, 'pending')"
      ).run(id, repo, description);
      return id;
    },
    logAgentRun: () => {},
    updateTask: () => {},
    getTask: () => undefined,
    getRecentTasks: () => [],
  };
});

import { parseAgentJson } from "../utils/parse-json.js";
import { checkCapacity, recordCapacityEvent } from "../capacity.js";
import { detectOscillation } from "../oscillation.js";
import { logReviewRound } from "../diff-ledger.js";
import { getDb } from "../db.js";
import { buildAlignmentPrompt } from "../prompts/alignment-gate.js";

// ---------------------------------------------------------------------------
// 0. buildAlignmentPrompt
// ---------------------------------------------------------------------------

describe("buildAlignmentPrompt", () => {
  const TASK = "Add an optional `diff` parameter to the alignment gate";
  const AGENT = "style-reviewer";
  const OUTPUT = JSON.stringify([{ issue: "missing semicolon", severity: "low" }]);

  it("includes task description, agent name, and agent output", () => {
    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT);
    expect(prompt).toContain(TASK);
    expect(prompt).toContain(AGENT);
    expect(prompt).toContain(OUTPUT);
  });

  it("does not include a Code Diff section when diff is omitted", () => {
    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT);
    expect(prompt).not.toContain("## Code Diff");
    expect(prompt).not.toContain("```diff");
  });

  it("does not include a Code Diff section when diff is undefined", () => {
    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT, undefined);
    expect(prompt).not.toContain("## Code Diff");
    expect(prompt).not.toContain("```diff");
  });

  it("does not include a Code Diff section when diff is an empty string", () => {
    // Empty string is falsy — same behaviour as omitting the diff
    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT, "");
    expect(prompt).not.toContain("## Code Diff");
  });

  it("includes a fenced Code Diff section when diff is provided", () => {
    const diff = "- old line\n+ new line\n";
    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT, diff);
    expect(prompt).toContain("## Code Diff (what the coder actually wrote)");
    expect(prompt).toContain("```diff\n" + diff);
    expect(prompt).toContain("```");
  });

  it("includes the Code Diff section before the Agent Output section", () => {
    const diff = "- old\n+ new\n";
    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT, diff);
    const diffPos = prompt.indexOf("## Code Diff");
    const outputPos = prompt.indexOf("## Agent Output");
    expect(diffPos).toBeGreaterThan(-1);
    expect(outputPos).toBeGreaterThan(-1);
    expect(diffPos).toBeLessThan(outputPos);
  });

  it("truncates diffs longer than 4000 characters", () => {
    // Build a diff where the part after 4000 chars contains a unique sentinel
    const filler = "x".repeat(3999); // 3999 x's, preceded by '+' = 4000 chars
    const overflow = "OVERFLOW_SENTINEL";
    const longDiff = "+" + filler + overflow;
    expect(longDiff.length).toBeGreaterThan(4000);

    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT, longDiff);
    // The first 4000 chars of the diff should be present
    expect(prompt).toContain(longDiff.slice(0, 4000));
    // The sentinel that appears only after the 4000-char cutoff must not be present
    expect(prompt).not.toContain(overflow);
  });

  it("does not truncate diffs that are exactly 4000 characters", () => {
    const exactDiff = "+" + "y".repeat(3999); // 4000 chars total
    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT, exactDiff);
    expect(prompt).toContain(exactDiff);
  });

  it("still includes the Agent Output section when diff is provided", () => {
    const diff = "- foo\n+ bar\n";
    const prompt = buildAlignmentPrompt(TASK, AGENT, OUTPUT, diff);
    expect(prompt).toContain("## Agent Output");
    expect(prompt).toContain(OUTPUT);
  });
});

// ---------------------------------------------------------------------------
// 1. parseAgentJson
// ---------------------------------------------------------------------------

describe("parseAgentJson", () => {
  it("parses clean JSON", () => {
    expect(parseAgentJson<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true });
  });

  it("parses fenced JSON with language tag", () => {
    const text = "```json\n{\"verdict\":\"pass\"}\n```";
    expect(parseAgentJson<{ verdict: string }>(text)).toEqual({ verdict: "pass" });
  });

  it("parses fenced JSON without language tag", () => {
    const text = "```\n{\"key\":\"value\"}\n```";
    expect(parseAgentJson<{ key: string }>(text)).toEqual({ key: "value" });
  });

  it("returns null for plain text", () => {
    expect(parseAgentJson("This is not JSON.")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAgentJson("")).toBeNull();
  });

  it("parses whitespace-padded JSON", () => {
    expect(parseAgentJson<{ n: number }>("  { \"n\": 7 }  ")).toEqual({ n: 7 });
  });
});

// ---------------------------------------------------------------------------
// 2. checkCapacity
// ---------------------------------------------------------------------------

describe("checkCapacity", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM capacity_events").run();
    db.prepare("DELETE FROM task_logs").run();
  });

  it("returns canProceed true when there are no capacity events", () => {
    const status = checkCapacity();
    expect(status.canProceed).toBe(true);
    expect(status.isUsingOverage).toBe(false);
  });

  it("returns isUsingOverage true for a recent overage event", () => {
    recordCapacityEvent({
      resetsAt: null,
      rateLimitType: null,
      isUsingOverage: true,
    });
    const status = checkCapacity();
    expect(status.isUsingOverage).toBe(true);
    expect(status.canProceed).toBe(true);
  });

  it("returns canProceed false when 3+ failures occur within 30 minutes", () => {
    // Need at least one capacity event so checkCapacity doesn't short-circuit
    recordCapacityEvent({
      resetsAt: null,
      rateLimitType: null,
      isUsingOverage: false,
    });

    const db = getDb();
    // Insert 3 recent failure rows
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO task_logs (task_id, agent, round, success, created_at)
         VALUES (?, ?, ?, 0, datetime('now'))`
      ).run("task-test", "coder", 1);
    }

    const status = checkCapacity();
    expect(status.canProceed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. detectOscillation
// ---------------------------------------------------------------------------

describe("detectOscillation", () => {
  const TASK_ID = "ym-osc-test";

  afterEach(() => {
    getDb().prepare("DELETE FROM review_rounds WHERE task_id = ?").run(TASK_ID);
  });

  it("returns detected false when there is no review history", () => {
    const result = detectOscillation(TASK_ID, "some diff");
    expect(result.detected).toBe(false);
  });

  it("returns detected false when there is only one prior round", () => {
    logReviewRound(TASK_ID, 1, "style-reviewer", "needs-work", [], "diff from round 1");
    const result = detectOscillation(TASK_ID, "some new diff");
    expect(result.detected).toBe(false);
  });

  it("returns detected false when two rounds have very different diffs", () => {
    logReviewRound(TASK_ID, 1, "style-reviewer", "needs-work", [], "aaaaaaaaaa");
    logReviewRound(TASK_ID, 2, "style-reviewer", "needs-work", [], "bbbbbbbbbb");
    // Current diff is completely different from round 1
    const result = detectOscillation(TASK_ID, "zzzzzzzzzzzzzzzzzzzzzzzzzzz");
    expect(result.detected).toBe(false);
  });

  it("returns detected true when current diff matches round N-2 at 90%+ similarity", () => {
    const baseDiff = "function foo() { return 42; } // some code here";
    // Round 1 diff — this is what we compare against (N-2 when there are 2 rounds)
    logReviewRound(TASK_ID, 1, "style-reviewer", "needs-work", [], baseDiff);
    // Round 2 diff — just needs to exist to make rounds.length === 2
    logReviewRound(TASK_ID, 2, "style-reviewer", "needs-work", [], "completely different content xyz");
    // Current diff is 95%+ similar to round 1
    const nearlyIdentical = baseDiff.replace("42", "43");
    const result = detectOscillation(TASK_ID, nearlyIdentical);
    expect(result.detected).toBe(true);
    expect(result.reason).toMatch(/oscillation detected/);
  });
});
