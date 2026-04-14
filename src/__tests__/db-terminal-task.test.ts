/**
 * Tests for getTerminalTaskByRepoAndDescription (src/db.ts).
 *
 * Strategy: mock ../config.js so getDb() creates a real SQLite file in a
 * temporary directory instead of the default ~/code/… data dir.  This lets
 * us exercise the real SQL query without any external services or prod data.
 *
 * The _db singleton in db.ts is created once per vitest module context (each
 * test file runs in isolation).  Tables are cleared between tests via
 * beforeEach.
 */

import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Create a temp directory BEFORE any module imports so the mock factory can
// reference it.
// ---------------------------------------------------------------------------
const testDataDir = mkdtempSync(join(tmpdir(), "ym-db-test-"));

vi.mock("../config.js", () => ({
  loadConfig: () => ({
    repos: [],
    dataDir: testDataDir,
    worktreeBaseDir: join(testDataDir, "worktrees"),
    claudeBinary: "claude",
    defaultModel: "sonnet",
    maxConcurrentAgents: 1,
    timeouts: {
      coder: 600_000,
      reviewer: 300_000,
      gitAgent: 180_000,
      diagnostician: 300_000,
      diagnosticianEscalated: 600_000,
    },
  }),
}));

// Import AFTER the mock is in place.
import { getDb, getTerminalTaskByRepoAndDescription } from "../db.js";

// ---------------------------------------------------------------------------
// Clean up temp files after all tests finish.
// ---------------------------------------------------------------------------
afterAll(() => {
  const dbPath = join(testDataDir, "yardmaster.db");
  if (existsSync(dbPath)) rmSync(dbPath);
  const walPath = dbPath + "-wal";
  if (existsSync(walPath)) rmSync(walPath);
  const shmPath = dbPath + "-shm";
  if (existsSync(shmPath)) rmSync(shmPath);
  try {
    rmdirSync(testDataDir);
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Reset task rows between tests so tests are independent.
// ---------------------------------------------------------------------------
beforeEach(() => {
  getDb().prepare("DELETE FROM tasks").run();
});

// ---------------------------------------------------------------------------
// Helper: insert a task with an explicit status and optional created_at.
// We go directly to SQLite so we can set status without calling updateTask().
// ---------------------------------------------------------------------------
function insertTask(
  id: string,
  repo: string,
  description: string,
  status: string,
  createdAt?: string
): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (id, repo, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))`
    )
    .run(id, repo, description, status, createdAt ?? null);
}

// ---------------------------------------------------------------------------
describe("getTerminalTaskByRepoAndDescription", () => {
  it("returns undefined when no tasks exist", () => {
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeUndefined();
  });

  it("returns undefined when the only matching task is still running", () => {
    insertTask("ym-001", "myrepo", "fix the bug", "running");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeUndefined();
  });

  it("returns undefined when the only matching task is pending", () => {
    insertTask("ym-002", "myrepo", "fix the bug", "pending");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeUndefined();
  });

  it("returns undefined when the only matching task is interrupted", () => {
    insertTask("ym-003", "myrepo", "fix the bug", "interrupted");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeUndefined();
  });

  it("returns the task when status is 'done'", () => {
    insertTask("ym-d01", "myrepo", "fix the bug", "done");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeDefined();
    expect(result!.id).toBe("ym-d01");
    expect(result!.status).toBe("done");
  });

  it("returns the task when status is 'completed'", () => {
    insertTask("ym-c01", "myrepo", "fix the bug", "completed");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeDefined();
    expect(result!.status).toBe("completed");
  });

  it("returns the task when status is 'failed'", () => {
    insertTask("ym-f01", "myrepo", "fix the bug", "failed");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeDefined();
    expect(result!.status).toBe("failed");
  });

  it("returns the task when status is 'partial'", () => {
    insertTask("ym-p01", "myrepo", "fix the bug", "partial");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeDefined();
    expect(result!.status).toBe("partial");
  });

  it("does not match a different repo", () => {
    insertTask("ym-x01", "other-repo", "fix the bug", "completed");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeUndefined();
  });

  it("does not match a different description", () => {
    insertTask("ym-x02", "myrepo", "add a feature", "completed");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toBeUndefined();
  });

  it("returns the most recent terminal task when multiple exist", () => {
    insertTask("ym-old", "myrepo", "fix the bug", "failed",    "2024-01-01 10:00:00");
    insertTask("ym-new", "myrepo", "fix the bug", "completed", "2024-01-02 10:00:00");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result!.id).toBe("ym-new");
  });

  it("ignores non-terminal rows when a terminal one also matches", () => {
    insertTask("ym-run", "myrepo", "fix the bug", "running");
    insertTask("ym-fin", "myrepo", "fix the bug", "completed");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result!.id).toBe("ym-fin");
  });

  it("returns a TaskRow with all expected fields present", () => {
    insertTask("ym-full", "myrepo", "fix the bug", "done");
    const result = getTerminalTaskByRepoAndDescription("myrepo", "fix the bug");
    expect(result).toMatchObject({
      id: "ym-full",
      repo: "myrepo",
      description: "fix the bug",
      status: "done",
    });
    // Optional fields must exist on the row (even if null).
    expect("branch" in result!).toBe(true);
    expect("pr_url" in result!).toBe(true);
    expect("error" in result!).toBe(true);
    expect("created_at" in result!).toBe(true);
    expect("updated_at" in result!).toBe(true);
  });
});
