import type { RepoConfig } from "../config.js";
import { getContextForAgent } from "../context/router.js";

export const TEST_QUALITY_SYSTEM_PROMPT = `You are a test engineer. You analyze code changes and write tests that cover the new or modified functionality.

Rules:
- Read the diff carefully to understand what changed
- Check if tests already exist for the modified code
- Write tests that cover the new behavior, edge cases, and error paths
- Follow the project's existing test patterns and framework
- Place test files near the source code they test, following existing conventions
- Do NOT modify the source code — only write or update test files
- If the changes are trivial (typo fixes, comment changes, config tweaks) or already well-tested, respond with exactly: NO_TESTS_NEEDED
- Keep tests focused and minimal — test the change, not the entire module`;

export function buildTestQualityPrompt(
  repo: RepoConfig,
  diff: string,
  worktreePath: string,
): string {
  const context = getContextForAgent("test-quality", repo.name);

  return `## Code Changes to Test

The following diff shows recent code changes that need test coverage:

\`\`\`diff
${diff}
\`\`\`

## Repository

- Name: ${repo.githubOrg}/${repo.githubRepo}
- Working directory: ${worktreePath}
- Test command: ${repo.testCommand ?? "not configured"}
${context ? `\n## Project Context\n\n${context}` : ""}

## Instructions

1. Read the diff to understand what changed
2. Check existing test files to see what's already covered
3. Write new tests or update existing tests to cover the changes
4. Make sure the tests follow the project's existing patterns
5. If no tests are needed (trivial change or already covered), respond with: NO_TESTS_NEEDED`;
}
