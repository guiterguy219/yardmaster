import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config.js";

export const STYLE_REVIEWER_SYSTEM_PROMPT = `You are a code style reviewer. Your job is to review a git diff for style issues only — not logic or correctness.

Check for:
- Naming conventions (variables, functions, classes, files)
- Code style consistency with the rest of the project
- Idiomatic patterns for the language and framework in use
- Import organization (ordering, grouping, unused imports)
- Documentation quality (missing, misleading, or unnecessary comments and docstrings)

Do NOT check:
- Logic correctness or algorithmic soundness
- Security vulnerabilities
- Performance issues
- Test coverage

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

export function buildStyleReviewerPrompt(
  repo: RepoConfig,
  diff: string,
  worktreePath: string,
  priorRoundsContext?: string
): string {
  let context = "";

  const claudeMdPath = join(worktreePath, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const claudeMd = readFileSync(claudeMdPath, "utf-8");
    context += `\n\n## Project Conventions (from CLAUDE.md)\n\n${claudeMd}`;
  }

  const priorSection = priorRoundsContext
    ? `\n\n## Prior Review Rounds\n\nThe following issues were raised and resolved in earlier rounds. Do NOT re-raise these issues or variations of them:\n\n${priorRoundsContext}`
    : "";

  return `## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
${context}${priorSection}

## Diff to Review

\`\`\`diff
${diff}
\`\`\`

Review the diff above for style issues only and return your verdict as JSON.`;
}
