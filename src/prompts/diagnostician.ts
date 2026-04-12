export const DIAGNOSTICIAN_SYSTEM_PROMPT = `You are a pipeline diagnostician for Yardmaster, an autonomous coding agent orchestrator. A task just failed and you must determine why and what to do about it.

Investigate the failure using your tools. Check git state, file contents, error logs, and environment. Then return a JSON diagnosis.

Common failure patterns:
| Pattern | Clue | Fix |
|---------|------|-----|
| Gitignore whitelist | Coder succeeded but diff is empty | Add files to .gitignore whitelist, retry |
| Missing git identity | "Author identity unknown" | git config user.name/email in worktree |
| Push auth failure | "could not read Username" | Report missing credential |
| Empty diff after coder | task_logs show coder success but no changes | Check .gitignore, file paths |
| Type errors post-test | "Final check failed" with tsc errors | Create issue if recurring |
| Agent timeout | "Agent timed out" | Suggest narrowing scope |
| Review non-convergence | "needs_human_review" | Analyze oscillation vs scope creep |
| PR auth failure | "HTTP 401" from gh | Check gh auth status |

For "retry" actions: apply fixes yourself using Bash/Edit before returning. The orchestrator will retry the failed stage.
For "retry_with_spec": provide a rewritten, more specific task description.

Return ONLY a JSON object:
{
  "diagnosis": "what went wrong and why",
  "category": "environment|gitignore|task_spec|pipeline_bug|agent_behavior|external|unknown",
  "action": { "type": "retry", "fixes": ["list of fixes applied"] }
    | { "type": "retry_with_spec", "newSpec": "rewritten task description" }
    | { "type": "create_issue", "title": "issue title", "body": "issue body with details" }
    | { "type": "escalate", "reason": "why deeper analysis is needed" }
    | { "type": "give_up", "reason": "why this is unrecoverable" }
}`;

export interface DiagnosticContext {
  taskDescription: string;
  failureStage: string;
  errorMessage: string;
  taskLogs: Array<{
    agent: string;
    round: number;
    resultSummary: string;
    durationMs: number;
    success: number;
  }>;
  repoConfig: {
    name: string;
    checkCommand?: string;
    testCommand?: string;
  };
  worktreePath: string;
  gitStatus: string;
  gitDiffStat: string;
  gitLog: string;
  priorDiagnosis?: string;
}

export function buildDiagnosticianPrompt(ctx: DiagnosticContext): string {
  const logEntries = ctx.taskLogs
    .map(
      (l) =>
        `- ${l.agent} (round ${l.round}): ${l.success ? "✓" : "✗"} ${l.durationMs}ms — ${(l.resultSummary ?? "").slice(0, 200)}`
    )
    .join("\n");

  let prompt = `## Failed Task

**Description:** ${ctx.taskDescription}

**Failure stage:** ${ctx.failureStage}

**Error:**
\`\`\`
${ctx.errorMessage.slice(0, 4000)}
\`\`\`

## Repo Config

- Name: ${ctx.repoConfig.name}
- Check command: ${ctx.repoConfig.checkCommand ?? "(none)"}
- Test command: ${ctx.repoConfig.testCommand ?? "(none)"}

## Working Directory

${ctx.worktreePath}

## Git State

### git status
\`\`\`
${ctx.gitStatus}
\`\`\`

### git diff --cached --stat
\`\`\`
${ctx.gitDiffStat}
\`\`\`

### git log --oneline -3
\`\`\`
${ctx.gitLog}
\`\`\`

## Agent Run Logs

${logEntries || "(no logs)"}`;

  if (ctx.priorDiagnosis) {
    prompt += `

## Prior Diagnosis (from sonnet)

${ctx.priorDiagnosis}

You are running as an escalated model. The initial diagnostician could not resolve the issue. Provide deeper analysis.`;
  }

  prompt += `

Investigate the failure. Use your tools to inspect files, check git state, and diagnose the root cause. Then return your JSON diagnosis.`;

  return prompt;
}
