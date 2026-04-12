/**
 * Tests for src/prompts/logic-reviewer.ts
 *
 * Covers:
 *  - LOGIC_REVIEWER_SYSTEM_PROMPT static content
 *  - buildLogicReviewerPrompt: repo info, diff, optional context, prior rounds,
 *    and the Documentation Lookup section added in this change
 */

import { vi, describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that transitively use these modules
// ---------------------------------------------------------------------------

vi.mock("../context/router.js", () => ({
  getContextForAgent: vi.fn().mockReturnValue(""),
  getBudgetForRole: vi.fn(),
  getContextStats: vi.fn(),
  ALL_AGENT_ROLES: [],
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getContextForAgent } from "../context/router.js";
import {
  LOGIC_REVIEWER_SYSTEM_PROMPT,
  buildLogicReviewerPrompt,
} from "../prompts/logic-reviewer.js";
import type { RepoConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO: RepoConfig = {
  name: "test-repo",
  localPath: "/repos/test-repo",
  githubOrg: "acme",
  githubRepo: "widget",
  defaultBranch: "main",
};

const DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 export function add(a: number, b: number) {
+  if (a < 0) throw new Error("negative");
   return a + b;
 }`;

const WORKTREE = "/data/worktrees/ym-abc123";

// ---------------------------------------------------------------------------
// LOGIC_REVIEWER_SYSTEM_PROMPT — static content
// ---------------------------------------------------------------------------

describe("LOGIC_REVIEWER_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof LOGIC_REVIEWER_SYSTEM_PROMPT).toBe("string");
    expect(LOGIC_REVIEWER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("instructs reviewer to check for correctness and edge cases", () => {
    expect(LOGIC_REVIEWER_SYSTEM_PROMPT).toContain("Correctness and edge cases");
  });

  it("instructs reviewer to return JSON with verdict and issues", () => {
    expect(LOGIC_REVIEWER_SYSTEM_PROMPT).toContain('"verdict"');
    expect(LOGIC_REVIEWER_SYSTEM_PROMPT).toContain('"issues"');
  });

  it("excludes style concerns from scope", () => {
    expect(LOGIC_REVIEWER_SYSTEM_PROMPT).toContain("Do NOT check");
    expect(LOGIC_REVIEWER_SYSTEM_PROMPT).toContain("Code style");
  });
});

// ---------------------------------------------------------------------------
// buildLogicReviewerPrompt — repo and diff info
// ---------------------------------------------------------------------------

describe("buildLogicReviewerPrompt — repo and diff info", () => {
  it("includes the GitHub org/repo name", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("acme/widget");
  });

  it("includes the working directory path", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain(WORKTREE);
  });

  it("includes the diff content inside a diff code fence", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("```diff");
    expect(prompt).toContain(DIFF);
  });

  it("ends with the logic-only review instruction", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("logic issues only");
    expect(prompt).toContain("return your verdict as JSON");
  });
});

// ---------------------------------------------------------------------------
// buildLogicReviewerPrompt — project context
// ---------------------------------------------------------------------------

describe("buildLogicReviewerPrompt — project context", () => {
  it("omits context block when getContextForAgent returns empty string", () => {
    vi.mocked(getContextForAgent).mockReturnValue("");
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).not.toContain("## Project Context");
  });

  it("includes context content when getContextForAgent returns content", () => {
    vi.mocked(getContextForAgent).mockReturnValue("## Conventions\n\nUse ESM imports.");
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("Use ESM imports.");
    vi.mocked(getContextForAgent).mockReturnValue("");
  });

  it("calls getContextForAgent with role 'logic-reviewer' and the repo name", () => {
    vi.mocked(getContextForAgent).mockReturnValue("");
    buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(getContextForAgent).toHaveBeenCalledWith("logic-reviewer", REPO.name);
  });
});

// ---------------------------------------------------------------------------
// buildLogicReviewerPrompt — prior rounds context
// ---------------------------------------------------------------------------

describe("buildLogicReviewerPrompt — prior rounds context", () => {
  it("omits Prior Review Rounds section when priorRoundsContext is undefined", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).not.toContain("## Prior Review Rounds");
  });

  it("includes Prior Review Rounds section when priorRoundsContext is provided", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE, "Round 1: fixed null check");
    expect(prompt).toContain("## Prior Review Rounds");
    expect(prompt).toContain("Round 1: fixed null check");
  });

  it("prior rounds section instructs reviewer not to re-raise resolved issues", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE, "Round 1: something");
    expect(prompt).toContain("Do NOT re-raise these issues");
  });
});

// ---------------------------------------------------------------------------
// buildLogicReviewerPrompt — documentation lookup section
// ---------------------------------------------------------------------------

describe("buildLogicReviewerPrompt — documentation lookup", () => {
  it("includes a Documentation Lookup section", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("## Documentation Lookup");
  });

  it("includes the ym context docs command with the correct repo name", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain(`ym context docs --repo ${REPO.name} --lib`);
  });

  it("documentation lookup command uses the repo name not the github org/repo", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("--repo test-repo");
    expect(prompt).not.toContain("--repo acme/widget");
  });

  it("mentions API usage verification purpose", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("correct API usage");
  });

  it("mentions preference over raw web searches", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("raw web searches");
  });

  it("Documentation Lookup section appears before the final review instruction", () => {
    const prompt = buildLogicReviewerPrompt(REPO, DIFF, WORKTREE);
    const docsIdx = prompt.indexOf("## Documentation Lookup");
    const reviewIdx = prompt.indexOf("Review the diff above for logic issues only");
    expect(docsIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(docsIdx).toBeLessThan(reviewIdx);
  });
});
