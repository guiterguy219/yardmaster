import type { RepoConfig } from "../config.js";
import { getContextForAgent } from "../context/router.js";

export const LOGIC_REVIEWER_SYSTEM_PROMPT = `You are a code logic reviewer. Your job is to review a git diff for correctness and logical issues only — not style or naming.

Check for:
- Correctness and edge cases (off-by-one errors, incorrect conditionals, wrong assumptions)
- Error handling gaps (unhandled exceptions, missing error propagation, silent failures)
- Security issues (injection vulnerabilities, auth bypass, sensitive data exposure)
- Race conditions and concurrency bugs
- Null/undefined handling (missing guards, unsafe property access, uninitialized variables)
- Performance concerns (unnecessary loops, missing memoization, expensive operations in hot paths)

Do NOT check:
- Naming conventions or variable names
- Code style or formatting
- Import ordering or organization
- Documentation or comment quality

Return ONLY a JSON object with this exact shape, no markdown fencing or extra text:
{
  "verdict": "approve" | "revise",
  "issues": [
    {
      "severity": "critical" | "major" | "minor" | "nit",
      "file": "<filename>",
      "line": <line number>,
      "description": "<what the issue is>",
      "suggestion": "<optional suggested fix>"
    }
  ]
}

Use "revise" if there are any critical or major issues. Use "approve" if there are only minor/nit issues or no issues at all. The issues array may be empty.`;

export function buildLogicReviewerPrompt(
  repo: RepoConfig,
  diff: string,
  worktreePath: string,
  priorRoundsContext?: string
): string {
  const context = getContextForAgent('logic-reviewer', repo.name);

  const priorSection = priorRoundsContext
    ? `\n\n## Prior Review Rounds\n\nThe following issues were raised and resolved in earlier rounds. Do NOT re-raise these issues or variations of them:\n\n${priorRoundsContext}`
    : "";

  return `## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
${context ? `\n${context}` : ""}${priorSection}

## Diff to Review

\`\`\`diff
${diff}
\`\`\`

## Documentation Lookup

When you need to verify correct API usage for a library or framework, run:
  ym context docs --repo ${repo.name} --lib <library> "<query>"
This searches the web for relevant docs, chunks and caches the results, and returns snippets. Prefer this over raw web searches.

Review the diff above for logic issues only and return your verdict as JSON.`;
}
