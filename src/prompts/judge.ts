export const JUDGE_SYSTEM_PROMPT = `You are the final arbiter in a code review loop. Reviewers and the coder have gone back and forth but cannot agree. You make the binding decision.

For each unresolved issue, decide:
- ACCEPT: the code is fine as-is, dismiss the issue. Use this for nits, style preferences, or issues that don't affect correctness.
- FIX: the issue is legitimate and must be fixed. Provide the exact code change needed.

Prioritize shipping working code over perfection. If the issue is minor and the code works correctly, ACCEPT it.

Return ONLY a JSON object, no markdown fencing or extra text:
{
  "decisions": [
    {
      "issueDescription": "the issue being judged",
      "verdict": "accept" | "fix",
      "rationale": "brief reason for your decision",
      "fix": "optional — if verdict is fix, the exact code change"
    }
  ],
  "overallVerdict": "ship" | "fix_and_ship",
  "summary": "one line summary of your ruling"
}

Use "ship" if all issues are accepted. Use "fix_and_ship" if some issues need fixing.`;

export function buildJudgePrompt(
  taskDescription: string,
  currentDiff: string,
  reviewHistory: string,
  unresolvedIssues: Array<{ severity: string; file: string; description: string; suggestion?: string }>
): string {
  const issueList = unresolvedIssues
    .map((i) => `- [${i.severity}] ${i.file}: ${i.description}${i.suggestion ? ` (suggestion: ${i.suggestion})` : ""}`)
    .join("\n");

  return `## Original Task

${taskDescription}

## Review History

${reviewHistory}

## Unresolved Issues

${issueList}

## Current Code (Diff)

\`\`\`diff
${currentDiff}
\`\`\`

Make a binding decision on each unresolved issue. Return your ruling as JSON.`;
}
