/**
 * Tests for the new per-repo git identity and push-credential checks added to
 * src/doctor.ts:
 *
 *  - getGitConfig: returns trimmed string on success, null on error
 *  - checkRepoGitIdentity: local/global fallback for user.name + user.email,
 *    logs the right source label, marks criticalFailed on missing identity
 *  - checkRepoPushCredentials: dry-run success, timeout (warn-only), hard
 *    failure, and the credential.useHttpPath .git-credentials scan
 *
 * None of those functions are exported, so we test them through runDoctor()
 * with all other checks mocked to pass.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared (and hoisted) before any imports
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../gh-auth.js", () => ({
  // No configured orgs → no token calls; missing is empty → returns true
  auditTokens: vi.fn().mockReturnValue({ configured: [], missing: [] }),
  ghExecEnv: vi.fn().mockReturnValue({}),
}));

import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { runDoctor } from "../doctor.js";

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockLoadConfig = vi.mocked(loadConfig);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_PATH = "/home/testuser/code/my-repo";
const ORG = "myorg";
const REPO_GH = "myrepo";

/** Minimal config shape that runDoctor consumes. */
const MOCK_CONFIG = {
  repos: [
    {
      name: "my-repo",
      localPath: REPO_PATH,
      githubOrg: ORG,
      githubRepo: REPO_GH,
      branch: "main",
      useSerena: false,
    },
  ],
  maxConcurrentAgents: 1,
  claudeBinary: "claude",
  defaultModel: "sonnet",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make execSync always succeed so the non-new checks (git, gh, claude, redis) pass. */
function setupPassingExecSync() {
  mockExecSync.mockReturnValue(Buffer.from("mock-output\n") as any);
}

interface GitMockOptions {
  /** null → git config exits non-zero (key not set) */
  localName?: string | null;
  globalName?: string | null;
  localEmail?: string | null;
  globalEmail?: string | null;
  pushResult?: "success" | "timeout" | "fail";
  localUseHttpPath?: string | null;
  globalUseHttpPath?: string | null;
}

/**
 * Returns an execFileSync implementation that controls the responses for every
 * git call made by doctor.ts:
 *
 *  git ls-remote           → checkRepoRemote (always succeeds)
 *  git -C <p> config …     → local getGitConfig
 *  git config …            → global getGitConfig (fallback)
 *  git -C <p> push …       → checkRepoPushCredentials dry-run
 */
function makeGitImpl(opts: GitMockOptions = {}) {
  const {
    localName = "Local User",
    globalName = "Global User",
    localEmail = "local@example.com",
    globalEmail = "global@example.com",
    pushResult = "success",
    localUseHttpPath = null,
    globalUseHttpPath = null,
  } = opts;

  return (_cmd: unknown, rawArgs: unknown): Buffer => {
    const args = rawArgs as string[];

    // git ls-remote <remote> HEAD — checkRepoRemote
    if (args[0] === "ls-remote") {
      return Buffer.from("abc123\tHEAD\n");
    }

    // git -C <path> push --dry-run origin HEAD — checkRepoPushCredentials
    if (args[0] === "-C" && args[2] === "push") {
      if (pushResult === "success") return Buffer.from("");
      if (pushResult === "timeout") {
        throw Object.assign(new Error("timed out"), { killed: false });
      }
      throw new Error("fatal: unable to connect to origin");
    }

    // git -C <path> config --get <key> — local getGitConfig
    if (args[0] === "-C" && args[2] === "config" && args[3] === "--get") {
      const key = args[4];
      if (key === "user.name") {
        if (localName === null) throw new Error("git config: not set");
        return Buffer.from(localName + "\n");
      }
      if (key === "user.email") {
        if (localEmail === null) throw new Error("git config: not set");
        return Buffer.from(localEmail + "\n");
      }
      if (key === "credential.useHttpPath") {
        if (localUseHttpPath === null) throw new Error("git config: not set");
        return Buffer.from(localUseHttpPath + "\n");
      }
    }

    // git config --get <key> — global getGitConfig (no -C prefix)
    if (args[0] === "config" && args[1] === "--get") {
      const key = args[2];
      if (key === "user.name") {
        if (globalName === null) throw new Error("git config: not set");
        return Buffer.from(globalName + "\n");
      }
      if (key === "user.email") {
        if (globalEmail === null) throw new Error("git config: not set");
        return Buffer.from(globalEmail + "\n");
      }
      if (key === "credential.useHttpPath") {
        if (globalUseHttpPath === null) throw new Error("git config: not set");
        return Buffer.from(globalUseHttpPath + "\n");
      }
    }

    // Default: succeed silently
    return Buffer.from("");
  };
}

/** Silences console.log and returns all logged lines as a single string. */
function captureConsoleLogs(): { getLogs: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return {
    getLogs: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

// ---------------------------------------------------------------------------
// Suite: checkRepoGitIdentity
// ---------------------------------------------------------------------------

describe("doctor — checkRepoGitIdentity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLoadConfig.mockReturnValue(MOCK_CONFIG as any);
    setupPassingExecSync();
    mockExistsSync.mockReturnValue(false);
  });

  it("returns exit code 0 when both user.name and user.email are set locally", async () => {
    mockExecFileSync.mockImplementation(makeGitImpl() as any);
    const { restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();
    expect(exitCode).toBe(0);
  });

  it("logs '(local)' source label when user.name is set in local config", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ localName: "Local User", localEmail: "local@example.com" }) as any,
    );
    const { getLogs, restore } = captureConsoleLogs();
    await runDoctor();
    restore();
    expect(getLogs()).toContain("Local User (local)");
    expect(getLogs()).toContain("local@example.com (local)");
  });

  it("logs '(global)' source label and returns 0 when user.name falls back to global", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({
        localName: null,
        globalName: "Global User",
        localEmail: null,
        globalEmail: "global@example.com",
      }) as any,
    );
    const { getLogs, restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();
    expect(exitCode).toBe(0);
    expect(getLogs()).toContain("Global User (global)");
    expect(getLogs()).toContain("global@example.com (global)");
  });

  it("returns exit code 1 when user.name is missing both locally and globally", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ localName: null, globalName: null }) as any,
    );
    const { restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();
    expect(exitCode).toBe(1);
  });

  it("returns exit code 1 when user.email is missing both locally and globally", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ localEmail: null, globalEmail: null }) as any,
    );
    const { restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();
    expect(exitCode).toBe(1);
  });

  it("returns exit code 1 when both user.name and user.email are missing", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({
        localName: null,
        globalName: null,
        localEmail: null,
        globalEmail: null,
      }) as any,
    );
    const { restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();
    expect(exitCode).toBe(1);
  });

  it("logs a fail hint mentioning git -C when user.name is not set", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ localName: null, globalName: null }) as any,
    );
    const { getLogs, restore } = captureConsoleLogs();
    await runDoctor();
    restore();
    expect(getLogs()).toContain("not set — run: git -C <repo> config user.name");
  });

  it("logs a fail hint mentioning git -C when user.email is not set", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ localEmail: null, globalEmail: null }) as any,
    );
    const { getLogs, restore } = captureConsoleLogs();
    await runDoctor();
    restore();
    expect(getLogs()).toContain("not set — run: git -C <repo> config user.email");
  });
});

