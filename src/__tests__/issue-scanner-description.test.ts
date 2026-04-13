import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any module imports so Vitest hoists them correctly
// ---------------------------------------------------------------------------

vi.mock("node:child_process");

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../db.js", async () => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS queued_issues (
      issue_ref TEXT PRIMARY KEY,
      job_id    TEXT NOT NULL,
      queued_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return { getDb: () => db };
});

vi.mock("../agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../queue/task-queue.js", () => ({
  enqueueTask: vi.fn(),
}));

vi.mock("../issue-lifecycle.js", () => ({
  notifyQueued: vi.fn(),
}));

vi.mock("../gh-auth.js", () => ({
  ghExecEnv: vi.fn(),
  orgFromIssueRef: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { enqueueTask } from "../queue/task-queue.js";
import { notifyQueued } from "../issue-lifecycle.js";
import { ghExecEnv } from "../gh-auth.js";
import { scanReposForIssues } from "../issue-scanner.js";
import type { YardmasterConfig } from "../config.js";
import { getDb } from "../db.js";

const mockExecSync = vi.mocked(execSync);
const mockLoadConfig = vi.mocked(loadConfig);
const mockEnqueueTask = vi.mocked(enqueueTask);
const mockNotifyQueued = vi.mocked(notifyQueued);
const mockGhExecEnv = vi.mocked(ghExecEnv);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_ENV = { GH_TOKEN: "tok", PATH: "/usr/bin" } as NodeJS.ProcessEnv;

const MINIMAL_CONFIG: YardmasterConfig = {
  repos: [
    {
      name: "myrepo",
      localPath: "/home/user/code/myrepo",
      githubOrg: "acme",
      githubRepo: "myrepo",
      defaultBranch: "main",
    },
  ],
  dataDir: "/tmp/data",
  worktreeBaseDir: "/tmp/worktrees",
  claudeBinary: "claude",
  defaultModel: "sonnet",
  maxConcurrentAgents: 1,
  timeouts: { coder: 600_000, reviewer: 300_000, gitAgent: 180_000, diagnostician: 120_000, diagnosticianEscalated: 180_000 },
};

function makeIssue(overrides: { number?: number; title?: string; body?: string; labels?: Array<{ name: string }> } = {}) {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? "Fix login bug",
    body: overrides.body ?? "When the user clicks login, nothing happens.",
    labels: overrides.labels ?? [{ name: "ym" }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanReposForIssues — taskDescription format", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGhExecEnv.mockReturnValue(FAKE_ENV);
    mockLoadConfig.mockReturnValue(MINIMAL_CONFIG);
    mockEnqueueTask.mockResolvedValue("job-001");
    mockNotifyQueued.mockResolvedValue(undefined);
    // Clear queued_issues between tests so no skips
    getDb().prepare("DELETE FROM queued_issues").run();
  });

  it("passes a taskDescription that contains the issue title", async () => {
    const issue = makeIssue({ title: "Add dark mode support" });
    mockExecSync.mockReturnValue(JSON.stringify([issue]));

    await scanReposForIssues(MINIMAL_CONFIG);

    expect(mockEnqueueTask).toHaveBeenCalledOnce();
    const [, description] = mockEnqueueTask.mock.calls[0];
    expect(description).toContain("Add dark mode support");
  });

  it("passes a taskDescription that contains the Closes trailer", async () => {
    const issue = makeIssue({ number: 42 });
    mockExecSync.mockReturnValue(JSON.stringify([issue]));

    await scanReposForIssues(MINIMAL_CONFIG);

    expect(mockEnqueueTask).toHaveBeenCalledOnce();
    const [, description] = mockEnqueueTask.mock.calls[0];
    expect(description).toContain("Closes acme/myrepo#42");
  });

  it("does NOT include issue.body in the taskDescription (body is fetched fresh at pickup)", async () => {
    const issue = makeIssue({
      body: "BODY_SENTINEL: detailed steps to reproduce the bug",
    });
    mockExecSync.mockReturnValue(JSON.stringify([issue]));

    await scanReposForIssues(MINIMAL_CONFIG);

    expect(mockEnqueueTask).toHaveBeenCalledOnce();
    const [, description] = mockEnqueueTask.mock.calls[0];
    expect(description).not.toContain("BODY_SENTINEL");
  });

  it("queues the task against the correct repo name", async () => {
    const issue = makeIssue();
    mockExecSync.mockReturnValue(JSON.stringify([issue]));

    await scanReposForIssues(MINIMAL_CONFIG);

    expect(mockEnqueueTask).toHaveBeenCalledOnce();
    const [repoName] = mockEnqueueTask.mock.calls[0];
    expect(repoName).toBe("myrepo");
  });

  it("skips an issue that was already queued", async () => {
    const issue = makeIssue({ number: 7 });
    // Pre-populate the queued_issues table
    getDb()
      .prepare("INSERT INTO queued_issues (issue_ref, job_id) VALUES (?, ?)")
      .run("acme/myrepo#7", "existing-job");

    mockExecSync.mockReturnValue(JSON.stringify([issue]));

    const result = await scanReposForIssues(MINIMAL_CONFIG);

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.queued).toBe(0);
  });
});
