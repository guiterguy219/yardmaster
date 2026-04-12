/**
 * Tests for src/prompts/test-quality.ts
 *
 * Covers:
 *  - TEST_QUALITY_SYSTEM_PROMPT — new type-safety rules added in this change
 *  - buildTestQualityPrompt — updated instruction numbering and new steps
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

import {
  TEST_QUALITY_SYSTEM_PROMPT,
  buildTestQualityPrompt,
} from "../prompts/test-quality.js";
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
  testCommand: "npm test",
};

const DIFF = `diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1 +1,2 @@
+export function greet(name: string) { return name; }`;

const WORKTREE = "/data/worktrees/ym-abc123";

// ---------------------------------------------------------------------------
// TEST_QUALITY_SYSTEM_PROMPT — new type-safety rules
// ---------------------------------------------------------------------------

describe("TEST_QUALITY_SYSTEM_PROMPT — type-safety rules", () => {
  it("requires tests to type-check under the project tsconfig", () => {
    expect(TEST_QUALITY_SYSTEM_PROMPT).toContain("tsconfig");
    expect(TEST_QUALITY_SYSTEM_PROMPT).toMatch(/type-check|tsconfig/i);
  });

  it("forbids as-any and ts-ignore escape hatches", () => {
    expect(TEST_QUALITY_SYSTEM_PROMPT).toContain("as any");
    expect(TEST_QUALITY_SYSTEM_PROMPT).toContain("@ts-ignore");
  });

  it("instructs agent to verify import paths against current file layout", () => {
    expect(TEST_QUALITY_SYSTEM_PROMPT).toContain("import paths");
  });

  it("retains the NO_TESTS_NEEDED bail-out rule", () => {
    expect(TEST_QUALITY_SYSTEM_PROMPT).toContain("NO_TESTS_NEEDED");
  });

  it("retains the rule to not modify source code", () => {
    expect(TEST_QUALITY_SYSTEM_PROMPT).toContain("Do NOT modify the source code");
  });
});

// ---------------------------------------------------------------------------
// buildTestQualityPrompt — updated instructions
// ---------------------------------------------------------------------------

describe("buildTestQualityPrompt — updated numbered instructions", () => {
  it("instructs agent to read modified source files directly (step 2)", () => {
    const prompt = buildTestQualityPrompt(REPO, DIFF, WORKTREE);

    expect(prompt).toContain("Read the modified source files directly");
  });

  it("instructs agent to verify tsconfig before writing tests (step 4)", () => {
    const prompt = buildTestQualityPrompt(REPO, DIFF, WORKTREE);

    expect(prompt).toContain("tsconfig");
  });

  it("ends with NO_TESTS_NEEDED fallback instruction", () => {
    const prompt = buildTestQualityPrompt(REPO, DIFF, WORKTREE);

    expect(prompt).toContain("NO_TESTS_NEEDED");
  });

  it("includes the diff content", () => {
    const prompt = buildTestQualityPrompt(REPO, DIFF, WORKTREE);

    expect(prompt).toContain("```diff");
    expect(prompt).toContain(DIFF);
  });

  it("includes the repo org/name", () => {
    const prompt = buildTestQualityPrompt(REPO, DIFF, WORKTREE);

    expect(prompt).toContain("acme/widget");
  });

  it("includes the working directory path", () => {
    const prompt = buildTestQualityPrompt(REPO, DIFF, WORKTREE);

    expect(prompt).toContain(WORKTREE);
  });

  it("'read source files' step appears before 'check existing test files' step", () => {
    const prompt = buildTestQualityPrompt(REPO, DIFF, WORKTREE);
    const readSourceIdx = prompt.indexOf("Read the modified source files directly");
    const checkExistingIdx = prompt.indexOf("existing test files");

    expect(readSourceIdx).toBeGreaterThan(-1);
    expect(checkExistingIdx).toBeGreaterThan(-1);
    expect(readSourceIdx).toBeLessThan(checkExistingIdx);
  });
});
