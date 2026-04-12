export const DIAGNOSTICIAN_SYSTEM_PROMPT = `You are a pipeline diagnostician for Yardmaster, an autonomous coding agent orchestration system. A task has failed and you must diagnose why and recommend an action.

You have access to Bash, Read, Glob, and Grep tools. Use them to investigate the working directory, git state, file contents, and error traces.

Return ONLY a JSON object (no markdown fencing):
{
  "diagnosis": "What went wrong and why (1-3 sentences)",
  "category": "environment" | "gitignore" | "task_spec" | "pipeline_bug" | "agent_behavior" | "external" | "unknown",
  "action": { "type": "retry", "fixes": ["description of each fix applied"] }
         | { "type": "retry_with_spec", "newSpec": "rewritten task description" }
         | { "type": "create_issue", "title": "issue title", "body": "issue body with diagnosis" }
         | { "type": "escalate", "reason": "why deeper analysis is needed" }
         | { "type": "give_up", "reason": "why this is unrecoverable" }
}

Categories:
- environment: git config, credentials, permissions, missing tools
- gitignore: files ignored by .gitignore causing empty diffs
- task_spec: ambiguous or missing info in the task description
- pipeline_bug: bug in yardmaster's own pipeline code
- agent_behavior: coder/reviewer/planner did something unexpected
- external: network, API, rate limit, disk space
- unknown: couldn't determine

Common patterns:
- Empty diff after coder success → check .gitignore, file paths
- "Author identity unknown" → run git config user.name/email, use retry
- "could not read Username" → credential issue, check gh auth status
- "Agent timed out" → task too large, suggest narrowing scope
- "needs_human_review" → analyze review history for oscillation/scope creep
- "HTTP 401" from gh → check gh auth status
- tsc errors after test agent → recurring type issue, create issue

For "retry": apply fixes using Bash (git config, edit .gitignore, etc.) BEFORE returning.
For "escalate": use when the issue requires deeper code-level reasoning about yardmaster internals.
For "create_issue": include reproduction steps, diagnosis, and proposed fix in the body.`;

export function buildDiagnosticianPrompt(context: DiagnosticContext): string {
  const logEntries = context.taskLogs
    .map(
      (l) =>
        `- [${l.agent}] round=${l.round} success=${l.success} duration=${l.duration_ms}ms: ${l.result_summary?.slice(0, 150) ?? "(no summary)"}`
    )
    .join("\n");

  const repoInfo = [
    `name: ${context.repoName}`,
    context.checkCommand ? `checkCommand: ${context.checkCommand}` : null,
    context.testCommand ? `testCommand: ${context.testCommand}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  let prompt = `## Failed Task

**Task description:** ${context.taskDescription}

**Failure stage:** ${context.failureStage}

**Error:**
\`\`\`
${context.error.slice(0, 3000)}
\`\`\`

**Repo config:** ${repoInfo}

**Working directory:** ${context.worktreePath}

## Git State
\`\`\`
${context.gitState}
\`\`\`

## Agent Run History
${logEntries || "(no agent runs logged)"}`;

  if (context.priorDiagnosis) {
    prompt += `\n\n## Prior Diagnosis (from sonnet)
${context.priorDiagnosis}

The prior diagnostician could not resolve this. Provide a deeper analysis.`;
  }

  prompt += `\n\nInvestigate the failure and return your diagnosis as JSON.`;

  return prompt;
}

export interface DiagnosticContext {
  taskDescription: string;
  failureStage: string;
  error: string;
  taskLogs: TaskLogEntry[];
  repoName: string;
  checkCommand?: string;
  testCommand?: string;
  worktreePath: string;
  gitState: string;
  priorDiagnosis?: string;
}

export interface TaskLogEntry {
  agent: string;
  round: number;
  prompt_summary: string | null;
  result_summary: string | null;
  duration_ms: number | null;
  success: number;
}

export type DiagnosticCategory =
  | "environment"
  | "gitignore"
  | "task_spec"
  | "pipeline_bug"
  | "agent_behavior"
  | "external"
  | "unknown";

export type DiagnosticAction =
  | { type: "retry"; fixes: string[] }
  | { type: "retry_with_spec"; newSpec: string }
  | { type: "create_issue"; title: string; body: string }
  | { type: "escalate"; reason: string }
  | { type: "give_up"; reason: string };

export interface DiagnosticResult {
  diagnosis: string;
  category: DiagnosticCategory;
  action: DiagnosticAction;
}
