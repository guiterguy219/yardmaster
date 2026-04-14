import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — real in-memory SQLite, must be hoisted before any module imports
// that transitively call getDb().
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

import { upsertContext } from "../context-store.js";
import { getContextForAgent } from "../context/router.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO = "telemetry-test-repo";

interface AccessRow {
  id: number;
  key: string;
  access_count: number;
  last_accessed_at: string | null;
}

function clearEntries() {
  getDb().prepare("DELETE FROM context_entries").run();
}

function getAccessInfo(key: string): AccessRow {
  return getDb()
    .prepare("SELECT id, key, access_count, last_accessed_at FROM context_entries WHERE repo = ? AND key = ?")
    .get(REPO, key) as AccessRow;
}

// ---------------------------------------------------------------------------
// Suite: access telemetry via getContextForAgent
// ---------------------------------------------------------------------------

describe("context access telemetry", () => {
  beforeEach(clearEntries);

  it("packed entries have access_count = 1 and non-null last_accessed_at after one call", () => {
    upsertContext(REPO, "convention", "conv-a", "Convention A content", ["coder"]);
    upsertContext(REPO, "convention", "conv-b", "Convention B content", ["coder"]);

    getContextForAgent("coder", REPO);

    const a = getAccessInfo("conv-a");
    const b = getAccessInfo("conv-b");
    expect(a.access_count).toBe(1);
    expect(a.last_accessed_at).not.toBeNull();
    expect(b.access_count).toBe(1);
    expect(b.last_accessed_at).not.toBeNull();
  });

  it("entries filtered out by role have access_count = 0", () => {
    upsertContext(REPO, "convention", "coder-only", "Coder convention", ["coder"]);
    upsertContext(REPO, "convention", "planner-only", "Planner convention", ["planner"]);

    getContextForAgent("coder", REPO);

    const coder = getAccessInfo("coder-only");
    const planner = getAccessInfo("planner-only");
    expect(coder.access_count).toBe(1);
    expect(planner.access_count).toBe(0);
    expect(planner.last_accessed_at).toBeNull();
  });

  it("entries filtered out by budget have access_count = 0", () => {
    // Insert a large entry that fills the tools-agent budget (1024 chars)
    upsertContext(REPO, "convention", "big-entry", "x".repeat(2000), ["tools-agent"]);
    upsertContext(REPO, "convention", "small-entry", "tiny content", ["tools-agent"]);

    getContextForAgent("tools-agent", REPO);

    // big-entry should be packed (possibly truncated), small-entry should be excluded by budget
    const big = getAccessInfo("big-entry");
    const small = getAccessInfo("small-entry");
    expect(big.access_count).toBe(1);
    expect(small.access_count).toBe(0);
  });

  it("calling getContextForAgent twice yields access_count = 2", () => {
    upsertContext(REPO, "convention", "double-access", "Some convention", ["coder"]);

    getContextForAgent("coder", REPO);
    getContextForAgent("coder", REPO);

    const row = getAccessInfo("double-access");
    expect(row.access_count).toBe(2);
  });

  it("migration adds access_count and last_accessed_at columns to existing table", async () => {
    // Create a fresh in-memory DB without the new columns
    const Database = (await import("better-sqlite3")).default;
    const freshDb = new Database(":memory:");
    freshDb.exec(`
      CREATE TABLE context_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        agent_roles TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(repo, kind, key)
      );
    `);

    // Insert a row before migration
    freshDb
      .prepare(
        "INSERT INTO context_entries (repo, kind, key, content, content_hash, agent_roles) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("r", "convention", "k", "c", "h", "[]");

    // Verify columns don't exist yet
    const colsBefore = freshDb.prepare("PRAGMA table_info(context_entries)").all() as Array<{ name: string }>;
    const namesBefore = new Set(colsBefore.map((c) => c.name));
    expect(namesBefore.has("access_count")).toBe(false);
    expect(namesBefore.has("last_accessed_at")).toBe(false);

    // Run the same migration logic as db.ts migrateContextStore
    if (!namesBefore.has("access_count")) {
      freshDb.exec("ALTER TABLE context_entries ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!namesBefore.has("last_accessed_at")) {
      freshDb.exec("ALTER TABLE context_entries ADD COLUMN last_accessed_at TEXT");
    }

    // Verify columns now exist
    const colsAfter = freshDb.prepare("PRAGMA table_info(context_entries)").all() as Array<{ name: string }>;
    const namesAfter = new Set(colsAfter.map((c) => c.name));
    expect(namesAfter.has("access_count")).toBe(true);
    expect(namesAfter.has("last_accessed_at")).toBe(true);

    // Verify existing row is intact with defaults
    const row = freshDb.prepare("SELECT * FROM context_entries WHERE key = 'k'").get() as {
      content: string;
      access_count: number;
      last_accessed_at: string | null;
    };
    expect(row.content).toBe("c");
    expect(row.access_count).toBe(0);
    expect(row.last_accessed_at).toBeNull();

    freshDb.close();
  });
});
