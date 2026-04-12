/**
 * Tests for src/prompts/style-reviewer.ts
 *
 * Covers:
 *  - STYLE_REVIEWER_SYSTEM_PROMPT static content
 *  - buildStyleReviewerPrompt: repo info, diff, optional context, prior rounds,
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
  STYLE_REVIEWER_SYSTEM_PROMPT,
  buildStyleReviewerPrompt,
} from "../prompts/style-reviewer.js";
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

const DIFF = `diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,3 +1,4 @@
 export function greet(name: string) {
+  const greeting = \`Hello, \${name}!\`;
   return greeting;
 }`;

const WORKTREE = "/data/worktrees/ym-abc123";

// ---------------------------------------------------------------------------
// STYLE_REVIEWER_SYSTEM_PROMPT — static content
// ---------------------------------------------------------------------------

describe("STYLE_REVIEWER_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof STYLE_REVIEWER_SYSTEM_PROMPT).toBe("string");
    expect(STYLE_REVIEWER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("instructs reviewer to check naming conventions", () => {
    expect(STYLE_REVIEWER_SYSTEM_PROMPT).toContain("Naming conventions");
  });

  it("instructs reviewer to return JSON with verdict and issues", () => {
    expect(STYLE_REVIEWER_SYSTEM_PROMPT).toContain('"verdict"');
    expect(STYLE_REVIEWER_SYSTEM_PROMPT).toContain('"issues"');
  });

  it("excludes logic concerns from scope", () => {
    expect(STYLE_REVIEWER_SYSTEM_PROMPT).toContain("Do NOT check");
    expect(STYLE_REVIEWER_SYSTEM_PROMPT).toContain("Logic correctness");
  });
});

// ---------------------------------------------------------------------------
// buildStyleReviewerPrompt — repo and diff info
// ---------------------------------------------------------------------------

describe("buildStyleReviewerPrompt — repo and diff info", () => {
  it("includes the GitHub org/repo name", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("acme/widget");
  });

  it("includes the working directory path", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain(WORKTREE);
  });

  it("includes the diff content inside a diff code fence", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("```diff");
    expect(prompt).toContain(DIFF);
  });

  it("ends with the style-only review instruction", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("style issues only");
    expect(prompt).toContain("return your verdict as JSON");
  });
});

// ---------------------------------------------------------------------------
// buildStyleReviewerPrompt — project context
// ---------------------------------------------------------------------------

describe("buildStyleReviewerPrompt — project context", () => {
  it("omits context block when getContextForAgent returns empty string", () => {
    vi.mocked(getContextForAgent).mockReturnValue("");
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).not.toContain("## Project Context");
  });

  it("includes context content when getContextForAgent returns content", () => {
    vi.mocked(getContextForAgent).mockReturnValue("## Conventions\n\nUse ESM imports.");
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("Use ESM imports.");
    vi.mocked(getContextForAgent).mockReturnValue("");
  });

  it("calls getContextForAgent with role 'style-reviewer' and the repo name", () => {
    vi.mocked(getContextForAgent).mockReturnValue("");
    buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(getContextForAgent).toHaveBeenCalledWith("style-reviewer", REPO.name);
  });
});

// ---------------------------------------------------------------------------
// buildStyleReviewerPrompt — prior rounds context
// ---------------------------------------------------------------------------

describe("buildStyleReviewerPrompt — prior rounds context", () => {
  it("omits Prior Review Rounds section when priorRoundsContext is undefined", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).not.toContain("## Prior Review Rounds");
  });

  it("includes Prior Review Rounds section when priorRoundsContext is provided", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE, "Round 1: renamed variable");
    expect(prompt).toContain("## Prior Review Rounds");
    expect(prompt).toContain("Round 1: renamed variable");
  });

  it("prior rounds section instructs reviewer not to re-raise resolved issues", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE, "Round 1: something");
    expect(prompt).toContain("Do NOT re-raise these issues");
  });
});

// ---------------------------------------------------------------------------
// buildStyleReviewerPrompt — documentation lookup section
// ---------------------------------------------------------------------------

describe("buildStyleReviewerPrompt — documentation lookup", () => {
  it("includes a Documentation Lookup section", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("## Documentation Lookup");
  });

  it("includes the ym context docs command with the correct repo name", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain(`ym context docs --repo ${REPO.name} --lib`);
  });

  it("documentation lookup command uses the repo name not the github org/repo", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("--repo test-repo");
    expect(prompt).not.toContain("--repo acme/widget");
  });

  it("mentions idiomatic usage patterns as the purpose", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("idiomatic usage patterns");
  });

  it("mentions preference over raw web searches", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    expect(prompt).toContain("raw web searches");
  });

  it("Documentation Lookup section appears before the final review instruction", () => {
    const prompt = buildStyleReviewerPrompt(REPO, DIFF, WORKTREE);
    const docsIdx = prompt.indexOf("## Documentation Lookup");
    const reviewIdx = prompt.indexOf("Review the diff above for style issues only");
    expect(docsIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(docsIdx).toBeLessThan(reviewIdx);
  });
});
