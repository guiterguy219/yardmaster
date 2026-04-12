import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { verifyCheckOrFix } from "../agents/verify-check.js";
import type { RepoConfig } from "../config.js";

const CHECK_CMD = "npx tsc --noEmit";
const STDERR = "src/foo.ts(1,1): error TS2322: type error";

function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "test-repo",
    localPath: "/tmp/test-repo",
    githubOrg: "acme",
    githubRepo: "test-repo",
    defaultBranch: "main",
    checkCommand: CHECK_CMD,
    ...overrides,
  };
}

function setupCheck(failuresBeforePass: number): void {
  let calls = 0;
  vi.mocked(execSync).mockImplementation(() => {
    calls++;
    if (calls <= failuresBeforePass) {
      const err: any = new Error("Type error");
      err.stderr = Buffer.from(STDERR);
      throw err;
    }
    return Buffer.from("");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyCheckOrFix", () => {
  it("returns skipped=true when repo has no checkCommand", async () => {
    const fixWith = vi.fn();
    const result = await verifyCheckOrFix(
      makeRepo({ checkCommand: undefined }),
      "/tmp/wt",
      "test",
      fixWith,
    );
    expect(result).toEqual({ passed: true, attempts: 0, skipped: true });
    expect(fixWith).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });

  it("returns passed=true with attempts=0 when initial check passes", async () => {
    setupCheck(0);
    const fixWith = vi.fn();

    const result = await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith);

    expect(result).toEqual({ passed: true, attempts: 0 });
    expect(fixWith).not.toHaveBeenCalled();
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it("calls fixWith with error output and passes after one fix", async () => {
    setupCheck(1);
    const fixWith = vi.fn().mockResolvedValue(undefined);

    const result = await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith);

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(fixWith).toHaveBeenCalledTimes(1);
    expect(fixWith).toHaveBeenCalledWith(expect.stringContaining(STDERR));
  });

  it("retries up to maxAttempts and returns failure on exhaustion", async () => {
    setupCheck(10);
    const fixWith = vi.fn().mockResolvedValue(undefined);

    const result = await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith, 2);

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.output).toContain(STDERR);
    expect(fixWith).toHaveBeenCalledTimes(2);
  });

  it("respects custom maxAttempts", async () => {
    setupCheck(10);
    const fixWith = vi.fn().mockResolvedValue(undefined);

    const result = await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith, 4);

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(4);
    expect(fixWith).toHaveBeenCalledTimes(4);
  });

  it("passes after exactly maxAttempts when last fix succeeds", async () => {
    setupCheck(2);
    const fixWith = vi.fn().mockResolvedValue(undefined);

    const result = await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith, 2);

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fixWith).toHaveBeenCalledTimes(2);
  });

  it("invokes execSync with correct cwd and stdio options", async () => {
    setupCheck(0);
    const fixWith = vi.fn();

    await verifyCheckOrFix(makeRepo(), "/tmp/my-worktree", "coder", fixWith);

    expect(execSync).toHaveBeenCalledWith(CHECK_CMD, {
      cwd: "/tmp/my-worktree",
      encoding: "utf-8",
      stdio: "pipe",
    });
  });

  it("skips the fix loop and returns failure immediately when maxAttempts=0", async () => {
    setupCheck(10);
    const fixWith = vi.fn().mockResolvedValue(undefined);

    const result = await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith, 0);

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.output).toContain(STDERR);
    expect(fixWith).not.toHaveBeenCalled();
  });

  describe("captureOutput fallback paths", () => {
    function throwOnCheck(errFactory: () => unknown): void {
      vi.mocked(execSync).mockImplementationOnce(() => { throw errFactory(); });
    }

    it("captures stdout when stderr is absent", async () => {
      const STDOUT_MSG = "stdout type error line";
      throwOnCheck(() => {
        const err: any = new Error("ignored");
        delete err.stderr;
        err.stdout = Buffer.from(STDOUT_MSG);
        return err;
      });
      const fixWith = vi.fn().mockResolvedValue(undefined);
      // second call (after fix) passes
      vi.mocked(execSync).mockImplementationOnce(() => Buffer.from(""));

      const result = await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith, 1);

      expect(fixWith).toHaveBeenCalledWith(expect.stringContaining(STDOUT_MSG));
      expect(result.passed).toBe(true);
    });

    it("captures message when stderr and stdout are absent", async () => {
      const MSG = "raw error message";
      throwOnCheck(() => new Error(MSG));
      const fixWith = vi.fn().mockResolvedValue(undefined);
      vi.mocked(execSync).mockImplementationOnce(() => Buffer.from(""));

      const result = await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith, 1);

      expect(fixWith).toHaveBeenCalledWith(expect.stringContaining(MSG));
      expect(result.passed).toBe(true);
    });

    it("stringifies non-object throws", async () => {
      throwOnCheck(() => "plain string error");
      const fixWith = vi.fn().mockResolvedValue(undefined);
      vi.mocked(execSync).mockImplementationOnce(() => Buffer.from(""));

      await verifyCheckOrFix(makeRepo(), "/tmp/wt", "coder", fixWith, 1);

      expect(fixWith).toHaveBeenCalledWith(expect.stringContaining("plain string error"));
    });
  });
});
