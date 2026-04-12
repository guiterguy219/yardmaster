/**
 * Tests for src/integration/runner.ts
 *
 * Covers:
 *  - runIntegrationTests: no config → advisor flow (not_applicable / failed /
 *    config_created → reload / config_created but file missing / invalid config),
 *    disabled, Docker unavailable, Docker fail, tests pass on first run,
 *    tests fail then pass after fix, exhausted fix attempts, docker teardown
 *    in finally, testsWritten flag, empty-diff path
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that transitively use these modules
// ---------------------------------------------------------------------------

vi.mock("./config.js", () => ({
  loadIntegrationConfig: vi.fn(),
  integrationConfigPath: vi.fn().mockReturnValue("/data/integration/test-repo.yml"),
}));

vi.mock("./secrets.js", () => ({
  resolveSecrets: vi.fn().mockResolvedValue({}),
  buildIntegrationEnv: vi.fn().mockReturnValue({}),
}));

vi.mock("./docker.js", () => ({
  isDockerAvailable: vi.fn().mockReturnValue(true),
  startServices: vi.fn().mockReturnValue({ started: true, services: ["redis"], error: undefined }),
  stopServices: vi.fn(),
}));

vi.mock("./scaffold.js", () => ({
  scaffoldIntegrationTests: vi.fn().mockReturnValue({ filesCreated: [], filesSkipped: [] }),
}));

vi.mock("../agents/integration-test.js", () => ({
  runIntegrationTestAgent: vi.fn().mockResolvedValue({ wrote: false, summary: "NO_INTEGRATION_TESTS_NEEDED" }),
}));

vi.mock("../agents/coder.js", () => ({
  runCoder: vi.fn().mockResolvedValue({ success: true, result: "", durationMs: 100, error: undefined }),
}));

vi.mock("../agents/integration-advisor.js", () => ({
  runIntegrationAdvisor: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { loadIntegrationConfig, integrationConfigPath } from "./config.js";
import { isDockerAvailable, startServices, stopServices } from "./docker.js";
import { runIntegrationTestAgent } from "../agents/integration-test.js";
import { runCoder } from "../agents/coder.js";
import { runIntegrationAdvisor } from "../agents/integration-advisor.js";
import { runIntegrationTests } from "./runner.js";
import type { YardmasterConfig, RepoConfig } from "../config.js";
import type { IntegrationConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: YardmasterConfig = {
  repos: [],
  dataDir: "/tmp/test-data",
  worktreeBaseDir: "/tmp/test-data/worktrees",
  claudeBinary: "claude",
  defaultModel: "sonnet",
  maxConcurrentAgents: 1,
  timeouts: { coder: 60_000, reviewer: 60_000, gitAgent: 60_000, diagnostician: 180_000, diagnosticianEscalated: 300_000 },
};

const REPO: RepoConfig = {
  name: "test-repo",
  localPath: "/repos/test-repo",
  githubOrg: "acme",
  githubRepo: "widget",
  defaultBranch: "main",
  testCommand: "npx vitest run",
};

const WORKTREE = "/data/worktrees/ym-abc123";
const DESCRIPTION = "add new user endpoint";

function makeIntegrationConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    enabled: true,
    services: { db: { type: "neon" } }, // non-docker by default
    auth: { strategy: "mock-jwt" },
    testCommand: "npx vitest run --integration",
    testTimeout: 30_000,
    ...overrides,
  };
}

/**
 * Helper: set up execSync so the git diff returns the given diff text and
 * the test command either succeeds (testPasses=true) or throws.
 */
