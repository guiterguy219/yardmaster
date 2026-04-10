import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config.js";

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
  worktreePath: string
): string {
  let context = "";

  const claudeMdPath = join(worktreePath, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const claudeMd = readFileSync(claudeMdPath, "utf-8");
    context += `\n\n## Project Conventions (from CLAUDE.md)\n\n${claudeMd}`;
  }

  return `## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
${context}

## Diff to Review

\`\`\`diff
${diff}
\`\`\`

Review the diff above for logic issues only and return your verdict as JSON.`;
}
