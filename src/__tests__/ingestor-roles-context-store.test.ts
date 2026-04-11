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
      UNIQUE(repo, kind, key)
    );

    CREATE INDEX IF NOT EXISTS idx_context_repo_kind
      ON context_entries(repo, kind);
  `);

  return { getDb: () => db };
});

import { upsertContext, getContext } from "../context-store.js";
import { getContextForAgent, getBudgetForRole } from "../context/router.js";
import { getDb } from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO = "test-repo";

function clearEntries() {
  getDb().prepare("DELETE FROM context_entries").run();
}

// ---------------------------------------------------------------------------
// Suite: new roles survive SQLite round-trips
// ---------------------------------------------------------------------------

describe("test-quality and integration-test roles: upsertContext → SQLite → getContextForAgent", () => {
  beforeEach(clearEntries);

  // --- storage ---

  it("stores test-quality role and retrieves the entry via getContextForAgent", () => {
    upsertContext(REPO, "convention", "vitest-setup", "Run tests with vitest run", ["test-quality"]);

    const ctx = getContextForAgent("test-quality", REPO);

    expect(ctx).toContain("vitest-setup");
    expect(ctx).toContain("Run tests with vitest run");
  });

  it("stores integration-test role and retrieves the entry via getContextForAgent", () => {
    upsertContext(REPO, "convention", "db-patterns", "Database access patterns using Drizzle ORM", ["integration-test"]);

    const ctx = getContextForAgent("integration-test", REPO);

    expect(ctx).toContain("db-patterns");
    expect(ctx).toContain("Database access patterns using Drizzle ORM");
  });

  // --- LIKE pattern isolation (hyphenated names must not cross-match) ---

  it("test-quality entry is NOT returned when querying the integration-test role", () => {
    upsertContext(REPO, "convention", "unit-test-guide", "Unit test patterns with vitest", ["test-quality"]);

    const ctx = getContextForAgent("integration-test", REPO);

    // agent_roles = '["test-quality"]' — LIKE '%"integration-test"%' must not match
    expect(ctx).not.toContain("unit-test-guide");
  });

  it("integration-test entry is NOT returned when querying the test-quality role", () => {
    upsertContext(REPO, "convention", "auth-patterns", "Authentication config for integration tests", ["integration-test"]);

    const ctx = getContextForAgent("test-quality", REPO);

    // agent_roles = '["integration-test"]' — LIKE '%"test-quality"%' must not match
    expect(ctx).not.toContain("auth-patterns");
  });

  // --- multi-role entries ---

  it("entry with both new roles is returned when querying either role", () => {
    upsertContext(REPO, "convention", "test-infra", "Test infrastructure overview", [
      "test-quality",
      "integration-test",
    ]);

    expect(getContextForAgent("test-quality", REPO)).toContain("test-infra");
    expect(getContextForAgent("integration-test", REPO)).toContain("test-infra");
  });

  // --- universal entries (empty roles array) ---

  it("entry with empty roles array is returned for both new roles", () => {
    upsertContext(REPO, "convention", "global-conventions", "Global coding conventions", []);

    expect(getContextForAgent("test-quality", REPO)).toContain("global-conventions");
    expect(getContextForAgent("integration-test", REPO)).toContain("global-conventions");
  });

  // --- new roles do not bleed into existing roles ---

  it("coder-only entry is NOT returned when querying test-quality or integration-test", () => {
    upsertContext(REPO, "convention", "coder-only", "Coder-specific conventions", ["coder"]);

    expect(getContextForAgent("test-quality", REPO)).not.toContain("coder-only");
    expect(getContextForAgent("integration-test", REPO)).not.toContain("coder-only");
  });

  it("test-quality entry is NOT returned when querying legacy roles like coder or planner", () => {
    upsertContext(REPO, "convention", "test-quality-guide", "How to write quality tests", ["test-quality"]);

    expect(getContextForAgent("coder", REPO)).not.toContain("test-quality-guide");
    expect(getContextForAgent("planner", REPO)).not.toContain("test-quality-guide");
  });

  // --- upsert semantics: roles are replaced, not merged ---

  it("upsert on conflict replaces roles — new roles survive the overwrite", () => {
    upsertContext(REPO, "convention", "shared-doc", "some content", ["coder"]);
    upsertContext(REPO, "convention", "shared-doc", "some content updated", [
      "test-quality",
      "integration-test",
    ]);

    const entry = getContext(REPO, "convention", "shared-doc");
    expect(entry?.agentRoles).toContain("test-quality");
    expect(entry?.agentRoles).toContain("integration-test");
    expect(entry?.agentRoles).not.toContain("coder"); // replaced, not merged
    expect(entry?.content).toBe("some content updated");
  });

  // --- character budgets ---

  it("getBudgetForRole returns the expected budget for test-quality (2048)", () => {
    expect(getBudgetForRole("test-quality")).toBe(2048);
  });

  it("getBudgetForRole returns the expected budget for integration-test (3072)", () => {
    expect(getBudgetForRole("integration-test")).toBe(3072);
  });

  it("integration-test has a larger budget than test-quality", () => {
    expect(getBudgetForRole("integration-test")).toBeGreaterThan(getBudgetForRole("test-quality"));
  });

  it("getContextForAgent respects the test-quality budget — output does not exceed budget", () => {
    const budget = getBudgetForRole("test-quality");
    // Insert content 4× the budget; the router must truncate it
    upsertContext(REPO, "convention", "oversized-test-entry", "t".repeat(budget * 4), ["test-quality"]);

    const ctx = getContextForAgent("test-quality", REPO);

    // Allow a small overhead for the section header ("## Conventions\n\n### key\n\n")
    expect(ctx.length).toBeLessThanOrEqual(budget + 60);
  });

  it("getContextForAgent respects the integration-test budget — output does not exceed budget", () => {
    const budget = getBudgetForRole("integration-test");
    upsertContext(REPO, "convention", "oversized-integ-entry", "i".repeat(budget * 4), ["integration-test"]);

    const ctx = getContextForAgent("integration-test", REPO);

    expect(ctx.length).toBeLessThanOrEqual(budget + 60);
  });

  // --- multi-entry packing ---

  it("packs multiple entries with test-quality role up to budget", () => {
    upsertContext(REPO, "convention", "entry-a", "First test convention", ["test-quality"]);
    upsertContext(REPO, "convention", "entry-b", "Second test convention", ["test-quality"]);
    upsertContext(REPO, "convention", "entry-c", "Third test convention", ["test-quality"]);

    const ctx = getContextForAgent("test-quality", REPO);

    // All three small entries should fit within the 2048-char budget
    expect(ctx).toContain("entry-a");
    expect(ctx).toContain("entry-b");
    expect(ctx).toContain("entry-c");
  });

  it("returns empty string when no entries match the test-quality role", () => {
    upsertContext(REPO, "convention", "coder-doc", "Coder only", ["coder"]);

    expect(getContextForAgent("test-quality", REPO)).toBe("");
  });

  it("returns empty string when no entries match the integration-test role", () => {
    upsertContext(REPO, "convention", "planner-doc", "Planner only", ["planner"]);

    expect(getContextForAgent("integration-test", REPO)).toBe("");
  });
});