function setupExecSync(diffText: string, testPasses: boolean, testOutput = "all good") {
  vi.mocked(execSync).mockImplementation((cmd: unknown) => {
    const command = String(cmd);
    if (command.includes("migration:run")) return Buffer.from("Migrations applied");
    if (command === "git add -A") return Buffer.from("");
    if (command === "git diff --cached") return Buffer.from(diffText);
    // test command
    if (testPasses) return testOutput as any;
    const err = Object.assign(new Error("test failed"), { stderr: Buffer.from("FAIL: assertion error") });
    throw err;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // reset to safe defaults
  vi.mocked(startServices).mockReturnValue({ started: true, services: ["redis"], error: undefined });
  vi.mocked(isDockerAvailable).mockReturnValue(true);
  vi.mocked(runIntegrationTestAgent).mockResolvedValue({ wrote: false, summary: "NO_INTEGRATION_TESTS_NEEDED" });
  vi.mocked(runCoder).mockResolvedValue({ success: true, result: "", durationMs: 100, error: undefined } as any);
  // default advisor response so tests that supply a real config are unaffected
  vi.mocked(runIntegrationAdvisor).mockResolvedValue({ outcome: "not_applicable", summary: "NOT_APPLICABLE: no services" });
});

// ---------------------------------------------------------------------------
// Early-exit paths (ran = false)
// ---------------------------------------------------------------------------

describe("runIntegrationTests — no config: advisor not_applicable", () => {
  beforeEach(() => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(null);
    vi.mocked(runIntegrationAdvisor).mockResolvedValue({
      outcome: "not_applicable",
      summary: "NOT_APPLICABLE: pure CLI tool, no external services",
    });
  });

  it("invokes the integration advisor when loadIntegrationConfig returns null", async () => {
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationAdvisor).toHaveBeenCalledTimes(1);
  });

  it("passes config, repo, worktreePath, configPath and description to the advisor", async () => {
    vi.mocked(integrationConfigPath).mockReturnValue("/data/integration/test-repo.yml");
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationAdvisor).toHaveBeenCalledWith(
      CONFIG,
      REPO,
      WORKTREE,
      "/data/integration/test-repo.yml",
      DESCRIPTION
    );
  });

  it("returns ran=false, passed=true when advisor says not_applicable", async () => {
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(0);
  });

  it("includes advisor summary in output when not_applicable", async () => {
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.output).toContain("not applicable");
  });

  it("does NOT spawn the integration test agent when advisor says not_applicable", async () => {
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationTestAgent).not.toHaveBeenCalled();
  });
});

describe("runIntegrationTests — no config: advisor failed", () => {
  beforeEach(() => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(null);
    vi.mocked(runIntegrationAdvisor).mockResolvedValue({
      outcome: "failed",
      summary: "claude process timed out",
    });
  });

  it("returns ran=false, passed=true when advisor fails (non-blocking)", async () => {
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(0);
  });

  it("includes 'advisor failed' in output when advisor returns failed", async () => {
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.output).toContain("advisor failed");
  });

  it("does NOT spawn the integration test agent when advisor fails", async () => {
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationTestAgent).not.toHaveBeenCalled();
  });
});

describe("runIntegrationTests — no config: advisor config_created", () => {
  it("reloads the integration config after advisor creates it", async () => {
    vi.mocked(loadIntegrationConfig)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(makeIntegrationConfig());
    vi.mocked(runIntegrationAdvisor).mockResolvedValue({
      outcome: "config_created",
      summary: "Wrote config. CONFIG_CREATED",
    });
    setupExecSync("", true);

    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);

    // loadIntegrationConfig called twice: initial check + reload after advisor
    expect(loadIntegrationConfig).toHaveBeenCalledTimes(2);
  });

  it("proceeds to run integration tests after advisor creates a valid config", async () => {
    vi.mocked(loadIntegrationConfig)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(makeIntegrationConfig());
    vi.mocked(runIntegrationAdvisor).mockResolvedValue({
      outcome: "config_created",
      summary: "CONFIG_CREATED",
    });
    setupExecSync("", true);

    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);

    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("returns ran=false, passed=false when advisor reports config_created but file is still missing", async () => {
    vi.mocked(loadIntegrationConfig)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null); // still null after advisor
    vi.mocked(runIntegrationAdvisor).mockResolvedValue({
      outcome: "config_created",
      summary: "CONFIG_CREATED",
    });
    vi.mocked(integrationConfigPath).mockReturnValue("/data/integration/test-repo.yml");

    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);

    expect(result.ran).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("CONFIG_CREATED");
    expect(result.output).toContain("/data/integration/test-repo.yml");
  });

  it("returns ran=false, passed=false when advisor creates an invalid config (parse error)", async () => {
    vi.mocked(loadIntegrationConfig)
      .mockReturnValueOnce(null)
      .mockImplementationOnce(() => {
        throw new Error("Invalid integration config: 'enabled' must be a boolean");
      });
    vi.mocked(runIntegrationAdvisor).mockResolvedValue({
      outcome: "config_created",
      summary: "CONFIG_CREATED",
    });

    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);

    expect(result.ran).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("advisor produced invalid config");
    expect(result.output).toContain("'enabled' must be a boolean");
  });
});

