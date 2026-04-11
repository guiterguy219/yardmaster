/**
 * Tests for src/prompts/integration-test.ts
 *
 * Covers:
 *  - INTEGRATION_TEST_SYSTEM_PROMPT content
 *  - buildIntegrationTestPrompt: diff embedding, repo info, service info,
 *    auth strategy rendering, and optional context inclusion
 */

import { vi, describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that transitively use these modules
// ---------------------------------------------------------------------------

// Mock the context router so buildIntegrationTestPrompt doesn't need a DB
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
  INTEGRATION_TEST_SYSTEM_PROMPT,
  buildIntegrationTestPrompt,
} from "../prompts/integration-test.js";
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
  testCommand: "npx vitest run",
};

const DIFF = `diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() { return 42; }`;
const WORKTREE = "/data/worktrees/ym-abc123";

// ---------------------------------------------------------------------------
// INTEGRATION_TEST_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe("INTEGRATION_TEST_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof INTEGRATION_TEST_SYSTEM_PROMPT).toBe("string");
    expect(INTEGRATION_TEST_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("instructs agent to respond with NO_INTEGRATION_TESTS_NEEDED for trivial changes", () => {
    expect(INTEGRATION_TEST_SYSTEM_PROMPT).toContain("NO_INTEGRATION_TESTS_NEEDED");
  });

  it("prohibits modifying source code", () => {
    expect(INTEGRATION_TEST_SYSTEM_PROMPT).toContain("Do NOT modify the source code");
  });

  it("mentions integration testing between components", () => {
    expect(INTEGRATION_TEST_SYSTEM_PROMPT).toContain("integration test");
  });
});

// ---------------------------------------------------------------------------
// buildIntegrationTestPrompt — diff and repo info
// ---------------------------------------------------------------------------

describe("buildIntegrationTestPrompt — diff and repo info", () => {
  it("embeds the diff inside a fenced diff block", () => {
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(prompt).toContain("```diff\n" + DIFF + "\n```");
  });

  it("includes the GitHub org/repo name", () => {
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(prompt).toContain("acme/widget");
  });

  it("includes the working directory", () => {
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(prompt).toContain(WORKTREE);
  });

  it("includes the test command when configured", () => {
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(prompt).toContain("npx vitest run");
  });

  it("shows 'not configured' when testCommand is absent", () => {
    const repoNoTest: RepoConfig = { ...REPO, testCommand: undefined };
    const prompt = buildIntegrationTestPrompt(repoNoTest, DIFF, WORKTREE, {}, "none");
    expect(prompt).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// buildIntegrationTestPrompt — available services
// ---------------------------------------------------------------------------

describe("buildIntegrationTestPrompt — available services", () => {
  it("shows 'No external services configured.' when services is empty", () => {
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(prompt).toContain("No external services configured.");
  });

  it("lists each service as a bullet when services are provided", () => {
    const services = { postgres: "localhost:5432", redis: "localhost:6379" };
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, services, "none");
    expect(prompt).toContain("- postgres: localhost:5432");
    expect(prompt).toContain("- redis: localhost:6379");
  });

  it("does not show 'No external services configured.' when services are provided", () => {
    const services = { postgres: "localhost:5432" };
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, services, "none");
    expect(prompt).not.toContain("No external services configured.");
  });
});

// ---------------------------------------------------------------------------
// buildIntegrationTestPrompt — auth strategy
// ---------------------------------------------------------------------------

describe("buildIntegrationTestPrompt — auth strategy", () => {
  it("renders mock-jwt description for authStrategy 'mock-jwt'", () => {
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "mock-jwt");
    expect(prompt).toContain("mock JWTs");
    expect(prompt).toContain("no real auth server needed");
  });

  it("renders the raw auth strategy string for any other value", () => {
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "basic-auth");
    expect(prompt).toContain("Authentication strategy: basic-auth");
  });

  it("renders 'none' verbatim for authStrategy 'none'", () => {
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(prompt).toContain("Authentication strategy: none");
  });
});

// ---------------------------------------------------------------------------
// buildIntegrationTestPrompt — project context
// ---------------------------------------------------------------------------

describe("buildIntegrationTestPrompt — project context", () => {
  it("omits the Project Context section when getContextForAgent returns empty string", () => {
    vi.mocked(getContextForAgent).mockReturnValue("");
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(prompt).not.toContain("## Project Context");
  });

  it("includes the Project Context section when getContextForAgent returns content", () => {
    vi.mocked(getContextForAgent).mockReturnValue("## Conventions\n\nUse ESM imports.");
    const prompt = buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("Use ESM imports.");
    // Reset for subsequent tests
    vi.mocked(getContextForAgent).mockReturnValue("");
  });

  it("calls getContextForAgent with role 'integration-test' and the repo name", () => {
    vi.mocked(getContextForAgent).mockReturnValue("");
    buildIntegrationTestPrompt(REPO, DIFF, WORKTREE, {}, "none");
    expect(getContextForAgent).toHaveBeenCalledWith("integration-test", REPO.name);
  });
});