// ---------------------------------------------------------------------------
// Suite: checkRepoPushCredentials
// ---------------------------------------------------------------------------

describe("doctor — checkRepoPushCredentials", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLoadConfig.mockReturnValue(MOCK_CONFIG as any);
    setupPassingExecSync();
    mockExistsSync.mockReturnValue(false);
  });

  it("returns exit code 0 when push dry-run succeeds", async () => {
    mockExecFileSync.mockImplementation(makeGitImpl({ pushResult: "success" }) as any);
    const { restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();
    expect(exitCode).toBe(0);
  });

  it("logs 'git push --dry-run OK' on success", async () => {
    mockExecFileSync.mockImplementation(makeGitImpl({ pushResult: "success" }) as any);
    const { getLogs, restore } = captureConsoleLogs();
    await runDoctor();
    restore();
    expect(getLogs()).toContain("git push --dry-run OK");
  });

  it("returns exit code 0 (warn-only) when push dry-run times out", async () => {
    mockExecFileSync.mockImplementation(makeGitImpl({ pushResult: "timeout" }) as any);
    const { restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();
    expect(exitCode).toBe(0);
  });

  it("logs a timeout warning when push dry-run times out", async () => {
    mockExecFileSync.mockImplementation(makeGitImpl({ pushResult: "timeout" }) as any);
    const { getLogs, restore } = captureConsoleLogs();
    await runDoctor();
    restore();
    expect(getLogs()).toContain("timed out — check network");
  });

  it("returns exit code 1 when push dry-run fails with a non-timeout error", async () => {
    mockExecFileSync.mockImplementation(makeGitImpl({ pushResult: "fail" }) as any);
    const { restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();
    expect(exitCode).toBe(1);
  });

  it("logs an SSH/HTTPS credential error message on push failure", async () => {
    mockExecFileSync.mockImplementation(makeGitImpl({ pushResult: "fail" }) as any);
    const { getLogs, restore } = captureConsoleLogs();
    await runDoctor();
    restore();
    expect(getLogs()).toContain("cannot reach origin — verify SSH key or HTTPS credentials");
  });

  it("does not check .git-credentials when credential.useHttpPath is not configured", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ pushResult: "success", localUseHttpPath: null, globalUseHttpPath: null }) as any,
    );
    const { restore } = captureConsoleLogs();
    await runDoctor();
    restore();
    expect(mockExistsSync).not.toHaveBeenCalledWith("/home/testuser/.git-credentials");
  });

  it("passes and logs success when credential.useHttpPath=true and matching entry exists", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ pushResult: "success", localUseHttpPath: "true" }) as any,
    );
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      `https://user:token@github.com/${ORG}/${REPO_GH}\n` as any,
    );

    const { getLogs, restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();

    expect(exitCode).toBe(0);
    expect(getLogs()).toContain(`per-repo entry found for ${ORG}/${REPO_GH}`);
  });

  it("also matches a .git entry (org/repo.git) in .git-credentials", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ pushResult: "success", localUseHttpPath: "true" }) as any,
    );
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      `https://user:token@github.com/${ORG}/${REPO_GH}.git\n` as any,
    );

    const { getLogs, restore } = captureConsoleLogs();
    await runDoctor();
    restore();

    expect(getLogs()).toContain(`per-repo entry found for ${ORG}/${REPO_GH}`);
  });

  it("warns (exit 0) when credential.useHttpPath=true but no matching entry in .git-credentials", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ pushResult: "success", localUseHttpPath: "true" }) as any,
    );
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      "https://user:token@github.com/other-org/other-repo\n" as any,
    );

    const { getLogs, restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();

    expect(exitCode).toBe(0);
    expect(getLogs()).toContain(
      `credential.useHttpPath=true but no entry for ${ORG}/${REPO_GH} in ~/.git-credentials`,
    );
  });

  it("warns (exit 0) when credential.useHttpPath=true but ~/.git-credentials does not exist", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({ pushResult: "success", localUseHttpPath: "true" }) as any,
    );
    mockExistsSync.mockReturnValue(false);

    const { getLogs, restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();

    expect(exitCode).toBe(0);
    expect(getLogs()).toContain(
      "credential.useHttpPath=true but ~/.git-credentials not found",
    );
  });

  it("picks up credential.useHttpPath from global config when not set locally", async () => {
    mockExecFileSync.mockImplementation(
      makeGitImpl({
        pushResult: "success",
        localUseHttpPath: null,  // not set locally
        globalUseHttpPath: "true",
      }) as any,
    );
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      `https://user:token@github.com/${ORG}/${REPO_GH}\n` as any,
    );

    const { getLogs, restore } = captureConsoleLogs();
    const exitCode = await runDoctor();
    restore();

    expect(exitCode).toBe(0);
    expect(getLogs()).toContain(`per-repo entry found for ${ORG}/${REPO_GH}`);
  });
});