describe("runIntegrationTests — config.enabled false", () => {
  it("returns ran=false when config.enabled is false", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(makeIntegrationConfig({ enabled: false }));
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.output).toBe("integration tests disabled");
  });

  it("does NOT invoke the advisor when config.enabled is false", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(makeIntegrationConfig({ enabled: false }));
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationAdvisor).not.toHaveBeenCalled();
  });

  it("does NOT spawn the integration test agent when config.enabled is false", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(makeIntegrationConfig({ enabled: false }));
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationTestAgent).not.toHaveBeenCalled();
  });
});

describe("runIntegrationTests — Docker not available", () => {
  it("returns ran=false when docker-* services exist but Docker is unavailable", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(
      makeIntegrationConfig({ services: { cache: { type: "docker-redis" } } })
    );
    vi.mocked(isDockerAvailable).mockReturnValue(false);
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.output).toBe("Docker not available");
  });

  it("does NOT skip when only non-docker services exist and Docker is unavailable", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(makeIntegrationConfig()); // neon only
    vi.mocked(isDockerAvailable).mockReturnValue(false);
    setupExecSync("", true);
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    // Should have proceeded (ran=true)
    expect(result.ran).toBe(true);
  });
});

describe("runIntegrationTests — Docker start failure", () => {
  it("returns ran=true, passed=false when Docker services fail to start", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(
      makeIntegrationConfig({ services: { cache: { type: "docker-redis" } } })
    );
    vi.mocked(startServices).mockReturnValue({ started: false, services: ["cache"], error: "daemon unreachable" });
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("Docker failed");
    expect(result.output).toContain("daemon unreachable");
  });

  it("includes 'unknown error' when Docker start fails with no error message", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(
      makeIntegrationConfig({ services: { cache: { type: "docker-redis" } } })
    );
    vi.mocked(startServices).mockReturnValue({ started: false, services: [], error: undefined });
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.output).toContain("unknown error");
  });
});

// ---------------------------------------------------------------------------
// Tests pass on first run
// ---------------------------------------------------------------------------

