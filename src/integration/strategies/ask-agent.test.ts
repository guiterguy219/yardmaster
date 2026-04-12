/**
 * Tests for src/integration/strategies/ask-agent.ts
 *
 * Covers the safe fallback strategy that halts the pipeline and surfaces
 * clarification questions when no integration strategy has been declared.
 */

import { describe, it, expect } from "vitest";
import { runAskAgentStrategy } from "./ask-agent.js";
import type { RepoConfig } from "../../config.js";

const REPO: RepoConfig = {
  name: "my-repo",
  localPath: "/repos/my-repo",
  githubOrg: "acme",
  githubRepo: "widget",
  defaultBranch: "main",
};

describe("runAskAgentStrategy", () => {
  it("returns ran=false", async () => {
    const result = await runAskAgentStrategy(REPO);
    expect(result.ran).toBe(false);
  });

  it("returns passed=false", async () => {
    const result = await runAskAgentStrategy(REPO);
    expect(result.passed).toBe(false);
  });

  it("returns needsClarification=true", async () => {
    const result = await runAskAgentStrategy(REPO);
    expect(result.needsClarification).toBe(true);
  });

  it("returns attempts=0", async () => {
    const result = await runAskAgentStrategy(REPO);
    expect(result.attempts).toBe(0);
  });

  it("includes the repo name in output", async () => {
    const result = await runAskAgentStrategy(REPO);
    expect(result.output).toContain("my-repo");
  });

  it("includes INTEGRATION_STRATEGY_UNCLEAR in output", async () => {
    const result = await runAskAgentStrategy(REPO);
    expect(result.output).toContain("INTEGRATION_STRATEGY_UNCLEAR");
  });

  it("provides a non-empty clarificationQuestions array", async () => {
    const result = await runAskAgentStrategy(REPO);
    expect(result.clarificationQuestions).toBeDefined();
    expect(result.clarificationQuestions!.length).toBeGreaterThan(0);
  });

  it("includes the repo name in at least one clarification question", async () => {
    const result = await runAskAgentStrategy(REPO);
    const hasRepoName = result.clarificationQuestions!.some((q) => q.includes("my-repo"));
    expect(hasRepoName).toBe(true);
  });

  it("uses the repo name from the passed RepoConfig", async () => {
    const otherRepo: RepoConfig = { ...REPO, name: "other-service" };
    const result = await runAskAgentStrategy(otherRepo);
    expect(result.output).toContain("other-service");
  });
});
