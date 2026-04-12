/**
 * Tests for src/integration/strategies/self-exec.ts
 *
 * Covers:
 *  - missing buildCommand → needsClarification
 *  - build fails → ran=true, passed=false
 *  - CLI invocation fails after successful build → ran=true, passed=false
 *  - both pass → ran=true, passed=true
 *  - smokeCommand fallback for CLI invocation
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { runSelfExecStrategy } from "./self-exec.js";
import type { RepoConfig } from "../../config.js";

const BASE_REPO: RepoConfig = {
  name: "yardmaster",
  localPath: "/repos/yardmaster",
  githubOrg: "gibson-ops",
  githubRepo: "yardmaster",
  defaultBranch: "main",
};

const WORKTREE = "/data/worktrees/ym-self";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("runSelfExecStrategy — missing buildCommand", () => {
  it("returns ran=false, passed=false when buildCommand is not configured", async () => {
    const result = await runSelfExecStrategy(BASE_REPO, WORKTREE);
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("returns needsClarification=true when buildCommand is not configured", async () => {
    const result = await runSelfExecStrategy(BASE_REPO, WORKTREE);
    expect(result.needsClarification).toBe(true);
  });

  it("returns attempts=0 when buildCommand is not configured", async () => {
    const result = await runSelfExecStrategy(BASE_REPO, WORKTREE);
    expect(result.attempts).toBe(0);
  });

  it("includes clarification question mentioning buildCommand", async () => {
    const result = await runSelfExecStrategy(BASE_REPO, WORKTREE);
    expect(result.clarificationQuestions).toBeDefined();
    const hasBuildCmd = result.clarificationQuestions!.some((q) => q.includes("buildCommand"));
    expect(hasBuildCmd).toBe(true);
  });

  it("does not call execSync when buildCommand is missing", async () => {
    await runSelfExecStrategy(BASE_REPO, WORKTREE);
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe("runSelfExecStrategy — build fails", () => {
  const REPO: RepoConfig = { ...BASE_REPO, buildCommand: "npm run build" };

  it("returns ran=true, passed=false when build fails", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("tsc error") });
    });
    const result = await runSelfExecStrategy(REPO, WORKTREE);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("includes 'build failed' and stderr in output", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("TS_BUILD_ERR") });
    });
    const result = await runSelfExecStrategy(REPO, WORKTREE);
    expect(result.output).toContain("build failed");
    expect(result.output).toContain("TS_BUILD_ERR");
  });

  it("returns attempts=1 when build fails", async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error("fail"); });
    const result = await runSelfExecStrategy(REPO, WORKTREE);
    expect(result.attempts).toBe(1);
  });
});

describe("runSelfExecStrategy — CLI invocation fails", () => {
  const REPO: RepoConfig = { ...BASE_REPO, buildCommand: "npm run build" };

  it("returns ran=true, passed=false when CLI invocation fails after successful build", async () => {
    let callCount = 0;
    vi.mocked(execSync).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return "build ok" as any;
      throw Object.assign(new Error("cli fail"), { stderr: Buffer.from("cannot find module") });
    });
    const result = await runSelfExecStrategy(REPO, WORKTREE);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("includes 'self-exec invocation failed' in output when CLI fails", async () => {
    let callCount = 0;
    vi.mocked(execSync).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return "ok" as any;
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("CLI_CRASH") });
    });
    const result = await runSelfExecStrategy(REPO, WORKTREE);
    expect(result.output).toContain("self-exec invocation failed");
    expect(result.output).toContain("CLI_CRASH");
  });
});

describe("runSelfExecStrategy — both pass", () => {
  const REPO: RepoConfig = { ...BASE_REPO, buildCommand: "npm run build" };

  it("returns ran=true, passed=true when build and CLI both succeed", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    const result = await runSelfExecStrategy(REPO, WORKTREE);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("calls execSync twice: once for build, once for CLI invocation", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSelfExecStrategy(REPO, WORKTREE);
    expect(execSync).toHaveBeenCalledTimes(2);
  });

  it("calls build command with the worktree as cwd", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSelfExecStrategy(REPO, WORKTREE);
    expect(execSync).toHaveBeenCalledWith(
      "npm run build",
      expect.objectContaining({ cwd: WORKTREE }),
    );
  });
});

describe("runSelfExecStrategy — CLI invocation fallback", () => {
  const REPO: RepoConfig = { ...BASE_REPO, buildCommand: "npm run build" };

  it("defaults to 'node dist/cli.js --help' when smokeCommand is absent", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSelfExecStrategy(REPO, WORKTREE);
    expect(execSync).toHaveBeenCalledWith(
      "node dist/cli.js --help",
      expect.objectContaining({ cwd: WORKTREE }),
    );
  });

  it("uses repo.smokeCommand when configured", async () => {
    const repoWithSmoke: RepoConfig = { ...REPO, smokeCommand: "node dist/cli.js doctor" };
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSelfExecStrategy(repoWithSmoke, WORKTREE);
    expect(execSync).toHaveBeenCalledWith(
      "node dist/cli.js doctor",
      expect.objectContaining({ cwd: WORKTREE }),
    );
  });
});