describe("runIntegrationTests — tests pass immediately", () => {
  beforeEach(() => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(makeIntegrationConfig());
    setupExecSync("", true, "All tests passed");
  });

  it("returns ran=true, passed=true, attempts=0", async () => {
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(0);
  });

  it("does not call runCoder when tests pass immediately", async () => {
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runCoder).not.toHaveBeenCalled();
  });

  it("returns testsWritten=false when diff is empty", async () => {
    setupExecSync("", true);
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.testsWritten).toBe(false);
  });

  it("does not call runIntegrationTestAgent when diff is empty", async () => {
    setupExecSync("", true);
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationTestAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// testsWritten flag
// ---------------------------------------------------------------------------

describe("runIntegrationTests — testsWritten flag", () => {
  beforeEach(() => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(makeIntegrationConfig());
  });

  it("returns testsWritten=true when agent wrote tests and diff was non-empty", async () => {
    setupExecSync("diff content here", true);
    vi.mocked(runIntegrationTestAgent).mockResolvedValue({ wrote: true, summary: "Wrote integration test" });
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.testsWritten).toBe(true);
  });

  it("returns testsWritten=false when agent reported no tests written", async () => {
    setupExecSync("diff content here", true);
    vi.mocked(runIntegrationTestAgent).mockResolvedValue({ wrote: false, summary: "NO_INTEGRATION_TESTS_NEEDED" });
    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.testsWritten).toBe(false);
  });

  it("passes auth strategy from config to runIntegrationTestAgent", async () => {
    setupExecSync("diff content here", true);
    vi.mocked(loadIntegrationConfig).mockReturnValue(
      makeIntegrationConfig({ auth: { strategy: "mock-jwt" } })
    );
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationTestAgent).toHaveBeenCalledWith(
      CONFIG,
      REPO,
      expect.any(String),
      WORKTREE,
      expect.any(Object),
      "mock-jwt",
    );
  });

  it("passes undefined auth strategy when config has no auth block", async () => {
    setupExecSync("diff content here", true);
    const cfg = makeIntegrationConfig();
    // Remove auth entirely
    delete (cfg as any).auth;
    vi.mocked(loadIntegrationConfig).mockReturnValue(cfg);
    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(runIntegrationTestAgent).toHaveBeenCalledWith(
      CONFIG,
      REPO,
      expect.any(String),
      WORKTREE,
      expect.any(Object),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Fix attempts
// ---------------------------------------------------------------------------

describe("runIntegrationTests — fix attempts", () => {
  beforeEach(() => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(makeIntegrationConfig());
  });

  it("calls runCoder once and returns passed=true when tests pass after first fix", async () => {
    let testCallCount = 0;
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes("migration:run")) return Buffer.from("");
      if (command === "git add -A") return Buffer.from("");
      if (command === "git diff --cached") return Buffer.from("");
      // test command: fail first, pass second
      testCallCount++;
      if (testCallCount === 1) {
        throw Object.assign(new Error("fail"), { stderr: Buffer.from("assertion failed") });
      }
      return "all ok" as any;
    });

    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(runCoder).toHaveBeenCalledTimes(1);
  });

  it("exhausts MAX_FIX_ATTEMPTS (2) and returns passed=false", async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes("migration:run")) return Buffer.from("");
      if (command === "git add -A") return Buffer.from("");
      if (command === "git diff --cached") return Buffer.from("");
      // test command always fails
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("still failing") });
    });

    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(runCoder).toHaveBeenCalledTimes(2);
  });

  it("includes failed test output in the result", async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes("migration:run")) return Buffer.from("");
      if (command === "git add -A") return Buffer.from("");
      if (command === "git diff --cached") return Buffer.from("");
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("SPECIFIC_FAILURE_OUTPUT") });
    });

    const result = await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(result.output).toContain("SPECIFIC_FAILURE_OUTPUT");
  });
});

// ---------------------------------------------------------------------------
// Docker teardown in finally block
// ---------------------------------------------------------------------------

describe("runIntegrationTests — Docker teardown", () => {
  it("calls stopServices in finally block when Docker was started", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(
      makeIntegrationConfig({ services: { cache: { type: "docker-redis" } } })
    );
    vi.mocked(startServices).mockReturnValue({ started: true, services: ["cache"], error: undefined });
    setupExecSync("", true);

    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(stopServices).toHaveBeenCalledWith(REPO.name);
  });

  it("calls stopServices even when tests fail after fix attempts", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(
      makeIntegrationConfig({ services: { cache: { type: "docker-redis" } } })
    );
    vi.mocked(startServices).mockReturnValue({ started: true, services: ["cache"], error: undefined });
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes("migration:run")) return Buffer.from("");
      if (command === "git add -A") return Buffer.from("");
      if (command === "git diff --cached") return Buffer.from("");
      throw Object.assign(new Error("fail"), { stderr: Buffer.from("error") });
    });

    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(stopServices).toHaveBeenCalledWith(REPO.name);
  });

  it("does NOT call stopServices when no Docker services were started", async () => {
    vi.mocked(loadIntegrationConfig).mockReturnValue(makeIntegrationConfig()); // neon only
    setupExecSync("", true);

    await runIntegrationTests(CONFIG, REPO, "t1", WORKTREE, DESCRIPTION);
    expect(stopServices).not.toHaveBeenCalled();
  });
});
