/**
 * Tests for src/integration/strategies/index.ts
 *
 * Covers the dispatcher: each integrationStrategy value is routed to the
 * correct strategy module, and an undefined strategy falls back to ask-agent.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mocks before imports
// ---------------------------------------------------------------------------

vi.mock("./full-docker.js", () => ({
  runFullDockerStrategy: vi.fn().mockResolvedValue({ ran: true, passed: true, output: "full-docker", attempts: 1 }),
}));

vi.mock("./test-suite.js", () => ({
  runTestSuiteStrategy: vi.fn().mockResolvedValue({ ran: true, passed: true, output: "test-suite", attempts: 1 }),
}));

vi.mock("./smoke.js", () => ({
  runSmokeStrategy: vi.fn().mockResolvedValue({ ran: true, passed: true, output: "smoke", attempts: 1 }),
}));

vi.mock("./self-exec.js", () => ({
  runSelfExecStrategy: vi.fn().mockResolvedValue({ ran: true, passed: true, output: "self-exec", attempts: 1 }),
}));

vi.mock("./ask-agent.js", () => ({
  runAskAgentStrategy: vi.fn().mockResolvedValue({ ran: false, passed: false, output: "ask-agent", attempts: 0, needsClarification: true }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runIntegrationStrategy } from "./index.js";
import { runFullDockerStrategy } from "./full-docker.js";
import { runTestSuiteStrategy } from "./test-suite.js";
import { runSmokeStrategy } from "./smoke.js";
import { runSelfExecStrategy } from "./self-exec.js";
import { runAskAgentStrategy } from "./ask-agent.js";
import type { YardmasterConfig, RepoConfig } from "../../config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: YardmasterConfig = {
  repos: [],
  dataDir: "/tmp/data",
  worktreeBaseDir: "/tmp/data/worktrees",
  claudeBinary: "claude",
  defaultModel: "sonnet",
  maxConcurrentAgents: 1,
  timeouts: { coder: 60_000, reviewer: 60_000, gitAgent: 60_000, diagnostician: 180_000, diagnosticianEscalated: 300_000 },
};

function makeRepo(strategy?: RepoConfig["integrationStrategy"]): RepoConfig {
  return {
    name: "dispatch-repo",
    localPath: "/repos/dispatch-repo",
    githubOrg: "acme",
    githubRepo: "dispatch",
    defaultBranch: "main",
    integrationStrategy: strategy,
  };
}

const WORKTREE = "/data/worktrees/ym-dispatch";
const TASK_ID = "task-abc";
const DESCRIPTION = "add feature";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runIntegrationStrategy — strategy dispatch", () => {
  it("delegates to runFullDockerStrategy when strategy is 'full-docker'", async () => {
    await runIntegrationStrategy(CONFIG, makeRepo("full-docker"), TASK_ID, WORKTREE, DESCRIPTION);
    expect(runFullDockerStrategy).toHaveBeenCalledOnce();
    expect(runTestSuiteStrategy).not.toHaveBeenCalled();
  });

  it("delegates to runTestSuiteStrategy when strategy is 'test-suite'", async () => {
    await runIntegrationStrategy(CONFIG, makeRepo("test-suite"), TASK_ID, WORKTREE, DESCRIPTION);
    expect(runTestSuiteStrategy).toHaveBeenCalledOnce();
    expect(runFullDockerStrategy).not.toHaveBeenCalled();
  });

  it("delegates to runSmokeStrategy when strategy is 'smoke'", async () => {
    await runIntegrationStrategy(CONFIG, makeRepo("smoke"), TASK_ID, WORKTREE, DESCRIPTION);
    expect(runSmokeStrategy).toHaveBeenCalledOnce();
  });

  it("delegates to runSelfExecStrategy when strategy is 'self-exec'", async () => {
    await runIntegrationStrategy(CONFIG, makeRepo("self-exec"), TASK_ID, WORKTREE, DESCRIPTION);
    expect(runSelfExecStrategy).toHaveBeenCalledOnce();
  });

  it("delegates to runAskAgentStrategy when strategy is 'ask-agent'", async () => {
    await runIntegrationStrategy(CONFIG, makeRepo("ask-agent"), TASK_ID, WORKTREE, DESCRIPTION);
    expect(runAskAgentStrategy).toHaveBeenCalledOnce();
  });

  it("falls back to runAskAgentStrategy when integrationStrategy is undefined", async () => {
    const repo = makeRepo(undefined);
    await runIntegrationStrategy(CONFIG, repo, TASK_ID, WORKTREE, DESCRIPTION);
    expect(runAskAgentStrategy).toHaveBeenCalledOnce();
  });
});

describe("runIntegrationStrategy — return values pass through", () => {
  it("returns the result from the delegated strategy", async () => {
    const result = await runIntegrationStrategy(CONFIG, makeRepo("smoke"), TASK_ID, WORKTREE, DESCRIPTION);
    expect(result.output).toBe("smoke");
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("returns needsClarification from ask-agent strategy", async () => {
    const result = await runIntegrationStrategy(CONFIG, makeRepo("ask-agent"), TASK_ID, WORKTREE, DESCRIPTION);
    expect(result.needsClarification).toBe(true);
    expect(result.ran).toBe(false);
  });
});

describe("runIntegrationStrategy — argument forwarding", () => {
  it("passes repo and worktreePath to runSmokeStrategy", async () => {
    const repo = makeRepo("smoke");
    await runIntegrationStrategy(CONFIG, repo, TASK_ID, WORKTREE, DESCRIPTION);
    expect(runSmokeStrategy).toHaveBeenCalledWith(repo, WORKTREE);
  });

  it("passes repo to runAskAgentStrategy", async () => {
    const repo = makeRepo("ask-agent");
    await runIntegrationStrategy(CONFIG, repo, TASK_ID, WORKTREE, DESCRIPTION);
    expect(runAskAgentStrategy).toHaveBeenCalledWith(repo);
  });

  it("passes all args to runFullDockerStrategy", async () => {
    const repo = makeRepo("full-docker");
    await runIntegrationStrategy(CONFIG, repo, TASK_ID, WORKTREE, DESCRIPTION);
    expect(runFullDockerStrategy).toHaveBeenCalledWith(CONFIG, repo, TASK_ID, WORKTREE, DESCRIPTION);
  });
});
