import { vi, describe, it, expect, beforeEach } from "vitest";

// Hoist mocks before any imports that touch the module under test
vi.mock("node:child_process");
vi.mock("../gh-auth.js", () => ({
  orgFromIssueRef: vi.fn(),
  ghExecEnv: vi.fn(),
}));

import { execSync } from "node:child_process";
import { orgFromIssueRef, ghExecEnv } from "../gh-auth.js";
import { fetchFreshIssue } from "../gh-utils.js";
import type { FreshIssueResult } from "../gh-utils.js";

const mockExecSync = vi.mocked(execSync);
const mockOrgFromIssueRef = vi.mocked(orgFromIssueRef);
const mockGhExecEnv = vi.mocked(ghExecEnv);

const FAKE_ENV = { GH_TOKEN: "tok", PATH: "/usr/bin" } as NodeJS.ProcessEnv;
const ISSUE_REF = "acme/myrepo#42";
const FALLBACK = "Original queued description";

beforeEach(() => {
  vi.resetAllMocks();
  mockOrgFromIssueRef.mockReturnValue("acme");
  mockGhExecEnv.mockReturnValue(FAKE_ENV);
});

// ---------------------------------------------------------------------------
// fetchFreshIssue — closed issue
// ---------------------------------------------------------------------------

describe("fetchFreshIssue — closed issue", () => {
  it("returns closed:true and the fallback description when state is CLOSED", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ title: "Bug", body: "Details", state: "CLOSED", comments: [] }),
    );

    const result: FreshIssueResult = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.closed).toBe(true);
    expect(result.description).toBe(FALLBACK);
  });
});

// ---------------------------------------------------------------------------
// fetchFreshIssue — open issue, no comments
// ---------------------------------------------------------------------------

describe("fetchFreshIssue — open issue without comments", () => {
  it("returns closed:false with title+body and Closes trailer", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        title: "Add dark mode",
        body: "Users want dark mode.",
        state: "OPEN",
        comments: [],
      }),
    );

    const result = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.closed).toBe(false);
    expect(result.description).toContain("Add dark mode");
    expect(result.description).toContain("Users want dark mode.");
    expect(result.description).toContain(`Closes ${ISSUE_REF}`);
  });

  it("handles a null body without throwing", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        title: "Empty body issue",
        body: null,
        state: "OPEN",
        comments: [],
      }),
    );

    const result = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.closed).toBe(false);
    expect(result.description).toContain("Empty body issue");
    expect(result.description).toContain(`Closes ${ISSUE_REF}`);
  });
});

// ---------------------------------------------------------------------------
// fetchFreshIssue — open issue with comments
// ---------------------------------------------------------------------------

describe("fetchFreshIssue — open issue with comments", () => {
  it("appends a comments block with author, timestamp, and body", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        title: "Performance issue",
        body: "It is slow.",
        state: "OPEN",
        comments: [
          {
            body: "Confirmed on v2.",
            author: { login: "alice" },
            createdAt: "2024-01-15T10:00:00Z",
          },
          {
            body: "Happens on large datasets.",
            author: { login: "bob" },
            createdAt: "2024-01-16T08:30:00Z",
          },
        ],
      }),
    );

    const result = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.closed).toBe(false);
    expect(result.description).toContain("## Issue Comments");
    expect(result.description).toContain("--- Comment by @alice (2024-01-15T10:00:00Z) ---");
    expect(result.description).toContain("Confirmed on v2.");
    expect(result.description).toContain("--- Comment by @bob (2024-01-16T08:30:00Z) ---");
    expect(result.description).toContain("Happens on large datasets.");
    expect(result.description).toContain(`Closes ${ISSUE_REF}`);
  });

  it("does not add a comments block when comments array is empty", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ title: "T", body: "B", state: "OPEN", comments: [] }),
    );

    const result = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.description).not.toContain("## Issue Comments");
  });

  it("filters out yardmaster bot comments", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        title: "Fix login bug",
        body: "Login is broken.",
        state: "OPEN",
        comments: [
          {
            body: "🤖 **Yardmaster** — Task queued\n\nTask `abc123` has been created.",
            author: { login: "github-actions[bot]" },
            createdAt: "2024-01-15T10:00:00Z",
          },
          {
            body: "I can reproduce this on Firefox too.",
            author: { login: "alice" },
            createdAt: "2024-01-15T11:00:00Z",
          },
          {
            body: "🤖 **Yardmaster** — Work started\n\nTask `abc123` is now being worked on.",
            author: { login: "github-actions[bot]" },
            createdAt: "2024-01-15T12:00:00Z",
          },
        ],
      }),
    );

    const result = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.description).toContain("## Issue Comments");
    expect(result.description).toContain("--- Comment by @alice");
    expect(result.description).toContain("I can reproduce this on Firefox too.");
    expect(result.description).not.toContain("Task queued");
    expect(result.description).not.toContain("Work started");
  });

  it("omits comments block when all comments are bot comments", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        title: "T",
        body: "B",
        state: "OPEN",
        comments: [
          {
            body: "🤖 **Yardmaster** — Task queued\n\nTask `abc` created.",
            author: { login: "github-actions[bot]" },
            createdAt: "2024-01-15T10:00:00Z",
          },
        ],
      }),
    );

    const result = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.description).not.toContain("## Issue Comments");
  });
});

// ---------------------------------------------------------------------------
// fetchFreshIssue — execSync failure (fallback)
// ---------------------------------------------------------------------------

describe("fetchFreshIssue — execSync failure", () => {
  it("returns closed:false with the fallback description when execSync throws", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const result = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.closed).toBe(false);
    expect(result.description).toBe(FALLBACK);
  });

  it("returns closed:false with the fallback description when JSON.parse fails", () => {
    mockExecSync.mockReturnValue("not valid json{{{");

    const result = fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(result.closed).toBe(false);
    expect(result.description).toBe(FALLBACK);
  });
});

// ---------------------------------------------------------------------------
// fetchFreshIssue — org resolution
// ---------------------------------------------------------------------------

describe("fetchFreshIssue — org resolution", () => {
  it("passes the org returned by orgFromIssueRef to ghExecEnv", () => {
    mockOrgFromIssueRef.mockReturnValue("myorg");
    mockExecSync.mockReturnValue(
      JSON.stringify({ title: "T", body: "B", state: "OPEN", comments: [] }),
    );

    fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(mockGhExecEnv).toHaveBeenCalledWith("myorg");
  });

  it("passes empty string to ghExecEnv when orgFromIssueRef returns null", () => {
    mockOrgFromIssueRef.mockReturnValue(null);
    mockExecSync.mockReturnValue(
      JSON.stringify({ title: "T", body: "B", state: "OPEN", comments: [] }),
    );

    fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(mockGhExecEnv).toHaveBeenCalledWith("");
  });

  it("uses the env returned by ghExecEnv in the execSync call", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({ title: "T", body: "B", state: "OPEN", comments: [] }),
    );

    fetchFreshIssue(ISSUE_REF, FALLBACK);

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(ISSUE_REF),
      expect.objectContaining({ env: FAKE_ENV }),
    );
  });
});
