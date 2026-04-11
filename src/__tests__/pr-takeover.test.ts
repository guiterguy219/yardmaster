import { describe, it, expect } from "vitest";
import { parsePrUrl, buildTaskFromPr } from "../pr-takeover.js";
import type { PrInfo, PrContext } from "../pr-takeover.js";

// ---------------------------------------------------------------------------
// parsePrUrl
// ---------------------------------------------------------------------------

describe("parsePrUrl", () => {
  it("parses a standard GitHub PR URL", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/42");
    expect(result).toEqual({ owner: "owner", repo: "repo", number: 42 });
  });

  it("parses a PR URL with numeric owner/repo names", () => {
    const result = parsePrUrl("https://github.com/my-org/my-repo/pull/1");
    expect(result).toEqual({ owner: "my-org", repo: "my-repo", number: 1 });
  });

  it("parses a PR URL with a large PR number", () => {
    const result = parsePrUrl("https://github.com/acme/widget/pull/9999");
    expect(result).toEqual({ owner: "acme", repo: "widget", number: 9999 });
  });

  it("parses a URL containing extra path after the PR number", () => {
    // gh sometimes appends a trailing slash or query params — regex matches the core
    const result = parsePrUrl("https://github.com/foo/bar/pull/7/files");
    expect(result).toEqual({ owner: "foo", repo: "bar", number: 7 });
  });

  it("throws for a non-PR GitHub URL", () => {
    expect(() => parsePrUrl("https://github.com/owner/repo/issues/5")).toThrow(
      "Invalid PR URL"
    );
  });

  it("throws for a completely invalid URL", () => {
    expect(() => parsePrUrl("not-a-url")).toThrow("Invalid PR URL");
  });

  it("throws for an empty string", () => {
    expect(() => parsePrUrl("")).toThrow("Invalid PR URL");
  });
});

// ---------------------------------------------------------------------------
// buildTaskFromPr
// ---------------------------------------------------------------------------

describe("buildTaskFromPr", () => {
  const pr: PrInfo = { owner: "acme", repo: "widget", number: 42 };

  function makeContext(overrides: Partial<PrContext> = {}): PrContext {
    return {
      title: "Fix the bug",
      body: "",
      headRefName: "feature/fix",
      baseRefName: "main",
      reviewComments: [],
      ...overrides,
    };
  }

  it("includes the PR number and title in the first line", () => {
    const task = buildTaskFromPr(pr, makeContext());
    expect(task).toMatch(/^Address feedback on PR #42: Fix the bug/);
  });

  it("omits the PR body section when body is empty", () => {
    const task = buildTaskFromPr(pr, makeContext({ body: "" }));
    expect(task).not.toContain("## Original PR Description");
  });

  it("includes the PR body when present", () => {
    const task = buildTaskFromPr(pr, makeContext({ body: "This PR fixes X." }));
    expect(task).toContain("## Original PR Description");
    expect(task).toContain("This PR fixes X.");
  });

  it("omits the review comments section when there are none", () => {
    const task = buildTaskFromPr(pr, makeContext({ reviewComments: [] }));
    expect(task).not.toContain("## Review Comments to Address");
  });

  it("includes each review comment wrapped in a code fence", () => {
    const task = buildTaskFromPr(
      pr,
      makeContext({ reviewComments: ["Please add tests.", "Rename this variable."] })
    );
    expect(task).toContain("## Review Comments to Address");
    expect(task).toContain("```\nPlease add tests.\n```");
    expect(task).toContain("```\nRename this variable.\n```");
  });

  it("includes both body and review comments when both are present", () => {
    const task = buildTaskFromPr(
      pr,
      makeContext({
        body: "Original description here.",
        reviewComments: ["LGTM but fix types."],
      })
    );
    expect(task).toContain("## Original PR Description");
    expect(task).toContain("Original description here.");
    expect(task).toContain("## Review Comments to Address");
    expect(task).toContain("LGTM but fix types.");
  });

  it("produces consistent output order: header, body, comments", () => {
    const task = buildTaskFromPr(
      pr,
      makeContext({
        body: "The body.",
        reviewComments: ["A comment."],
      })
    );
    const headerIdx = task.indexOf("Address feedback");
    const bodyIdx = task.indexOf("## Original PR Description");
    const commentsIdx = task.indexOf("## Review Comments to Address");
    expect(headerIdx).toBeLessThan(bodyIdx);
    expect(bodyIdx).toBeLessThan(commentsIdx);
  });
});
