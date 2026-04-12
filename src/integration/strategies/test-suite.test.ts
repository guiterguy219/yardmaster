/**
 * Tests for src/integration/strategies/test-suite.ts
 *
 * Covers:
 *  - missing integrationTestCommand → needsClarification
 *  - command passes → ran=true, passed=true
 *  - command fails → ran=true, passed=false with error output
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { runTestSuiteStrategy } from "./test-suite.js";
import type { RepoConfig } from "../../config.js";

const BASE_REPO: RepoConfig = {
  name: "test-repo",
  localPath: "/repos/test-repo",
  githubOrg: "acme",
  githubRepo: "widget",
  defaultBranch: "main",
};

const WORKTREE = "/data/worktrees/ym-abc123";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("runTestSuiteStrategy — no integrationTestCommand", () => {
  it("returns ran=false when integrationTestCommand is not configured", async () => {
    const result = await runTestSuiteStrategy(BASE_REPO, WORKTREE);
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("returns needsClarification=true when integrationTestCommand is not configured", async () => {
    const result = await runTestSuiteStrategy(BASE_REPO, WORKTREE);
    expect(result.needsClarification).toBe(true);
  });

  it("returns attempts=0 when integrationTestCommand is not configured", async () => {
    const result = await runTestSuiteStrategy(BASE_REPO, WORKTREE);
    expect(result.attempts).toBe(0);
  });

  it("includes the repo name in clarification questions", async () => {
    const result = await runTestSuiteStrategy(BASE_REPO, WORKTREE);
    expect(result.clarificationQuestions).toBeDefined();
    const hasRepoName = result.clarificationQuestions!.some((q) => q.includes("test-repo"));
    expect(hasRepoName).toBe(true);
  });

  it("does not call execSync when integrationTestCommand is missing", async () => {
    await runTestSuiteStrategy(BASE_REPO, WORKTREE);
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe("runTestSuiteStrategy — command passes", () => {
  const REPO: RepoConfig = { ...BASE_REPO, integrationTestCommand: "npx vitest run --integration" };

  it("returns ran=true and passed=true on success", async () => {
    vi.mocked(execSync).mockReturnValue("all tests passed" as any);
    const result = await runTestSuiteStrategy(REPO, WORKTREE);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("returns attempts=1 on success", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    const result = await runTestSuiteStrategy(REPO, WORKTREE);
    expect(result.attempts).toBe(1);
  });

  it("includes command stdout in output", async () => {
    vi.mocked(execSync).mockReturnValue("PASS: 42 tests" as any);
    const result = await runTestSuiteStrategy(REPO, WORKTREE);
    expect(result.output).toContain("PASS: 42 tests");
  });

  it("calls execSync with the configured command and worktree cwd", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runTestSuiteStrategy(REPO, WORKTREE);
    expect(execSync).toHaveBeenCalledWith(
      "npx vitest run --integration",
      expect.objectContaining({ cwd: WORKTREE }),
    );
  });
});

describe("runTestSuiteStrategy — command fails", () => {
  const REPO: RepoConfig = { ...BASE_REPO, integrationTestCommand: "npx vitest run --integration" };

  it("returns ran=true and passed=false on failure", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("FAIL: assertion") });
    });
    const result = await runTestSuiteStrategy(REPO, WORKTREE);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("includes stderr in output on failure", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("SPECIFIC_FAILURE") });
    });
    const result = await runTestSuiteStrategy(REPO, WORKTREE);
    expect(result.output).toContain("SPECIFIC_FAILURE");
  });

  it("returns attempts=1 on failure", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("fail");
    });
    const result = await runTestSuiteStrategy(REPO, WORKTREE);
    expect(result.attempts).toBe(1);
  });
});
