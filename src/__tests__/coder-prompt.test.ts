/**
 * Tests for src/prompts/coder.ts
 *
 * Covers:
 *  - CODER_SYSTEM_PROMPT content — including the new CRITICAL scope-limiting rule
 *  - buildCoderPrompt: task description, repo info, worktree path, and optional
 *    context inclusion
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
  CODER_SYSTEM_PROMPT,
  buildCoderPrompt,
} from "../prompts/coder.js";
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

const TASK = "Add a health-check endpoint at GET /healthz";
const WORKTREE = "/data/worktrees/ym-abc123";

// ---------------------------------------------------------------------------
// CODER_SYSTEM_PROMPT — static content
// ---------------------------------------------------------------------------

describe("CODER_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof CODER_SYSTEM_PROMPT).toBe("string");
    expect(CODER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("prohibits staging or committing", () => {
    expect(CODER_SYSTEM_PROMPT).toContain("Commit nothing");
  });

  it("instructs agent to follow existing conventions", () => {
    expect(CODER_SYSTEM_PROMPT).toContain("existing conventions");
  });

  it("instructs agent to make minimal focused changes", () => {
    expect(CODER_SYSTEM_PROMPT).toContain("minimal");
  });

  // --- new CRITICAL rule ---

  it("contains the CRITICAL scope-limiting instruction", () => {
    expect(CODER_SYSTEM_PROMPT).toContain("CRITICAL");
  });

  it("CRITICAL rule forbids refactoring functions not part of the task", () => {
    expect(CODER_SYSTEM_PROMPT).toContain(
      "Do NOT refactor, simplify, or rewrite existing functions that are not part of the task"
    );
  });

  it("CRITICAL rule requires leaving untouched functions exactly as they are", () => {
    expect(CODER_SYSTEM_PROMPT).toContain(
      "leave all other functions in that file exactly as they are"
    );
  });

  it("CRITICAL rule scopes changes to what the task directly requires", () => {
    expect(CODER_SYSTEM_PROMPT).toContain(
      "Only modify code that is directly required by the task"
    );
  });
});

// ---------------------------------------------------------------------------
// buildCoderPrompt — task and repo info
// ---------------------------------------------------------------------------

describe("buildCoderPrompt — task and repo info", () => {
  it("includes the task description", () => {
    const prompt = buildCoderPrompt(REPO, TASK, WORKTREE);
    expect(prompt).toContain(TASK);
  });

  it("includes the GitHub org/repo name", () => {
    const prompt = buildCoderPrompt(REPO, TASK, WORKTREE);
    expect(prompt).toContain("acme/widget");
  });

  it("includes the working directory / worktree path", () => {
    const prompt = buildCoderPrompt(REPO, TASK, WORKTREE);
    expect(prompt).toContain(WORKTREE);
  });
});

// ---------------------------------------------------------------------------
// buildCoderPrompt — project context
// ---------------------------------------------------------------------------

describe("buildCoderPrompt — project context", () => {
  it("omits the Project Context section when getContextForAgent returns empty string", () => {
    vi.mocked(getContextForAgent).mockReturnValue("");
    const prompt = buildCoderPrompt(REPO, TASK, WORKTREE);
    expect(prompt).not.toContain("## Project Context");
  });

  it("includes project context content when getContextForAgent returns content", () => {
    vi.mocked(getContextForAgent).mockReturnValue("## Conventions\n\nUse ESM imports.");
    const prompt = buildCoderPrompt(REPO, TASK, WORKTREE);
    expect(prompt).toContain("Use ESM imports.");
    // Reset for subsequent tests
    vi.mocked(getContextForAgent).mockReturnValue("");
  });

  it("calls getContextForAgent with role 'coder' and the repo name", () => {
    vi.mocked(getContextForAgent).mockReturnValue("");
    buildCoderPrompt(REPO, TASK, WORKTREE);
    expect(getContextForAgent).toHaveBeenCalledWith("coder", REPO.name);
  });
});
