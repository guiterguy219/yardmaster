import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — real in-memory SQLite with the new telemetry columns.
// Must be hoisted before any module imports that call getDb().
// ---------------------------------------------------------------------------

vi.mock("../db.js", async () => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");

  db.exec(`
    CREATE TABLE IF NOT EXISTS context_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      agent_roles TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      UNIQUE(repo, kind, key)
    );

    CREATE INDEX IF NOT EXISTS idx_context_repo_kind
      ON context_entries(repo, kind);
  `);

  return { getDb: () => db };
});

import { bumpAccess, upsertContext } from "../context-store.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO = "bump-access-unit-repo";

interface AccessRow {
  id: number;
  key: string;
  access_count: number;
  last_accessed_at: string | null;
}

function clearEntries(): void {
  getDb().prepare("DELETE FROM context_entries").run();
}

function getRow(key: string): AccessRow {
  return getDb()
    .prepare(
      "SELECT id, key, access_count, last_accessed_at FROM context_entries WHERE repo = ? AND key = ?"
    )
    .get(REPO, key) as AccessRow;
}

// ---------------------------------------------------------------------------
// Suite: bumpAccess unit tests
// ---------------------------------------------------------------------------

describe("bumpAccess", () => {
  beforeEach(clearEntries);

  // -------------------------------------------------------------------------
  // Empty array — must short-circuit without touching the DB
  // -------------------------------------------------------------------------

  it("returns without error and makes no DB call when ids is empty", () => {
    const db = getDb();
    const prepareSpy = vi.spyOn(db, "prepare");

    bumpAccess([]);

    expect(prepareSpy).not.toHaveBeenCalled();
    prepareSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Single ID — happy path
  // -------------------------------------------------------------------------

  it("increments access_count to 1 and sets last_accessed_at for a single entry", () => {
    upsertContext(REPO, "convention", "single-key", "some content", ["coder"]);
    const { id } = getRow("single-key");

    bumpAccess([id]);

    const after = getRow("single-key");
    expect(after.access_count).toBe(1);
    expect(after.last_accessed_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Multiple IDs — all rows updated in one call
  // -------------------------------------------------------------------------

  it("increments access_count for every ID provided in a single call", () => {
    upsertContext(REPO, "convention", "multi-a", "content a", ["coder"]);
    upsertContext(REPO, "convention", "multi-b", "content b", ["coder"]);

    const idA = getRow("multi-a").id;
    const idB = getRow("multi-b").id;

    bumpAccess([idA, idB]);

    expect(getRow("multi-a").access_count).toBe(1);
    expect(getRow("multi-b").access_count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Accumulation — repeated calls stack up
  // -------------------------------------------------------------------------

  it("accumulates access_count correctly across repeated calls", () => {
    upsertContext(REPO, "convention", "repeat-key", "repeated content", ["coder"]);
    const { id } = getRow("repeat-key");

    bumpAccess([id]);
    bumpAccess([id]);
    bumpAccess([id]);

    expect(getRow("repeat-key").access_count).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Non-existent ID — no error, unrelated rows untouched
  // -------------------------------------------------------------------------

  it("does not throw and leaves real entries untouched when given a non-existent ID", () => {
    upsertContext(REPO, "convention", "real-key", "real content", ["coder"]);

    expect(() => bumpAccess([999_999_999])).not.toThrow();

    // The real entry must be unaffected
    expect(getRow("real-key").access_count).toBe(0);
    expect(getRow("real-key").last_accessed_at).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Fail-open — DB errors are swallowed, never propagated
  // -------------------------------------------------------------------------

  it("swallows a DB error and does not propagate it to the caller", () => {
    const db = getDb();
    const prepareSpy = vi
      .spyOn(db, "prepare")
      .mockImplementation((): never => {
        throw new Error("simulated DB failure");
      });

    // Must not throw even though the underlying DB call throws
    expect(() => bumpAccess([1, 2, 3])).not.toThrow();

    prepareSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Selective update — only the provided IDs are bumped
  // -------------------------------------------------------------------------

  it("only bumps the specified IDs, leaving other entries untouched", () => {
    upsertContext(REPO, "convention", "target-key", "target content", ["coder"]);
    upsertContext(REPO, "convention", "bystander-key", "bystander content", ["coder"]);

    const targetId = getRow("target-key").id;

    bumpAccess([targetId]);

    expect(getRow("target-key").access_count).toBe(1);
    expect(getRow("bystander-key").access_count).toBe(0);
    expect(getRow("bystander-key").last_accessed_at).toBeNull();
  });
});
