/**
 * Tests for src/integration/strategies/smoke.ts
 *
 * Covers:
 *  - missing smokeCommand → needsClarification
 *  - build fails → ran=true, passed=false
 *  - smoke command fails → ran=true, passed=false
 *  - both pass → ran=true, passed=true
 *  - fallback defaults for buildCmd and timeout
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { runSmokeStrategy } from "./smoke.js";
import type { RepoConfig } from "../../config.js";

const BASE_REPO: RepoConfig = {
  name: "smoke-repo",
  localPath: "/repos/smoke-repo",
  githubOrg: "acme",
  githubRepo: "smoker",
  defaultBranch: "main",
};

const WORKTREE = "/data/worktrees/ym-smoke";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("runSmokeStrategy — missing smokeCommand", () => {
  it("returns ran=false, passed=false when smokeCommand is not configured", async () => {
    const result = await runSmokeStrategy(BASE_REPO, WORKTREE);
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("returns needsClarification=true when smokeCommand is not configured", async () => {
    const result = await runSmokeStrategy(BASE_REPO, WORKTREE);
    expect(result.needsClarification).toBe(true);
  });

  it("returns attempts=0 when smokeCommand is not configured", async () => {
    const result = await runSmokeStrategy(BASE_REPO, WORKTREE);
    expect(result.attempts).toBe(0);
  });

  it("includes the repo name in clarification questions", async () => {
    const result = await runSmokeStrategy(BASE_REPO, WORKTREE);
    expect(result.clarificationQuestions).toBeDefined();
    const hasRepoName = result.clarificationQuestions!.some((q) => q.includes("smoke-repo"));
    expect(hasRepoName).toBe(true);
  });

  it("does not call execSync when smokeCommand is missing", async () => {
    await runSmokeStrategy(BASE_REPO, WORKTREE);
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe("runSmokeStrategy — build fails", () => {
  const REPO: RepoConfig = { ...BASE_REPO, smokeCommand: "node dist/cli.js --help" };

  it("returns ran=true, passed=false when build fails", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("build error"), { stderr: Buffer.from("compile error") });
    });
    const result = await runSmokeStrategy(REPO, WORKTREE);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("includes 'build failed' and stderr in output", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("TS_ERROR_42") });
    });
    const result = await runSmokeStrategy(REPO, WORKTREE);
    expect(result.output).toContain("build failed");
    expect(result.output).toContain("TS_ERROR_42");
  });

  it("attempts=1 when build fails", async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error("fail"); });
    const result = await runSmokeStrategy(REPO, WORKTREE);
    expect(result.attempts).toBe(1);
  });
});

describe("runSmokeStrategy — smoke command fails", () => {
  const REPO: RepoConfig = { ...BASE_REPO, smokeCommand: "node dist/cli.js --help" };

  it("returns ran=true, passed=false when smoke command fails after successful build", async () => {
    let callCount = 0;
    vi.mocked(execSync).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return "build ok" as any; // build succeeds
      throw Object.assign(new Error("cli fail"), { stderr: Buffer.from("exit 1") });
    });
    const result = await runSmokeStrategy(REPO, WORKTREE);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("includes 'smoke command failed' and error in output", async () => {
    let callCount = 0;
    vi.mocked(execSync).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return "build ok" as any;
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("CLI_CRASH") });
    });
    const result = await runSmokeStrategy(REPO, WORKTREE);
    expect(result.output).toContain("smoke command failed");
    expect(result.output).toContain("CLI_CRASH");
  });
});

describe("runSmokeStrategy — both pass", () => {
  const REPO: RepoConfig = { ...BASE_REPO, smokeCommand: "node dist/cli.js --help" };

  it("returns ran=true, passed=true when build and smoke both succeed", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    const result = await runSmokeStrategy(REPO, WORKTREE);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("calls execSync twice: once for build, once for smoke command", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSmokeStrategy(REPO, WORKTREE);
    expect(execSync).toHaveBeenCalledTimes(2);
  });
});

describe("runSmokeStrategy — build command fallback", () => {
  const REPO: RepoConfig = { ...BASE_REPO, smokeCommand: "node dist/cli.js --help" };

  it("uses repo.checkCommand when provided", async () => {
    const repoWithCheck: RepoConfig = { ...REPO, checkCommand: "npx tsc --noEmit" };
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSmokeStrategy(repoWithCheck, WORKTREE);
    expect(execSync).toHaveBeenCalledWith(
      "npx tsc --noEmit",
      expect.objectContaining({ cwd: WORKTREE }),
    );
  });

  it("defaults to 'npm run build' when checkCommand is absent", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSmokeStrategy(REPO, WORKTREE);
    expect(execSync).toHaveBeenCalledWith(
      "npm run build",
      expect.objectContaining({ cwd: WORKTREE }),
    );
  });
});

describe("runSmokeStrategy — smokeTimeoutMs", () => {
  const REPO: RepoConfig = { ...BASE_REPO, smokeCommand: "node dist/cli.js --help" };

  it("uses repo.smokeTimeoutMs when configured", async () => {
    const repoWithTimeout: RepoConfig = { ...REPO, smokeTimeoutMs: 5_000 };
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSmokeStrategy(repoWithTimeout, WORKTREE);
    // Second execSync call (the smoke command) should use the configured timeout
    const secondCall = vi.mocked(execSync).mock.calls[1];
    expect((secondCall[1] as any).timeout).toBe(5_000);
  });

  it("defaults smoke timeout to 120_000 when smokeTimeoutMs is absent", async () => {
    vi.mocked(execSync).mockReturnValue("ok" as any);
    await runSmokeStrategy(REPO, WORKTREE);
    const secondCall = vi.mocked(execSync).mock.calls[1];
    expect((secondCall[1] as any).timeout).toBe(120_000);
  });
});
