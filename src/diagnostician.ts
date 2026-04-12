import { execSync, execFileSync } from "node:child_process";
import type { YardmasterConfig, RepoConfig } from "./config.js";
import { getDb } from "./db.js";
import { runDiagnostician, type DiagnosticResult } from "./agents/diagnostician.js";
import type { DiagnosticContext } from "./prompts/diagnostician.js";

export type DiagnosticActionType = "retry" | "retry_with_spec" | "create_issue" | "escalate" | "give_up";

export interface DiagnosticLoopResult {
  recovered: boolean;
  diagnosis: string;
  action: DiagnosticActionType;
  newSpec?: string;
}

export async function runDiagnosticLoop(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  failureStage: string,
  errorMessage: string,
  description: string
): Promise<DiagnosticLoopResult> {
  console.log(`  Running diagnostician (sonnet)...`);

  const context = gatherDiagnosticContext(
    taskId,
    description,
    failureStage,
    errorMessage,
    repo,
    worktreePath
  );

  let result = await runDiagnostician(config, context, "sonnet");
  console.log(`  Diagnosis: ${result.diagnosis.slice(0, 150)}`);
  console.log(`  Category: ${result.category}, Action: ${result.action.type}`);

  // Handle escalation to opus
  if (result.action.type === "escalate") {
    console.log(`  Escalating to opus: ${result.action.reason}`);
    context.priorDiagnosis = result.diagnosis;
    result = await runDiagnostician(config, context, "opus");
    console.log(`  Opus diagnosis: ${result.diagnosis.slice(0, 150)}`);
    console.log(`  Category: ${result.category}, Action: ${result.action.type}`);

    // Prevent infinite escalation — opus cannot escalate further
    if (result.action.type === "escalate") {
      result = {
        ...result,
        action: { type: "give_up", reason: "Escalation limit reached — opus cannot escalate further" },
      };
    }
  }

  return handleAction(repo, result);
}

function gatherDiagnosticContext(
  taskId: string,
  description: string,
  failureStage: string,
  errorMessage: string,
  repo: RepoConfig,
  worktreePath: string
): DiagnosticContext {
  // Gather task logs from SQLite
  const db = getDb();
  const rawLogs = db
    .prepare(
      "SELECT agent, round, result_summary, duration_ms, success FROM task_logs WHERE task_id = ? ORDER BY created_at ASC"
    )
    .all(taskId) as Array<{
    agent: string;
    round: number;
    result_summary: string;
    duration_ms: number;
    success: number;
  }>;
  const taskLogs = rawLogs.map((l) => ({
    agent: l.agent,
    round: l.round,
    resultSummary: l.result_summary,
    durationMs: l.duration_ms,
    success: l.success,
  }));

  // Gather git state from worktree
  const gitStatus = safeExec("git status --short", worktreePath);
  const gitDiffStat = safeExec("git diff --cached --stat", worktreePath);
  const gitLog = safeExec("git log --oneline -3", worktreePath);

  return {
    taskDescription: description,
    failureStage,
    errorMessage,
    taskLogs,
    repoConfig: {
      name: repo.name,
      checkCommand: repo.checkCommand,
      testCommand: repo.testCommand,
    },
    worktreePath,
    gitStatus,
    gitDiffStat,
    gitLog,
  };
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "(command failed)";
  }
}

function handleAction(
  repo: RepoConfig,
  result: DiagnosticResult
): DiagnosticLoopResult {
  switch (result.action.type) {
    case "retry":
      console.log(`  Diagnostician applied fixes: ${result.action.fixes.join(", ") || "(none listed)"}`);
      return {
        recovered: true,
        diagnosis: result.diagnosis,
        action: "retry",
      };

    case "retry_with_spec":
      console.log(`  Diagnostician rewrote task spec`);
      return {
        recovered: true,
        diagnosis: result.diagnosis,
        action: "retry_with_spec",
        newSpec: result.action.newSpec,
      };

    case "create_issue":
      createGitHubIssue(repo, result.action.title, result.action.body);
      return {
        recovered: false,
        diagnosis: result.diagnosis,
        action: "create_issue",
      };

    case "give_up":
      console.log(`  Diagnostician gave up: ${result.action.reason}`);
      return {
        recovered: false,
        diagnosis: result.diagnosis,
        action: "give_up",
      };

    case "escalate": // fall through to give_up — should have been resolved before handleAction
    default:
      return {
        recovered: false,
        diagnosis: result.diagnosis,
        action: "give_up",
      };
  }
}

function createGitHubIssue(
  repo: RepoConfig,
  title: string,
  body: string
): void {
  try {
    const fullBody = `${body}\n\n---\n_Created by Yardmaster diagnostician_`;
    const ghOutput = execFileSync(
      "gh",
      ["issue", "create", "--repo", `${repo.githubOrg}/${repo.githubRepo}`, "--title", title, "--body", fullBody],
      { encoding: "utf-8", stdio: "pipe" }
    );
    console.log(`  Created issue: ${ghOutput.trim()}`);
  } catch (err) {
    console.log(`  Warning: failed to create GitHub issue: ${err instanceof Error ? err.message : String(err)}`);
  }
}
