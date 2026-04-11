import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted so vi.mock factories can reference them.
// ---------------------------------------------------------------------------

const { mockUpsertContext, mockRunAgent, mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockUpsertContext: vi.fn(),
  mockRunAgent: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("../context-store.js", () => ({
  hashContent: (c: string) => `hash:${c.slice(0, 8)}`,
  hasFileChanged: () => true, // always treat files as changed so they get processed
  upsertContext: mockUpsertContext,
  ingestPackageJson: () => 0,
}));

vi.mock("../agent-runner.js", () => ({
  runAgent: mockRunAgent,
}));

// db.transaction(fn) returns fn; the caller does upsertTx = db.transaction(fn); upsertTx()
vi.mock("../db.js", () => ({
  getDb: () => ({
    transaction: (fn: () => void) => fn,
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

import { ingestRepo } from "../ingestor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_CONFIG = {} as Parameters<typeof ingestRepo>[0];
const MOCK_REPO = "test-repo";
const MOCK_BASE_PATH = "/fake/repo";

/** Wrap chunks in the JSON shape that runAgent returns on success */
function agentSuccess(chunks: object[]) {
  return { success: true, result: JSON.stringify({ chunks }) };
}

/** Simulate a failed runAgent call */
function agentFailure() {
  return { success: false, result: "" };
}

/**
 * Return all agentRoles arrays that were passed to upsertContext,
 * excluding the raw-hash sentinel rows ("_raw:…" keys).
 */
function capturedRoles(): string[][] {
  return mockUpsertContext.mock.calls
    .filter((call) => !String(call[2]).startsWith("_raw:"))
    .map((call) => call[4] as string[]);
}

// ---------------------------------------------------------------------------
// Suite: enrichTestRoles — keyword-based role enrichment
// ---------------------------------------------------------------------------

describe("enrichTestRoles — keyword-based role enrichment via ingestRepo", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Only CLAUDE.md "exists" so discoverFiles returns exactly one file.
    mockExistsSync.mockImplementation(
      (p: unknown) => typeof p === "string" && p.endsWith("CLAUDE.md"),
    );
    // Default file content — overridden per test
    mockReadFileSync.mockReturnValue("no keywords here");
  });

  it("adds test-quality and integration-test when chunk content mentions a test keyword", async () => {
    mockReadFileSync.mockReturnValue("vitest setup guide");
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "testing-overview",
          kind: "convention",
          content: "describes our vitest setup and how to run tests",
          agentRoles: ["coder"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toContain("test-quality");
    expect(roles[0]).toContain("integration-test");
    expect(roles[0]).toContain("coder"); // original role preserved
  });

  it("matches test keywords in chunk key as well as content", async () => {
    mockReadFileSync.mockReturnValue("irrelevant");
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        // key contains "spec" — should trigger TEST_KEYWORDS
        {
          key: "spec-conventions",
          kind: "convention",
          content: "nothing relevant in the body",
          agentRoles: ["planner"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles[0]).toContain("test-quality");
    expect(roles[0]).toContain("integration-test");
    expect(roles[0]).toContain("planner"); // original role preserved
  });

  it("adds only integration-test (not test-quality) for integration-only keywords", async () => {
    mockReadFileSync.mockReturnValue("database connection docs");
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "db-config",
          kind: "convention",
          content: "database access patterns and migration strategies",
          agentRoles: ["coder"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toContain("integration-test");
    expect(roles[0]).not.toContain("test-quality");
  });

  it("adds only integration-test for 'auth' keyword", async () => {
    mockReadFileSync.mockReturnValue("auth setup");
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "auth-guide",
          kind: "convention",
          content: "authentication configuration and token refresh",
          agentRoles: ["logic-reviewer"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles[0]).toContain("integration-test");
    expect(roles[0]).not.toContain("test-quality");
    expect(roles[0]).toContain("logic-reviewer"); // original preserved
  });

  it("adds test-quality and integration-test for architecture keywords", async () => {
    mockReadFileSync.mockReturnValue("project layout docs");
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "architecture-section",
          kind: "convention",
          content: "module structure and project layout overview",
          agentRoles: ["planner"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles[0]).toContain("test-quality");
    expect(roles[0]).toContain("integration-test");
    expect(roles[0]).toContain("planner"); // original preserved
  });

  it("does not add new roles when chunk has no matching keywords", async () => {
    mockReadFileSync.mockReturnValue("simple config");
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "tsconfig-options",
          kind: "file",
          content: "compiler target and strict settings",
          agentRoles: ["coder"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0]).not.toContain("test-quality");
    expect(roles[0]).not.toContain("integration-test");
    expect(roles[0]).toEqual(["coder"]);
  });

  it("enriches each chunk independently based on its own content", async () => {
    mockReadFileSync.mockReturnValue("mixed content");
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        // chunk 0: integration keyword only
        {
          key: "auth-section",
          kind: "convention",
          content: "authentication setup",
          agentRoles: ["coder"],
        },
        // chunk 1: no matching keywords
        {
          key: "plain-section",
          kind: "convention",
          content: "just some plain notes about formatting",
          agentRoles: ["coder"],
        },
        // chunk 2: test keyword
        {
          key: "vitest-section",
          kind: "convention",
          content: "vitest configuration and runner setup",
          agentRoles: ["coder"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles).toHaveLength(3);

    // chunk 0: auth → integration-test only
    expect(roles[0]).toContain("integration-test");
    expect(roles[0]).not.toContain("test-quality");

    // chunk 1: no keywords → no new roles
    expect(roles[1]).not.toContain("integration-test");
    expect(roles[1]).not.toContain("test-quality");

    // chunk 2: vitest → both roles
    expect(roles[2]).toContain("test-quality");
    expect(roles[2]).toContain("integration-test");
  });

  it("enriches the fallback chunk when runAgent fails", async () => {
    // "error handling" is an INTEGRATION_KEYWORD
    mockReadFileSync.mockReturnValue("error handling and auth configuration");
    mockRunAgent.mockResolvedValue(agentFailure());

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toContain("integration-test");
    // fallback chunk starts with ["coder", "planner"] — both must be preserved
    expect(roles[0]).toContain("coder");
    expect(roles[0]).toContain("planner");
  });

  it("enriches the fallback chunk when haiku returns no chunks", async () => {
    mockReadFileSync.mockReturnValue("migration scripts and repository patterns");
    // runAgent succeeds but returns an empty chunks array → fallback
    mockRunAgent.mockResolvedValue({ success: true, result: JSON.stringify({ chunks: [] }) });

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0]).toContain("integration-test");
    expect(roles[0]).toContain("coder"); // fallback default roles preserved
  });
});

// ---------------------------------------------------------------------------
// Suite: VALID_ROLES — test-quality and integration-test are now accepted
// ---------------------------------------------------------------------------

describe("VALID_ROLES — test-quality and integration-test survive validateChunk", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockImplementation(
      (p: unknown) => typeof p === "string" && p.endsWith("CLAUDE.md"),
    );
    mockReadFileSync.mockReturnValue("no keyword triggers");
  });

  it("preserves test-quality role returned by haiku (not filtered out by validateChunk)", async () => {
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "test-setup",
          kind: "convention",
          content: "no keyword triggers here",
          agentRoles: ["test-quality"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles[0]).toContain("test-quality");
  });

  it("preserves integration-test role returned by haiku (not filtered out by validateChunk)", async () => {
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "integration-setup",
          kind: "convention",
          content: "no keyword triggers here",
          agentRoles: ["integration-test"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles[0]).toContain("integration-test");
  });

  it("preserves both new roles alongside legacy roles", async () => {
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "mixed-roles",
          kind: "convention",
          content: "no keyword triggers here",
          agentRoles: ["coder", "planner", "test-quality", "integration-test"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    expect(roles[0]).toContain("coder");
    expect(roles[0]).toContain("planner");
    expect(roles[0]).toContain("test-quality");
    expect(roles[0]).toContain("integration-test");
  });

  it("does not duplicate roles when enrichment adds a role haiku already assigned", async () => {
    // haiku already assigned test-quality; content also triggers it — should not duplicate
    mockRunAgent.mockResolvedValue(
      agentSuccess([
        {
          key: "vitest-config",
          kind: "convention",
          content: "vitest runner configuration", // TEST_KEYWORD: "vitest"
          agentRoles: ["test-quality"],
        },
      ]),
    );

    await ingestRepo(MOCK_CONFIG, MOCK_REPO, MOCK_BASE_PATH);

    const roles = capturedRoles();
    const testQualityCount = roles[0].filter((r) => r === "test-quality").length;
    expect(testQualityCount).toBe(1); // no duplicates
  });
});
