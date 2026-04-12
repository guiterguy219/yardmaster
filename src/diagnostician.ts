import { execSync } from "node:child_process";
import type { YardmasterConfig, RepoConfig } from "./config.js";
import { getDb } from "./db.js";
import { runDiagnostician } from "./agents/diagnostician.js";
import type { DiagnosticContext, TaskLogEntry, DiagnosticResult } from "./prompts/diagnostician.js";

export interface DiagnosticLoopResult {
  recovered: boolean;
  diagnosis: string;
  category: string;
  actionTaken: string;
  /** If action was retry_with_spec, contains the rewritten description */
  newSpec?: string;
}

/**
 * Run the diagnostic loop after a task failure.
 *
 * Returns whether the task was recovered (caller should retry the failed stage)
 * and what action was taken.
 */
export async function runDiagnosticLoop(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  failureStage: string,
  error: string,
  description: string
): Promise<DiagnosticLoopResult> {
  console.log(`  [Diagnostician] Investigating failure at stage: ${failureStage}`);

  const context = gatherContext(repo, taskId, worktreePath, failureStage, error, description);

  // First attempt with sonnet
  const result = await runDiagnostician(config, taskId, context, "sonnet");
  console.log(`  [Diagnostician] Diagnosis: ${result.diagnosis}`);
  console.log(`  [Diagnostician] Category: ${result.category}, Action: ${result.action.type}`);

  return handleAction(config, repo, taskId, worktreePath, context, result, false);
}

async function handleAction(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  context: DiagnosticContext,
  result: DiagnosticResult,
  isEscalated: boolean
): Promise<DiagnosticLoopResult> {
  const { action } = result;

  switch (action.type) {
    case "retry":
      console.log(`  [Diagnostician] Fixes applied: ${action.fixes.join("; ")}`);
      return {
        recovered: true,
        diagnosis: result.diagnosis,
        category: result.category,
        actionTaken: `retry (fixes: ${action.fixes.join("; ")})`,
      };

    case "retry_with_spec":
      console.log(`  [Diagnostician] Rewritten spec: ${action.newSpec.slice(0, 100)}...`);
      return {
        recovered: true,
        diagnosis: result.diagnosis,
        category: result.category,
        actionTaken: "retry_with_spec",
        newSpec: action.newSpec,
      };

    case "escalate": {
      if (isEscalated) {
        // Already escalated once — don't recurse further
        console.log(`  [Diagnostician] Already escalated, creating issue instead`);
        return createIssueResult(config, repo, taskId, result, context);
      }
      console.log(`  [Diagnostician] Escalating to opus: ${action.reason}`);
      const escalatedContext: DiagnosticContext = {
        ...context,
        priorDiagnosis: result.diagnosis,
      };
      const opusResult = await runDiagnostician(config, taskId, escalatedContext, "opus");
      console.log(`  [Diagnostician/opus] Diagnosis: ${opusResult.diagnosis}`);
      console.log(`  [Diagnostician/opus] Category: ${opusResult.category}, Action: ${opusResult.action.type}`);
      return handleAction(config, repo, taskId, worktreePath, escalatedContext, opusResult, true);
    }

    case "create_issue":
      return createIssueResult(config, repo, taskId, result, context);

    case "give_up":
      console.log(`  [Diagnostician] Giving up: ${action.reason}`);
      return {
        recovered: false,
        diagnosis: result.diagnosis,
        category: result.category,
        actionTaken: `give_up: ${action.reason}`,
      };

    default:
      return {
        recovered: false,
        diagnosis: result.diagnosis,
        category: result.category,
        actionTaken: "give_up: unknown action type",
      };
  }
}

function createIssueResult(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  result: DiagnosticResult,
  context: DiagnosticContext
): DiagnosticLoopResult {
  const action = result.action;
  const title = action.type === "create_issue" ? action.title : `Pipeline failure: ${result.category} in ${context.failureStage}`;
  const body = action.type === "create_issue"
    ? action.body
    : `## Diagnosis\n\n${result.diagnosis}\n\n## Context\n\n- Task: ${taskId}\n- Stage: ${context.failureStage}\n- Category: ${result.category}`;

  try {
    const ymRepo = config.repos.find((r) => r.name === "yardmaster");
    const targetOrg = ymRepo?.githubOrg ?? repo.githubOrg;
    const targetRepo = ymRepo?.githubRepo ?? repo.githubRepo;
    execSync(
      `gh issue create --repo "${targetOrg}/${targetRepo}" --title ${shellEscape(title.slice(0, 200))} --body ${shellEscape(body.slice(0, 4000))} --label "ym,ym-diagnostician"`,
      { stdio: "pipe", timeout: 15_000 }
    );
    console.log(`  [Diagnostician] Created GitHub issue: ${title}`);
  } catch (err) {
    console.log(`  [Diagnostician] Failed to create issue: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    recovered: false,
    diagnosis: result.diagnosis,
    category: result.category,
    actionTaken: `create_issue: ${title}`,
  };
}

function gatherContext(
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  failureStage: string,
  error: string,
  description: string
): DiagnosticContext {
  // Gather task logs
  const taskLogs = getDb()
    .prepare(
      "SELECT agent, round, prompt_summary, result_summary, duration_ms, success FROM task_logs WHERE task_id = ? ORDER BY created_at ASC"
    )
    .all(taskId) as TaskLogEntry[];

  // Gather git state
  let gitState = "";
  try {
    const status = execSync("git status --short", { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const diffStat = execSync("git diff --cached --stat", { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const log = execSync("git log --oneline -3", { cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    gitState = `$ git status --short\n${status}\n$ git diff --cached --stat\n${diffStat}\n$ git log --oneline -3\n${log}`;
  } catch {
    gitState = "(could not retrieve git state)";
  }

  return {
    taskDescription: description,
    failureStage,
    error,
    taskLogs,
    repoName: repo.name,
    checkCommand: repo.checkCommand,
    testCommand: repo.testCommand,
    worktreePath,
    gitState,
  };
}

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
